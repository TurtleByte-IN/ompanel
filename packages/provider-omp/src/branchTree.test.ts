import { assert, describe, it } from "@effect/vitest";
import type { OmpBranchNode, OmpBranchTree } from "@t3tools/contracts";

import { ompBranchCount, ompBranchNodeLabel, ompBranchTreeRows } from "./branchTree.ts";

const node = (
  entryId: string,
  parentId: string | null,
  kind: OmpBranchNode["kind"] = "user",
  preview = entryId,
): OmpBranchNode => ({ entryId, parentId, kind, preview, timestamp: null, label: null });

const tree = (nodes: ReadonlyArray<OmpBranchNode>): OmpBranchTree => ({
  nodes,
  leafId: null,
  activePath: [],
});

const shape = (input: OmpBranchTree) =>
  ompBranchTreeRows(input).map((row) => `${row.node.entryId}:${row.depth}${row.fork ? "*" : ""}`);

describe("ompBranchTreeRows", () => {
  it("keeps a straight conversation on one line", () => {
    assert.deepStrictEqual(shape(tree([node("a", null), node("b", "a"), node("c", "b")])), [
      "a:0",
      "b:0",
      "c:0",
    ]);
  });

  it("indents a fork's children, depth first, in their order", () => {
    const rows = shape(
      tree([
        node("a", null),
        node("b", "a"),
        node("c", "a"),
        node("b1", "b"),
        node("c1", "c"),
        node("c2", "c"),
      ]),
    );
    assert.deepStrictEqual(rows, ["a:0*", "b:1", "b1:1", "c:1*", "c1:2", "c2:2"]);
  });

  it("lists several roots in order", () => {
    assert.deepStrictEqual(shape(tree([node("r1", null), node("r2", null)])), ["r1:0", "r2:0"]);
  });

  it("returns nothing for an empty tree", () => {
    assert.deepStrictEqual(ompBranchTreeRows(tree([])), []);
  });
});

describe("ompBranchCount", () => {
  it("counts one branch plus one per fork", () => {
    assert.strictEqual(ompBranchCount(ompBranchTreeRows(tree([node("a", null)]))), 1);
    const forked = tree([node("a", null), node("b", "a"), node("c", "a")]);
    assert.strictEqual(ompBranchCount(ompBranchTreeRows(forked)), 2);
  });
});

describe("ompBranchNodeLabel", () => {
  it("prefers the label, then the preview, then the kind", () => {
    assert.strictEqual(ompBranchNodeLabel({ ...node("a", null), label: "Named" }), "Named");
    assert.strictEqual(ompBranchNodeLabel(node("a", null, "user", "Hello")), "Hello");
    assert.strictEqual(ompBranchNodeLabel(node("a", null, "assistant", "")), "Reply");
    assert.strictEqual(ompBranchNodeLabel(node("a", null, "compaction", "")), "Compaction");
  });
});
