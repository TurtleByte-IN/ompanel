// @effect-diagnostics nodeBuiltinImport:off - an end-to-end test reading the stack's files.
// Gate G1: one OMP thread through the web app, against a real `omp` built from the omp.lock tag
// and a scripted local model (no account, no API key). Steps run in order on one page.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, test } from "@playwright/test";

import { useOmpSuite } from "./ompSuite.ts";
import { COMMIT_SUBJECT, STREAMED_PARAGRAPHS, TOOL_REPLY_PREFIX } from "./scriptedModel.ts";

/** Screenshots and per-step traces; point it at the gate's evidence directory to keep them. */
const ARTIFACTS =
  process.env.OMPANEL_E2E_ARTIFACTS_DIR ??
  NodePath.join(import.meta.dirname, "..", "..", ".playwright", "omp-artifacts");

test.describe.configure({ mode: "serial" });

const suite = useOmpSuite({ artifacts: ARTIFACTS });
let threadId: string;

const threadProcesses = () => suite.current().threadProcesses(threadId);

test("creates an OMP thread", async () => {
  const { createOmpThread, screenshot } = suite.current();
  await createOmpThread("Supervised");
  await screenshot("01-new-omp-thread");
});

test("streams a reply", async () => {
  const { assistantSays, screenshot, send, threadId: openThreadId, watchFor } = suite.current();
  const [first, second] = STREAMED_PARAGRAPHS;
  const sawPartial = await watchFor("partial", { include: first, exclude: second });
  await send("hello from G1");
  await expect(assistantSays(first)).toBeVisible();
  await screenshot("02a-streaming");
  await expect(assistantSays(second)).toBeVisible();
  // The first paragraph rendered while the model was still streaming the second.
  expect(await sawPartial()).toBe(true);

  threadId = openThreadId();
  const processes = threadProcesses();
  expect(processes).toHaveLength(1);
  expect(processes[0]?.args).toContain("--mode rpc-ui --approval-mode always-ask");
  await screenshot("02b-streamed-reply");
});

test("approves a bash call in Supervised", async () => {
  const { approvalCard, assistantSays, page, screenshot, send, stack } = suite.current();
  await send("run: echo g1-supervised");
  // T3 runs OMP's shell commands through its `terminal` host tool (docs/omp/host-tools.md).
  await expect(approvalCard()).toBeVisible();
  await expect(approvalCard()).toContainText("terminal");
  await screenshot("03a-command-approval");

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(assistantSays(`${TOOL_REPLY_PREFIX}g1-supervised`)).toBeVisible();
  await expect(approvalCard()).toHaveCount(0);
  expect(
    stack.model.calls.some(
      (call) => "calls" in call.reply && call.reply.calls.some(({ tool }) => tool === "terminal"),
    ),
  ).toBe(true);
  await screenshot("03b-approved-command-ran");
});

test("switches to Full access mid-thread without restarting omp", async () => {
  const { assistantSays, screenshot, selectRuntimeMode, send, stack, watchFor } = suite.current();
  const before = threadProcesses().map((entry) => entry.pid);
  expect(before).toHaveLength(1);

  await selectRuntimeMode("Full access");
  const sawApproval = await watchFor("approval", { include: "Command approval" });
  await send("run: echo g1-full-access > g1.txt && echo wrote-g1");
  await expect(assistantSays(`${TOOL_REPLY_PREFIX}wrote-g1`)).toBeVisible();

  // No approval was asked, the command ran, and the same omp process served the turn.
  expect(await sawApproval()).toBe(false);
  expect(NodeFS.readFileSync(NodePath.join(stack.workspace, "g1.txt"), "utf8")).toBe(
    "g1-full-access\n",
  );
  expect(threadProcesses().map((entry) => entry.pid)).toEqual(before);
  await screenshot("04-full-access-no-restart");
});

/**
 * The user messages of the model request that answered `prompt`: what OMP sent as history,
 * without the `<system-reminder>` OMP prepends to a session's first message.
 */
const historyFor = (prompt: string) =>
  (
    suite
      .current()
      .stack.model.calls.findLast((call) => call.lastRole === "user" && call.lastText === prompt)
      ?.userTexts ?? []
  ).map((text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ""));

test("rewinds the thread to an earlier turn", async () => {
  const { assistantSays, page, rewindLastMessage, screenshot, send, userSaid } = suite.current();
  const kept = "run: echo g1-supervised";
  const removed = "run: echo g1-full-access > g1.txt && echo wrote-g1";
  const before = threadProcesses().map((entry) => entry.pid);
  await expect(userSaid(removed)).toBeVisible();

  // "Edit from here" on the last user message: OMP `branch`es before it on the live session.
  await rewindLastMessage();
  await expect(userSaid(removed)).toHaveCount(0);
  await expect(assistantSays(`${TOOL_REPLY_PREFIX}wrote-g1`)).toHaveCount(0);
  await expect(userSaid(kept)).toBeVisible();
  await expect(page.getByRole("textbox", { name: /^Message / })).toContainText(removed);
  await screenshot("05a-rewound");

  // The next prompt continues from the rewound conversation, in the same omp process.
  await send("after rewind");
  await expect(assistantSays(STREAMED_PARAGRAPHS[1])).toHaveCount(2);
  const history = historyFor("after rewind");
  expect(history).toContain("hello from G1");
  expect(history).toContain(kept);
  expect(history.some((text) => text.includes("g1-full-access"))).toBe(false);
  expect(threadProcesses().map((entry) => entry.pid)).toEqual(before);
  await screenshot("05b-continued-after-rewind");
});

test("forks the thread from a response", async () => {
  const {
    assistantSays,
    page,
    screenshot,
    send,
    stack,
    threadId: openThreadId,
    userSaid,
  } = suite.current();
  const sourceUrl = page.url();
  const sourceThreadId = threadId;
  const sourcePids = threadProcesses().map((entry) => entry.pid);

  // The first response: the fork holds only the first exchange.
  await page.getByRole("button", { name: "Fork from this response" }).first().click();
  await page.waitForURL((url) => !url.pathname.endsWith(encodeURIComponent(sourceThreadId)));
  const forkThreadId = openThreadId();
  await expect(userSaid("hello from G1")).toBeVisible();
  await expect(userSaid("after rewind")).toHaveCount(0);
  await screenshot("06a-fork-opened");

  // Its first turn forks OMP's session into a new file, in the fork's own omp process.
  await send("in the fork");
  await expect(userSaid("in the fork")).toBeVisible();
  await expect(assistantSays(STREAMED_PARAGRAPHS[1]).last()).toBeVisible();
  await expect.poll(() => historyFor("in the fork")).toEqual(["hello from G1", "in the fork"]);
  const forkProcesses = stack.ompProcesses().filter((entry) => entry.threadId === forkThreadId);
  expect(forkProcesses).toHaveLength(1);
  expect(sourcePids).not.toContain(forkProcesses[0]?.pid);
  await screenshot("06b-fork-continued");

  // The original thread is unchanged and still runs its own session.
  await page.evaluate((url) => window.location.assign(url), sourceUrl);
  await page.waitForURL((url) => url.pathname.endsWith(encodeURIComponent(sourceThreadId)));
  await expect(userSaid("after rewind")).toBeVisible();
  await expect(userSaid("in the fork")).toHaveCount(0);
  expect(threadProcesses().map((entry) => entry.pid)).toEqual(sourcePids);
  await screenshot("06c-source-unchanged");
});

test("generates a commit message", async () => {
  const { openCommitDialog, page, screenshot, stack } = suite.current();
  // The turn that wrote g1.txt is the only change.
  const dialog = await openCommitDialog(/^Changes \+1\b/);
  await expect(dialog.getByRole("textbox")).toHaveValue("");
  await screenshot("07a-commit-dialog");

  // An empty message is generated by the text-generation model: OMP (`omp -p`).
  await dialog.getByRole("button", { name: "Commit", exact: true }).click();
  await expect(page.getByText(COMMIT_SUBJECT)).toBeVisible();
  expect(stack.git("log", "-1", "--format=%s")).toBe(COMMIT_SUBJECT);
  expect(stack.git("show", "--name-only", "--format=", "HEAD")).toBe("g1.txt");
  await screenshot("07b-committed");
});

test("stops a running turn", async () => {
  const { assistantSays, page, screenshot, send, stack } = suite.current();
  // The scripted model streams a few words, then hangs until OMP aborts the request.
  await send("stall: g1-stop");
  const stop = page.getByRole("button", { name: "Stop generation" });
  await expect(stop).toBeVisible();
  await expect
    .poll(() => stack.model.calls.some((call) => call.lastText === "stall: g1-stop"))
    .toBe(true);
  await screenshot("08a-running");

  await stop.click();
  await expect(stop).toHaveCount(0);
  await screenshot("08b-stopped");

  // The thread keeps working on the same omp process.
  const before = threadProcesses().map((entry) => entry.pid);
  await send("after stop");
  await expect(assistantSays(STREAMED_PARAGRAPHS[1]).last()).toBeVisible();
  expect(threadProcesses().map((entry) => entry.pid)).toEqual(before);
  await screenshot("08c-after-stop");
});
