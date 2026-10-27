/**
 * Rows of an OMP session's branch tree (docs/omp/thread-menu.md), as the web and mobile
 * Branch tree views list them.
 */
import type { OmpBranchNode, OmpBranchTree } from "@t3tools/contracts";

export interface OmpBranchTreeRow {
  readonly node: OmpBranchNode;
  /** Indent level: only a fork indents, a lone child continues its parent's line. */
  readonly depth: number;
  /** The node has more than one child. */
  readonly fork: boolean;
}

/** What a node shows when it has neither a label nor a preview. */
export const OMP_BRANCH_NODE_FALLBACK_LABELS = {
  user: "Message",
  assistant: "Reply",
  branch_summary: "Branch summary",
  compaction: "Compaction",
} as const satisfies Record<OmpBranchNode["kind"], string>;

/** A node's row text: its label, else its preview, else what kind of node it is. */
export function ompBranchNodeLabel(node: OmpBranchNode): string {
  return node.label ?? (node.preview || OMP_BRANCH_NODE_FALLBACK_LABELS[node.kind]);
}

/** Depth-first rows with their depth; `nodes` are parents first, so one pass orders them. */
export function ompBranchTreeRows(tree: OmpBranchTree): ReadonlyArray<OmpBranchTreeRow> {
  const children = new Map<string | null, Array<OmpBranchNode>>();
  for (const node of tree.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const rows: Array<OmpBranchTreeRow> = [];
  const stack: Array<{ node: OmpBranchNode; depth: number }> = [];
  const pushReversed = (nodes: ReadonlyArray<OmpBranchNode>, depth: number) => {
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      stack.push({ node: nodes[index]!, depth });
    }
  };
  pushReversed(children.get(null) ?? [], 0);
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    const below = children.get(node.entryId) ?? [];
    const fork = below.length > 1;
    rows.push({ node, depth, fork });
    pushReversed(below, fork ? depth + 1 : depth);
  }
  return rows;
}

/** How many branches the tree has: one, plus one per fork. */
export function ompBranchCount(rows: ReadonlyArray<OmpBranchTreeRow>): number {
  let forks = 0;
  for (const row of rows) if (row.fork) forks += 1;
  return forks + 1;
}
