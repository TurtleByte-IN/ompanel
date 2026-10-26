/**
 * Rewind and fork over OMP's session tree (docs/omp/sessions.md): each turn records its user
 * message entry, rewind `branch`es before the next turn's, fork `fork`s through the turn.
 */
import type { OmpBranchNode, OmpBranchTree, OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type {
  AgentMessage,
  BranchMessage,
  SessionTree,
} from "../../contract/src/wire.generated.ts";
import type { OmpRpcProcess } from "./rpcProcess.ts";

/** One session entry, reduced to what rewind and fork read. */
export interface OmpSessionEntry {
  readonly id: string;
  readonly parentId: string | null;
  readonly type: string;
  /** The message role of a `message` entry. */
  readonly role: AgentMessage["role"] | null;
  /** OMP's `timestamp` in epoch milliseconds; null when missing or unparsable. */
  readonly timestamp: number | null;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;

const parseTimestamp = (value: unknown) =>
  typeof value === "string"
    ? Option.getOrNull(Option.map(DateTime.make(value), DateTime.toEpochMillis))
    : null;

/**
 * Raw `get_entries` (or `get_tree`) entries by id; null when one lacks an id or repeats one, in
 * which case nothing read from the listing can be trusted.
 */
export function ompSessionEntries(
  raw: ReadonlyArray<unknown>,
): ReadonlyMap<string, OmpSessionEntry> | null {
  const entries = new Map<string, OmpSessionEntry>();
  for (const entry of raw) {
    const id = field(entry, "id");
    const parentId = field(entry, "parentId") ?? null;
    const type = field(entry, "type");
    if (typeof id !== "string" || entries.has(id) || typeof type !== "string") return null;
    if (parentId !== null && typeof parentId !== "string") return null;
    const role = type === "message" ? field(field(entry, "message"), "role") : undefined;
    entries.set(id, {
      id,
      parentId,
      type,
      role: typeof role === "string" ? (role as AgentMessage["role"]) : null,
      timestamp: parseTimestamp(field(entry, "timestamp")),
    });
  }
  return entries;
}

const isUserMessage = (entry: OmpSessionEntry) => entry.type === "message" && entry.role === "user";

/**
 * The earliest user entry on the path from `leafId` back to the leaf before the turn (unknown:
 * back to the first entry older than the turn). Null: the turn wrote no user message; undefined:
 * the path does not lead back to the previous leaf.
 */
export function ompTurnUserEntry(input: {
  readonly entries: ReadonlyMap<string, OmpSessionEntry>;
  readonly leafId: string | null;
  /** The leaf before the turn; undefined when unknown. */
  readonly previousLeafId: string | null | undefined;
  readonly turnStartedAt: number;
}): string | null | undefined {
  const { entries, previousLeafId } = input;
  let earliest: string | null = null;
  let current = input.leafId;
  const seen = new Set<string>();
  while (current !== null && current !== previousLeafId) {
    const entry = entries.get(current);
    if (entry === undefined || seen.has(current)) break;
    seen.add(current);
    if (
      previousLeafId === undefined &&
      entry.timestamp !== null &&
      entry.timestamp < input.turnStartedAt
    ) {
      return earliest;
    }
    if (isUserMessage(entry)) earliest = entry.id;
    current = entry.parentId;
  }
  if (previousLeafId === undefined) return current === null ? earliest : undefined;
  return current === previousLeafId ? earliest : undefined;
}

/**
 * The turns a rewind or fork leaves out, in order: those after `keepThroughOrdinal` (0 keeps
 * none) that may have written a user message. A turn whose ref is null wrote none (a builtin
 * command); one still carrying the synthetic weak ref was never captured.
 */
export function ompDroppedTurns(
  keepThroughOrdinal: number,
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
): ReadonlyArray<OrchestrationV2ProviderTurn> {
  return turns
    .filter((turn) => turn.ordinal > keepThroughOrdinal && turn.nativeTurnRef !== null)
    .toSorted((a, b) => a.ordinal - b.ordinal);
}

/**
 * For a turn recorded before its entry was captured: the earliest user message on the session's
 * current path written while the turn ran (OMP and Ompanel share the clock). Undefined when there
 * is none or a timestamp is missing.
 */
export function ompUncapturedTurnEntry(input: {
  readonly entries: ReadonlyMap<string, OmpSessionEntry>;
  readonly leafId: string | null;
  readonly turn: OrchestrationV2ProviderTurn;
}): string | undefined {
  const { startedAt, completedAt } = input.turn;
  if (startedAt === null) return undefined;
  const from = DateTime.toEpochMillis(startedAt);
  const to = completedAt === null ? Infinity : DateTime.toEpochMillis(completedAt);
  let found: string | undefined;
  let current = input.leafId;
  const seen = new Set<string>();
  while (current !== null) {
    const entry = input.entries.get(current);
    if (entry === undefined || seen.has(current)) return undefined;
    seen.add(current);
    if (isUserMessage(entry)) {
      if (entry.timestamp === null) return undefined;
      if (entry.timestamp >= from && entry.timestamp <= to) found = entry.id;
    }
    current = entry.parentId;
  }
  return found;
}

/** The session tree did not hold what a rewind or fork needs. */
export class OmpSessionTreeError extends Schema.TaggedError<OmpSessionTreeError>()(
  "OmpSessionTreeError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const cutError = (detail: string) => Effect.fail(new OmpSessionTreeError({ detail }));

/** Where a rewind or fork cuts the live session. */
export interface OmpCut {
  /** The first left-out user message; null keeps the whole session. */
  readonly entryId: string | null;
  /** The session's user messages in order (`get_branch_messages`). */
  readonly userMessages: ReadonlyArray<BranchMessage>;
}

/**
 * Finds the cut in the session the process runs: the user message of the first left-out turn
 * that is still in it. A captured turn whose message is gone (an earlier rewind dropped it) left
 * nothing here and is skipped; an uncaptured one is found by its time window in the full entry
 * listing, read only then.
 */
export const resolveOmpCut = Effect.fnUntraced(function* (input: {
  readonly process: Pick<OmpRpcProcess, "request">;
  readonly dropped: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly timeoutMs: number;
}) {
  const { messages } = yield* input.process.request("get_branch_messages", undefined, {
    timeoutMs: input.timeoutMs,
  });
  const present = new Set(messages.map((message) => message.entryId));
  let listing: { entries: ReadonlyMap<string, OmpSessionEntry>; leafId: string | null } | null =
    null;
  for (const turn of input.dropped) {
    const ref = turn.nativeTurnRef;
    if (ref == null) continue;
    if (ref.strength === "strong" && ref.nativeId !== null) {
      if (present.has(ref.nativeId)) {
        return { entryId: ref.nativeId, userMessages: messages } satisfies OmpCut;
      }
      continue;
    }
    if (listing === null) {
      const raw = yield* input.process.request("get_entries", {}, { timeoutMs: input.timeoutMs });
      const entries = ompSessionEntries(raw.entries);
      if (entries === null) return yield* cutError("OMP listed session entries it cannot index");
      listing = { entries, leafId: raw.leafId };
    }
    const entryId = ompUncapturedTurnEntry({ ...listing, turn });
    if (entryId !== undefined) return { entryId, userMessages: messages } satisfies OmpCut;
  }
  return { entryId: null, userMessages: messages } satisfies OmpCut;
});

/**
 * The entry `fork {entryId}` keeps through so that `cut.entryId` and everything after it are
 * left out: the nearest message entry before it (`fork` only accepts message entries). Only the
 * entries after the previous user message are listed. Null when no message precedes the cut.
 */
export const resolveOmpForkEntry = Effect.fnUntraced(function* (input: {
  readonly process: Pick<OmpRpcProcess, "request">;
  readonly cut: OmpCut & { readonly entryId: string };
  readonly timeoutMs: number;
}) {
  const index = input.cut.userMessages.findIndex(
    (message) => message.entryId === input.cut.entryId,
  );
  const previousUser = index > 0 ? input.cut.userMessages[index - 1]!.entryId : undefined;
  const raw = yield* input.process.request(
    "get_entries",
    previousUser === undefined ? {} : { since: previousUser },
    { timeoutMs: input.timeoutMs },
  );
  const entries = ompSessionEntries(raw.entries);
  const cut = entries?.get(input.cut.entryId);
  if (entries === null || cut === undefined) {
    return yield* cutError(
      `OMP did not list the session entry ${input.cut.entryId} to fork before`,
    );
  }
  const seen = new Set<string>();
  for (let current = cut.parentId; current !== null;) {
    if (current === previousUser) return current;
    const entry = entries.get(current);
    if (entry === undefined || seen.has(current)) {
      return yield* cutError(`OMP session entry ${input.cut.entryId} has a broken parent chain`);
    }
    seen.add(current);
    if (entry.type === "message") return entry.id;
    current = entry.parentId;
  }
  return null;
});

const PREVIEW_CHARS = 160;

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      field(block, "type") === "text" ? [String(field(block, "text") ?? "")] : [],
    )
    .join("");
};

const preview = (text: string) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1)}…`;
};

function branchNodeKind(entry: unknown): { kind: OmpBranchNode["kind"]; text: string } | null {
  const type = field(entry, "type");
  if (type === "message") {
    const message = field(entry, "message");
    const role = field(message, "role");
    if (role === "user") return { kind: "user", text: textOf(field(message, "content")) };
    if (role === "assistant") return { kind: "assistant", text: "" };
    return null;
  }
  if (type === "branch_summary")
    return { kind: "branch_summary", text: String(field(entry, "summary") ?? "") };
  if (type === "compaction")
    return { kind: "compaction", text: String(field(entry, "summary") ?? "") };
  return null;
}

/**
 * Reduces `get_tree` to P-06's branch view; iterative, so a long session cannot exhaust the
 * stack. `nodes` are in depth-first order, parents first; the tree's other entries (tool
 * results, model and setting changes, labels) are folded into their nearest kept ancestor.
 * `activePath` runs from the root to the leaf the session continues from.
 */
export function ompBranchTree(tree: SessionTree): OmpBranchTree {
  const nodes: Array<OmpBranchNode> = [];
  /** Kept ancestor of every entry, for the leaf's path. */
  const keptAncestor = new Map<string, string | null>();
  const keptParent = new Map<string, string | null>();
  const stack: Array<{ readonly node: unknown; readonly parentId: string | null }> = tree.tree
    .toReversed()
    .map((node) => ({ node, parentId: null }));
  while (stack.length > 0) {
    const { node, parentId } = stack.pop()!;
    const entry = field(node, "entry");
    const id = field(entry, "id");
    if (typeof id !== "string") continue;
    const kind = branchNodeKind(entry);
    let childParent = parentId;
    if (kind !== null) {
      const label = field(node, "label");
      const timestamp = field(entry, "timestamp");
      nodes.push({
        entryId: id,
        parentId,
        kind: kind.kind,
        preview: preview(kind.text),
        timestamp: typeof timestamp === "string" ? timestamp : null,
        label: typeof label === "string" ? label : null,
      });
      keptParent.set(id, parentId);
      childParent = id;
    }
    keptAncestor.set(id, childParent);
    const children = field(node, "children");
    if (Array.isArray(children)) {
      for (let index = children.length - 1; index >= 0; index--) {
        stack.push({ node: children[index], parentId: childParent });
      }
    }
  }
  const leafId = tree.leafId === null ? null : (keptAncestor.get(tree.leafId) ?? null);
  const activePath: Array<string> = [];
  for (let current = leafId; current !== null; current = keptParent.get(current) ?? null) {
    activePath.push(current);
  }
  return { nodes, leafId, activePath: activePath.toReversed() };
}

/** The live session's branch tree (`get_tree`). */
export const readOmpBranchTree = (process: Pick<OmpRpcProcess, "request">, timeoutMs: number) =>
  process.request("get_tree", undefined, { timeoutMs }).pipe(Effect.map(ompBranchTree));
