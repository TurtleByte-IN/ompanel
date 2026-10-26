// @effect-diagnostics nodeBuiltinImport:off
// The Windows job-object launcher against real processes; CI runs it on the Windows desktop
// smoke runner (docs/omp/ci.md). POSIX trees are covered in rpcProcess.test.ts.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { makeOmpPidfiles } from "./pidfiles.ts";
import { materializeOmpJobLauncher, ompJobLauncherCommand } from "./processTree.ts";
import { startOmpRpcProcess } from "./rpcProcess.ts";
import {
  allDead,
  FAKE_OMP_FIXTURE,
  type FakeOmpState,
  makeFakeOmpState,
  waitUntil,
} from "./testing/fakeOmp.ts";

const platform = HostProcess.Platform.defaultValue();

// On windows-11-arm the launcher's PowerShell start costs ~20-30 s per spawn (ompanel#145), so
// the waits get room: ready + tree + death (150 s) stays under the per-test limit (180 s).
const READY_MS = 90_000;
const TREE_MS = 30_000;
const DEATH_MS = 30_000;

/** The fake omp, with a child and a grandchild, under the job-object launcher as sessions run it. */
const startUnderJob = (state: FakeOmpState) =>
  Effect.gen(function* () {
    const launcher = yield* materializeOmpJobLauncher(`${state.dir}/launcher`);
    const launch = ompJobLauncherCommand(launcher, {
      command: process.execPath,
      args: [FAKE_OMP_FIXTURE, "--mode", "rpc-ui", "--approval-mode", "always-ask"],
    });
    const omp = yield* startOmpRpcProcess({
      command: launch.command,
      args: launch.args,
      cwd: state.dir,
      env: state.env({ FAKE_OMP_SPAWN_TREE: "1" }),
      platform,
      expectedContractVersion: "1.0.0",
      pidfiles: yield* makeOmpPidfiles({ dir: `${state.dir}/pids`, platform }),
      threadId: "thread-1",
      readyTimeoutMs: READY_MS,
    });
    assert.isTrue(yield* waitUntil(() => state.tree() !== undefined, TREE_MS));
    const tree = state.tree()!;
    // The launcher is the spawned process; omp is its child.
    assert.notStrictEqual(tree.omp, omp.pid);
    assert.isFalse(allDead([omp.pid, tree.omp, tree.child, tree.grandchild]));
    return { omp, tree };
  });

describe.runIf(platform === "win32")("Windows job-object launcher, live", () => {
  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- PowerShell launcher start on arm64 runners is slow (ompanel#145), not a hidden wait.
  it.live(
    "stop kills the launcher, omp, its child and its grandchild",
    () =>
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const { omp, tree } = yield* startUnderJob(state);
        yield* omp.kill;
        assert.isTrue(
          yield* waitUntil(
            () => allDead([omp.pid, tree.omp, tree.child, tree.grandchild]),
            DEATH_MS,
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );

  // oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- PowerShell launcher start on arm64 runners is slow (ompanel#145), not a hidden wait.
  it.live(
    "the tree dies with the launcher even when only the launcher is terminated",
    () =>
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const { omp, tree } = yield* startUnderJob(state);
        // TerminateProcess on the launcher alone, no tree walk: the kill-on-close job must end
        // everything else when its only handle goes away.
        process.kill(omp.pid);
        assert.isTrue(
          yield* waitUntil(
            () => allDead([omp.pid, tree.omp, tree.child, tree.grandchild]),
            DEATH_MS,
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    180_000,
  );
});
