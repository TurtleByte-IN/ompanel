import type { OmpAccountUsage, OmpSessionUsageList, OmpStatsSummary } from "@t3tools/contracts";
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
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
  }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../settings/components/SettingsSection", () => ({
  SettingsSection: (props: { title: string; footer?: string; children?: ReactNode }) => (
    <section aria-label={props.title}>
      {props.children}
      <footer>{props.footer}</footer>
    </section>
  ),
}));

import { OmpUsageSection, OmpUsageView } from "./OmpUsageSection";

const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

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

const labels = (section: string) =>
  Array.from(
    container.querySelectorAll(`section[aria-label="${section}"] div[aria-label]`),
    (row) => row.getAttribute("aria-label"),
  );
const sectionText = (section: string) =>
  container.querySelector(`section[aria-label="${section}"]`)?.textContent ?? "";

const account: OmpAccountUsage = {
  generatedAt: NOW,
  providersWithoutLimits: [],
  limits: [
    {
      provider: "anthropic",
      accountId: "me@example.com",
      id: "5h",
      label: "5 hour",
      unit: "percent",
      usedFraction: 0.42,
      resetsAt: NOW + 90 * 60_000,
    },
    { provider: "openai", id: "week", label: "Weekly", unit: "percent" },
  ],
};

const totals = {
  requests: 12,
  failedRequests: 1,
  inputTokens: 1000,
  outputTokens: 500,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.5,
  firstTimestamp: 0,
  lastTimestamp: 0,
};
const stats: OmpStatsSummary = {
  overall: totals,
  byModel: [{ ...totals, provider: "anthropic", model: "opus" }],
};

const sessions: OmpSessionUsageList = {
  sessions: [
    {
      threadId: "t-1",
      sessionId: "s-1",
      cwd: "/work/app",
      status: "ok",
      stats: {
        userMessages: 2,
        assistantMessages: 3,
        toolCalls: 4,
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 150,
        costUsd: 0.01,
        contextUsage: { tokens: 150, contextWindow: 1000, percent: 15 },
      },
    },
    { threadId: "t-2", sessionId: "s-2", cwd: "/work/other", status: "error", message: "Busy." },
  ],
};

describe("OmpUsageView", () => {
  it("shows account limits, the last 24 hours and running threads, read-only", () => {
    act(() =>
      root.render(
        <OmpUsageView
          account={{ status: "ok", value: account }}
          stats={{ status: "ok", value: stats }}
          sessions={{ status: "ok", value: sessions }}
          now={NOW}
        />,
      ),
    );
    expect(labels("Account limits")).toEqual([
      "anthropic · me@example.com · 5 hour: 42% · resets in 2 h",
      "openai · Weekly: unknown",
    ]);
    const statLabels = labels("Last 24 hours");
    expect(statLabels.slice(0, 4).map((label) => label?.split(":")[0])).toEqual([
      "Requests",
      "Failed",
      "Tokens",
      "Cost",
    ]);
    expect(statLabels[0]).toBe("Requests: 12");
    expect(statLabels[4]).toMatch(/^anthropic\/opus: 12 requests · .+ tokens · .+$/);
    expect(sectionText("Running threads")).toContain("/work/app");
    expect(sectionText("Running threads")).toContain("4 tool calls · 5 messages · context 15%");
    expect(
      container.querySelector('section[aria-label="Running threads"] [role="alert"]')?.textContent,
    ).toBe("Busy.");
    expect(container.querySelector("button, input")).toBeNull();
  });

  it("shows each source's loading, empty and failed states on its own", () => {
    act(() =>
      root.render(
        <OmpUsageView
          account={{ status: "loading" }}
          stats={{ status: "error", message: "omp stats timed out" }}
          sessions={{ status: "ok", value: { sessions: [] } }}
          now={NOW}
        />,
      ),
    );
    expect(sectionText("Account limits")).toContain("Asking OMP for account limits…");
    expect(
      container.querySelector('section[aria-label="Last 24 hours"] [role="alert"]')?.textContent,
    ).toBe("omp stats timed out");
    expect(sectionText("Running threads")).toContain("No OMP thread is running.");

    act(() =>
      root.render(
        <OmpUsageView
          account={{ status: "ok", value: { ...account, limits: [] } }}
          stats={{ status: "loading" }}
          sessions={{ status: "loading" }}
          now={NOW}
        />,
      ),
    );
    expect(sectionText("Account limits")).toContain("No signed-in account reports limits.");
    expect(sectionText("Last 24 hours")).toContain("OMP is reading its session history…");
    expect(sectionText("Running threads")).toContain("Asking running threads…");
  });
});

describe("OmpUsageSection", () => {
  it("asks for an OMP provider when no selected environment has one", () => {
    act(() => root.render(<OmpUsageSection environments={[]} refreshKey={0} />));
    expect(container.textContent).toBe(
      "Add an OMP provider to see its account limits and usage stats here.",
    );
  });
});
