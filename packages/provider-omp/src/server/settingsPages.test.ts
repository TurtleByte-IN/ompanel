import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { OmpConfigType } from "@t3tools/contracts";

import { OMP_SETTING_KEYS } from "../ompSettingKeys.generated.ts";
import { OMP_PATH_SCOPED_KEYS, OMP_SETTINGS_PAGES, ompSettingsPageForm } from "../settingsPages.ts";
import { makeOmpControlService, type OmpControlTarget } from "./control.ts";
import { makeOmpSettingsEngine } from "./settingsEngine.ts";

const encoder = new TextEncoder();

// One key per page plus a neighbour each, typed as the pinned OMP registers them.
const SETTINGS: Readonly<Record<string, { type: OmpConfigType; default: unknown }>> = {
  modelRoles: { type: "record", default: {} },
  cycleOrder: { type: "array", default: [] },
  "retry.maxRetries": { type: "number", default: 3 },
  "retry.fallbackChains": { type: "record", default: {} },
  "thinkingBudgets.high": { type: "number", default: 16384 },
  defaultThinkingLevel: { type: "enum", default: "high" },
  "compaction.enabled": { type: "boolean", default: true },
};

/** A scripted `omp config` holding one global layer; `get` prints like `omp config get --json`. */
function fakeOmp() {
  const global: Record<string, unknown> = {};
  const value = (key: string) => (key in global ? global[key] : SETTINGS[key]!.default);
  const run = (args: ReadonlyArray<string>): string | undefined => {
    const rest = args.slice(args.indexOf("config") + 1);
    const operands = rest.includes("--") ? rest.slice(rest.indexOf("--") + 1) : rest.slice(1);
    const [key, text] = operands.filter((arg) => !arg.startsWith("--"));
    switch (rest[0]) {
      case "list":
        return JSON.stringify(
          Object.fromEntries(
            Object.entries(SETTINGS).map(([name, setting]) => [
              name,
              {
                type: setting.type,
                description: "",
                source: name in global ? "global" : "default",
                value: value(name),
              },
            ]),
          ),
        );
      case "set":
        if (key === undefined || text === undefined || !(key in SETTINGS)) return undefined;
        global[key] = JSON.parse(text);
        return JSON.stringify({ key, scope: "global", value: global[key] });
      case "get":
        if (key === undefined || !(key in SETTINGS)) return undefined;
        return JSON.stringify({ key, value: value(key), type: SETTINGS[key]!.type });
      default:
        return undefined;
    }
  };
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    const stdout = run(command.args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_996),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(stdout === undefined ? 1 : 0)),
        isRunning: Effect.succeed(false),
        stdout: Stream.succeed(encoder.encode(`${stdout ?? ""}\n`)),
        stderr: Stream.empty,
      }),
    );
  });
  /** What `omp config get <key> --json` prints, run as a separate process would see it. */
  const configGet = (key: string) =>
    JSON.parse(run(["config", "get", key, "--json"]) ?? "null") as { value: unknown };
  return { spawner, configGet };
}

const TARGET: OmpControlTarget = {
  binaryPath: "/opt/ompanel/omp",
  profile: "work",
  environment: { HOME: "/home/tester" },
  cwd: "/work/app",
};

describe("OMP settings pages", () => {
  it("name only keys the pinned OMP registers", () => {
    const missing = Object.values(OMP_SETTINGS_PAGES).flatMap((page) =>
      page.keys.filter((pattern) =>
        pattern.endsWith(".")
          ? !OMP_SETTING_KEYS.some((key) => key.startsWith(pattern))
          : !OMP_SETTING_KEYS.includes(pattern),
      ),
    );
    assert.deepStrictEqual(missing, []);
  });

  it.effect("change one key per page through the engine and read it back with `config get`", () =>
    Effect.gen(function* () {
      const omp = fakeOmp();
      const changes = [
        { page: OMP_SETTINGS_PAGES.models, key: "modelRoles", value: { smol: "anthropic/haiku" } },
        { page: OMP_SETTINGS_PAGES.routing, key: "retry.maxRetries", value: 7 },
        { page: OMP_SETTINGS_PAGES.thinking, key: "thinkingBudgets.high", value: 32000 },
      ];
      yield* makeOmpControlService().pipe(
        Effect.flatMap((control) => {
          const engine = makeOmpSettingsEngine({
            control,
            threads: {
              openThreads: Effect.succeed([]),
              sendCommand: () => Effect.void,
              readOverlay: () => Effect.succeed("{}\n"),
              writeOverlay: () => Effect.void,
              markRestartRequired: () => Effect.void,
            },
          });
          return Effect.forEach(changes, ({ page, key, value }) =>
            Effect.gen(function* () {
              const before = ompSettingsPageForm(yield* engine.read(TARGET), page);
              assert.include(
                before.fields.map((field) => field.key),
                key,
              );
              const result = yield* engine.write(TARGET, { key, value, scope: "global" });
              const field = ompSettingsPageForm(result.form, page).fields.find(
                (candidate) => candidate.key === key,
              );
              assert.strictEqual(field?.source, "global");
              assert.deepStrictEqual(field?.value, value);
              assert.deepStrictEqual(omp.configGet(key).value, value);
            }),
          );
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
        Effect.scoped,
      );
    }),
  );

  it("keep each page's fields in page order and leave other groups out", () => {
    const field = (key: string) => ({
      key,
      group: key.split(".")[0]!,
      type: "number" as const,
      description: "",
      source: "default" as const,
      redacted: false,
      credential: false,
      readOnly: false,
      launchScoped: false,
      threadOverride: "overlay" as const,
    });
    const form = {
      fields: ["compaction.enabled", "thinkingBudgets.low", "defaultThinkingLevel"].map(field),
    };
    assert.deepStrictEqual(
      ompSettingsPageForm(form, OMP_SETTINGS_PAGES.thinking).fields.map((f) => f.key),
      ["defaultThinkingLevel", "thinkingBudgets.low"],
    );
  });

  it("show path-scoped arrays read-only so their scoped entries are never overwritten", () => {
    // OMP flags these `pathScoped` in its registry; the pages must not lose a scoped entry.
    for (const key of OMP_PATH_SCOPED_KEYS) assert.include(OMP_SETTING_KEYS, key);
    const form = {
      fields: [...OMP_PATH_SCOPED_KEYS, "retry.maxRetries"].map((key) => ({
        key,
        group: key.split(".")[0]!,
        type: "array" as const,
        description: "",
        source: "global" as const,
        value: ["anthropic/claude-sonnet-4-5"],
        redacted: false,
        credential: false,
        readOnly: false,
        launchScoped: false,
        threadOverride: "overlay" as const,
      })),
    };
    for (const page of [OMP_SETTINGS_PAGES.models, OMP_SETTINGS_PAGES.routing]) {
      const fields = ompSettingsPageForm(form, page).fields;
      for (const field of fields) {
        assert.strictEqual(field.readOnly, OMP_PATH_SCOPED_KEYS.includes(field.key), field.key);
      }
    }
  });
});
