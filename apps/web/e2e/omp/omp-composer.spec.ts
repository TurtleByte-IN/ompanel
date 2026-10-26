// @effect-diagnostics nodeBuiltinImport:off - an end-to-end test writing artifacts.
// Composer extras on an OMP thread (PHASES P-05): goal mode through the composer chip and the Goal
// panel, magic-keyword chips, and the traits menu (boolean traits, role chip; Vibe Mode only once
// the pin has `set_vibe_mode`). A real `omp` from the omp.lock tag and the scripted model.
import * as NodePath from "node:path";

import { expect, test } from "@playwright/test";

import { useOmpSuite } from "./ompSuite.ts";
import { GOAL_DONE_MARKER, STREAMED_PARAGRAPHS, TOOL_REPLY_PREFIX } from "./scriptedModel.ts";

const ARTIFACTS =
  process.env.OMPANEL_E2E_ARTIFACTS_DIR ??
  NodePath.join(import.meta.dirname, "..", "..", ".playwright", "omp-artifacts");

test.describe.configure({ mode: "serial" });

const suite = useOmpSuite({ artifacts: ARTIFACTS });
const OBJECTIVE = "Write the composer extras marker";

const composer = () => suite.current().page.getByRole("textbox", { name: /^Message / });
const goalChip = () => suite.current().page.locator("[data-composer-goal-chip]");
const goalPanel = () => suite.current().page.locator("[data-goal-panel]");

test("creates an OMP thread; its composer has the goal chip", async () => {
  const { assistantSays, createOmpThread, screenshot, sendAndSettle } = suite.current();
  await createOmpThread("Full access");
  await sendAndSettle("hello from P-05");
  await expect(assistantSays(STREAMED_PARAGRAPHS[1])).toBeVisible();
  // The chip belongs to a started thread: goal commands run as turns of it.
  await expect(goalChip()).toHaveAttribute("aria-label", "Goal");
  await screenshot("p05-01-goal-chip");
});

test("sets a goal with /goal: OMP creates it over RPC and works on the objective", async () => {
  const { assistantMessages, page, screenshot, sendAndSettle, stack } = suite.current();
  await composer().pressSequentially("/goa");
  await expect(page.getByRole("option", { name: /\/goal/ })).toBeVisible();
  await screenshot("p05-02-goal-in-slash-menu");
  await composer().fill("");

  const replies = await assistantMessages().count();
  await sendAndSettle(`/goal set --budget 200000 ${OBJECTIVE}`);
  await expect(assistantMessages()).not.toHaveCount(replies);
  // The objective went to the model as the prompt (never the `/goal` text), and once OMP set
  // the goal, its goal context and `goal` tool followed.
  const calls = stack.model.calls.filter((entry) =>
    entry.userTexts.some((text) => text.includes(OBJECTIVE)),
  );
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.flatMap((entry) => entry.userTexts).some((text) => text.includes("/goal set"))).toBe(
    false,
  );
  expect(calls.some((entry) => entry.tools.includes("goal"))).toBe(true);
  await expect(goalChip()).toHaveAttribute("aria-label", "Goal set");
  await screenshot("p05-03-goal-set");
});

test("pauses and resumes the goal from the Goal panel", async () => {
  const { page, screenshot } = suite.current();
  await goalChip().click();
  await expect(goalPanel().locator("[data-goal-objective]")).toHaveText(OBJECTIVE);
  await expect(goalPanel().locator("[data-goal-budget]")).toContainText("200,000");
  await expect(goalChip()).toHaveAttribute("aria-pressed", "true");
  await screenshot("p05-04-goal-panel");

  await goalPanel().getByRole("button", { name: "Pause" }).click();
  await expect(goalPanel().locator("[data-goal-status]")).toHaveAttribute(
    "data-goal-status",
    "paused",
  );
  await expect(goalChip()).toHaveAttribute("aria-label", "Goal paused");
  await expect(page.getByText(`Goal paused: ${OBJECTIVE}`).first()).toBeVisible();
  await screenshot("p05-05-goal-paused");

  await goalPanel().getByRole("button", { name: "Resume" }).click();
  await expect(goalPanel().locator("[data-goal-status]")).toHaveAttribute(
    "data-goal-status",
    "active",
  );
  await expect(page.getByText(`Goal resumed: ${OBJECTIVE}`).first()).toBeVisible();
});

test("the agent completes the goal with OMP's goal tool", async () => {
  const { page, screenshot, send, stack } = suite.current();
  await send(`${GOAL_DONE_MARKER} the marker is written`);
  await expect(page.getByText(new RegExp(`^${TOOL_REPLY_PREFIX}`)).first()).toBeVisible();
  expect(
    stack.model.calls.some(
      (entry) => "calls" in entry.reply && entry.reply.calls.some(({ tool }) => tool === "goal"),
    ),
  ).toBe(true);
  await expect(goalPanel().locator("[data-goal-status]")).toHaveAttribute(
    "data-goal-status",
    "complete",
  );
  await expect(goalPanel().getByRole("form", { name: "Set a goal" })).toBeVisible();
  await screenshot("p05-06-goal-complete");
});

test("offers magic keywords as chips, and OMP acts on them", async () => {
  const { page, screenshot, sendAndSettle, stack } = suite.current();
  await composer().pressSequentially("think it through, ultra");
  const option = page.getByRole("listbox", { name: "Magic keywords" }).getByRole("option");
  await expect(option.filter({ hasText: "ultrathink" })).toBeVisible();
  await screenshot("p05-07-keyword-suggestion");

  // The suggestion never takes a key: Tab keeps its default, only a click inserts the keyword.
  await option.filter({ hasText: "ultrathink" }).click();
  await expect(composer()).toHaveText("think it through, ultrathink");
  await expect(page.locator('[data-magic-keyword="ultrathink"]')).toBeVisible();
  await composer().pressSequentially("please");
  await screenshot("p05-08-keyword-chip");

  const before = stack.model.calls.length;
  await sendAndSettle("think it through, ultrathink please");
  // OMP adds its ultrathink notice to the turn; the prompt itself went out as typed.
  const turn = stack.model.calls.slice(before).find((entry) => entry.lastRole === "user");
  expect(turn?.userTexts.join("\n")).toContain("think it through, ultrathink please");
  expect(turn?.userTexts.join("\n")).toContain("Multi-step reasoning");
});

test("shows OMP's boolean traits and role chip; no Vibe Mode before the vibe contract", async () => {
  const { page, screenshot } = suite.current();
  await page.locator('[data-composer-shortcut="composer.effort"]').click();
  const menu = page.getByRole("menu");
  for (const label of ["Fast Mode", "Advisor", "Prewalk", "Computer Use", "Role"]) {
    await expect(menu.getByText(label, { exact: true }).first()).toBeVisible();
  }
  // The pinned sidecar has no `set_vibe_mode`, so the trait is not offered (docs/omp/composer.md).
  await expect(menu.getByText("Vibe Mode", { exact: true })).toHaveCount(0);
  await screenshot("p05-09-traits-menu");
  await page.keyboard.press("Escape");
});
