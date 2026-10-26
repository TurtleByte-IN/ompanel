import {
  NodeId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

export const JOURNAL_INSTANCE_ID = ProviderInstanceId.make("omp-journal");
export const JOURNAL_THREAD_ID = ThreadId.make("thread/journal");
export const journalModelSelection = { instanceId: JOURNAL_INSTANCE_ID, model: "default" };
export const journalRuntimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const appThread = (
  providerThread: OrchestrationV2ProviderThread,
  now: DateTime.Utc,
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: JOURNAL_THREAD_ID,
  projectId: "project:omp" as OrchestrationV2AppThread["projectId"],
  title: "Journal thread",
  providerInstanceId: JOURNAL_INSTANCE_ID,
  modelSelection: journalModelSelection,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: providerThread.id,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: JOURNAL_THREAD_ID },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** Turn `ordinal`; `continuation` is the turn T3 runs for a run OMP started on its own. */
export const journalTurnInput = (
  providerThread: OrchestrationV2ProviderThread,
  ordinal: number,
  now: DateTime.Utc,
  continuation = false,
): ProviderAdapter.ProviderAdapterV2TurnInput => ({
  appThread: appThread(providerThread, now),
  threadId: JOURNAL_THREAD_ID,
  runId: RunId.make(`run:journal:${ordinal}`),
  runOrdinal: ordinal,
  providerTurnOrdinal: ordinal,
  attemptId: RunAttemptId.make(`run-attempt:journal:${ordinal}`),
  rootNodeId: NodeId.make(`node:journal:${ordinal}`),
  providerThread,
  message: {
    messageId: `message:journal:${ordinal}` as never,
    text: continuation ? "Background task completed." : `Prompt ${ordinal}`,
    attachments: [],
    createdBy: continuation ? "agent" : "user",
    creationSource: continuation ? "provider" : "web",
  },
  modelSelection: journalModelSelection,
  runtimePolicy: journalRuntimePolicy,
});

const encodeEvent = Schema.encodeSync(Schema.toCodecJson(ProviderAdapter.ProviderAdapterV2Event));

/** The record an event updates in a thread view: one row per entity, the latest write wins. */
const rowKey = (event: ProviderAdapter.ProviderAdapterV2Event): string => {
  switch (event.type) {
    case "app_thread.created":
      return `app_thread:${event.appThread.id}`;
    case "provider_session.updated":
      return `provider_session:${event.providerSession.id}`;
    case "provider_thread.updated":
      return `provider_thread:${event.providerThread.id}`;
    case "provider_turn.updated":
      return `provider_turn:${event.providerTurn.id}`;
    case "node.updated":
      return `node:${event.node.id}`;
    case "subagent.updated":
      return `subagent:${event.subagent.id}`;
    case "message.updated":
      return `message:${event.message.id}`;
    case "turn_item.updated":
      return `turn_item:${event.turnItem.id}`;
    case "command_output.delta":
      return `command_output:${event.itemId}`;
    case "runtime_request.updated":
      return `runtime_request:${event.runtimeRequest.id}`;
    case "plan.updated":
      return `plan:${event.plan.id}`;
    case "turn.terminal":
      return `terminal:${event.providerTurnId}`;
  }
};

/**
 * What a client showing the thread keeps after applying `events`: every entity's latest state,
 * JSON-encoded so dates compare as text. `command_output.delta` is left out: it is live-only
 * (never persisted), and the card's whole output arrives with its `turn_item.updated`.
 */
export function ompThreadView(
  events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>,
): Record<string, unknown> {
  const rows = new Map<string, unknown>();
  for (const event of events) {
    if (event.type !== "command_output.delta") rows.set(rowKey(event), encodeEvent(event));
  }
  return Object.fromEntries([...rows].toSorted(([left], [right]) => left.localeCompare(right)));
}
