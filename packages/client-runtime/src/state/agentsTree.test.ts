import { NodeId, type OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  type AgentsTreeNode,
  type AgentsTreeSubagent,
  buildAgentsTree,
  canKill,
  canRevive,
  canSteer,
  flattenAgentsTree,
  isSubagentActive,
} from "./agentsTree.ts";

const agent = (
  id: string,
  parent: string,
  startedAtMs: number | null,
  depth?: number,
): AgentsTreeSubagent => ({
  id: NodeId.make(id),
  parentNodeId: NodeId.make(parent),
  startedAt: startedAtMs === null ? null : DateTime.makeUnsafe(startedAtMs),
  ...(depth === undefined ? {} : { depth }),
});

const shape = (nodes: ReadonlyArray<AgentsTreeNode<AgentsTreeSubagent>>): ReadonlyArray<unknown> =>
  nodes.map((node) =>
    node.children.length === 0
      ? `${node.subagent.id}@${node.depth}`
      : [`${node.subagent.id}@${node.depth}`, shape(node.children)],
  );

describe("buildAgentsTree", () => {
  it("nests three levels by parentNodeId", () => {
    const tree = buildAgentsTree([
      agent("grandchild", "child", 3),
      agent("child", "root", 2),
      agent("root", "thread-agent", 1),
    ]);
    expect(shape(tree)).toEqual([["root@0", [["child@1", ["grandchild@2"]]]]]);
  });

  it("makes a subagent whose parent is unknown a root", () => {
    const tree = buildAgentsTree([agent("root", "thread-agent", 1), agent("orphan", "gone", 2)]);
    expect(shape(tree)).toEqual(["root@0", "orphan@0"]);
  });

  it("orders siblings by start time, unstarted last, then id", () => {
    const tree = buildAgentsTree([
      agent("unstarted-b", "thread-agent", null),
      agent("late", "thread-agent", 20),
      agent("unstarted-a", "thread-agent", null),
      agent("tie-b", "thread-agent", 10),
      agent("tie-a", "thread-agent", 10),
    ]);
    expect(shape(tree)).toEqual(["tie-a@0", "tie-b@0", "late@0", "unstarted-a@0", "unstarted-b@0"]);
  });

  it("uses the reported depth only to break start-time ties", () => {
    const tree = buildAgentsTree([
      agent("b", "thread-agent", 5, 0),
      agent("a", "thread-agent", 5, 2),
    ]);
    expect(shape(tree)).toEqual(["b@0", "a@0"]);
  });

  it("computes depth from the tree, not the reported field", () => {
    const tree = buildAgentsTree([
      agent("root", "thread-agent", 1, 4),
      agent("child", "root", 2, 0),
    ]);
    expect(shape(tree)).toEqual([["root@0", ["child@1"]]]);
  });

  it("breaks parent cycles and keeps every subagent once", () => {
    const tree = buildAgentsTree([
      agent("a", "c", 1),
      agent("b", "a", 2),
      agent("c", "b", 3),
      agent("self", "self", 4),
      agent("root", "thread-agent", 5),
    ]);
    expect(shape(tree)).toEqual([["a@0", [["b@1", ["c@2"]]]], "self@0", "root@0"]);
    expect(flattenAgentsTree(tree).map((node) => node.subagent.id)).toEqual([
      "a",
      "b",
      "c",
      "self",
      "root",
    ]);
  });
});

describe("subagent action rules", () => {
  const allControls = { transcript: true, steer: true, kill: true, revive: true };
  const statuses: ReadonlyArray<OrchestrationV2Subagent["status"]> = [
    "idle",
    "pending",
    "running",
    "waiting",
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ];

  it("steers and kills only active subagents and revives only finished ones", () => {
    const table = statuses.map((status) => {
      const subagent = { status, controls: allControls };
      return [
        status,
        isSubagentActive(status),
        canSteer(subagent),
        canKill(subagent),
        canRevive(subagent),
      ];
    });
    expect(table).toEqual([
      ["idle", false, false, false, false],
      ["pending", true, true, true, false],
      ["running", true, true, true, false],
      ["waiting", true, true, true, false],
      ["completed", false, false, false, true],
      ["failed", false, false, false, true],
      ["cancelled", false, false, false, true],
      ["interrupted", false, false, false, true],
    ]);
  });

  it("needs the provider to offer each control", () => {
    const running = { status: "running" as const };
    const done = { status: "completed" as const };
    const none = { transcript: true, steer: false, kill: false, revive: false };
    expect([canSteer(running), canKill(running), canRevive(done)]).toEqual([false, false, false]);
    expect([
      canSteer({ ...running, controls: none }),
      canKill({ ...running, controls: none }),
      canRevive({ ...done, controls: none }),
    ]).toEqual([false, false, false]);
  });
});
