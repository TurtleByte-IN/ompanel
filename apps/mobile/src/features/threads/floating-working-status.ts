import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import { presentProviderGoal } from "@t3tools/client-runtime/state/thread-execution";
import type { OrchestrationV2ProviderGoal } from "@t3tools/contracts";

export interface FloatingStatusAction {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}

export type FloatingWorkingStatus =
  | { readonly kind: "working"; readonly startedAt: string }
  | { readonly kind: "syncing"; readonly label: string }
  | { readonly kind: "compacting" }
  | {
      readonly kind: "child-input";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly onPress: () => void;
    }
  | {
      readonly kind: "background";
      readonly label: string;
      readonly accessibilityLabel: string;
      readonly waiting: boolean;
      readonly onPress: () => void;
      readonly action: FloatingStatusAction;
    }
  | {
      readonly kind: "lifecycle";
      readonly state: "snoozed" | "settled" | "woke";
      readonly label: string;
      readonly action: FloatingStatusAction;
    }
  | {
      readonly kind: "goal";
      readonly label: string;
      readonly accessibilityLabel: string;
      /** Opens the goal sheet; absent where it cannot act (the thread is not on OMP). */
      readonly onPress?: () => void;
    }
  | { readonly kind: "preparing"; readonly label: string }
  | {
      readonly kind: "connection";
      readonly tone: "reconnecting" | "unavailable";
      readonly label: string;
      readonly onPress: () => void;
    };

/**
 * The idle thread's goal pill. Only OMP threads get the goal sheet (its actions are OMP `/goal`
 * commands), so other providers' goals show as a plain label.
 */
export function goalFloatingStatus(input: {
  readonly goal: OrchestrationV2ProviderGoal;
  readonly isOmpThread: boolean;
  readonly onOpenGoal: () => void;
}): FloatingWorkingStatus {
  const goal = presentProviderGoal(input.goal, false);
  return {
    kind: "goal",
    label: goal.title,
    accessibilityLabel: `${goal.title}: ${goal.objective}`,
    ...(input.isOmpThread ? { onPress: input.onOpenGoal } : {}),
  };
}

export function connectionFloatingStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly environmentLabel: string | null;
  readonly onReconnect: () => void;
}): FloatingWorkingStatus | null {
  const environmentLabel = input.environmentLabel ?? "Environment";
  const unavailable = (label: string): FloatingWorkingStatus => ({
    kind: "connection",
    tone: "unavailable",
    label,
    onPress: input.onReconnect,
  });

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "connection",
        tone: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
        onPress: input.onReconnect,
      };
    case "offline":
      return unavailable("You are offline");
    case "unsupported":
      return unavailable("Client not supported");
    case "error":
      return unavailable(
        input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      );
    case "available":
      return unavailable(`${environmentLabel} is not connected`);
    case "connected":
      return null;
  }
}
