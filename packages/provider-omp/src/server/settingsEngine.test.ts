import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { OmpConfigType } from "@t3tools/contracts";

import type { OmpThreadRpcCommand } from "../configForm.ts";
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
  "compaction.enabled": { type: "boolean", default: true },
  "compaction.thresholdPercent": { type: "number", default: 80 },
  modelRoles: { type: "record", default: {} },
  "memory.backend": { type: "enum", default: "off" },
  "hindsight.apiToken": { type: "string", credential: true },
  "newfeature.endpoint": { type: "string", default: "https://example.test" },
  "web_search.enabled": { type: "boolean", default: true, env: false },
  "browser.enabled": { type: "boolean", default: true },
  "computer.enabled": { type: "boolean", default: false },
  enabledModels: { type: "array", default: [] },
};

const PROJECT = "/work/app";

/**
 * A scripted `omp config` with OMP's layering (default < global < project < env) and redaction,
 * so a write is observable through the next `config list`. `enabledModels` resolves its
 * `{ path, models }` entries for `--cwd`, as OMP does. `layerList` makes `config list --scope`
 * list a layer as written (CLI contract 1.1.0); without it that call exits 1, like the pinned OMP.
 * Layer listings are recorded in `layerLaunches`, apart from the other `config` calls.
 */
function fakeOmpConfig(
  seed: { readonly global?: Record<string, unknown>; readonly layerList?: boolean } = {},
) {
  const launches: Array<ReadonlyArray<string>> = [];
  const layerLaunches: Array<ReadonlyArray<string>> = [];
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
    const resolve = (name: string, value: unknown) =>
      name === "enabledModels" && Array.isArray(value)
        ? value.flatMap((entry: unknown) =>
            typeof entry === "string"
              ? [entry]
              : typeof entry === "object" &&
                  entry !== null &&
                  "path" in entry &&
                  "models" in entry &&
                  typeof entry.path === "string" &&
                  `${cwd}/`.startsWith(`${entry.path}/`)
                ? (entry.models as ReadonlyArray<string>)
                : [],
          )
        : value;
    const effective = (name: string) => {
      const setting = SETTINGS[name]!;
      if (setting.env !== undefined) return { value: setting.env, source: "env" };
      if (name in project) return { value: resolve(name, project[name]), source: "project" };
      if (name in global) return { value: resolve(name, global[name]), source: "global" };
      return { value: setting.default, source: "default" };
    };
    switch (action) {
      case "list": {
        const scope = flag("--scope");
        if (scope !== undefined) {
          if (seed.layerList !== true) return { stdout: "", code: 1 };
          const layer = scope === "project" ? project : global;
          const listed: Record<string, unknown> = {};
          for (const [name, value] of Object.entries(layer)) {
            const setting = SETTINGS[name]!;
            listed[name] =
              setting.credential === true && value
                ? { type: setting.type, description: `${name} help`, redacted: true }
                : { type: setting.type, description: `${name} help`, value };
          }
          return { stdout: `${JSON.stringify(listed)}\n`, code: 0 };
        }
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
    (command.args.includes("--scope") && command.args.includes("list")
      ? layerLaunches
      : launches
    ).push(command.args);
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
  return { spawner, launches, layerLaunches, global, projects };
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
        global: { "hindsight.apiToken": "sk-secret", "memory.backend": "local" },
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
        credential: false,
        readOnly: false,
        launchScoped: false,
        threadOverride: "overlay",
      });
      assert.strictEqual(byKey.get("memory.backend")?.source, "global");
      assert.strictEqual(byKey.get("memory.backend")?.value, "local");
      assert.isTrue(byKey.get("memory.backend")?.launchScoped);
      assert.strictEqual(byKey.get("tools.approvalMode")?.threadOverride, "none");
      assert.strictEqual(byKey.get("browser.enabled")?.threadOverride, "none");
      assert.strictEqual(byKey.get("computer.enabled")?.threadOverride, "none");
      assert.strictEqual(byKey.get("compaction.enabled")?.threadOverride, "rpc");

      const stored = byKey.get("hindsight.apiToken");
      assert.isTrue(stored?.redacted);
      assert.isTrue(stored?.credential);
      assert.isFalse(stored !== undefined && "value" in stored);
      // Unknown to the pinned registry: treated as a credential, its value withheld.
      const unknown = byKey.get("newfeature.endpoint");
      assert.isTrue(unknown?.credential);
      assert.isFalse(unknown !== undefined && "value" in unknown);
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

  it.effect("never runs `config get` and never takes a credential, stored or not", () =>
    Effect.gen(function* () {
      const omp = fakeOmpConfig({ global: { "hindsight.apiToken": "sk-old" } });
      const threads = fakeThreads(OPEN_THREADS);
      const [replace, override, cleared, unsetWrite, unknownWrite] = yield* withEngine(
        omp,
        threads,
        (engine) =>
          Effect.all([
            engine
              .write(TARGET, { key: "hindsight.apiToken", value: "sk-new", scope: "global" })
              .pipe(Effect.flip),
            engine
              .setThreadOverride(TARGET, "thread-app", {
                key: "hindsight.apiToken",
                value: "sk-thread",
              })
              .pipe(Effect.flip),
            engine.reset(TARGET, { key: "hindsight.apiToken", scope: "global" }),
            // Unset, OMP reports it as plain text; the pinned registry still marks it.
            engine
              .write(TARGET, { key: "hindsight.apiToken", value: "sk-first", scope: "project" })
              .pipe(Effect.flip),
            // A key the pinned OMP does not register is not known to be safe.
            engine
              .write(TARGET, { key: "newfeature.endpoint", value: "x", scope: "global" })
              .pipe(Effect.flip),
          ]),
      );

      for (const error of [replace, override, unsetWrite, unknownWrite]) {
        assert.strictEqual(error._tag === "OmpSettingsError" && error.reason, "credential");
      }
      const after = cleared.form.fields.find((f) => f.key === "hindsight.apiToken");
      assert.isFalse(after?.redacted);
      assert.isTrue(after?.credential);
      assert.deepStrictEqual(omp.launches.map(configAction), [
        "list",
        "list",
        "list",
        "reset",
        "list",
        "list",
        "list",
      ]);
      assert.isFalse(omp.launches.some((args) => args.includes("get")));
      assert.isFalse(omp.launches.some((args) => args.some((arg) => arg.startsWith("sk-"))));
      assert.strictEqual(threads.overlays.get("thread-app"), EMPTY_OVERLAY);
    }),
  );
});

describe("path-scoped arrays", () => {
  const SCOPED = { path: "/work/other", models: ["lab/scoped"] };

  it.effect("carry the global layer's own entries when OMP lists that layer", () =>
    Effect.gen(function* () {
      const omp = fakeOmpConfig({
        layerList: true,
        global: { enabledModels: ["lab/a", SCOPED], "memory.backend": "local" },
      });
      const form = yield* withEngine(omp, fakeThreads([]), (engine) => engine.read(TARGET));
      const field = form.fields.find((candidate) => candidate.key === "enabledModels");
      // The effective value is resolved for PROJECT; the global entries are as written.
      assert.deepStrictEqual(field?.value, ["lab/a"]);
      assert.deepStrictEqual(field?.globalEntries, ["lab/a", SCOPED]);
      assert.isFalse(
        form.fields.some(
          (candidate) => candidate.key !== "enabledModels" && "globalEntries" in candidate,
        ),
      );
      assert.deepStrictEqual(omp.layerLaunches, [
        ["--profile", "work", "config", "list", "--scope", "global", "--json", "--cwd", PROJECT],
      ]);
    }),
  );

  it.effect("write only the global list and keep entries scoped to folders", () =>
    Effect.gen(function* () {
      const omp = fakeOmpConfig({ layerList: true, global: { enabledModels: ["lab/a", SCOPED] } });
      const result = yield* withEngine(omp, fakeThreads([]), (engine) =>
        engine.write(TARGET, { key: "enabledModels", value: ["lab/b", "lab/c"], scope: "global" }),
      );
      assert.deepStrictEqual(omp.global["enabledModels"], ["lab/b", "lab/c", SCOPED]);
      const field = result.form.fields.find((candidate) => candidate.key === "enabledModels");
      assert.deepStrictEqual(field?.globalEntries, ["lab/b", "lab/c", SCOPED]);
    }),
  );

  it.effect("reset clears the global list but keeps entries scoped to folders", () =>
    Effect.gen(function* () {
      const scopedOnly = fakeOmpConfig({
        layerList: true,
        global: { enabledModels: ["lab/a", SCOPED] },
      });
      yield* withEngine(scopedOnly, fakeThreads([]), (engine) =>
        engine.reset(TARGET, { key: "enabledModels", scope: "global" }),
      );
      assert.deepStrictEqual(scopedOnly.global["enabledModels"], [SCOPED]);
      assert.isFalse(scopedOnly.launches.some((args) => configAction(args) === "reset"));

      const plain = fakeOmpConfig({ layerList: true, global: { enabledModels: ["lab/a"] } });
      yield* withEngine(plain, fakeThreads([]), (engine) =>
        engine.reset(TARGET, { key: "enabledModels", scope: "global" }),
      );
      assert.isFalse("enabledModels" in plain.global);
    }),
  );

  it.effect(
    "refuse a project write, an OMP that cannot list the layer, and a list with scoped entries",
    () =>
      Effect.gen(function* () {
        const supported = fakeOmpConfig({ layerList: true, global: { enabledModels: [SCOPED] } });
        const [project, notStrings, projectReset] = yield* withEngine(
          supported,
          fakeThreads([]),
          (engine) =>
            Effect.all([
              engine
                .write(TARGET, { key: "enabledModels", value: ["lab/a"], scope: "project" })
                .pipe(Effect.flip),
              engine
                .write(TARGET, { key: "enabledModels", value: [SCOPED], scope: "global" })
                .pipe(Effect.flip),
              engine.reset(TARGET, { key: "enabledModels", scope: "project" }).pipe(Effect.flip),
            ]),
        );
        const pinned = fakeOmpConfig({ global: { enabledModels: [SCOPED] } });
        const [form, old] = yield* withEngine(pinned, fakeThreads([]), (engine) =>
          Effect.all([
            engine.read(TARGET),
            engine
              .write(TARGET, { key: "enabledModels", value: ["lab/a"], scope: "global" })
              .pipe(Effect.flip),
          ]),
        );

        assert.deepStrictEqual(
          [project, notStrings, projectReset, old].map((error) =>
            error._tag === "OmpSettingsError" ? error.reason : error._tag,
          ),
          ["path_scoped", "invalid_value", "path_scoped", "path_scoped"],
        );
        assert.isFalse(
          "globalEntries" in (form.fields.find((field) => field.key === "enabledModels") ?? {}),
        );
        for (const omp of [supported, pinned]) {
          assert.isFalse(
            omp.launches.some((args) => ["set", "reset"].includes(configAction(args)!)),
          );
          assert.deepStrictEqual(omp.global["enabledModels"], [SCOPED]);
        }
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
          key: "compaction.enabled",
          value: false,
        }),
      );
      assert.deepStrictEqual(result, { route: "rpc", restartRequired: false });
      assert.deepStrictEqual(threads.commands, [
        {
          threadId: "thread-app",
          command: { type: "set_auto_compaction", params: { enabled: false } },
        },
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
      const omp = fakeOmpConfig({ global: { "compaction.enabled": false } });
      yield* withEngine(omp, threads, (engine) =>
        Effect.all([
          engine.setThreadOverride(TARGET, "thread-app", {
            key: "modelRoles",
            value: { default: "a/b" },
          }),
          engine.clearThreadOverride(TARGET, "thread-app", "modelRoles"),
          engine.clearThreadOverride(TARGET, "thread-app", "compaction.enabled"),
        ]),
      );
      const overlay = threads.overlays.get("thread-app")!;
      assert.deepStrictEqual(JSON.parse(overlay.slice(overlay.indexOf("\n") + 1)), {});
      assert.deepStrictEqual(threads.commands, [
        {
          threadId: "thread-app",
          command: { type: "set_auto_compaction", params: { enabled: false } },
        },
      ]);
    }),
  );

  it.effect("an RPC-only override needs the thread's session running", () =>
    Effect.gen(function* () {
      const threads = fakeThreads([]);
      const error = yield* withEngine(fakeOmpConfig(), threads, (engine) =>
        engine
          .setThreadOverride(TARGET, "thread-closed", { key: "compaction.enabled", value: false })
          .pipe(Effect.flip),
      );
      assert.strictEqual(error._tag === "OmpSettingsError" && error.reason, "thread_not_open");
      assert.deepStrictEqual(threads.commands, []);
    }),
  );

  it.effect("refuse the keys the thread's permission mode sets", () =>
    Effect.gen(function* () {
      const threads = fakeThreads(OPEN_THREADS);
      const errors = yield* withEngine(fakeOmpConfig(), threads, (engine) =>
        Effect.all([
          engine
            .setThreadOverride(TARGET, "thread-app", { key: "tools.approvalMode", value: "write" })
            .pipe(Effect.flip),
          engine.clearThreadOverride(TARGET, "thread-app", "tools.approvalMode").pipe(Effect.flip),
          // Browser and computer use exist only in Full access (toolGuards.ts).
          engine
            .setThreadOverride(TARGET, "thread-app", { key: "browser.enabled", value: true })
            .pipe(Effect.flip),
          engine
            .setThreadOverride(TARGET, "thread-app", { key: "computer.enabled", value: true })
            .pipe(Effect.flip),
          engine.clearThreadOverride(TARGET, "thread-app", "computer.enabled").pipe(Effect.flip),
        ]),
      );
      assert.deepStrictEqual(
        errors.map((error) => (error._tag === "OmpSettingsError" ? error.reason : error._tag)),
        Array.from({ length: 5 }, () => "not_thread_overridable"),
      );
      assert.deepStrictEqual(threads.commands, []);
      assert.strictEqual(threads.overlays.get("thread-app"), EMPTY_OVERLAY);
    }),
  );
});
