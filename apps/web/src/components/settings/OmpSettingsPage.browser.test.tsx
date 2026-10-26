import { EnvironmentId, ProviderInstanceId, type OmpConfigType } from "@t3tools/contracts";
import { buildOmpSettingsForm } from "@t3tools/provider-omp/configForm";
import { OMP_MODEL_ROLES, OMP_SETTINGS_PAGES } from "@t3tools/provider-omp/settingsPages";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";

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
  ]);
  return {
    ...(await original()),
    useAtomCommand: ((atom: unknown) => byAtom.get(atom)) as never,
  };
});

import { OmpSettingsPageBody } from "./OmpSettingsPage";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("omp");
const row = (key: string) => document.querySelector(`[data-setting="${key}"]`);

/** The agent directory: `WATCHDOG.yml` and `agents/<name>` by relative path. */
const files = vi.hoisted(() => new Map<string, string>());
const AGENT_DIR = "/home/tester/.omp/profiles/work/agent";
const fileVersion = (content: string) => `v:${content}`;
const relativePathOf = (file: { kind: string; name?: string }) =>
  file.kind === "watchdog" ? "WATCHDOG.yml" : `agents/${file.name}`;
const fileList = () => ({
  agentDir: AGENT_DIR,
  watchdogFileName: "WATCHDOG.yml",
  watchdogExists: files.has("WATCHDOG.yml"),
  agents: [...files.keys()]
    .filter((path) => path.startsWith("agents/"))
    .map((path) => ({ name: path.slice("agents/".length), editable: true }))
    .toSorted((left, right) => left.name.localeCompare(right.name)),
});

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
    .mockImplementation(async ({ input }: { input: { file: { kind: string; name?: string } } }) => {
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
      async ({
        input,
      }: {
        input: { file: { kind: string; name?: string }; content: string; baseVersion?: string };
      }) => {
        const relativePath = relativePathOf(input.file);
        const current = files.get(relativePath);
        // The page must send the version it read; a stale one fails the test outright.
        if ((current === undefined ? undefined : fileVersion(current)) !== input.baseVersion) {
          throw new Error(`${relativePath}: stale baseVersion ${input.baseVersion}`);
        }
        files.set(relativePath, input.content);
        return {
          _tag: "Success",
          value: {
            file: input.file,
            relativePath,
            content: input.content,
            version: fileVersion(input.content),
          },
        };
      },
    );
  commands.deleteFile
    .mockReset()
    .mockImplementation(async ({ input }: { input: { file: { kind: string; name?: string } } }) => {
      files.delete(relativePathOf(input.file));
      return { _tag: "Success", value: fileList() };
    });
}

describe("OMP settings pages", () => {
  it.each(Object.values(OMP_SETTINGS_PAGES))(
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
});
