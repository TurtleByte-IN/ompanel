// @effect-diagnostics nodeBuiltinImport:off - an end-to-end test reading the stack's files.
// Gate G2: OMP's control plane through the web app, against a real `omp` built from the omp.lock
// tag. One non-credential key changed on every OMP settings page and read back with
// `omp config get` from the test's OMP home; a sign-in against a fake login provider; `/wt` from
// a thread making a T3 worktree. Steps run in order on one page. See docs/omp/testing.md.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, type Locator, type Page, test } from "@playwright/test";

import { FAKE_SIGN_IN_EMAIL, FAKE_SIGN_IN_PROVIDER } from "./fakeSignIn.ts";
import { useOmpSuite } from "./ompSuite.ts";
import { STREAMED_PARAGRAPHS } from "./scriptedModel.ts";

const ARTIFACTS = NodePath.join(
  process.env.OMPANEL_E2E_ARTIFACTS_DIR ??
    NodePath.join(import.meta.dirname, "..", "..", ".playwright", "omp-artifacts"),
  "g2",
);

test.describe.configure({ mode: "serial" });

const suite = useOmpSuite({ artifacts: ARTIFACTS, stack: () => ({ fakeSignIn: true }) });

/** `omp config get <key> --json` against the stack's OMP home: what OMP itself resolves. */
const ompConfigValue = (key: string): unknown => {
  const setting: { readonly value?: unknown } = JSON.parse(
    suite.current().stack.omp("config", "get", key, "--json"),
  );
  return setting.value;
};

/** A full page load: the cached providers render before the connection is up. */
const openPage = async (page: Page, path: string) => {
  await page.goto(new URL(path, page.url()).href);
};

const settingRow = (page: Page, key: string) => page.locator(`[data-setting="${key}"]`);

/** Whether the client's cache (IndexedDB `server-config`) holds a server config listing OMP. */
const ompProviderCached = (page: Page) =>
  page.evaluate(async () => {
    const opened = indexedDB.open("t3code:connection-runtime");
    const database = Promise.withResolvers<IDBDatabase | null>();
    opened.addEventListener("success", () => database.resolve(opened.result));
    opened.addEventListener("error", () => database.resolve(null));
    const connection = await database.promise;
    if (connection === null || !connection.objectStoreNames.contains("server-config")) {
      connection?.close();
      return false;
    }
    const read = connection.transaction("server-config").objectStore("server-config").getAll();
    const values = Promise.withResolvers<ReadonlyArray<unknown>>();
    read.addEventListener("success", () => values.resolve(read.result));
    read.addEventListener("error", () => values.resolve([]));
    const stored = await values.promise;
    connection.close();
    return stored.some((value) => typeof value === "string" && value.includes('"driver":"omp"'));
  });

test("a full page load of an OMP settings page shows its settings", async () => {
  const { page, screenshot } = suite.current();
  await openPage(page, "/settings/omp-models");
  await expect(settingRow(page, "includeModelInPrompt")).toBeVisible();
  // Once the client has cached the environment's providers, every load renders them before the
  // connection is up, and an OMP page must wait for it before reading OMP instead of showing
  // "OMP settings are unavailable."
  await expect.poll(() => ompProviderCached(page)).toBe(true);
  for (const path of ["/settings/omp-routing", "/settings/omp-mcp", "/settings/omp-models"]) {
    await openPage(page, path);
    await expect(page.locator("[data-setting]").first()).toBeVisible();
    await expect(page.getByText(/unavailable/)).toHaveCount(0);
  }
  await page.reload();
  await expect(settingRow(page, "includeModelInPrompt")).toBeVisible();
  await expect(page.getByText(/unavailable/)).toHaveCount(0);
  await screenshot("01-full-page-load");
});

test("a full page load of the Usage page's OMP tab reads OMP", async () => {
  const { page, screenshot } = suite.current();
  await openPage(page, "/usage");
  await page.getByRole("button", { name: "OMP", exact: true }).click();
  // The tab is kept in the page's preferences, so the reload opens on it.
  await page.reload();
  const stats = page.getByRole("region", { name: "Last 24 hours" });
  await expect(stats).toHaveAttribute("data-omp-usage-source", "ok");
  await screenshot("01b-usage-omp-tab");
});

test("/wt from a thread creates a T3 worktree", async () => {
  const { page, stack, screenshot, createOmpThread, sendAndSettle, assistantSays, threadId } =
    suite.current();
  await openPage(page, "/");
  await createOmpThread("Full access");
  const branch = "g2-wt";
  await sendAndSettle(`/wt ${branch}`);
  // T3 made the worktree (OMP asked through `host_cwd_change_request` instead of making its own).
  await expect
    .poll(() => stack.git("worktree", "list", "--porcelain"))
    .toContain(`branch refs/heads/${branch}`);
  const worktree = stack
    .git("worktree", "list", "--porcelain")
    .split("\n\n")
    .find((entry) => entry.includes(`branch refs/heads/${branch}`))
    ?.match(/^worktree (.+)$/m)?.[1];
  expect(worktree).toBeDefined();
  expect(worktree).not.toBe(stack.workspace);
  // The thread is bound to it: the branch shows in the thread list and the thread's git panel.
  await expect(page.getByRole("navigation", { name: "Threads" }).getByText(branch)).toBeVisible();
  await expect(page.getByRole("main").getByText(branch, { exact: true })).toBeVisible();
  await screenshot("02a-wt-worktree");
  // The next message starts OMP in the worktree, on the same OMP session.
  await sendAndSettle("hello from the worktree");
  await expect(assistantSays(STREAMED_PARAGRAPHS[1])).toBeVisible();
  expect(
    suite
      .current()
      .threadProcesses(threadId())
      .map((entry) => entry.args),
  ).toEqual([expect.stringContaining(`--cwd ${worktree}`)]);
  await screenshot("02b-wt-next-turn");
});

test("signs in through a fake login provider", async () => {
  const { page, stack, screenshot } = suite.current();
  const signIn = stack.signIn!;
  await openPage(page, "/settings/providers");
  await page.getByRole("button", { name: "Show providers" }).click();
  const provider = page
    .getByRole("list", { name: "OMP providers" })
    .locator(`[data-provider="${FAKE_SIGN_IN_PROVIDER.id}"]`);
  await expect(provider).toContainText("Not signed in");
  await provider.getByRole("button", { name: "Sign in" }).click();

  const flow = page.getByRole("region", { name: "OMP sign-in" });
  await expect(flow.getByRole("button", { name: "Open sign-in page" })).toBeVisible();
  await expect(flow.getByRole("textbox", { name: "Paste the authorization code" })).toBeVisible();
  await screenshot("03a-sign-in-started");
  const vendorPage = page.context().waitForEvent("page");
  await flow.getByRole("button", { name: "Open sign-in page" }).click();
  const vendor = await vendorPage;
  await vendor.waitForLoadState();
  expect(vendor.url().startsWith(`${signIn.vendor.url}/authorize`)).toBe(true);
  const code = (await vendor.locator("[data-fake-vendor-code]").textContent()) ?? "";
  await vendor.screenshot({ path: NodePath.join(ARTIFACTS, "03b-fake-vendor-page.png") });
  await vendor.close();

  await flow.getByRole("textbox", { name: "Paste the authorization code" }).fill(code);
  await flow.getByRole("button", { name: "Submit" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: `Signed in to ${FAKE_SIGN_IN_PROVIDER.id}.` }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(provider).toContainText("Signed in");
  await expect(provider).not.toContainText("Not signed in");
  // The code went to the fake vendor's token endpoint, and nowhere else.
  expect(signIn.vendor.exchanged()).toEqual([code]);
  expect(JSON.parse(NodeFS.readFileSync(signIn.accountFile, "utf8"))).toMatchObject({
    email: FAKE_SIGN_IN_EMAIL,
  });
  await provider.scrollIntoViewIfNeeded();
  await screenshot("03c-signed-in");
});

interface SettingChange {
  /** The page's route segment after `/settings/omp-`. */
  readonly page: string;
  readonly key: string;
  readonly to: boolean | number | string;
}

/** One key per OMP settings page that `omp config set` writes. */
const SETTING_CHANGES: ReadonlyArray<SettingChange> = [
  { page: "models", key: "includeModelInPrompt", to: false },
  { page: "routing", key: "retry.maxRetries", to: 4 },
  { page: "thinking", key: "hideThinkingBlock", to: true },
  { page: "advisor", key: "advisor.immuneTurns", to: 5 },
  { page: "sampling", key: "topP", to: 0.9 },
  { page: "approvals", key: "tools.intentTracing", to: false },
  { page: "memory", key: "memory.backend", to: "local" },
  { page: "context", key: "compaction.thresholdPercent", to: 75 },
  { page: "modes", key: "plan.enabled", to: false },
  { page: "runtime", key: "eval.py", to: false },
  { page: "search", key: "web_search.enabled", to: false },
  { page: "discovery", key: "commands.enableClaudeProject", to: false },
  { page: "mcp", key: "mcp.startupTimeoutMs", to: 500 },
  { page: "customization", key: "ttsr.enabled", to: false },
];

const change = async (row: Locator, to: SettingChange["to"]) => {
  if (typeof to === "boolean") {
    const control = row.getByRole("switch");
    await expect(control).toBeChecked({ checked: !to });
    await control.click();
    return;
  }
  const control = row.getByRole("textbox");
  await control.fill(String(to));
  await control.press("Enter");
};

SETTING_CHANGES.forEach(({ page: pageId, key, to }, index) => {
  test(`writes ${key} on the OMP ${pageId} page`, async () => {
    const { page, screenshot } = suite.current();
    expect(ompConfigValue(key)).not.toEqual(to);
    await openPage(page, `/settings/omp-${pageId}`);
    const row = settingRow(page, key);
    await row.scrollIntoViewIfNeeded();
    await change(row, to);
    await expect.poll(() => ompConfigValue(key)).toEqual(to);
    // The form re-reads OMP after the write: the key now comes from the global layer.
    await expect(row.getByText("Global", { exact: true })).toBeVisible();
    await screenshot(`04-${String(index + 1).padStart(2, "0")}-${pageId}`);
  });
});

test("adds a custom provider on the OMP custom providers page", async () => {
  const { page, stack, screenshot } = suite.current();
  const provider = "g2-local";
  await openPage(page, "/settings/omp-providers");
  const section = page.getByRole("region", { name: "Custom providers" });
  await section.getByRole("textbox", { name: "New provider id" }).fill(provider);
  await section.getByRole("button", { name: "Add provider" }).click();
  const card = section.locator(`[data-custom-provider="${provider}"]`);
  const baseUrl = /baseUrl: (\S+)/.exec(
    NodeFS.readFileSync(NodePath.join(stack.home, ".omp", "agent", "models.yml"), "utf8"),
  )?.[1];
  await card.getByRole("textbox", { name: `${provider} baseUrl` }).fill(baseUrl ?? "");
  await card.getByRole("textbox", { name: `${provider} baseUrl` }).press("Enter");
  await card.getByRole("combobox", { name: `${provider} api` }).click();
  await page.getByRole("option", { name: "openai-completions", exact: true }).click();
  await card.getByRole("button", { name: "none", exact: true }).click();
  await card.getByRole("textbox", { name: `New model id for ${provider}` }).fill("g2-model");
  await card.getByRole("button", { name: "Add model" }).click();
  await section.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText(/OMP loaded \d+ model\(s\) from this file/)).toBeVisible();
  // OMP lists the new provider's model from models.yml.
  const listed: { readonly models: ReadonlyArray<{ readonly selector: string }> } = JSON.parse(
    stack.omp("models", provider, "--json", "--no-extensions"),
  );
  expect(listed.models.map((model) => model.selector)).toContain(`${provider}/g2-model`);
  await card.scrollIntoViewIfNeeded();
  await screenshot("05-custom-providers");
});

test("shows OMP's terminal preferences read-only", async () => {
  const { page, screenshot } = suite.current();
  const before = ompConfigValue("startup.quiet");
  await openPage(page, "/settings/omp-terminal");
  const row = settingRow(page, "startup.quiet");
  await expect(row.getByRole("switch")).toBeDisabled();
  await expect(row).toContainText("Terminal-only");
  expect(ompConfigValue("startup.quiet")).toEqual(before);
  await screenshot("06-terminal-read-only");
});

/** A plugin marketplace on disk (OMP reads a local path directly): one plugin with one skill. */
const writeLocalMarketplace = (dir: string) => {
  const write = (path: string, content: string) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, path)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, path), content);
  };
  write(
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      name: "g2-local",
      owner: { name: "G2 E2E" },
      plugins: [
        {
          name: "g2-plugin",
          source: "./plugins/g2-plugin",
          description: "G2 end-to-end plugin",
          version: "1.0.0",
        },
      ],
    }),
  );
  write(
    "plugins/g2-plugin/.claude-plugin/plugin.json",
    JSON.stringify({ name: "g2-plugin", version: "1.0.0", description: "G2 end-to-end plugin" }),
  );
  write(
    "plugins/g2-plugin/skills/g2-skill/SKILL.md",
    "---\nname: g2-skill\ndescription: Skill shipped by the G2 plugin\n---\n\nSay hello.\n",
  );
};

const PLUGIN = "g2-plugin@g2-local";

interface OmpPluginList {
  readonly marketplace: ReadonlyArray<{
    readonly id: string;
    readonly entries: ReadonlyArray<{ readonly enabled?: boolean }>;
  }>;
}

const installedPlugin = () => {
  const list: OmpPluginList = JSON.parse(suite.current().stack.omp("plugin", "list", "--json"));
  return list.marketplace.find((plugin) => plugin.id === PLUGIN);
};

const confirmPluginCommand = async (page: Page, command: string, label: string) => {
  const dialog = page.locator("[data-omp-plugin-confirm]");
  await expect(dialog.locator("[data-omp-plugin-command]")).toHaveText(command);
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await expect(dialog).toHaveCount(0);
};

test("installs a plugin from a local marketplace on the OMP plugins page", async () => {
  const { page, stack, screenshot } = suite.current();
  const marketplace = NodePath.join(NodePath.dirname(stack.home), "g2-marketplace");
  writeLocalMarketplace(marketplace);
  await openPage(page, "/settings/omp-plugins");
  await expect(page.locator("[data-omp-plugins]")).toContainText("No plugins installed.");

  await page.getByRole("textbox", { name: "Marketplace to add" }).fill(marketplace);
  await page.getByRole("button", { name: "Add marketplace…" }).click();
  await expect(page.locator('[data-omp-plugin-confirm="marketplace_add"]')).toContainText(
    "Third-party code",
  );
  await screenshot("07a-confirm-marketplace-add");
  await confirmPluginCommand(page, `omp plugin marketplace add ${marketplace}`, "Add marketplace");
  const listed = page.locator('[data-omp-marketplace="g2-local"]');
  await listed.getByRole("button", { name: "Browse" }).click();
  await page
    .locator(`[data-omp-marketplace-plugin="${PLUGIN}"]`)
    .getByRole("button", { name: "Install…" })
    .click();
  await expect(page.locator('[data-omp-plugin-confirm="install"]')).toContainText(
    "Third-party code",
  );
  await screenshot("07b-confirm-install");
  await confirmPluginCommand(page, `omp plugin install ${PLUGIN}`, "Install");
  const plugin = page.locator(`[data-omp-plugin="${PLUGIN}"]`);
  await expect(plugin).toBeVisible();
  expect(installedPlugin()?.entries[0]?.enabled).not.toBe(false);
  await screenshot("07c-plugin-installed");

  // The enable toggle: OMP's own list reports the plugin disabled.
  await plugin.getByRole("button", { name: "Disable" }).click();
  await confirmPluginCommand(page, `omp plugin disable ${PLUGIN}`, "Disable");
  await expect(plugin).toContainText("disabled");
  expect(installedPlugin()?.entries[0]?.enabled).toBe(false);
  await screenshot("07d-plugin-disabled");
  await plugin.getByRole("button", { name: "Enable" }).click();
  await confirmPluginCommand(page, `omp plugin enable ${PLUGIN}`, "Enable");
  await expect(plugin).not.toContainText("disabled");
  expect(installedPlugin()?.entries[0]?.enabled).not.toBe(false);
});

test("lists the plugin's skill on the OMP skills page", async () => {
  const { page, stack, screenshot } = suite.current();
  await openPage(page, "/settings/omp-skills");
  await expect(page.locator('[data-omp-skill="g2-skill"]')).toBeVisible();
  const skills: { readonly skills: ReadonlyArray<{ readonly name: string }> } = JSON.parse(
    stack.omp("skill", "list", stack.workspace, "--json"),
  );
  expect(skills.skills.map((skill) => skill.name)).toContain("g2-skill");
  await screenshot("08-skills");
});
