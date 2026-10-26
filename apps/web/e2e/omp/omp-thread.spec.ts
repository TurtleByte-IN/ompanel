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

/** The RPC contract of the sidecar `omp.lock` pins, which the stack's omp speaks. */
const PINNED_CONTRACT: string = JSON.parse(
  NodeFS.readFileSync(
    new URL("../../../../packages/provider-omp/omp.lock", import.meta.url),
    "utf8",
  ),
).contract.version;

/** Picks `label` in the OMP section of the thread's menu (the title button opens it). */
const pickOmpMenuItem = async (label: string) => {
  const { page } = suite.current();
  await page.locator("[data-thread-title-chevron]").click();
  await page.locator("div[data-level] button", { hasText: /^OMP$/ }).click();
  await page.locator("div[data-level] button", { hasText: new RegExp(`^${label}$`) }).click();
};

test("exports the thread as HTML from the thread menu", async () => {
  const { page, screenshot } = suite.current();
  const download = page.waitForEvent("download");
  await pickOmpMenuItem("Export HTML");
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^omp-session-[\w-]+\.html$/);
  const saved = NodePath.join(ARTIFACTS, file.suggestedFilename());
  await file.saveAs(saved);
  const html = NodeFS.readFileSync(saved, "utf8");
  expect(html).toMatch(/^<!DOCTYPE html>/i);
  // OMP's page bundles its own viewer script, so a real export is never a small stub.
  expect(html).toContain("<title");
  expect(html.length).toBeGreaterThan(10_000);
  await screenshot("09-exported-html");
});

test("shows the session's branch tree from the thread menu", async () => {
  const { page, screenshot } = suite.current();
  await pickOmpMenuItem("Branch tree");
  const dialog = page.locator("[data-omp-branch-tree-dialog]");
  const rows = dialog.locator("[data-entry-id]");
  await expect(rows.first()).toBeVisible();
  // The rewind moved the session onto a file that keeps the first exchange: one path to the leaf.
  await expect(dialog.locator("[data-active-path]", { hasText: "hello from G1" })).toBeVisible();
  await expect(dialog.locator("[data-active-path]", { hasText: "after stop" })).toBeVisible();
  await expect(dialog.getByText("current")).toBeVisible();
  await expect(dialog.getByText("g1-full-access")).toHaveCount(0);
  await screenshot("10-branch-tree");
  await dialog.getByRole("button", { name: "Done" }).click();
  await expect(dialog).toHaveCount(0);
});

test("opens Share live with the pairing warning, gated on the collab RPC", async () => {
  const [major = 0, minor = 0] = PINNED_CONTRACT.split(".").map(Number);
  const hasCollab = major > 1 || minor >= 7;
  const { page, screenshot } = suite.current();
  // The menu item itself says the link is outside T3 pairing.
  await pickOmpMenuItem("Share live \\(outside pairing\\)…");
  const dialog = page.locator("[data-omp-share-live-dialog]");
  await expect(dialog.getByText("This link bypasses T3 pairing")).toBeVisible();
  const start = dialog.getByRole("button", { name: "Start sharing" });
  if (hasCollab) {
    await expect(start).toBeEnabled();
  } else {
    await expect(dialog.getByText(/needs OMP RPC contract 1\.7\.0/)).toBeVisible();
    await expect(start).toBeDisabled();
  }
  await screenshot("11-share-live-dialog");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

// PRD §9: what a collector receives about OMP is driver kind, version, error class and frame
// drops; never a prompt, reply, path or secret (`packages/provider-omp/src/server/telemetry.ts`).
const OMP_METRIC_KEYS = [
  "provider",
  "ompVersion",
  "ompContract",
  "outcome",
  "errorClass",
  "reason",
];

test("exports OMP driver metrics without turn content", async () => {
  const { stack } = suite.current();
  const ompPoints = () =>
    stack.metrics.points().filter((point) => point.name.startsWith("t3_omp_"));
  const ended = (outcome: string) =>
    ompPoints().some(
      (point) => point.name === "t3_omp_turns_total" && point.attributes.outcome === outcome,
    );
  await expect
    .poll(() => ended("completed") && ended("interrupted"), { timeout: 30_000 })
    .toBe(true);
  const points = ompPoints();
  expect(
    points.some(
      (point) => point.name === "t3_omp_sessions_total" && point.attributes.outcome === "started",
    ),
  ).toBe(true);
  const forbidden = [
    "hello from G1",
    "g1-supervised",
    "g1-stop",
    STREAMED_PARAGRAPHS[0],
    stack.workspace,
    stack.home,
  ];
  for (const point of points) {
    expect(point.attributes.provider).toBe("omp");
    for (const [key, value] of Object.entries(point.attributes)) {
      expect(OMP_METRIC_KEYS, `${point.name} label ${key}`).toContain(key);
      for (const text of forbidden) expect(value).not.toContain(text);
    }
  }
  // The labels exactly as exported, for the gate's evidence.
  NodeFS.mkdirSync(ARTIFACTS, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(ARTIFACTS, "omp-metrics.json"),
    `${JSON.stringify(points, null, 2)}\n`,
  );
});
