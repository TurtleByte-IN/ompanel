import type { OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

import { GoalPanel, type GoalPanelProps } from "./GoalPanel";
import "~/index.css";

const goal = (
  overrides: Partial<OrchestrationV2ProviderGoal> = {},
): OrchestrationV2ProviderGoal => ({
  objective: "Port the parser to the new AST",
  status: "active",
  tokensUsed: 12_400,
  tokenBudget: 50_000,
  timeUsedSeconds: 300,
  ...overrides,
});

function setup(props: Partial<GoalPanelProps> = {}) {
  const onSendCommand = vi.fn<GoalPanelProps["onSendCommand"]>();
  const container = document.createElement("div");
  container.style.width = "380px";
  container.style.height = "640px";
  container.className = "bg-background text-foreground";
  const element = (
    <GoalPanel
      goal={null}
      working={false}
      disabled={false}
      onSendCommand={onSendCommand}
      {...props}
    />
  );
  return { container, element, onSendCommand };
}

const ACTIONS: ReadonlySet<string> = new Set(["Pause", "Resume", "Drop"]);

const visibleActions = (container: HTMLElement) =>
  [...container.querySelectorAll("button")]
    .map((button) => button.textContent ?? "")
    .filter((label) => ACTIONS.has(label));

describe("GoalPanel", () => {
  it.each([
    ["active", "Goal set", ["Pause", "Drop"]],
    ["paused", "Goal paused", ["Resume", "Drop"]],
    ["blocked", "Goal blocked", ["Resume", "Drop"]],
    ["usage_limited", "Goal hit a usage limit", ["Resume", "Drop"]],
    ["budget_limited", "Goal reached its token budget", ["Resume", "Drop"]],
    ["complete", "Goal complete", ["Drop"]],
  ] as const)("shows a %s goal with its actions", async (status, title, actions) => {
    const { container, element } = setup({ goal: goal({ status }) });
    await using screen = await render(element, { container });

    await expect.element(screen.getByText(title)).toBeVisible();
    await expect.element(screen.getByText("Port the parser to the new AST")).toBeVisible();
    await expect.element(screen.getByText("12k / 50k tokens · 5m")).toBeVisible();
    await expect.element(screen.getByText("Token budget: 50,000")).toBeVisible();
    expect(visibleActions(container)).toEqual(actions);
    // A completed goal can be replaced; any other goal cannot.
    expect(screen.getByRole("button", { name: "Set goal" }).query() !== null).toBe(
      status === "complete",
    );
    await expect.element(screen.getByText(/goal\.continuationModes/)).toBeVisible();
    // Review artifacts; `__screenshots__/` is git-ignored.
    await page.screenshot({ path: `__screenshots__/goal-panel-${status}.png`, element: container });
  });

  it("reads an active goal as pursued while the thread works, without actions", async () => {
    const { container, element } = setup({ goal: goal(), working: true });
    await using screen = await render(element, { container });

    await expect.element(screen.getByText("Pursuing goal")).toBeVisible();
    expect(visibleActions(container)).toEqual([]);
  });

  it("sends each action as its /goal command", async () => {
    const active = setup({ goal: goal() });
    {
      await using screen = await render(active.element, { container: active.container });
      await screen.getByRole("button", { name: "Pause" }).click();
      await screen.getByRole("button", { name: "Drop" }).click();
    }
    expect(active.onSendCommand.mock.calls).toEqual([
      ["/goal pause", "Failed to pause goal."],
      ["/goal drop", "Failed to drop goal."],
    ]);

    const paused = setup({ goal: goal({ status: "paused" }) });
    await using screen = await render(paused.element, { container: paused.container });
    await screen.getByRole("button", { name: "Resume" }).click();
    expect(paused.onSendCommand.mock.calls).toEqual([["/goal resume", "Failed to resume goal."]]);
  });

  it("disables the actions while the goal cannot be changed", async () => {
    const { container, element, onSendCommand } = setup({
      goal: goal({ status: "paused" }),
      disabled: true,
    });
    await using screen = await render(element, { container });

    await expect.element(screen.getByRole("button", { name: "Resume" })).toBeDisabled();
    await expect.element(screen.getByRole("button", { name: "Drop" })).toBeDisabled();
    expect(onSendCommand).not.toHaveBeenCalled();
  });

  it("sets a goal with and without a token budget", async () => {
    const { container, element, onSendCommand } = setup();
    await using screen = await render(element, { container });

    await expect.element(screen.getByText("No goal set")).toBeVisible();
    const submit = screen.getByRole("button", { name: "Set goal" });
    await expect.element(submit).toBeDisabled();

    await screen.getByLabelText("Objective").fill("  Ship the\n  release notes ");
    await screen.getByLabelText("Token budget (optional)").fill("2.5");
    await expect.element(screen.getByText("Enter a whole number of tokens.")).toBeVisible();
    await expect.element(submit).toBeDisabled();

    await screen.getByLabelText("Token budget (optional)").fill("80000");
    // Review artifact of the form; `__screenshots__/` is git-ignored.
    await page.screenshot({ path: "__screenshots__/goal-panel-form.png", element: container });
    await submit.click();
    expect(onSendCommand).toHaveBeenLastCalledWith(
      "/goal set --budget 80000 Ship the release notes",
      "Failed to set goal.",
    );
    await expect.element(screen.getByLabelText("Objective")).toHaveValue("");

    await screen.getByLabelText("Objective").fill("Write the changelog");
    await submit.click();
    expect(onSendCommand).toHaveBeenLastCalledWith(
      "/goal set Write the changelog",
      "Failed to set goal.",
    );
  });

  it("keeps the form closed to sends while the thread works", async () => {
    const { container, element } = setup({ working: true });
    await using screen = await render(element, { container });

    await screen.getByLabelText("Objective").fill("Write the changelog");
    await expect.element(screen.getByRole("button", { name: "Set goal" })).toBeDisabled();
  });
});
