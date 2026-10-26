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
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await context.newPage();
  await page.goto(stack.pairingUrl);
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

// C-11 (ompanel#74) adds rewind and fork for OMP threads; it fills these two in.
test.fixme("rewinds the thread to an earlier turn (C-11, ompanel#74)", async () => {
  // "Edit from here" on an earlier user message: OMP `branch {entryId}`, the thread re-renders
  // from `get_branch_messages`, and the later turns are gone from the thread.
});

test.fixme("forks the thread from a response (C-11, ompanel#74)", async () => {
  // "Fork from this response": OMP `fork` to a new session file, a new thread opens with the
  // history up to that response, and the original thread is unchanged.
});

test("generates a commit message", async () => {
  await page.getByRole("button", { name: "Git action options" }).click();
  await page.getByRole("menuitem", { name: "Commit" }).click();
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
