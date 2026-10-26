// @effect-diagnostics nodeBuiltinImport:off - end-to-end fixtures writing artifacts.
// What every OMP end-to-end spec shares: one stack and one page for the file (steps run in order),
// pairing without leaking the token, a screenshot directory and one trace per step, and the page
// helpers the steps use.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";

import { type OmpProcess, type OmpStack, type OmpStackOptions, startOmpStack } from "./ompStack.ts";

export interface OmpSuite {
  readonly stack: OmpStack;
  readonly page: Page;
  readonly screenshot: (name: string) => Promise<void>;
  readonly send: (text: string) => Promise<void>;
  /** Sends `text` and waits until the turn it starts has finished. */
  readonly sendAndSettle: (text: string, timeout?: number) => Promise<void>;
  readonly selectRuntimeMode: (label: "Supervised" | "Full access") => Promise<void>;
  /** An assistant paragraph with exactly this text. */
  readonly assistantSays: (text: string) => Locator;
  /** Every assistant message row in the timeline, oldest first. */
  readonly assistantMessages: () => Locator;
  readonly approvalCard: () => Locator;
  /** A sent user message in the timeline (not the composer, which a rewind refills). */
  readonly userSaid: (text: string) => Locator;
  /**
   * Whether the thread (or the elements matching `within`) ever contained `include` (without
   * `exclude`) after this call, checked on every DOM change; the flag lives in a `data-*`
   * attribute on `<html>`.
   */
  readonly watchFor: (
    key: string,
    matches: { include: string; exclude?: string; within?: string },
  ) => Promise<() => Promise<boolean>>;
  /** "Edit from here" on the last user message, keeping the workspace's changes. */
  readonly rewindLastMessage: () => Promise<void>;
  /**
   * Opens "Commit changes" from the Git actions menu once the header shows `changes` (e.g.
   * `/^Changes \+1\b/`); returns the dialog.
   */
  readonly openCommitDialog: (changes: RegExp) => Promise<Locator>;
  /** Opens a new thread on OMP's default model in the given runtime mode. */
  readonly createOmpThread: (mode: "Supervised" | "Full access") => Promise<void>;
  /** The open thread's id, from the URL. */
  readonly threadId: () => string;
  readonly threadProcesses: (threadId: string) => ReadonlyArray<OmpProcess>;
}

const slug = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const STOP = '[aria-label="Stop generation"]';

const makeSuite = (stack: OmpStack, page: Page, artifacts: string): OmpSuite => {
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
  return {
    stack,
    page,
    screenshot: async (name) => {
      const path = NodePath.join(artifacts, `${name}.png`);
      await page.screenshot({ path });
      await test.info().attach(name, { path, contentType: "image/png" });
    },
    send,
    sendAndSettle: async (text, timeout = 120_000) => {
      // The Stop button shows while a turn runs; a fast turn can come and go between polls, so
      // a DOM observer records that it appeared.
      await page.evaluate((selector) => {
        const flags = document.documentElement.dataset;
        flags.turnStarted = "false";
        const observer = new MutationObserver(() => {
          if (document.querySelector(selector) !== null) {
            flags.turnStarted = "true";
            observer.disconnect();
          }
        });
        observer.observe(document.body, { subtree: true, childList: true, attributes: true });
      }, STOP);
      await send(text);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.dataset.turnStarted), { timeout })
        .toBe("true");
      await expect(page.locator(STOP)).toHaveCount(0, { timeout });
    },
    selectRuntimeMode,
    assistantSays: (text) =>
      page.getByRole("main").getByRole("paragraph").getByText(text, { exact: true }),
    approvalCard: () => page.getByRole("group", { name: "Command approval" }),
    userSaid: (text) =>
      page.locator('[data-user-message-body="true"]').getByText(text, { exact: true }),
    assistantMessages: () => page.locator('[data-message-role="assistant"]'),
    watchFor: async (key, matches) => {
      await page.evaluate(
        ({ key, include, exclude, within }) => {
          const flags = document.documentElement.dataset;
          flags[key] = "false";
          const observer = new MutationObserver(() => {
            const text = [...document.querySelectorAll(within)]
              .map((element) => element.textContent)
              .join("\n");
            if (text.includes(include) && (exclude === undefined || !text.includes(exclude))) {
              flags[key] = "true";
              observer.disconnect();
            }
          });
          observer.observe(document.body, { subtree: true, childList: true, characterData: true });
        },
        { key, within: "main", ...matches },
      );
      return async () =>
        (await page.evaluate((key) => document.documentElement.dataset[key], key)) === "true";
    },
    rewindLastMessage: async () => {
      // OMP `branch`es before the message on the live session. A message gets its button only
      // once the turn before it has a ready checkpoint, and the buttons stay disabled while the
      // thread is still finishing a turn. Until every user message has one, `.last()` is an
      // earlier message's button and the rewind drops one turn too many.
      const editFromHere = page.getByRole("button", { name: "Edit from here" });
      await expect(editFromHere).toHaveCount(
        await page.locator('[data-user-message-body="true"]').count(),
      );
      await expect(editFromHere.last()).toBeEnabled();
      await editFromHere.last().click();
      const confirm = page.getByRole("alertdialog", { name: "Edit from here?" });
      await confirm.getByRole("button", { name: "Revert and keep changes" }).click();
    },
    openCommitDialog: async (changes) => {
      // The Commit item is disabled until the thread's git status shows a working-tree change;
      // that status refreshes asynchronously after a turn and after navigation. Clicking the
      // disabled item opens nothing.
      await expect(page.getByRole("button", { name: changes })).toBeVisible();
      await page.getByRole("button", { name: "Git action options" }).click();
      const commit = page.getByRole("menuitem", { name: "Commit" });
      await expect(commit).toBeEnabled();
      await commit.click();
      return page.getByRole("dialog", { name: "Commit changes" });
    },
    createOmpThread: async (mode) => {
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
      await selectRuntimeMode(mode);
    },
    threadId: () => decodeURIComponent(new URL(page.url()).pathname.split("/").at(-1) ?? ""),
    threadProcesses: (threadId) =>
      stack.ompProcesses().filter((entry) => entry.threadId === threadId),
  };
};

/**
 * Registers the file's hooks: the stack and a paired page before the first step, a trace per
 * step, and `server.log` plus teardown after the last. `current()` is the suite inside a step.
 * Nothing starts when every step is skipped.
 */
export const useOmpSuite = (options: {
  readonly artifacts: string;
  readonly stack?: () => OmpStackOptions;
}): { readonly current: () => OmpSuite } => {
  let suite: OmpSuite | undefined;
  let context: BrowserContext | undefined;

  test.beforeAll(async ({ browser }) => {
    NodeFS.mkdirSync(options.artifacts, { recursive: true });
    const stack = await startOmpStack(options.stack?.());
    context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const page = await context.newPage();
    suite = makeSuite(stack, page, options.artifacts);
    // Through `location` rather than `page.goto`, so the report's step titles never show the
    // pairing token; tracing starts after pairing for the same reason.
    await page.evaluate((url) => window.location.assign(url), stack.pairingUrl);
    await page.waitForURL((url) => url.protocol === "http:" && !url.pathname.startsWith("/pair"));
    await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  });

  test.beforeEach(async () => {
    await context?.tracing.startChunk({ title: test.info().title });
  });

  test.afterEach(async () => {
    const path = NodePath.join(options.artifacts, `trace-${slug(test.info().title)}.zip`);
    await context?.tracing.stopChunk({ path });
    await test.info().attach("trace", { path, contentType: "application/zip" });
  });

  test.afterAll(async () => {
    if (suite !== undefined) {
      NodeFS.writeFileSync(NodePath.join(options.artifacts, "server.log"), suite.stack.serverLog());
    }
    await context?.tracing.stop();
    await context?.close();
    const stopped = await suite?.stack.stop();
    // PRD §9: no secret the run handled reaches the server's logs, traces or OMP's thread state.
    if (stopped !== undefined) {
      NodeFS.writeFileSync(
        NodePath.join(options.artifacts, "leaked-secrets.json"),
        `${JSON.stringify(stopped.leakedSecrets, null, 2)}\n`,
      );
      expect(stopped.leakedSecrets).toEqual([]);
    }
  });

  return {
    current: () => {
      if (suite === undefined) throw new Error("The OMP suite has not started.");
      return suite;
    },
  };
};
