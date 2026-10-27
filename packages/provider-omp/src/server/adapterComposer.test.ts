// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  type ChatAttachment,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type ProviderInteractionMode,
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
import type { OmpCommandHooks } from "./commands.ts";
import { makeOmpThreadSessions } from "./threadSessions.ts";
import {
  type FakeOmpScript,
  type FakeOmpState,
  type FakeOmpStep,
  fakeOmpFrames,
  makeFakeOmpState,
  waitUntil,
} from "./testing/fakeOmp.ts";

const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const INSTANCE_ID = ProviderInstanceId.make("omp-work");
const THREAD_ID = ThreadId.make("thread/composer");
const policy = (interactionMode: ProviderInteractionMode = "default") =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode,
    cwd: null,
  });

/** Answers the reads around every turn so only the composer commands are scripted. */
const TURN_READS: Record<string, ReadonlyArray<FakeOmpStep>> = {
  set_session_name: [{ respond: null }],
  get_session_stats: [{ fail: "no stats" }],
};

/** A prompt that starts the agent loop and stays running until a later command settles it. */
const OPEN_PROMPT: ReadonlyArray<FakeOmpStep> = [
  { respond: { agentInvoked: true } },
  { emit: { type: "agent_start" } },
];

/** `prompt_result` without an id settles whichever prompt the turn is waiting on. */
const settle = (status: "completed" | "aborted"): FakeOmpStep => ({
  emit: { type: "prompt_result", status, agentInvoked: true, sessionSettled: true },
});

type Event = ProviderAdapter.ProviderAdapterV2Event;

/** `abort_and_restore_queue`'s answer when OMP held nothing. */
const NO_QUEUE = { steering: [], followUp: [] };

const openThread = Effect.fnUntraced(function* (
  state: FakeOmpState,
  script: FakeOmpScript,
  extra: {
    readonly resolveAttachmentPath?: (attachment: ChatAttachment) => string | null;
    readonly commands?: OmpCommandHooks;
  } = {},
) {
  const path = yield* Path.Path;
  const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
  const adapter = yield* makeOmpAdapter({
    instanceId: INSTANCE_ID,
    profile: "",
    environment: state.env(state.script(script)),
    platform,
    defaultCwd: state.dir,
    resolveBinary: Effect.succeed(state.executable()),
    dirs,
    pidfiles: yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform }),
    expectedContractVersion: "1.0.0",
    threadSessions: makeOmpThreadSessions(),
    sessions: state.sessions,
    ...extra,
  });
  const session = yield* adapter.openSession({
    threadId: THREAD_ID,
    providerSessionId: ProviderSessionId.make("session-composer"),
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimePolicy: policy(),
  });
  const providerThread = yield* session.ensureThread({
    threadId: THREAD_ID,
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
    runtimePolicy: policy(),
  });
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: THREAD_ID,
    projectId: "project:omp" as OrchestrationV2AppThread["projectId"],
    title: "Composer thread",
    providerInstanceId: INSTANCE_ID,
    modelSelection: { instanceId: INSTANCE_ID, model: "default" },
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
  };
  // Every event, in order, as the session emits them.
  const events: Array<Event> = [];
  yield* session.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => events.push(event))),
    Effect.forkScoped,
  );
  let turns = 0;
  const startTurn = (
    text: string,
    options: {
      readonly runId?: string;
      readonly attempt?: number;
      readonly interactionMode?: ProviderInteractionMode;
      readonly attachments?: ReadonlyArray<ChatAttachment>;
    } = {},
  ) =>
    Effect.gen(function* () {
      turns += 1;
      const runId = RunId.make(options.runId ?? `run:composer:${turns}`);
      const attempt = options.attempt ?? 1;
      const terminalsBefore = events.filter((event) => event.type === "turn.terminal").length;
      yield* session.startTurn({
        appThread,
        threadId: THREAD_ID,
        runId,
        runOrdinal: turns,
        providerTurnOrdinal: turns,
        attemptId: RunAttemptId.make(`${runId}:attempt:${attempt}`),
        rootNodeId: NodeId.make(`node:composer:${turns}`),
        providerThread,
        message: {
          messageId: `message:composer:${turns}` as never,
          text,
          attachments: options.attachments ?? [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: INSTANCE_ID, model: "default" },
        runtimePolicy: policy(options.interactionMode),
      });
      const ordinal = turns;
      const ownTurn = () =>
        events
          .flatMap((event) => (event.type === "provider_turn.updated" ? [event.providerTurn] : []))
          .find((providerTurn) => providerTurn.ordinal === ordinal);
      yield* waitUntil(() => ownTurn() !== undefined);
      const providerTurnId = ownTurn()?.id;
      assert.isDefined(providerTurnId);
      return {
        runId,
        providerTurnId: providerTurnId!,
        /** Waits for this turn's terminal and returns it. */
        terminal: Effect.gen(function* () {
          const done = yield* waitUntil(
            () => events.filter((event) => event.type === "turn.terminal").length > terminalsBefore,
          );
          assert.isTrue(done, "turn did not settle");
          const terminal = events.findLast((event) => event.type === "turn.terminal");
          return terminal?.type === "turn.terminal" ? terminal.status : null;
        }),
      };
    });
  const steer = (providerTurnId: string, text: string) =>
    session.steerTurn({
      threadId: THREAD_ID,
      runId: RunId.make(`run:composer:${turns}`),
      providerThread,
      providerTurnId: providerTurnId as never,
      message: {
        messageId: `message:composer:steer:${text}` as never,
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
    });
  const interrupt = (providerTurnId: string) =>
    session.interruptTurn({ providerThread, providerTurnId: providerTurnId as never });
  return { session, events, startTurn, steer, interrupt };
});

const commandsOf = (state: FakeOmpState, type: string) =>
  state.commands().filter((command) => command["type"] === type);

const notifications = (events: ReadonlyArray<Event>) =>
  events.flatMap((event) =>
    event.type === "turn_item.updated" && event.turnItem.type === "notification"
      ? [event.turnItem]
      : [],
  );

posixOnly("OmpAdapter composer runtime", () => {
  it.live("sends image attachments as prompt image blocks and names every attachment", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const imagePath = NodePath.join(state.dir, "pixel.png");
      NodeFS.writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      const image = {
        type: "image",
        id: "attachment-image",
        name: "pixel.png",
        mimeType: "image/png",
        sizeBytes: 4,
      } as ChatAttachment;
      const file = {
        type: "file",
        id: "attachment-file",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 5,
      } as ChatAttachment;
      const thread = yield* openThread(
        state,
        {
          commands: {
            ...TURN_READS,
            prompt: fakeOmpFrames.promptTurn({ text: ["Seen"] }),
          },
        },
        {
          resolveAttachmentPath: (attachment) =>
            attachment.id === "attachment-image" ? imagePath : "/saved/notes.txt",
        },
      );
      const turn = yield* thread.startTurn("What is this?", { attachments: [image, file] });
      assert.strictEqual(yield* turn.terminal, "completed");

      const [prompt] = commandsOf(state, "prompt");
      assert.deepStrictEqual(prompt?.["images"], [
        {
          type: "image",
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString("base64"),
          mimeType: "image/png",
        },
      ]);
      const message = String(prompt?.["message"]);
      assert.isTrue(message.startsWith("What is this?"));
      assert.include(message, `[Attached image "pixel.png" is saved at: ${imagePath}]`);
      assert.include(message, '[Attached file "notes.txt" is saved at: /saved/notes.txt]');
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("steers the running agent loop and renders OMP's queue snapshots", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const thread = yield* openThread(state, {
        commands: {
          ...TURN_READS,
          prompt: OPEN_PROMPT,
          steer: [
            { respond: null },
            { emit: { type: "queue_update", steering: ["also check y"], followUp: [] } },
            {
              emit: {
                type: "queue_update",
                steering: ["also check y"],
                followUp: [],
                liveSteered: 1,
              },
            },
            { emit: { type: "queue_update", steering: [], followUp: [] } },
            { emit: { type: "agent_end", messages: [] } },
            settle("completed"),
          ],
        },
      });
      const turn = yield* thread.startTurn("Check x");
      yield* thread.steer(turn.providerTurnId, "also check y");
      assert.strictEqual(yield* turn.terminal, "completed");

      assert.deepInclude(commandsOf(state, "steer")[0], { message: "also check y" });
      assert.lengthOf(commandsOf(state, "follow_up"), 0);
      const cards = notifications(thread.events).filter((item) => item.title === "OMP queue");
      assert.deepStrictEqual(
        cards.map((card) => [card.status, card.summary, card.detail]),
        [
          ["running", "1 message queued in OMP", "Steering: also check y"],
          ["running", "1 message queued in OMP", "Steering (sent): also check y"],
          ["completed", "OMP delivered every queued message", undefined],
        ],
      );
      // One card, updated in place.
      assert.strictEqual(new Set(cards.map((card) => card.id)).size, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("sends a follow_up once the agent loop has ended", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const thread = yield* openThread(state, {
        commands: {
          ...TURN_READS,
          prompt: [
            ...OPEN_PROMPT,
            { emit: { type: "agent_end", messages: [] } },
            { emit: fakeOmpFrames.notice("loop ended") },
          ],
          follow_up: [{ respond: null }, settle("completed")],
        },
      });
      const turn = yield* thread.startTurn("Start the job");
      const ended = yield* waitUntil(() =>
        thread.events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "system_notice" &&
            event.turnItem.message === "loop ended",
        ),
      );
      assert.isTrue(ended);
      yield* thread.steer(turn.providerTurnId, "then summarise");
      assert.strictEqual(yield* turn.terminal, "completed");
      assert.deepInclude(commandsOf(state, "follow_up")[0], { message: "then summarise" });
      assert.lengthOf(commandsOf(state, "steer"), 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops a turn with abort_and_restore_queue", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const thread = yield* openThread(state, {
        commands: {
          ...TURN_READS,
          prompt: OPEN_PROMPT,
          abort_and_restore_queue: [{ respond: NO_QUEUE }, settle("aborted")],
        },
      });
      const turn = yield* thread.startTurn("Long task");
      yield* thread.interrupt(turn.providerTurnId);
      assert.strictEqual(yield* turn.terminal, "interrupted");
      assert.lengthOf(commandsOf(state, "abort_and_restore_queue"), 1);
      assert.lengthOf(commandsOf(state, "abort"), 0);
      // Nothing was queued, so no queue card.
      assert.lengthOf(
        notifications(thread.events).filter((item) => item.title === "OMP queue"),
        0,
      );

      // A Stop for a turn that is no longer running is refused.
      const late = yield* Effect.flip(thread.interrupt(turn.providerTurnId));
      assert.strictEqual(late._tag, "ProviderAdapterInterruptError");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each([
    [
      "the answer before prompt_result",
      [
        { respond: { steering: [], followUp: [{ text: "afterwards" }] } },
        { emit: { type: "queue_update", steering: [], followUp: [] } },
        settle("aborted"),
      ],
    ],
    [
      "prompt_result before the answer",
      [
        { emit: { type: "queue_update", steering: [], followUp: [] } },
        settle("aborted"),
        { sleepMs: 200 },
        { respond: { steering: [], followUp: [{ text: "afterwards" }] } },
      ],
    ],
  ] as const)("lists messages a Stop withdrew on the stopped turn (%s)", ([, steps]) =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const thread = yield* openThread(state, {
        commands: {
          ...TURN_READS,
          prompt: [
            ...OPEN_PROMPT,
            { emit: { type: "queue_update", steering: [], followUp: ["afterwards"] } },
          ],
          abort_and_restore_queue: steps,
        },
      });
      const turn = yield* thread.startTurn("Long task");
      const queued = yield* waitUntil(() =>
        notifications(thread.events).some((item) => item.summary === "1 message queued in OMP"),
      );
      assert.isTrue(queued);
      yield* thread.interrupt(turn.providerTurnId);
      assert.strictEqual(yield* turn.terminal, "interrupted");

      const cards = notifications(thread.events).filter((item) => item.title === "OMP queue");
      // The emptied queue never reads as delivered: the card closes as withdrawn.
      assert.deepStrictEqual(
        cards.map((card) => [card.status, card.summary, card.detail]),
        [
          ["running", "1 message queued in OMP", "Follow-up: afterwards"],
          ["completed", "Stopped before 1 queued message ran", "afterwards"],
        ],
      );
      // ...and it is on the turn before the turn ends.
      const closedAt = thread.events.findIndex(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "notification" &&
          event.turnItem.summary.startsWith("Stopped before"),
      );
      const endedAt = thread.events.findIndex((event) => event.type === "turn.terminal");
      assert.isTrue(closedAt !== -1 && closedAt < endedAt);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ends a held turn with the run OMP starts for the late steer", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const thread = yield* openThread(state, {
        commands: {
          ...TURN_READS,
          prompt: OPEN_PROMPT,
          steer: [
            { emit: { type: "agent_end", messages: [] } },
            settle("completed"),
            { emit: { type: "queue_update", steering: ["one more thing"], followUp: [] } },
            { respond: null },
            { sleepMs: 100 },
            { emit: { type: "agent_start" } },
            { emit: { type: "queue_update", steering: [], followUp: [] } },
            { emit: fakeOmpFrames.notice("drain ran") },
            { emit: { type: "agent_end", messages: [] } },
          ],
          // `get_state` keeps the fake's default answer; the queue snapshot says it is queued.
        },
      });
      const turn = yield* thread.startTurn("Long task");
      yield* thread.steer(turn.providerTurnId, "one more thing");
      assert.strictEqual(yield* turn.terminal, "completed");
      const ranAt = thread.events.findIndex(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "system_notice" &&
          event.turnItem.message === "drain ran",
      );
      const endedAt = thread.events.findIndex((event) => event.type === "turn.terminal");
      // The drain run's frames landed in the turn, which ended only after it.
      assert.isTrue(ranAt !== -1 && ranAt < endedAt);
      assert.lengthOf(
        thread.events.filter((event) => event.type === "turn.terminal"),
        1,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ends a held turn when OMP is idle after the late steer", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const thread = yield* openThread(state, {
        commands: {
          ...TURN_READS,
          prompt: OPEN_PROMPT,
          steer: [
            { emit: { type: "agent_end", messages: [] } },
            settle("completed"),
            { respond: null },
          ],
          // `get_state` keeps the fake's default answer: nothing queued, not streaming.
        },
      });
      const turn = yield* thread.startTurn("Long task");
      yield* thread.steer(turn.providerTurnId, "one more thing");
      assert.strictEqual(yield* turn.terminal, "completed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("restarts an interrupted run's next attempt with abort_and_prompt", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const thread = yield* openThread(state, {
        commands: {
          ...TURN_READS,
          prompt: OPEN_PROMPT,
          abort_and_restore_queue: [{ respond: NO_QUEUE }, settle("aborted")],
          abort_and_prompt: fakeOmpFrames.promptTurn({ text: ["Restarted"] }),
        },
      });
      const first = yield* thread.startTurn("First try", { runId: "run:restart" });
      yield* thread.interrupt(first.providerTurnId);
      assert.strictEqual(yield* first.terminal, "interrupted");

      const second = yield* thread.startTurn("Second try", { runId: "run:restart", attempt: 2 });
      assert.strictEqual(yield* second.terminal, "completed");
      assert.lengthOf(commandsOf(state, "prompt"), 1);
      assert.deepInclude(commandsOf(state, "abort_and_prompt")[0], { message: "Second try" });
      const answer = thread.events
        .flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []))
        .findLast((item) => item.type === "assistant_message");
      assert.strictEqual(answer?.type === "assistant_message" ? answer.text : null, "Restarted");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("states the Plan toggle to OMP on the first prompt after each change", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const thread = yield* openThread(state, {
        commands: { ...TURN_READS, prompt: fakeOmpFrames.promptTurn({ text: ["Ok"] }) },
      });
      for (const [text, interactionMode] of [
        ["Plan the change", "plan"],
        ["Refine it", "plan"],
        ["/compact", "default"],
        ["Implement it", "default"],
        ["Keep going", "default"],
      ] as const) {
        const turn = yield* thread.startTurn(text, { interactionMode });
        assert.strictEqual(yield* turn.terminal, "completed");
      }
      const messages = commandsOf(state, "prompt").map((command) => String(command["message"]));
      assert.include(messages[0], "## Ompanel interaction mode: Plan");
      assert.include(messages[0], "<user_request>\nPlan the change\n</user_request>");
      assert.strictEqual(messages[1], "Refine it");
      // A slash command stays first in its prompt; the mode change waits for the next one.
      assert.strictEqual(messages[2], "/compact");
      assert.include(messages[3], "## Ompanel interaction mode: Default");
      assert.include(messages[3], "<user_request>\nImplement it\n</user_request>");
      assert.strictEqual(messages[4], "Keep going");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rewrites a `$skill` before stating Plan and never counts it as stating the mode", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const thread = yield* openThread(
        state,
        { commands: { ...TURN_READS, prompt: fakeOmpFrames.promptTurn({ text: ["Ok"] }) } },
        {
          commands: {
            onAvailableCommands: () => Effect.void,
            resolvePrompt: (_cwd, text) => Effect.succeed(text.replace(/^\$(\S+)/, "/skill:$1")),
          },
        },
      );
      for (const text of ["$review the diff", "Plan the change"]) {
        const turn = yield* thread.startTurn(text, { interactionMode: "plan" });
        assert.strictEqual(yield* turn.terminal, "completed");
      }
      const messages = commandsOf(state, "prompt").map((command) => String(command["message"]));
      // OMP expands a skill only at the start of a prompt: the rewrite goes out unwrapped...
      assert.strictEqual(messages[0], "/skill:review the diff");
      // ...so Plan is stated on the next prompt.
      assert.include(messages[1], "## Ompanel interaction mode: Plan");
      assert.include(messages[1], "<user_request>\nPlan the change\n</user_request>");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  // Recorded from the pinned OMP (`omp_handoff` replay fixture): the ack comes first, the
  // handoff runs in the background, and one `command_output` closes it.
  it.live("sends /handoff to OMP and ends its turn with OMP's closing output", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const thread = yield* openThread(state, {
        commands: {
          ...TURN_READS,
          prompt: [
            { respond: { agentInvoked: false } },
            { sleepMs: 200 },
            {
              emit: { type: "command_output", text: "Context handed off and compacted in place." },
            },
          ],
        },
      });
      const turn = yield* thread.startTurn("/handoff focus on the parser");
      assert.strictEqual(yield* turn.terminal, "completed");
      assert.deepStrictEqual(
        commandsOf(state, "prompt").map((command) => command["message"]),
        ["/handoff focus on the parser"],
      );
      const shownAt = thread.events.findIndex(
        (event) =>
          event.type === "turn_item.updated" &&
          event.turnItem.type === "notification" &&
          event.turnItem.summary === "Context handed off and compacted in place.",
      );
      const endedAt = thread.events.findIndex((event) => event.type === "turn.terminal");
      assert.isTrue(shownAt !== -1 && shownAt < endedAt, "the handoff's output is not on its turn");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("stops a /handoff OMP is still running", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const thread = yield* openThread(state, {
        commands: {
          ...TURN_READS,
          // A Stop cancels the handoff, and OMP then sends nothing more.
          prompt: [{ respond: { agentInvoked: false } }],
          abort_and_restore_queue: [{ respond: NO_QUEUE }],
        },
      });
      const turn = yield* thread.startTurn("/handoff");
      yield* thread.interrupt(turn.providerTurnId);
      assert.strictEqual(yield* turn.terminal, "interrupted");
      assert.lengthOf(commandsOf(state, "abort_and_restore_queue"), 1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
