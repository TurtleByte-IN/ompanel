import type { OmpPluginList, OmpSkillsList } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
  }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: (props: { title: string; footer?: string; children?: ReactNode }) => (
    <section aria-label={props.title}>
      {props.children}
      <footer>{props.footer}</footer>
    </section>
  ),
}));

import { OmpPluginsSummaryView, OmpSkillsSummaryView } from "./OmpPluginsSummary";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

const rowLabels = () =>
  Array.from(container.querySelectorAll("div[aria-label]"), (row) =>
    row.getAttribute("aria-label"),
  );

const pluginList: OmpPluginList = {
  command: ["omp"],
  plugins: [
    {
      id: "lint@acme",
      source: "marketplace",
      version: "1.2.0",
      enabled: false,
      description: "Lints things",
      shadowed: true,
    },
    { id: "omp-git", source: "npm", version: "0.3.1", enabled: true, shadowed: false },
  ],
  marketplaces: [{ name: "acme", source: "github:acme/plugins" }],
};

describe("OmpPluginsSummaryView", () => {
  it("lists installed plugins and marketplaces read-only, with the third-party note", () => {
    act(() => root.render(<OmpPluginsSummaryView read={{ status: "ok", value: pluginList }} />));
    expect(rowLabels()).toEqual([
      "lint@acme. 1.2.0 · marketplace · disabled · overridden by a project install. Lints things",
      "omp-git. 0.3.1 · npm · enabled",
      "acme. Marketplace. github:acme/plugins",
    ]);
    expect(container.textContent).toContain("Plugins are third-party code.");
    expect(container.querySelector("footer")?.textContent).toContain("on web or desktop");
    expect(container.querySelector("button, input")).toBeNull();
  });

  it("says when nothing is installed", () => {
    act(() =>
      root.render(
        <OmpPluginsSummaryView
          read={{ status: "ok", value: { command: ["omp"], plugins: [], marketplaces: [] } }}
        />,
      ),
    );
    expect(container.textContent).toContain("No plugins installed.");
    expect(container.textContent).toContain("No marketplaces configured.");
    expect(rowLabels()).toEqual([]);
  });

  it("shows loading, then web's failure copy", () => {
    act(() => root.render(<OmpPluginsSummaryView read={{ status: "loading" }} />));
    expect(container.textContent).toContain("Reading OMP's plugins…");
    act(() =>
      root.render(<OmpPluginsSummaryView read={{ status: "error", message: "timed out" }} />),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "OMP's plugins are unavailable.",
    );
  });
});

const skillsList: OmpSkillsList = {
  skills: [
    {
      name: "tdd",
      description: "Test first",
      filePath: "/home/u/.omp/agent/skills/tdd/SKILL.md",
      source: "native:user",
      hidden: false,
    },
    {
      name: "secret",
      description: "Hidden one",
      filePath: "/home/u/.claude/skills/secret/SKILL.md",
      source: "claude:user",
      hidden: true,
    },
  ],
  warnings: [{ skillPath: "/x/SKILL.md", message: "missing description" }],
};

describe("OmpSkillsSummaryView", () => {
  it("lists skills with source, hidden flag, path and OMP's warnings, read-only", () => {
    act(() => root.render(<OmpSkillsSummaryView read={{ status: "ok", value: skillsList }} />));
    expect(rowLabels()).toEqual([
      "tdd. native:user. Test first. /home/u/.omp/agent/skills/tdd/SKILL.md",
      "secret. claude:user · hidden from the model. Hidden one. /home/u/.claude/skills/secret/SKILL.md",
    ]);
    expect(container.textContent).toContain("/x/SKILL.md: missing description");
    expect(container.querySelector("button, input")).toBeNull();
  });

  it("shows empty, loading and failed states", () => {
    act(() =>
      root.render(
        <OmpSkillsSummaryView read={{ status: "ok", value: { skills: [], warnings: [] } }} />,
      ),
    );
    expect(container.textContent).toContain("OMP found no skills.");
    act(() => root.render(<OmpSkillsSummaryView read={{ status: "loading" }} />));
    expect(container.textContent).toContain("Reading OMP's skills…");
    act(() => root.render(<OmpSkillsSummaryView read={{ status: "error", message: "x" }} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "OMP's skills are unavailable.",
    );
  });
});
