import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { OMP_PROVIDER } from "./mapper.ts";
import {
  ompBranchTree,
  ompDroppedTurns,
  ompSessionEntries,
  ompTurnUserEntry,
  ompUncapturedTurnEntry,
} from "./sessionBranches.ts";

const at = (seconds: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2026, 9, 26, 10, 0, seconds)));

const entry = (id: string, parentId: string | null, role: string | null, seconds = 0) => ({
  id,
  parentId,
  timestamp: at(seconds),
  ...(role === null
    ? { type: "model_change", model: "fake/fake-model" }
    : { type: "message", message: { role, content: [{ type: "text", text: `${role} ${id}` }] } }),
});

const entries = (raw: ReadonlyArray<unknown>) => {
  const listed = ompSessionEntries(raw);
  assert.isNotNull(listed);
  return listed!;
};

const turn = (
  ordinal: number,
  nativeTurnRef: OrchestrationV2ProviderTurn["nativeTurnRef"],
  window: readonly [number, number] = [0, 0],
) =>
  ({
    id: `turn-${ordinal}`,
    ordinal,
    nativeTurnRef,
    startedAt: DateTime.makeUnsafe(at(window[0])),
    completedAt: DateTime.makeUnsafe(at(window[1])),
  }) as unknown as OrchestrationV2ProviderTurn;

const strong = (nativeId: string) =>
  ({ driver: OMP_PROVIDER, nativeId, strength: "strong" }) as const;

describe("OMP session branches", () => {
  it("rejects listings it cannot index", () => {
    assert.isNull(ompSessionEntries([{ id: "a", parentId: null }]));
    assert.isNull(ompSessionEntries([entry("a", null, "user"), entry("a", null, "user")]));
  });

  it("finds the user message a turn wrote after the previous leaf", () => {
    // The turn's prompt, a steering message, then the answer.
    const listed = entries([
      entry("u1", "a0", "user", 10),
      entry("a1", "u1", "assistant", 11),
      entry("u2", "a1", "user", 12),
      entry("a2", "u2", "assistant", 13),
    ]);
    assert.strictEqual(
      ompTurnUserEntry({ entries: listed, leafId: "a2", previousLeafId: "a0", turnStartedAt: 0 }),
      "u1",
    );
    // A builtin command appended nothing.
    assert.isNull(
      ompTurnUserEntry({
        entries: new Map(),
        leafId: "a0",
        previousLeafId: "a0",
        turnStartedAt: 0,
      }),
    );
    // The path does not lead back to the previous leaf: unknown.
    assert.isUndefined(
      ompTurnUserEntry({ entries: listed, leafId: "a2", previousLeafId: "x", turnStartedAt: 0 }),
    );
  });

  it("without a previous leaf stops at the first entry older than the turn", () => {
    const listed = entries([
      entry("m", null, null, 1),
      entry("u0", "m", "user", 2),
      entry("a0", "u0", "assistant", 3),
      entry("u1", "a0", "user", 10),
      entry("a1", "u1", "assistant", 11),
    ]);
    const startedAt = Date.parse(at(9));
    assert.strictEqual(
      ompTurnUserEntry({
        entries: listed,
        leafId: "a1",
        previousLeafId: undefined,
        turnStartedAt: startedAt,
      }),
      "u1",
    );
  });

  it("orders the turns a cut leaves out and skips those that wrote nothing", () => {
    const turns = [
      turn(3, strong("u3")),
      turn(1, strong("u1")),
      turn(2, null),
      turn(4, strong("u4")),
    ];
    assert.deepStrictEqual(
      ompDroppedTurns(1, turns).map((dropped) => dropped.ordinal),
      [3, 4],
    );
    assert.deepStrictEqual(
      ompDroppedTurns(0, turns).map((dropped) => dropped.ordinal),
      [1, 3, 4],
    );
  });

  it("finds an uncaptured turn's message by when it ran", () => {
    const listed = entries([
      entry("u1", null, "user", 1),
      entry("a1", "u1", "assistant", 2),
      entry("u2", "a1", "user", 5),
      entry("a2", "u2", "assistant", 6),
    ]);
    const weak = { driver: OMP_PROVIDER, nativeId: "synthetic", strength: "weak" } as const;
    assert.strictEqual(
      ompUncapturedTurnEntry({ entries: listed, leafId: "a2", turn: turn(2, weak, [4, 7]) }),
      "u2",
    );
    assert.isUndefined(
      ompUncapturedTurnEntry({ entries: listed, leafId: "a2", turn: turn(3, weak, [8, 9]) }),
    );
  });

  it("reduces get_tree to the conversation, with the active path to the leaf", () => {
    const node = (raw: ReturnType<typeof entry>, children: ReadonlyArray<unknown> = []) => ({
      entry: raw,
      children,
    });
    // m → u1 → a1 → { u2 → a2 (abandoned), branch summary → u3 → a3 (leaf) }
    const tree = ompBranchTree({
      tree: [
        node(entry("m", null, null), [
          node(entry("u1", "m", "user"), [
            node(entry("a1", "u1", "assistant"), [
              node(entry("u2", "a1", "user"), [node(entry("a2", "u2", "assistant"))]),
              node(
                {
                  id: "s",
                  parentId: "a1",
                  type: "branch_summary",
                  summary: "Tried\n  the other way",
                  timestamp: at(0),
                } as never,
                [node(entry("u3", "s", "user"), [node(entry("a3", "u3", "assistant"))])],
              ),
            ]),
          ]),
        ]),
      ],
      leafId: "a3",
    });
    assert.deepStrictEqual(
      tree.nodes.map((n) => [n.entryId, n.parentId, n.kind, n.preview]),
      [
        ["u1", null, "user", "user u1"],
        ["a1", "u1", "assistant", ""],
        ["u2", "a1", "user", "user u2"],
        ["a2", "u2", "assistant", ""],
        ["s", "a1", "branch_summary", "Tried the other way"],
        ["u3", "s", "user", "user u3"],
        ["a3", "u3", "assistant", ""],
      ],
    );
    assert.strictEqual(tree.leafId, "a3");
    assert.deepStrictEqual(tree.activePath, ["u1", "a1", "s", "u3", "a3"]);
  });
});
