import type { OmpAgentFilesList } from "@t3tools/contracts";
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

import {
  OmpAgentFilesSummaryView,
  OmpCustomizationSummaryView,
  OmpMcpSummaryView,
} from "./OmpAgentDirectorySummary";

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

const rows = (section: string) =>
  Array.from(
    container.querySelectorAll(`section[aria-label="${section}"] div[aria-label]`),
    (row) => row.getAttribute("aria-label"),
  );

const list: OmpAgentFilesList = {
  agentDir: "/home/u/.omp/agent",
  watchdogFileName: "WATCHDOG.yml",
  watchdogExists: false,
  agents: [
    { name: "reviewer.md", editable: true },
    { name: ".hidden.md", editable: false },
  ],
  modelsFileName: "models.yml",
  modelsExists: true,
  modelsLegacyJson: false,
  mcpFiles: [
    { name: "mcp.json", exists: true },
    { name: ".mcp.json", exists: true, problem: "invalid_json" },
  ],
  mcpServers: [
    { name: "github", file: "mcp.json", transport: "stdio", target: "npx gh-mcp", disabled: false },
    { name: "docs", file: "mcp.json", transport: "http", disabled: true },
  ],
  customization: [
    { category: "skill", path: "skills/tdd/SKILL.md", editable: true },
    { category: "rule", path: "RULES.md", editable: true },
    { category: "hook", path: "hooks/pre/bash", editable: false },
  ],
};

const emptyList: OmpAgentFilesList = {
  ...list,
  watchdogExists: true,
  agents: [],
  mcpFiles: [
    { name: "mcp.json", exists: false },
    { name: ".mcp.json", exists: false },
  ],
  mcpServers: [],
  customization: [],
};

describe("OmpAgentFilesSummaryView", () => {
  it("lists the advisor roster and custom agents read-only", () => {
    act(() => root.render(<OmpAgentFilesSummaryView read={{ status: "ok", value: list }} />));
    expect(rows("Advisor & Agents files")).toEqual([
      "WATCHDOG.yml. Advisor roster · not created yet",
      "reviewer.md. Custom agent",
      ".hidden.md. Custom agent · Not editable in Ompanel",
    ]);
    expect(container.textContent).toContain("In /home/u/.omp/agent, the agent directory");
    expect(container.querySelector("button, input, textarea")).toBeNull();
  });

  it("shows empty, loading and failed states", () => {
    act(() => root.render(<OmpAgentFilesSummaryView read={{ status: "ok", value: emptyList }} />));
    expect(container.textContent).toContain("No agents in agents/.");
    expect(rows("Advisor & Agents files")).toEqual(["WATCHDOG.yml. Advisor roster"]);
    act(() => root.render(<OmpAgentFilesSummaryView read={{ status: "loading" }} />));
    expect(container.textContent).toContain("Reading OMP's agent directory…");
    act(() => root.render(<OmpAgentFilesSummaryView read={{ status: "error", message: "x" }} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "OMP's agent directory is unavailable.",
    );
  });
});

describe("OmpMcpSummaryView", () => {
  it("lists servers and files with their state, never arguments, read-only", () => {
    act(() => root.render(<OmpMcpSummaryView read={{ status: "ok", value: list }} />));
    expect(rows("MCP servers")).toEqual([
      "github. stdio · mcp.json. npx gh-mcp",
      "docs. http · Disabled · mcp.json",
      "mcp.json. MCP config file",
      ".mcp.json. Not valid JSON: OMP loads no servers from it",
    ]);
    expect(container.textContent).toContain("third-party code");
    expect(container.querySelector("footer")?.textContent).toContain("Ompanel's own MCP server");
    expect(container.querySelector("button, input, textarea")).toBeNull();
  });

  it("shows empty, loading and failed states", () => {
    act(() => root.render(<OmpMcpSummaryView read={{ status: "ok", value: emptyList }} />));
    expect(container.textContent).toContain("No servers.");
    expect(rows("MCP servers")).toEqual([
      "mcp.json. not created yet",
      ".mcp.json. not created yet",
    ]);
    act(() => root.render(<OmpMcpSummaryView read={{ status: "loading" }} />));
    expect(container.textContent).toContain("Reading OMP's agent directory…");
    act(() => root.render(<OmpMcpSummaryView read={{ status: "error", message: "x" }} />));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "OMP's agent directory is unavailable.",
    );
  });
});

describe("OmpCustomizationSummaryView", () => {
  it("groups files by kind in web's order, read-only", () => {
    act(() => root.render(<OmpCustomizationSummaryView read={{ status: "ok", value: list }} />));
    expect(
      Array.from(container.querySelectorAll("section"), (section) =>
        section.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Customization · Skills",
      "Customization · Rules",
      "Customization · Prompt templates",
      "Customization · Hooks",
      "Customization · Custom tools",
    ]);
    expect(rows("Customization · Skills")).toEqual(["skills/tdd/SKILL.md"]);
    expect(rows("Customization · Rules")).toEqual(["RULES.md"]);
    expect(rows("Customization · Hooks")).toEqual(["hooks/pre/bash. Not editable in Ompanel"]);
    expect(
      container.querySelector('section[aria-label="Customization · Prompt templates"]')
        ?.textContent,
    ).toContain("None yet.");
    expect(container.querySelector("button, input, textarea")).toBeNull();
  });

  it("shows loading and failed states once", () => {
    act(() => root.render(<OmpCustomizationSummaryView read={{ status: "loading" }} />));
    expect(container.querySelectorAll("section")).toHaveLength(1);
    expect(container.textContent).toContain("Reading OMP's agent directory…");
    act(() =>
      root.render(<OmpCustomizationSummaryView read={{ status: "error", message: "x" }} />),
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "OMP's agent directory is unavailable.",
    );
  });
});
