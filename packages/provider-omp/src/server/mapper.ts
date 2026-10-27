/**
 * Maps the frames of one `omp --mode rpc-ui` session to V2 thread events. Pure state: every
 * method takes the current time and returns the events to emit, so the adapter owns I/O and
 * timers and tests drive it with frame literals.
 */
import {
  OMP_CARD_OUTPUT_KEY,
  PlanId,
  ProviderDriverKind,
  readOmpToolCard,
  type OrchestrationV2AppThread,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderExtensionStatus,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderTurnTokenUsage,
  type OrchestrationV2TurnItem,
  type ThreadId,
  type ThreadTokenUsageSnapshot,
  type ToolActivitySource,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";

import type {
  AssistantMessageEvent,
  ContextUsage,
  Goal,
  SessionState,
  SessionStats,
  TodoPhase,
  Usage,
} from "../../contract/src/wire.generated.ts";
import { ompProviderGoal, ompStateGoal } from "./goal.ts";
import {
  advisorNotice,
  cardOutput,
  conflictCard,
  fallbackNotice,
  ompCardFor,
  ttsrNotice,
} from "./ompCards.ts";
import type { OmpSubagentScope } from "./subagents.ts";
import type { OmpFrameDropReason } from "./telemetry.ts";
import { OMP_HOST_TERMINAL_TOOL } from "./hostTools.ts";
import { OmpAnsi } from "./ompAnsi.ts";

export const OMP_PROVIDER = ProviderDriverKind.make("omp");

type Event = ProviderAdapter.ProviderAdapterV2Event;
type TurnItemStatus = OrchestrationV2TurnItem["status"];
/** A turn item without the fields `#item` fills in for every item of the turn. */
type ItemBody = DistributiveOmit<OrchestrationV2TurnItem, ItemBaseKey>;
type ItemBaseKey =
  | "id"
  | "threadId"
  | "runId"
  | "nodeId"
  | "providerThreadId"
  | "providerTurnId"
  | "nativeItemRef"
  | "parentItemId"
  | "ordinal"
  | "status"
  | "startedAt"
  | "completedAt"
  | "updatedAt";
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** How a prompt ended, before the session is re-read for usage and todos. */
export type OmpTurnOutcome =
  | { readonly status: "completed" }
  | { readonly status: "interrupted" }
  | { readonly status: "failed"; readonly failure: OrchestrationV2ProviderFailure };

/** What OMP reported after the turn; either read may have failed. */
export interface OmpTurnRefresh {
  readonly state?: SessionState;
  readonly stats?: SessionStats;
  /**
   * The session entry of the user message the turn's prompt wrote, which rewind and fork cut at
   * (sessionBranches.ts); null when it wrote none, absent when it could not be read.
   */
  readonly turnEntryId?: string | null;
}

export interface OmpFrameResult {
  readonly events: ReadonlyArray<Event>;
  /** Text arrived that is only held; call `flushStreaming` soon. */
  readonly streaming: boolean;
  /** The prompt is over; refresh state and call `finalizeTurn`. */
  readonly settled: OmpTurnOutcome | null;
  /** A held turn may be over: ask OMP (`get_state` with its reply echoed) whether it is idle. */
  readonly confirmIdle: boolean;
  /** The frame reached nothing, and why (`t3_omp_frames_dropped_total`). */
  readonly dropped: OmpFrameDropReason | null;
}

/** Frames that only mean something inside a turn; outside one they are dropped. */
const TURN_SCOPED_FRAME_TYPES: Readonly<Record<string, true>> = {
  prompt_result: true,
  message_start: true,
  message_update: true,
  message_end: true,
  auto_compaction_start: true,
  manual_compaction_start: true,
  auto_compaction_end: true,
  manual_compaction_end: true,
  ttsr_triggered: true,
  retry_fallback_applied: true,
  tool_execution_start: true,
  tool_execution_update: true,
  tool_execution_end: true,
  notice: true,
  command_output: true,
};
/** `extension_ui_request` methods the mapper turns into cards on the active turn. */
const TURN_SCOPED_UI_METHODS: Readonly<Record<string, true>> = {
  notify: true,
  open_url: true,
  set_editor_text: true,
};

/** Where a runtime request OMP raised belongs: the active turn, or only the thread. */
export interface OmpRequestPlacement {
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2ExecutionNode["runId"];
  readonly rootNodeId: OrchestrationV2ExecutionNode["parentNodeId"];
  readonly providerThreadId: OrchestrationV2ExecutionNode["providerThreadId"];
  readonly providerTurnId: OrchestrationV2ExecutionNode["providerTurnId"];
  readonly ordinal: number;
}

interface StreamItem {
  readonly nativeItemId: string;
  readonly kind: "assistant_message" | "reasoning";
  readonly startedAt: DateTime.Utc;
  text: string;
  dirty: boolean;
  completed: boolean;
}

interface ToolCall {
  readonly toolName: string;
  readonly startedAt: DateTime.Utc;
  args: unknown;
  /** Command output already sent as `command_output.delta` while the command runs. */
  streamed?: string;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
  reported: boolean;
}

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  readonly renameRequested: boolean;
  readonly itemOrdinals: Map<string, number>;
  nextItemOrdinal: number;
  messageOrdinal: number;
  messageKey: string;
  readonly streamItems: Map<string, StreamItem>;
  readonly tools: Map<string, ToolCall>;
  readonly usage: UsageTotals;
  tokenUsage: OrchestrationV2ProviderTurnTokenUsage | undefined;
  promptId: string | null;
  noticeCount: number;
  /** The compaction card while OMP compacts, so its end updates the same item. */
  compaction: { readonly nativeItemId: string; readonly startedAt: DateTime.Utc } | null;
  /** After `agent_end`: the agent loop is done and only background work can wake it again. */
  agentEnded: boolean;
  /** The queue card while OMP holds messages for this turn, so each snapshot updates it. */
  queueCard: { readonly nativeItemId: string; readonly startedAt: DateTime.Utc } | null;
  /** A Stop is waiting for OMP's answer; queue snapshots no longer mean delivery. */
  stopping: boolean;
  /** Steers and follow-ups sent for this turn that OMP has not answered yet. */
  steersInFlight: number;
  /** The prompt's outcome, held while a message sent for the turn has not run (`prompt_result`). */
  heldOutcome: OmpTurnOutcome | null;
  /** The prompt is `/compact` or `/handoff`, which OMP finishes after acknowledging it. */
  readonly backgroundCommand: boolean;
  /** A `command_output` reached this turn. */
  commandOutputSeen: boolean;
  /** OMP acknowledged the background command; its closing `command_output` ends the turn. */
  awaitingCommandOutput: boolean;
}

/** OMP's displayable steering and follow-up queue (`queue_update`). */
export interface OmpQueueSnapshot {
  readonly steering: ReadonlyArray<string>;
  readonly followUp: ReadonlyArray<string>;
  /** Leading `steering` entries already sent into the streaming response. */
  readonly liveSteered: number;
}

const EMPTY_QUEUE: OmpQueueSnapshot = { steering: [], followUp: [], liveSteered: 0 };

/** The queue card's text: what OMP still holds, in the order it delivers it. */
const queueCardText = (queue: OmpQueueSnapshot): { summary: string; detail?: string } => {
  const pending = queue.steering.length + queue.followUp.length;
  if (pending === 0) return { summary: "OMP delivered every queued message" };
  const lines = [
    ...queue.steering.map(
      (message, index) =>
        `${index < queue.liveSteered ? "Steering (sent)" : "Steering"}: ${message}`,
    ),
    ...queue.followUp.map((message) => `Follow-up: ${message}`),
  ];
  return {
    summary: `${pending} message${pending === 1 ? "" : "s"} queued in OMP`,
    detail: lines.join("\n"),
  };
};

interface BoundThread {
  providerThread: OrchestrationV2ProviderThread;
  sessionId: string;
  todoPhases: ReadonlyArray<TodoPhase>;
}

const providerRef = (
  nativeId: string,
  strength: "strong" | "weak" = "strong",
): OrchestrationV2ProviderRef => ({ driver: OMP_PROVIDER, nativeId, strength });

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringField = (value: unknown, key: string): string | undefined => {
  const field = asRecord(value)?.[key];
  return typeof field === "string" ? field : undefined;
};

/** Caps on the status strip: OMP forwards whatever an extension asks it to show. */
const EXTENSION_STATUS_MAX_ENTRIES = 16;
const EXTENSION_STATUS_MAX_LINES = 10;
const EXTENSION_STATUS_MAX_LINE_LENGTH = 240;
const EXTENSION_STATUS_MAX_KEY_LENGTH = 80;

/** `setStatus` / `setWidget`: an extension's keyed status line or widget, set or cleared. */
export const isOmpExtensionStatusRequest = (frame: { readonly type: string }): boolean => {
  const method = (frame as Record<string, unknown>)["method"];
  return (
    frame.type === "extension_ui_request" && (method === "setStatus" || method === "setWidget")
  );
};

/**
 * Plain lines of status text OMP styled for its TUI: ANSI sequences and control characters
 * dropped, blank lines at either end trimmed, each line and the count capped.
 */
function extensionStatusLines(texts: ReadonlyArray<string>): Array<string> {
  const lines = texts
    .flatMap((text) => text.split(/\r?\n/))
    .map((line) =>
      OmpAnsi.strip(line)
        .replaceAll("\t", " ")
        // oxlint-disable-next-line no-control-regex -- strips control characters.
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
        .trimEnd()
        .slice(0, EXTENSION_STATUS_MAX_LINE_LENGTH),
    );
  const first = lines.findIndex((line) => line.trim().length > 0);
  if (first === -1) return [];
  const last = lines.findLastIndex((line) => line.trim().length > 0);
  return lines.slice(first, last + 1).slice(0, EXTENSION_STATUS_MAX_LINES);
}

/**
 * The status entries after `frame`: set or replaced by key and kind (keeping the order first
 * set), removed when the text or lines are absent or blank. `null` when `frame` is no
 * `setStatus` / `setWidget` request with a key.
 */
function ompExtensionStatus(
  current: ReadonlyArray<OrchestrationV2ProviderExtensionStatus>,
  frame: { readonly type: string },
): ReadonlyArray<OrchestrationV2ProviderExtensionStatus> | null {
  if (!isOmpExtensionStatusRequest(frame)) return null;
  const f = frame as Record<string, unknown>;
  const kind = f["method"] === "setStatus" ? "status" : "widget";
  const key = stringField(f, kind === "status" ? "statusKey" : "widgetKey")
    ?.trim()
    .slice(0, EXTENSION_STATUS_MAX_KEY_LENGTH);
  if (key === undefined || key.length === 0) return null;
  const widgetLines = f["widgetLines"];
  const lines = extensionStatusLines(
    kind === "status"
      ? [stringField(f, "statusText") ?? ""]
      : Array.isArray(widgetLines)
        ? widgetLines.filter((line): line is string => typeof line === "string")
        : [],
  );
  const index = current.findIndex((entry) => entry.key === key && entry.kind === kind);
  if (lines.length === 0) {
    return index === -1 ? current : current.filter((_, i) => i !== index);
  }
  const placement = kind === "widget" ? f["widgetPlacement"] : undefined;
  const entry: OrchestrationV2ProviderExtensionStatus = {
    key,
    kind,
    lines,
    ...(placement === "aboveEditor" || placement === "belowEditor" ? { placement } : {}),
  };
  if (index !== -1) return current.map((existing, i) => (i === index ? entry : existing));
  return current.length >= EXTENSION_STATUS_MAX_ENTRIES ? current : [...current, entry];
}

/** `metadata` without its extension status entries. */
function withoutExtensionStatus(
  metadata: OrchestrationV2ProviderThreadNativeMetadata | null,
): OrchestrationV2ProviderThreadNativeMetadata | null {
  if (metadata === null || metadata.extensionStatus === undefined) return metadata;
  const { extensionStatus: _cleared, ...rest } = metadata;
  return rest;
}

const count = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;

const optionalCount = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : undefined;

/** Text blocks of a tool result (`{content: [{type: "text", text}]}`). */
function resultText(result: unknown): string {
  const content = asRecord(result)?.["content"];
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      stringField(block, "type") === "text" ? (stringField(block, "text") ?? "") : "",
    )
    .filter((text) => text.length > 0)
    .join("\n");
}

const isCommandTool = (toolName: string): boolean =>
  toolName === "bash" || toolName === OMP_HOST_TERMINAL_TOOL;

/** A command's output as cards and the live output view show it: plain text, no escapes. */
const commandOutputText = (result: unknown): string => OmpAnsi.strip(resultText(result));

/** How much of what was already sent locates a scrolled output window. */
const STREAM_ANCHOR_CHARS = 256;

/**
 * The part of a running command's output not sent yet. OMP's updates carry a snapshot of its
 * output window, which grows and, past its budget, scrolls. A scrolled window is located by the
 * end of what was sent: wholly inside it, or starting partway through it. A window that shares
 * nothing with it is sent whole. The card's final output replaces the live view either way.
 */
export function streamedOutputChunk(sent: string, snapshot: string): string {
  if (snapshot.startsWith(sent)) return snapshot.slice(sent.length);
  const anchor = sent.slice(-STREAM_ANCHOR_CHARS);
  const at = snapshot.lastIndexOf(anchor);
  if (at !== -1) return snapshot.slice(at + anchor.length);
  for (let dropped = 1; dropped < anchor.length; dropped += 1) {
    if (snapshot.startsWith(anchor.slice(dropped))) {
      return snapshot.slice(anchor.length - dropped);
    }
  }
  return snapshot;
}

const URI_TARGET = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i;
/** `[PATH#TAG]` section headers of a hashline patch. */
const HASHLINE_HEADER = /^\[([^\]\n#]+)#[0-9a-f]{4}\]\s*$/im;
/** `*** Update File: PATH` headers of `apply_patch` input. */
const APPLY_PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/m;

/** Counts added and removed lines of OMP's `+12|text` diff (and of unified diffs). */
function diffLineCounts(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
  }
  return { additions, deletions };
}

/** Where a target names a URI (`xd://github`, `skill://x`), its scheme labels the card. */
const uriSource = (scheme: string): ToolActivitySource => ({
  key: `omp-uri:${scheme}`,
  name: `${scheme}://`,
  kind: "integration",
});

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The tool-call card for one OMP tool call, at any phase. */
function ompToolCard(input: {
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly isError: boolean;
}): ItemBody {
  const { toolName, args, result, isError } = input;
  const details = asRecord(result)?.["details"];
  const output = resultText(result);
  const path = stringField(args, "path");

  // The T3 terminal host tool stands in for `bash` (hostTools.ts) and reports the same details.
  // Without it OMP's own `bash` runs (the terminal fallback); either way running output streams
  // as `command_output.delta` (`#toolEvent`) and the card carries the final output.
  if (isCommandTool(toolName)) {
    const exitCode = asRecord(details)?.["exitCode"];
    const plain = commandOutputText(result);
    return {
      title: toolName,
      type: "command_execution",
      input: stringField(args, "command") ?? "",
      ...(plain.length > 0 ? { output: plain } : {}),
      ...(typeof exitCode === "number" && Number.isInteger(exitCode) ? { exitCode } : {}),
    };
  }

  const uri = path === undefined ? null : URI_TARGET.exec(path);
  if (uri !== null && uri[1] !== undefined) {
    const scheme = uri[1].toLowerCase();
    const target = uri[2] ?? "";
    // `write xd://<device>` runs the device; its arguments are the written JSON.
    if (scheme === "xd" && toolName === "write" && target.length > 0) {
      const device = target.split("/")[0] ?? target;
      const content = stringField(args, "content");
      const input = content === undefined ? {} : parseJson(content);
      // The device's own args and details ride in `details.xdev`; card them like the bare tool.
      const xdev = asRecord(asRecord(details)?.["xdev"]);
      const carded = ompCardFor({
        toolName: device,
        args: xdev?.["args"] ?? input,
        result: { content: asRecord(result)?.["content"], details: xdev?.["inner"] },
        isError,
      });
      return {
        title: `xd://${device}`,
        type: "dynamic_tool",
        toolName: `xd://${device}`,
        toolSource: uriSource(scheme),
        input,
        ...(carded !== null
          ? { output: cardOutput(carded.blocks, carded.card) }
          : output.length > 0
            ? { output }
            : {}),
      };
    }
    const conflict =
      scheme === "conflict" && toolName === "write" ? conflictCard(target, result, isError) : null;
    return {
      title: `${toolName} ${path}`.slice(0, 160),
      type: "dynamic_tool",
      toolName,
      toolSource: uriSource(scheme),
      input: args ?? {},
      ...(conflict !== null
        ? { output: cardOutput(conflict.blocks, conflict.card) }
        : output.length > 0
          ? { output }
          : {}),
    };
  }

  if (toolName === "edit") {
    const detailRecord = asRecord(details);
    const perFile = Array.isArray(detailRecord?.["perFileResults"])
      ? (detailRecord["perFileResults"] as ReadonlyArray<unknown>)
      : [];
    const editInput = stringField(args, "input") ?? "";
    const fileName =
      stringField(details, "path") ??
      stringField(perFile[0], "path") ??
      path ??
      HASHLINE_HEADER.exec(editInput)?.[1]?.trim() ??
      APPLY_PATCH_HEADER.exec(editInput)?.[1]?.trim();
    if (fileName !== undefined && fileName.length > 0) {
      const diff = stringField(details, "diff");
      const diffStr =
        diff !== undefined && diff.length > 0
          ? diff
          : isError && output.trim().length > 0
            ? output
            : undefined;
      const files = perFile.length > 0 ? perFile : details === undefined ? [] : [details];
      const changes = files.flatMap((file) => {
        const filePath = stringField(file, "path");
        if (filePath === undefined || filePath.trim().length === 0) return [];
        const sourcePath = stringField(file, "sourcePath");
        return [
          {
            operation: stringField(file, "op") ?? "update",
            path: filePath,
            ...(sourcePath === undefined ? {} : { oldPath: sourcePath }),
          },
        ];
      });
      const oldStr = perFile.length === 0 ? stringField(details, "oldText") : undefined;
      const newStr = perFile.length === 0 ? stringField(details, "newText") : undefined;
      return {
        title: toolName,
        type: "file_change",
        fileName,
        ...(diff === undefined || diff.length === 0 ? {} : diffLineCounts(diff)),
        ...(diffStr === undefined ? {} : { diffStr }),
        ...(oldStr === undefined ? {} : { oldStr }),
        ...(newStr === undefined ? {} : { newStr }),
        ...(changes.length === 0 ? {} : { changes }),
      };
    }
  }

  if (toolName === "write" && path !== undefined && path.length > 0) {
    const content = stringField(args, "content");
    return {
      title: toolName,
      type: "file_change",
      fileName: path,
      ...(content === undefined ? {} : { newStr: content }),
      ...(isError && output.trim().length > 0 ? { diffStr: output } : {}),
      changes: [{ operation: "write", path }],
    };
  }

  const carded = ompCardFor({ toolName, args, result, isError });
  return {
    title: toolName,
    type: "dynamic_tool",
    toolName,
    input: args ?? {},
    ...(carded !== null
      ? { output: cardOutput(carded.blocks, carded.card) }
      : output.length > 0
        ? { output }
        : {}),
  };
}

/** Todo phases as plan steps; phase names prefix tasks once there is more than one phase. */
export function ompTodoSteps(phases: ReadonlyArray<TodoPhase>): Array<OrchestrationV2PlanStep> {
  const steps: Array<OrchestrationV2PlanStep> = [];
  const named = phases.length > 1;
  phases.forEach((phase, phaseIndex) => {
    phase.tasks.forEach((task, taskIndex) => {
      const content = task.content.trim();
      if (content.length === 0) return;
      const suffix =
        task.status === "abandoned"
          ? " (abandoned)"
          : task.status === "blocked"
            ? task.blocker === undefined || task.blocker.trim().length === 0
              ? " (blocked)"
              : ` (blocked: ${task.blocker.trim()})`
            : "";
      steps.push({
        id: `${phaseIndex}:${taskIndex}`,
        text: `${named && phase.name.trim().length > 0 ? `${phase.name.trim()}: ` : ""}${content}${suffix}`,
        status:
          task.status === "in_progress"
            ? "running"
            : task.status === "completed" || task.status === "abandoned"
              ? "completed"
              : "pending",
      });
    });
  });
  return steps;
}

const isTodoPhases = (value: unknown): value is ReadonlyArray<TodoPhase> =>
  Array.isArray(value) &&
  value.every((phase) => {
    const tasks = asRecord(phase)?.["tasks"];
    return (
      typeof stringField(phase, "name") === "string" &&
      Array.isArray(tasks) &&
      tasks.every(
        (task) =>
          typeof stringField(task, "content") === "string" &&
          typeof stringField(task, "status") === "string",
      )
    );
  });

/** A `/rename` typed by the user is the only title OMP reports that may rename the thread. */
const RENAME_COMMAND = /^\/rename(?:\s|$)/;

/**
 * Builtins OMP's RPC mode runs after acknowledging the prompt (`runCommandInBackground`): the
 * ack says `agentInvoked: false`, then compaction frames and one closing `command_output`
 * follow, or nothing when a Stop interrupted it.
 */
const BACKGROUND_COMMAND = /^\/(?:compact|handoff)(?:[\s:]|$)/;

export interface OmpThreadMapperOptions {
  readonly instanceId: OrchestrationV2ProviderSession["providerInstanceId"];
  readonly providerSession: OrchestrationV2ProviderSession;
  /**
   * The sidecar takes `resolve_proposal` (contract 1.10.0): a staged `ast_edit` card offers
   * Accept and Reject and stays `waiting` until it is resolved, so its run keeps listening.
   */
  readonly proposalsResolvable?: boolean;
}

export class OmpThreadMapper {
  #session: OrchestrationV2ProviderSession;
  #thread: BoundThread | null = null;
  #turn: ActiveTurn | null = null;
  /** OMP's last queue snapshot; the queue belongs to the session and can outlive a turn. */
  #queue: OmpQueueSnapshot = EMPTY_QUEUE;
  readonly #instanceId: OmpThreadMapperOptions["instanceId"];
  readonly #proposalsResolvable: boolean;
  /**
   * Staged `ast_edit` cards by tool call, oldest first, as last emitted: OMP keeps a preview
   * across turns (and a Stop) until the agent or the user resolves it, or the session ends.
   */
  readonly #staged = new Map<string, OrchestrationV2TurnItem>();

  constructor(options: OmpThreadMapperOptions) {
    this.#instanceId = options.instanceId;
    this.#session = options.providerSession;
    this.#proposalsResolvable = options.proposalsResolvable === true;
  }

  /** Whether tool call `toolCallId` staged a proposal that is still pending here. */
  isProposalStaged(toolCallId: string): boolean {
    return this.#staged.has(toolCallId);
  }

  /**
   * The user resolved the proposal `toolCallId` staged (`resolve_proposal`), or the agent did:
   * its card shows the outcome and no longer offers Accept and Reject.
   */
  resolveProposal(
    toolCallId: string,
    state: "applied" | "discarded",
    now: DateTime.Utc,
  ): Array<Event> {
    const item = this.#staged.get(toolCallId);
    if (item === undefined) return [];
    this.#staged.delete(toolCallId);
    const output = item.type === "dynamic_tool" ? asRecord(item.output) : undefined;
    const card = readOmpToolCard(output);
    if (output === undefined || card?.kind !== "proposed_edit") return [];
    const { resolvable: _offered, ...settled } = card;
    return [
      {
        type: "turn_item.updated",
        driver: OMP_PROVIDER,
        turnItem: {
          ...item,
          status: "completed",
          updatedAt: now,
          completedAt: now,
          output: { ...output, [OMP_CARD_OUTPUT_KEY]: { ...settled, state } },
        } as OrchestrationV2TurnItem,
      },
    ];
  }

  /** The session ended (closed, replaced or crashed): OMP dropped every staged preview. */
  settleProposals(now: DateTime.Utc): Array<Event> {
    return [...this.#staged.keys()].flatMap((id) => this.resolveProposal(id, "discarded", now));
  }

  get providerSession(): OrchestrationV2ProviderSession {
    return this.#session;
  }

  get providerThread(): OrchestrationV2ProviderThread | null {
    return this.#thread?.providerThread ?? null;
  }

  get hasActiveTurn(): boolean {
    return this.#turn !== null;
  }

  /** The prompt request of the active turn, while one is being answered. */
  get activeProviderTurnId(): OrchestrationV2ProviderTurn["id"] | null {
    return this.#turn?.providerTurn.id ?? null;
  }

  /**
   * Whether the active turn's agent loop already ended: a steer can no longer land in it, so
   * a message for the turn is delivered as OMP's follow-up instead.
   */
  get agentEnded(): boolean {
    return this.#turn?.agentEnded === true;
  }

  /**
   * Where request `nativeItemId` goes: into the active turn, after the items before it, or onto
   * the thread alone when OMP asks between turns.
   */
  requestPlacement(nativeItemId: string, fallbackThreadId: ThreadId): OmpRequestPlacement {
    const turn = this.#turn;
    if (turn !== null) {
      return {
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        rootNodeId: turn.input.rootNodeId,
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        ordinal: this.#itemOrdinal(turn, nativeItemId),
      };
    }
    const thread = this.#thread?.providerThread ?? null;
    return {
      threadId: thread?.appThreadId ?? fallbackThreadId,
      runId: null,
      rootNodeId: null,
      providerThreadId: thread?.id ?? null,
      providerTurnId: null,
      ordinal: 0,
    };
  }

  /** Where subagent records hang (see `subagents.ts`): the bound thread and the active turn. */
  get subagentScope(): OmpSubagentScope | null {
    const thread = this.#thread;
    const threadId = thread?.providerThread.appThreadId;
    if (thread === null || threadId == null) return null;
    return {
      threadId,
      providerThreadId: thread.providerThread.id,
      runId: this.#turn?.input.runId ?? null,
      rootNodeId: this.#turn?.input.rootNodeId ?? null,
    };
  }

  setSessionStatus(
    status: OrchestrationV2ProviderSession["status"],
    lastError: string | null,
    now: DateTime.Utc,
  ): Array<Event> {
    this.#session = { ...this.#session, status, lastError, updatedAt: now };
    return [
      { type: "provider_session.updated", driver: OMP_PROVIDER, providerSession: this.#session },
    ];
  }

  /** Settings changed that the session reads only at startup; a restart applies them. */
  setRestartRequired(keys: ReadonlyArray<string>, now: DateTime.Utc): Array<Event> {
    this.#session = { ...this.#session, restartRequired: keys, updatedAt: now };
    return [
      { type: "provider_session.updated", driver: OMP_PROVIDER, providerSession: this.#session },
    ];
  }

  /** The bound thread now runs session `sessionId`: a rewind moved it onto a new session file. */
  adoptSession(sessionId: string, now: DateTime.Utc): Array<Event> {
    // OMP drops staged previews when it leaves a session (`branch`, `switch_session`).
    return [...this.settleProposals(now), ...this.#sessionInfo(sessionId, undefined, now)];
  }

  /** Binds the app thread to the live OMP session described by `get_state`. */
  bindThread(
    input: {
      readonly threadId: ThreadId;
      readonly state: SessionState;
      readonly existing?: OrchestrationV2ProviderThread;
    },
    now: DateTime.Utc,
  ): { readonly providerThread: OrchestrationV2ProviderThread; readonly events: Array<Event> } {
    const { state, existing } = input;
    const sessionTitle = state.sessionName?.trim();
    // A new OMP process starts with no extension status; whatever the last one showed is gone.
    const carried = withoutExtensionStatus(existing?.nativeMetadata ?? null);
    const nativeMetadata =
      sessionTitle === undefined || sessionTitle.length === 0
        ? carried
        : { ...carried, title: sessionTitle };
    const contextUsage = this.#contextSnapshot(state.contextUsage, undefined, existing);
    const providerThread: OrchestrationV2ProviderThread =
      existing !== undefined
        ? {
            ...existing,
            providerSessionId: this.#session.id,
            nativeThreadRef: providerRef(state.sessionId),
            nativeMetadata,
            ...(contextUsage === undefined ? {} : { contextUsage }),
            // A contract without `get_state.goal` leaves the recorded goal alone.
            ...(state.goal === undefined ? {} : { goal: ompStateGoal(state.goal, existing.goal) }),
            status: "idle",
            updatedAt: now,
          }
        : {
            id: IdAllocator.derive.providerThread({
              driver: OMP_PROVIDER,
              nativeThreadId: state.sessionId,
            }),
            driver: OMP_PROVIDER,
            providerInstanceId: this.#instanceId,
            providerSessionId: this.#session.id,
            appThreadId: input.threadId,
            ownerNodeId: null,
            nativeThreadRef: providerRef(state.sessionId),
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [],
            contextUsage: contextUsage ?? null,
            nativeMetadata,
            goal: ompProviderGoal(state.goal?.goal),
            createdAt: now,
            updatedAt: now,
          };
    this.#thread = {
      providerThread,
      sessionId: state.sessionId,
      todoPhases: state.todoPhases ?? [],
    };
    return {
      providerThread,
      events: [{ type: "provider_thread.updated", driver: OMP_PROVIDER, providerThread }],
    };
  }

  /** OMP's goal changed (`goal_updated`); the thread shows it whether or not a turn runs. */
  applyGoal(goal: Goal | null, now: DateTime.Utc): Array<Event> {
    const thread = this.#thread;
    if (thread === null) return [];
    const next = ompProviderGoal(goal);
    if (JSON.stringify(next) === JSON.stringify(thread.providerThread.goal ?? null)) return [];
    thread.providerThread = { ...thread.providerThread, goal: next, updatedAt: now };
    return [
      {
        type: "provider_thread.updated",
        driver: OMP_PROVIDER,
        providerThread: thread.providerThread,
      },
    ];
  }

  /**
   * An extension set or cleared a status line (`setStatus`) or widget (`setWidget`). Both are
   * session state, not turn output: the thread's status strip shows them whether or not a turn
   * runs. A frame that changes nothing emits nothing.
   */
  applyExtensionStatus(frame: { readonly type: string }, now: DateTime.Utc): Array<Event> {
    const thread = this.#thread;
    if (thread === null) return [];
    const metadata = thread.providerThread.nativeMetadata ?? null;
    const current = metadata?.extensionStatus ?? [];
    const next = ompExtensionStatus(current, frame);
    if (next === null || JSON.stringify(next) === JSON.stringify(current)) return [];
    const rest = withoutExtensionStatus(metadata) ?? {};
    thread.providerThread = {
      ...thread.providerThread,
      nativeMetadata: next.length > 0 ? { ...rest, extensionStatus: next } : rest,
      updatedAt: now,
    };
    return [
      {
        type: "provider_thread.updated",
        driver: OMP_PROVIDER,
        providerThread: thread.providerThread,
      },
    ];
  }

  startTurn(input: ProviderAdapter.ProviderAdapterV2TurnInput, now: DateTime.Utc): Array<Event> {
    const thread = this.#thread;
    if (thread === null) throw new Error("OMP turn started before a thread was bound");
    if (this.#turn !== null) throw new Error("OMP turn started while another is active");
    const nativeTurnId = `${thread.providerThread.id}:attempt:${input.attemptId}`;
    const providerTurn: OrchestrationV2ProviderTurn = {
      id: IdAllocator.derive.providerTurn({ driver: OMP_PROVIDER, nativeTurnId }),
      providerThreadId: input.providerThread.id,
      nodeId: input.rootNodeId,
      runAttemptId: input.attemptId,
      nativeTurnRef: providerRef(nativeTurnId, "weak"),
      ordinal: input.providerTurnOrdinal,
      status: "running",
      startedAt: now,
      completedAt: null,
    };
    this.#turn = {
      input,
      providerTurn,
      renameRequested: RENAME_COMMAND.test(input.message.text.trimStart()),
      itemOrdinals: new Map(),
      nextItemOrdinal: input.providerTurnOrdinal * 100 + 1,
      messageOrdinal: 0,
      messageKey: "m0",
      streamItems: new Map(),
      tools: new Map(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, reported: false },
      tokenUsage: undefined,
      promptId: null,
      noticeCount: 0,
      compaction: null,
      agentEnded: false,
      queueCard: null,
      stopping: false,
      steersInFlight: 0,
      heldOutcome: null,
      backgroundCommand: BACKGROUND_COMMAND.test(input.message.text.trimStart()),
      commandOutputSeen: false,
      awaitingCommandOutput: false,
    };
    // The orchestrator owns the provider thread row; keep its identity for later updates.
    thread.providerThread = {
      ...input.providerThread,
      nativeThreadRef: thread.providerThread.nativeThreadRef,
      nativeMetadata: thread.providerThread.nativeMetadata,
      // The live session's goal: a `/goal` turn sets it before the turn starts.
      goal: thread.providerThread.goal ?? null,
      status: "active",
      firstRunOrdinal: input.providerThread.firstRunOrdinal ?? input.runOrdinal,
      lastRunOrdinal: input.runOrdinal,
      updatedAt: now,
    };
    return [
      {
        type: "provider_turn.updated",
        driver: OMP_PROVIDER,
        threadId: input.threadId,
        providerTurn,
      },
      {
        type: "provider_thread.updated",
        driver: OMP_PROVIDER,
        providerThread: thread.providerThread,
      },
      ...this.setSessionStatus("running", null, now),
    ];
  }

  /**
   * Maps one frame. Unknown and out-of-turn frames map to nothing; the frame stream is typed
   * as the pinned contract, but a newer sidecar may send types this build has never seen.
   */
  handleFrame(frame: { readonly type: string }, now: DateTime.Utc): OmpFrameResult {
    const events: Array<Event> = [];
    let streaming = false;
    let settled: OmpTurnOutcome | null = null;
    let confirmIdle = false;
    const turn = this.#turn;
    const f = frame as Record<string, unknown>;
    switch (frame.type) {
      case "session_info_update":
        events.push(
          ...this.#sessionInfo(stringField(f, "sessionId"), stringField(f, "title"), now),
        );
        break;
      case "agent_start":
        if (turn !== null) turn.agentEnded = false;
        break;
      case "agent_end":
        if (turn !== null) {
          turn.agentEnded = true;
          const queued = this.#queue.steering.length + this.#queue.followUp.length;
          // The run that took messages sent after the prompt finished: it ends the turn.
          if (
            turn.heldOutcome !== null &&
            (turn.stopping || (turn.steersInFlight === 0 && queued === 0))
          ) {
            settled = turn.stopping ? { status: "interrupted" } : { status: "completed" };
            turn.heldOutcome = null;
          }
        }
        break;
      case "queue_update": {
        this.#queue = {
          steering: Array.isArray(f["steering"])
            ? f["steering"].filter((entry): entry is string => typeof entry === "string")
            : [],
          followUp: Array.isArray(f["followUp"])
            ? f["followUp"].filter((entry): entry is string => typeof entry === "string")
            : [],
          liveSteered: typeof f["liveSteered"] === "number" ? f["liveSteered"] : 0,
        };
        if (turn !== null && !turn.stopping) events.push(...this.#queueCard(turn, now));
        break;
      }
      case "response": {
        const command = f["command"];
        if (turn === null) break;
        // Echoed answers to a steer or follow-up, and to the idle check after one, ordered
        // with the frames OMP wrote before them (adapter `steerTurn`).
        if (command === "steer" || command === "follow_up") {
          turn.steersInFlight = Math.max(0, turn.steersInFlight - 1);
          confirmIdle = this.#heldAndQuiet(turn);
          break;
        }
        if (command === "get_state") {
          const state = asRecord(f["data"]);
          const busy =
            f["success"] === true &&
            (Number(state?.["queuedMessageCount"] ?? 0) > 0 || state?.["isStreaming"] === true);
          if (this.#heldAndQuiet(turn) && !busy) {
            settled = turn.heldOutcome;
            turn.heldOutcome = null;
          }
          break;
        }
        // `abort_and_prompt` starts a turn exactly like `prompt` (adapter `startTurn`).
        if (turn.promptId !== null) break;
        if (command !== "prompt" && command !== "abort_and_prompt") break;
        turn.promptId = typeof f["id"] === "string" ? f["id"] : "";
        if (f["success"] !== true) {
          settled = {
            status: "failed",
            failure: makeProviderFailure({
              message: stringField(f, "error") ?? "OMP rejected the prompt.",
              code: stringField(f, "code") ?? null,
              class: "provider_error",
            }),
          };
        } else if (asRecord(f["data"])?.["agentInvoked"] === false) {
          // A builtin slash command finished locally; no `prompt_result` follows. A background
          // one ends with its `command_output`, unless that came first (a usage error).
          if (turn.backgroundCommand && !turn.commandOutputSeen) {
            turn.awaitingCommandOutput = true;
          } else {
            settled = { status: "completed" };
          }
        }
        break;
      }
      case "prompt_result": {
        if (turn === null) break;
        const id = stringField(f, "id");
        if (
          id !== undefined &&
          turn.promptId !== null &&
          turn.promptId !== "" &&
          id !== turn.promptId
        )
          break;
        settled = this.#promptDone(turn, this.#promptOutcome(f));
        break;
      }
      case "message_start":
        if (turn !== null && stringField(f["message"], "role") === "assistant") {
          turn.messageOrdinal += 1;
          turn.messageKey = stringField(f, "messageId") ?? `m${turn.messageOrdinal}`;
        }
        break;
      case "message_update":
        if (turn !== null) {
          streaming = this.#assistantEvent(
            turn,
            f["assistantMessageEvent"] as AssistantMessageEvent | undefined,
            events,
            now,
          );
        }
        break;
      case "message_end": {
        const message = asRecord(f["message"]);
        if (turn !== null && stringField(message, "role") === "assistant") {
          events.push(...this.#completeStreamItems(turn, now));
          events.push(...this.#messageUsage(turn, message ?? {}, now));
        }
        if (
          turn !== null &&
          stringField(message, "role") === "custom" &&
          stringField(message, "customType") === "advisor"
        ) {
          const advice = advisorNotice(message);
          if (advice !== null) {
            events.push(
              ...this.#oneShotItem(turn, "advisor", now, {
                title: "Advisor",
                type: "notification",
                source: { kind: "system" },
                outcome: advice.blocker ? "failed" : "updated",
                summary: advice.summary,
                detail: advice.detail,
              }),
            );
          }
        }
        break;
      }
      case "auto_compaction_start":
      case "manual_compaction_start":
      case "auto_compaction_end":
      case "manual_compaction_end":
        if (turn !== null) events.push(...this.#compactionEvent(turn, f, now));
        break;
      case "ttsr_triggered":
        if (turn !== null) {
          const notice = ttsrNotice(Array.isArray(f["rules"]) ? f["rules"] : []);
          if (notice !== null) {
            events.push(
              ...this.#oneShotItem(turn, "ttsr", now, {
                title: "Rule injected",
                type: "notification",
                source: { kind: "system" },
                outcome: "updated",
                ...notice,
              }),
            );
          }
        }
        break;
      case "retry_fallback_applied":
        if (turn !== null) {
          const notice = fallbackNotice(f);
          if (notice !== null) {
            events.push(
              ...this.#oneShotItem(turn, "fallback", now, {
                title: "Fallback applied",
                type: "notification",
                source: { kind: "system" },
                outcome: "updated",
                ...notice,
              }),
            );
          }
        }
        break;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        if (turn !== null) events.push(...this.#toolEvent(turn, f, now));
        break;
      case "notice":
        if (turn !== null) {
          const message = stringField(f, "message")?.trim();
          if (message !== undefined && message.length > 0) {
            events.push(
              ...this.#oneShotItem(turn, "notice", now, {
                title: stringField(f, "source") ?? null,
                type: "system_notice",
                message,
              }),
            );
          }
        }
        break;
      case "command_output":
        if (turn !== null) {
          const text = stringField(f, "text") ?? "";
          const summary = text
            .split("\n")
            .map((line) => line.trim())
            .find((line) => line.length > 0);
          if (summary !== undefined) {
            events.push(
              ...this.#oneShotItem(turn, "command-output", now, {
                title: null,
                type: "notification",
                source: { kind: "system" },
                outcome: "completed",
                summary: summary.slice(0, 200),
                detail: text,
              }),
            );
          }
          turn.commandOutputSeen = true;
          if (turn.awaitingCommandOutput) {
            turn.awaitingCommandOutput = false;
            settled = this.#promptDone(turn, { status: "completed" });
          }
        }
        break;
      case "extension_ui_request":
        if (turn !== null && f["method"] === "notify") {
          const message = stringField(f, "message")?.trim();
          if (message !== undefined && message.length > 0) {
            const notifyType = stringField(f, "notifyType");
            events.push(
              ...this.#oneShotItem(turn, "notify", now, {
                title: null,
                type: "notification",
                // `agent` lets the shell surface it for push and desktop alerts (P-15).
                source: { kind: "agent" },
                outcome: notifyType === "error" ? "failed" : "updated",
                summary: message.slice(0, 200),
                ...(message.length > 200 ? { detail: message } : {}),
              }),
            );
          }
        }
        // A link OMP wants opened (an MCP or provider sign-in) and text an extension put in the
        // editor have no T surface of their own; both become notifications that carry them.
        if (turn !== null && f["method"] === "open_url") {
          const url = stringField(f, "url")?.trim();
          if (url !== undefined && url.length > 0) {
            const instructions = stringField(f, "instructions")?.trim() ?? "";
            events.push(
              ...this.#oneShotItem(turn, "open-url", now, {
                title: null,
                type: "notification",
                source: { kind: "system" },
                outcome: "updated",
                summary: (instructions.split("\n")[0] || "OMP asks you to open a link").slice(
                  0,
                  200,
                ),
                detail: instructions.length > 0 ? `${instructions}\n\n${url}` : url,
              }),
            );
          }
        }
        if (turn !== null && f["method"] === "set_editor_text") {
          const text = stringField(f, "text") ?? "";
          if (text.trim().length > 0) {
            events.push(
              ...this.#oneShotItem(turn, "editor-text", now, {
                title: null,
                type: "notification",
                source: { kind: "system" },
                outcome: "updated",
                summary: "OMP suggested a message",
                detail: text,
              }),
            );
          }
        }
        // Extension status lines and widgets feed the thread's status strip, in or out of a turn
        // (the adapter routes them to `applyExtensionStatus` before any run buffering).
        if (isOmpExtensionStatusRequest(frame))
          events.push(...this.applyExtensionStatus(frame, now));
        // `setTitle` sets OMP's terminal title; T keeps its own thread title. Dialogs are the
        // adapter's.
        break;
      case "rpc_frame_error":
        // OMP dropped an event too large for the transport; only the fact is kept.
        return { events, streaming, settled, confirmIdle, dropped: "sidecar_oversize" };
      default:
        break;
    }
    const method = f["method"];
    const outOfTurn =
      turn === null &&
      (Object.hasOwn(TURN_SCOPED_FRAME_TYPES, frame.type) ||
        (frame.type === "extension_ui_request" &&
          typeof method === "string" &&
          Object.hasOwn(TURN_SCOPED_UI_METHODS, method)));
    return { events, streaming, settled, confirmIdle, dropped: outOfTurn ? "out_of_turn" : null };
  }

  /** Emits held text of streaming items. */
  flushStreaming(now: DateTime.Utc): Array<Event> {
    const turn = this.#turn;
    if (turn === null) return [];
    const events: Array<Event> = [];
    for (const item of turn.streamItems.values()) {
      if (!item.dirty || item.completed) continue;
      item.dirty = false;
      events.push(...this.#streamItemEvents(turn, item, true, now));
    }
    return events;
  }

  /** Records todos reported outside a tool call (`get_state`, `set_todos`). */
  applyTodoPhases(phases: ReadonlyArray<TodoPhase>, now: DateTime.Utc): Array<Event> {
    const thread = this.#thread;
    if (thread === null) return [];
    if (JSON.stringify(phases) === JSON.stringify(thread.todoPhases)) return [];
    thread.todoPhases = phases;
    const turn = this.#turn;
    return turn === null
      ? []
      : this.#todoEvents(turn, `todos:state:${turn.providerTurn.id}`, phases, now);
  }

  /** Ends the active turn with the refreshed session state. */
  finalizeTurn(outcome: OmpTurnOutcome, refresh: OmpTurnRefresh, now: DateTime.Utc): Array<Event> {
    const turn = this.#turn;
    const thread = this.#thread;
    if (turn === null || thread === null) return [];
    const events: Array<Event> = [...this.#completeStreamItems(turn, now)];
    if (refresh.state !== undefined) {
      events.push(...this.#sessionInfo(refresh.state.sessionId, undefined, now));
      if (refresh.state.todoPhases !== undefined) {
        events.push(...this.applyTodoPhases(refresh.state.todoPhases, now));
      }
    }
    this.#turn = null;

    const reportedContext = refresh.stats?.contextUsage ?? refresh.state?.contextUsage;
    const contextTokenUsage = this.#contextTokenUsage(reportedContext, now);
    const tokenUsage = contextTokenUsage ?? turn.tokenUsage;
    const providerTurn: OrchestrationV2ProviderTurn = {
      ...turn.providerTurn,
      ...(refresh.turnEntryId === undefined
        ? {}
        : {
            nativeTurnRef: refresh.turnEntryId === null ? null : providerRef(refresh.turnEntryId),
          }),
      status: outcome.status,
      completedAt: now,
      ...(tokenUsage === undefined ? {} : { tokenUsage }),
      turnTokenUsage: this.#turnTokenUsage(turn.usage),
    };
    events.push({
      type: "provider_turn.updated",
      driver: OMP_PROVIDER,
      threadId: turn.input.threadId,
      providerTurn,
    });

    const contextUsage = this.#contextSnapshot(
      reportedContext,
      refresh.stats,
      thread.providerThread,
    );
    thread.providerThread = {
      ...thread.providerThread,
      status: "idle",
      ...(contextUsage === undefined ? {} : { contextUsage }),
      ...(refresh.state?.goal === undefined
        ? {}
        : { goal: ompStateGoal(refresh.state.goal, thread.providerThread.goal) }),
      updatedAt: now,
    };
    events.push({
      type: "provider_thread.updated",
      driver: OMP_PROVIDER,
      providerThread: thread.providerThread,
    });

    if (outcome.status === "failed") {
      events.push(...this.setSessionStatus("ready", outcome.failure.message, now));
      const failureItemId = `terminal-failure:${turn.providerTurn.id}`;
      const failureItemOrdinal = this.#itemOrdinal(turn, failureItemId);
      events.push({
        type: "turn_item.updated",
        driver: OMP_PROVIDER,
        turnItem: makeProviderFailureTurnItem({
          driver: OMP_PROVIDER,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId: turn.input.rootNodeId,
          providerThreadId: turn.input.providerThread.id,
          providerTurnId: turn.providerTurn.id,
          itemOrdinal: failureItemOrdinal,
          failure: outcome.failure,
          occurredAt: now,
        }),
      });
      events.push({
        type: "turn.terminal",
        driver: OMP_PROVIDER,
        providerThreadId: thread.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: turn.input.runOrdinal,
        failureItemOrdinal,
        status: "failed",
        failure: outcome.failure,
        threadDisposition: "reusable",
      });
    } else {
      events.push(...this.setSessionStatus("ready", null, now));
      events.push({
        type: "turn.terminal",
        driver: OMP_PROVIDER,
        providerThreadId: thread.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        runOrdinal: turn.input.runOrdinal,
        status: outcome.status,
        failure: null,
        threadDisposition: "reusable",
      });
    }
    return events;
  }

  /**
   * `prompt_result.status` is the prompt's final word: a model error OMP recovered from by
   * auto-retry or fallback still ends `completed`, and one it gave up on ends `error`.
   */
  #promptOutcome(frame: Record<string, unknown>): OmpTurnOutcome {
    const status = frame["status"];
    if (status === "aborted") return { status: "interrupted" };
    if (status === "error") {
      const error = asRecord(frame["error"]);
      const httpStatus = error?.["httpStatus"];
      return {
        status: "failed",
        failure: makeProviderFailure({
          message: stringField(error, "message") ?? "OMP reported an error.",
          class: httpStatus === 429 ? "usage_limit" : "provider_error",
          retryable: typeof error?.["retryable"] === "boolean" ? error["retryable"] : null,
        }),
      };
    }
    return { status: "completed" };
  }

  #sessionInfo(
    sessionId: string | undefined,
    title: string | undefined,
    now: DateTime.Utc,
  ): Array<Event> {
    const thread = this.#thread;
    if (thread === null) return [];
    const events: Array<Event> = [];
    let providerThread = thread.providerThread;
    // `/fresh` rotates the OMP session id but keeps the session: adopt the new id in place.
    if (sessionId !== undefined && sessionId.length > 0 && sessionId !== thread.sessionId) {
      thread.sessionId = sessionId;
      providerThread = { ...providerThread, nativeThreadRef: providerRef(sessionId) };
    }
    const cleanTitle = title?.trim();
    if (
      cleanTitle !== undefined &&
      cleanTitle.length > 0 &&
      cleanTitle !== providerThread.nativeMetadata?.title
    ) {
      providerThread = {
        ...providerThread,
        nativeMetadata: { ...providerThread.nativeMetadata, title: cleanTitle },
      };
    }
    const turn = this.#turn;
    if (
      cleanTitle !== undefined &&
      cleanTitle.length > 0 &&
      turn !== null &&
      turn.renameRequested &&
      cleanTitle !== turn.input.appThread.title
    ) {
      // Only an explicit `/rename` renames the thread; titles OMP reports for other commands
      // (model switch, preset, move) are its own and stay native metadata.
      const appThread: OrchestrationV2AppThread = {
        ...turn.input.appThread,
        title: cleanTitle,
        updatedAt: now,
      };
      events.push({ type: "app_thread.created", driver: OMP_PROVIDER, appThread });
    }
    if (providerThread !== thread.providerThread) {
      thread.providerThread = { ...providerThread, updatedAt: now };
      events.push({
        type: "provider_thread.updated",
        driver: OMP_PROVIDER,
        providerThread: thread.providerThread,
      });
    }
    return events;
  }

  #itemOrdinal(turn: ActiveTurn, nativeItemId: string): number {
    const existing = turn.itemOrdinals.get(nativeItemId);
    if (existing !== undefined) return existing;
    const ordinal = turn.nextItemOrdinal++;
    turn.itemOrdinals.set(nativeItemId, ordinal);
    return ordinal;
  }

  #node(
    turn: ActiveTurn,
    nativeItemId: string,
    kind: OrchestrationV2ExecutionNode["kind"],
    status: OrchestrationV2ExecutionNode["status"],
    startedAt: DateTime.Utc,
    completedAt: DateTime.Utc | null,
  ): Event {
    return {
      type: "node.updated",
      driver: OMP_PROVIDER,
      node: {
        id: IdAllocator.derive.nodeFromProviderItem({ driver: OMP_PROVIDER, nativeItemId }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        parentNodeId: turn.input.rootNodeId,
        rootNodeId: turn.input.rootNodeId,
        kind,
        status,
        countsForRun: false,
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        runtimeRequestId: null,
        checkpointScopeId: null,
        startedAt,
        completedAt,
      },
    };
  }

  #item(
    turn: ActiveTurn,
    nativeItemId: string,
    status: TurnItemStatus,
    startedAt: DateTime.Utc,
    now: DateTime.Utc,
    body: ItemBody,
  ): Event {
    const completed = status !== "running" && status !== "pending" && status !== "waiting";
    return {
      type: "turn_item.updated",
      driver: OMP_PROVIDER,
      turnItem: {
        id: IdAllocator.derive.turnItemFromProviderItem({ driver: OMP_PROVIDER, nativeItemId }),
        threadId: turn.input.threadId,
        runId: turn.input.runId,
        nodeId: IdAllocator.derive.nodeFromProviderItem({ driver: OMP_PROVIDER, nativeItemId }),
        providerThreadId: turn.input.providerThread.id,
        providerTurnId: turn.providerTurn.id,
        nativeItemRef: providerRef(nativeItemId),
        parentItemId: null,
        ordinal: this.#itemOrdinal(turn, nativeItemId),
        startedAt,
        updatedAt: now,
        status,
        completedAt: completed ? now : null,
        ...body,
      } as OrchestrationV2TurnItem,
    };
  }

  /**
   * One card per turn for OMP's queue: it shows what OMP still holds after each snapshot and
   * completes once the queue is empty, or with `closing` when the turn's Stop withdrew it. An
   * empty queue with no card shows nothing.
   */
  #queueCard(
    turn: ActiveTurn,
    now: DateTime.Utc,
    closing?: { readonly summary: string; readonly detail?: string },
  ): Array<Event> {
    const queue = this.#queue;
    const pending = closing === undefined ? queue.steering.length + queue.followUp.length : 0;
    if (turn.queueCard === null) {
      if (pending === 0 && closing === undefined) return [];
      turn.queueCard = { nativeItemId: `queue:${turn.providerTurn.id}`, startedAt: now };
    }
    const { nativeItemId, startedAt } = turn.queueCard;
    const status = pending === 0 ? "completed" : "running";
    if (pending === 0) turn.queueCard = null;
    return [
      this.#node(turn, nativeItemId, "system", status, startedAt, pending === 0 ? now : null),
      this.#item(turn, nativeItemId, status, startedAt, now, {
        title: "OMP queue",
        type: "notification",
        source: { kind: "system" },
        outcome: "updated",
        ...(closing ?? queueCardText(queue)),
      }),
    ];
  }

  /**
   * A Stop is under way: OMP is about to empty its queue, but those messages are withdrawn,
   * not delivered, so queue snapshots stop updating the card until `endStop`.
   */
  beginStop(): void {
    if (this.#turn !== null) this.#turn.stopping = true;
  }

  /**
   * The Stop's answer: `restored` lists what OMP withdrew (`abort_and_restore_queue`), or is
   * null when the Stop failed. Withdrawn messages never ran; the queue card says which.
   */
  endStop(
    restored: {
      readonly steering: ReadonlyArray<string>;
      readonly followUp: ReadonlyArray<string>;
    } | null,
    now: DateTime.Utc,
  ): Array<Event> {
    const turn = this.#turn;
    if (turn === null) return [];
    turn.stopping = false;
    const withdrawn = restored === null ? [] : [...restored.steering, ...restored.followUp];
    if (restored !== null) this.#queue = EMPTY_QUEUE;
    if (withdrawn.length === 0) return this.#queueCard(turn, now);
    return this.#queueCard(turn, now, {
      summary: `Stopped before ${withdrawn.length} queued message${withdrawn.length === 1 ? "" : "s"} ran`,
      detail: withdrawn.join("\n"),
    });
  }

  /** A steer or follow-up for the active turn is on its way to OMP. */
  steerSent(): void {
    if (this.#turn !== null) this.#turn.steersInFlight += 1;
  }

  /**
   * A steer, follow-up or idle check got no reply on the frame stream (timeout, transport):
   * nothing more will say whether OMP runs the message, so a held turn ends with its prompt.
   */
  steerLost(): OmpTurnOutcome | null {
    const turn = this.#turn;
    if (turn === null) return null;
    turn.steersInFlight = Math.max(0, turn.steersInFlight - 1);
    if (turn.heldOutcome === null || turn.steersInFlight > 0) return null;
    const outcome = turn.heldOutcome;
    turn.heldOutcome = null;
    return outcome;
  }

  /** Whether the active turn's prompt finished but a message T3 sent for it is still pending. */
  get holdingOutcome(): boolean {
    return this.#turn?.heldOutcome != null;
  }

  /** Whether the active turn waits for a background `/compact` or `/handoff` to finish. */
  get awaitingCommandOutput(): boolean {
    return this.#turn?.awaitingCommandOutput === true;
  }

  /**
   * The prompt ended with `outcome`. A message T3 sent for this turn that OMP has not run yet
   * would start an OMP run no turn owns: the turn stays open until that run ends (`agent_end`,
   * `steerAcknowledged`).
   */
  #promptDone(turn: ActiveTurn, outcome: OmpTurnOutcome): OmpTurnOutcome | null {
    const queued = this.#queue.steering.length + this.#queue.followUp.length;
    if (!turn.stopping && (turn.steersInFlight > 0 || queued > 0)) {
      turn.heldOutcome = outcome;
      return null;
    }
    return outcome;
  }

  /**
   * A turn whose prompt finished, held for a message T3 sent for it, with every such message
   * answered, the agent loop ended and nothing in OMP's queue: OMP may be idle, so the
   * adapter asks (`get_state`, echoed) and the answer ends the turn. If OMP instead runs the
   * message, that run belongs to the turn and its `agent_end` ends it.
   */
  #heldAndQuiet(turn: ActiveTurn): boolean {
    const queued = this.#queue.steering.length + this.#queue.followUp.length;
    return (
      turn.heldOutcome !== null && turn.steersInFlight === 0 && turn.agentEnded && queued === 0
    );
  }

  #oneShotItem(turn: ActiveTurn, prefix: string, now: DateTime.Utc, body: ItemBody): Array<Event> {
    turn.noticeCount += 1;
    const nativeItemId = `${prefix}:${turn.providerTurn.id}:${turn.noticeCount}`;
    return [
      this.#node(turn, nativeItemId, "system", "completed", now, now),
      this.#item(turn, nativeItemId, "completed", now, now, body),
    ];
  }

  /** Returns whether text is now held for a flush. */
  #assistantEvent(
    turn: ActiveTurn,
    event: AssistantMessageEvent | undefined,
    events: Array<Event>,
    now: DateTime.Utc,
  ): boolean {
    if (event === undefined) return false;
    switch (event.type) {
      case "text_delta":
      case "thinking_delta": {
        const item = this.#streamItem(turn, event, now);
        item.text += event.delta;
        item.dirty = true;
        return true;
      }
      case "text_end":
      case "thinking_end": {
        const item = this.#streamItem(turn, event, now);
        if (!item.completed) {
          item.completed = true;
          if (event.content.length > 0) item.text = event.content;
          if (item.text.length > 0) events.push(...this.#streamItemEvents(turn, item, false, now));
        }
        return false;
      }
      default:
        return false;
    }
  }

  #streamItem(
    turn: ActiveTurn,
    event: Extract<
      AssistantMessageEvent,
      { type: "text_delta" | "thinking_delta" | "text_end" | "thinking_end" }
    >,
    now: DateTime.Utc,
  ): StreamItem {
    const nativeItemId = `${turn.providerTurn.id}:${turn.messageKey}:c${event.contentIndex}`;
    const existing = turn.streamItems.get(nativeItemId);
    if (existing !== undefined) return existing;
    // Thinking marked `narration` is prose addressed to the user: show it as the answer.
    const block = event.partial?.content?.[event.contentIndex];
    const narration = block?.type === "thinking" && block.narration === true;
    const kind =
      event.type === "text_delta" || event.type === "text_end" || narration
        ? "assistant_message"
        : "reasoning";
    const item: StreamItem = {
      nativeItemId,
      kind,
      startedAt: now,
      text: "",
      dirty: false,
      completed: false,
    };
    turn.streamItems.set(nativeItemId, item);
    this.#itemOrdinal(turn, nativeItemId);
    return item;
  }

  #completeStreamItems(turn: ActiveTurn, now: DateTime.Utc): Array<Event> {
    const events: Array<Event> = [];
    for (const item of turn.streamItems.values()) {
      if (item.completed) continue;
      item.completed = true;
      if (item.text.length > 0) events.push(...this.#streamItemEvents(turn, item, false, now));
    }
    return events;
  }

  #streamItemEvents(
    turn: ActiveTurn,
    item: StreamItem,
    streaming: boolean,
    now: DateTime.Utc,
  ): Array<Event> {
    const status = streaming ? "running" : "completed";
    const node = this.#node(
      turn,
      item.nativeItemId,
      item.kind,
      status,
      item.startedAt,
      streaming ? null : now,
    );
    if (item.kind === "reasoning") {
      return [
        node,
        this.#item(turn, item.nativeItemId, status, item.startedAt, now, {
          title: null,
          type: "reasoning",
          text: item.text,
          streaming,
        }),
      ];
    }
    const messageId = IdAllocator.derive.messageFromProviderItem({
      driver: OMP_PROVIDER,
      nativeItemId: item.nativeItemId,
    });
    return [
      node,
      this.#item(turn, item.nativeItemId, status, item.startedAt, now, {
        title: null,
        type: "assistant_message",
        messageId,
        text: item.text,
        streaming,
      }),
      {
        type: "message.updated",
        driver: OMP_PROVIDER,
        message: {
          id: messageId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId: IdAllocator.derive.nodeFromProviderItem({
            driver: OMP_PROVIDER,
            nativeItemId: item.nativeItemId,
          }),
          role: "assistant",
          text: item.text,
          attachments: [],
          streaming,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: item.startedAt,
          updatedAt: now,
        },
      },
    ];
  }

  #toolEvent(turn: ActiveTurn, frame: Record<string, unknown>, now: DateTime.Utc): Array<Event> {
    const toolCallId = stringField(frame, "toolCallId");
    if (toolCallId === undefined || toolCallId.length === 0) return [];
    const phase = frame["type"];
    const known = turn.tools.get(toolCallId);
    const call: ToolCall = known ?? {
      toolName: stringField(frame, "toolName") ?? "tool",
      startedAt: now,
      args: undefined,
    };
    if (known === undefined) turn.tools.set(toolCallId, call);
    if (frame["args"] !== undefined) call.args = frame["args"];
    const completed = phase === "tool_execution_end";
    const result = completed ? frame["result"] : frame["partialResult"];
    const isError = completed && frame["isError"] === true;

    if (isCommandTool(call.toolName) && phase === "tool_execution_update") {
      // Live output is a delta on the running card, as Codex streams it; the persisted card gets
      // the whole output at `tool_execution_end`.
      const output = commandOutputText(result);
      const sent = call.streamed;
      call.streamed = output;
      if (sent !== undefined || known !== undefined) {
        const chunk = streamedOutputChunk(sent ?? "", output);
        return chunk.length === 0
          ? []
          : [
              {
                type: "command_output.delta",
                driver: OMP_PROVIDER,
                threadId: turn.input.threadId,
                itemId: IdAllocator.derive.turnItemFromProviderItem({
                  driver: OMP_PROVIDER,
                  nativeItemId: toolCallId,
                }),
                chunk,
              },
            ];
      }
    }

    if (call.toolName === "todo") {
      // The card is the list itself, once the tool has run; failures keep the generic card.
      if (!completed) return [];
      const phases = asRecord(asRecord(result)?.["details"])?.["phases"];
      if (!isError && isTodoPhases(phases)) {
        const thread = this.#thread;
        if (thread !== null) thread.todoPhases = phases;
        return this.#todoEvents(turn, toolCallId, phases, now);
      }
    }

    const status: TurnItemStatus = completed ? (isError ? "failed" : "completed") : "running";
    let card = ompToolCard({ toolName: call.toolName, args: call.args, result, isError });
    const proposal = card.type === "dynamic_tool" ? readOmpToolCard(card.output) : null;
    const staging =
      completed && proposal?.kind === "proposed_edit" && proposal.state === "proposed";
    if (staging && this.#proposalsResolvable && card.type === "dynamic_tool") {
      card = {
        ...card,
        // `persistent`: like a monitor, the waiting card neither holds the thread as background
        // work nor ends with Stop (OMP keeps a preview across a Stop).
        input: { ...asRecord(card.input), persistent: true },
        output: {
          ...asRecord(card.output),
          [OMP_CARD_OUTPUT_KEY]: { ...proposal, resolvable: true },
        },
      };
    }
    // A resolvable proposal waits for Accept or Reject: its run keeps listening for the outcome.
    const itemStatus: TurnItemStatus = staging && this.#proposalsResolvable ? "waiting" : status;
    const item = this.#item(turn, toolCallId, itemStatus, call.startedAt, now, card);
    const events: Array<Event> = [
      this.#node(turn, toolCallId, "tool_call", status, call.startedAt, completed ? now : null),
      item,
    ];
    if (staging && item.type === "turn_item.updated") {
      this.#staged.set(toolCallId, item.turnItem);
    } else if (
      completed &&
      proposal?.kind === "proposed_edit" &&
      proposal.state !== "proposed" &&
      card.type === "dynamic_tool" &&
      (card.toolName === "xd://resolve" || card.toolName === "xd://reject")
    ) {
      // OMP names the staging call (contract 1.10.0); older ones resolve the latest preview.
      const inner = asRecord(
        asRecord(asRecord(asRecord(result)?.["details"])?.["xdev"])?.["inner"],
      );
      const named = inner?.["toolCallId"];
      const target = typeof named === "string" ? named : [...this.#staged.keys()].at(-1);
      if (target !== undefined) {
        events.push(...this.resolveProposal(target, proposal.state, now));
      }
    }
    return events;
  }

  /** Auto and manual compaction share one card that runs from start to end. */
  #compactionEvent(
    turn: ActiveTurn,
    frame: Record<string, unknown>,
    now: DateTime.Utc,
  ): Array<Event> {
    const type = frame["type"];
    const starting = type === "auto_compaction_start" || type === "manual_compaction_start";
    let current = turn.compaction;
    if (current === null || starting) {
      turn.noticeCount += 1;
      current = {
        nativeItemId: `compaction:${turn.providerTurn.id}:${turn.noticeCount}`,
        startedAt: now,
      };
    }
    turn.compaction = starting ? current : null;
    const resultRecord = asRecord(frame["result"]);
    const errorMessage = stringField(frame, "errorMessage");
    const status: TurnItemStatus = starting
      ? "running"
      : frame["aborted"] === true
        ? "interrupted"
        : errorMessage !== undefined && frame["skipped"] !== true && resultRecord === undefined
          ? "failed"
          : "completed";
    const summary =
      stringField(resultRecord, "shortSummary") ??
      stringField(resultRecord, "summary") ??
      errorMessage;
    const tokensBefore = optionalCount(resultRecord?.["tokensBefore"]);
    return [
      this.#node(
        turn,
        current.nativeItemId,
        "system",
        starting ? "running" : status === "failed" ? "failed" : "completed",
        current.startedAt,
        starting ? null : now,
      ),
      this.#item(turn, current.nativeItemId, status, current.startedAt, now, {
        title: null,
        type: "compaction",
        driver: OMP_PROVIDER,
        ...(starting || summary === undefined ? {} : { summary }),
        ...(tokensBefore === undefined ? {} : { beforeTokenCount: tokensBefore }),
      }),
    ];
  }

  #todoEvents(
    turn: ActiveTurn,
    nativeItemId: string,
    phases: ReadonlyArray<TodoPhase>,
    now: DateTime.Utc,
  ): Array<Event> {
    const steps = ompTodoSteps(phases);
    // One plan per turn: later lists in the same turn supersede earlier ones in place.
    const planId = PlanId.make(`plan:provider:omp:todos:${turn.providerTurn.id}`);
    const nodeId = IdAllocator.derive.nodeFromProviderItem({ driver: OMP_PROVIDER, nativeItemId });
    return [
      this.#node(turn, nativeItemId, "todo_list", "completed", now, now),
      {
        type: "plan.updated",
        driver: OMP_PROVIDER,
        plan: {
          id: planId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId,
          kind: "todo_list",
          status:
            steps.length > 0 && steps.every((step) => step.status === "completed")
              ? "completed"
              : "active",
          steps,
        },
      },
      this.#item(turn, nativeItemId, "completed", now, now, {
        title: null,
        type: "todo_list",
        planId,
        steps,
      }),
    ];
  }

  /** Assistant `message_end` usage: the turn's token totals and the live context meter. */
  #messageUsage(
    turn: ActiveTurn,
    message: Record<string, unknown>,
    now: DateTime.Utc,
  ): Array<Event> {
    const usage = asRecord(message["usage"]) as Partial<Usage> | undefined;
    if (usage === undefined) return [];
    turn.usage.input += count(usage.input);
    turn.usage.output += count(usage.output);
    turn.usage.cacheRead += count(usage.cacheRead);
    turn.usage.cacheWrite += count(usage.cacheWrite);
    turn.usage.reasoning += count(usage.reasoningTokens);
    turn.usage.reported = true;
    const window = this.#contextWindow();
    const usedTokens =
      optionalCount(usage.contextTokens) ??
      count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite) + count(usage.output);
    if (window !== null && usedTokens > 0) {
      turn.tokenUsage = {
        usedTokens,
        maxTokens: window,
        inputTokens: count(usage.input) + count(usage.cacheRead) + count(usage.cacheWrite),
        cachedInputTokens: count(usage.cacheRead),
        outputTokens: count(usage.output),
        updatedAt: DateTime.formatIso(now),
      };
    }
    return [
      {
        type: "provider_turn.updated",
        driver: OMP_PROVIDER,
        threadId: turn.input.threadId,
        providerTurn: {
          ...turn.providerTurn,
          ...(turn.tokenUsage === undefined ? {} : { tokenUsage: turn.tokenUsage }),
          turnTokenUsage: this.#turnTokenUsage(turn.usage),
        },
      },
    ];
  }

  #turnTokenUsage(usage: UsageTotals): TurnTokenUsage {
    if (!usage.reported) {
      return { usageScope: "main_agent", usageStatus: "unavailable", hasSubagents: false };
    }
    return {
      usageScope: "main_agent",
      usageStatus: "complete",
      // T3 counts cache reads and writes as input.
      inputTokens: usage.input + usage.cacheRead + usage.cacheWrite,
      cachedInputTokens: usage.cacheRead,
      cacheCreationTokens: usage.cacheWrite,
      outputTokens: usage.output,
      ...(usage.reasoning > 0 ? { reasoningTokens: usage.reasoning } : {}),
      hasSubagents: false,
    };
  }

  #contextWindow(): number | null {
    const window = this.#thread?.providerThread.contextUsage?.maxTokens;
    return window === undefined || window <= 0 ? null : window;
  }

  #contextTokenUsage(
    context: ContextUsage | undefined,
    now: DateTime.Utc,
  ): OrchestrationV2ProviderTurnTokenUsage | undefined {
    if (context === undefined || count(context.contextWindow) === 0) return undefined;
    return {
      usedTokens: count(context.tokens),
      maxTokens: count(context.contextWindow),
      updatedAt: DateTime.formatIso(now),
    };
  }

  /** The context meter: OMP's context window use, with session token totals and cost. */
  #contextSnapshot(
    context: ContextUsage | undefined,
    stats: SessionStats | undefined,
    previous: OrchestrationV2ProviderThread | undefined,
  ): ThreadTokenUsageSnapshot | undefined {
    if (context === undefined) return undefined;
    const maxTokens = count(context.contextWindow);
    const previousUsage = previous?.contextUsage ?? undefined;
    return {
      usedTokens: count(context.tokens),
      ...(maxTokens > 0 ? { maxTokens } : {}),
      ...(stats === undefined
        ? previousUsage?.cost === undefined
          ? {}
          : { cost: previousUsage.cost }
        : {
            totalProcessedTokens: count(stats.tokens.total),
            inputTokens:
              count(stats.tokens.input) +
              count(stats.tokens.cacheRead) +
              count(stats.tokens.cacheWrite),
            cachedInputTokens: count(stats.tokens.cacheRead),
            outputTokens: count(stats.tokens.output),
            ...(stats.tokens.reasoning === undefined
              ? {}
              : { reasoningOutputTokens: count(stats.tokens.reasoning) }),
            ...(Number.isFinite(stats.cost)
              ? { cost: { amount: stats.cost, currency: "USD" } }
              : {}),
          }),
      compactsAutomatically: true,
    };
  }
}
