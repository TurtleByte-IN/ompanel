/** The OMP instance's settings API for the server: the engine with a resolved omp per call. */
import { OmpSettingsOperationError, ThreadId } from "@t3tools/contracts";
import type { ProviderOmpSettingsController } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";

import type { OmpControlError, OmpControlTarget } from "./control.ts";
import type { OmpSettingsEngine, OmpSettingsError, OmpThreadHostError } from "./settingsEngine.ts";
import type { OmpSidecarError } from "./sidecar.ts";
import type { OmpThreadSessions } from "./threadSessions.ts";

type ControllerError = OmpControlError | OmpSettingsError | OmpThreadHostError | OmpSidecarError;

const toOperationError = (error: ControllerError): OmpSettingsOperationError => {
  switch (error._tag) {
    case "OmpSettingsError":
      return new OmpSettingsOperationError({ reason: error.reason, message: error.message });
    case "OmpThreadHostError":
      return new OmpSettingsOperationError({ reason: "thread_failed", message: error.message });
    case "OmpControlError":
    case "OmpSidecarError":
      return new OmpSettingsOperationError({ reason: "omp_failed", message: error.message });
  }
};

export const makeOmpSettingsController = (input: {
  readonly engine: OmpSettingsEngine;
  readonly sessions: OmpThreadSessions;
  /** This instance's omp, resolved and verified for this call, run in `cwd`. */
  readonly target: (cwd: string) => Effect.Effect<OmpControlTarget, OmpSidecarError>;
  /** A directory with no project config, for reads and writes of the global layers only. */
  readonly globalCwd: string;
}): ProviderOmpSettingsController => {
  const { engine, sessions } = input;
  const target = (cwd: string | undefined) => input.target(cwd ?? input.globalCwd);
  /** A thread's settings resolve in its own working directory, wherever it runs. */
  const threadTarget = (threadId: string) =>
    input.target(sessions.get(threadId)?.cwd ?? input.globalCwd);
  const projectScoped = (cwd: string | undefined, scope: "global" | "project") =>
    scope === "project" && cwd === undefined
      ? Effect.fail(
          new OmpSettingsOperationError({
            reason: "project_not_found",
            message: "A project setting needs a project.",
          }),
        )
      : Effect.void;

  return {
    read: ({ cwd }) =>
      target(cwd).pipe(Effect.flatMap(engine.read), Effect.mapError(toOperationError)),
    write: ({ cwd, ...change }) =>
      projectScoped(cwd, change.scope).pipe(
        Effect.andThen(target(cwd)),
        Effect.flatMap((resolved) => engine.write(resolved, change)),
        Effect.map(({ restartRequired, ...result }) => ({
          ...result,
          restartRequired: restartRequired.map((threadId) => ThreadId.make(threadId)),
        })),
        Effect.mapError((error) =>
          error._tag === "OmpSettingsOperationError" ? error : toOperationError(error),
        ),
      ),
    reset: ({ cwd, ...change }) =>
      projectScoped(cwd, change.scope).pipe(
        Effect.andThen(target(cwd)),
        Effect.flatMap((resolved) => engine.reset(resolved, change)),
        Effect.map(({ restartRequired, ...result }) => ({
          ...result,
          restartRequired: restartRequired.map((threadId) => ThreadId.make(threadId)),
        })),
        Effect.mapError((error) =>
          error._tag === "OmpSettingsOperationError" ? error : toOperationError(error),
        ),
      ),
    setThreadOverride: ({ threadId, key, value }) =>
      threadTarget(threadId).pipe(
        Effect.flatMap((resolved) => engine.setThreadOverride(resolved, threadId, { key, value })),
        Effect.mapError(toOperationError),
      ),
    clearThreadOverride: ({ threadId, key }) =>
      threadTarget(threadId).pipe(
        Effect.flatMap((resolved) => engine.clearThreadOverride(resolved, threadId, key)),
        Effect.mapError(toOperationError),
      ),
  };
};
