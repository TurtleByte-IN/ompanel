import type { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { goalFloatingStatus } from "./floating-working-status";

const GOAL = { objective: "Ship the release", status: "paused" } as OrchestrationV2ProviderGoal;

describe("goalFloatingStatus", () => {
  it("opens the goal sheet from an OMP thread's pill", () => {
    let opened = 0;
    const status = goalFloatingStatus({
      goal: GOAL,
      isOmpThread: true,
      onOpenGoal: () => (opened += 1),
    });
    expect(status).toMatchObject({ kind: "goal", accessibilityLabel: expect.any(String) });
    if (status.kind !== "goal") throw new Error("not a goal pill");
    expect(status.accessibilityLabel).toContain("Ship the release");
    status.onPress?.();
    expect(opened).toBe(1);
  });

  it("is a plain label on other providers' threads, where the sheet could not act", () => {
    const status = goalFloatingStatus({
      goal: GOAL,
      isOmpThread: false,
      onOpenGoal: () => undefined,
    });
    expect(status.kind).toBe("goal");
    expect("onPress" in status).toBe(false);
  });
});
