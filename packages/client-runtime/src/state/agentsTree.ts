// The agents panel's view model, shared by the web and mobile clients: a thread's
// provider-native subagents as a tree, their controls, and incremental transcript paging.
import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentTranscriptEntry,
  OrchestrationV2SubagentTranscriptPage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

type SubagentStatus = OrchestrationV2Subagent["status"];

/** The fields the tree reads, so callers and tests can pass partial subagents. */
export type AgentsTreeSubagent = Pick<
  OrchestrationV2Subagent,
  "id" | "parentNodeId" | "startedAt"
> &
  Partial<Pick<OrchestrationV2Subagent, "depth">>;

export interface AgentsTreeNode<Subagent extends AgentsTreeSubagent> {
  readonly subagent: Subagent;
  /** Position in the tree: 0 for a root. */
  readonly depth: number;
  readonly children: ReadonlyArray<AgentsTreeNode<Subagent>>;
}

const ACTIVE_STATUS: Record<SubagentStatus, boolean> = {
  idle: false,
  pending: true,
  running: true,
  waiting: true,
  completed: false,
  failed: false,
  cancelled: false,
  interrupted: false,
};
const REVIVABLE_STATUS: Record<SubagentStatus, boolean> = {
  idle: false,
  pending: false,
  running: false,
  waiting: false,
  completed: true,
  failed: true,
  cancelled: true,
  interrupted: true,
};

function compareSubagents(left: AgentsTreeSubagent, right: AgentsTreeSubagent): number {
  if (left.startedAt !== null && right.startedAt !== null) {
    const byStart =
      DateTime.toEpochMillis(left.startedAt) - DateTime.toEpochMillis(right.startedAt);
    if (byStart !== 0) return byStart;
  } else if (left.startedAt !== right.startedAt) {
    // Not started yet sorts after everything that has.
    return left.startedAt === null ? 1 : -1;
  }
  // The provider's own nesting only breaks ties; the tree position is what the row shows.
  const byDepth = (left.depth ?? 0) - (right.depth ?? 0);
  if (byDepth !== 0) return byDepth;
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * Links subagents by `parentNodeId`: a subagent whose parent is another subagent is its child;
 * any other (the thread's agent, or a parent not yet received) is a root. Siblings are ordered
 * by start time (unstarted last), then id. A parent cycle is broken at its earliest member,
 * so every subagent appears exactly once.
 */
export function buildAgentsTree<Subagent extends AgentsTreeSubagent>(
  subagents: ReadonlyArray<Subagent>,
): ReadonlyArray<AgentsTreeNode<Subagent>> {
  const sorted = subagents.toSorted(compareSubagents);
  const byId = new Map(sorted.map((subagent) => [subagent.id, subagent]));
  const childrenByParent = new Map<string, Subagent[]>();
  const roots: Subagent[] = [];
  for (const subagent of sorted) {
    if (subagent.parentNodeId === subagent.id || !byId.has(subagent.parentNodeId)) {
      roots.push(subagent);
      continue;
    }
    const siblings = childrenByParent.get(subagent.parentNodeId);
    if (siblings) siblings.push(subagent);
    else childrenByParent.set(subagent.parentNodeId, [subagent]);
  }

  const placed = new Set<string>();
  const place = (subagent: Subagent, depth: number): AgentsTreeNode<Subagent> => {
    placed.add(subagent.id);
    const children = (childrenByParent.get(subagent.id) ?? [])
      .filter((child) => !placed.has(child.id))
      .map((child) => place(child, depth + 1));
    return { subagent, depth, children };
  };

  const tree = roots.map((root) => place(root, 0));
  // Members of a parent cycle are unreachable from any root.
  for (const subagent of sorted) {
    if (!placed.has(subagent.id)) tree.push(place(subagent, 0));
  }
  return tree.toSorted((left, right) => compareSubagents(left.subagent, right.subagent));
}

/** Depth-first rows in display order, for an indented list. */
export function flattenAgentsTree<Subagent extends AgentsTreeSubagent>(
  tree: ReadonlyArray<AgentsTreeNode<Subagent>>,
): ReadonlyArray<AgentsTreeNode<Subagent>> {
  return tree.flatMap((node) => [node, ...flattenAgentsTree(node.children)]);
}

export function isSubagentActive(status: SubagentStatus): boolean {
  return ACTIVE_STATUS[status];
}

type ControlledSubagent = Pick<OrchestrationV2Subagent, "status" | "controls">;

export function canSteer(subagent: ControlledSubagent): boolean {
  return subagent.controls?.steer === true && isSubagentActive(subagent.status);
}

export function canKill(subagent: ControlledSubagent): boolean {
  return subagent.controls?.kill === true && isSubagentActive(subagent.status);
}

export function canRevive(subagent: ControlledSubagent): boolean {
  return subagent.controls?.revive === true && REVIVABLE_STATUS[subagent.status];
}

/** How often a client re-reads a running subagent's transcript. */
export const SUBAGENT_TRANSCRIPT_POLL_MS = 1500;

export interface SubagentTranscriptState {
  readonly entries: ReadonlyArray<OrchestrationV2SubagentTranscriptEntry>;
  /** Where the next read starts: the last applied page's `nextByte`. */
  readonly nextByte: number;
}

export const EMPTY_SUBAGENT_TRANSCRIPT: SubagentTranscriptState = { entries: [], nextByte: 0 };

/**
 * Folds one page into the transcript. `reset` replaces everything (the provider rewrote the
 * transcript); otherwise a page that does not start where the last one ended is stale and dropped.
 */
export function applyTranscriptPage(
  state: SubagentTranscriptState,
  page: OrchestrationV2SubagentTranscriptPage,
): SubagentTranscriptState {
  if (page.reset) return { entries: page.entries, nextByte: page.nextByte };
  if (page.fromByte !== state.nextByte) return state;
  if (page.entries.length === 0 && page.nextByte === state.nextByte) return state;
  return { entries: [...state.entries, ...page.entries], nextByte: page.nextByte };
}
