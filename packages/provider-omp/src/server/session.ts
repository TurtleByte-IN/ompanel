/**
 * Starts the `omp --mode rpc-ui` process that backs one thread: one process per thread, one
 * `--config` overlay per thread, the instance's profile, and an explicit approval mode.
 */
import type { RuntimeMode } from "@t3tools/contracts";
import { AgentScope } from "@t3tools/shared/AgentScope";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";

import {
  ensureOmpThreadOverlay,
  ompApprovalModeFor,
  ompSessionArgs,
  ompThreadOverlayPath,
} from "./launch.ts";
import type { OmpPidfiles } from "./pidfiles.ts";
import { materializeOmpJobLauncher, ompJobLauncherCommand } from "./processTree.ts";
import { startOmpRpcProcess } from "./rpcProcess.ts";

/** Where an instance keeps its process state: pidfiles, the Windows launcher, thread overlays. */
export interface OmpStateDirs {
  readonly pidfiles: string;
  readonly launcher: string;
  readonly threads: string;
}

export const ompStateDirs = (path: Path.Path, stateDir: string): OmpStateDirs => {
  const root = path.join(stateDir, "omp");
  return {
    pidfiles: path.join(root, "processes"),
    launcher: root,
    threads: path.join(root, "threads"),
  };
};

export interface OmpSessionProcessInput {
  /** Absolute path of the verified `omp` binary, resolved right before this spawn. */
  readonly binaryPath: string;
  readonly profile: string;
  /** The instance's launch arguments, appended to omp's argv. */
  readonly launchArgs?: ReadonlyArray<string>;
  readonly runtimeMode: RuntimeMode;
  readonly cwd: string;
  readonly threadId: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly dirs: OmpStateDirs;
  readonly pidfiles: OmpPidfiles;
  readonly expectedContractVersion: string;
  readonly readyTimeoutMs?: number;
}

/** Spawns the thread's `omp` in the current scope and completes the protocol handshake. */
export const startOmpSessionProcess = Effect.fn("startOmpSessionProcess")(function* (
  input: OmpSessionProcessInput,
) {
  const path = yield* Path.Path;
  const scope = yield* Effect.scope;
  const overlayPath = ompThreadOverlayPath(path, input.dirs.threads, input.threadId);
  yield* ensureOmpThreadOverlay(overlayPath);
  const args = ompSessionArgs({
    approvalMode: ompApprovalModeFor(input.runtimeMode),
    profile: input.profile,
    overlayPath,
    cwd: input.cwd,
    ...(input.launchArgs === undefined ? {} : { launchArgs: input.launchArgs }),
  });

  const agentScope = yield* AgentScope;
  const scoped = yield* agentScope.wrap({
    command: input.binaryPath,
    args,
    name: "omp",
    threadId: input.threadId,
    env: input.environment,
  });
  // Finalizers run in reverse: the systemd scope (Linux) is reaped after omp is gone.
  if (scoped.unit !== undefined) {
    const unit = scoped.unit;
    yield* Scope.addFinalizer(scope, agentScope.stop(unit));
  }
  const launch =
    input.platform === "win32"
      ? ompJobLauncherCommand(yield* materializeOmpJobLauncher(input.dirs.launcher), scoped)
      : scoped;

  return yield* startOmpRpcProcess({
    command: launch.command,
    args: launch.args,
    cwd: input.cwd,
    env: input.environment,
    platform: input.platform,
    expectedContractVersion: input.expectedContractVersion,
    pidfiles: input.pidfiles,
    threadId: input.threadId,
    ...(input.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: input.readyTimeoutMs }),
  });
});
