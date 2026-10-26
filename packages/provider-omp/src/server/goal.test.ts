import { assert, describe, it } from "@effect/vitest";

import type { Goal } from "../../contract/src/wire.generated.ts";
import { ompGoalReply, ompProviderGoal } from "./goal.ts";
import { ompBooleanTraitDescriptors } from "./modelTraits.ts";
import { OmpSubagentTracker } from "./subagents.ts";
import { OMP_VIBE_CONTRACT } from "./vibe.ts";
import { ProviderInstanceId, ProviderThreadId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const goal = (status: Goal["status"], extra: Partial<Goal> = {}): Goal => ({
  id: "goal-1",
  objective: "  Ship the release notes ",
  status,
  tokensUsed: 1_200.7,
  timeUsedSeconds: 125,
  createdAt: 0,
  updatedAt: 0,
  ...extra,
});

describe("OMP goal as the provider thread's goal", () => {
  it.each([
    ["active", "active"],
    ["paused", "paused"],
    ["budget-limited", "budget_limited"],
    ["complete", "complete"],
  ] as const)("maps status %s to %s", (status, expected) => {
    assert.strictEqual(ompProviderGoal(goal(status))?.status, expected);
  });

  it("keeps the objective, whole-number usage and the budget", () => {
    assert.deepStrictEqual(ompProviderGoal(goal("active", { tokenBudget: 50_000 })), {
      objective: "Ship the release notes",
      status: "active",
      tokenBudget: 50_000,
      tokensUsed: 1_200,
      timeUsedSeconds: 125,
    });
  });

  it("has no goal for none, a dropped goal or a blank objective", () => {
    assert.isNull(ompProviderGoal(null));
    assert.isNull(ompProviderGoal(undefined));
    assert.isNull(ompProviderGoal(goal("dropped")));
    assert.isNull(ompProviderGoal(goal("active", { objective: "  " })));
  });
});

describe("OMP goal command replies", () => {
  it("reports the goal, its status and what it used", () => {
    const result = { goal: goal("active", { tokenBudget: 50_000 }), state: null };
    assert.strictEqual(
      ompGoalReply("get", result),
      "Goal active: Ship the release notes\n1,200 of 50,000 tokens used · 2m 5s",
    );
    assert.isTrue(ompGoalReply("pause", result).startsWith("Goal paused: "));
    assert.isTrue(ompGoalReply("resume", result).startsWith("Goal resumed: "));
  });

  it("says when there is no goal, and when one was dropped", () => {
    assert.strictEqual(
      ompGoalReply("get", { goal: null, state: null }),
      "No goal is set. Set one with /goal <objective>.",
    );
    assert.strictEqual(ompGoalReply("drop", { goal: null, state: null }), "Goal dropped.");
  });
});

describe("OMP vibe mode", () => {
  it("offers the Vibe Mode trait only from the vibe contract on", () => {
    const ids = (version: string) => ompBooleanTraitDescriptors(version).map((trait) => trait.id);
    assert.deepStrictEqual(ids("1.6.0"), ["fastMode", "advisor", "prewalk", "computer"]);
    assert.deepStrictEqual(ids(OMP_VIBE_CONTRACT), [
      "fastMode",
      "advisor",
      "prewalk",
      "computer",
      "vibe",
    ]);
  });

  it("nests vibe workers under the vibe_spawn call and names them by flavour", () => {
    const tracker = new OmpSubagentTracker({
      instanceId: ProviderInstanceId.make("omp-work"),
      controls: { transcript: true, steer: true, kill: true, revive: true },
    });
    const scope = {
      threadId: ThreadId.make("thread/vibe"),
      providerThreadId: ProviderThreadId.make("provider-thread/vibe"),
      runId: null,
      rootNodeId: null,
    };
    const now = DateTime.makeUnsafe(0);
    const [spawned] = tracker.handleFrame(
      {
        type: "subagent_lifecycle",
        payload: {
          id: "QuickFox",
          agent: "sonic",
          description: "vibe fast session",
          status: "started",
          parentId: null,
          depth: 0,
          parentToolCallId: "call-vibe-spawn",
          assignment: "Rename the helper",
        },
      },
      scope,
      now,
    );
    const [plain] = tracker.handleFrame(
      {
        type: "subagent_lifecycle",
        payload: {
          id: "Scout",
          agent: "scout",
          description: "Map the parser",
          status: "started",
          parentToolCallId: "call-task",
        },
      },
      scope,
      now,
    );
    assert.strictEqual(
      spawned?.type === "subagent.updated" && spawned.subagent.title,
      "QuickFox: Vibe fast worker",
    );
    assert.strictEqual(
      spawned?.type === "subagent.updated" && spawned.subagent.prompt,
      "Rename the helper",
    );
    assert.notStrictEqual(
      spawned?.type === "subagent.updated" && spawned.subagent.parentNodeId,
      plain?.type === "subagent.updated" && plain.subagent.parentNodeId,
    );
    assert.strictEqual(
      plain?.type === "subagent.updated" && plain.subagent.title,
      "Scout: Map the parser",
    );
  });
});
