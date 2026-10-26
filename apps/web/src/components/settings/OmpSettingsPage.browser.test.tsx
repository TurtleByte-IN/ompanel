import {
  EnvironmentId,
  OmpAgentFilesOperationError,
  ProviderInstanceId,
  type OmpConfigType,
} from "@t3tools/contracts";
import { buildOmpSettingsForm } from "@t3tools/provider-omp/configForm";
import { OMP_MODEL_ROLES, OMP_SETTINGS_PAGES } from "@t3tools/provider-omp/settingsPages";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import {
  elementsPastViewport,
  settingsContentColumn,
  usePhoneViewport,
} from "../../../test/phoneViewport";
import { render } from "../../../test/render";
import { toastManager } from "../ui/toast";

// What the pinned OMP registers for the pages, plus one key no page shows.
const REGISTRY: Readonly<Record<string, { type: OmpConfigType; default: unknown; env?: true }>> = {
  modelRoles: { type: "record", default: { default: "anthropic/claude-sonnet-4-5" } },
  modelRoleStorage: { type: "enum", default: "global" },
  modelTags: { type: "record", default: {} },
  modelProviderOrder: { type: "array", default: [] },
  cycleOrder: { type: "array", default: [] },
  enabledModels: { type: "array", default: [] },
  enabledProviders: { type: "array", default: [] },
  disabledProviders: { type: "array", default: [] },
  includeModelInPrompt: { type: "boolean", default: false },
  "retry.enabled": { type: "boolean", default: true, env: true },
  "retry.maxRetries": { type: "number", default: 3 },
  "retry.fallbackChains": { type: "record", default: {} },
  "auth.accountPolicies": { type: "record", default: {} },
  "task.agentAccountPools": { type: "record", default: {} },
  "providers.anthropic.serverSideFallback": { type: "boolean", default: false },
  defaultThinkingLevel: { type: "enum", default: "high" },
  hideThinkingBlock: { type: "boolean", default: false },
  "thinkingBudgets.high": { type: "number", default: 16384 },
  "thinkingBudgets.low": { type: "number", default: 2048 },
  "providers.autoThinkingMaxEffort": { type: "enum", default: "high" },
  "compaction.enabled": { type: "boolean", default: true },
  "advisor.enabled": { type: "boolean", default: false },
  "advisor.reviewMode": { type: "enum", default: "turn" },
  "advisor.immuneTurns": { type: "number", default: 3 },
  "task.agentAdvisor": { type: "record", default: {} },
  temperature: { type: "number", default: -1 },
  topP: { type: "number", default: -1 },
  textVerbosity: { type: "enum", default: "medium" },
  personality: { type: "enum", default: "default" },
  "tier.openai": { type: "enum", default: "none" },
  "tools.approvalMode": { type: "enum", default: "yolo" },
  "tools.approval": { type: "record", default: { read: "allow" } },
  "bash.patterns": { type: "array", default: [] },
  "bashInterceptor.enabled": { type: "boolean", default: false },
  "bashInterceptor.patterns": { type: "array", default: [] },
  "tools.intentTracing": { type: "boolean", default: true, env: true },
  "tools.xdev": { type: "boolean", default: true },
  "tools.xdevDocs": { type: "enum", default: "catalog" },
  "tools.xdevInlineDevices": { type: "array", default: [] },
  "memory.backend": { type: "enum", default: "off" },
  "memories.maxRolloutAgeDays": { type: "number", default: 30 },
  "hindsight.apiUrl": { type: "string", default: "" },
  "hindsight.apiToken": { type: "string", default: "" },
  "mnemopi.recallLimit": { type: "number", default: 8 },
  "sharpshooter.model": { type: "string", default: "" },
  "compaction.methodOrder": { type: "array", default: ["snapshot", "summary"] },
  "compaction.thresholdPercent": { type: "number", default: 80 },
  "plan.enabled": { type: "boolean", default: true },
  "goal.continuationModes": { type: "array", default: [] },
  "loop.mode": { type: "enum", default: "prompt" },
  "eval.py": { type: "boolean", default: true },
  "eval.js": { type: "boolean", default: true },
  "providers.tinyModelDevice": { type: "enum", default: "auto", env: true },
  "providers.tinyModelDtype": { type: "enum", default: "auto" },
  "web_search.enabled": { type: "boolean", default: true },
  "providers.webSearchTimeoutSeconds": { type: "number", default: 30 },
  "exa.enabled": { type: "boolean", default: true },
  "searxng.endpoint": { type: "string", default: "" },
  "searxng.token": { type: "string", default: "" },
  "skills.enableClaudeUser": { type: "boolean", default: true },
  "commands.enableClaudeProject": { type: "boolean", default: true },
  "mcp.enableProjectConfig": { type: "boolean", default: true },
  "contextFiles.extra": { type: "array", default: [] },
  "startup.quiet": { type: "boolean", default: false },
  "theme.dark": { type: "string", default: "titanium" },
  "statusLine.preset": { type: "enum", default: "default" },
  "mcp.startupTimeoutMs": { type: "number", default: 30000 },
  "ttsr.enabled": { type: "boolean", default: true },
  "skills.customDirectories": { type: "array", default: [] },
  extensions: { type: "array", default: [] },
  "marketplace.autoUpdate": { type: "enum", default: "notify" },
  "skills.registryUrl": { type: "string", default: "https://skills.omp.sh" },
};

/** The settings engine over an in-memory global layer: every write re-reads the list. */
const engine = vi.hoisted(() => ({ global: new Map<string, unknown>() }));
const engineForm = () =>
  buildOmpSettingsForm(
    Object.fromEntries(
      Object.entries(REGISTRY).map(([key, setting]) => [
        key,
        {
          type: setting.type,
          description: `${key} help`,
          source: setting.env ? "env" : engine.global.has(key) ? "global" : "default",
          value: engine.global.has(key) ? engine.global.get(key) : setting.default,
        },
      ]),
    ),
  );
const commands = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  reset: vi.fn(),
  listFiles: vi.fn(),
  readFile: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  unpackAgents: vi.fn(),
  listPlugins: vi.fn(),
  runPluginCommand: vi.fn(),
  discoverMarketplace: vi.fn(),
  reloadPlugins: vi.fn(),
  checkUpdate: vi.fn(),
  listSkills: vi.fn(),
  openInEditor: vi.fn(),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => {
  const { serverEnvironment } = await import("../../state/server");
  const byAtom = new Map<unknown, unknown>([
    [serverEnvironment.readOmpSettings, commands.read],
    [serverEnvironment.writeOmpSetting, commands.write],
    [serverEnvironment.resetOmpSetting, commands.reset],
    [serverEnvironment.listOmpAgentFiles, commands.listFiles],
    [serverEnvironment.readOmpAgentFile, commands.readFile],
    [serverEnvironment.writeOmpAgentFile, commands.writeFile],
    [serverEnvironment.deleteOmpAgentFile, commands.deleteFile],
    [serverEnvironment.unpackOmpAgents, commands.unpackAgents],
    [serverEnvironment.listOmpPlugins, commands.listPlugins],
    [serverEnvironment.runOmpPluginCommand, commands.runPluginCommand],
    [serverEnvironment.discoverOmpMarketplace, commands.discoverMarketplace],
    [serverEnvironment.reloadOmpPlugins, commands.reloadPlugins],
    [serverEnvironment.checkOmpUpdate, commands.checkUpdate],
    [serverEnvironment.listOmpSkills, commands.listSkills],
  ]);
  return {
    ...(await original()),
    useAtomCommand: ((atom: unknown) => byAtom.get(atom)) as never,
  };
});

vi.mock(import("../../editorPreferences"), async (original) => ({
  ...(await original()),
  useOpenInPreferredEditor: (() => commands.openInEditor) as never,
}));

vi.mock(import("../../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  return {
    ...(await original()),
    primaryServerAvailableEditorsAtom: Atom.make(["vscode"] as never),
  };
});

import { OmpSettingsPageBody } from "./OmpSettingsPage";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("omp");
const row = (key: string) => document.querySelector(`[data-setting="${key}"]`);

/** The agent directory: every file by its relative path. */
const files = vi.hoisted(() => new Map<string, string>());
const AGENT_DIR = "/home/tester/.omp/profiles/work/agent";
const fileVersion = (content: string) => `v:${content}`;
type FileRef =
  | { kind: "watchdog" }
  | { kind: "models" }
  | { kind: "agent"; name: string }
  | { kind: "mcp"; name: string }
  | { kind: "custom"; category: string; path: string };
const relativePathOf = (file: FileRef) => {
  switch (file.kind) {
    case "watchdog":
      return "WATCHDOG.yml";
    case "models":
      return "models.yml";
    case "mcp":
      return file.name;
    case "custom":
      return file.path;
    case "agent":
      return `agents/${file.name}`;
  }
};
const CATEGORY_OF: ReadonlyArray<readonly [string, string]> = [
  ["skills/", "skill"],
  ["rules/", "rule"],
  ["RULES.md", "rule"],
  ["prompts/", "prompt"],
  ["hooks/", "hook"],
  ["tools/", "tool"],
];
/** MCP servers the server would list from `mcp.json`. */
const mcpServers = () => {
  const text = files.get("mcp.json");
  if (text === undefined) return [];
  const parsed: { mcpServers?: Record<string, { command?: string }> } = JSON.parse(text);
  return Object.entries(parsed.mcpServers ?? {}).map(([name, server]) => ({
    name,
    file: "mcp.json",
    transport: "stdio",
    ...(server.command === undefined ? {} : { target: server.command }),
    disabled: false,
  }));
};
const fileList = () => ({
  agentDir: AGENT_DIR,
  watchdogFileName: "WATCHDOG.yml",
  watchdogExists: files.has("WATCHDOG.yml"),
  agents: [...files.keys()]
    .filter((path) => path.startsWith("agents/"))
    .map((path) => ({ name: path.slice("agents/".length), editable: true }))
    .toSorted((left, right) => left.name.localeCompare(right.name)),
  modelsFileName: "models.yml",
  modelsExists: files.has("models.yml"),
  modelsLegacyJson: false,
  mcpFiles: ["mcp.json", ".mcp.json"].map((name) => ({ name, exists: files.has(name) })),
  mcpServers: mcpServers(),
  customization: [...files.keys()]
    .flatMap((path) => {
      const category = CATEGORY_OF.find(([prefix]) => path.startsWith(prefix))?.[1];
      return category === undefined ? [] : [{ category, path, editable: true }];
    })
    .toSorted((left, right) => left.path.localeCompare(right.path)),
});
/** What OMP's `models.yml` check refuses here: a provider naming an `api` OMP does not know. */
const MODELS_REFUSED = /api: carrier-pigeon/;

/** Empties the global layer and the agent directory, and wires the commands to them. */
function resetEngine() {
  engine.global.clear();
  files.clear();
  commands.read.mockReset().mockImplementation(async () => ({
    _tag: "Success",
    value: engineForm(),
  }));
  commands.write
    .mockReset()
    .mockImplementation(async ({ input }: { input: { key: string; value: unknown } }) => {
      engine.global.set(input.key, input.value);
      return { _tag: "Success", value: { form: engineForm(), restartRequired: [] } };
    });
  commands.reset.mockReset().mockImplementation(async ({ input }: { input: { key: string } }) => {
    engine.global.delete(input.key);
    return { _tag: "Success", value: { form: engineForm(), restartRequired: [] } };
  });
  commands.listFiles.mockReset().mockImplementation(async () => ({
    _tag: "Success",
    value: fileList(),
  }));
  commands.readFile
    .mockReset()
    .mockImplementation(async ({ input }: { input: { file: FileRef } }) => {
      const relativePath = relativePathOf(input.file);
      const content = files.get(relativePath);
      return {
        _tag: "Success",
        value: {
          file: input.file,
          relativePath,
          ...(content === undefined ? {} : { content, version: fileVersion(content) }),
        },
      };
    });
  commands.writeFile
    .mockReset()
    .mockImplementation(
      async ({ input }: { input: { file: FileRef; content: string; baseVersion?: string } }) => {
        const relativePath = relativePathOf(input.file);
        const current = files.get(relativePath);
        // The page must send the version it read; a stale one fails the test outright.
        if ((current === undefined ? undefined : fileVersion(current)) !== input.baseVersion) {
          throw new Error(`${relativePath}: stale baseVersion ${input.baseVersion}`);
        }
        // OMP's check leaves the file as it was when it refuses the text.
        if (input.file.kind === "models" && MODELS_REFUSED.test(input.content)) {
          return AsyncResult.failure(
            Cause.fail(
              new OmpAgentFilesOperationError({
                reason: "invalid",
                message: "OMP did not load this models.yml. The file was not saved.",
              }),
            ),
          );
        }
        files.set(relativePath, input.content);
        return {
          _tag: "Success",
          value: {
            file: input.file,
            relativePath,
            content: input.content,
            version: fileVersion(input.content),
            ...(input.file.kind === "models"
              ? { checkedModels: [{ provider: "lab", id: "a" }] }
              : {}),
          },
        };
      },
    );
  commands.deleteFile
    .mockReset()
    .mockImplementation(async ({ input }: { input: { file: FileRef } }) => {
      files.delete(relativePathOf(input.file));
      return { _tag: "Success", value: fileList() };
    });
  commands.unpackAgents.mockReset().mockImplementation(async () => {
    const written = ["explore.md", "plan.md"].filter((name) => !files.has(`agents/${name}`));
    const skipped = ["explore.md", "plan.md"].filter((name) => !written.includes(name));
    for (const name of written) files.set(`agents/${name}`, `# ${name}\n`);
    return { _tag: "Success", value: { written, skipped, files: fileList() } };
  });
  plugins.installed = [
    {
      id: "differential-review@trailofbits",
      source: "marketplace",
      version: "1.1.4",
      enabled: true,
      scope: "user",
      shadowed: false,
    },
  ];
  commands.listPlugins.mockReset().mockImplementation(async () => ({
    _tag: "Success",
    value: pluginList(),
  }));
  commands.runPluginCommand
    .mockReset()
    .mockImplementation(async ({ input }: { input: { command: Record<string, string> } }) => {
      const { command } = input;
      if (command["action"] === "install") {
        plugins.installed.push({
          id: command["spec"]!,
          source: "marketplace",
          version: "2.0.2",
          enabled: true,
          scope: "user",
          shadowed: false,
        });
      } else if (command["action"] === "uninstall") {
        plugins.installed = plugins.installed.filter((plugin) => plugin.id !== command["name"]);
      } else if (command["action"] === "disable" || command["action"] === "enable") {
        plugins.installed = plugins.installed.map((plugin) =>
          plugin.id === command["name"]
            ? { ...plugin, enabled: command["action"] === "enable" }
            : plugin,
        );
      }
      return { _tag: "Success", value: pluginList() };
    });
  commands.discoverMarketplace.mockReset().mockImplementation(async () => ({
    _tag: "Success",
    value: {
      marketplace: "trailofbits",
      plugins: [
        {
          name: "audit-context-building",
          version: "2.0.2",
          description: "Understand a codebase before looking for bugs in it.",
        },
        { name: "differential-review", version: "1.1.4" },
      ],
    },
  }));
  commands.reloadPlugins
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { reloaded: 2, busy: 1, failed: 0 } });
  commands.checkUpdate.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { status: "available", currentVersion: "18.12.6", latestVersion: "18.13.0" },
  });
  commands.listSkills.mockReset().mockResolvedValue({
    _tag: "Success",
    value: {
      skills: [
        {
          name: "grilling",
          description: "Stress-test a plan",
          filePath: "/home/tester/.omp/plugins/cache/mattpocock/skills/grilling/SKILL.md",
          source: "claude-plugins:user",
          hidden: false,
        },
        {
          name: "tdd",
          description: "Test first",
          filePath: `${AGENT_DIR}/skills/tdd/SKILL.md`,
          source: "native:user",
          hidden: true,
        },
      ],
      warnings: [{ skillPath: `${AGENT_DIR}/skills/bad`, message: "missing description" }],
    },
  });
  commands.openInEditor.mockReset().mockResolvedValue({ _tag: "Success", value: "vscode" });
  toastSpy.mockClear();
}

/** Installed plugins as `omp plugin list --json` reads them, mutated by confirmed commands. */
const plugins = vi.hoisted(() => ({ installed: [] as Array<Record<string, unknown>> }));
const pluginList = () => ({
  command: ["omp", "--profile", "work"],
  // A fresh array per read, as decoding one would give.
  plugins: [...plugins.installed],
  marketplaces: [{ name: "trailofbits", source: "trailofbits/skills" }],
});

const toastSpy = vi.spyOn(toastManager, "add");

describe("OMP settings pages", () => {
  it.each(Object.values(OMP_SETTINGS_PAGES).filter((page) => page.keys.length > 0))(
    "$title shows exactly its keys with their source layer",
    async (page) => {
      resetEngine();
      await using _screen = await render(
        <OmpSettingsPageBody
          environmentId={environmentId}
          instanceId={instanceId}
          pageId={page.id}
        />,
      );
      await expect.poll(() => document.querySelector("[data-setting]")).not.toBeNull();
      const shown = [...document.querySelectorAll("[data-setting]")].map((element) =>
        element.getAttribute("data-setting"),
      );
      const expected = Object.keys(REGISTRY).filter((key) =>
        page.keys.some((pattern) =>
          pattern.endsWith(".") ? key.startsWith(pattern) : key === pattern,
        ),
      );
      expect(shown.toSorted()).toEqual(expected.toSorted());
      for (const element of document.querySelectorAll("[data-setting]")) {
        expect(element.textContent).toMatch(/Default|Global|Environment/);
      }
      expect(commands.read).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    },
  );

  it("Models & Roles edits one role and keeps the others", async () => {
    resetEngine();
    await using screen = await render(
      <OmpSettingsPageBody environmentId={environmentId} instanceId={instanceId} pageId="models" />,
    );
    const roles = OMP_MODEL_ROLES.map(({ role }) => role);
    expect(roles).not.toContain("designer");
    for (const role of roles) {
      await expect
        .element(screen.getByRole("textbox", { name: `modelRoles.${role}` }))
        .toBeVisible();
    }
    const smol = screen.getByRole("textbox", { name: "modelRoles.smol" });
    await userEvent.type(smol, "anthropic/claude-haiku-4-5{Enter}");

    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        instanceId,
        scope: "global",
        key: "modelRoles",
        value: { default: "anthropic/claude-sonnet-4-5", smol: "anthropic/claude-haiku-4-5" },
      },
    });
    // The engine's re-read is what the page shows.
    await expect.poll(() => row("modelRoles")?.textContent).toContain("Global");
    await expect.element(smol).toHaveValue("anthropic/claude-haiku-4-5");

    await userEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(commands.reset).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, scope: "global", key: "modelRoles" },
    });
    await expect.element(smol).toHaveValue("");
  });

  it("Routing writes a retry count and leaves an env-set key read-only", async () => {
    resetEngine();
    await using screen = await render(
      <OmpSettingsPageBody
        environmentId={environmentId}
        instanceId={instanceId}
        pageId="routing"
      />,
    );
    await expect.element(screen.getByRole("switch", { name: "retry.enabled" })).toBeDisabled();
    const retries = screen.getByRole("textbox", { name: "retry.maxRetries" });
    await userEvent.clear(retries);
    await userEvent.type(retries, "7{Enter}");

    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, scope: "global", key: "retry.maxRetries", value: 7 },
    });
    await expect.poll(() => row("retry.maxRetries")?.textContent).toContain("Global");
    await expect.element(retries).toHaveValue("7");
  });

  it("Routing shows path-scoped model lists without a way to overwrite them", async () => {
    resetEngine();
    // `config list` resolves path-scoped entries for its folder; writing this back would drop them.
    engine.global.set("enabledModels", ["anthropic/claude-sonnet-4-5"]);
    await using screen = await render(
      <OmpSettingsPageBody
        environmentId={environmentId}
        instanceId={instanceId}
        pageId="routing"
      />,
    );
    for (const key of ["enabledModels", "enabledProviders", "disabledProviders"]) {
      await expect.element(screen.getByRole("textbox", { name: key })).toBeDisabled();
      expect(row(key)?.textContent).toContain("scoped to other folders");
    }
    expect(row("enabledModels")?.textContent).toContain("Global");
    expect(row("enabledModels")?.querySelector("button")).toBeNull();
    expect(commands.write).not.toHaveBeenCalled();
    expect(commands.reset).not.toHaveBeenCalled();
  });

  it("Thinking writes a budget and shows the re-read value", async () => {
    resetEngine();
    await using screen = await render(
      <OmpSettingsPageBody
        environmentId={environmentId}
        instanceId={instanceId}
        pageId="thinking"
      />,
    );
    const budget = screen.getByRole("textbox", { name: "thinkingBudgets.high" });
    await userEvent.clear(budget);
    await userEvent.type(budget, "32000{Enter}");

    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, scope: "global", key: "thinkingBudgets.high", value: 32000 },
    });
    await expect.poll(() => row("thinkingBudgets.high")?.textContent).toContain("Global");
    await expect.element(budget).toHaveValue("32000");
  });

  const renderPage = (pageId: "advisor" | "sampling" | "approvals") =>
    render(
      <OmpSettingsPageBody environmentId={environmentId} instanceId={instanceId} pageId={pageId} />,
    );

  it("Sampling writes a temperature and shows the re-read value", async () => {
    resetEngine();
    await using screen = await renderPage("sampling");
    const temperature = screen.getByRole("textbox", { name: "temperature" });
    await expect.element(temperature).toHaveValue("-1");
    await userEvent.clear(temperature);
    await userEvent.type(temperature, "0.2{Enter}");

    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, scope: "global", key: "temperature", value: 0.2 },
    });
    await expect.poll(() => row("temperature")?.textContent).toContain("Global");
    await expect.element(temperature).toHaveValue("0.2");
    expect(row("topP")?.textContent).toContain("Default");
  });

  it("Approvals & Tools sets the approval mode and says how Ompanel threads launch", async () => {
    resetEngine();
    await using screen = await renderPage("approvals");
    await expect
      .element(screen.getByRole("button", { name: "Yolo" }))
      .toHaveAttribute("aria-pressed", "true");
    expect(row("tools.approvalMode")?.textContent).toContain(
      "Supervised → always-ask, Auto-accept edits → write, Full access → yolo",
    );
    // `PI_INTENT_TRACING` sets it, so the page cannot.
    await expect
      .element(screen.getByRole("switch", { name: "tools.intentTracing" }))
      .toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Always ask" }));
    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, scope: "global", key: "tools.approvalMode", value: "always-ask" },
    });
    await expect.poll(() => row("tools.approvalMode")?.textContent).toContain("Global");
    await expect
      .element(screen.getByRole("button", { name: "Always ask" }))
      .toHaveAttribute("aria-pressed", "true");
  });

  it("Approvals & Tools adds, changes and removes tool rules, keeping the others", async () => {
    resetEngine();
    await using screen = await renderPage("approvals");
    await userEvent.fill(screen.getByRole("textbox", { name: "New tools.approval tool" }), "bash");
    await userEvent.click(
      screen.getByRole("group", { name: "New tools.approval policy" }).getByRole("button", {
        name: "deny",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add tools.approval rule" }));
    expect(commands.write).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        scope: "global",
        key: "tools.approval",
        value: { read: "allow", bash: "deny" },
      },
    });

    await userEvent.click(
      screen.getByRole("group", { name: "tools.approval.read" }).getByRole("button", {
        name: "prompt",
      }),
    );
    expect(commands.write).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        scope: "global",
        key: "tools.approval",
        value: { read: "prompt", bash: "deny" },
      },
    });

    await userEvent.click(screen.getByRole("button", { name: "Remove bash" }));
    expect(commands.write).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, scope: "global", key: "tools.approval", value: { read: "prompt" } },
    });
    expect(commands.write).toHaveBeenCalledTimes(3);
  });

  it("Approvals & Tools reorders and adds bash patterns, keeping entries OMP ignores", async () => {
    resetEngine();
    engine.global.set("bash.patterns", [
      { match: "git status*", approval: "allow" },
      { match: "rm *", approval: "deny" },
      "not a rule",
    ]);
    await using screen = await renderPage("approvals");
    await expect
      .element(screen.getByRole("textbox", { name: "bash.patterns 2 match" }))
      .toHaveValue("rm *");
    expect(row("bash.patterns")?.textContent).toContain("ignored by OMP");

    await userEvent.click(screen.getByRole("button", { name: "Move rule 2 up" }));
    expect(commands.write).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        scope: "global",
        key: "bash.patterns",
        value: [
          { match: "rm *", approval: "deny" },
          { match: "git status*", approval: "allow" },
          "not a rule",
        ],
      },
    });

    await userEvent.fill(
      screen.getByRole("textbox", { name: "New bash.patterns match" }),
      "npm test*",
    );
    await userEvent.click(
      screen.getByRole("group", { name: "New bash.patterns approval" }).getByRole("button", {
        name: "allow",
      }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Add bash.patterns rule" }));
    expect(commands.write).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        scope: "global",
        key: "bash.patterns",
        value: [
          { match: "rm *", approval: "deny" },
          { match: "git status*", approval: "allow" },
          "not a rule",
          { match: "npm test*", approval: "allow" },
        ],
      },
    });
  });

  it("Advisor & Agents sets which subagents get an advisor", async () => {
    resetEngine();
    await using screen = await renderPage("advisor");
    await userEvent.fill(
      screen.getByRole("textbox", { name: "New task.agentAdvisor agent" }),
      "task",
    );
    await userEvent.fill(
      screen.getByRole("textbox", { name: "New task.agentAdvisor value" }),
      "on",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add task.agentAdvisor rule" }));
    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, scope: "global", key: "task.agentAdvisor", value: { task: "on" } },
    });
    await expect.poll(() => row("task.agentAdvisor")?.textContent).toContain("Global");
    await expect
      .element(screen.getByRole("textbox", { name: "task.agentAdvisor.task" }))
      .toHaveValue("on");
  });

  it("Advisor & Agents edits WATCHDOG.yml and custom agents in the profile's agent directory", async () => {
    resetEngine();
    const reviewer = "---\nname: reviewer\n---\nReview.\n";
    files.set("agents/reviewer.md", reviewer);
    await using screen = await renderPage("advisor");
    await expect.element(screen.getByText(AGENT_DIR)).toBeVisible();
    await expect.element(screen.getByText("not created yet")).toBeVisible();

    // A new roster: created without a base version.
    await userEvent.click(screen.getByRole("button", { name: "WATCHDOG.yml" }));
    const roster = screen.getByRole("textbox", { name: "Contents of WATCHDOG.yml" });
    await expect.element(roster).toHaveValue("");
    await userEvent.fill(roster, "advisors:\n  - name: Security\n");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(commands.writeFile).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        file: { kind: "watchdog" },
        content: "advisors:\n  - name: Security\n",
      },
    });
    await expect.poll(() => files.get("WATCHDOG.yml")).toBe("advisors:\n  - name: Security\n");

    // An existing agent: saved at the version it was read.
    await userEvent.click(screen.getByRole("button", { name: "reviewer.md" }));
    const agentText = screen.getByRole("textbox", { name: "Contents of agents/reviewer.md" });
    await expect.element(agentText).toHaveValue(reviewer);
    await userEvent.fill(agentText, `${reviewer}Be strict.\n`);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(commands.writeFile).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        file: { kind: "agent", name: "reviewer.md" },
        content: `${reviewer}Be strict.\n`,
        baseVersion: fileVersion(reviewer),
      },
    });
    await expect.poll(() => files.get("agents/reviewer.md")).toBe(`${reviewer}Be strict.\n`);

    // A name that would leave agents/ is refused before anything is sent.
    const newName = screen.getByRole("textbox", { name: "New agent file name" });
    await userEvent.fill(newName, "../escape");
    await expect.element(screen.getByRole("button", { name: "New agent" })).toBeDisabled();

    await userEvent.fill(newName, "planner");
    await userEvent.click(screen.getByRole("button", { name: "New agent" }));
    const plannerText = screen.getByRole("textbox", { name: "Contents of agents/planner.md" });
    await expect.element(plannerText).toHaveValue("---\nname: planner\ndescription: \n---\n\n");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(commands.writeFile).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        file: { kind: "agent", name: "planner.md" },
        content: "---\nname: planner\ndescription: \n---\n\n",
      },
    });
    await expect.element(screen.getByRole("button", { name: "planner.md" })).toBeVisible();

    // Delete asks once more, then removes the file at the version read.
    await userEvent.click(screen.getByRole("button", { name: "reviewer.md" }));
    await expect
      .element(screen.getByRole("textbox", { name: "Contents of agents/reviewer.md" }))
      .toHaveValue(`${reviewer}Be strict.\n`);
    await userEvent.click(screen.getByRole("button", { name: "Delete…" }));
    expect(commands.deleteFile).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete agents/reviewer.md" }));
    expect(commands.deleteFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        instanceId,
        file: { kind: "agent", name: "reviewer.md" },
        baseVersion: fileVersion(`${reviewer}Be strict.\n`),
      },
    });
    await expect.poll(() => document.querySelector("[data-agent-file]")).toBeNull();
    expect(files.has("agents/reviewer.md")).toBe(false);
  });

  const renderK04d = (pageId: "providers" | "mcp" | "customization") =>
    render(
      <OmpSettingsPageBody environmentId={environmentId} instanceId={instanceId} pageId={pageId} />,
    );

  const LAB = [
    "# The lab box",
    "providers:",
    "  lab:",
    "    baseUrl: http://lab:8000/v1",
    "    api: openai-completions",
    "    apiKey: LAB_KEY",
    "    headers:",
    "      X-Team: ml",
    "    models:",
    "      - id: a",
    "",
  ].join("\n");

  it("Custom providers edits models.yml in the form, keeping what the form does not show", async () => {
    resetEngine();
    files.set("models.yml", LAB);
    await using screen = await renderK04d("providers");
    await expect
      .element(screen.getByRole("textbox", { name: "lab baseUrl" }))
      .toHaveValue("http://lab:8000/v1");
    await expect
      .element(screen.getByRole("textbox", { name: "lab apiKey" }))
      .toHaveValue("LAB_KEY");
    await expect
      .element(screen.getByText("Also set in YAML, kept as written: headers."))
      .toBeVisible();
    // models.yml is not one of OMP's settings: nothing is read through the settings engine.
    expect(commands.read).not.toHaveBeenCalled();
    await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await userEvent.type(
      screen.getByRole("textbox", { name: "lab/a contextWindow" }),
      "32768{Enter}",
    );
    await userEvent.click(screen.getByRole("switch", { name: "lab/a reasoning" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "New model id for lab" }), "b");
    await userEvent.click(screen.getByRole("button", { name: "Add model" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "New provider id" }), "local");
    await userEvent.click(screen.getByRole("button", { name: "Add provider" }));
    await userEvent.click(screen.getByRole("button", { name: "none" }).last());
    await expect.element(screen.getByRole("textbox", { name: "local baseUrl" })).toHaveValue("");
    // A provider id OMP would not take as a key is refused before anything changes.
    await userEvent.fill(screen.getByRole("textbox", { name: "New provider id" }), "a b");
    await expect.element(screen.getByRole("button", { name: "Add provider" })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await expect.poll(() => files.get("models.yml")).not.toBe(LAB);
    const saved = files.get("models.yml") ?? "";
    expect(saved).toContain("# The lab box");
    expect(saved).toContain("X-Team: ml");
    expect(saved).toContain("contextWindow: 32768");
    expect(saved).toContain("reasoning: true");
    expect(saved).toContain("- id: b");
    expect(saved).toMatch(/local:\n {4}api: openai-completions\n {4}models: \[\]\n {4}auth: none/);
    expect(commands.writeFile).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        file: { kind: "models" },
        content: saved,
        baseVersion: fileVersion(LAB),
      },
    });
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "OMP loaded 1 model(s) from this file" }),
    );
  });

  it("Custom providers saves raw YAML only when OMP loads it, leaving the file as it was otherwise", async () => {
    resetEngine();
    files.set("models.yml", LAB);
    await using screen = await renderK04d("providers");
    await expect.element(screen.getByRole("textbox", { name: "lab baseUrl" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "YAML" }));
    const yaml = screen.getByRole("textbox", { name: "Contents of models.yml" });
    await expect.element(yaml).toHaveValue(LAB);

    // OMP refuses the text: the file keeps its old text and the editor keeps the new one.
    const refused = LAB.replace("api: openai-completions", "api: carrier-pigeon");
    await userEvent.fill(yaml, refused);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await expect
      .poll(() => toastSpy.mock.calls.at(-1)?.[0])
      .toMatchObject({ type: "error", title: "Could not save models.yml" });
    expect(files.get("models.yml")).toBe(LAB);
    await expect.element(yaml).toHaveValue(refused);

    // Broken YAML: the form says where, and points at the YAML view.
    await userEvent.fill(yaml, "providers: [\n");
    await userEvent.click(screen.getByRole("button", { name: "Form" }));
    await expect.element(screen.getByText(/not valid YAML at line \d+, column \d+/)).toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "YAML" }));
    const accepted = LAB.replace("- id: a", "- id: a\n      - id: c");
    await userEvent.fill(screen.getByRole("textbox", { name: "Contents of models.yml" }), accepted);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await expect.poll(() => files.get("models.yml")).toBe(accepted);
    expect(commands.writeFile).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        file: { kind: "models" },
        content: accepted,
        baseVersion: fileVersion(LAB),
      },
    });
  });

  it("MCP lists OMP's on-disk servers and opens mcp.json beside Ompanel's own MCP server", async () => {
    resetEngine();
    files.set("mcp.json", JSON.stringify({ mcpServers: { github: { command: "npx" } } }, null, 2));
    await using screen = await renderK04d("mcp");
    await expect
      .poll(() => document.querySelector('[data-mcp-server="github"]')?.textContent)
      .toContain("npx");
    await expect.element(screen.getByText("Ompanel's MCP server")).toBeVisible();
    await expect.poll(() => row("mcp.startupTimeoutMs")).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "mcp.json", exact: true }));
    const text = screen.getByRole("textbox", { name: "Contents of mcp.json" });
    const next = JSON.stringify(
      { mcpServers: { github: { command: "npx" }, docs: { command: "uvx" } } },
      null,
      2,
    );
    await userEvent.fill(text, next);
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await expect
      .poll(() => document.querySelector('[data-mcp-server="docs"]')?.textContent)
      .toContain("uvx");

    // .mcp.json does not exist yet: it opens with an empty server list, created on save.
    await userEvent.click(screen.getByRole("button", { name: ".mcp.json" }));
    await expect
      .element(screen.getByRole("textbox", { name: "Contents of .mcp.json" }))
      .toHaveValue('{\n  "mcpServers": {}\n}\n');
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(commands.writeFile).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        file: { kind: "mcp", name: ".mcp.json" },
        content: '{\n  "mcpServers": {}\n}\n',
      },
    });
  });

  it("Customization lists skills, rules, prompts, hooks and tools and opens them in the editor", async () => {
    resetEngine();
    files.set("skills/tdd/SKILL.md", "---\nname: tdd\n---\n");
    files.set("RULES.md", "Be brief.\n");
    files.set("rules/no-any.md", "---\ndescription: no any\n---\n");
    files.set("prompts/review.md", "Review $1\n");
    files.set("hooks/pre/bash.ts", "export default {}\n");
    files.set("tools/fetch.py", "print(1)\n");
    await using screen = await renderK04d("customization");
    for (const [category, path] of [
      ["skill", "skills/tdd/SKILL.md"],
      ["rule", "RULES.md"],
      ["rule", "rules/no-any.md"],
      ["prompt", "prompts/review.md"],
      ["hook", "hooks/pre/bash.ts"],
      ["tool", "tools/fetch.py"],
    ] as const) {
      await expect
        .poll(() => document.querySelector(`[data-customization="${category}"]`)?.textContent)
        .toContain(path);
    }
    await expect.poll(() => row("ttsr.enabled")).not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "rules/no-any.md" }));
    const rule = screen.getByRole("textbox", { name: "Contents of rules/no-any.md" });
    await expect.element(rule).toHaveValue("---\ndescription: no any\n---\n");
    await userEvent.fill(rule, "---\ndescription: no any\n---\nNever use any.\n");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(commands.writeFile).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        file: { kind: "custom", category: "rule", path: "rules/no-any.md" },
        content: "---\ndescription: no any\n---\nNever use any.\n",
        baseVersion: fileVersion("---\ndescription: no any\n---\n"),
      },
    });

    // New files stay in their kind's folder: a name with a path is refused.
    const newSkill = screen.getByRole("textbox", { name: "New skills name" });
    await userEvent.fill(newSkill, "../escape");
    const skillGroup = screen.getByRole("list", { name: "Skills" }).element().parentElement!;
    const newButton = () =>
      [...skillGroup.querySelectorAll("button")].find((button) => button.textContent === "New")!;
    expect(newButton().disabled).toBe(true);
    await userEvent.fill(newSkill, "tdd");
    expect(newButton().disabled).toBe(true);
    await userEvent.fill(newSkill, "debug");
    await userEvent.click(newButton());
    const skill = screen.getByRole("textbox", { name: "Contents of skills/debug/SKILL.md" });
    await expect.element(skill).toHaveValue("---\nname: debug\ndescription: \n---\n\n");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(commands.writeFile).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        file: { kind: "custom", category: "skill", path: "skills/debug/SKILL.md" },
        content: "---\nname: debug\ndescription: \n---\n\n",
      },
    });
    await expect
      .element(screen.getByRole("button", { name: "skills/debug/SKILL.md" }))
      .toBeVisible();
  });

  it("Customization unpacks OMP's bundled agents and keeps the user's own", async () => {
    resetEngine();
    files.set("agents/plan.md", "mine\n");
    await using screen = await renderK04d("customization");
    await userEvent.click(screen.getByRole("button", { name: "Unpack bundled agents" }));
    expect(commands.unpackAgents).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId },
    });
    await expect.element(screen.getByRole("button", { name: "explore.md" })).toBeVisible();
    expect(files.get("agents/plan.md")).toBe("mine\n");
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Unpacked 1 bundled agent(s) into agents/",
        description: "Kept 1 existing file(s): plan.md",
      }),
    );
  });

  const renderK04c = (
    pageId: "memory" | "context" | "modes" | "runtime" | "search" | "discovery" | "terminal",
  ) =>
    render(
      <OmpSettingsPageBody environmentId={environmentId} instanceId={instanceId} pageId={pageId} />,
    );

  it("Plugins confirms an install with the exact command and warns it is third-party code", async () => {
    resetEngine();
    await using screen = await render(
      <OmpSettingsPageBody
        environmentId={environmentId}
        instanceId={instanceId}
        pageId="plugins"
      />,
    );
    await expect
      .poll(() => document.querySelector('[data-omp-plugin="differential-review@trailofbits"]'))
      .not.toBeNull();
    expect(document.querySelector("[data-omp-third-party]")?.textContent).toContain("xd://");
    await expect.poll(() => row("marketplace.autoUpdate")).not.toBeNull();

    await userEvent.fill(
      screen.getByRole("textbox", { name: "Plugin to install" }),
      "github:someone/plugin#v1",
    );
    await userEvent.click(screen.getByRole("button", { name: "Install…" }).first());
    await expect
      .poll(() => document.querySelector("[data-omp-plugin-command]")?.textContent)
      .toBe("omp --profile work plugin install 'github:someone/plugin#v1'");
    expect(document.querySelector('[data-omp-plugin-confirm="install"]')?.textContent).toContain(
      "Third-party code",
    );
    // Nothing runs until the command is confirmed.
    expect(commands.runPluginCommand).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Install", exact: true }));
    await expect
      .poll(() => document.querySelector('[data-omp-plugin="github:someone/plugin#v1"]'))
      .not.toBeNull();
    expect(commands.runPluginCommand).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, command: { action: "install", spec: "github:someone/plugin#v1" } },
    });
  });

  it("Plugins cancels, disables and uninstalls only after confirmation", async () => {
    resetEngine();
    await using screen = await render(
      <OmpSettingsPageBody
        environmentId={environmentId}
        instanceId={instanceId}
        pageId="plugins"
      />,
    );
    await expect
      .poll(() => document.querySelector('[data-omp-plugin="differential-review@trailofbits"]'))
      .not.toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    await expect
      .poll(() => document.querySelector("[data-omp-plugin-command]")?.textContent)
      .toBe("omp --profile work plugin uninstall differential-review@trailofbits");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await expect.poll(() => document.querySelector("[data-omp-plugin-confirm]")).toBeNull();
    expect(commands.runPluginCommand).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Disable" }));
    await expect
      .poll(() => document.querySelector("[data-omp-plugin-command]")?.textContent)
      .toBe("omp --profile work plugin disable differential-review@trailofbits");
    // Turning code off is not a third-party warning; turning it on is.
    expect(document.querySelector("[data-omp-plugin-confirm]")?.textContent).not.toContain(
      "Third-party code",
    );
    await userEvent.click(screen.getByRole("button", { name: "Disable", exact: true }).last());
    await expect
      .poll(
        () =>
          document.querySelector('[data-omp-plugin="differential-review@trailofbits"]')
            ?.textContent,
      )
      .toContain("disabled");
    await userEvent.click(screen.getByRole("button", { name: "Enable" }));
    await expect
      .poll(() => document.querySelector("[data-omp-plugin-confirm]")?.textContent)
      .toContain("Third-party code");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await userEvent.click(screen.getByRole("button", { name: "Uninstall" }));
    await userEvent.click(screen.getByRole("button", { name: "Uninstall", exact: true }).last());
    await expect
      .poll(() => document.querySelector('[data-omp-plugin="differential-review@trailofbits"]'))
      .toBeNull();
    expect(commands.runPluginCommand).toHaveBeenCalledTimes(2);
  });

  it("Plugins browses a marketplace, installs name@marketplace, reloads threads and checks for updates", async () => {
    resetEngine();
    await using screen = await render(
      <OmpSettingsPageBody
        environmentId={environmentId}
        instanceId={instanceId}
        pageId="plugins"
      />,
    );
    await expect
      .poll(() => document.querySelector('[data-omp-marketplace="trailofbits"]'))
      .not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Browse" }));
    await expect
      .poll(
        () =>
          document.querySelector('[data-omp-marketplace-plugin="differential-review@trailofbits"]')
            ?.textContent,
      )
      .toContain("installed");
    const entry = document.querySelector<HTMLElement>(
      '[data-omp-marketplace-plugin="audit-context-building@trailofbits"]',
    );
    expect(entry?.textContent).toContain("Understand a codebase");
    await userEvent.click(entry!.querySelector("button")!);
    await expect
      .poll(() => document.querySelector("[data-omp-plugin-command]")?.textContent)
      .toBe("omp --profile work plugin install audit-context-building@trailofbits");
    await userEvent.click(screen.getByRole("button", { name: "Install", exact: true }));
    await expect
      .poll(
        () =>
          document.querySelector(
            '[data-omp-marketplace-plugin="audit-context-building@trailofbits"]',
          )?.textContent,
      )
      .toContain("installed");

    await userEvent.click(screen.getByRole("button", { name: "Reload plugins" }));
    await expect
      .poll(() => toastSpy.mock.calls.at(-1)?.[0])
      .toMatchObject({
        title: "Reloaded plugins in 2 of 3 running thread(s)",
        description: "1 busy with a turn, left alone",
      });
    expect(commands.reloadPlugins).toHaveBeenCalledWith({ environmentId, input: { instanceId } });

    expect(document.querySelector("[data-omp-update]")?.textContent).toContain(
      "Sidecar updates only arrive with app updates",
    );
    await userEvent.click(screen.getByRole("button", { name: "Check for updates" }));
    await expect
      .poll(() => document.querySelector('[data-omp-update-status="available"]')?.textContent)
      .toContain("OMP 18.13.0 is out; this app ships 18.12.6");
  });

  it("Plugins adds a marketplace only after a third-party confirmation", async () => {
    resetEngine();
    await using screen = await render(
      <OmpSettingsPageBody
        environmentId={environmentId}
        instanceId={instanceId}
        pageId="plugins"
      />,
    );
    await expect.poll(() => document.querySelector("[data-omp-marketplaces]")).not.toBeNull();
    await userEvent.fill(screen.getByRole("textbox", { name: "Marketplace to add" }), "--force");
    expect(screen.getByRole("button", { name: "Add marketplace…" }).element()).toBeDisabled();
    await userEvent.fill(
      screen.getByRole("textbox", { name: "Marketplace to add" }),
      "docker/skills",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add marketplace…" }));
    await expect
      .poll(() => document.querySelector("[data-omp-plugin-command]")?.textContent)
      .toBe("omp --profile work plugin marketplace add docker/skills");
    expect(document.querySelector("[data-omp-plugin-confirm]")?.textContent).toContain(
      "third-party catalog",
    );
    await userEvent.click(screen.getByRole("button", { name: "Add marketplace", exact: true }));
    expect(commands.runPluginCommand).toHaveBeenCalledWith({
      environmentId,
      input: { instanceId, command: { action: "marketplace_add", source: "docker/skills" } },
    });
  });

  it("Skills lists what omp skill list resolves and opens a skill in the editor", async () => {
    resetEngine();
    await using screen = await render(
      <OmpSettingsPageBody environmentId={environmentId} instanceId={instanceId} pageId="skills" />,
    );
    await expect
      .poll(() => document.querySelector('[data-omp-skill="grilling"]')?.textContent)
      .toContain("claude-plugins:user");
    expect(document.querySelector('[data-omp-skill="tdd"]')?.textContent).toContain(
      "hidden from the model",
    );
    expect(document.querySelector("[data-omp-skill-warnings]")?.textContent).toContain(
      "missing description",
    );
    await expect.poll(() => row("skills.registryUrl")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Open in editor" }).first());
    expect(commands.openInEditor).toHaveBeenCalledWith(
      "/home/tester/.omp/plugins/cache/mattpocock/skills/grilling/SKILL.md",
    );
  });

  it("MCP says its servers' xd:// tools are third-party code", async () => {
    resetEngine();
    await using _screen = await render(
      <OmpSettingsPageBody environmentId={environmentId} instanceId={instanceId} pageId="mcp" />,
    );
    await expect
      .poll(() => document.querySelector('[data-omp-third-party="mcp"]')?.textContent)
      .toContain("xd://");
  });

  it("Memory switches the backend and keeps backend credentials reset-only", async () => {
    resetEngine();
    await using screen = await renderK04c("memory");
    const backend = screen.getByRole("textbox", { name: "memory.backend" });
    await expect.element(backend).toHaveValue("off");
    await expect.element(screen.getByLabelText("hindsight.apiToken")).toBeDisabled();
    await userEvent.clear(backend);
    await userEvent.type(backend, "mnemopi{Enter}");

    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, scope: "global", key: "memory.backend", value: "mnemopi" },
    });
    await expect.poll(() => row("memory.backend")?.textContent).toContain("Global");
    await expect.element(backend).toHaveValue("mnemopi");
    expect(row("mnemopi.recallLimit")?.textContent).toContain("Default");
  });

  it("Context sets the compaction threshold and shows methodOrder", async () => {
    resetEngine();
    await using screen = await renderK04c("context");
    expect(row("compaction.methodOrder")).not.toBeNull();
    const threshold = screen.getByRole("textbox", { name: "compaction.thresholdPercent" });
    await userEvent.clear(threshold);
    await userEvent.type(threshold, "65{Enter}");

    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, scope: "global", key: "compaction.thresholdPercent", value: 65 },
    });
    await expect.poll(() => row("compaction.thresholdPercent")?.textContent).toContain("Global");
    await expect.element(threshold).toHaveValue("65");
  });

  it("Modes turns plan mode off and shows the re-read value", async () => {
    resetEngine();
    await using screen = await renderK04c("modes");
    const plan = screen.getByRole("switch", { name: "plan.enabled" });
    await expect.element(plan).toBeChecked();
    await userEvent.click(plan);

    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, scope: "global", key: "plan.enabled", value: false },
    });
    await expect.poll(() => row("plan.enabled")?.textContent).toContain("Global");
    await expect.element(plan).not.toBeChecked();
  });

  it("Runtime turns Python eval off and shows PTY read-only", async () => {
    resetEngine();
    await using screen = await renderK04c("runtime");
    await expect
      .element(screen.getByRole("textbox", { name: "providers.tinyModelDevice" }))
      .toBeDisabled();
    const pty = document.querySelector('[data-setting-static="pty"]');
    expect(pty?.textContent).toContain("read-only");
    expect(pty?.textContent).toContain("PI_NO_PTY");
    expect(pty?.querySelector("input, button")).toBeNull();

    const python = screen.getByRole("switch", { name: "eval.py" });
    await userEvent.click(python);
    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, scope: "global", key: "eval.py", value: false },
    });
    await expect.poll(() => row("eval.py")?.textContent).toContain("Global");
    await expect.element(python).not.toBeChecked();
  });

  it("Search edits the web role and its fallback chain, keeping other roles and chains", async () => {
    resetEngine();
    engine.global.set("retry.fallbackChains", { default: ["openai/gpt-5"] });
    await using screen = await renderK04c("search");
    // Only the web entries of the shared records are offered here.
    expect(document.querySelectorAll("[data-model-role]")).toHaveLength(0);
    await expect.element(screen.getByLabelText("searxng.token")).toBeDisabled();

    await userEvent.type(screen.getByRole("textbox", { name: "modelRoles.web" }), "web/exa{Enter}");
    expect(commands.write).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        scope: "global",
        key: "modelRoles",
        value: { default: "anthropic/claude-sonnet-4-5", web: "web/exa" },
      },
    });
    await expect.poll(() => row("modelRoles")?.textContent).toContain("Global");

    const chain = screen.getByRole("textbox", { name: "retry.fallbackChains.web" });
    await userEvent.type(chain, "web/searxng, web/duckduckgo{Enter}");
    expect(commands.write).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        scope: "global",
        key: "retry.fallbackChains",
        value: { default: ["openai/gpt-5"], web: ["web/searxng", "web/duckduckgo"] },
      },
    });
    await expect.element(chain).toHaveValue("web/searxng, web/duckduckgo");
  });

  it("Search offers no Reset that would clear every role or chain; clearing removes only web", async () => {
    resetEngine();
    engine.global.set("modelRoles", { default: "anthropic/claude-sonnet-4-5", web: "web/exa" });
    engine.global.set("retry.fallbackChains", { default: ["openai/gpt-5"], web: ["web/brave"] });
    engine.global.set("exa.enabled", false);
    await using screen = await renderK04c("search");
    await expect.poll(() => row("modelRoles")?.textContent).toContain("Global");
    // A Reset here would reset the whole key in the global layer: all roles, all chains.
    expect(row("modelRoles")?.querySelector("button")).toBeNull();
    expect(row("retry.fallbackChains")?.querySelector("button")).toBeNull();
    // Keys the page edits whole keep their Reset.
    expect(row("exa.enabled")?.textContent).toContain("Reset");

    await userEvent.clear(screen.getByRole("textbox", { name: "modelRoles.web" }));
    await userEvent.keyboard("{Enter}");
    expect(commands.write).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        scope: "global",
        key: "modelRoles",
        value: { default: "anthropic/claude-sonnet-4-5" },
      },
    });
    await userEvent.clear(screen.getByRole("textbox", { name: "retry.fallbackChains.web" }));
    await userEvent.keyboard("{Enter}");
    expect(commands.write).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        instanceId,
        scope: "global",
        key: "retry.fallbackChains",
        value: { default: ["openai/gpt-5"] },
      },
    });
    expect(commands.reset).not.toHaveBeenCalled();
    expect(engine.global.get("modelRoles")).toEqual({ default: "anthropic/claude-sonnet-4-5" });
  });

  it("Discovery toggles Claude skills and keeps provider lists read-only", async () => {
    resetEngine();
    await using screen = await renderK04c("discovery");
    for (const key of ["enabledProviders", "disabledProviders"]) {
      await expect.element(screen.getByRole("textbox", { name: key })).toBeDisabled();
    }
    const skills = screen.getByRole("switch", { name: "skills.enableClaudeUser" });
    await userEvent.click(skills);
    expect(commands.write).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { instanceId, scope: "global", key: "skills.enableClaudeUser", value: false },
    });
    await expect.poll(() => row("skills.enableClaudeUser")?.textContent).toContain("Global");
    await expect.element(skills).not.toBeChecked();
  });

  it("Terminal prefs shows every key read-only and marked terminal-only", async () => {
    resetEngine();
    engine.global.set("startup.quiet", true);
    await using screen = await renderK04c("terminal");
    await expect.element(screen.getByRole("switch", { name: "startup.quiet" })).toBeDisabled();
    await expect.element(screen.getByRole("textbox", { name: "theme.dark" })).toBeDisabled();
    for (const key of ["startup.quiet", "theme.dark", "statusLine.preset"]) {
      expect(row(key)?.textContent).toContain("Terminal-only");
      expect(row(key)?.querySelector("button")).toBeNull();
    }
    expect(row("startup.quiet")?.textContent).toContain("Global");
    expect(
      document.querySelector('[data-setting-static="keybindings.yml"]')?.textContent,
    ).toContain("Terminal-only");
    expect(commands.write).not.toHaveBeenCalled();
  });
});

describe("OMP settings pages at phone width", () => {
  it.each(Object.values(OMP_SETTINGS_PAGES))(
    "$title fits the settings column of a 390px viewport without sideways scrolling",
    async (page) => {
      resetEngine();
      // Long values and agent files exercise wrapping, not just the default form.
      engine.global.set("contextFiles.extra", [
        "/a/very/long/path/to/some/context/file.md".repeat(3),
      ]);
      files.set("WATCHDOG.yml", "rules: []\n");
      files.set("agents/reviewer-with-a-rather-long-name.md", "# Reviewer\n");
      files.set(
        "models.yml",
        "providers:\n  a-provider-with-a-long-name:\n    baseUrl: https://a-very-long-host-name.example.com/some/long/path/v1\n    api: openai-completions\n    apiKey: A_PROVIDER_WITH_A_LONG_NAME_API_KEY\n    models:\n      - id: a-model-id-that-is-quite-long-indeed\n",
      );
      files.set(
        "mcp.json",
        JSON.stringify({
          mcpServers: { "a-server-with-a-long-name": { command: "/opt/tools/bin/a-long-command" } },
        }),
      );
      files.set("skills/a-skill-with-a-rather-long-name/SKILL.md", "---\nname: x\n---\n");
      await using _viewport = await usePhoneViewport();
      expect(document.documentElement.clientWidth).toBe(390);
      await using screen = await render(
        <OmpSettingsPageBody
          environmentId={environmentId}
          instanceId={instanceId}
          pageId={page.id}
        />,
        { container: settingsContentColumn() },
      );
      await expect
        .poll(() =>
          page.keys.length > 0
            ? document.querySelector("[data-setting]")
            : document.querySelector("[data-omp-files]"),
        )
        .not.toBeNull();
      await expect
        .poll(() =>
          ["mcp", "customization"].includes(page.id)
            ? document.querySelector("[data-omp-files]")
            : page.id === "plugins"
              ? document.querySelector("[data-omp-plugins]")
              : page.id === "skills"
                ? document.querySelector("[data-omp-skills]")
                : true,
        )
        .not.toBeNull();
      expect(elementsPastViewport(screen.container)).toEqual([]);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
    },
  );
});
