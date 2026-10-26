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
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { makeOmpAdapter } from "./adapter.ts";
import { rewriteOmpSkillMention, type OmpCommandHooks } from "./commands.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import { ompStateDirs } from "./session.ts";
import { makeOmpThreadSessions } from "./threadSessions.ts";
import { makeFakeOmpState, waitUntil, type FakeOmpStep } from "./testing/fakeOmp.ts";

const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const INSTANCE_ID = ProviderInstanceId.make("omp-work");
const THREAD_ID = ThreadId.make("thread/ui");
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "approval-required",
  interactionMode: "default",
  cwd: null,
});

type Event = ProviderAdapter.ProviderAdapterV2Event;

const PROMPT_ACK: FakeOmpStep = { respond: { agentInvoked: true } };
const PROMPT_DONE: FakeOmpStep = {
  emit: { type: "prompt_result", status: "completed", agentInvoked: true, sessionSettled: true },
};
const uiRequest = (frame: Record<string, unknown>): FakeOmpStep => ({
  emit: { type: "extension_ui_request", ...frame },
});

/**
 * Opens a session on the fake, starts one turn and collects every event in the background.
 * `prompt` is what the fake does on `prompt`; `answered` what it does on each UI reply;
 * `afterReady` what it writes right after `ready`. `text` is the turn's message.
 */
const startUiTurn = Effect.fnUntraced(function* (script: {
  readonly prompt: ReadonlyArray<FakeOmpStep>;
  readonly answered?: ReadonlyArray<FakeOmpStep>;
  readonly afterReady?: ReadonlyArray<FakeOmpStep>;
  readonly text?: string;
  readonly commands?: OmpCommandHooks;
}) {
  const state = yield* makeFakeOmpState;
  const env = state.script({
    ...(script.afterReady === undefined ? {} : { afterReady: script.afterReady }),
    commands: {
      set_session_name: [{ respond: null }],
      set_ask_dialog: [{ respond: { enabled: true } }],
      prompt: script.prompt,
      ...(script.answered === undefined ? {} : { extension_ui_response: script.answered }),
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
    ...(script.commands === undefined ? {} : { commands: script.commands }),
  });
  const session = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: ProviderSessionId.make("session-ui"),
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimePolicy,
  });
  const events: Array<Event> = [];
  yield* session.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.forkScoped,
  );
  const providerThread = yield* session.ensureThread({
    threadId: THREAD_ID,
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimePolicy,
  });
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:omp" as OrchestrationV2AppThread["projectId"],
    title: "UI thread",
    providerInstanceId: INSTANCE_ID,
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimeMode: "approval-required",
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
  yield* session.startTurn({
    appThread,
    threadId: THREAD_ID,
    runId: RunId.make("run:ui:1"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("run-attempt:ui:1"),
    rootNodeId: NodeId.make("node:ui:root"),
    providerThread,
    message: {
      messageId: "message:ui:1" as never,
      text: script.text ?? "Do the thing",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimePolicy,
  });

  const requests = () =>
    events.flatMap((event) =>
      event.type === "runtime_request.updated" ? [event.runtimeRequest] : [],
    );
  const items = () =>
    events.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));
  /** The latest state of the first request OMP raised, once it is in `status`. */
  const request = Effect.fnUntraced(function* (status: OrchestrationV2RuntimeRequest["status"]) {
    assert.isTrue(
      yield* waitUntil(() => requests().some((entry) => entry.status === status)),
      `no runtime request became ${status}`,
    );
    return requests().findLast((entry) => entry.status === status)!;
  });
  const terminal = Effect.fnUntraced(function* () {
    assert.isTrue(yield* waitUntil(() => events.some((event) => event.type === "turn.terminal")));
    return events.findLast((event) => event.type === "turn.terminal");
  });
  const replies = () =>
    state.commands().filter((command) => command["type"] === "extension_ui_response");
  const itemFor = (requestId: OrchestrationV2RuntimeRequest["id"]) =>
    items().findLast(
      (item): item is Extract<OrchestrationV2TurnItem, { requestId: unknown }> =>
        "requestId" in item && item.requestId === requestId,
    );
  return { session, state, request, terminal, replies, itemFor };
});

const APPROVAL_PROMPT = [
  PROMPT_ACK,
  { emit: { type: "agent_start" } },
  uiRequest({
    id: "ui-approve",
    method: "select",
    title: "Allow tool: bash\nCommand: rm -rf build",
    options: ["Approve", "Approve rm for this session", "Deny"],
  }),
] satisfies ReadonlyArray<FakeOmpStep>;

posixOnly("OmpAdapter UI requests", () => {
  it.live("enables the ask dialog when the session opens", () =>
    Effect.gen(function* () {
      const { state } = yield* startUiTurn({ prompt: [PROMPT_ACK, PROMPT_DONE] });
      assert.deepInclude(
        state.commands().map(({ id: _id, ...command }) => command),
        { type: "set_ask_dialog", enabled: true },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each([
    { decision: "accept", value: "Approve" },
    { decision: "decline", value: "Deny" },
  ] as const)(
    "round-trips an approval card: $decision reaches omp as $value",
    ({ decision, value }) =>
      Effect.gen(function* () {
        const turn = yield* startUiTurn({ prompt: APPROVAL_PROMPT, answered: [PROMPT_DONE] });
        const pending = yield* turn.request("pending");
        assert.deepStrictEqual(
          [pending.kind, pending.nativeRequestRef?.nativeId, pending.responseCapability.type],
          ["command", "ui-approve", "live"],
        );
        const card = turn.itemFor(pending.id);
        assert.deepStrictEqual(
          card?.type === "approval_request"
            ? [card.status, card.prompt, card.options?.map((option) => option.decision)]
            : null,
          [
            "waiting",
            "Allow tool: bash\nCommand: rm -rf build",
            ["accept", "acceptForSession", "decline"],
          ],
        );

        yield* turn.session.respondToRuntimeRequest({ requestId: pending.id, decision });
        const resolved = yield* turn.request("resolved");
        assert.strictEqual(resolved.id, pending.id);
        assert.strictEqual(turn.itemFor(pending.id)?.status, "completed");
        assert.deepStrictEqual(turn.replies(), [
          { type: "extension_ui_response", id: "ui-approve", value },
        ]);
        const terminal = yield* turn.terminal();
        assert.strictEqual(
          terminal?.type === "turn.terminal" ? terminal.status : null,
          "completed",
        );

        // Answered once: a second answer has nothing to reach.
        const again = yield* turn.session
          .respondToRuntimeRequest({ requestId: pending.id, decision })
          .pipe(Effect.flip);
        assert.strictEqual(again._tag, "ProviderAdapterRuntimeRequestResponseError");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("answers a dialog OMP gave a deadline with cancelled+timedOut once it passes", () =>
    Effect.gen(function* () {
      const turn = yield* startUiTurn({
        prompt: [
          PROMPT_ACK,
          uiRequest({
            id: "ui-confirm",
            method: "confirm",
            title: "Overwrite?",
            message: "notes.md",
            timeout: 200,
          }),
        ],
        answered: [PROMPT_DONE],
      });
      const pending = yield* turn.request("pending");
      const expired = yield* turn.request("expired");
      assert.strictEqual(expired.id, pending.id);
      assert.strictEqual(turn.itemFor(pending.id)?.status, "cancelled");
      assert.deepStrictEqual(turn.replies(), [
        { type: "extension_ui_response", id: "ui-confirm", cancelled: true, timedOut: true },
      ]);
      yield* turn.terminal();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("closes the dialog a cancel names by targetId and sends no answer", () =>
    Effect.gen(function* () {
      const turn = yield* startUiTurn({
        prompt: [
          PROMPT_ACK,
          uiRequest({ id: "ui-input", method: "input", title: "Branch name" }),
          { sleepMs: 300 },
          uiRequest({ id: "ui-cancel", method: "cancel", targetId: "ui-input" }),
          PROMPT_DONE,
        ],
      });
      const pending = yield* turn.request("pending");
      const cancelled = yield* turn.request("cancelled");
      assert.strictEqual(cancelled.id, pending.id);
      assert.strictEqual(turn.itemFor(pending.id)?.status, "cancelled");
      yield* turn.terminal();
      assert.deepStrictEqual(turn.replies(), []);
      const late = yield* turn.session
        .respondToRuntimeRequest({ requestId: pending.id, answers: { "ui-input": "main" } })
        .pipe(Effect.flip);
      assert.strictEqual(late._tag, "ProviderAdapterRuntimeRequestResponseError");
      assert.deepStrictEqual(turn.replies(), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("answers an ask with multi-select labels and free-text Other", () =>
    Effect.gen(function* () {
      const turn = yield* startUiTurn({
        prompt: [
          PROMPT_ACK,
          uiRequest({
            id: "ui-ask",
            method: "ask",
            questions: [
              {
                id: "parts",
                question: "Which parts?",
                multi: true,
                options: [{ label: "API" }, { label: "Web" }, { label: "Docs" }],
              },
              { id: "tone", question: "Which tone?", options: [{ label: "Terse" }] },
            ],
          }),
        ],
        answered: [PROMPT_DONE],
      });
      const pending = yield* turn.request("pending");
      assert.strictEqual(pending.kind, "user_input");
      const card = turn.itemFor(pending.id);
      assert.deepStrictEqual(
        card?.type === "user_input_request"
          ? card.questions.map((question) => [
              question.id,
              question.multiSelect,
              question.allowCustomAnswer,
            ])
          : null,
        [
          ["parts", true, true],
          ["tone", false, true],
        ],
      );
      yield* turn.session.respondToRuntimeRequest({
        requestId: pending.id,
        answers: { parts: ["API", "Docs"], tone: "Friendly but brief" },
      });
      yield* turn.request("resolved");
      assert.deepStrictEqual(turn.replies(), [
        {
          type: "extension_ui_response",
          id: "ui-ask",
          answers: [
            { id: "parts", selectedOptions: ["API", "Docs"] },
            { id: "tone", selectedOptions: [], customInput: "Friendly but brief" },
          ],
        },
      ]);
      yield* turn.terminal();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("round-trips the /review mode picker as a select card", () =>
    Effect.gen(function* () {
      const modes = [
        "1. Review against a base branch (PR Style)",
        "2. Review uncommitted changes",
        "3. Review a specific commit",
        "4. Review a specific PR/MR",
        "5. Custom review instructions",
      ];
      const turn = yield* startUiTurn({
        text: "/review",
        prompt: [
          PROMPT_ACK,
          uiRequest({ id: "ui-review", method: "select", title: "Review Mode", options: modes }),
        ],
        answered: [PROMPT_DONE],
      });
      const pending = yield* turn.request("pending");
      assert.strictEqual(pending.kind, "user_input");
      const card = turn.itemFor(pending.id);
      assert.deepStrictEqual(
        card?.type === "user_input_request"
          ? card.questions.map((question) => [
              question.id,
              question.question,
              question.options.map((option) => option.label),
            ])
          : null,
        [["ui-review", "Review Mode", modes]],
      );
      yield* turn.session.respondToRuntimeRequest({
        requestId: pending.id,
        answers: { "ui-review": "2. Review uncommitted changes" },
      });
      yield* turn.request("resolved");
      assert.deepStrictEqual(
        turn.state
          .commands()
          .filter((command) => command["type"] === "prompt")
          .map((command) => command["message"]),
        ["/review"],
      );
      assert.deepStrictEqual(turn.replies(), [
        { type: "extension_ui_response", id: "ui-review", value: "2. Review uncommitted changes" },
      ]);
      yield* turn.terminal();
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

posixOnly("OmpAdapter commands and skills", () => {
  const recordingHooks = () => {
    const pushes: Array<{ readonly cwd: string; readonly names: ReadonlyArray<string> }> = [];
    const hooks: OmpCommandHooks = {
      onAvailableCommands: (cwd, commands) =>
        Effect.sync(() => void pushes.push({ cwd, names: commands.map((c) => c.name) })),
      resolvePrompt: (_cwd, text) => Effect.succeed(rewriteOmpSkillMention(text, new Set(["tdd"]))),
    };
    return { hooks, pushes };
  };
  const commandsUpdate = (names: ReadonlyArray<string>): FakeOmpStep => ({
    emit: {
      type: "available_commands_update",
      commands: names.map((name) => ({ name, source: "builtin" })),
    },
  });

  it.live("hands every available_commands_update to the catalog with the session's cwd", () =>
    Effect.gen(function* () {
      const { hooks, pushes } = recordingHooks();
      const turn = yield* startUiTurn({
        commands: hooks,
        afterReady: [commandsUpdate(["compact", "fresh"])],
        prompt: [PROMPT_ACK, commandsUpdate(["compact", "fresh", "review"]), PROMPT_DONE],
      });
      yield* turn.terminal();
      assert.isTrue(yield* waitUntil(() => pushes.length === 2));
      assert.deepStrictEqual(pushes, [
        { cwd: turn.state.dir, names: ["compact", "fresh"] },
        { cwd: turn.state.dir, names: ["compact", "fresh", "review"] },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("sends a $skill prompt to OMP as /skill:<name>", () =>
    Effect.gen(function* () {
      const { hooks } = recordingHooks();
      const turn = yield* startUiTurn({
        commands: hooks,
        text: "$tdd cover the parser",
        prompt: [PROMPT_ACK, PROMPT_DONE],
      });
      yield* turn.terminal();
      assert.deepStrictEqual(
        turn.state
          .commands()
          .filter((command) => command["type"] === "prompt")
          .map((command) => command["message"]),
        ["/skill:tdd cover the parser"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
