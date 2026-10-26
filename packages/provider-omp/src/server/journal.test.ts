// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { makeOmpAdapter, OMP_PROVIDER_CAPABILITIES } from "./adapter.ts";
import {
  OmpJournaledMapper,
  OmpJournalRecorder,
  ompJournalDetachedTail,
  ompJournalFrame,
  ompJournalOpenEntry,
  ompJournalPath,
  parseOmpJournal,
  replayOmpJournal,
  type OmpJournalEntry,
} from "./journal.ts";
import { OMP_PROVIDER } from "./mapper.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import { ompStateDirs } from "./session.ts";
import { makeOmpThreadSessions } from "./threadSessions.ts";
import {
  fakeOmpFrames,
  makeFakeOmpState,
  waitUntil,
  type FakeOmpState,
  type FakeOmpStep,
} from "./testing/fakeOmp.ts";
import {
  JOURNAL_INSTANCE_ID,
  JOURNAL_THREAD_ID,
  journalModelSelection,
  journalRuntimePolicy,
  journalTurnInput,
  ompThreadView,
} from "./testing/journalFixtures.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;

const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const SESSION_READS = {
  get_state: [
    {
      respond: {
        sessionId: "journal-session",
        sessionFile: "/fake/sessions/journal-session.jsonl",
        contextUsage: { tokens: 1_000, contextWindow: 100_000, percent: 1 },
        todoPhases: [],
      },
    },
  ],
  get_session_stats: [
    {
      respond: {
        sessionId: "journal-session",
        userMessages: 1,
        assistantMessages: 1,
        toolCalls: 1,
        toolResults: 1,
        totalMessages: 3,
        tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
        premiumRequests: 0,
        cost: 0.001,
        contextUsage: { tokens: 1_015, contextWindow: 100_000, percent: 1.02 },
      },
    },
  ],
  set_session_name: [{ respond: null }],
} satisfies Record<string, ReadonlyArray<FakeOmpStep>>;

/** A run OMP starts by itself once a background job's result arrives. */
const backgroundRun: ReadonlyArray<FakeOmpStep> = (() => {
  const final = fakeOmpFrames.assistant([{ type: "text", text: "Job done" }]);
  const partial = fakeOmpFrames.assistant([]);
  const messageId = "background-message";
  const update = (event: Record<string, unknown>): FakeOmpStep => ({
    emit: { type: "message_update", message: partial, assistantMessageEvent: event, messageId },
  });
  return [
    { emit: { type: "agent_start" } },
    { emit: { type: "message_start", message: partial, messageId } },
    update({ type: "text_start", contentIndex: 0, partial }),
    update({ type: "text_delta", contentIndex: 0, delta: "Job ", partial }),
    update({ type: "text_delta", contentIndex: 0, delta: "done", partial }),
    update({ type: "text_end", contentIndex: 0, content: "Job done", partial }),
    { emit: { type: "message_end", message: final, messageId } },
    { emit: { type: "agent_end", messages: [final], yielded: true, isTerminal: true } },
    { emit: { type: "session_settled" } },
  ];
})();

/** A prompt whose `prompt_result` says a background job can still wake the session. */
const unsettledPrompt = (): Array<FakeOmpStep> => {
  const steps = [...fakeOmpFrames.promptTurn({ text: ["Started ", "a job"] })];
  const result = steps.pop() as { readonly emit: Record<string, unknown> };
  return [...steps, { emit: { ...result.emit, sessionSettled: false } }];
};

const makeHarness = Effect.fnUntraced(function* (
  state: FakeOmpState,
  commands: Record<string, ReadonlyArray<FakeOmpStep>>,
  offers: Array<ProviderContinuationRequests.ProviderContinuationRequest>,
) {
  const path = yield* Path.Path;
  const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
  const adapter = yield* makeOmpAdapter({
    instanceId: JOURNAL_INSTANCE_ID,
    profile: "",
    environment: state.env(state.script({ commands: { ...SESSION_READS, ...commands } })),
    platform,
    defaultCwd: state.dir,
    resolveBinary: Effect.succeed(state.executable()),
    dirs,
    pidfiles: yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform }),
    expectedContractVersion: "1.0.0",
    threadSessions: makeOmpThreadSessions(),
    sessions: state.sessions,
  }).pipe(
    Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
      offer: (request) => Effect.sync(() => void offers.push(request)),
      take: Effect.never,
    }),
  );
  return { adapter, journalFile: ompJournalPath(path, dirs.threads, JOURNAL_THREAD_ID) };
});

const openInput = (id: string) => ({
  threadId: JOURNAL_THREAD_ID,
  providerSessionId: ProviderSessionId.make(id),
  modelSelection: journalModelSelection,
  runtimePolicy: journalRuntimePolicy,
});

const terminals = (events: ReadonlyArray<Event>) =>
  events.filter((event) => event.type === "turn.terminal");

const assistantTexts = (events: ReadonlyArray<Event>) =>
  events.flatMap((event) =>
    event.type === "turn_item.updated" &&
    event.turnItem.type === "assistant_message" &&
    event.turnItem.status === "completed"
      ? [event.turnItem.text]
      : [],
  );

const readJournal = (file: string) => parseOmpJournal(NodeFS.readFileSync(file, "utf8"));

describe("OMP journal entries", () => {
  it("keeps only what the mapping reads of a streaming update, and unknown frames whole", () => {
    const partial = {
      role: "assistant",
      content: [
        { type: "text", text: "a long answer so far" },
        { type: "thinking", thinking: "said aloud", narration: true },
      ],
    };
    const update = {
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 1, delta: "x", partial },
    };
    assert.deepStrictEqual(ompJournalFrame(update), {
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 1,
        delta: "x",
        partial: { content: [null, { type: "thinking", narration: true }] },
      },
    });
    const unknown = { type: "frame_from_a_newer_omp", payload: { anything: [1, 2] } };
    assert.strictEqual(ompJournalFrame(unknown), unknown);
  });

  it("skips torn, foreign and unknown lines, and replays unknown frames as nothing", () => {
    const now = DateTime.makeUnsafe(1_000);
    const entries: Array<OmpJournalEntry> = [];
    const recorder = new OmpJournalRecorder((entry) => entries.push(entry));
    const providerSession = {
      id: ProviderSessionId.make("session-journal"),
      driver: OMP_PROVIDER,
      providerInstanceId: JOURNAL_INSTANCE_ID,
      status: "ready" as const,
      cwd: "/work",
      model: "default",
      capabilities: OMP_PROVIDER_CAPABILITIES,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    recorder.record(
      ompJournalOpenEntry({
        threadId: JOURNAL_THREAD_ID,
        instanceId: JOURNAL_INSTANCE_ID,
        contractVersion: "1.6.0",
        providerSession,
        now,
      }),
    );
    const mapper = new OmpJournaledMapper(
      { instanceId: JOURNAL_INSTANCE_ID, providerSession },
      recorder,
    );
    const sessionInfo = { type: "session_info_update", sessionId: "s-2" };
    const live = [
      ...mapper.bindThread(
        { threadId: JOURNAL_THREAD_ID, state: { sessionId: "s-1", sessionName: "Named" } },
        now,
      ).events,
      ...mapper.handleFrame({ type: "frame_from_a_newer_omp" }, now).events,
      ...mapper.handleFrame(sessionInfo, now).events,
    ];
    const text = [
      "not json",
      ...entries.map((entry) => JSON.stringify(entry)),
      JSON.stringify({ k: "entry_from_a_newer_build" }),
      '{"k":"frame","at":1000,"frame":{"type":"no',
    ].join("\n");
    const parsed = parseOmpJournal(text);
    assert.strictEqual(parsed.skipped, 3);
    const replay = replayOmpJournal(parsed.entries);
    assert.strictEqual(replay.skipped, 0);
    assert.deepStrictEqual(ompThreadView(replay.events), ompThreadView(live));
  });

  it("records a turn start once, not the status change it makes inside", () => {
    const now = DateTime.makeUnsafe(2_000);
    const entries: Array<OmpJournalEntry> = [];
    const recorder = new OmpJournalRecorder((entry) => entries.push(entry));
    const mapper = new OmpJournaledMapper(
      {
        instanceId: JOURNAL_INSTANCE_ID,
        providerSession: {
          id: ProviderSessionId.make("session-nesting"),
          driver: OMP_PROVIDER,
          providerInstanceId: JOURNAL_INSTANCE_ID,
          status: "ready",
          cwd: "/work",
          model: "default",
          capabilities: OMP_PROVIDER_CAPABILITIES,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        },
      },
      recorder,
    );
    const { providerThread } = mapper.bindThread(
      { threadId: JOURNAL_THREAD_ID, state: { sessionId: "s-1" } },
      now,
    );
    mapper.startTurn(journalTurnInput(providerThread, 1, now), now);
    mapper.finalizeTurn({ status: "completed" }, {}, now);
    assert.deepStrictEqual(
      entries.map((entry) => entry.k),
      ["bind", "turn", "finalize"],
    );
  });

  it("replays steers, a Stop and OMP's queue, including a queue change between turns", () => {
    const now = (ms: number) => DateTime.makeUnsafe(3_000 + ms);
    const entries: Array<OmpJournalEntry> = [];
    const recorder = new OmpJournalRecorder((entry) => entries.push(entry));
    const providerSession = {
      id: ProviderSessionId.make("session-steer"),
      driver: OMP_PROVIDER,
      providerInstanceId: JOURNAL_INSTANCE_ID,
      status: "ready" as const,
      cwd: "/work",
      model: "default",
      capabilities: OMP_PROVIDER_CAPABILITIES,
      createdAt: now(0),
      updatedAt: now(0),
      lastError: null,
    };
    recorder.record(
      ompJournalOpenEntry({
        threadId: JOURNAL_THREAD_ID,
        instanceId: JOURNAL_INSTANCE_ID,
        contractVersion: "1.6.0",
        providerSession,
        now: now(0),
      }),
    );
    const mapper = new OmpJournaledMapper(
      { instanceId: JOURNAL_INSTANCE_ID, providerSession },
      recorder,
    );
    const queue = (steering: ReadonlyArray<string>) => ({
      type: "queue_update",
      steering,
      followUp: [],
    });
    const live: Array<Event> = [];
    const bound = mapper.bindThread(
      { threadId: JOURNAL_THREAD_ID, state: { sessionId: "steer-session" } },
      now(1),
    );
    live.push(...bound.events);
    // Left over from before the turn: the turn's queue card starts from it.
    live.push(...mapper.handleFrame(queue(["earlier"]), now(2)).events);
    live.push(...mapper.startTurn(journalTurnInput(bound.providerThread, 1, now(3)), now(3)));
    mapper.steerSent();
    live.push(...mapper.handleFrame(queue(["earlier", "also this"]), now(4)).events);
    mapper.beginStop();
    live.push(...mapper.endStop({ steering: ["earlier", "also this"], followUp: [] }, now(5)));
    live.push(...mapper.finalizeTurn({ status: "interrupted" }, {}, now(6)));

    assert.deepStrictEqual(
      entries.map((entry) => entry.k),
      ["open", "bind", "frame", "turn", "steer", "frame", "stop", "stopped", "finalize"],
    );
    const replay = replayOmpJournal(entries);
    assert.strictEqual(replay.skipped, 0);
    assert.deepStrictEqual(ompThreadView(replay.events), ompThreadView(live));
  });

  it("finds the run still waiting for a turn at the end of a segment", () => {
    const frame = (type: string) => ({ type });
    const segment: Array<OmpJournalEntry> = [
      { k: "detached", at: 1, frame: frame("agent_start") },
      { k: "turn", at: 2, input: {} },
      { k: "frame", at: 3, frame: frame("agent_start") },
      { k: "finalize", at: 4, outcome: { status: "completed" }, refresh: {} },
      { k: "detached", at: 5, frame: frame("agent_start") },
      { k: "detached", at: 6, frame: frame("agent_end") },
    ];
    assert.deepStrictEqual(ompJournalDetachedTail(segment), [
      frame("agent_start"),
      frame("agent_end"),
    ]);
  });
});

posixOnly("OmpAdapter journal", () => {
  it.live("replays the journal to the same thread view a client watching live had", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const prompt = [
        ...fakeOmpFrames.promptTurn({
          text: ["Hel", "lo"],
          thinking: ["Thinking"],
          tool: {
            toolCallId: "call-bash",
            toolName: "bash",
            args: { command: "ls" },
            result: { content: [{ type: "text", text: "a.txt" }] },
          },
        }),
      ];
      const promptResult = prompt.pop()!;
      const { adapter, journalFile } = yield* makeHarness(
        state,
        {
          prompt: [
            ...prompt,
            { emit: fakeOmpFrames.subagentLifecycle({ id: "sub-1", status: "started" }) },
            { emit: { type: "frame_from_a_newer_omp", payload: { anything: true } } },
            { emit: fakeOmpFrames.notice("Heads up") },
            { emit: fakeOmpFrames.subagentLifecycle({ id: "sub-1", status: "completed" }) },
            promptResult,
          ],
        },
        [],
      );

      const live: Array<Event> = [];
      const outer = yield* Effect.scope;
      const collector = yield* Effect.gen(function* () {
        const session = yield* adapter.openSession(openInput("session-journal-view"));
        const fiber = yield* session.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => void live.push(event))),
          Effect.forkIn(outer),
        );
        const providerThread = yield* session.ensureThread({
          threadId: JOURNAL_THREAD_ID,
          modelSelection: journalModelSelection,
          runtimePolicy: journalRuntimePolicy,
        });
        yield* session.startTurn(journalTurnInput(providerThread, 1, yield* DateTime.now));
        assert.isTrue(yield* waitUntil(() => terminals(live).length === 1));
        return fiber;
      }).pipe(Effect.scoped);
      // The session's last events (stopped) arrive as its scope closes.
      yield* Fiber.await(collector);

      assert.deepStrictEqual(assistantTexts(live), ["Hello"]);
      assert.isTrue(live.some((event) => event.type === "subagent.updated"));
      const replay = replayOmpJournal(readJournal(journalFile).entries);
      assert.strictEqual(replay.segments, 1);
      assert.strictEqual(replay.skipped, 0);
      assert.strictEqual(replay.events.length, live.length);
      assert.deepStrictEqual(ompThreadView(replay.events), ompThreadView(live));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("delivers a run OMP starts after the turn through a continuation turn (ompanel#41)", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const { adapter } = yield* makeHarness(
        state,
        { prompt: [...unsettledPrompt(), { sleepMs: 200 }, ...backgroundRun] },
        offers,
      );
      yield* Effect.gen(function* () {
        const session = yield* adapter.openSession(openInput("session-journal-wake"));
        const live: Array<Event> = [];
        yield* session.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => void live.push(event))),
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId: JOURNAL_THREAD_ID,
          modelSelection: journalModelSelection,
          runtimePolicy: journalRuntimePolicy,
        });
        yield* session.startTurn(journalTurnInput(providerThread, 1, yield* DateTime.now));
        assert.isTrue(yield* waitUntil(() => terminals(live).length === 1));
        assert.isTrue(yield* waitUntil(() => offers.length === 1));
        const offer = offers[0]!;
        assert.deepStrictEqual(
          [offer.threadId, offer.providerThreadId, offer.driver],
          [JOURNAL_THREAD_ID, providerThread.id, OMP_PROVIDER],
        );
        // The run waits for its turn; idle release must not kill the process meanwhile.
        assert.isTrue(yield* session.hasPendingBackgroundWork!);
        const dispatched = yield* offer.dispatchIfCurrent!(Effect.succeed("dispatched"));
        assert.deepStrictEqual(dispatched, Option.some("dispatched"));

        const before = live.length;
        yield* session.startTurn(journalTurnInput(providerThread, 2, yield* DateTime.now, true));
        assert.isTrue(yield* waitUntil(() => terminals(live).length === 2));
        const continuation = live.slice(before);
        assert.deepStrictEqual(assistantTexts(continuation), ["Job done"]);
        const terminal = terminals(continuation)[0];
        assert.deepStrictEqual(
          terminal?.type === "turn.terminal" ? [terminal.status, terminal.runOrdinal] : null,
          ["completed", 2],
        );
        // A continuation sends no prompt: OMP already ran the work.
        assert.strictEqual(
          state.commands().filter((command) => command["type"] === "prompt").length,
          1,
        );
        assert.isFalse(yield* session.hasPendingBackgroundWork!);
        // Taken by its turn: a late dispatch of the same wake does nothing.
        assert.deepStrictEqual(
          yield* offer.dispatchIfCurrent!(Effect.succeed("late")),
          Option.none(),
        );
      }).pipe(Effect.scoped);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("replays a run the previous process left waiting when the thread reattaches", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const firstOffers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const first = yield* makeHarness(
        state,
        { prompt: [...unsettledPrompt(), { sleepMs: 200 }, ...backgroundRun] },
        firstOffers,
      );
      // The thread goes to the background: its run is never continued, and the process stops.
      yield* Effect.gen(function* () {
        const session = yield* first.adapter.openSession(openInput("session-journal-first"));
        const live: Array<Event> = [];
        yield* session.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => void live.push(event))),
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId: JOURNAL_THREAD_ID,
          modelSelection: journalModelSelection,
          runtimePolicy: journalRuntimePolicy,
        });
        yield* session.startTurn(journalTurnInput(providerThread, 1, yield* DateTime.now));
        assert.isTrue(yield* waitUntil(() => firstOffers.length === 1));
        // The whole run arrived: the journal holds it up to its `agent_end`.
        assert.isTrue(
          yield* waitUntil(() =>
            readJournal(first.journalFile).entries.some(
              (entry) => entry.k === "detached" && entry.frame.type === "agent_end",
            ),
          ),
        );
      }).pipe(Effect.scoped);

      const offers: Array<ProviderContinuationRequests.ProviderContinuationRequest> = [];
      const second = yield* makeHarness(state, {}, offers);
      yield* Effect.gen(function* () {
        const session = yield* second.adapter.openSession(openInput("session-journal-second"));
        const live: Array<Event> = [];
        yield* session.events.pipe(
          Stream.runForEach((event) => Effect.sync(() => void live.push(event))),
          Effect.forkScoped,
        );
        const providerThread = yield* session.ensureThread({
          threadId: JOURNAL_THREAD_ID,
          modelSelection: journalModelSelection,
          runtimePolicy: journalRuntimePolicy,
        });
        assert.strictEqual(offers.length, 1);
        assert.isTrue(yield* session.hasPendingBackgroundWork!);
        yield* session.startTurn(journalTurnInput(providerThread, 2, yield* DateTime.now, true));
        assert.isTrue(yield* waitUntil(() => terminals(live).length === 1));
        assert.deepStrictEqual(assistantTexts(live), ["Job done"]);
        const terminal = terminals(live)[0];
        assert.strictEqual(
          terminal?.type === "turn.terminal" ? terminal.status : null,
          "completed",
        );
        assert.isFalse(yield* session.hasPendingBackgroundWork!);
      }).pipe(Effect.scoped);

      // Taken: a third process has nothing left to carry over.
      const tail = replayOmpJournal(readJournal(second.journalFile).entries);
      assert.strictEqual(tail.segments, 2);
      assert.strictEqual(tail.skipped, 0);
      const segment = readJournal(second.journalFile).entries;
      const lastOpen = segment.findLastIndex((entry) => entry.k === "open");
      assert.deepStrictEqual(ompJournalDetachedTail(segment.slice(lastOpen)), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
