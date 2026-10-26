// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { makeOmpPidfiles } from "./pidfiles.ts";
import { readProcessStartTime } from "./processTree.ts";
import { allDead, FAKE_OMP_FIXTURE, makeFakeOmpState, waitUntil } from "./testing/fakeOmp.ts";

// Process groups are POSIX; Windows trees are job objects.
const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

/** A pid that belonged to a process that has since exited: the previous server. */
const deadPid = () => NodeChildProcess.spawnSync(process.execPath, ["-e", "0"]).pid!;

/**
 * An `omp` tree left by a server that died: started detached like a session process, with stdin
 * still open (so it does not exit on its own) and nothing in this server tracking it.
 */
const startOrphan = (env: NodeJS.ProcessEnv) => {
  const orphan = NodeChildProcess.spawn(process.execPath, [FAKE_OMP_FIXTURE], {
    detached: true,
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...env, FAKE_OMP_SPAWN_TREE: "1", FAKE_OMP_IGNORE_SIGTERM: "1" },
  });
  orphan.unref();
  return orphan;
};

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

posixOnly("OMP pidfile sweep", () => {
  it.live("kills an orphaned tree from a previous boot and removes its pidfile", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const dir = NodePath.join(state.dir, "pids");
        const orphan = startOrphan(state.env());
        yield* Effect.addFinalizer(() => Effect.sync(() => orphan.kill("SIGKILL")));
        assert.isTrue(yield* waitUntil(() => state.tree() !== undefined));
        const tree = state.tree()!;

        const previousBoot = yield* makeOmpPidfiles({
          dir,
          platform: platform,
          bootId: "previous-boot",
          ownerPid: deadPid(),
        });
        yield* previousBoot.register({ pid: orphan.pid!, threadId: "thread-1" });

        const thisBoot = yield* makeOmpPidfiles({ dir, platform: platform });
        const entries = yield* thisBoot.sweep;
        assert.deepStrictEqual(
          entries.map((entry) => [entry.pid, entry.outcome]),
          [[orphan.pid!, "killed"]],
        );
        assert.isTrue(yield* waitUntil(() => allDead([tree.omp, tree.child, tree.grandchild])));
        assert.deepStrictEqual(NodeFS.readdirSync(dir), []);
      }),
    ),
  );

  it.live("never signals a group whose recorded omp is gone, since its pid may be reused", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const dir = NodePath.join(state.dir, "pids");
        const orphan = startOrphan(state.env());
        assert.isTrue(yield* waitUntil(() => state.tree() !== undefined));
        const tree = state.tree()!;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            for (const pid of [tree.child, tree.grandchild]) {
              try {
                process.kill(pid, "SIGKILL");
              } catch {
                // Already gone.
              }
            }
          }),
        );
        const previousBoot = yield* makeOmpPidfiles({
          dir,
          platform,
          bootId: "previous-boot",
          ownerPid: deadPid(),
        });
        yield* previousBoot.register({ pid: orphan.pid!, threadId: "thread-1" });
        // The recorded process exits; a live process group still answers to its id. That is
        // indistinguishable from the id having been reused by an unrelated program's group.
        orphan.kill("SIGKILL");
        assert.isTrue(yield* waitUntil(() => allDead([tree.omp])));
        assert.isFalse(allDead([tree.child, tree.grandchild]));

        const thisBoot = yield* makeOmpPidfiles({ dir, platform });
        const entries = yield* thisBoot.sweep;
        assert.deepStrictEqual(
          entries.map((entry) => entry.outcome),
          ["gone"],
        );
        assert.isFalse(allDead([tree.child]));
        assert.isFalse(allDead([tree.grandchild]));
        assert.deepStrictEqual(NodeFS.readdirSync(dir), []);
      }),
    ),
  );

  it.live("leaves this boot's processes, live owners and recycled pids alone", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const dir = NodePath.join(state.dir, "pids");
        const bystander = NodeChildProcess.spawn(
          process.execPath,
          ["-e", "setInterval(() => {}, 1000)"],
          { detached: true, stdio: "ignore" },
        );
        yield* Effect.addFinalizer(() => Effect.sync(() => bystander.kill("SIGKILL")));
        const pid = bystander.pid!;
        assert.isNotNull(yield* readProcessStartTime(pid, platform));

        const write = (name: string, record: object) =>
          NodeFS.writeFileSync(
            NodePath.join(dir, name),
            JSON.stringify({
              version: 1,
              pid,
              ownerPid: deadPid(),
              ownerBootId: "previous-boot",
              threadId: "thread-1",
              startedAt: "2026-10-26T00:00:00.000Z",
              startTime: "ps:not when it started",
              ...record,
            }),
          );
        NodeFS.mkdirSync(dir, { recursive: true });
        // Same pid, other start time: the pid was reused by an unrelated process.
        write("1.json", {});
        // Recorded by this server.
        write("2.json", { ownerBootId: "this-boot" });
        // Its server is still running.
        write("3.json", { ownerPid: process.pid });
        write("4.json", { startTime: null });
        NodeFS.writeFileSync(NodePath.join(dir, "5.json"), "not json");

        const sweeper = yield* makeOmpPidfiles({
          dir,
          platform: platform,
          bootId: "this-boot",
          ownerPid: process.ppid,
        });
        const outcomes = Object.fromEntries(
          (yield* sweeper.sweep).map((entry) => [NodePath.basename(entry.file), entry.outcome]),
        );
        assert.deepStrictEqual(outcomes, {
          "1.json": "recycled",
          "2.json": "owned",
          "3.json": "owned",
          "4.json": "kept",
          "5.json": "gone",
        });
        assert.isFalse(allDead([pid]));
        assert.deepStrictEqual(NodeFS.readdirSync(dir).sort(), ["2.json", "3.json", "4.json"]);
      }),
    ),
  );
});
