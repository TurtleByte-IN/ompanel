// @effect-diagnostics nodeBuiltinImport:off - an end-to-end test reading the stack's files.
// Gate G1: one OMP thread through the web app, against a real `omp` built from the omp.lock tag
// and a scripted local model (no account, no API key). Steps run in order on one page.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type BrowserContext, expect, type Page, test } from "@playwright/test";

import { type OmpStack, startOmpStack } from "./ompStack.ts";
import { COMMIT_SUBJECT, STREAMED_PARAGRAPHS, TOOL_REPLY_PREFIX } from "./scriptedModel.ts";

/** Screenshots and per-step traces; point it at the gate's evidence directory to keep them. */
const ARTIFACTS =
  process.env.OMPANEL_E2E_ARTIFACTS_DIR ??
  NodePath.join(import.meta.dirname, "..", "..", ".playwright", "omp-artifacts");

test.describe.configure({ mode: "serial" });

let stack: OmpStack;
let context: BrowserContext;
let page: Page;
let threadId: string;

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const screenshot = async (name: string) => {
  const path = NodePath.join(ARTIFACTS, `${name}.png`);
  await page.screenshot({ path });
  await test.info().attach(name, { path, contentType: "image/png" });
};

const send = async (text: string) => {
  await page.getByRole("textbox", { name: /^Message / }).fill(text);
  await page.getByRole("button", { name: "Submit message" }).click();
};

const selectRuntimeMode = async (label: "Supervised" | "Full access") => {
  const mode = page.getByRole("combobox", { name: "Runtime mode" });
  await mode.click();
  await page.getByRole("option", { name: new RegExp(`^${label}`) }).click();
  await expect(mode).toHaveText(label);
};

const assistantSays = (text: string) =>
  page.getByRole("main").getByRole("paragraph").getByText(text, { exact: true });

const approvalCard = () => page.getByRole("group", { name: "Command approval" });

/**
 * Whether the thread ever contained `include` (without `exclude`) after this call, checked on
 * every DOM change; the flag lives in a `data-*` attribute on `<html>`.
 */
const watchFor = async (key: string, matches: { include: string; exclude?: string }) => {
  await page.evaluate(
    ({ key, include, exclude }) => {
      const flags = document.documentElement.dataset;
      flags[key] = "false";
      const observer = new MutationObserver(() => {
        const text = document.querySelector("main")?.textContent ?? "";
        if (text.includes(include) && (exclude === undefined || !text.includes(exclude))) {
          flags[key] = "true";
          observer.disconnect();
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, characterData: true });
    },
    { key, ...matches },
  );
  return async () =>
    (await page.evaluate((key) => document.documentElement.dataset[key], key)) === "true";
};

const threadProcesses = () => stack.ompProcesses().filter((entry) => entry.threadId === threadId);

test.beforeAll(async ({ browser }) => {
  NodeFS.mkdirSync(ARTIFACTS, { recursive: true });
  stack = await startOmpStack();
  context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  page = await context.newPage();
  // Through `location` rather than `page.goto`, so the report's step titles never show the
  // pairing token; tracing starts after pairing for the same reason.
  await page.evaluate((url) => window.location.assign(url), stack.pairingUrl);
  await page.waitForURL((url) => url.protocol === "http:" && !url.pathname.startsWith("/pair"));
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
});

test.beforeEach(async () => {
  await context.tracing.startChunk({ title: test.info().title });
});

test.afterEach(async () => {
  const path = NodePath.join(ARTIFACTS, `trace-${slug(test.info().title)}.zip`);
  await context.tracing.stopChunk({ path });
  await test.info().attach("trace", { path, contentType: "application/zip" });
});

test.afterAll(async () => {
  NodeFS.writeFileSync(NodePath.join(ARTIFACTS, "server.log"), stack?.serverLog() ?? "");
  await context?.tracing.stop();
  await context?.close();
  await stack?.stop();
});

test("creates an OMP thread", async () => {
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await expect(page.getByRole("heading", { name: /What should we build in/ })).toBeVisible();

  const picker = page.locator('[data-chat-provider-model-picker="true"]');
  await picker.click();
  await page
    .getByRole("toolbar", { name: "Providers" })
    .getByRole("button", { name: "OMP" })
    .click();
  await page.getByRole("option", { name: /^OMP default/ }).click();
  await expect(picker).toHaveAccessibleName(/^OMP/);
  await selectRuntimeMode("Supervised");
  await screenshot("01-new-omp-thread");
});

test("streams a reply", async () => {
  const [first, second] = STREAMED_PARAGRAPHS;
  const sawPartial = await watchFor("partial", { include: first, exclude: second });
  await send("hello from G1");
  await expect(assistantSays(first)).toBeVisible();
  await screenshot("02a-streaming");
  await expect(assistantSays(second)).toBeVisible();
  // The first paragraph rendered while the model was still streaming the second.
  expect(await sawPartial()).toBe(true);

  threadId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
  const processes = threadProcesses();
  expect(processes).toHaveLength(1);
  expect(processes[0]?.args).toContain("--mode rpc-ui --approval-mode always-ask");
  await screenshot("02b-streamed-reply");
});

test("approves a bash call in Supervised", async () => {
  await send("run: echo g1-supervised");
  // T3 runs OMP's shell commands through its `terminal` host tool (docs/omp/host-tools.md).
  await expect(approvalCard()).toBeVisible();
  await expect(approvalCard()).toContainText("terminal");
  await screenshot("03a-command-approval");

  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(assistantSays(`${TOOL_REPLY_PREFIX}g1-supervised`)).toBeVisible();
  await expect(approvalCard()).toHaveCount(0);
  expect(
    stack.model.calls.some((call) => "tool" in call.reply && call.reply.tool === "terminal"),
  ).toBe(true);
  await screenshot("03b-approved-command-ran");
});

test("switches to Full access mid-thread without restarting omp", async () => {
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

/** A sent user message in the timeline (not the composer, which a rewind refills). */
const userSaid = (text: string) =>
  page.locator('[data-user-message-body="true"]').getByText(text, { exact: true });

/**
 * The user messages of the model request that answered `prompt`: what OMP sent as history,
 * without the `<system-reminder>` OMP prepends to a session's first message.
 */
const historyFor = (prompt: string) =>
  (
    stack.model.calls.findLast((call) => call.lastRole === "user" && call.lastText === prompt)
      ?.userTexts ?? []
  ).map((text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ""));

test("rewinds the thread to an earlier turn", async () => {
  const kept = "run: echo g1-supervised";
  const removed = "run: echo g1-full-access > g1.txt && echo wrote-g1";
  const before = threadProcesses().map((entry) => entry.pid);
  await expect(userSaid(removed)).toBeVisible();

  // "Edit from here" on the last user message: OMP `branch`es before it on the live session.
  // A message gets its button only once the turn before it has a ready checkpoint, and the
  // buttons stay disabled while the thread is still finishing a turn. Until every user message
  // has one, `.last()` is an earlier message's button and the rewind drops one turn too many.
  const editFromHere = page.getByRole("button", { name: "Edit from here" });
  await expect(editFromHere).toHaveCount(
    await page.locator('[data-user-message-body="true"]').count(),
  );
  await expect(editFromHere.last()).toBeEnabled();
  await editFromHere.last().click();
  const confirm = page.getByRole("alertdialog", { name: "Edit from here?" });
  await confirm.getByRole("button", { name: "Revert and keep changes" }).click();
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
  const sourceUrl = page.url();
  const sourceThreadId = threadId;
  const sourcePids = threadProcesses().map((entry) => entry.pid);

  // The first response: the fork holds only the first exchange.
  await page.getByRole("button", { name: "Fork from this response" }).first().click();
  await page.waitForURL((url) => !url.pathname.endsWith(encodeURIComponent(sourceThreadId)));
  const forkThreadId = decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? "");
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
  // The Commit item is disabled until the thread's git status shows a working-tree change; that
  // status refreshes asynchronously after the turn that wrote g1.txt and after navigation.
  // Clicking the disabled item opens nothing.
  await expect(page.getByRole("button", { name: /^Changes \+1\b/ })).toBeVisible();
  await page.getByRole("button", { name: "Git action options" }).click();
  const commit = page.getByRole("menuitem", { name: "Commit" });
  await expect(commit).toBeEnabled();
  await commit.click();
  const dialog = page.getByRole("dialog", { name: "Commit changes" });
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
  await expect(page.getByRole("button", { name: "Submit message" })).toBeVisible();
  await screenshot("08b-stopped");

  // The thread keeps working on the same omp process.
  const before = threadProcesses().map((entry) => entry.pid);
  await send("after stop");
  await expect(assistantSays(STREAMED_PARAGRAPHS[1]).last()).toBeVisible();
  expect(threadProcesses().map((entry) => entry.pid)).toEqual(before);
  await screenshot("08c-after-stop");
});
