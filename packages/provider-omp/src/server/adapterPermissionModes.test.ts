// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type RuntimeMode,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeOmpAdapter } from "./adapter.ts";
import { ompApprovalModeFor } from "./launch.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import { ompStateDirs } from "./session.ts";
import {
  makeFakeOmpState,
  waitUntil,
  type FakeOmpState,
  type FakeOmpStep,
} from "./testing/fakeOmp.ts";
import { makeOmpThreadSessions } from "./threadSessions.ts";

const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const INSTANCE_ID = ProviderInstanceId.make("omp-work");
const THREAD_ID = ThreadId.make("thread/modes");
/** What OMP answers when the session was started with `--auto-approve` (`rpc-mode.ts`). */
const AUTO_APPROVE_LOCK =
  "Approval mode is locked to yolo: the session was started with --auto-approve/--yolo.";

const PROMPT_TURN: ReadonlyArray<FakeOmpStep> = [
  { respond: { agentInvoked: true } },
  {
    emit: { type: "prompt_result", status: "completed", agentInvoked: true, sessionSettled: true },
  },
];

const policy = (runtimeMode: RuntimeMode) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd: null,
  });

/**
 * Opens a thread on the fake in `launchMode`; `turn` runs one prompt turn in a given mode.
 * `options.state` outlives the thread's scope, for checking what happened after it closed.
 */
const openThread = Effect.fnUntraced(function* (
  launchMode: RuntimeMode,
  setApprovalMode: ReadonlyArray<FakeOmpStep>,
  options: {
    readonly state?: FakeOmpState;
    readonly prompt?: ReadonlyArray<FakeOmpStep>;
  } = {},
) {
  const state = options.state ?? (yield* makeFakeOmpState);
  const env = state.script({
    commands: {
      set_session_name: [{ respond: null }],
      set_ask_dialog: [{ respond: { enabled: true } }],
      set_approval_mode: setApprovalMode,
      prompt: options.prompt ?? PROMPT_TURN,
    },
  });
  const path = yield* Path.Path;
  const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
  const adapter = yield* makeOmpAdapter({
    instanceId: INSTANCE_ID,
    profile: "",
    environment: state.env(env),
    platform,
    defaultCwd: state.dir,
    resolveBinary: Effect.succeed(state.executable()),
    dirs,
    pidfiles: yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform }),
    expectedContractVersion: "1.0.0",
    threadSessions: makeOmpThreadSessions(),
    sessions: state.sessions,
  });
  const session = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: ProviderSessionId.make("session-modes"),
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimePolicy: policy(launchMode),
  });
  let terminals = 0;
  yield* session.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => {
        if (event.type === "turn.terminal") terminals += 1;
      }),
    ),
    Effect.forkScoped,
  );
  const providerThread = yield* session.ensureThread({
    threadId: THREAD_ID,
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimePolicy: policy(launchMode),
  });
  const now = yield* DateTime.now;
  let ordinal = 0;

  /** Starts a turn in `runtimeMode` and, once OMP accepted it, waits for its terminal unless told not to. */
  const turn = (runtimeMode: RuntimeMode, awaitTerminal = true) =>
    Effect.gen(function* () {
      ordinal += 1;
      const appThread: OrchestrationV2AppThread = {
        createdBy: "user",
        creationSource: "web",
        id: THREAD_ID,
        projectId: "project:omp" as OrchestrationV2AppThread["projectId"],
        title: "Modes thread",
        providerInstanceId: INSTANCE_ID,
        modelSelection: { instanceId: INSTANCE_ID, model: "default" },
        runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: providerThread.id,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const settledBefore = terminals;
      yield* session.startTurn({
        appThread,
        threadId: THREAD_ID,
        runId: RunId.make(`run:modes:${ordinal}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`run-attempt:modes:${ordinal}`),
        rootNodeId: NodeId.make(`node:modes:${ordinal}`),
        providerThread,
        message: {
          messageId: `message:modes:${ordinal}` as never,
          text: `Turn ${ordinal}`,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: INSTANCE_ID, model: "default" },
        runtimePolicy: policy(runtimeMode),
      });
      if (awaitTerminal) assert.isTrue(yield* waitUntil(() => terminals > settledBefore));
    });

  const sent = (type: string) => state.commands().filter((command) => command["type"] === type);
  return { state, session, turn, sent };
});

describe("OMP permission mapping", () => {
  it("maps T3 runtime modes to OMP approval modes, Auto to always-ask", () => {
    assert.strictEqual(ompApprovalModeFor("approval-required"), "always-ask");
    assert.strictEqual(ompApprovalModeFor("auto-accept-edits"), "write");
    assert.strictEqual(ompApprovalModeFor("full-access"), "yolo");
    assert.strictEqual(ompApprovalModeFor("auto"), "always-ask");
  });
});

posixOnly("OmpAdapter permission modes", () => {
  it.live("declares in-session mode switches, so T3 keeps the process on a mode change", () =>
    Effect.gen(function* () {
      const { session } = yield* openThread("full-access", []);
      assert.isTrue(
        session.providerSession.capabilities.sessions.supportsRuntimeModeSwitchInSession,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("launches a thread stored as Auto with always-ask", () =>
    Effect.gen(function* () {
      const { state, turn, sent } = yield* openThread("auto", []);
      const argv = state.argv().argv;
      assert.strictEqual(argv[argv.indexOf("--approval-mode") + 1], "always-ask");
      // Supervised is what the process already enforces: nothing to change.
      yield* turn("approval-required");
      assert.lengthOf(sent("set_approval_mode"), 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("sends a live thread's new mode as set_approval_mode before the prompt, no respawn", () =>
    Effect.gen(function* () {
      const { state, turn, sent } = yield* openThread("approval-required", [
        { respond: { mode: "yolo" } },
      ]);
      yield* turn("full-access");
      const commands = state.commands().map((command) => command["type"]);
      assert.deepStrictEqual(
        sent("set_approval_mode").map((command) => command["mode"]),
        ["yolo"],
      );
      assert.isBelow(commands.indexOf("set_approval_mode"), commands.indexOf("prompt"));
      // The same process: one spawn, one handshake, launched in the old mode.
      assert.lengthOf(
        state.events().filter((event) => event === "command:negotiate_protocol"),
        1,
      );
      const argv = state.argv().argv;
      assert.strictEqual(argv[argv.indexOf("--approval-mode") + 1], "always-ask");

      // An unchanged mode is not sent again.
      yield* turn("full-access");
      assert.lengthOf(sent("set_approval_mode"), 1);
      assert.lengthOf(sent("prompt"), 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails the turn when OMP refuses the mode and keeps the mode it had", () =>
    Effect.gen(function* () {
      const { turn, sent } = yield* openThread("full-access", [{ fail: AUTO_APPROVE_LOCK }]);
      const error = yield* turn("approval-required").pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterTurnStartError");
      const cause = error._tag === "ProviderAdapterTurnStartError" ? error.cause : undefined;
      assert.isTrue(Schema.is(ProviderAdapter.ProviderAdapterProtocolError)(cause));
      if (Schema.is(ProviderAdapter.ProviderAdapterProtocolError)(cause)) {
        assert.strictEqual(cause.reason, "permission_mode_refused");
        assert.include(cause.detail, "locked to yolo");
      }
      assert.include(
        makeProviderFailure({ cause: error }).message,
        "the provider refused the thread's permission mode",
      );
      // The prompt never reached OMP.
      assert.deepStrictEqual(
        sent("set_approval_mode").map((command) => command["mode"]),
        ["always-ask"],
      );
      assert.lengthOf(sent("prompt"), 0);

      // OMP still runs yolo, so Full access needs no change; Supervised is asked for again.
      yield* turn("full-access");
      assert.lengthOf(sent("set_approval_mode"), 1);
      assert.lengthOf(sent("prompt"), 1);
      yield* turn("approval-required").pipe(Effect.flip);
      assert.lengthOf(sent("set_approval_mode"), 2);
      assert.lengthOf(sent("prompt"), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("aborts a running turn before closing, so a detached turn does not drain on", () =>
    Effect.gen(function* () {
      // T3 detaches a session mid-turn when its mode tightens; OMP would otherwise finish the
      // turn under the looser mode while it drains on stdin end.
      const state = yield* makeFakeOmpState;
      yield* Effect.gen(function* () {
        const { turn, sent } = yield* openThread("full-access", [], {
          state,
          prompt: [{ respond: { agentInvoked: true } }],
        });
        yield* turn("full-access", false);
        assert.isTrue(yield* waitUntil(() => sent("prompt").length === 1));
      }).pipe(Effect.scoped);
      const events = state.events();
      assert.include(events, "command:abort");
      assert.isBelow(events.indexOf("command:abort"), events.indexOf("stdin-end"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("closes an idle session without an abort", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      yield* Effect.gen(function* () {
        const { turn } = yield* openThread("full-access", [], { state });
        yield* turn("full-access");
      }).pipe(Effect.scoped);
      assert.notInclude(state.events(), "command:abort");
      assert.include(state.events(), "stdin-end");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
