import type { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { presentProviderGoal } from "@t3tools/client-runtime/state/thread-execution";
import { TargetIcon } from "lucide-react";

import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";

/** What the composer's goal chip shows for an OMP thread, and the goal panel it toggles. */
export interface ComposerGoalChipState {
  readonly goal: OrchestrationV2ProviderGoal | null;
  /** The thread is working, so an active goal reads as being pursued. */
  readonly working: boolean;
  /** The goal panel is the open right-panel surface. */
  readonly open: boolean;
  readonly onToggle: () => void;
}

/** `Goal` without a goal, else the goal's status title (`Goal set`, `Goal paused`, …). */
export function composerGoalChipLabel(chip: ComposerGoalChipState): string {
  return chip.goal === null ? "Goal" : presentProviderGoal(chip.goal, chip.working).title;
}

export function ComposerGoalChip(props: {
  chip: ComposerGoalChipState;
  size: ComposerControlSize;
}) {
  const { chip, size } = props;
  const label = composerGoalChipLabel(chip);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={size}
            className="shrink-0 whitespace-nowrap"
            type="button"
            aria-pressed={chip.open}
            aria-label={label}
            data-composer-goal-chip
            onClick={chip.onToggle}
          />
        }
      >
        <ComposerControlIcon icon={TargetIcon} size={size} />
        <span data-composer-control-label className="max-w-48 truncate">
          {label}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-72">
        {chip.goal === null ? "Set a goal for this thread" : chip.goal.objective}
      </TooltipPopup>
    </Tooltip>
  );
}
