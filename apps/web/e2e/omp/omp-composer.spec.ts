// @effect-diagnostics nodeBuiltinImport:off - an end-to-end test writing artifacts.
// Composer extras on an OMP thread (PHASES P-05): goal mode through the composer chip and the Goal
// panel, magic-keyword chips, and the traits menu (boolean traits, role chip, Vibe Mode over
// `set_vibe_mode`, and a vibe worker in the Agents panel), and a staged `ast_edit` card's Accept
// and Reject (Z-05, RPC `resolve_proposal`). A real `omp` from the omp.lock tag and the scripted
// model.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, test } from "@playwright/test";

import { useOmpSuite } from "./ompSuite.ts";
import {
  AST_EDIT_PREFIX,
  GOAL_DONE_MARKER,
  STREAMED_PARAGRAPHS,
  TOOL_REPLY_PREFIX,
  VIBE_SPAWN_PREFIX,
} from "./scriptedModel.ts";

const ARTIFACTS =
  process.env.OMPANEL_E2E_ARTIFACTS_DIR ??
  NodePath.join(import.meta.dirname, "..", "..", ".playwright", "omp-artifacts");

test.describe.configure({ mode: "serial" });

const suite = useOmpSuite({ artifacts: ARTIFACTS });
const OBJECTIVE = "Write the composer extras marker";

const composer = () => suite.current().page.getByRole("textbox", { name: /^Message / });
const goalChip = () => suite.current().page.locator("[data-composer-goal-chip]");
const goalPanel = () => suite.current().page.locator("[data-goal-panel]");
/** Sets the composer's Vibe Mode trait; the adapter applies it before the next prompt. */
const setVibeMode = async (vibe: "On" | "Off") => {
  const { page } = suite.current();
  await page.locator('[data-composer-shortcut="composer.effort"]').click();
  await page
    .getByRole("menu")
    .getByRole("group")
    .filter({ has: page.getByText("Vibe Mode", { exact: true }) })
    .last()
    .getByRole("menuitemradio", { name: vibe, exact: true })
    .click();
};

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

test("shows OMP's boolean traits, Vibe Mode and the role chip", async () => {
  const { page, screenshot } = suite.current();
  await page.locator('[data-composer-shortcut="composer.effort"]').click();
  const menu = page.getByRole("menu");
  for (const label of ["Fast Mode", "Advisor", "Prewalk", "Computer Use", "Vibe Mode", "Role"]) {
    await expect(menu.getByText(label, { exact: true }).first()).toBeVisible();
  }
  await screenshot("p05-09-traits-menu");
  await page.keyboard.press("Escape");
});

test("Vibe Mode gives the agent OMP's worker tools, and turning it off takes them away", async () => {
  const { screenshot, sendAndSettle, stack } = suite.current();
  // The adapter sends `set_vibe_mode` before the next prompt; the tools OMP then offers the model
  // show the mode it runs in: vibe mode keeps `read` and adds the `vibe_*` tools.
  const turnTools = async (vibe: "On" | "Off", text: string) => {
    await setVibeMode(vibe);
    const before = stack.model.calls.length;
    await sendAndSettle(text);
    return stack.model.calls.slice(before).find((entry) => entry.lastRole === "user")?.tools;
  };

  const vibeTools = await turnTools("On", "hello in vibe mode");
  expect(vibeTools).toEqual(expect.arrayContaining(["read", "vibe_spawn", "vibe_send"]));
  expect(vibeTools).not.toContain("terminal");
  await screenshot("p05-10-vibe-mode");

  const tools = await turnTools("Off", "hello after vibe mode");
  expect(tools).toContain("terminal");
  expect(tools).not.toContain("vibe_spawn");
});

test("a Vibe Mode worker is a row in the Agents panel, not a new thread", async () => {
  const { page, screenshot, sendAndSettle, stack } = suite.current();
  const threads = page.locator("[data-thread-item]");
  const threadCount = await threads.count();
  await setVibeMode("On");
  await sendAndSettle(`${VIBE_SPAWN_PREFIX}vibe-alpha`);
  // The worker runs in the background: its own model call carries the brief the agent sent.
  await expect
    .poll(() => stack.model.calls.some((call) => call.lastText.includes("vibe-alpha-done")))
    .toBe(true);

  // OMP runs the worker as a subagent whose frames name the `vibe_spawn` call; Ompanel lists it in
  // the Agents panel under that call (docs/omp/subagents.md#vibe-workers).
  await page.getByRole("button", { name: "Toggle agents panel" }).click();
  const worker = page
    .getByRole("navigation", { name: "Agents" })
    .getByRole("button", { name: /^vibe-alpha: Vibe good worker, / });
  await expect(worker).toBeVisible();
  await screenshot("z05-vibe-worker");
  await worker.click();
  await expect(
    page.getByRole("region", { name: "vibe-alpha: Vibe good worker details" }),
  ).toContainText("Reply with vibe-alpha-done.");
  await screenshot("z05-vibe-worker-details");
  // The worker is not a delegated child thread: the sidebar holds as many threads as before.
  await expect(threads).toHaveCount(threadCount);
  await page.getByRole("button", { name: "Toggle agents panel" }).click();
});

test("a staged ast_edit card: Accept applies the proposal, Reject discards the next", async () => {
  const { createOmpThread, page, screenshot, send, stack } = suite.current();
  await setVibeMode("Off");
  const file = NodePath.join(stack.workspace, "z05-proposal.ts");
  NodeFS.writeFileSync(file, "export const value = oldName(1);\n");
  // The scripted model stages the rewrite, then hangs: the preview waits for the user mid-turn.
  const callsBefore = stack.model.calls.length;
  const stalledBefore = stack.model.stalledStreams();
  await send(`${AST_EDIT_PREFIX}oldName($A) => newName($A) in z05-proposal.ts`);
  const stop = page.getByRole("button", { name: "Stop generation" });
  // The model called `ast_edit` (or wrote its `xd://` device) and OMP sent it the staged preview:
  // the model's next request follows the tool result.
  await expect
    .poll(
      () =>
        stack.model.calls.slice(callsBefore).findIndex((call) => "calls" in call.reply) !== -1 &&
        stack.model.calls.slice(callsBefore).length >= 2,
      { timeout: 60_000 },
    )
    .toBe(true);

  // The latest proposal's card (an earlier one may be expanded too).
  const card = page
    .locator("[data-omp-card]")
    .filter({ has: page.locator("[data-omp-proposal]") })
    .last();
  /** Expands the `ast_edit` tool row (in the running turn, or a finished turn's "Worked for"). */
  const openProposal = async (state: "proposed" | "applied") => {
    await expect(async () => {
      const worked = page.getByRole("button", { name: /^Worked for / }).last();
      if ((await worked.count()) > 0 && (await worked.getAttribute("aria-expanded")) !== "true") {
        await worked.click();
      }
      const row = page.getByRole("button", { name: /ast_edit/ }).last();
      if ((await row.getAttribute("aria-expanded")) !== "true") await row.click();
      await expect(card.locator(`[data-omp-proposal=${state}]`)).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000 });
  };
  await openProposal("proposed");
  await expect(card).toContainText("z05-proposal.ts");
  // Staged: OMP has not touched the file.
  expect(NodeFS.readFileSync(file, "utf8")).toBe("export const value = oldName(1);\n");
  await expect(card).toContainText("Accept or reject it");
  await screenshot("z05-proposal-staged");
  await card.getByRole("button", { name: "Accept" }).click();
  await expect(card.locator("[data-omp-proposal=applied]")).toBeVisible();
  await expect(card.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await expect
    .poll(() => NodeFS.readFileSync(file, "utf8"))
    .toBe("export const value = newName(1);\n");
  await screenshot("z05-proposal-applied");
  await stop.click();
  await expect(stop).toHaveCount(0);
  // OMP aborted the hung turn: its model stream is closed, so the next turn does not queue
  // behind it.
  await expect.poll(() => stack.model.stalledStreams()).toBe(stalledBefore);
  // A reload replays the thread: the card still shows the outcome, with no buttons.
  await page.reload();
  await openProposal("applied");
  await expect(card.getByRole("button", { name: "Accept" })).toHaveCount(0);
  await screenshot("z05-proposal-after-reload");

  // Reject discards a proposal: the file keeps its text. It runs in a thread of its own, so the
  // first thread's stopped turn and reload cannot hide the new turn's card.
  await createOmpThread("Full access");
  NodeFS.writeFileSync(file, "export const other = oldName(2);\n");
  const rejectFrom = stack.model.calls.length;
  await send(`${AST_EDIT_PREFIX}oldName($A) => newName($A) in z05-proposal.ts`);
  try {
    await expect
      .poll(() => stack.model.calls.slice(rejectFrom).length >= 2, { timeout: 60_000 })
      .toBe(true);
    await openProposal("proposed");
  } catch (error) {
    // What the scripted model served, so a failure shows whether OMP called the tool at all.
    await test.info().attach("reject-model-calls", {
      body: JSON.stringify(
        stack.model.calls.slice(rejectFrom).map((call) => ({
          lastRole: call.lastRole,
          lastText: call.lastText.slice(0, 200),
          tools: call.tools,
          devices: call.devices,
        })),
        null,
        2,
      ),
      contentType: "application/json",
    });
    throw error;
  }
  await card.getByRole("button", { name: "Reject" }).click();
  await expect(card.locator("[data-omp-proposal=discarded]")).toBeVisible();
  await expect(card.getByRole("button", { name: "Reject" })).toHaveCount(0);
  await screenshot("z05-proposal-rejected");
  await stop.click();
  await expect(stop).toHaveCount(0);
  expect(NodeFS.readFileSync(file, "utf8")).toBe("export const other = oldName(2);\n");
});
