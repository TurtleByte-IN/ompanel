// @effect-diagnostics nodeBuiltinImport:off - an end-to-end test reading the stack's files.
// The live suite (docs/omp/testing.md, "Live suite"): one OMP thread through the web app against
// a real `omp` built from the omp.lock tag and a real model. Skipped unless OMPANEL_LIVE=1.
// The prompts are worded so the scripted model answers them too (OMPANEL_LIVE_MODEL=scripted),
// which checks the suite itself without a key.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, test } from "@playwright/test";

import type { OmpStackOptions } from "./ompStack.ts";
import { useOmpSuite } from "./ompSuite.ts";
import { CODE_WORD_QUESTION, COMMIT_SUBJECT, VERBATIM_MARKER } from "./scriptedModel.ts";

/** The provider key, read from the environment only; OMP gets it as `ANTHROPIC_API_KEY`. */
const KEY_ENV = "OMPANEL_LIVE_ANTHROPIC_API_KEY";
// Empty (a scheduled or pull request run of omp-live.yml) means the default.
const MODEL = process.env.OMPANEL_LIVE_MODEL || "anthropic/claude-haiku-4-5";
const SCRIPTED = MODEL === "scripted";

const ARTIFACTS =
  process.env.OMPANEL_E2E_ARTIFACTS_DIR === undefined
    ? NodePath.join(import.meta.dirname, "..", "..", ".playwright", "omp-live-artifacts")
    : NodePath.join(process.env.OMPANEL_E2E_ARTIFACTS_DIR, "live");

// oxlint-disable-next-line t3code/no-test-timeout-or-unreasoned-skip -- an opt-in gate like `skipIf`, not a quarantine.
test.skip(
  process.env.OMPANEL_LIVE !== "1",
  "The OMP live suite runs only with OMPANEL_LIVE=1 (docs/omp/testing.md, Live suite).",
);
// A real model takes seconds per turn, and the fan-out runs three agents.
test.describe.configure({ mode: "serial", timeout: 600_000 });

const stackOptions = (): OmpStackOptions => {
  if (SCRIPTED) return {};
  if (!MODEL.startsWith("anthropic/")) {
    throw new Error(`OMPANEL_LIVE_MODEL must be anthropic/<model> or scripted, not ${MODEL}.`);
  }
  const key = process.env[KEY_ENV];
  if (key === undefined || key === "") {
    throw new Error(`OMPANEL_LIVE=1 needs ${KEY_ENV} (or OMPANEL_LIVE_MODEL=scripted).`);
  }
  return { defaultModel: MODEL, secretEnvironment: { ANTHROPIC_API_KEY: key } };
};

const suite = useOmpSuite({ artifacts: ARTIFACTS, stack: stackOptions });
let threadId: string;

const threadPids = () =>
  suite
    .current()
    .threadProcesses(threadId)
    .map((entry) => entry.pid);

const TURN_TIMEOUT = 180_000;

test("streams a reply", async () => {
  const {
    assistantMessages,
    createOmpThread,
    screenshot,
    sendAndSettle,
    threadId: openThreadId,
    watchFor,
  } = suite.current();
  await createOmpThread("Supervised");
  const first = "LIVE-ONE opens this reply.";
  const second =
    "LIVE-TWO closes it, and it is long enough to take a while to stream: one, two, three, " +
    "four, five, six, seven, eight, nine, ten, eleven, twelve, thirteen, fourteen, fifteen.";
  // Ompanel's default `responseStreamingMode` shows streamed text a finished paragraph at a
  // time: the first paragraph is on screen before the second has arrived.
  const sawPartial = await watchFor("partial", {
    include: "LIVE-ONE",
    exclude: "LIVE-TWO",
    within: '[data-message-role="assistant"]',
  });
  await sendAndSettle(`${VERBATIM_MARKER}\n\n${first}\n\n${second}`, TURN_TIMEOUT);
  await expect(assistantMessages().last()).toContainText("LIVE-ONE");
  await expect(assistantMessages().last()).toContainText("LIVE-TWO");
  expect(await sawPartial()).toBe(true);

  threadId = openThreadId();
  expect(threadPids()).toHaveLength(1);
  await screenshot("01-streamed-reply");
});

test("runs a command after approval in Supervised", async () => {
  const { approvalCard, assistantMessages, page, screenshot, send, stack } = suite.current();
  const file = NodePath.join(stack.workspace, "live-approval.txt");
  await send(
    "Use your shell tool to run the command below exactly once, then reply with its output " +
      "and nothing else.\nrun: printf live-approved > live-approval.txt && cat live-approval.txt",
  );
  await expect(approvalCard()).toBeVisible({ timeout: TURN_TIMEOUT });
  // Nothing ran before the approval.
  expect(NodeFS.existsSync(file)).toBe(false);
  await screenshot("02a-command-approval");

  // Approve every command OMP asks for until the turn ends: a real model may split the work.
  const approve = page.getByRole("button", { name: "Approve", exact: true });
  const stop = page.getByRole("button", { name: "Stop generation" });
  await expect
    .poll(
      async () => {
        if (await approve.isVisible()) await approve.click({ timeout: 5_000 }).catch(() => {});
        return (await stop.count()) === 0 && (await approvalCard().count()) === 0;
      },
      { timeout: TURN_TIMEOUT, intervals: [500] },
    )
    .toBe(true);
  expect(NodeFS.readFileSync(file, "utf8")).toBe("live-approved");
  await expect(assistantMessages().last()).toContainText("live-approved");
  expect(threadPids()).toHaveLength(1);
  await screenshot("02b-approved-command-ran");
});

test("fans out to subagents", async () => {
  const { page, screenshot, selectRuntimeMode, sendAndSettle } = suite.current();
  // Full access: the subagents start without an approval each.
  await selectRuntimeMode("Full access");
  await sendAndSettle(
    "Use your task tool to start two subagents in parallel, named live-alpha and live-beta. " +
      'Each one\'s only task is to reply with its own name followed by "-done", without using ' +
      "any other tool. When both have finished, reply with their two results.\n" +
      "fanout: live-alpha, live-beta",
    TURN_TIMEOUT,
  );

  // Ompanel's agents panel lists them; both finish.
  const toggle = page.getByRole("button", { name: "Toggle agents panel" });
  await expect(toggle).toBeVisible();
  await toggle.click();
  const agents = page.getByRole("navigation", { name: "Agents" });
  await expect
    .poll(() => agents.getByRole("button", { name: /, Completed$/ }).count(), {
      timeout: TURN_TIMEOUT,
    })
    .toBeGreaterThanOrEqual(2);
  await screenshot("03-subagents-completed");
  await toggle.click();
  // OMP runs `task` subagents in the background and reports their results in a follow-up turn.
  await expect(page.getByRole("button", { name: "Stop generation" })).toHaveCount(0, {
    timeout: TURN_TIMEOUT,
  });
});

test("rewinds the thread to an earlier turn", async () => {
  const { assistantMessages, rewindLastMessage, screenshot, sendAndSettle, userSaid } =
    suite.current();
  const kept = "Remember this code word: KEPT-LIVE-7. Reply with just OK.";
  const removed = "Remember this code word: GONE-LIVE-3. Reply with just OK.";
  await sendAndSettle(kept, TURN_TIMEOUT);
  await sendAndSettle(removed, TURN_TIMEOUT);
  const before = threadPids();

  await rewindLastMessage();
  await expect(userSaid(removed)).toHaveCount(0);
  await expect(userSaid(kept)).toBeVisible();
  await screenshot("04a-rewound");

  // The model only knows the conversation OMP kept: the removed turn is gone from it.
  await sendAndSettle(
    `${CODE_WORD_QUESTION} in this conversation, separated by spaces, and nothing else.`,
    TURN_TIMEOUT,
  );
  const answer = assistantMessages().last();
  await expect(answer).toContainText("KEPT-LIVE-7");
  await expect(answer).not.toContainText("GONE-LIVE-3");
  expect(threadPids()).toEqual(before);
  await screenshot("04b-continued-after-rewind");
});

test("generates a commit message", async () => {
  const { openCommitDialog, page, screenshot, stack } = suite.current();
  const dialog = await openCommitDialog(/^Changes \+\d+\b/);
  await expect(dialog.getByRole("textbox")).toHaveValue("");
  await screenshot("05a-commit-dialog");

  // An empty message is generated by the text-generation model: OMP (`omp -p`).
  await dialog.getByRole("button", { name: "Commit", exact: true }).click();
  await expect
    .poll(() => stack.git("log", "-1", "--format=%s"), { timeout: TURN_TIMEOUT })
    .not.toBe("Initial commit");
  const subject = stack.git("log", "-1", "--format=%s");
  expect(subject).not.toBe("");
  if (SCRIPTED) expect(subject).toBe(COMMIT_SUBJECT);
  expect(stack.git("show", "--name-only", "--format=", "HEAD").split("\n")).toContain(
    "live-approval.txt",
  );
  await expect(page.getByText(subject).first()).toBeVisible();
  await screenshot("05b-committed");
});
