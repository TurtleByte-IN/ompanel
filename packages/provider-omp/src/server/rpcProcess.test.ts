// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { makeOmpPidfiles } from "./pidfiles.ts";
import { isOmpTreeAlive, isProcessAlive } from "./processTree.ts";
import { startOmpRpcProcess } from "./rpcProcess.ts";
import {
  allDead,
  FAKE_OMP_FIXTURE,
  type FakeOmpState,
  makeFakeOmpState,
  waitUntil,
} from "./testing/fakeOmp.ts";

// Process groups are POSIX; Windows trees are job objects.
const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");
const MiB = 1024 * 1024;

const start = (
  state: FakeOmpState,
  vars: Record<string, string> = {},
  args: ReadonlyArray<string> = ["--mode", "rpc-ui", "--approval-mode", "always-ask"],
) =>
  Effect.gen(function* () {
    const pidfiles = yield* makeOmpPidfiles({
      dir: `${state.dir}/pids`,
      platform: platform,
    });
    return yield* startOmpRpcProcess({
      command: process.execPath,
      args: [FAKE_OMP_FIXTURE, ...args],
      cwd: state.dir,
      env: state.env(vars),
      platform: platform,
      expectedContractVersion: "1.0.0",
      pidfiles,
      threadId: "thread-1",
      readyTimeoutMs: 10_000,
    });
  });

const live = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer));

posixOnly("startOmpRpcProcess", () => {
  it.live("never spawns a command line without an explicit, known --approval-mode", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        for (const args of [
          ["--mode", "rpc-ui"],
          ["--mode", "rpc-ui", "--approval-mode"],
          ["--mode", "rpc-ui", "--approval-mode", "ask-sometimes"],
        ]) {
          const error = yield* start(state, {}, args).pipe(Effect.flip);
          assert.strictEqual(error._tag, "OmpRpcError");
          if (error._tag === "OmpRpcError") assert.strictEqual(error.reason, "spawn");
        }
        // The fake writes argv.json as soon as it starts: nothing was spawned.
        assert.isFalse(NodeFS.existsSync(NodePath.join(state.dir, "argv.json")));
      }),
    ),
  );

  it.live("reads ready, negotiates protocol v2 and answers commands", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const omp = yield* start(state);
        assert.strictEqual(omp.contractVersion, "1.0.0");
        assert.deepStrictEqual(omp.ready.supportedProtocolVersions, [1, 2]);
        assert.deepStrictEqual(state.events(), ["command:negotiate_protocol"]);

        const sessionState = yield* omp.request("get_state", undefined);
        assert.strictEqual(sessionState.sessionId, "fake-session");

        const frame = yield* omp.frames.pipe(Stream.runHead);
        assert.deepStrictEqual(Option.getOrUndefined(frame), {
          type: "notice",
          message: "negotiated",
        } as never);

        const error = yield* omp.request("abort", undefined).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OmpRpcCommandError");
        if (error._tag === "OmpRpcCommandError") assert.strictEqual(error.code, "unsupported");

        // A pidfile is kept while the process runs.
        assert.isTrue(isProcessAlive(omp.pid));
      }),
    ),
  );

  it.live("reassembles rpc_chunk sequences into one frame", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const omp = yield* start(
          state,
          state.script({
            afterNegotiate: [
              { emitChunked: { type: "notice", message: "y".repeat(3 * MiB) } },
              { emit: { type: "notice", message: "after-chunked" } },
            ],
          }),
        );
        const frames = yield* omp.frames.pipe(Stream.take(2), Stream.runCollect);
        const [big, after] = frames;
        assert.strictEqual(big?.type, "notice");
        assert.strictEqual((big as { message: string }).message.length, 3 * 1024 * 1024);
        assert.deepStrictEqual(after, { type: "notice", message: "after-chunked" } as never);
      }),
    ),
  );

  it.live("echoes a response onto the frame stream behind the frames written before it", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const omp = yield* start(
          state,
          state.script({
            afterNegotiate: [],
            commands: {
              prompt: [
                { emit: { type: "command_output", text: "Context: 12%" } },
                { respond: { agentInvoked: false } },
              ],
            },
          }),
        );
        const ack = yield* omp.request("prompt", { message: "/context" }, { echoResponse: true });
        assert.deepStrictEqual(ack, { agentInvoked: false });
        const frames = yield* omp.frames.pipe(Stream.take(2), Stream.runCollect);
        assert.deepStrictEqual(
          frames.map((frame) => frame.type),
          ["command_output", "response"],
        );
        assert.propertyVal(frames[1], "command", "prompt");
      }),
    ),
  );

  it.live("refuses a chunk sequence over 64 MiB and stops the process", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const byteLength = 64 * MiB + 1;
        const omp = yield* start(
          state,
          state.script({
            afterNegotiate: [
              {
                emit: {
                  type: "rpc_chunk",
                  chunkId: "fake-big",
                  index: 0,
                  count: Math.ceil(byteLength / (256 * 1024)),
                  byteLength,
                  data: Buffer.alloc(256 * 1024, 0x61).toString("base64"),
                },
              },
            ],
          }),
        );
        const error = yield* omp.frames.pipe(Stream.runDrain, Effect.flip);
        assert.strictEqual(error.reason, "protocol");
        assert.include(error.detail, "64");
        assert.isTrue(yield* waitUntil(() => !isOmpTreeAlive(omp.pid, platform)));
      }),
    ),
  );

  it.live("refuses a line over the 1 MiB frame limit", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const omp = yield* start(
          state,
          state.script({ afterNegotiate: [{ writeRaw: `${"z".repeat(MiB + 16)}\n` }] }),
        );
        const error = yield* omp.frames.pipe(Stream.runDrain, Effect.flip);
        assert.strictEqual(error.reason, "protocol");
      }),
    ),
  );

  it.live("refuses rpc_chunk before protocol v2 is negotiated", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const error = yield* start(
          state,
          state.script({
            afterReady: [{ emitChunked: { type: "notice", message: "x".repeat(2 * MiB) } }],
          }),
        ).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OmpRpcError");
        if (error._tag === "OmpRpcError") assert.strictEqual(error.reason, "protocol");
      }),
    ),
  );

  it.live("refuses a sidecar whose ready frame reports another contract, and kills it", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const error = yield* start(state, {
          FAKE_OMP_CONTRACT: "1.3.0",
          FAKE_OMP_SPAWN_TREE: "1",
        }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OmpContractMismatchError");
        if (error._tag !== "OmpContractMismatchError") return;
        assert.strictEqual(error.actual, "1.3.0");
        assert.strictEqual(error.expected, "1.0.0");
        assert.strictEqual(error.stage, "ready");
        // Never negotiated, never driven.
        assert.notInclude(state.events(), "command:negotiate_protocol");
        const { argv } = state.argv();
        assert.include(argv, "rpc-ui");
        assert.isTrue(
          yield* waitUntil(() => {
            const tree = state.tree();
            return tree === undefined || allDead([tree.omp, tree.child, tree.grandchild]);
          }),
        );
      }),
    ),
  );

  it.live("refuses a sidecar with no contract version", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const error = yield* start(state, { FAKE_OMP_CONTRACT: "none" }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OmpContractMismatchError");
        if (error._tag === "OmpContractMismatchError") assert.isNull(error.actual);
      }),
    ),
  );

  it.live("refuses a negotiate_protocol response with another contract", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const error = yield* start(state, { FAKE_OMP_NEGOTIATE_CONTRACT: "2.0.0" }).pipe(
          Effect.flip,
        );
        assert.strictEqual(error._tag, "OmpContractMismatchError");
        if (error._tag === "OmpContractMismatchError") {
          assert.strictEqual(error.stage, "negotiate_protocol");
        }
      }),
    ),
  );

  it.live("refuses a sidecar without protocol v2", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const error = yield* start(state, { FAKE_OMP_V1_ONLY: "1" }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OmpRpcError");
        if (error._tag === "OmpRpcError") assert.strictEqual(error.reason, "negotiate");
      }),
    ),
  );

  it.live("refuses a first frame that is not ready", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const error = yield* start(state, { FAKE_OMP_FIRST_FRAME: "notice" }).pipe(Effect.flip);
        assert.strictEqual(error._tag, "OmpRpcError");
        if (error._tag === "OmpRpcError") assert.strictEqual(error.reason, "ready");
      }),
    ),
  );

  it.live("exits gracefully when stdin closes, without being signalled", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const omp = yield* start(state);
        const exit = yield* omp.close();
        assert.deepStrictEqual(exit, { code: 0, graceful: true });
        assert.include(state.events(), "stdin-end");
        assert.notInclude(state.events(), "sigterm");
        // The frame stream ends cleanly.
        const drained = yield* omp.frames.pipe(Stream.runDrain, Effect.exit);
        assert.isTrue(Exit.isSuccess(drained));
      }),
    ),
  );

  it.live("kills the tree when a stdin close does not end the process in time", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const omp = yield* start(state, { FAKE_OMP_IGNORE_STDIN_END: "1" });
        const exit = yield* omp.close(300);
        assert.isFalse(exit.graceful);
        assert.include(state.events(), "stdin-end");
        assert.include(state.events(), "sigterm");
        assert.isFalse(isOmpTreeAlive(omp.pid, platform));
      }),
    ),
  );

  it.live("kills the whole process tree, child of child included", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const omp = yield* start(state, {
          FAKE_OMP_SPAWN_TREE: "1",
          // SIGTERM alone must not be enough: the kill escalates.
          FAKE_OMP_IGNORE_SIGTERM: "1",
        });
        assert.isTrue(yield* waitUntil(() => state.tree() !== undefined));
        const tree = state.tree()!;
        assert.strictEqual(tree.omp, omp.pid);
        assert.isFalse(allDead([tree.child, tree.grandchild]));
        yield* omp.kill;
        assert.isTrue(yield* waitUntil(() => allDead([tree.omp, tree.child, tree.grandchild])));
      }),
    ),
  );

  it.live("kills descendants left behind by a graceful exit", () =>
    live(
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const omp = yield* start(state, { FAKE_OMP_SPAWN_TREE: "1" });
        assert.isTrue(yield* waitUntil(() => state.tree() !== undefined));
        const tree = state.tree()!;
        const exit = yield* omp.close();
        assert.isTrue(exit.graceful);
        assert.isTrue(yield* waitUntil(() => allDead([tree.child, tree.grandchild])));
      }),
    ),
  );

  it.live("closing the scope kills the tree and removes the pidfile", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const tree = yield* Effect.gen(function* () {
        const omp = yield* start(state, { FAKE_OMP_SPAWN_TREE: "1" });
        assert.isTrue(yield* waitUntil(() => state.tree() !== undefined));
        const pidfiles = yield* makeOmpPidfiles({
          dir: `${state.dir}/pids`,
          platform: platform,
        });
        assert.deepStrictEqual(
          (yield* pidfiles.sweep).map((entry) => [entry.pid, entry.outcome]),
          [[omp.pid, "owned"]],
        );
        return state.tree()!;
      }).pipe(Effect.scoped);
      assert.isTrue(yield* waitUntil(() => allDead([tree.omp, tree.child, tree.grandchild])));
      const pidfiles = yield* makeOmpPidfiles({
        dir: `${state.dir}/pids`,
        platform: platform,
      });
      assert.deepStrictEqual(yield* pidfiles.sweep, []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
