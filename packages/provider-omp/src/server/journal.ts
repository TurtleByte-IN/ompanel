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
import { ompProposalsResolvable } from "./proposals.ts";
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
/** A journal this large moves to `journal.1.ndjson`, while a process writes it or at open. */
const OMP_JOURNAL_ROTATE_BYTES = 32 * 1024 * 1024;
/** Lines are written in batches; a crash loses at most this much of the tail. */
const OMP_JOURNAL_FLUSH_MS = 100;
/**
 * A running tool's updates carry all its output so far (bash polls every 250 ms). The journal
 * keeps one per tool call this often, and always the last one before the call ends.
 */
const OMP_JOURNAL_TOOL_UPDATE_MS = 5_000;
/** The frames that change the mapper's state when no turn is active; the rest are not written then. */
const OUT_OF_TURN_FRAMES: Record<string, true> = { session_info_update: true, queue_update: true };

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
  /** A Stop began, ended (`restored`: what OMP withdrew, null if it failed), a steer was sent or lost. */
  | { readonly k: "stop" }
  | {
      readonly k: "stopped";
      readonly at: number;
      readonly restored: {
        readonly steering: ReadonlyArray<string>;
        readonly followUp: ReadonlyArray<string>;
      } | null;
    }
  | { readonly k: "steer" }
  | { readonly k: "steerLost" }
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
  /** The user resolved a staged proposal (`resolve_proposal`), or the session dropped them all. */
  | {
      readonly k: "proposal";
      readonly at: number;
      readonly toolCallId: string;
      readonly state: "applied" | "discarded";
    }
  | { readonly k: "settleProposals"; readonly at: number }
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
  stop: true,
  stopped: true,
  steer: true,
  steerLost: true,
  place: true,
  dialog: true,
  resolve: true,
  expire: true,
  close: true,
  closeAll: true,
  proposal: true,
  settleProposals: true,
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
    case "message_end": {
      const message = asRecord(f["message"]);
      const role = message?.["role"];
      // Advisor notes are read whole; of any other message only its usage and role.
      if (role === "custom" && message?.["customType"] === "advisor")
        return frame as OmpJournalFrame;
      return {
        type: frame.type,
        message:
          role === "assistant"
            ? { role, usage: message?.["usage"] }
            : { role, customType: message?.["customType"] },
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
  /** Where each running tool's latest update sits: a newer one replaces it. */
  readonly #updates = new Map<string, number>();
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
    const toolCallId = ompToolCallId(frame);
    if (toolCallId !== undefined && frame.type === "tool_execution_update") {
      // Updates are cumulative: a parked job's would otherwise pile up for as long as it runs.
      const index = this.#updates.get(toolCallId);
      if (index !== undefined) {
        this.#frames[index] = frame;
        return;
      }
      this.#updates.set(toolCallId, this.#frames.length);
    } else if (toolCallId !== undefined && frame.type === "tool_execution_end") {
      this.#updates.delete(toolCallId);
    }
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
    this.#updates.clear();
    this.#previousProcess = false;
    return taken;
  }
}

const ompToolCallId = (frame: { readonly type: string }): string | undefined => {
  const id = (frame as Record<string, unknown>)["toolCallId"];
  return typeof id === "string" && id.length > 0 ? id : undefined;
};

/**
 * Thins the journal lines of running tools: one update per tool call every 5 s, the latest held
 * back until then, and the held one written right before the call's end (or the turn's). A
 * replay then misses only superseded snapshots; each tool card ends as it did live.
 */
export class OmpToolUpdateCoalescer {
  readonly #calls = new Map<string, { lastAt: number; held: OmpJournalEntry | undefined }>();

  /** The lines to write now for `entry`, the line of `frame` at `at`. */
  admit(
    frame: { readonly type: string },
    entry: OmpJournalEntry,
    at: number,
  ): ReadonlyArray<OmpJournalEntry> {
    const toolCallId = ompToolCallId(frame);
    if (toolCallId === undefined) return [entry];
    const call = this.#calls.get(toolCallId);
    switch (frame.type) {
      case "tool_execution_start":
        this.#calls.set(toolCallId, { lastAt: at, held: undefined });
        return [entry];
      case "tool_execution_update":
        if (call !== undefined && at - call.lastAt < OMP_JOURNAL_TOOL_UPDATE_MS) {
          call.held = entry;
          return [];
        }
        this.#calls.set(toolCallId, { lastAt: at, held: undefined });
        return [entry];
      case "tool_execution_end":
        this.#calls.delete(toolCallId);
        return call?.held === undefined ? [entry] : [call.held, entry];
      default:
        return [entry];
    }
  }

  /** The held updates, in call order; nothing is held afterwards. */
  drain(): ReadonlyArray<OmpJournalEntry> {
    const held = [...this.#calls.values()].flatMap((call) =>
      call.held === undefined ? [] : [call.held],
    );
    this.#calls.clear();
    return held;
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
    return this.quiet(apply);
  }

  /** Applies without recording anything, for inputs already recorded or not worth a line. */
  quiet<A>(apply: () => A): A {
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
  readonly #toolUpdates = new OmpToolUpdateCoalescer();

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

  override beginStop(): void {
    this.#recorder.run(
      () => ({ k: "stop" }),
      () => super.beginStop(),
    );
  }

  override endStop(
    restored: Parameters<OmpThreadMapper["endStop"]>[0],
    now: DateTime.Utc,
  ): Array<Event> {
    return this.#recorder.run(
      () => ({ k: "stopped", at: millis(now), restored }),
      () => super.endStop(restored, now),
    );
  }

  override steerSent(): void {
    this.#recorder.run(
      () => ({ k: "steer" }),
      () => super.steerSent(),
    );
  }

  override steerLost(): OmpTurnOutcome | null {
    return this.#recorder.run(
      () => ({ k: "steerLost" }),
      () => super.steerLost(),
    );
  }

  override adoptSession(sessionId: string, now: DateTime.Utc): Array<Event> {
    return this.#recorder.run(
      () => ({ k: "adopt", at: millis(now), sessionId }),
      () => super.adoptSession(sessionId, now),
    );
  }
  override resolveProposal(
    toolCallId: string,
    state: "applied" | "discarded",
    now: DateTime.Utc,
  ): Array<Event> {
    return this.#recorder.run(
      () => ({ k: "proposal", at: millis(now), toolCallId, state }),
      () => super.resolveProposal(toolCallId, state, now),
    );
  }

  override settleProposals(now: DateTime.Utc): Array<Event> {
    return this.#recorder.run(
      () => ({ k: "settleProposals", at: millis(now) }),
      () => super.settleProposals(now),
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
    // Outside a turn only the session id/title and OMP's queue change; every other frame maps
    // to nothing (a parked background job's tool updates keep coming for hours).
    if (!this.hasActiveTurn && !Object.hasOwn(OUT_OF_TURN_FRAMES, frame.type)) {
      return this.#recorder.quiet(() => super.handleFrame(frame, now));
    }
    const at = millis(now);
    const entry: OmpJournalEntry = { k: "frame", at, frame: ompJournalFrame(frame) };
    for (const line of this.#toolUpdates.admit(frame, entry, at)) this.#recorder.record(line);
    return this.#recorder.quiet(() => super.handleFrame(frame, now));
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
    // Each tool card ends with the last update the turn saw.
    for (const line of this.#toolUpdates.drain()) this.#recorder.record(line);
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
          mapper: new OmpThreadMapper({
            instanceId,
            providerSession,
            proposalsResolvable: ompProposalsResolvable(entry.contractVersion),
          }),
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
        case "stop":
          mapper.beginStop();
          break;
        case "stopped":
          push(mapper.endStop(entry.restored, utc(entry.at)));
          break;
        case "steer":
          mapper.steerSent();
          break;
        case "steerLost":
          mapper.steerLost();
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
        case "proposal":
          push(mapper.resolveProposal(entry.toolCallId, entry.state, utc(entry.at)));
          break;
        case "settleProposals":
          push(mapper.settleProposals(utc(entry.at)));
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

/** How a segment's first line starts (`k` is the first key `JSON.stringify` writes). */
const OPEN_LINE = new TextEncoder().encode('{"k":"open"');
const TAIL_CHUNK_BYTES = 1024 * 1024;

/** Whether the bytes at `index` start an `open` line: at the start, or right after a newline. */
const opensSegment = (bytes: Uint8Array, index: number): boolean => {
  if (index > 0 && bytes[index - 1] !== 0x0a) return false;
  for (let offset = 0; offset < OPEN_LINE.length; offset += 1) {
    if (bytes[index + offset] !== OPEN_LINE[offset]) return false;
  }
  return true;
};

/**
 * The entries of the journal's last process segment, read back from the end of the file in
 * 1 MiB chunks, never the whole file. Empty when there is no journal, no segment within twice
 * the rotation size, or the file cannot be read.
 */
export const readOmpJournalTail = Effect.fn("readOmpJournalTail")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const empty: OmpJournalParse = { entries: [], skipped: 0 };
  return yield* Effect.gen(function* () {
    const handle = yield* fileSystem.open(file, { flag: "r" });
    const size = Number((yield* handle.stat).size);
    const readAt = Effect.fnUntraced(function* (position: number, length: number) {
      const buffer = new Uint8Array(length);
      let filled = 0;
      while (filled < length) {
        const read = yield* handle.read(buffer.subarray(filled), {
          position: BigInt(position + filled),
        });
        if (read === 0) break;
        filled += read;
      }
      return buffer.subarray(0, filled);
    });
    let start = -1;
    let end = size;
    while (start === -1 && end > 0 && size - end < OMP_JOURNAL_ROTATE_BYTES * 2) {
      const from = Math.max(0, end - TAIL_CHUNK_BYTES);
      // The window runs a line start past `end`. A line at a window's index 0 needs the byte
      // before it, so the next window back, which ends there, checks it.
      const window = yield* readAt(from, Math.min(size, end + OPEN_LINE.length) - from);
      for (let index = end - from; index >= (from === 0 ? 0 : 1); index -= 1) {
        if (opensSegment(window, index)) {
          start = from + index;
          break;
        }
      }
      end = from;
    }
    if (start === -1) return empty;
    return parseOmpJournal(new TextDecoder().decode(yield* readAt(start, size - start)));
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => empty),
  );
});

export interface OmpJournalWriter {
  /** Queues one entry; lines reach the file in order, in batches. */
  readonly record: (entry: OmpJournalEntry) => void;
  /** Writes what is queued. Also runs every 100 ms and when the scope closes. */
  readonly flush: Effect.Effect<void>;
}

/**
 * Appends to the thread's journal for the scope's life. Past the rotation size (at open or while
 * writing) it moves to `journal.1.ndjson`; the new file starts with this process's `open` line.
 * A torn last line is ended first. Write failures are logged, never fail the session.
 */
export const makeOmpJournalWriter = Effect.fn("makeOmpJournalWriter")(function* (
  file: string,
  options: { readonly rotateBytes?: number } = {},
) {
  const rotateBytes = options.rotateBytes ?? OMP_JOURNAL_ROTATE_BYTES;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const previous = path.join(path.dirname(file), OMP_JOURNAL_PREVIOUS_FILE);
  const lastByte = (size: number) =>
    fileSystem.open(file, { flag: "r" }).pipe(
      Effect.flatMap((handle) => {
        const byte = new Uint8Array(1);
        return handle.read(byte, { position: BigInt(size - 1) }).pipe(Effect.as(byte[0]));
      }),
      Effect.scoped,
    );
  const opened = yield* fileSystem
    .makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 })
    .pipe(
      Effect.andThen(
        fileSystem.stat(file).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.catchTags({
            PlatformError: (error) =>
              error.reason._tag === "NotFound" ? Effect.succeed(0) : Effect.fail(error),
          }),
        ),
      ),
      Effect.flatMap((size) =>
        size > rotateBytes
          ? fileSystem.rename(file, previous).pipe(Effect.as({ size: 0, torn: false }))
          : size === 0
            ? Effect.succeed({ size, torn: false })
            : lastByte(size).pipe(Effect.map((byte) => ({ size, torn: byte !== 0x0a }))),
      ),
      Effect.map((state) => state as { readonly size: number; readonly torn: boolean } | null),
      Effect.catch((error) =>
        Effect.logWarning("omp journal unavailable", { detail: error.message }).pipe(
          Effect.as(null),
        ),
      ),
    );
  let bytes = opened?.size ?? 0;
  let prefix = opened?.torn === true ? "\n" : "";
  let openLine: string | undefined;
  let queued: Array<string> = [];
  const permit = yield* Semaphore.make(1);
  const flush = permit
    .withPermits(1)(
      Effect.gen(function* () {
        if (opened === null || queued.length === 0) return;
        let text = prefix + queued.join("");
        queued = [];
        prefix = "";
        if (bytes > 0 && bytes + text.length > rotateBytes) {
          yield* fileSystem.rename(file, previous);
          bytes = 0;
          text = text.startsWith("\n") ? text.slice(1) : text;
          if (openLine !== undefined && !text.startsWith(openLine)) text = openLine + text;
        }
        yield* fileSystem.writeFileString(file, text, { flag: "a", mode: 0o600 });
        bytes += text.length;
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("omp journal write failed", { detail: error.message }),
        ),
      ),
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
      if (opened === null) return;
      const line = `${JSON.stringify(entry)}\n`;
      if (entry.k === "open") openLine = line;
      queued.push(line);
    },
    flush,
  } satisfies OmpJournalWriter;
});
