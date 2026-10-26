// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
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
import { makeFakeOmpState, waitUntil, type FakeOmpStep } from "./testing/fakeOmp.ts";
import { makeOmpThreadSessions } from "./threadSessions.ts";

const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const INSTANCE_ID = ProviderInstanceId.make("omp-work");
const THREAD_ID = ThreadId.make("thread/traits");
const SESSION_ID = ProviderSessionId.make("session-traits");

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

const selection = (model: string, options: ModelSelection["options"] = []): ModelSelection => ({
  instanceId: INSTANCE_ID,
  model,
  options,
});

const MODEL = {
  id: "claude-sonnet-4-5",
  name: "Claude Sonnet 4.5",
  provider: "anthropic",
  reasoning: true,
};

const openThread = Effect.fnUntraced(function* (
  opened: ModelSelection,
  commands: Readonly<Record<string, ReadonlyArray<FakeOmpStep>>> = {},
) {
  const state = yield* makeFakeOmpState;
  const env = state.script({
    commands: {
      set_session_name: [{ respond: null }],
      set_ask_dialog: [{ respond: { enabled: true } }],
      set_model: [{ respond: MODEL }],
      set_thinking_level: [{ respond: null }],
      set_fast_mode: [{ respond: { enabled: true, active: true } }],
      set_advisor: [{ respond: { enabled: true, active: true } }],
      set_prewalk: [{ respond: { armed: true } }],
      prompt: PROMPT_TURN,
      ...commands,
    },
  });
  const path = yield* Path.Path;
  const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
  const threadSessions = makeOmpThreadSessions();
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
    threadSessions,
    sessions: state.sessions,
  });
  const session = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: SESSION_ID,
    modelSelection: opened,
    runtimePolicy: policy,
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
    modelSelection: opened,
    runtimePolicy: policy,
  });
  const now = yield* DateTime.now;
  let ordinal = 0;

  const turn = (modelSelection: ModelSelection) =>
    Effect.gen(function* () {
      ordinal += 1;
      const appThread = {
        createdBy: "user",
        creationSource: "web",
        id: THREAD_ID,
        projectId: "project:omp",
        title: "Traits thread",
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
      const settledBefore = terminals;
      yield* session.startTurn({
        appThread,
        threadId: THREAD_ID,
        runId: RunId.make(`run:traits:${ordinal}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`run-attempt:traits:${ordinal}`),
        rootNodeId: NodeId.make(`node:traits:${ordinal}`),
        providerThread,
        message: {
          messageId: `message:traits:${ordinal}` as never,
          text: `Turn ${ordinal}`,
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection,
        runtimePolicy: policy,
      });
      assert.isTrue(yield* waitUntil(() => terminals > settledBefore));
    });

  const sent = (type: string) => state.commands().filter((command) => command["type"] === type);
  const argv = state.argv().argv;
  const overlayPath = argv[argv.indexOf("--config") + 1]!;
  const overlay = () =>
    JSON.parse(
      NodeFS.readFileSync(overlayPath, "utf8")
        .split("\n")
        .filter((line) => !line.startsWith("#"))
        .join("\n") || "{}",
    ) as Record<string, unknown>;
  return { adapter, state, turn, sent, overlay };
});

posixOnly("OmpAdapter model and traits", () => {
  it.live("sends set_model for a picked model before the prompt, once", () =>
    Effect.gen(function* () {
      const { state, turn, sent } = yield* openThread(selection("default"));
      yield* turn(selection("default"));
      assert.lengthOf(sent("set_model"), 0);
      yield* turn(selection("openrouter/anthropic/claude-sonnet-4-5"));
      assert.deepStrictEqual(
        sent("set_model").map((command) => [command["provider"], command["modelId"]]),
        [["openrouter", "anthropic/claude-sonnet-4-5"]],
      );
      const types = state.commands().map((command) => command["type"]);
      assert.isBelow(types.indexOf("set_model"), types.lastIndexOf("prompt"));
      yield* turn(selection("openrouter/anthropic/claude-sonnet-4-5"));
      assert.lengthOf(sent("set_model"), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("sends each thinking level, inherit included, and again after a model change", () =>
    Effect.gen(function* () {
      const { turn, sent } = yield* openThread(selection("default"));
      yield* turn(selection("default", [{ id: "thinking", value: "high" }]));
      yield* turn(selection("default", [{ id: "thinking", value: "inherit" }]));
      yield* turn(selection("default", [{ id: "thinking", value: "inherit" }]));
      yield* turn(selection("anthropic/x", [{ id: "thinking", value: "inherit" }]));
      assert.deepStrictEqual(
        sent("set_thinking_level").map((command) => command["level"]),
        ["high", "inherit", "inherit"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("sends each boolean trait as its own command; computer goes to the overlay", () =>
    Effect.gen(function* () {
      const { turn, sent, overlay } = yield* openThread(selection("default"));
      const traits = (value: boolean) => [
        { id: "fastMode", value },
        { id: "advisor", value },
        { id: "prewalk", value },
        { id: "computer", value },
      ];
      yield* turn(selection("default", traits(true)));
      assert.deepStrictEqual(
        sent("set_fast_mode").map((command) => command["enabled"]),
        [true],
      );
      assert.deepStrictEqual(
        sent("set_advisor").map((command) => command["enabled"]),
        [true],
      );
      assert.deepStrictEqual(
        sent("set_prewalk").map((command) => command["armed"]),
        [true],
      );
      assert.deepStrictEqual(overlay()["computer"], { enabled: true });
      assert.lengthOf(sent("set_tool_enabled"), 0);

      // Prewalk is re-armed each turn; the others are sent only on change.
      yield* turn(selection("default", traits(true)));
      assert.lengthOf(sent("set_fast_mode"), 1);
      assert.lengthOf(sent("set_prewalk"), 2);

      yield* turn(selection("default", traits(false)));
      assert.deepStrictEqual(
        sent("set_fast_mode").map((command) => command["enabled"]),
        [true, false],
      );
      assert.deepStrictEqual(
        sent("set_advisor").map((command) => command["enabled"]),
        [true, false],
      );
      assert.deepStrictEqual(
        sent("set_prewalk").map((command) => command["armed"]),
        [true, true, false],
      );
      assert.deepStrictEqual(overlay()["computer"], { enabled: false });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps the turn when OMP refuses a trait", () =>
    Effect.gen(function* () {
      const { turn, sent } = yield* openThread(selection("default"), {
        set_fast_mode: [{ fail: "Fast mode is unavailable for the current model." }],
      });
      yield* turn(selection("default", [{ id: "fastMode", value: true }]));
      assert.lengthOf(sent("prompt"), 1);
      // Not recorded as applied, so the next turn asks again.
      yield* turn(selection("default", [{ id: "fastMode", value: true }]));
      assert.lengthOf(sent("set_fast_mode"), 2);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("writes the role chip to the overlay before launch and restarts on a role change", () =>
    Effect.gen(function* () {
      const role = (value: string) => selection("default", [{ id: "role", value }]);
      const { adapter, overlay } = yield* openThread(role("smol"));
      assert.deepStrictEqual(overlay()["modelRoles"], { default: "@smol" });

      const plan = (current: ModelSelection, target: ModelSelection) =>
        adapter.planSelectionTransition({
          current,
          target,
          providerSessionId: SESSION_ID,
          sessionCapabilities: undefined as never,
        });
      assert.deepStrictEqual(yield* plan(role("smol"), role("slow")), {
        type: "restart_session",
      });
      assert.deepStrictEqual(
        yield* plan(
          role("smol"),
          selection("default", [
            { id: "role", value: "smol" },
            { id: "thinking", value: "low" },
          ]),
        ),
        { type: "apply_on_next_turn" },
      );
      // A picked model makes the role moot, which is a role change too.
      assert.deepStrictEqual(yield* plan(role("smol"), selection("openai/o3")), {
        type: "restart_session",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("restores the picked model after a prewalk handoff, and re-arms it", () =>
    Effect.gen(function* () {
      const { turn, sent } = yield* openThread(selection("default"));
      const picked = selection("anthropic/claude-sonnet-4-5", [{ id: "prewalk", value: true }]);
      yield* turn(picked);
      yield* turn(picked);
      // The handoff left OMP on the prewalk target: the pick is set again before the prompt.
      assert.lengthOf(sent("set_model"), 2);
      assert.lengthOf(sent("set_prewalk"), 2);
      yield* turn(selection("anthropic/claude-sonnet-4-5", [{ id: "prewalk", value: false }]));
      assert.lengthOf(sent("set_model"), 3);
      yield* turn(selection("anthropic/claude-sonnet-4-5", [{ id: "prewalk", value: false }]));
      assert.lengthOf(sent("set_model"), 3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("re-sends fast mode after a model change, since OMP keeps it per model family", () =>
    Effect.gen(function* () {
      const { turn, sent } = yield* openThread(selection("default"));
      const fast = [{ id: "fastMode", value: true }];
      yield* turn(selection("default", fast));
      yield* turn(selection("anthropic/claude-sonnet-4-5", fast));
      yield* turn(selection("anthropic/claude-sonnet-4-5", fast));
      assert.deepStrictEqual(
        sent("set_fast_mode").map((command) => command["enabled"]),
        [true, true],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("goes back to the model OMP launched on (the role's model) for OMP default", () =>
    Effect.gen(function* () {
      const role = selection("default", [{ id: "role", value: "smol" }]);
      const { turn, sent } = yield* openThread(role, {
        get_state: [
          {
            respond: {
              sessionId: "launch",
              sessionFile: "/fake/sessions/launch.jsonl",
              model: { ...MODEL, id: "claude-haiku-4-5" },
            },
          },
        ],
      });
      yield* turn(selection("anthropic/claude-sonnet-4-5"));
      yield* turn(role);
      assert.deepStrictEqual(
        sent("set_model").map((command) => command["modelId"]),
        ["claude-sonnet-4-5", "claude-haiku-4-5"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
