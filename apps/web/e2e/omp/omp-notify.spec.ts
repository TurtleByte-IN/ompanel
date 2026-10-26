// @effect-diagnostics nodeBuiltinImport:off - an end-to-end test writing artifacts and an extension.
// OMP `notify` → push (PHASES P-15): an OMP extension calls `ctx.ui.notify` mid-turn; the real
// `omp` sends `extension_ui_request notify`; Ompanel shows it in the thread, alerts it in another
// view (the desktop/web notification coordinator), and publishes it to the Connect relay as the
// thread's `agentMessage`, which the relay turns into a push. The relay is a loopback stub here.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, test } from "@playwright/test";

import { useOmpSuite } from "./ompSuite.ts";
import { STREAMED_PARAGRAPHS } from "./scriptedModel.ts";

const ARTIFACTS =
  process.env.OMPANEL_E2E_ARTIFACTS_DIR ??
  NodePath.join(import.meta.dirname, "..", "..", ".playwright", "omp-artifacts");

test.describe.configure({ mode: "serial" });

const suite = useOmpSuite({ artifacts: ARTIFACTS, stack: () => ({ relayStub: true }) });

const MARKER = "notify me:";
const MESSAGE = "Build is green, ready for review";
/** Notifies a few seconds into a turn whose prompt names a message, so the user can look away. */
const EXTENSION = `const MARKER = ${JSON.stringify(MARKER)};

export default function ompanelNotifyE2e(pi) {
  pi.on("before_agent_start", (event, ctx) => {
    const at = event.prompt.indexOf(MARKER);
    if (at === -1) return undefined;
    const message = event.prompt.slice(at + MARKER.length).trim();
    setTimeout(() => ctx.ui.notify(message, "info"), 4000);
    return undefined;
  });
}
`;

test("an OMP thread with a notifying extension; in-app and agent-message alerts on", async () => {
  const { assistantSays, createOmpThread, page, screenshot, sendAndSettle, stack } =
    suite.current();
  // OMP discovers user extensions in its agent directory when a session starts.
  const extensions = NodePath.join(stack.home, ".omp", "agent", "extensions");
  NodeFS.mkdirSync(extensions, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(extensions, "ompanel-notify-e2e.ts"), EXTENSION);

  await page.goto(new URL("/settings/general", page.url()).href);
  const inApp = page.getByRole("switch", { name: "In-app notifications" });
  await inApp.click();
  await expect(inApp).toBeChecked();
  await expect(page.getByRole("switch", { name: "Agent messages" })).toBeChecked();
  await page.getByRole("switch", { name: "Agent messages" }).scrollIntoViewIfNeeded();
  await screenshot("p15-01-settings");

  await page.goto(new URL("/", page.url()).href);
  await createOmpThread("Full access");
  await sendAndSettle("hello from P-15");
  await expect(assistantSays(STREAMED_PARAGRAPHS[1])).toBeVisible();
});

test("an OMP notify mid-turn alerts in another view and reaches the relay", async () => {
  const { page, screenshot, send, stack, threadId } = suite.current();
  const thread = threadId();
  // The scripted model hangs on `stall:`, so the turn is still running when the extension fires.
  await send(`stall: ${MARKER} ${MESSAGE}`);
  const stop = page.getByRole("button", { name: "Stop generation" });
  await expect(stop).toBeVisible();
  // Look away: alerts are for threads the user is not reading.
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await expect(page.getByRole("heading", { name: /What should we build in/ })).toBeVisible();

  await expect(page.getByText(MESSAGE, { exact: true })).toBeVisible({ timeout: 30_000 });
  await screenshot("p15-02-toast");

  // The push path: the relay received the thread's state with the agent's message while it works.
  await expect
    .poll(
      () =>
        stack.relay?.publications().find((entry) => entry.state?.agentMessage?.text === MESSAGE)
          ?.state ?? null,
    )
    .toMatchObject({ threadId: thread, phase: "running", agentMessage: { text: MESSAGE } });
  NodeFS.writeFileSync(
    NodePath.join(ARTIFACTS, "p15-relay-publications.json"),
    `${JSON.stringify(stack.relay?.publications() ?? [], null, 2)}\n`,
  );

  await page.getByRole("button", { name: "Open thread" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${encodeURIComponent(thread)}$`));
  // The same message is in the thread as a notification row (C-14).
  await expect(page.getByRole("main").getByText(MESSAGE).first()).toBeVisible();
  await screenshot("p15-03-in-thread");
  await stop.click();
  await expect(stop).toHaveCount(0);
});

test("turning Agent messages off silences the next notify but still reaches the relay", async () => {
  const { page, screenshot, send, stack, threadId } = suite.current();
  const thread = threadId();
  const threadUrl = page.url();
  await page.goto(new URL("/settings/general", threadUrl).href);
  const agentMessages = page.getByRole("switch", { name: "Agent messages" });
  await agentMessages.click();
  await expect(agentMessages).not.toBeChecked();
  await page.goto(threadUrl);
  await expect(page).toHaveURL(new RegExp(`/${encodeURIComponent(thread)}$`));

  const second = "Second message, muted on this device";
  await send(`stall: ${MARKER} ${second}`);
  const stop = page.getByRole("button", { name: "Stop generation" });
  await expect(stop).toBeVisible();
  await page.getByRole("button", { name: "New thread", exact: true }).click();
  await expect
    .poll(() =>
      stack.relay?.publications().some((entry) => entry.state?.agentMessage?.text === second),
    )
    .toBe(true);
  // The relay decides per device; this browser's setting only mutes its own alert. The first
  // notify alerted within a second of reaching the relay; allow this one the same and more.
  await page.waitForTimeout(3_000);
  await expect(page.getByText(second, { exact: true })).toHaveCount(0);
  await screenshot("p15-04-muted");

  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/${encodeURIComponent(thread)}$`));
  await stop.click();
  await expect(stop).toHaveCount(0);
});
