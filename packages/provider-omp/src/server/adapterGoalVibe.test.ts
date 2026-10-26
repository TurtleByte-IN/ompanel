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
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderGoal,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import type { Goal } from "../../contract/src/wire.generated.ts";
import { makeOmpAdapter } from "./adapter.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import { ompStateDirs } from "./session.ts";
import { makeFakeOmpState, waitUntil, type FakeOmpStep } from "./testing/fakeOmp.ts";
import { makeOmpThreadSessions } from "./threadSessions.ts";
import { OMP_VIBE_CONTRACT } from "./vibe.ts";

const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const INSTANCE_ID = ProviderInstanceId.make("omp-work");
const THREAD_ID = ThreadId.make("thread/goal");
const SESSION_ID = ProviderSessionId.make("session-goal");

const PROMPT_TURN: ReadonlyArray<FakeOmpStep> = [
  { respond: { agentInvoked: true } },
  {
    emit: { type: "prompt_result", status: "completed", agentInvoked: true, sessionSettled: true },
  },
];

const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const selection = (options: ModelSelection["options"] = []): ModelSelection => ({
  instanceId: INSTANCE_ID,
  model: "default",
  options,
});

const goal = (status: Goal["status"], extra: Partial<Goal> = {}): Goal => ({
  id: "goal-1",
  objective: "Ship the release notes",
  status,
  tokensUsed: 1_200,
  timeUsedSeconds: 90,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

const goalResult = (value: Goal | null) => ({
  goal: value,
  state:
    value === null ? null : { enabled: value.status === "active", mode: "active", goal: value },
});

const openThread = Effect.fnUntraced(function* (options: {
  readonly commands?: Readonly<Record<string, ReadonlyArray<FakeOmpStep>>>;
  readonly contract?: string;
}) {
  const contract = options.contract ?? "1.0.0";
  const state = yield* makeFakeOmpState;
  const env = state.script({
    commands: {
      set_session_name: [{ respond: null }],
      set_ask_dialog: [{ respond: { enabled: true } }],
      prompt: PROMPT_TURN,
      ...options.commands,
    },
  });
  const path = yield* Path.Path;
  const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
  const adapter = yield* makeOmpAdapter({
    instanceId: INSTANCE_ID,
    profile: "",
    environment: state.env({ ...env, FAKE_OMP_CONTRACT: contract }),
    platform,
    defaultCwd: state.dir,
    resolveBinary: Effect.succeed(state.executable()),
    dirs,
    pidfiles: yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform }),
    expectedContractVersion: contract,
    threadSessions: makeOmpThreadSessions(),
    sessions: state.sessions,
  });
  const session = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: selection(),
    runtimePolicy: policy,
  });
  const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  yield* session.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.forkScoped,
  );
  const providerThread = yield* session.ensureThread({
    threadId: THREAD_ID,
    modelSelection: selection(),
    runtimePolicy: policy,
  });
  const now = yield* DateTime.now;
  let ordinal = 0;
  const terminals = () => events.filter((event) => event.type === "turn.terminal");

  const turn = (text: string, modelSelection: ModelSelection = selection()) =>
    Effect.gen(function* () {
      ordinal += 1;
      const appThread = {
        createdBy: "user",
        creationSource: "web",
        id: THREAD_ID,
        projectId: "project:omp",
        title: "Goal thread",
        providerInstanceId: INSTANCE_ID,
        modelSelection,
        runtimeMode: "full-access",
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
      } as unknown as OrchestrationV2AppThread;
      const settledBefore = terminals().length;
      yield* session.startTurn({
        appThread,
        threadId: THREAD_ID,
        runId: RunId.make(`run:goal:${ordinal}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`run-attempt:goal:${ordinal}`),
        rootNodeId: NodeId.make(`node:goal:${ordinal}`),
        providerThread,
        message: {
          messageId: `message:goal:${ordinal}` as never,
          text,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection,
        runtimePolicy: policy,
      });
      assert.isTrue(yield* waitUntil(() => terminals().length > settledBefore));
      return terminals().at(-1)!;
    });

  const sent = (type: string) => state.commands().filter((command) => command["type"] === type);
  /** The goal the last `provider_thread.updated` carried. */
  const lastGoal = (): OrchestrationV2ProviderGoal | null | undefined =>
    events.findLast((event) => event.type === "provider_thread.updated")?.providerThread.goal;
  /** Texts of the command-output notifications the turns showed. */
  const outputs = () =>
    events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "notification"
        ? [event.turnItem.detail ?? event.turnItem.summary]
        : [],
    );
  const steer = (text: string) =>
    session.steerTurn({
      threadId: THREAD_ID,
      runId: RunId.make(`run:goal:${ordinal}`),
      providerThread,
      providerTurnId: "provider-turn:goal" as never,
      message: {
        messageId: `message:goal:steer` as never,
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    });
  const types = () => state.commands().map((command) => String(command["type"]));
  const notices = () =>
    events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "system_notice"
        ? [event.turnItem.message]
        : [],
    );
  /** Every status the subagent's rows had, oldest first. */
  const subagentStatuses = (nativeId: string) =>
    events.flatMap((event) =>
      event.type === "subagent.updated" && event.subagent.nativeTaskRef?.nativeId === nativeId
        ? [event.subagent.status]
        : [],
    );
  return { turn, sent, lastGoal, outputs, steer, types, notices, subagentStatuses };
});

posixOnly("OmpAdapter goal mode", () => {
  it.live("/goal set prompts its objective, then creates the goal over RPC", () =>
    Effect.gen(function* () {
      const active = goal("active", { tokensUsed: 0, timeUsedSeconds: 0, tokenBudget: 50_000 });
      const { turn, sent, lastGoal, types } = yield* openThread({
        commands: {
          goal: [
            { emit: { type: "goal_updated", goal: active, state: goalResult(active).state } },
            { respond: goalResult(active) },
          ],
        },
      });
      const terminal = yield* turn("/goal set --budget 50000 Ship the release notes");
      assert.strictEqual(terminal.type === "turn.terminal" && terminal.status, "completed");
      assert.deepStrictEqual(
        sent("goal").map(({ op, objective, token_budget }) => ({ op, objective, token_budget })),
        [{ op: "create", objective: "Ship the release notes", token_budget: 50_000 }],
      );
      assert.deepStrictEqual(
        sent("prompt").map((command) => command["message"]),
        ["Ship the release notes"],
      );
      // The objective reaches OMP before the goal exists, so no goal continuation can take it.
      assert.isBelow(types().indexOf("prompt"), types().indexOf("goal"));
      assert.deepStrictEqual(lastGoal(), {
        objective: "Ship the release notes",
        status: "active",
        tokenBudget: 50_000,
        tokensUsed: 0,
        timeUsedSeconds: 0,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a refused goal still runs the objective and says the goal was not set", () =>
    Effect.gen(function* () {
      const { turn, sent, notices } = yield* openThread({
        commands: {
          // OMP answers the goal while the objective's run goes on; the run ends afterwards.
          goal: [{ fail: "Goal mode is disabled (goal.enabled)." }, ...PROMPT_TURN.slice(1)],
          prompt: [PROMPT_TURN[0]!],
        },
      });
      const terminal = yield* turn("/goal Ship the release notes");
      assert.strictEqual(terminal.type === "turn.terminal" && terminal.status, "completed");
      assert.lengthOf(sent("prompt"), 1);
      assert.deepStrictEqual(notices(), [
        "OMP did not set the goal: Goal mode is disabled (goal.enabled).",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a /goal sent while a turn runs is refused, never steered as text", () =>
    Effect.gen(function* () {
      const { steer, sent } = yield* openThread({});
      const error = yield* steer("/goal pause").pipe(Effect.flip);
      assert.isDefined(error);
      assert.lengthOf(sent("steer"), 0);
      assert.lengthOf(sent("follow_up"), 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("/goal pause runs the goal op, shows OMP's answer and sends no prompt", () =>
    Effect.gen(function* () {
      const paused = goal("paused");
      const { turn, sent, lastGoal, outputs } = yield* openThread({
        commands: {
          goal: [
            { emit: { type: "goal_updated", goal: paused, state: goalResult(paused).state } },
            { respond: goalResult(paused) },
          ],
        },
      });
      const terminal = yield* turn("/goal pause");
      assert.strictEqual(terminal.type === "turn.terminal" && terminal.status, "completed");
      assert.deepStrictEqual(
        sent("goal").map((command) => command["op"]),
        ["pause"],
      );
      assert.lengthOf(sent("prompt"), 0);
      assert.strictEqual(lastGoal()?.status, "paused");
      assert.include(outputs().join("\n"), "Goal paused: Ship the release notes");
      assert.include(outputs().join("\n"), "1,200 tokens used");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("/goal clear drops the goal and the thread's goal goes away", () =>
    Effect.gen(function* () {
      const dropped = goal("dropped");
      const { turn, sent, lastGoal } = yield* openThread({
        commands: {
          goal: [{ emit: { type: "goal_updated", goal: dropped } }, { respond: goalResult(null) }],
        },
      });
      yield* turn("/goal clear");
      assert.deepStrictEqual(
        sent("goal").map((command) => command["op"]),
        ["drop"],
      );
      assert.isNull(lastGoal());
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a refused goal op fails the turn with OMP's reason", () =>
    Effect.gen(function* () {
      const { turn } = yield* openThread({
        commands: { goal: [{ fail: "No paused goal to resume." }] },
      });
      const terminal = yield* turn("/goal resume");
      assert.strictEqual(terminal.type === "turn.terminal" && terminal.status, "failed");
      assert.strictEqual(
        terminal.type === "turn.terminal" ? terminal.failure?.message : undefined,
        "No paused goal to resume.",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("/goal budget answers without an RPC call: OMP has no RPC form for it", () =>
    Effect.gen(function* () {
      const { turn, sent, outputs } = yield* openThread({});
      yield* turn("/goal budget 9000");
      assert.lengthOf(sent("goal"), 0);
      assert.include(outputs().join("\n"), "only in its terminal UI");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "a goal_updated frame updates the thread's goal; a completed one stays until dropped",
    () =>
      Effect.gen(function* () {
        const complete = goal("complete");
        const { turn, sent, lastGoal, outputs } = yield* openThread({
          commands: {
            prompt: [
              { respond: { agentInvoked: true } },
              { emit: { type: "goal_updated", goal: complete } },
              ...PROMPT_TURN.slice(1),
            ],
          },
        });
        yield* turn("Keep going");
        assert.strictEqual(lastGoal()?.status, "complete");
        // OMP has already forgotten a completed goal: the adapter shows and drops it itself.
        yield* turn("/goal");
        yield* turn("/goal drop");
        assert.lengthOf(sent("goal"), 0);
        assert.include(outputs().join("\n"), "Goal complete: Ship the release notes");
        assert.isNull(lastGoal());
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

posixOnly("OmpAdapter vibe mode", () => {
  const vibe = (value: boolean) => selection([{ id: "vibe", value }]);

  it.live("sends set_vibe_mode when the trait changes, on a sidecar that has it", () =>
    Effect.gen(function* () {
      const { turn, sent } = yield* openThread({
        contract: OMP_VIBE_CONTRACT,
        commands: {
          set_vibe_mode: [{ respond: { enabled: true, killed: 0 } }],
        },
      });
      yield* turn("Direct the workers", vibe(true));
      yield* turn("Again", vibe(true));
      assert.deepStrictEqual(
        sent("set_vibe_mode").map((command) => command["enabled"]),
        [true],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a refused set_vibe_mode leaves the turn running and is asked again", () =>
    Effect.gen(function* () {
      const { turn, sent } = yield* openThread({
        contract: OMP_VIBE_CONTRACT,
        commands: { set_vibe_mode: [{ fail: "Exit goal mode first." }] },
      });
      const terminal = yield* turn("Direct the workers", vibe(true));
      assert.strictEqual(terminal.type === "turn.terminal" && terminal.status, "completed");
      yield* turn("Again", vibe(true));
      assert.lengthOf(sent("set_vibe_mode"), 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("leaving vibe mode ends the workers' rows, even without a final frame", () =>
    Effect.gen(function* () {
      const { turn, subagentStatuses } = yield* openThread({
        contract: OMP_VIBE_CONTRACT,
        commands: {
          // Every call answers "off", so each vibe-on turn asks again and sees vibe end.
          set_vibe_mode: [{ respond: { enabled: false, killed: 1 } }],
          prompt: [
            PROMPT_TURN[0]!,
            {
              emit: {
                type: "subagent_lifecycle",
                payload: {
                  id: "QuickFox",
                  agent: "sonic",
                  description: "vibe fast session",
                  status: "started",
                  parentId: null,
                  depth: 0,
                  parentToolCallId: "call-vibe-spawn",
                },
              },
            },
            ...PROMPT_TURN.slice(1),
          ],
        },
      });
      yield* turn("Direct the workers", vibe(true));
      assert.deepStrictEqual(subagentStatuses("QuickFox"), ["running"]);
      // The second turn's set_vibe_mode reports vibe off: the running worker's row ends first.
      yield* turn("Again", vibe(true));
      assert.deepStrictEqual(subagentStatuses("QuickFox").slice(0, 2), ["running", "cancelled"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("never sends set_vibe_mode to a sidecar older than the vibe contract", () =>
    Effect.gen(function* () {
      const { turn, sent } = yield* openThread({ contract: "1.6.0" });
      yield* turn("Direct the workers", vibe(true));
      assert.lengthOf(sent("set_vibe_mode"), 0);
      assert.lengthOf(sent("prompt"), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
