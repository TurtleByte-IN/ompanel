/**
 * OMP subagents of one thread as V2 subagents, from the `subagent_lifecycle` and
 * `subagent_progress` frames OMP sends at subscription level `"progress"`. Pure state, like
 * `OmpThreadMapper`: the adapter feeds frames and sends the returned events.
 */
import type {
  NodeId,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentControls,
  OrchestrationV2SubagentTranscriptEntry,
  OrchestrationV2SubagentTranscriptPage,
  OrchestrationV2SubagentUsage,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as DateTime from "effect/DateTime";

import type { SubagentMessages } from "../../contract/src/wire.generated.ts";
import { OMP_PROVIDER } from "./mapper.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;
type SubagentStatus = OrchestrationV2Subagent["status"];

/** The first RPC contract with `revive_subagent`. */
export const OMP_REVIVE_CONTRACT = "1.4.0";

/** Longest progress line and transcript entry kept; transcripts are for reading, not archiving. */
const PROGRESS_CHARS = 200;
const ENTRY_CHARS = 4_000;

/** Where this thread's subagents hang: the bound thread, and the turn running now, if any. */
export interface OmpSubagentScope {
  readonly threadId: ThreadId;
  readonly providerThreadId: ProviderThreadId;
  readonly runId: RunId | null;
  readonly rootNodeId: NodeId | null;
}

/** True when `version` (semver) is at least `minimum`. */
export function contractAtLeast(version: string, minimum: string): boolean {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const have = parse(version);
  const need = parse(minimum);
  for (let index = 0; index < need.length; index += 1) {
    const difference = (have[index] ?? 0) - (need[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

/** What the agents panel may do to OMP subagents under the pinned RPC contract. */
export function ompSubagentControls(contractVersion: string): OrchestrationV2SubagentControls {
  return {
    transcript: true,
    steer: true,
    kill: true,
    revive: contractAtLeast(contractVersion, OMP_REVIVE_CONTRACT),
  };
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const stringOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value : undefined;

const countOf = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : undefined;

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/** Lifecycle and `AgentProgress` statuses as V2 subagent statuses. */
function subagentStatus(status: unknown): SubagentStatus | undefined {
  switch (status) {
    case "started":
    case "running":
      return "running";
    case "pending":
      return "pending";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "aborted":
      return "cancelled";
    default:
      return undefined;
  }
}

const isTerminal = (status: SubagentStatus) =>
  status === "completed" ||
  status === "failed" ||
  status === "cancelled" ||
  status === "interrupted";

function usageOf(progress: Record<string, unknown>): OrchestrationV2SubagentUsage | undefined {
  const cost = progress.cost;
  const usage: OrchestrationV2SubagentUsage = {
    ...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
    ...(countOf(progress.tokens) === undefined ? {} : { totalTokens: countOf(progress.tokens) }),
    ...(countOf(progress.toolCount) === undefined
      ? {}
      : { toolCalls: countOf(progress.toolCount) }),
    ...(countOf(progress.durationMs) === undefined
      ? {}
      : { durationMs: countOf(progress.durationMs) }),
  };
  return Object.keys(usage).length === 0 ? undefined : usage;
}

/** The agent's current step: its own words when it reported some, else the tool it runs. */
function progressLine(progress: Record<string, unknown>): string | undefined {
  const line =
    stringOf(progress.stage) ??
    stringOf(progress.lastIntent) ??
    stringOf(progress.currentToolIntent) ??
    stringOf(progress.currentTool);
  return line === undefined ? undefined : clip(line.trim(), PROGRESS_CHARS);
}

/** `parentId`/`depth` arrive with RPC contract 1.2.0; older frames have neither. */
function lineageOf(payload: Record<string, unknown>): {
  readonly parentId: string | null | undefined;
  readonly depth: number | undefined;
} {
  const parentId = payload.parentId;
  return {
    parentId:
      typeof parentId === "string" && parentId.length > 0
        ? parentId
        : parentId === null
          ? null
          : undefined,
    depth: countOf(payload.depth),
  };
}

/** A tracked subagent, with what later frames need that the V2 record does not hold. */
interface Tracked {
  readonly record: OrchestrationV2Subagent;
  readonly agent: string;
  readonly description: string | undefined;
}

export interface OmpSubagentTrackerOptions {
  readonly instanceId: ProviderInstanceId;
  readonly controls: OrchestrationV2SubagentControls;
}

export class OmpSubagentTracker {
  readonly #subagents = new Map<string, Tracked>();
  readonly #instanceId: ProviderInstanceId;
  readonly #controls: OrchestrationV2SubagentControls;

  constructor(options: OmpSubagentTrackerOptions) {
    this.#instanceId = options.instanceId;
    this.#controls = options.controls;
  }

  /** The node of OMP subagent `id` in `providerThreadId`; OMP ids are unique per session. */
  static nodeId(providerThreadId: ProviderThreadId, id: string): NodeId {
    return IdAllocator.derive.nodeFromProviderItem({
      driver: OMP_PROVIDER,
      nativeItemId: `${providerThreadId}:subagent:${id}`,
    });
  }

  /** Maps one `subagent_lifecycle` or `subagent_progress` frame; other frames map to nothing. */
  handleFrame(
    frame: { readonly type: string; readonly payload?: unknown },
    scope: OmpSubagentScope | null,
    now: DateTime.Utc,
  ): Array<Event> {
    const payload = asRecord(frame.payload);
    // Subagents only run inside a bound thread's session; a frame before binding has no home.
    if (payload === undefined || scope === null) return [];
    if (frame.type === "subagent_lifecycle") {
      const id = stringOf(payload.id);
      const status = subagentStatus(payload.status);
      if (id === undefined || status === undefined) return [];
      return this.#update(id, payload, undefined, status, scope, now);
    }
    if (frame.type === "subagent_progress") {
      const progress = asRecord(payload.progress);
      const id = stringOf(payload.id) ?? stringOf(progress?.id);
      if (id === undefined || progress === undefined) return [];
      // A terminal status only ever comes from the lifecycle frame; progress may lag behind it.
      const reported = subagentStatus(progress.status);
      const current = this.#subagents.get(id)?.record.status;
      const status =
        current !== undefined && isTerminal(current) ? current : (reported ?? current ?? "running");
      return this.#update(id, payload, progress, status, scope, now);
    }
    return [];
  }

  #update(
    id: string,
    payload: Record<string, unknown>,
    progress: Record<string, unknown> | undefined,
    status: SubagentStatus,
    scope: OmpSubagentScope,
    now: DateTime.Utc,
  ): Array<Event> {
    const existing = this.#subagents.get(id);
    const previous = existing?.record;
    const agent = stringOf(payload.agent) ?? existing?.agent ?? "task";
    const description =
      stringOf(payload.description) ?? stringOf(progress?.description) ?? existing?.description;
    const { parentId, depth } = lineageOf(payload);
    const parentNodeId =
      parentId !== undefined && parentId !== null
        ? OmpSubagentTracker.nodeId(scope.providerThreadId, parentId)
        : (previous?.parentNodeId ??
          (stringOf(payload.parentToolCallId) === undefined
            ? (scope.rootNodeId ??
              IdAllocator.derive.nodeFromProviderItem({
                driver: OMP_PROVIDER,
                nativeItemId: `${scope.providerThreadId}:subagents`,
              }))
            : IdAllocator.derive.nodeFromProviderItem({
                driver: OMP_PROVIDER,
                nativeItemId: String(payload.parentToolCallId),
              })));
    const restarted = previous !== undefined && isTerminal(previous.status) && !isTerminal(status);
    const task = stringOf(payload.assignment) ?? stringOf(payload.task) ?? stringOf(progress?.task);
    const usage = progress === undefined ? previous?.usage : (usageOf(progress) ?? previous?.usage);
    const line = progress === undefined ? undefined : progressLine(progress);
    const record: OrchestrationV2Subagent = {
      id: OmpSubagentTracker.nodeId(scope.providerThreadId, id),
      threadId: scope.threadId,
      // A revived subagent runs outside the turn that spawned it; it keeps that turn's run.
      runId: previous?.runId ?? scope.runId,
      parentNodeId,
      origin: "provider_native",
      createdBy: "agent",
      driver: OMP_PROVIDER,
      providerInstanceId: this.#instanceId,
      providerThreadId: scope.providerThreadId,
      childThreadId: null,
      nativeTaskRef: { driver: OMP_PROVIDER, nativeId: id, strength: "strong" },
      prompt: task ?? previous?.prompt ?? description ?? "",
      title: description === undefined ? `${id} (${agent})` : `${id}: ${description}`,
      model:
        stringOf(progress?.resolvedModel) ??
        stringOf(progress?.resolvedModelIdentity) ??
        previous?.model ??
        null,
      status,
      ...(isTerminal(status)
        ? {}
        : line !== undefined
          ? { progress: line }
          : previous?.progress !== undefined && !restarted
            ? { progress: previous.progress }
            : {}),
      ...(depth !== undefined
        ? { depth }
        : previous?.depth !== undefined
          ? { depth: previous.depth }
          : parentId === null
            ? { depth: 0 }
            : {}),
      ...(usage === undefined ? {} : { usage }),
      controls: this.#controls,
      result: previous?.result ?? null,
      startedAt: restarted || previous === undefined ? now : previous.startedAt,
      completedAt: isTerminal(status) ? (previous?.completedAt ?? now) : null,
      updatedAt: now,
    };
    this.#subagents.set(id, { record, agent, description });
    if (previous !== undefined && sameRecord(previous, record)) return [];
    return [{ type: "subagent.updated", driver: OMP_PROVIDER, subagent: record }];
  }
}

/** Equal but for `updatedAt`: progress frames repeat a lot, and only changes are worth a write. */
function sameRecord(left: OrchestrationV2Subagent, right: OrchestrationV2Subagent): boolean {
  return (
    JSON.stringify({ ...left, updatedAt: null }) === JSON.stringify({ ...right, updatedAt: null })
  );
}

/** Text blocks of message content (a string, or `[{type: "text", text}]`). */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      const record = asRecord(block);
      if (record?.type === "text" && typeof record.text === "string") return record.text;
      if (record?.type === "image") return "[image]";
      return "";
    })
    .filter((text) => text.length > 0)
    .join("\n");
}

/** One transcript message as viewer entries: a reply's text and each tool call it made. */
export function ompTranscriptEntries(
  message: unknown,
): Array<OrchestrationV2SubagentTranscriptEntry> {
  const record = asRecord(message);
  if (record === undefined) return [];
  switch (record.role) {
    case "user":
    case "developer": {
      const text = contentText(record.content).trim();
      return text === "" ? [] : [{ role: "user", text: clip(text, ENTRY_CHARS) }];
    }
    case "assistant": {
      const entries: Array<OrchestrationV2SubagentTranscriptEntry> = [];
      const blocks = Array.isArray(record.content) ? record.content : [];
      for (const block of blocks) {
        const part = asRecord(block);
        if (part?.type === "text" && typeof part.text === "string" && part.text.trim() !== "") {
          entries.push({ role: "assistant", text: clip(part.text.trim(), ENTRY_CHARS) });
        } else if (part?.type === "toolCall" && typeof part.name === "string") {
          entries.push({
            role: "tool",
            toolName: part.name,
            text: clip(JSON.stringify(part.arguments ?? {}), ENTRY_CHARS),
          });
        }
      }
      return entries;
    }
    case "toolResult": {
      const text = contentText(record.content).trim();
      return [
        {
          role: "tool",
          ...(typeof record.toolName === "string" ? { toolName: record.toolName } : {}),
          text: clip(text, ENTRY_CHARS),
          ...(record.isError === true ? { isError: true } : {}),
        },
      ];
    }
    default: {
      // Summaries, bash/python runs and custom messages: shown as system notes when they say something.
      const text = (
        stringOf(record.summary) ??
        stringOf(record.output) ??
        contentText(record.content)
      ).trim();
      return text === "" ? [] : [{ role: "system", text: clip(text, ENTRY_CHARS) }];
    }
  }
}

/** A `get_subagent_messages` page for the agents panel. */
export function ompTranscriptPage(page: SubagentMessages): OrchestrationV2SubagentTranscriptPage {
  return {
    fromByte: Math.max(0, Math.trunc(page.fromByte)),
    nextByte: Math.max(0, Math.trunc(page.nextByte)),
    reset: page.reset,
    entries: page.messages.flatMap(ompTranscriptEntries),
  };
}
