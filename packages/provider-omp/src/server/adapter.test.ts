// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Stream from "effect/Stream";

import { makeOmpAdapter } from "./adapter.ts";
import { OMP_EMPTY_OVERLAY, ompApprovalModeFor, ompSessionArgs } from "./launch.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import { ompStateDirs, startOmpSessionProcess } from "./session.ts";
import {
  type FakeOmpState,
  type FakeOmpStep,
  fakeOmpFrames,
  makeFakeOmpState,
  waitUntil,
} from "./testing/fakeOmp.ts";
import { makeOmpThreadSessions, makeOmpThreadSettingsHost } from "./threadSessions.ts";

// Process groups and the `#!/bin/sh` fake omp are POSIX; Windows trees are job objects.
const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const makeAdapter = (state: FakeOmpState, profile: string, vars: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
    const pidfiles = yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform: platform });
    const binaryPath = state.executable();
    const threadSessions = makeOmpThreadSessions();
    const adapter = yield* makeOmpAdapter({
      instanceId: ProviderInstanceId.make("omp-work"),
      profile,
      environment: state.env(vars),
      platform: platform,
      defaultCwd: state.dir,
      resolveBinary: Effect.succeed(binaryPath),
      dirs,
      pidfiles,
      expectedContractVersion: "1.0.0",
      threadSessions,
      sessions: state.sessions,
    });
    return { adapter, dirs, threadSessions };
  });

const openInput = (cwd: string, runtimeMode: "approval-required" | "full-access") => ({
  threadId: ThreadId.make("thread/1"),
  providerSessionId: ProviderSessionId.make("session-1"),
  modelSelection: { instanceId: ProviderInstanceId.make("omp-work"), model: "default" },
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd,
  }),
});

describe("OMP launch arguments", () => {
  it("maps runtime modes to explicit approval modes", () => {
    assert.strictEqual(ompApprovalModeFor("approval-required"), "always-ask");
    assert.strictEqual(ompApprovalModeFor("auto-accept-edits"), "write");
    assert.strictEqual(ompApprovalModeFor("full-access"), "yolo");
    // Auto is not offered for OMP and must never widen permissions.
    assert.strictEqual(ompApprovalModeFor("auto"), "always-ask");
  });

  it("leaves out --profile for the default profile", () => {
    assert.deepStrictEqual(
      ompSessionArgs({ approvalMode: "yolo", profile: "", overlayPath: "/o.yml", cwd: "/w" }),
      ["--mode", "rpc-ui", "--approval-mode", "yolo", "--config", "/o.yml", "--cwd", "/w"],
    );
  });

  it("passes the profile, overlay and cwd as single arguments, spaces included", () => {
    assert.deepStrictEqual(
      ompSessionArgs({
        approvalMode: "write",
        profile: "work",
        overlayPath: "/state dir/overlay.yml",
        cwd: "/my work",
      }),
      [
        "--mode",
        "rpc-ui",
        "--approval-mode",
        "write",
        "--profile",
        "work",
        "--config",
        "/state dir/overlay.yml",
        "--cwd",
        "/my work",
      ],
    );
  });
});

const MiB = 1024 * 1024;

/** A scripted run: a streamed turn with a tool, a subagent, a `/fresh` id swap, a chunked frame. */
const streamedRun: ReadonlyArray<FakeOmpStep> = [
  // Not answering a command here, so the turn's ack is left out.
  ...fakeOmpFrames
    .promptTurn({
      text: ["Hello", " world"],
      thinking: ["Thinking"],
      tool: {
        toolCallId: "call-1",
        toolName: "read",
        args: { path: "README.md" },
        result: { content: [{ type: "text", text: "readme" }] },
      },
    })
    .filter((step) => !("respond" in step)),
  { emit: fakeOmpFrames.subagentLifecycle({ id: "sub-1", status: "started" }) },
  { emit: fakeOmpFrames.subagentEvent("sub-1", { type: "agent_start" }) },
  { emit: fakeOmpFrames.subagentLifecycle({ id: "sub-1", status: "completed" }) },
  { emit: fakeOmpFrames.sessionInfoUpdate("fake-session-2") },
  {
    emitChunked: {
      type: "tool_execution_end",
      toolCallId: "call-2",
      toolName: "bash",
      result: { content: [{ type: "text", text: "o".repeat(3 * MiB) }] },
    },
  },
  { emit: fakeOmpFrames.notice("end of script") },
];

const STREAMED_RUN_TYPES = [
  "agent_start",
  "turn_start",
  "message_start",
  ...Array.from({ length: 9 }, () => "message_update"),
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "turn_end",
  "agent_end",
  "prompt_result",
  "subagent_lifecycle",
  "subagent_event",
  "subagent_lifecycle",
  "session_info_update",
  // The chunked frame arrives reassembled, never as `rpc_chunk`.
  "tool_execution_end",
  "notice",
];

/** Frame types the adapter drained, from its debug log (it logs types, never content). */
const recordFrameTypes = () => {
  const types: Array<string> = [];
  const logger = Logger.make(({ message }) => {
    const [text, data]: ReadonlyArray<unknown> = [message].flat();
    if (text !== "omp frame" || typeof data !== "object" || data === null) return;
    if ("type" in data && typeof data.type === "string") types.push(data.type);
  });
  return {
    types,
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      ),
  };
};

posixOnly("OmpAdapter driven by the scripted fake omp", () => {
  it.live(
    "drains a streamed turn, tools, subagents, an id swap and a chunked frame in order",
    () => {
      const log = recordFrameTypes();
      return Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const { adapter } = yield* makeAdapter(
          state,
          "",
          state.script({ afterNegotiate: streamedRun }),
        );
        const updates = yield* Effect.gen(function* () {
          const session = yield* adapter.openSession(openInput(state.dir, "full-access"));
          assert.strictEqual(session.providerSession.status, "ready");
          assert.isTrue(yield* waitUntil(() => log.types.length >= STREAMED_RUN_TYPES.length));
          return session.events;
        }).pipe(Effect.scoped);
        assert.deepStrictEqual(log.types, STREAMED_RUN_TYPES);
        const last = yield* updates.pipe(Stream.runLast);
        assert.strictEqual(last._tag, "Some");
        if (last._tag === "Some" && last.value.type === "provider_session.updated") {
          assert.strictEqual(last.value.providerSession.status, "stopped");
          assert.isNull(last.value.providerSession.lastError);
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), log.provide);
    },
  );

  it.live("reports an omp that exits mid-stream as a session error", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter } = yield* makeAdapter(
        state,
        "",
        state.script({ afterNegotiate: [{ emit: fakeOmpFrames.notice("working") }, { exit: 3 }] }),
      );
      const session = yield* adapter.openSession(openInput(state.dir, "full-access"));
      const last = yield* session.events.pipe(Stream.runLast);
      assert.strictEqual(last._tag, "Some");
      if (last._tag === "Some" && last.value.type === "provider_session.updated") {
        assert.strictEqual(last.value.providerSession.status, "error");
        assert.include(last.value.providerSession.lastError ?? "", "code 3");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

/** The thread process `openSession` starts, for the command side the adapter does not map yet. */
const startSession = (state: FakeOmpState, vars: Record<string, string>) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
    return yield* startOmpSessionProcess({
      binaryPath: state.executable(),
      profile: "",
      runtimeMode: "full-access",
      cwd: state.dir,
      threadId: "thread-1",
      environment: state.env(vars),
      platform: platform,
      dirs,
      pidfiles: yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform: platform }),
      expectedContractVersion: "1.0.0",
    });
  });

posixOnly("OMP thread process driven by the scripted fake omp", () => {
  it.live("streams a prompt turn and correlates its prompt_result", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const omp = yield* startSession(
        state,
        state.script({
          afterNegotiate: [],
          commands: { prompt: fakeOmpFrames.promptTurn({ text: ["Hel", "lo"] }) },
        }),
      );
      const ack = yield* omp.request("prompt", { message: "hi" });
      assert.deepStrictEqual(ack, { agentInvoked: true });
      const frames = yield* omp.frames.pipe(
        Stream.takeUntil((frame) => frame.type === "prompt_result"),
        Stream.runCollect,
      );
      const deltas = frames.flatMap((frame) =>
        frame.type === "message_update" && frame.assistantMessageEvent.type === "text_delta"
          ? [frame.assistantMessageEvent.delta]
          : [],
      );
      assert.strictEqual(deltas.join(""), "Hello");
      const result = frames.at(-1);
      const prompt = state.commands().find((command) => command["type"] === "prompt");
      assert.strictEqual(result?.type, "prompt_result");
      if (result?.type === "prompt_result") {
        assert.strictEqual(result.id, prompt?.["id"]);
        assert.strictEqual(result.status, "completed");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("swaps the session id on /fresh's session_info_update", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const omp = yield* startSession(
        state,
        state.script({
          afterNegotiate: [],
          commands: {
            prompt: [
              { emit: fakeOmpFrames.sessionInfoUpdate("fake-session-fresh") },
              { respond: { agentInvoked: false } },
            ],
          },
        }),
      );
      assert.strictEqual((yield* omp.request("get_state", undefined)).sessionId, "fake-session");
      const ack = yield* omp.request("prompt", { message: "/fresh" });
      assert.deepStrictEqual(ack, { agentInvoked: false });
      const [update] = yield* omp.frames.pipe(Stream.take(1), Stream.runCollect);
      assert.deepStrictEqual(update, {
        type: "session_info_update",
        sessionId: "fake-session-fresh",
      });
      const after = yield* omp.request("get_state", undefined);
      assert.strictEqual(after.sessionId, "fake-session-fresh");
      assert.strictEqual(after.sessionFile, "/fake/sessions/fake-session-fresh.jsonl");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("surfaces session_busy as a typed command error and keeps the session usable", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const omp = yield* startSession(
        state,
        state.script({
          commands: {
            fork: [{ fail: "Cannot fork the session while it is busy", code: "session_busy" }],
          },
        }),
      );
      const error = yield* omp.request("fork", {}).pipe(Effect.flip);
      assert.strictEqual(error._tag, "OmpRpcCommandError");
      if (error._tag === "OmpRpcCommandError") {
        assert.strictEqual(error.command, "fork");
        assert.strictEqual(error.code, "session_busy");
      }
      assert.strictEqual((yield* omp.request("get_state", undefined)).sessionId, "fake-session");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reassembles a chunked frame between its neighbours", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const omp = yield* startSession(
        state,
        state.script({
          afterNegotiate: [
            { emit: fakeOmpFrames.notice("before") },
            {
              emitChunked: {
                type: "tool_execution_end",
                toolCallId: "call-1",
                toolName: "bash",
                result: { output: "o".repeat(3 * MiB) },
              },
            },
            { emit: fakeOmpFrames.notice("after") },
          ],
        }),
      );
      const frames = yield* omp.frames.pipe(Stream.take(3), Stream.runCollect);
      assert.deepStrictEqual(
        frames.map((frame) => frame.type),
        ["notice", "tool_execution_end", "notice"],
      );
      assert.deepStrictEqual(frames[1], {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "bash",
        result: { output: "o".repeat(3 * MiB) },
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

posixOnly("OmpAdapter.openSession", () => {
  it.live(
    "spawns omp --mode rpc-ui with the thread's approval mode, profile, overlay and cwd",
    () =>
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const work = NodePath.join(state.dir, "work tree");
        NodeFS.mkdirSync(work);
        const { adapter, dirs } = yield* makeAdapter(state, "work");

        const updates = yield* Effect.gen(function* () {
          const session = yield* adapter.openSession(openInput(work, "approval-required"));
          assert.strictEqual(session.providerSession.status, "ready");
          assert.strictEqual(session.providerSession.cwd, work);

          const overlayPath = NodePath.join(dirs.threads, "thread%2F1", "overlay.yml");
          assert.deepStrictEqual(state.argv().argv, [
            "--mode",
            "rpc-ui",
            "--approval-mode",
            "always-ask",
            "--profile",
            "work",
            "--config",
            overlayPath,
            "--cwd",
            work,
          ]);
          assert.strictEqual(state.argv().cwd, NodeFS.realpathSync(work));
          assert.strictEqual(NodeFS.readFileSync(overlayPath, "utf8"), OMP_EMPTY_OVERLAY);
          assert.strictEqual(NodeFS.statSync(overlayPath).mode & 0o777, 0o600);
          // After the handshake the session subscribes to the subagent frames that feed the
          // agents panel, enables OMP's ask dialog and checks that its session is a fresh one.
          assert.deepStrictEqual(state.events(), [
            "command:negotiate_protocol",
            "command:set_subagent_subscription",
            "command:set_ask_dialog",
            "command:get_state",
          ]);
          assert.strictEqual(NodeFS.readdirSync(dirs.pidfiles).length, 1);

          // The thread binds to the session the process opened.
          const providerThread = yield* session.ensureThread({
            threadId: ThreadId.make("thread/1"),
            modelSelection: openInput(work, "approval-required").modelSelection,
            runtimePolicy: openInput(work, "approval-required").runtimePolicy,
          });
          assert.strictEqual(providerThread.nativeThreadRef?.nativeId, "fake-session");
          return session.events;
        }).pipe(Effect.scoped);

        // Stopping the thread closed stdin; omp drained and exited on its own.
        assert.include(state.events(), "stdin-end");
        assert.notInclude(state.events(), "sigterm");
        assert.deepStrictEqual(NodeFS.readdirSync(dirs.pidfiles), []);
        const last = yield* updates.pipe(Stream.runLast);
        assert.strictEqual(last._tag, "Some");
        if (last._tag === "Some" && last.value.type === "provider_session.updated") {
          assert.strictEqual(last.value.providerSession.status, "stopped");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "registers the running thread for settings: overlay kept on respawn, RPC commands, restart marker",
    () =>
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const { adapter, dirs, threadSessions } = yield* makeAdapter(state, "");
        const capabilities = yield* adapter.getCapabilities();
        const host = yield* makeOmpThreadSettingsHost({
          sessions: threadSessions,
          threadsDir: dirs.threads,
        });
        const overlayPath = NodePath.join(dirs.threads, "thread%2F1", "overlay.yml");
        // Overrides written while the thread was stopped survive its next start.
        const overrides =
          '# Per-thread OMP settings written by Ompanel.\n{"memory":{"backend":"local"}}\n';
        yield* host.writeOverlay("thread/1", overrides);
        const input = openInput(state.dir, "approval-required");
        const transition = (providerSessionId = input.providerSessionId) =>
          adapter.planSelectionTransition({
            current: input.modelSelection,
            target: { ...input.modelSelection, model: "other" },
            sessionCapabilities: capabilities,
            providerSessionId,
          });

        const events = yield* Effect.gen(function* () {
          const session = yield* adapter.openSession(input);
          assert.strictEqual(NodeFS.readFileSync(overlayPath, "utf8"), overrides);
          assert.strictEqual(yield* host.readOverlay("thread/1"), overrides);
          assert.deepStrictEqual(yield* host.openThreads, [
            { threadId: "thread/1", cwd: state.dir },
          ]);

          const rejected = yield* host
            .sendCommand("thread/1", { type: "set_auto_compaction", params: { enabled: false } })
            .pipe(Effect.flip);
          assert.strictEqual(rejected.reason, "rejected");
          assert.include(state.events(), "command:set_auto_compaction");

          assert.deepStrictEqual(yield* transition(), { type: "apply_on_next_turn" });
          yield* host.markRestartRequired("thread/1", ["memory.backend"]);
          yield* host.markRestartRequired("thread/1", ["memory.backend"]);
          assert.deepStrictEqual(session.providerSession.restartRequired, ["memory.backend"]);
          assert.deepStrictEqual(yield* transition(), { type: "restart_session" });
          assert.deepStrictEqual(yield* transition(ProviderSessionId.make("session-other")), {
            type: "apply_on_next_turn",
          });
          return session.events;
        }).pipe(Effect.scoped);

        const updates = yield* events.pipe(
          Stream.filter((event) => event.type === "provider_session.updated"),
          Stream.runCollect,
        );
        // One update for the marker (the repeat adds nothing), then the stop.
        assert.deepStrictEqual(
          updates.map((event) =>
            event.type === "provider_session.updated"
              ? event.providerSession.restartRequired
              : undefined,
          ),
          [["memory.backend"], ["memory.backend"]],
        );
        assert.deepStrictEqual(yield* host.openThreads, []);
        assert.deepStrictEqual(yield* transition(), { type: "apply_on_next_turn" });
        const closed = yield* host
          .sendCommand("thread/1", { type: "set_auto_retry", params: { enabled: true } })
          .pipe(Effect.flip);
        assert.strictEqual(closed.reason, "not_open");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses to open a session on a sidecar with another contract", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter } = yield* makeAdapter(state, "", { FAKE_OMP_CONTRACT: "1.3.0" });
      const error = yield* adapter
        .openSession(openInput(state.dir, "full-access"))
        .pipe(Effect.scoped, Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterOpenSessionError");
      if (error._tag === "ProviderAdapterOpenSessionError") {
        assert.propertyVal(error.cause, "_tag", "OmpContractMismatchError");
      }
      assert.include(state.argv().argv, "yolo");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
