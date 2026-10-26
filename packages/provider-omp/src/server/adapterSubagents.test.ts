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
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { makeOmpAdapter } from "./adapter.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import { ompStateDirs } from "./session.ts";
import { OmpSubagentTracker } from "./subagents.ts";
import { makeOmpThreadSessions } from "./threadSessions.ts";
import {
  type FakeOmpScript,
  type FakeOmpState,
  fakeOmpFrames,
  makeFakeOmpState,
} from "./testing/fakeOmp.ts";

const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const INSTANCE_ID = ProviderInstanceId.make("omp-work");
const THREAD_ID = ThreadId.make("thread/subagents");
const ROOT_NODE = NodeId.make("node:subagents:root");
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const TRANSCRIPT_PAGE = {
  sessionFile: "/fake/sessions/fake-session/Reader.jsonl",
  fromByte: 0,
  nextByte: 120,
  reset: false,
  entries: [],
  messages: [{ role: "user", content: "Read src/auth.ts", timestamp: 0 }],
};

/** A prompt whose turn spawns Planner, which spawns Reader, before answering. */
const promptSpawningSubagents = () => {
  const [ack, agentStart, ...rest] = fakeOmpFrames.promptTurn({ text: ["Done"] });
  return [
    ack!,
    agentStart!,
    {
      emit: fakeOmpFrames.subagentLifecycle({
        id: "Planner",
        status: "started",
        description: "Plan the change",
        parentId: null,
        depth: 0,
      } as never),
    },
    {
      emit: fakeOmpFrames.subagentLifecycle({
        id: "Reader",
        status: "started",
        parentId: "Planner",
        depth: 1,
      } as never),
    },
    {
      emit: {
        type: "subagent_progress",
        payload: {
          index: 0,
          agent: "explore",
          agentSource: "bundled",
          task: "Read src/auth.ts",
          parentId: "Planner",
          depth: 1,
          progress: {
            id: "Reader",
            status: "running",
            stage: "Reading src/auth.ts",
            resolvedModel: "fake/fake-model",
            cost: 0.02,
            tokens: 900,
            toolCount: 2,
            durationMs: 3_000,
          },
        },
      },
    },
    ...rest,
  ];
};

const baseScript = (): FakeOmpScript => ({
  commands: {
    set_subagent_subscription: [{ respond: { level: "progress" } }],
    set_session_name: [{ respond: null }],
    get_session_stats: [{ fail: "not needed" }],
    prompt: promptSpawningSubagents(),
    cancel_subagent: [{ respond: { cancelled: true } }],
    steer_subagent: [{ respond: null }],
    get_subagent_messages: [{ respond: TRANSCRIPT_PAGE }],
    revive_subagent: [{ respond: { revived: true } }],
  },
});

const openAdapter = Effect.fnUntraced(function* (state: FakeOmpState, contract: string) {
  const path = yield* Path.Path;
  const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
  const adapter = yield* makeOmpAdapter({
    instanceId: INSTANCE_ID,
    profile: "",
    environment: state.env({ ...state.script(baseScript()), FAKE_OMP_CONTRACT: contract }),
    platform,
    defaultCwd: state.dir,
    resolveBinary: Effect.succeed(state.executable()),
    dirs,
    pidfiles: yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform }),
    expectedContractVersion: contract,
    threadSessions: makeOmpThreadSessions(),
  });
  const session = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: ProviderSessionId.make("session-subagents"),
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimePolicy,
  });
  const providerThread = yield* session.ensureThread({
    threadId: THREAD_ID,
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimePolicy,
  });
  return { session, providerThread };
});

const appThread = (
  now: DateTime.Utc,
  activeProviderThreadId: OrchestrationV2AppThread["activeProviderThreadId"],
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: THREAD_ID,
  projectId: "project:omp" as OrchestrationV2AppThread["projectId"],
  title: "Subagent thread",
  providerInstanceId: INSTANCE_ID,
  modelSelection: { instanceId: INSTANCE_ID, model: "default" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

posixOnly("OmpAdapter subagents", () => {
  it.live("subscribes, maps the spawn tree, and sends kill, steer and transcript reads", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const result = yield* Effect.gen(function* () {
        const { session, providerThread } = yield* openAdapter(state, "1.0.0");
        const now = yield* DateTime.now;
        yield* session.startTurn({
          appThread: appThread(now, providerThread.id),
          threadId: THREAD_ID,
          runId: RunId.make("run:subagents:1"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("run-attempt:subagents:1"),
          rootNodeId: ROOT_NODE,
          providerThread,
          message: {
            messageId: "message:subagents:1" as never,
            text: "Plan it",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: INSTANCE_ID, model: "default" },
          runtimePolicy,
        });
        const events = yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const control = session.controlSubagent!;
        const read = session.readSubagentTranscript!;
        yield* control({ providerThread, nativeTaskId: "Reader", action: { type: "kill" } });
        yield* control({
          providerThread,
          nativeTaskId: "Reader",
          action: { type: "steer", message: "Only the login path" },
        });
        const first = yield* read({ providerThread, nativeTaskId: "Reader", fromByte: 0 });
        yield* read({ providerThread, nativeTaskId: "Reader", fromByte: first.nextByte });
        const refused = yield* control({
          providerThread,
          nativeTaskId: "Reader",
          action: { type: "revive" },
        }).pipe(Effect.flip);
        return { events, first, refused };
      }).pipe(Effect.scoped);

      const commands = state.commands();
      assert.deepInclude(commands, {
        type: "set_subagent_subscription",
        id: commands.find((command) => command["type"] === "set_subagent_subscription")?.["id"],
        level: "progress",
      });

      const subagents = result.events.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent] : [],
      );
      const planner = subagents.findLast((record) => record.nativeTaskRef?.nativeId === "Planner");
      const reader = subagents.findLast((record) => record.nativeTaskRef?.nativeId === "Reader");
      assert.strictEqual(planner?.parentNodeId, ROOT_NODE);
      assert.strictEqual(planner?.title, "Planner: Plan the change");
      assert.strictEqual(reader?.parentNodeId, planner?.id);
      assert.strictEqual(reader?.depth, 1);
      assert.strictEqual(
        reader?.id,
        OmpSubagentTracker.nodeId(reader!.providerThreadId!, "Reader"),
      );
      assert.strictEqual(reader?.model, "fake/fake-model");
      assert.strictEqual(reader?.usage?.costUsd, 0.02);
      assert.deepStrictEqual(reader?.controls, {
        transcript: true,
        steer: true,
        kill: true,
        revive: false,
      });

      const sent = (type: string) =>
        commands
          .filter((command) => command["type"] === type)
          .map(({ id: _id, type: _type, ...params }) => params);
      assert.deepStrictEqual(sent("cancel_subagent"), [{ subagentId: "Reader" }]);
      assert.deepStrictEqual(sent("steer_subagent"), [
        { subagentId: "Reader", message: "Only the login path" },
      ]);
      assert.deepStrictEqual(sent("get_subagent_messages"), [
        { subagentId: "Reader", fromByte: 0 },
        { subagentId: "Reader", fromByte: 120 },
      ]);
      assert.deepStrictEqual(result.first.entries, [{ role: "user", text: "Read src/auth.ts" }]);

      // Contract 1.0.0 has no revive_subagent: refused here, never sent.
      assert.deepStrictEqual(sent("revive_subagent"), []);
      assert.include(
        result.refused._tag === "ProviderAdapterProtocolError" ? result.refused.detail : "",
        "contract 1.4.0",
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("revives a subagent when the pinned contract has revive_subagent", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      yield* Effect.gen(function* () {
        const { session, providerThread } = yield* openAdapter(state, "1.4.0");
        yield* session.controlSubagent!({
          providerThread,
          nativeTaskId: "Reader",
          action: { type: "revive", message: "Now the logout path" },
        });
        yield* session.controlSubagent!({
          providerThread,
          nativeTaskId: "Planner",
          action: { type: "revive" },
        });
      }).pipe(Effect.scoped);

      const revives = state
        .commands()
        .filter((command) => command["type"] === "revive_subagent")
        .map(({ id: _id, type: _type, ...params }) => params);
      assert.deepStrictEqual(revives, [
        { subagentId: "Reader", message: "Now the logout path" },
        { subagentId: "Planner" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
