import { EnvironmentId, ProviderInstanceId, type OmpConfigType } from "@t3tools/contracts";
import { buildOmpSettingsForm } from "@t3tools/provider-omp/configForm";
import { OMP_MODEL_ROLES, OMP_SETTINGS_PAGES } from "@t3tools/provider-omp/settingsPages";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";

// What the pinned OMP registers for the three pages, plus one key no page shows.
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
const commands = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), reset: vi.fn() }));

vi.mock(import("../../state/use-atom-command"), async (original) => {
  const { serverEnvironment } = await import("../../state/server");
  const byAtom = new Map<unknown, unknown>([
    [serverEnvironment.readOmpSettings, commands.read],
    [serverEnvironment.writeOmpSetting, commands.write],
    [serverEnvironment.resetOmpSetting, commands.reset],
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

/** Empties the global layer and wires the commands to the in-memory engine. */
function resetEngine() {
  engine.global.clear();
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
});
