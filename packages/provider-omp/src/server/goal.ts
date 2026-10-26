/**
 * OMP goal mode for T: the goal as the provider thread's `goal`, and what a `/goal` command
 * answers in the thread. docs/omp/composer.md#goal-mode.
 */
import type {
  OrchestrationV2ProviderGoal,
  OrchestrationV2ProviderGoalStatus,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import type { OmpGoalCommand } from "../composer.ts";
import type {
  Goal,
  GoalModeState,
  GoalResult,
  GoalStatus,
} from "../../contract/src/wire.generated.ts";

/** OMP's goal statuses as T's; a dropped goal is no goal. */
const GOAL_STATUS: Readonly<Record<GoalStatus, OrchestrationV2ProviderGoalStatus | null>> = {
  active: "active",
  paused: "paused",
  "budget-limited": "budget_limited",
  complete: "complete",
  dropped: null,
};

const count = (value: number | undefined) =>
  value === undefined || !Number.isFinite(value) ? undefined : Math.max(0, Math.trunc(value));

/** OMP's goal as the provider thread's goal; no goal, a dropped one or a blank objective is null. */
export function ompProviderGoal(goal: Goal | null | undefined): OrchestrationV2ProviderGoal | null {
  if (goal == null) return null;
  const objective = goal.objective.trim();
  const status = GOAL_STATUS[goal.status] ?? null;
  if (objective === "" || status === null) return null;
  const tokensUsed = count(goal.tokensUsed);
  const timeUsedSeconds = count(goal.timeUsedSeconds);
  return {
    objective,
    status,
    tokenBudget: count(goal.tokenBudget) ?? null,
    ...(tokensUsed === undefined ? {} : { tokensUsed }),
    ...(timeUsedSeconds === undefined ? {} : { timeUsedSeconds }),
  };
}

/**
 * The goal `get_state` reports, given the one the thread shows. OMP forgets a completed goal
 * once the turn that completed it ends; the thread keeps showing it complete until the next goal
 * or a drop (both arrive as `goal_updated`).
 */
export function ompStateGoal(
  reported: GoalModeState | null | undefined,
  current: OrchestrationV2ProviderGoal | null | undefined,
): OrchestrationV2ProviderGoal | null {
  const next = ompProviderGoal(reported?.goal);
  return next === null && current?.status === "complete" ? current : next;
}

const STATUS_WORDS: Readonly<Record<GoalStatus, string>> = {
  active: "active",
  paused: "paused",
  "budget-limited": "stopped at its token budget",
  complete: "complete",
  dropped: "dropped",
};

/** One line on what the goal has used: tokens (of its budget) and time. */
function goalUsage(goal: Goal): string | null {
  const parts: Array<string> = [];
  const used = count(goal.tokensUsed) ?? 0;
  const budget = count(goal.tokenBudget);
  if (used > 0 || budget !== undefined) {
    parts.push(
      budget === undefined
        ? `${used.toLocaleString("en-US")} tokens used`
        : `${used.toLocaleString("en-US")} of ${budget.toLocaleString("en-US")} tokens used`,
    );
  }
  const seconds = count(goal.timeUsedSeconds) ?? 0;
  if (seconds > 0) parts.push(formatDuration(seconds * 1_000));
  return parts.length === 0 ? null : parts.join(" · ");
}

/** What a goal command run over RPC answers in the thread. */
export function ompGoalReply(
  op: Extract<OmpGoalCommand["op"], "get" | "pause" | "resume" | "drop">,
  result: GoalResult,
): string {
  const goal = result.goal;
  const objective = goal?.objective.trim();
  if (op === "drop") return goal === null ? "Goal dropped." : `Goal dropped: ${objective}`;
  if (goal === null) return "No goal is set. Set one with /goal <objective>.";
  const usage = goalUsage(goal);
  const head =
    op === "pause"
      ? `Goal paused: ${objective}`
      : op === "resume"
        ? `Goal resumed: ${objective}`
        : `Goal ${STATUS_WORDS[goal.status]}: ${objective}`;
  return usage === null ? head : `${head}\n${usage}`;
}

/** OMP changes a running goal's budget only in its TUI (`/goal budget`); RPC has no form. */
export const OMP_GOAL_BUDGET_REPLY =
  "OMP changes a goal's token budget only in its terminal UI. Drop the goal and set it again with /goal set --budget <tokens> <objective>.";
