import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { OmpConfigType, OmpThreadRpcCommand } from "../configForm.ts";
import { makeOmpControlService, type OmpControlTarget } from "./control.ts";
import {
  makeOmpSettingsEngine,
  OmpThreadHostError,
  type OmpOpenThread,
  type OmpSettingsEngine,
} from "./settingsEngine.ts";

const encoder = new TextEncoder();

interface FakeSetting {
  readonly type: OmpConfigType;
  readonly default?: unknown;
  readonly credential?: boolean;
  readonly env?: unknown;
}

const SETTINGS: Readonly<Record<string, FakeSetting>> = {
  "tools.approvalMode": { type: "enum", default: "yolo" },
  "compaction.thresholdPercent": { type: "number", default: 80 },
  modelRoles: { type: "record", default: {} },
  "memory.backend": { type: "enum", default: "off" },
  "exa.apiKey": { type: "string", credential: true },
  "web_search.enabled": { type: "boolean", default: true, env: false },
};

const PROJECT = "/work/app";

/**
 * A scripted `omp config` with OMP's layering (default < global < project < env) and redaction,
 * so a write is observable through the next `config list`.
 */
function fakeOmpConfig(seed: { readonly global?: Record<string, unknown> } = {}) {
  const launches: Array<ReadonlyArray<string>> = [];
  const global: Record<string, unknown> = { ...seed.global };
  const projects = new Map<string, Record<string, unknown>>();

  const run = (args: ReadonlyArray<string>): { stdout: string; code: number } => {
    const at = args.indexOf("config");
    const action = args[at + 1];
    const separator = args.indexOf("--");
    const flag = (name: string) => {
      const index = args.indexOf(name);
      return index === -1 || (separator !== -1 && index > separator) ? undefined : args[index + 1];
    };
    const [key, valueText] = separator === -1 ? [] : args.slice(separator + 1);
    const cwd = flag("--cwd") ?? "/";
    const project = projects.get(cwd) ?? {};
    const effective = (name: string) => {
      const setting = SETTINGS[name]!;
      if (setting.env !== undefined) return { value: setting.env, source: "env" };
      if (name in project) return { value: project[name], source: "project" };
      if (name in global) return { value: global[name], source: "global" };
      return { value: setting.default, source: "default" };
    };
    switch (action) {
      case "list": {
        const list: Record<string, unknown> = {};
        for (const [name, setting] of Object.entries(SETTINGS)) {
          const { value, source } = effective(name);
          list[name] =
            setting.credential === true && value
              ? { type: setting.type, description: `${name} help`, source, redacted: true }
              : { type: setting.type, description: `${name} help`, source, value };
        }
        return { stdout: `${JSON.stringify(list, null, 2)}\n`, code: 0 };
      }
      case "set": {
        if (key === undefined || valueText === undefined || !(key in SETTINGS)) {
          return { stdout: "", code: 1 };
        }
        const scope = flag("--scope") ?? "global";
        const layer = scope === "project" ? project : global;
        layer[key] = JSON.parse(valueText);
        projects.set(cwd, project);
        const { source } = effective(key);
        const overriddenBy =
          source === "env" || (scope === "global" && source === "project") ? source : undefined;
        return {
          stdout: `${JSON.stringify({ key, scope, value: layer[key], overriddenBy })}\n`,
          code: 0,
        };
      }
      case "reset": {
        if (key === undefined) return { stdout: "", code: 1 };
        const scope = flag("--scope") ?? "global";
        delete (scope === "project" ? project : global)[key];
        return { stdout: `${JSON.stringify({ key, scope, ...effective(key) })}\n`, code: 0 };
      }
      default:
        // `config get` prints credentials unmasked; the engine must never get here.
        return { stdout: "", code: 2 };
    }
  };

  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    launches.push(command.args);
    const { stdout, code } = run(command.args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        // Outside the valid PID range, so cleanup cannot signal a real process.
        pid: ChildProcessSpawner.ProcessId(999_999_997),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
        isRunning: Effect.succeed(false),
        stdout: Stream.succeed(encoder.encode(stdout)),
        stderr: Stream.empty,
      }),
    );
  });
  return { spawner, launches, global, projects };
}

const EMPTY_OVERLAY = "# Per-thread OMP settings written by Ompanel.\n{}\n";

function fakeThreads(open: ReadonlyArray<OmpOpenThread>) {
  const commands: Array<{ threadId: string; command: OmpThreadRpcCommand }> = [];
  const overlays = new Map<string, string>(open.map((thread) => [thread.threadId, EMPTY_OVERLAY]));
  const restartMarks: Array<{ threadId: string; keys: ReadonlyArray<string> }> = [];
  return {
    commands,
    overlays,
    restartMarks,
    host: {
      openThreads: Effect.succeed(open),
      sendCommand: (threadId: string, command: OmpThreadRpcCommand) =>
        Effect.sync(() => void commands.push({ threadId, command })),
      readOverlay: (threadId: string) => {
        const content = overlays.get(threadId);
        return content === undefined
          ? Effect.fail(new OmpThreadHostError({ threadId, reason: "io" }))
          : Effect.succeed(content);
      },
      writeOverlay: (threadId: string, content: string) =>
        Effect.sync(() => void overlays.set(threadId, content)),
      markRestartRequired: (threadId: string, keys: ReadonlyArray<string>) =>
        Effect.sync(() => void restartMarks.push({ threadId, keys })),
    },
  };
}

const TARGET: OmpControlTarget = {
  binaryPath: "/opt/ompanel/omp",
  profile: "work",
  environment: { HOME: "/home/tester" },
  cwd: PROJECT,
};

const OPEN_THREADS: ReadonlyArray<OmpOpenThread> = [
  { threadId: "thread-app", cwd: PROJECT },
  { threadId: "thread-app-worktree", cwd: `${PROJECT}/wt/feature` },
  { threadId: "thread-other", cwd: "/work/other" },
];

const withEngine = <A, E>(
  omp: ReturnType<typeof fakeOmpConfig>,
  threads: ReturnType<typeof fakeThreads>,
  use: (engine: OmpSettingsEngine) => Effect.Effect<A, E>,
) =>
  makeOmpControlService().pipe(
    Effect.flatMap((control) => use(makeOmpSettingsEngine({ control, threads: threads.host }))),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
    Effect.scoped,
  );

const configAction = (args: ReadonlyArray<string>) => args[args.indexOf("config") + 1];

describe("OmpSettingsEngine.read", () => {
  it.effect("builds one field per `config list` key with its value, type and source", () =>
    Effect.gen(function* () {
      const omp = fakeOmpConfig({
        global: { "exa.apiKey": "sk-secret", "memory.backend": "local" },
      });
      const form = yield* withEngine(omp, fakeThreads([]), (engine) => engine.read(TARGET));

      assert.deepStrictEqual(omp.launches, [
        ["--profile", "work", "config", "list", "--json", "--cwd", PROJECT],
      ]);
      assert.deepStrictEqual(
        form.fields.map((field) => field.key),
        Object.keys(SETTINGS),
      );
      const byKey = new Map(form.fields.map((field) => [field.key, field]));
      assert.deepStrictEqual(byKey.get("compaction.thresholdPercent"), {
        key: "compaction.thresholdPercent",
        group: "compaction",
        type: "number",
        description: "compaction.thresholdPercent help",
        source: "default",
        value: 80,
        redacted: false,
        readOnly: false,
        launchScoped: false,
        threadOverride: "overlay",
      });
      assert.strictEqual(byKey.get("memory.backend")?.source, "global");
      assert.strictEqual(byKey.get("memory.backend")?.value, "local");
      assert.isTrue(byKey.get("memory.backend")?.launchScoped);
      assert.strictEqual(byKey.get("tools.approvalMode")?.threadOverride, "rpc");

      const credential = byKey.get("exa.apiKey");
      assert.isTrue(credential?.redacted);
      assert.isFalse(credential !== undefined && "value" in credential);
    }),
  );

  it.effect("marks env-set values read-only and refuses to write or reset them", () =>
    Effect.gen(function* () {
      const omp = fakeOmpConfig();
      const threads = fakeThreads(OPEN_THREADS);
      const [form, ...errors] = yield* withEngine(omp, threads, (engine) =>
        Effect.all([
          engine.read(TARGET),
          engine
            .write(TARGET, { key: "web_search.enabled", value: true, scope: "global" })
            .pipe(Effect.flip),
          engine.reset(TARGET, { key: "web_search.enabled", scope: "project" }).pipe(Effect.flip),
          engine
            .setThreadOverride(TARGET, "thread-app", { key: "web_search.enabled", value: true })
            .pipe(Effect.flip),
        ]),
      );

      const field = form.fields.find((candidate) => candidate.key === "web_search.enabled");
      assert.strictEqual(field?.source, "env");
      assert.isTrue(field?.readOnly);
      assert.deepStrictEqual(
        errors.map((error) => (error._tag === "OmpSettingsError" ? error.reason : error._tag)),
        ["read_only", "read_only", "read_only"],
      );
      assert.deepStrictEqual(omp.launches.map(configAction), ["list", "list", "list", "list"]);
      assert.deepStrictEqual(threads.overlays.get("thread-app"), EMPTY_OVERLAY);
    }),
  );
});

describe("OmpSettingsEngine.write", () => {
  it.effect("writes through `config set` with the scope and cwd, then re-reads the list", () =>
    Effect.gen(function* () {
      const omp = fakeOmpConfig();
      const result = yield* withEngine(omp, fakeThreads(OPEN_THREADS), (engine) =>
        engine.write(TARGET, { key: "compaction.thresholdPercent", value: -5, scope: "project" }),
      );

      assert.deepStrictEqual(omp.launches, [
        ["--profile", "work", "config", "list", "--json", "--cwd", PROJECT],
        [
          "--profile",
          "work",
          "config",
          "set",
          "--scope",
          "project",
          "--cwd",
          PROJECT,
          "--json",
          "--",
          "compaction.thresholdPercent",
          "-5",
        ],
        ["--profile", "work", "config", "list", "--json", "--cwd", PROJECT],
      ]);
      const field = result.form.fields.find((f) => f.key === "compaction.thresholdPercent");
      assert.strictEqual(field?.value, -5);
      assert.strictEqual(field?.source, "project");
      assert.deepStrictEqual(result.restartRequired, []);
    }),
  );

  it.effect("reports the layer that still overrides a global write", () =>
    Effect.gen(function* () {
      const omp = fakeOmpConfig();
      const result = yield* withEngine(omp, fakeThreads([]), (engine) =>
        engine
          .write(TARGET, { key: "modelRoles", value: { default: "a/b" }, scope: "project" })
          .pipe(
            Effect.andThen(
              engine.write(TARGET, {
                key: "modelRoles",
                value: { default: "c/d" },
                scope: "global",
              }),
            ),
          ),
      );
      assert.strictEqual(result.overriddenBy, "project");
      const field = result.form.fields.find((f) => f.key === "modelRoles");
      assert.deepStrictEqual(field?.value, { default: "a/b" });
      assert.deepStrictEqual(omp.global["modelRoles"], { default: "c/d" });
    }),
  );

  it.effect(
    "refuses a value of the wrong type and an unknown key without spawning `config set`",
    () =>
      Effect.gen(function* () {
        const omp = fakeOmpConfig();
        const [wrongType, unknown] = yield* withEngine(omp, fakeThreads([]), (engine) =>
          Effect.all([
            engine
              .write(TARGET, { key: "compaction.thresholdPercent", value: "80", scope: "global" })
              .pipe(Effect.flip),
            engine.write(TARGET, { key: "nope", value: 1, scope: "global" }).pipe(Effect.flip),
          ]),
        );
        assert.strictEqual(
          wrongType._tag === "OmpSettingsError" && wrongType.reason,
          "invalid_value",
        );
        assert.strictEqual(unknown._tag === "OmpSettingsError" && unknown.reason, "unknown_key");
        assert.deepStrictEqual(omp.launches.map(configAction), ["list", "list"]);
      }),
  );

  it.effect("resets through `config reset` and re-reads the list", () =>
    Effect.gen(function* () {
      const omp = fakeOmpConfig({ global: { "compaction.thresholdPercent": 50 } });
      const result = yield* withEngine(omp, fakeThreads([]), (engine) =>
        engine.reset(TARGET, { key: "compaction.thresholdPercent", scope: "global" }),
      );
      assert.deepStrictEqual(omp.launches[1], [
        "--profile",
        "work",
        "config",
        "reset",
        "--scope",
        "global",
        "--cwd",
        PROJECT,
        "--json",
        "--",
        "compaction.thresholdPercent",
      ]);
      const field = result.form.fields.find((f) => f.key === "compaction.thresholdPercent");
      assert.strictEqual(field?.source, "default");
      assert.strictEqual(field?.value, 80);
    }),
  );

  it.effect("never runs `config get` and never puts a stored credential on a command line", () =>
    Effect.gen(function* () {
      const omp = fakeOmpConfig();
      const threads = fakeThreads(OPEN_THREADS);
      const [first, replace, override, cleared] = yield* withEngine(omp, threads, (engine) =>
        Effect.all([
          // Unset, OMP cannot tell it is a credential yet; once stored it comes back redacted.
          engine.write(TARGET, { key: "exa.apiKey", value: "sk-first", scope: "global" }),
          engine
            .write(TARGET, { key: "exa.apiKey", value: "sk-second", scope: "global" })
            .pipe(Effect.flip),
          engine
            .setThreadOverride(TARGET, "thread-app", { key: "exa.apiKey", value: "sk-third" })
            .pipe(Effect.flip),
          engine.reset(TARGET, { key: "exa.apiKey", scope: "global" }),
        ]),
      );

      const stored = first.form.fields.find((f) => f.key === "exa.apiKey");
      assert.isTrue(stored?.redacted);
      assert.isFalse(JSON.stringify(first).includes("sk-first"));
      assert.strictEqual(replace._tag === "OmpSettingsError" && replace.reason, "credential");
      assert.strictEqual(override._tag === "OmpSettingsError" && override.reason, "credential");
      const after = cleared.form.fields.find((f) => f.key === "exa.apiKey");
      assert.isFalse(after?.redacted);
      assert.deepStrictEqual(omp.launches.map(configAction), [
        "list",
        "set",
        "list",
        "list",
        "list",
        "list",
        "reset",
        "list",
      ]);
      assert.isFalse(omp.launches.some((args) => args.includes("get")));
      assert.isFalse(omp.launches.some((args) => args.some((arg) => arg.includes("sk-second"))));
      assert.strictEqual(threads.overlays.get("thread-app"), EMPTY_OVERLAY);
    }),
  );
});

describe("launch-scoped settings", () => {
  it.effect("a global change marks every open thread restart required", () =>
    Effect.gen(function* () {
      const threads = fakeThreads(OPEN_THREADS);
      const result = yield* withEngine(fakeOmpConfig(), threads, (engine) =>
        engine.write(TARGET, { key: "memory.backend", value: "local", scope: "global" }),
      );
      assert.deepStrictEqual(result.restartRequired, [
        "thread-app",
        "thread-app-worktree",
        "thread-other",
      ]);
      assert.deepStrictEqual(
        threads.restartMarks,
        OPEN_THREADS.map((thread) => ({ threadId: thread.threadId, keys: ["memory.backend"] })),
      );
    }),
  );

  it.effect("a project change marks only threads inside that project", () =>
    Effect.gen(function* () {
      const threads = fakeThreads(OPEN_THREADS);
      const result = yield* withEngine(fakeOmpConfig(), threads, (engine) =>
        engine.reset(TARGET, { key: "memory.backend", scope: "project" }),
      );
      assert.deepStrictEqual(result.restartRequired, ["thread-app", "thread-app-worktree"]);
    }),
  );

  it.effect("a live setting marks no thread", () =>
    Effect.gen(function* () {
      const threads = fakeThreads(OPEN_THREADS);
      const result = yield* withEngine(fakeOmpConfig(), threads, (engine) =>
        engine.write(TARGET, { key: "tools.approvalMode", value: "write", scope: "global" }),
      );
      assert.deepStrictEqual(result.restartRequired, []);
      assert.deepStrictEqual(threads.restartMarks, []);
    }),
  );
});

describe("per-thread overrides", () => {
  it.effect("use the session RPC command when OMP has one", () =>
    Effect.gen(function* () {
      const omp = fakeOmpConfig();
      const threads = fakeThreads(OPEN_THREADS);
      const result = yield* withEngine(omp, threads, (engine) =>
        engine.setThreadOverride(TARGET, "thread-app", {
          key: "tools.approvalMode",
          value: "always-ask",
        }),
      );
      assert.deepStrictEqual(result, { route: "rpc", restartRequired: false });
      assert.deepStrictEqual(threads.commands, [
        { threadId: "thread-app", command: { type: "set_approval_mode", mode: "always-ask" } },
      ]);
      assert.strictEqual(threads.overlays.get("thread-app"), EMPTY_OVERLAY);
      assert.isFalse(omp.launches.some((args) => configAction(args) !== "list"));
    }),
  );

  it.effect("write the thread overlay when no RPC command exists", () =>
    Effect.gen(function* () {
      const threads = fakeThreads(OPEN_THREADS);
      const results = yield* withEngine(fakeOmpConfig(), threads, (engine) =>
        Effect.all([
          engine.setThreadOverride(TARGET, "thread-app", {
            key: "modelRoles",
            value: { default: "anthropic/claude-opus" },
          }),
          engine.setThreadOverride(TARGET, "thread-app", { key: "memory.backend", value: "local" }),
        ]),
      );
      assert.deepStrictEqual(results, [
        { route: "overlay", restartRequired: false },
        { route: "overlay", restartRequired: true },
      ]);
      assert.deepStrictEqual(threads.commands, []);
      const overlay = threads.overlays.get("thread-app")!;
      assert.isTrue(overlay.startsWith("# Per-thread OMP settings written by Ompanel.\n"));
      assert.deepStrictEqual(JSON.parse(overlay.slice(overlay.indexOf("\n") + 1)), {
        modelRoles: { default: "anthropic/claude-opus" },
        memory: { backend: "local" },
      });
      assert.deepStrictEqual(threads.restartMarks, [
        { threadId: "thread-app", keys: ["memory.backend"] },
      ]);
    }),
  );

  it.effect("clearing drops the overlay key or restores the configured value over RPC", () =>
    Effect.gen(function* () {
      const threads = fakeThreads(OPEN_THREADS);
      const omp = fakeOmpConfig({ global: { "tools.approvalMode": "write" } });
      yield* withEngine(omp, threads, (engine) =>
        Effect.all([
          engine.setThreadOverride(TARGET, "thread-app", {
            key: "modelRoles",
            value: { default: "a/b" },
          }),
          engine.clearThreadOverride(TARGET, "thread-app", "modelRoles"),
          engine.clearThreadOverride(TARGET, "thread-app", "tools.approvalMode"),
        ]),
      );
      const overlay = threads.overlays.get("thread-app")!;
      assert.deepStrictEqual(JSON.parse(overlay.slice(overlay.indexOf("\n") + 1)), {});
      assert.deepStrictEqual(threads.commands, [
        { threadId: "thread-app", command: { type: "set_approval_mode", mode: "write" } },
      ]);
    }),
  );

  it.effect("an RPC-only override needs the thread's session running", () =>
    Effect.gen(function* () {
      const threads = fakeThreads([]);
      const error = yield* withEngine(fakeOmpConfig(), threads, (engine) =>
        engine
          .setThreadOverride(TARGET, "thread-closed", { key: "tools.approvalMode", value: "write" })
          .pipe(Effect.flip),
      );
      assert.strictEqual(error._tag === "OmpSettingsError" && error.reason, "thread_not_open");
      assert.deepStrictEqual(threads.commands, []);
    }),
  );
});
