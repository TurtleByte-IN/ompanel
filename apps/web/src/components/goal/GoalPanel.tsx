import { presentProviderGoal } from "@t3tools/client-runtime/state/thread-execution";
import type { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { ompGoalCommandText } from "@t3tools/provider-omp/composer";
import { TargetIcon } from "lucide-react";
import { useId, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

type GoalStatus = OrchestrationV2ProviderGoal["status"];

const STATUS_BADGE_VARIANT: Record<GoalStatus, "info" | "outline" | "warning" | "success"> = {
  active: "info",
  paused: "outline",
  blocked: "warning",
  usage_limited: "warning",
  budget_limited: "warning",
  complete: "success",
};

export interface GoalPanelProps {
  /** The thread's goal, updated live; null when it has none. */
  readonly goal: OrchestrationV2ProviderGoal | null;
  /** The thread is working: an active goal is being pursued and actions wait for it. */
  readonly working: boolean;
  /** The goal cannot be changed now: no permission to operate the thread, or a send is in flight. */
  readonly disabled: boolean;
  /** Sends a `/goal …` command as its own turn. */
  readonly onSendCommand: (text: string, failureMessage: string) => void;
}

/** Number of tokens in a budget field: empty is no budget, anything but a positive integer is invalid. */
function parseTokenBudget(value: string): number | null | "invalid" {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const tokens = Number(trimmed);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : "invalid";
}

/** An OMP thread's goal: what it is, how far it got, and pause, resume, drop or set one. */
export function GoalPanel(props: GoalPanelProps) {
  const { goal, working, disabled, onSendCommand } = props;
  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto p-4" data-goal-panel>
      {goal === null ? null : (
        <GoalSummary
          goal={goal}
          working={working}
          disabled={disabled}
          onSendCommand={onSendCommand}
        />
      )}
      {goal === null || goal.status === "complete" ? (
        <SetGoalForm
          replacesComplete={goal !== null}
          disabled={disabled || working}
          onSendCommand={onSendCommand}
        />
      ) : null}
      <p className="text-muted-foreground text-xs">
        OMP keeps working on a goal by itself only when its goal.continuationModes setting includes
        rpc; otherwise each message you send works toward it.
      </p>
    </div>
  );
}

function GoalSummary(props: {
  readonly goal: OrchestrationV2ProviderGoal;
  readonly working: boolean;
  readonly disabled: boolean;
  readonly onSendCommand: GoalPanelProps["onSendCommand"];
}) {
  const { goal, working, disabled, onSendCommand } = props;
  const presentation = presentProviderGoal(goal, working);
  const send = (op: "pause" | "resume" | "drop", verb: string) =>
    onSendCommand(ompGoalCommandText({ op }), `Failed to ${verb} goal.`);
  return (
    <section aria-label="Goal" className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <TargetIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <Badge variant={STATUS_BADGE_VARIANT[goal.status]} data-goal-status={goal.status}>
          {presentation.title}
        </Badge>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm" data-goal-objective>
        {presentation.objective}
      </p>
      {presentation.usage === null ? null : (
        <p className="text-muted-foreground text-xs" data-goal-usage>
          {presentation.usage}
        </p>
      )}
      {goal.tokenBudget == null ? null : (
        <p className="text-muted-foreground text-xs" data-goal-budget>
          Token budget: {goal.tokenBudget.toLocaleString()}
        </p>
      )}
      {working ? (
        <p className="text-muted-foreground text-xs">
          You can pause, resume or drop the goal once this turn ends.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {goal.status === "active" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => send("pause", "pause")}
            >
              Pause
            </Button>
          ) : null}
          {presentation.canResume ? (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled}
              onClick={() => send("resume", "resume")}
            >
              Resume
            </Button>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            disabled={disabled}
            onClick={() => send("drop", "drop")}
          >
            Drop
          </Button>
        </div>
      )}
    </section>
  );
}

function SetGoalForm(props: {
  /** The thread has a completed goal the new one replaces. */
  readonly replacesComplete: boolean;
  readonly disabled: boolean;
  readonly onSendCommand: GoalPanelProps["onSendCommand"];
}) {
  const { replacesComplete, disabled, onSendCommand } = props;
  const id = useId();
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const tokenBudget = parseTokenBudget(budget);
  const canSubmit = !disabled && objective.trim() !== "" && tokenBudget !== "invalid";
  return (
    <form
      aria-label="Set a goal"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSubmit) return;
        onSendCommand(
          ompGoalCommandText({
            op: "create",
            objective,
            ...(tokenBudget === null ? {} : { tokenBudget }),
          }),
          "Failed to set goal.",
        );
        setObjective("");
        setBudget("");
      }}
    >
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-sm">
          {replacesComplete ? "Set a new goal" : "No goal set"}
        </h3>
        <p className="text-muted-foreground text-xs">
          OMP works toward the goal across turns and reports when it is done.
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-objective`}>Objective</Label>
        <Textarea
          id={`${id}-objective`}
          value={objective}
          rows={3}
          placeholder="What should this thread achieve?"
          onChange={(event) => setObjective(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-budget`}>Token budget (optional)</Label>
        <Input
          id={`${id}-budget`}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={budget}
          placeholder="No limit"
          aria-invalid={tokenBudget === "invalid" || undefined}
          onChange={(event) => setBudget(event.target.value)}
        />
        {tokenBudget === "invalid" ? (
          <p className="text-destructive-foreground text-xs">Enter a whole number of tokens.</p>
        ) : null}
      </div>
      <div>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          Set goal
        </Button>
      </div>
    </form>
  );
}
