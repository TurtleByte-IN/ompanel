/**
 * The per-session frame journal (FR-7, docs/omp/journal.md): every input that changes what a
 * thread shows, one NDJSON line each, so a replay through fresh state reproduces the live events.
 * A run OMP starts while no turn is attached waits here until a turn takes it.
 */
import {
  ModelSelection,
  NodeId,
  OrchestrationV2AppThread,
  OrchestrationV2ProviderSession,
  OrchestrationV2ProviderThread,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import type { SessionState } from "../../contract/src/wire.generated.ts";
import {
  OmpThreadMapper,
  type OmpFrameResult,
  type OmpRequestPlacement,
  type OmpThreadMapperOptions,
  type OmpTurnOutcome,
  type OmpTurnRefresh,
} from "./mapper.ts";
import {
  OmpSubagentTracker,
  ompSubagentControls,
  type OmpSubagentScope,
  type OmpSubagentTrackerOptions,
} from "./subagents.ts";
import {
  OmpUiRequests,
  type OmpDialogAnswer,
  type OmpDialogOpened,
  type OmpDialogRequest,
} from "./uiRequests.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;

const OMP_JOURNAL_VERSION = 1;
/** The thread's journal, next to its `session.json` (docs/omp/sessions.md). */
const OMP_JOURNAL_FILE = "journal.ndjson";
/** The previous journal, kept once when the current one is rotated. */
const OMP_JOURNAL_PREVIOUS_FILE = "journal.1.ndjson";
/** A journal this large is rotated when the next process opens it. */
const OMP_JOURNAL_ROTATE_BYTES = 32 * 1024 * 1024;
/** Lines are written in batches; a crash loses at most this much of the tail. */
const OMP_JOURNAL_FLUSH_MS = 100;

/** A frame as recorded: the parts of it the mapping reads (see `ompJournalFrame`). */
export type OmpJournalFrame = { readonly type: string } & Readonly<Record<string, unknown>>;

/**
 * One journal line. `at` is the epoch milliseconds the live session passed as "now", so a replay
 * stamps the same times. Payloads holding dates are schema-encoded.
 */
export type OmpJournalEntry =
  | {
      readonly k: "open";
      readonly at: number;
      readonly v: typeof OMP_JOURNAL_VERSION;
      readonly threadId: string;
      readonly instanceId: string;
      readonly contractVersion: string;
      readonly providerSession: unknown;
    }
  | { readonly k: "frame"; readonly at: number; readonly frame: OmpJournalFrame }
  | { readonly k: "subagent"; readonly at: number; readonly frame: OmpJournalFrame }
  /** A frame of a run no turn holds yet; a later turn replays it as a `frame`. */
  | { readonly k: "detached"; readonly at: number; readonly frame: OmpJournalFrame }
  | {
      readonly k: "bind";
      readonly at: number;
      readonly threadId: string;
      readonly state: SessionState;
      readonly existing?: unknown;
    }
  | { readonly k: "turn"; readonly at: number; readonly input: unknown }
  | { readonly k: "flush"; readonly at: number }
  | {
      readonly k: "finalize";
      readonly at: number;
      readonly outcome: OmpTurnOutcome;
      readonly refresh: OmpTurnRefresh;
    }
  | { readonly k: "adopt"; readonly at: number; readonly sessionId: string }
  | {
      readonly k: "status";
      readonly at: number;
      readonly status: OrchestrationV2ProviderSession["status"];
      readonly lastError: string | null;
    }
  | { readonly k: "restart"; readonly at: number; readonly keys: ReadonlyArray<string> }
  | { readonly k: "place"; readonly nativeItemId: string; readonly fallbackThreadId: string }
  | {
      readonly k: "dialog";
      readonly at: number;
      readonly frame: OmpJournalFrame;
      readonly placement: OmpRequestPlacement;
    }
  | { readonly k: "resolve"; readonly at: number; readonly requestId: string }
  | { readonly k: "expire"; readonly at: number; readonly nativeId: string }
  | { readonly k: "close"; readonly at: number; readonly targetId: string }
  | { readonly k: "closeAll"; readonly at: number }
  /** Events the adapter emitted from outside the state objects (an imported session's history). */
  | { readonly k: "events"; readonly events: unknown };

const ENTRY_KINDS: Record<OmpJournalEntry["k"], true> = {
  open: true,
  frame: true,
  subagent: true,
  detached: true,
  bind: true,
  turn: true,
  flush: true,
  finalize: true,
  adopt: true,
  status: true,
  restart: true,
  place: true,
  dialog: true,
  resolve: true,
  expire: true,
  close: true,
  closeAll: true,
  events: true,
};

/** `ProviderAdapterV2TurnInput` as a schema, so a turn start survives the round trip. */
const JournalTurnInput = Schema.Struct({
  appThread: OrchestrationV2AppThread,
  threadId: ThreadId,
  runId: RunId,
  runOrdinal: Schema.Number,
  nativeThreadHasTurns: Schema.optionalKey(Schema.Boolean),
  providerTurnOrdinal: Schema.Number,
  restartContinuationOfRunId: Schema.optionalKey(RunId),
  attemptId: RunAttemptId,
  rootNodeId: NodeId,
  providerThread: OrchestrationV2ProviderThread,
  message: ProviderAdapter.ProviderAdapterV2TurnMessage,
  modelSelection: ModelSelection,
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
  appContext: Schema.optionalKey(
    Schema.Array(Schema.Struct({ key: Schema.String, text: Schema.String })),
  ),
});
const encodeTurnInput = Schema.encodeSync(Schema.toCodecJson(JournalTurnInput));
const decodeTurnInputSchema = Schema.decodeUnknownSync(Schema.toCodecJson(JournalTurnInput));
/** Typed as the adapter interface, so the schema has to stay a faithful copy of it. */
const decodeTurnInput = (value: unknown): ProviderAdapter.ProviderAdapterV2TurnInput =>
  decodeTurnInputSchema(value);
const encodeProviderThread = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ProviderThread));
const decodeProviderThread = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ProviderThread),
);
const encodeProviderSession = Schema.encodeSync(Schema.toCodecJson(OrchestrationV2ProviderSession));
const decodeProviderSession = Schema.decodeUnknownSync(
  Schema.toCodecJson(OrchestrationV2ProviderSession),
);
const JournalEvents = Schema.Array(ProviderAdapter.ProviderAdapterV2Event);
const encodeEvents = Schema.encodeSync(Schema.toCodecJson(JournalEvents));
const decodeEvents = Schema.decodeUnknownSync(Schema.toCodecJson(JournalEvents));

const millis = (now: DateTime.Utc) => DateTime.toEpochMillis(now);
const utc = (at: number) => DateTime.makeUnsafe(at);

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

/**
 * What the journal keeps of a frame: exactly the fields the mapping reads. Streaming updates
 * carry the whole partial message on every delta, and run boundaries every message of the run;
 * both shrink to what is read. Any other frame, including types this build does not know, is
 * kept as it came.
 */
export function ompJournalFrame(frame: { readonly type: string }): OmpJournalFrame {
  const f = frame as Record<string, unknown>;
  switch (frame.type) {
    case "message_update": {
      const event = asRecord(f["assistantMessageEvent"]);
      if (event === undefined) return { type: frame.type };
      const type = event["type"];
      const contentIndex = event["contentIndex"];
      if (
        (type === "text_delta" ||
          type === "thinking_delta" ||
          type === "text_end" ||
          type === "thinking_end") &&
        typeof contentIndex === "number"
      ) {
        const content = asRecord(event["partial"])?.["content"];
        const block = Array.isArray(content) ? asRecord(content[contentIndex]) : undefined;
        const kept: Array<unknown> = Array.from({ length: contentIndex }, () => null);
        if (block !== undefined) {
          kept.push({
            type: block["type"],
            ...(block["narration"] === true ? { narration: true } : {}),
          });
        }
        const text =
          type === "text_delta" || type === "thinking_delta"
            ? { delta: event["delta"] }
            : { content: event["content"] };
        return {
          type: frame.type,
          assistantMessageEvent: { type, contentIndex, ...text, partial: { content: kept } },
        };
      }
      return { type: frame.type, assistantMessageEvent: { type } };
    }
    case "message_start": {
      const role = asRecord(f["message"])?.["role"];
      return {
        type: frame.type,
        ...(typeof f["messageId"] === "string" ? { messageId: f["messageId"] } : {}),
        message: { role },
      };
    }
    case "agent_start":
    case "turn_start":
    case "turn_end":
      return { type: frame.type };
    case "agent_end": {
      const last = lastAssistant(f["messages"]);
      return {
        type: frame.type,
        ...(typeof f["yielded"] === "boolean" ? { yielded: f["yielded"] } : {}),
        ...(typeof f["isTerminal"] === "boolean" ? { isTerminal: f["isTerminal"] } : {}),
        messages:
          last === undefined
            ? []
            : [
                {
                  role: "assistant",
                  stopReason: last["stopReason"],
                  ...(typeof last["errorMessage"] === "string"
                    ? { errorMessage: last["errorMessage"] }
                    : {}),
                },
              ],
      };
    }
    default:
      return frame as OmpJournalFrame;
  }
}

const lastAssistant = (messages: unknown) => {
  if (!Array.isArray(messages)) return undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = asRecord(messages[index]);
    if (message?.["role"] === "assistant") return message;
  }
  return undefined;
};

/** `agent_end` of a run that yielded; older sessions omit `yielded`, their terminal ends yielded. */
export const isOmpRunYield = (frame: { readonly type: string }): boolean => {
  if (frame.type !== "agent_end") return false;
  const f = frame as Record<string, unknown>;
  return typeof f["yielded"] === "boolean" ? f["yielded"] : f["isTerminal"] !== false;
};

/** How a run OMP started on its own ended, read like OMP's `prompt_result` (its last message). */
export function ompRunOutcome(agentEnd: { readonly type: string }): OmpTurnOutcome {
  const last = lastAssistant((agentEnd as Record<string, unknown>)["messages"]);
  if (last?.["stopReason"] === "aborted") return { status: "interrupted" };
  if (last?.["stopReason"] === "error") {
    return {
      status: "failed",
      failure: makeProviderFailure({
        message:
          typeof last["errorMessage"] === "string"
            ? last["errorMessage"]
            : "OMP reported an error.",
        class: "provider_error",
      }),
    };
  }
  return { status: "completed" };
}

/**
 * A run OMP started while no turn was attached (a background job's result woke the session
 * after `prompt_result` said `sessionSettled: false`). Its frames wait here, from its
 * `agent_start` on, until a turn takes them.
 */
export class OmpDetachedRun {
  #frames: Array<{ readonly type: string }> = [];
  #previousProcess = false;

  get pending(): boolean {
    return this.#frames.length > 0;
  }

  /** Whether `frame` belongs to the detached run: its `agent_start` or anything after it. */
  accepts(frame: { readonly type: string }): boolean {
    return this.#frames.length > 0 || frame.type === "agent_start";
  }

  push(frame: { readonly type: string }): void {
    // A run this process started can go on, whatever an earlier process left behind.
    if (frame.type === "agent_start") this.#previousProcess = false;
    this.#frames.push(frame);
  }

  /** Carries a previous process's unclaimed run into this one. */
  adopt(frames: ReadonlyArray<{ readonly type: string }>): void {
    for (const frame of frames) this.push(frame);
    this.#previousProcess = frames.length > 0;
  }

  /**
   * Hands the frames to a turn. `fromPreviousProcess`: the process that ran them has exited, so
   * a run they leave open can never yield.
   */
  take(): {
    readonly frames: ReadonlyArray<{ readonly type: string }>;
    readonly fromPreviousProcess: boolean;
  } {
    const taken = { frames: this.#frames, fromPreviousProcess: this.#previousProcess };
    this.#frames = [];
    this.#previousProcess = false;
    return taken;
  }
}

/**
 * Records entries for the state objects below. Only the outermost call is recorded: the mapper
 * calls its own public methods (a turn start sets the session status), and replaying the outer
 * call repeats the inner one.
 */
export class OmpJournalRecorder {
  #depth = 0;
  readonly #sink: (entry: OmpJournalEntry) => void;

  constructor(sink: (entry: OmpJournalEntry) => void) {
    this.#sink = sink;
  }

  record(entry: OmpJournalEntry): void {
    if (this.#depth === 0) this.#sink(entry);
  }

  run<A>(entry: () => OmpJournalEntry, apply: () => A): A {
    if (this.#depth === 0) this.#sink(entry());
    this.#depth += 1;
    try {
      return apply();
    } finally {
      this.#depth -= 1;
    }
  }
}

/** `OmpThreadMapper` that journals every input before applying it. */
export class OmpJournaledMapper extends OmpThreadMapper {
  readonly #recorder: OmpJournalRecorder;

  constructor(options: OmpThreadMapperOptions, recorder: OmpJournalRecorder) {
    super(options);
    this.#recorder = recorder;
  }

  override requestPlacement(nativeItemId: string, fallbackThreadId: ThreadId): OmpRequestPlacement {
    return this.#recorder.run(
      () => ({ k: "place", nativeItemId, fallbackThreadId }),
      () => super.requestPlacement(nativeItemId, fallbackThreadId),
    );
  }

  override setSessionStatus(
    status: OrchestrationV2ProviderSession["status"],
    lastError: string | null,
    now: DateTime.Utc,
  ): Array<Event> {
    return this.#recorder.run(
      () => ({ k: "status", at: millis(now), status, lastError }),
      () => super.setSessionStatus(status, lastError, now),
    );
  }

  override setRestartRequired(keys: ReadonlyArray<string>, now: DateTime.Utc): Array<Event> {
    return this.#recorder.run(
      () => ({ k: "restart", at: millis(now), keys }),
      () => super.setRestartRequired(keys, now),
    );
  }

  override adoptSession(sessionId: string, now: DateTime.Utc): Array<Event> {
    return this.#recorder.run(
      () => ({ k: "adopt", at: millis(now), sessionId }),
      () => super.adoptSession(sessionId, now),
    );
  }

  override bindThread(
    input: Parameters<OmpThreadMapper["bindThread"]>[0],
    now: DateTime.Utc,
  ): { readonly providerThread: OrchestrationV2ProviderThread; readonly events: Array<Event> } {
    return this.#recorder.run(
      () => ({
        k: "bind",
        at: millis(now),
        threadId: input.threadId,
        state: input.state,
        ...(input.existing === undefined ? {} : { existing: encodeProviderThread(input.existing) }),
      }),
      () => super.bindThread(input, now),
    );
  }

  override startTurn(
    input: ProviderAdapter.ProviderAdapterV2TurnInput,
    now: DateTime.Utc,
  ): Array<Event> {
    return this.#recorder.run(
      () => ({ k: "turn", at: millis(now), input: encodeTurnInput(input) }),
      () => super.startTurn(input, now),
    );
  }

  override handleFrame(frame: { readonly type: string }, now: DateTime.Utc): OmpFrameResult {
    return this.#recorder.run(
      () => ({ k: "frame", at: millis(now), frame: ompJournalFrame(frame) }),
      () => super.handleFrame(frame, now),
    );
  }

  override flushStreaming(now: DateTime.Utc): Array<Event> {
    return this.#recorder.run(
      () => ({ k: "flush", at: millis(now) }),
      () => super.flushStreaming(now),
    );
  }

  override finalizeTurn(
    outcome: OmpTurnOutcome,
    refresh: OmpTurnRefresh,
    now: DateTime.Utc,
  ): Array<Event> {
    return this.#recorder.run(
      () => ({ k: "finalize", at: millis(now), outcome, refresh }),
      () => super.finalizeTurn(outcome, refresh, now),
    );
  }
}

/** `OmpSubagentTracker` that journals the frames it consumes. */
export class OmpJournaledSubagents extends OmpSubagentTracker {
  readonly #recorder: OmpJournalRecorder;

  constructor(options: OmpSubagentTrackerOptions, recorder: OmpJournalRecorder) {
    super(options);
    this.#recorder = recorder;
  }

  override handleFrame(
    frame: { readonly type: string; readonly payload?: unknown },
    scope: OmpSubagentScope | null,
    now: DateTime.Utc,
  ): Array<Event> {
    return this.#recorder.run(
      () => ({ k: "subagent", at: millis(now), frame: frame as OmpJournalFrame }),
      () => super.handleFrame(frame, scope, now),
    );
  }
}

/** `OmpUiRequests` that journals every card it opens or settles. */
export class OmpJournaledUiRequests extends OmpUiRequests {
  readonly #recorder: OmpJournalRecorder;

  constructor(
    options: ConstructorParameters<typeof OmpUiRequests>[0],
    recorder: OmpJournalRecorder,
  ) {
    super(options);
    this.#recorder = recorder;
  }

  override open(
    frame: OmpDialogRequest,
    placement: OmpRequestPlacement,
    now: DateTime.Utc,
  ): OmpDialogOpened | null {
    return this.#recorder.run(
      () => ({
        k: "dialog",
        at: millis(now),
        frame: frame as unknown as OmpJournalFrame,
        placement,
      }),
      () => super.open(frame, placement, now),
    );
  }

  override resolve(requestId: RuntimeRequestId, now: DateTime.Utc): ReadonlyArray<Event> {
    return this.#recorder.run(
      () => ({ k: "resolve", at: millis(now), requestId }),
      () => super.resolve(requestId, now),
    );
  }

  override expire(
    nativeId: string,
    now: DateTime.Utc,
  ): { readonly reply: OmpDialogAnswer["reply"]; readonly events: ReadonlyArray<Event> } | null {
    return this.#recorder.run(
      () => ({ k: "expire", at: millis(now), nativeId }),
      () => super.expire(nativeId, now),
    );
  }

  override close(targetId: string, now: DateTime.Utc): ReadonlyArray<Event> {
    return this.#recorder.run(
      () => ({ k: "close", at: millis(now), targetId }),
      () => super.close(targetId, now),
    );
  }

  override closeAll(now: DateTime.Utc): ReadonlyArray<Event> {
    return this.#recorder.run(
      () => ({ k: "closeAll", at: millis(now) }),
      () => super.closeAll(now),
    );
  }
}

/** The first line of a process's segment: who wrote it, for a replay to rebuild the same state. */
export const ompJournalOpenEntry = (input: {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly contractVersion: string;
  readonly providerSession: OrchestrationV2ProviderSession;
  readonly now: DateTime.Utc;
}): OmpJournalEntry => ({
  k: "open",
  at: millis(input.now),
  v: OMP_JOURNAL_VERSION,
  threadId: input.threadId,
  instanceId: input.instanceId,
  contractVersion: input.contractVersion,
  providerSession: encodeProviderSession(input.providerSession),
});

/** Events emitted outside the state objects, recorded as they were. */
export const ompJournalEventsEntry = (events: ReadonlyArray<Event>): OmpJournalEntry => ({
  k: "events",
  events: encodeEvents(events),
});

export const ompJournalDetachedEntry = (
  frame: { readonly type: string },
  now: DateTime.Utc,
): OmpJournalEntry => ({ k: "detached", at: millis(now), frame: ompJournalFrame(frame) });

export interface OmpJournalParse {
  readonly entries: ReadonlyArray<OmpJournalEntry>;
  /** Lines that are not JSON or not a known entry (a torn last line, a newer build's kinds). */
  readonly skipped: number;
}

/** The entries in a journal's text; anything unreadable is skipped, never fatal. */
export function parseOmpJournal(text: string): OmpJournalParse {
  const entries: Array<OmpJournalEntry> = [];
  let skipped = 0;
  let start = 0;
  while (start < text.length) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    if (end > start) {
      try {
        const value = JSON.parse(text.slice(start, end)) as unknown;
        const kind = asRecord(value)?.["k"];
        if (typeof kind === "string" && Object.hasOwn(ENTRY_KINDS, kind)) {
          entries.push(value as OmpJournalEntry);
        } else {
          skipped += 1;
        }
      } catch {
        skipped += 1;
      }
    }
    start = end + 1;
  }
  return { entries, skipped };
}

/** The entries of the last process segment (from its `open`); the whole list when there is none. */
export function lastOmpJournalSegment(
  entries: ReadonlyArray<OmpJournalEntry>,
): ReadonlyArray<OmpJournalEntry> {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    if (entries[index]!.k === "open") return entries.slice(index);
  }
  return [];
}

/**
 * The frames of the run still waiting for a turn at the end of `segment`: the `detached`
 * entries after its last turn start. A turn takes the waiting run, and the adapter records the
 * taken frames again as that turn's `frame` entries.
 */
export function ompJournalDetachedTail(
  segment: ReadonlyArray<OmpJournalEntry>,
): ReadonlyArray<OmpJournalFrame> {
  const frames: Array<OmpJournalFrame> = [];
  for (let index = segment.length - 1; index >= 0; index -= 1) {
    const entry = segment[index]!;
    if (entry.k === "turn" || entry.k === "open") break;
    if (entry.k === "detached") frames.push(entry.frame);
  }
  return frames.toReversed();
}

export interface OmpJournalReplay {
  /** The events the recorded sessions emitted, in order. */
  readonly events: ReadonlyArray<Event>;
  /** Process segments replayed. */
  readonly segments: number;
  /** Entries that could not be applied (undecodable, or out of order for the state). */
  readonly skipped: number;
}

interface ReplayState {
  readonly mapper: OmpThreadMapper;
  readonly subagents: OmpSubagentTracker;
  readonly uiRequests: OmpUiRequests;
}

/**
 * Replays journal entries through fresh state objects, one set per process segment, exactly as
 * the live adapter applied them. Entries before the first `open`, and entries the state cannot
 * apply, are skipped.
 */
export function replayOmpJournal(entries: Iterable<OmpJournalEntry>): OmpJournalReplay {
  const events: Array<Event> = [];
  let state: ReplayState | null = null;
  let segments = 0;
  let skipped = 0;
  const push = (list: ReadonlyArray<Event>) => {
    for (const event of list) events.push(event);
  };
  for (const entry of entries) {
    try {
      if (entry.k === "open") {
        const providerSession = decodeProviderSession(entry.providerSession);
        const instanceId = ProviderInstanceId.make(entry.instanceId);
        state = {
          mapper: new OmpThreadMapper({ instanceId, providerSession }),
          subagents: new OmpSubagentTracker({
            instanceId,
            controls: ompSubagentControls(entry.contractVersion),
          }),
          uiRequests: new OmpUiRequests({ providerSessionId: providerSession.id }),
        };
        segments += 1;
        continue;
      }
      if (state === null) {
        skipped += 1;
        continue;
      }
      const { mapper, subagents, uiRequests } = state;
      switch (entry.k) {
        case "frame":
          push(mapper.handleFrame(entry.frame, utc(entry.at)).events);
          break;
        case "subagent":
          push(subagents.handleFrame(entry.frame, mapper.subagentScope, utc(entry.at)));
          break;
        case "detached":
          // Not mapped yet: the turn that takes the run records its frames again.
          break;
        case "bind":
          push(
            mapper.bindThread(
              {
                threadId: ThreadId.make(entry.threadId),
                state: entry.state,
                ...(entry.existing === undefined
                  ? {}
                  : { existing: decodeProviderThread(entry.existing) }),
              },
              utc(entry.at),
            ).events,
          );
          break;
        case "turn":
          push(mapper.startTurn(decodeTurnInput(entry.input), utc(entry.at)));
          break;
        case "flush":
          push(mapper.flushStreaming(utc(entry.at)));
          break;
        case "finalize":
          push(mapper.finalizeTurn(entry.outcome, entry.refresh, utc(entry.at)));
          break;
        case "adopt":
          push(mapper.adoptSession(entry.sessionId, utc(entry.at)));
          break;
        case "status":
          push(mapper.setSessionStatus(entry.status, entry.lastError, utc(entry.at)));
          break;
        case "restart":
          push(mapper.setRestartRequired(entry.keys, utc(entry.at)));
          break;
        case "place":
          mapper.requestPlacement(entry.nativeItemId, ThreadId.make(entry.fallbackThreadId));
          break;
        case "dialog": {
          const opened = uiRequests.open(
            entry.frame as unknown as OmpDialogRequest,
            entry.placement,
            utc(entry.at),
          );
          if (opened !== null) push(opened.events);
          break;
        }
        case "resolve":
          push(uiRequests.resolve(RuntimeRequestId.make(entry.requestId), utc(entry.at)));
          break;
        case "expire": {
          const expired = uiRequests.expire(entry.nativeId, utc(entry.at));
          if (expired !== null) push(expired.events);
          break;
        }
        case "close":
          push(uiRequests.close(entry.targetId, utc(entry.at)));
          break;
        case "closeAll":
          push(uiRequests.closeAll(utc(entry.at)));
          break;
        case "events":
          push(decodeEvents(entry.events));
          break;
      }
    } catch {
      skipped += 1;
    }
  }
  return { events, segments, skipped };
}

/** `<threads dir>/<thread id>/journal.ndjson`. */
export const ompJournalPath = (path: Path.Path, threadsDir: string, threadId: string): string =>
  path.join(threadsDir, encodeURIComponent(threadId), OMP_JOURNAL_FILE);

/** The thread's journal; empty when it has none or it cannot be read. */
export const readOmpJournal = Effect.fn("readOmpJournal")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(file).pipe(Effect.orElseSucceed(() => ""));
  return parseOmpJournal(text);
});

export interface OmpJournalWriter {
  /** Queues one entry; lines reach the file in order, in batches. */
  readonly record: (entry: OmpJournalEntry) => void;
  /** Writes what is queued. Also runs every 100 ms and when the scope closes. */
  readonly flush: Effect.Effect<void>;
}

/**
 * Appends to the thread's journal for the life of the scope. A journal over the rotation size
 * moves to `journal.1.ndjson` first (replacing the one before), so every file starts at a
 * process segment. Write failures are logged and never fail the session: the journal is a
 * record, the session goes on without it.
 */
export const makeOmpJournalWriter = Effect.fn("makeOmpJournalWriter")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ready = yield* fileSystem
    .makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 })
    .pipe(
      Effect.andThen(
        fileSystem.stat(file).pipe(
          Effect.flatMap((info) =>
            Number(info.size) > OMP_JOURNAL_ROTATE_BYTES
              ? fileSystem.rename(file, path.join(path.dirname(file), OMP_JOURNAL_PREVIOUS_FILE))
              : Effect.void,
          ),
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.void : Effect.fail(error),
          }),
        ),
      ),
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("omp journal unavailable", { detail: error.message }).pipe(
          Effect.as(false),
        ),
      ),
    );
  let queued: Array<string> = [];
  const permit = yield* Semaphore.make(1);
  const flush = permit
    .withPermits(1)(
      Effect.suspend(() => {
        if (!ready || queued.length === 0) return Effect.void;
        const text = queued.join("");
        queued = [];
        return fileSystem
          .writeFileString(file, text, { flag: "a", mode: 0o600 })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("omp journal write failed", { detail: error.message }),
            ),
          );
      }),
    )
    .pipe(Effect.uninterruptible);
  // Added before the periodic writer, so it runs after that writer stops: the last lines land.
  yield* Effect.addFinalizer(() => flush);
  yield* Effect.sleep(OMP_JOURNAL_FLUSH_MS).pipe(
    Effect.andThen(flush),
    Effect.forever,
    Effect.forkScoped,
  );
  return {
    record: (entry: OmpJournalEntry) => {
      if (ready) queued.push(`${JSON.stringify(entry)}\n`);
    },
    flush,
  } satisfies OmpJournalWriter;
});
