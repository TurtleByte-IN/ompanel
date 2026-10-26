import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { OmpControlTarget } from "./control.ts";
import { OmpControlError } from "./control.ts";
import { makeOmpSettingsController } from "./settingsController.ts";
import { type OmpSettingsEngine, OmpSettingsError, OmpThreadHostError } from "./settingsEngine.ts";
import { OmpSidecarError } from "./sidecar.ts";
import { makeOmpThreadSessions } from "./threadSessions.ts";

const FORM = { fields: [] };

/** Records the directory each engine call resolved its omp in; thread overrides fail with `fail`. */
function stubEngine(fail?: () => OmpSettingsError | OmpThreadHostError | OmpControlError) {
  const cwds: Array<string> = [];
  const record = (target: OmpControlTarget) => Effect.sync(() => void cwds.push(target.cwd));
  const override = <A>(target: OmpControlTarget, value: A) =>
    record(target).pipe(
      Effect.andThen(fail === undefined ? Effect.succeed(value) : Effect.fail(fail())),
    );
  const engine: OmpSettingsEngine = {
    read: (target) => record(target).pipe(Effect.as(FORM)),
    write: (target) =>
      record(target).pipe(
        Effect.as({ form: FORM, overriddenBy: "project", restartRequired: ["thread-a"] }),
      ),
    reset: (target) => record(target).pipe(Effect.as({ form: FORM, restartRequired: [] })),
    setThreadOverride: (target) =>
      override(target, { route: "overlay", restartRequired: true } as const),
    clearThreadOverride: (target) =>
      override(target, { route: "rpc", restartRequired: false } as const),
  };
  return { engine, cwds };
}

const target = (cwd: string) =>
  Effect.succeed({ binaryPath: "/opt/omp", profile: "", environment: {}, cwd });

describe("OMP settings controller", () => {
  it.effect("reads global layers in its own directory and project layers in the project", () =>
    Effect.gen(function* () {
      const { engine, cwds } = stubEngine();
      const sessions = makeOmpThreadSessions();
      const controller = makeOmpSettingsController({
        engine,
        sessions,
        target,
        globalCwd: "/state/omp",
      });

      yield* controller.read({ cwd: undefined });
      yield* controller.read({ cwd: "/work/app" });
      const written = yield* controller.write({
        cwd: undefined,
        scope: "global",
        key: "memory.backend",
        value: "local",
      });
      assert.deepStrictEqual(written.restartRequired, [ThreadId.make("thread-a")]);
      assert.strictEqual(written.overriddenBy, "project");
      assert.deepStrictEqual(cwds, ["/state/omp", "/work/app", "/state/omp"]);
    }),
  );

  it.effect("refuses a project write without a project before resolving omp", () =>
    Effect.gen(function* () {
      const { engine, cwds } = stubEngine();
      const controller = makeOmpSettingsController({
        engine,
        sessions: makeOmpThreadSessions(),
        target,
        globalCwd: "/state/omp",
      });
      const errors = yield* Effect.all([
        controller
          .write({ cwd: undefined, scope: "project", key: "k", value: 1 })
          .pipe(Effect.flip),
        controller.reset({ cwd: undefined, scope: "project", key: "k" }).pipe(Effect.flip),
      ]);
      assert.deepStrictEqual(
        errors.map((error) => error.reason),
        ["project_not_found", "project_not_found"],
      );
      assert.deepStrictEqual(cwds, []);
    }),
  );

  it.effect("resolves thread overrides in the running thread's directory", () =>
    Effect.gen(function* () {
      const { engine, cwds } = stubEngine();
      const sessions = makeOmpThreadSessions();
      const controller = makeOmpSettingsController({
        engine,
        sessions,
        target,
        globalCwd: "/state/omp",
      });
      yield* sessions.register({
        threadId: "thread-a",
        providerSessionId: ProviderSessionId.make("session-a"),
        cwd: "/work/app/wt/feature",
        process: { request: () => Effect.die("unused") },
        onRestartRequired: () => Effect.void,
      });
      yield* controller.setThreadOverride({
        threadId: ThreadId.make("thread-a"),
        key: "modelRoles",
        value: {},
      });
      yield* controller.clearThreadOverride({ threadId: ThreadId.make("thread-b"), key: "x" });
      assert.deepStrictEqual(cwds, ["/work/app/wt/feature", "/state/omp"]);
    }).pipe(Effect.scoped),
  );

  it.effect("maps engine, thread, omp and sidecar failures to operation errors", () =>
    Effect.gen(function* () {
      const failures = [
        new OmpSettingsError({ key: "exa.apiKey", reason: "credential" }),
        new OmpThreadHostError({ threadId: "thread-a", reason: "not_open" }),
        new OmpControlError({ operation: "config_set", reason: "exit", exitCode: 1 }),
      ];
      const reasons = yield* Effect.forEach(failures, (failure) =>
        makeOmpSettingsController({
          engine: stubEngine(() => failure).engine,
          sessions: makeOmpThreadSessions(),
          target,
          globalCwd: "/state/omp",
        })
          .setThreadOverride({ threadId: ThreadId.make("thread-a"), key: "k", value: 1 })
          .pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
      );
      const sidecar = yield* makeOmpSettingsController({
        engine: stubEngine().engine,
        sessions: makeOmpThreadSessions(),
        target: () => Effect.fail(new OmpSidecarError({ reason: "not_found", detail: "gone" })),
        globalCwd: "/state/omp",
      })
        .read({ cwd: undefined })
        .pipe(Effect.flip);
      assert.deepStrictEqual(
        [...reasons, sidecar.reason],
        ["credential", "thread_failed", "omp_failed", "omp_failed"],
      );
    }),
  );
});
