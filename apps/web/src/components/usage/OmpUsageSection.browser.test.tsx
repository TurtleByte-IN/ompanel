import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";

const commands = vi.hoisted(() => ({
  account: vi.fn(),
  stats: vi.fn(),
  sessions: vi.fn(),
}));

vi.mock(import("../../state/use-atom-command"), async (original) => {
  const { serverEnvironment } = await import("../../state/server");
  const byAtom = new Map<unknown, unknown>([
    [serverEnvironment.getOmpAccountUsage, commands.account],
    [serverEnvironment.getOmpStats, commands.stats],
    [serverEnvironment.getOmpSessionStats, commands.sessions],
  ]);
  return {
    ...(await original()),
    useAtomCommand: ((atom: unknown) => byAtom.get(atom)) as never,
  };
});

import { OmpUsagePanel } from "./OmpUsageSection";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("omp");
const NOW = 1_790_000_000_000;

const totals = {
  requests: 12,
  failedRequests: 1,
  inputTokens: 1_000_000,
  outputTokens: 200_000,
  cacheReadTokens: 300_000,
  cacheWriteTokens: 0,
  costUsd: 3.5,
  firstTimestamp: NOW - 86_400_000,
  lastTimestamp: NOW,
};

const section = (name: string) =>
  document.querySelector<HTMLElement>(`section[aria-label="${name}"]`);

describe("Usage → OMP tab", () => {
  it("shows account limits, all-session totals and running threads", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    commands.account.mockResolvedValue({
      _tag: "Success",
      value: {
        generatedAt: NOW,
        limits: [
          {
            provider: "anthropic",
            accountId: "me@example.com",
            id: "anthropic:5h",
            label: "5 Hour",
            resetsAt: NOW + 2 * 3_600_000,
            usedFraction: 0.25,
            unit: "percent",
            status: "ok",
          },
        ],
        providersWithoutLimits: [],
      },
    });
    commands.stats.mockResolvedValue({
      _tag: "Success",
      value: {
        overall: totals,
        byModel: [{ ...totals, provider: "anthropic", model: "claude-sonnet-4-5" }],
      },
    });
    commands.sessions.mockResolvedValue({
      _tag: "Success",
      value: {
        sessions: [
          {
            threadId: "t1",
            sessionId: "omp-1",
            cwd: "/work/app",
            status: "ok",
            stats: {
              userMessages: 2,
              assistantMessages: 3,
              toolCalls: 7,
              inputTokens: 1_000,
              outputTokens: 500,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              totalTokens: 1_500,
              costUsd: 0.02,
              contextUsage: { tokens: 20_000, contextWindow: 200_000, percent: 10 },
            },
          },
        ],
      },
    });
    await using _screen = await render(
      <OmpUsagePanel environmentId={environmentId} instanceId={instanceId} />,
    );
    await expect.poll(() => section("Account limits")?.dataset.ompUsageSource).toBe("ok");
    expect(section("Account limits")?.textContent).toContain("me@example.com");
    expect(section("Account limits")?.textContent).toContain("25%");
    expect(section("Account limits")?.textContent).toContain("resets in 2 h");
    await expect.poll(() => section("Last 24 hours")?.dataset.ompUsageSource).toBe("ok");
    expect(section("Last 24 hours")?.querySelector("h2")?.textContent).toBe("Last 24 hours");
    expect(section("Last 24 hours")?.textContent).toContain("last 24 hours");
    expect(section("Last 24 hours")?.textContent).toContain("$3.50");
    expect(section("Last 24 hours")?.textContent).toContain("1.50M");
    expect(section("Last 24 hours")?.textContent).toContain("anthropic/claude-sonnet-4-5");
    await expect.poll(() => section("Running threads")?.dataset.ompUsageSource).toBe("ok");
    expect(section("Running threads")?.textContent).toContain("7 tool calls");
    expect(section("Running threads")?.textContent).toContain("context 10%");
    for (const command of [commands.account, commands.stats, commands.sessions]) {
      expect(command).toHaveBeenCalledWith({ environmentId, input: { instanceId } });
    }
    vi.restoreAllMocks();
  });

  it("keeps each source's state apart: loading, timed out, failed thread", async () => {
    commands.account.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(new Error("OMP usage timed out after 10000 ms and was stopped.")),
    });
    // `omp stats` still syncing its history.
    commands.stats.mockReturnValue(new Promise(() => {}));
    commands.sessions.mockResolvedValue({
      _tag: "Success",
      value: {
        sessions: [
          {
            threadId: "t2",
            sessionId: "omp-2",
            cwd: "/work/api",
            status: "error",
            message: "OMP command get_session_stats got no response within 5000 ms.",
          },
        ],
      },
    });
    await using _screen = await render(
      <OmpUsagePanel environmentId={environmentId} instanceId={instanceId} />,
    );
    await expect.poll(() => section("Account limits")?.dataset.ompUsageSource).toBe("error");
    expect(section("Account limits")?.querySelector("[role=alert]")?.textContent).toContain(
      "timed out",
    );
    expect(section("Last 24 hours")?.dataset.ompUsageSource).toBe("loading");
    await expect.poll(() => section("Running threads")?.dataset.ompUsageSource).toBe("ok");
    expect(section("Running threads")?.querySelector("[role=alert]")?.textContent).toContain(
      "5000 ms",
    );
  });
});
