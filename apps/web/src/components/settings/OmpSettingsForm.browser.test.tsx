import { buildOmpSettingsForm } from "@t3tools/provider-omp/configForm";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { OmpSettingsForm } from "./OmpSettingsForm";

// What the settings engine builds from `omp config list --json`.
const FORM = buildOmpSettingsForm({
  "compaction.enabled": {
    type: "boolean",
    description: "Compact long sessions automatically.",
    source: "default",
    value: false,
  },
  "compaction.thresholdPercent": {
    type: "number",
    description: "Context use that triggers compaction.",
    source: "project",
    value: 80,
  },
  modelRoles: { type: "record", description: "Model per role.", source: "global", value: {} },
  "memory.backend": {
    type: "enum",
    description: "Memory backend.",
    source: "default",
    value: "off",
  },
  "hindsight.apiToken": {
    type: "string",
    description: "Hindsight API token.",
    source: "global",
    redacted: true,
  },
  // Unredacted by OMP, still a credential in the pinned registry.
  "searxng.basicPassword": {
    type: "string",
    description: "SearXNG password.",
    source: "default",
    value: "hunter2",
  },
  "web_search.enabled": {
    type: "boolean",
    description: "Enable web search.",
    source: "env",
    value: true,
  },
});

const row = (key: string) => document.querySelector(`[data-setting="${key}"]`)!;

describe("OmpSettingsForm", () => {
  it("shows each setting's source layer, restart scope and env lock", async () => {
    await using screen = await render(
      <OmpSettingsForm form={FORM} scope="project" onWrite={vi.fn()} onReset={vi.fn()} />,
    );

    await expect.element(screen.getByRole("region", { name: "compaction" })).toBeVisible();
    expect(row("compaction.thresholdPercent").textContent).toContain("Project");
    expect(row("modelRoles").textContent).toContain("Global");
    expect(row("memory.backend").textContent).toContain("Restarts threads");
    expect(row("compaction.enabled").textContent).not.toContain("Restarts threads");
    expect(row("web_search.enabled").textContent).toContain("Environment");
    await expect.element(screen.getByRole("switch", { name: "web_search.enabled" })).toBeDisabled();
    await expect
      .element(screen.getByRole("textbox", { name: "compaction.thresholdPercent" }))
      .toHaveValue("80");
  });

  it("writes typed values and resets fields the edited layer sets", async () => {
    const onWrite = vi.fn();
    const onReset = vi.fn();
    await using screen = await render(
      <OmpSettingsForm form={FORM} scope="project" onWrite={onWrite} onReset={onReset} />,
    );

    await userEvent.click(screen.getByRole("switch", { name: "compaction.enabled" }));
    expect(onWrite).toHaveBeenLastCalledWith("compaction.enabled", true);

    const threshold = screen.getByRole("textbox", { name: "compaction.thresholdPercent" });
    await userEvent.clear(threshold);
    await userEvent.type(threshold, "65{Enter}");
    expect(onWrite).toHaveBeenLastCalledWith("compaction.thresholdPercent", 65);

    const roles = screen.getByRole("textbox", { name: "modelRoles" });
    await userEvent.clear(roles);
    await userEvent.type(roles, '{{"default": "anthropic/claude"}');
    await userEvent.click(document.body);
    expect(onWrite).toHaveBeenLastCalledWith("modelRoles", { default: "anthropic/claude" });

    // Only the project layer's own value can be reset from the project form.
    const resets = screen.getByRole("button", { name: "Reset" });
    await expect.element(resets).toBeVisible();
    expect(resets.elements()).toHaveLength(1);
    await userEvent.click(resets);
    expect(onReset).toHaveBeenCalledExactlyOnceWith("compaction.thresholdPercent");
  });

  it("rejects JSON of the wrong shape without writing it", async () => {
    const onWrite = vi.fn();
    await using screen = await render(
      <OmpSettingsForm form={FORM} scope="global" onWrite={onWrite} onReset={vi.fn()} />,
    );

    const roles = screen.getByRole("textbox", { name: "modelRoles" });
    await userEvent.clear(roles);
    await userEvent.type(roles, "[1]");
    await userEvent.click(document.body);
    await expect.element(screen.getByText("Enter a JSON object.")).toBeVisible();
    expect(onWrite).not.toHaveBeenCalled();
  });

  it("masks credentials, stored or not, and only offers to reset a stored one", async () => {
    const onReset = vi.fn();
    await using screen = await render(
      <OmpSettingsForm form={FORM} scope="global" onWrite={vi.fn()} onReset={onReset} />,
    );

    for (const key of ["hindsight.apiToken", "searxng.basicPassword"]) {
      const secret = screen.getByLabelText(key);
      await expect.element(secret).toBeDisabled();
      expect(secret.element()).toHaveProperty("type", "password");
      expect(secret.element()).toHaveProperty("value", "");
    }
    // OMP reported the unset password as plain text; the form still never shows it.
    expect(row("searxng.basicPassword").textContent).not.toContain("hunter2");
    expect(row("searxng.basicPassword").querySelector("button")).toBeNull();

    await userEvent.click(row("hindsight.apiToken").querySelector("button")!);
    expect(onReset).toHaveBeenCalledExactlyOnceWith("hindsight.apiToken");
  });
});
