import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import {
  makeOmpControlService,
  OMP_CONTROL_TIMEOUTS_MS,
  type OmpControlTarget,
} from "./control.ts";
import { OmpRpcCommandError, OmpRpcTimeoutError } from "./rpcProcess.ts";
import type { OmpThreadSession } from "./threadSessions.ts";
import { makeOmpUsageController, OMP_SESSION_STATS_TIMEOUT_MS } from "./usageController.ts";

const encoder = new TextEncoder();
type Behaviour = { readonly stdout: string; readonly exitCode: number } | "hang";

interface FakeOmp {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly launches: Array<ReadonlyArray<string>>;
}

/** A fake `omp`: `usage` and `stats` answer as configured; anything else is unexpected. */
function fakeOmp(input: { readonly usage?: Behaviour; readonly stats?: Behaviour }): FakeOmp {
  const launches: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    launches.push(command.args);
    const behaviour = command.args.includes("stats") ? input.stats : input.usage;
    if (behaviour === undefined) return Effect.die(`Unexpected omp ${command.args.join(" ")}`);
    const base = {
      pid: ChildProcessSpawner.ProcessId(999_999_998),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    };
    return Effect.succeed(
      behaviour === "hang"
        ? ChildProcessSpawner.makeHandle({
            ...base,
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            stdout: Stream.never,
            stderr: Stream.never,
          })
        : ChildProcessSpawner.makeHandle({
            ...base,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(behaviour.exitCode)),
            isRunning: Effect.succeed(false),
            stdout: Stream.succeed(encoder.encode(behaviour.stdout)),
            stderr: Stream.succeed(encoder.encode("Syncing session files...\n")),
          }),
    );
  });
  return { spawner, launches };
}

const target = (cwd: string): Effect.Effect<OmpControlTarget> =>
  Effect.succeed({ binaryPath: "/opt/ompanel/omp", profile: "work", environment: {}, cwd });

const USAGE_JSON = JSON.stringify({
  generatedAt: 1_790_000_000_000,
  reports: [
    {
      provider: "anthropic",
      fetchedAt: 1_790_000_000_000,
      limits: [
        {
          id: "anthropic:5h",
          label: "5 Hour",
          scope: { provider: "anthropic", accountId: "me@example.com" },
          window: { id: "5h", label: "5 Hour", resetsAt: 1_790_000_600_000 },
          amount: { used: 30, limit: 120, unit: "requests" },
          status: "ok",
        },
        {
          id: "anthropic:7d",
          label: "7 Day",
          scope: { provider: "anthropic" },
          amount: { used: 92, unit: "percent" },
          status: "warning",
        },
        // Not a `UsageLimit`: skipped, not fatal.
        { id: "broken" },
      ],
    },
    { provider: "openai-codex", fetchedAt: 1_790_000_000_000, limits: [] },
  ],
});

const totals = {
  totalRequests: 4,
  successfulRequests: 3,
  failedRequests: 1,
  errorRate: 0.25,
  totalInputTokens: 4_000,
  totalOutputTokens: 400,
  totalCacheReadTokens: 20_000,
  totalCacheWriteTokens: 100,
  cacheRate: 0.8,
  cacheSavings: 0.5,
  totalCost: 0.75,
  unpricedRequests: 0,
  totalPremiumRequests: 0,
  avgDuration: null,
  avgTtft: null,
  avgTokensPerSecond: null,
  firstTimestamp: 1_789_000_000_000,
  lastTimestamp: 1_790_000_000_000,
};
const STATS_JSON = JSON.stringify({
  overall: totals,
  byModel: [{ ...totals, model: "claude-sonnet-4-5", provider: "anthropic" }],
  byFolder: [],
  byAgentType: [],
  timeSeries: [],
  modelSeries: [],
  modelPerformanceSeries: [],
  costSeries: [],
});

const controllerWith = (omp: FakeOmp, sessions: ReadonlyArray<OmpThreadSession> = []) =>
  makeOmpControlService().pipe(
    Effect.map((control) =>
      makeOmpUsageController({
        control,
        target,
        globalCwd: "/state/launcher",
        sessions: { list: Effect.succeed(sessions) },
      }),
    ),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
  );

describe("OMP usage: account limits (omp usage --json)", () => {
  it.effect("maps each limit with its used fraction and lists providers without limits", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ usage: { stdout: USAGE_JSON, exitCode: 0 } });
      const usage = yield* controllerWith(omp);
      const account = yield* usage.account;
      assert.deepStrictEqual(omp.launches[0], ["--profile", "work", "usage", "--json"]);
      assert.deepStrictEqual(account, {
        generatedAt: 1_790_000_000_000,
        limits: [
          {
            provider: "anthropic",
            accountId: "me@example.com",
            id: "anthropic:5h",
            label: "5 Hour",
            windowLabel: "5 Hour",
            resetsAt: 1_790_000_600_000,
            usedFraction: 0.25,
            used: 30,
            limit: 120,
            unit: "requests",
            status: "ok",
          },
          {
            provider: "anthropic",
            id: "anthropic:7d",
            label: "7 Day",
            usedFraction: 0.92,
            used: 92,
            unit: "percent",
            status: "warning",
          },
        ],
        providersWithoutLimits: ["openai-codex"],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reports a failing omp without its output", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ usage: { stdout: "token=sk-secret", exitCode: 1 } });
      const usage = yield* controllerWith(omp);
      const error = yield* usage.account.pipe(Effect.flip);
      assert.strictEqual(error.reason, "omp_failed");
      assert.strictEqual(error.message, "OMP usage exited with code 1.");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a hung omp as a timeout at the usage deadline", () =>
    Effect.gen(function* () {
      const usage = yield* controllerWith(fakeOmp({ usage: "hang" }));
      const running = yield* usage.account.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(OMP_CONTROL_TIMEOUTS_MS.usage);
      const error = yield* Fiber.join(running);
      assert.strictEqual(error.reason, "timeout");
      assert.include(error.message, "timed out");
    }).pipe(Effect.scoped),
  );
});

describe("OMP usage: all sessions (omp stats --json)", () => {
  it.effect("maps the overall and per-model totals", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ stats: { stdout: `${STATS_JSON}\n`, exitCode: 0 } });
      const usage = yield* controllerWith(omp);
      const stats = yield* usage.stats;
      assert.deepStrictEqual(omp.launches[0], ["--profile", "work", "stats", "--json"]);
      const expected = {
        requests: 4,
        failedRequests: 1,
        inputTokens: 4_000,
        outputTokens: 400,
        cacheReadTokens: 20_000,
        cacheWriteTokens: 100,
        costUsd: 0.75,
        firstTimestamp: 1_789_000_000_000,
        lastTimestamp: 1_790_000_000_000,
      };
      assert.deepStrictEqual(stats, {
        overall: expected,
        byModel: [{ ...expected, provider: "anthropic", model: "claude-sonnet-4-5" }],
      });
    }).pipe(Effect.scoped),
  );

  it.effect("reports unreadable stats output and a hung stats run", () =>
    Effect.gen(function* () {
      const garbled = yield* controllerWith(
        fakeOmp({ stats: { stdout: "Dashboard available at: http://x", exitCode: 0 } }),
      );
      const invalid = yield* garbled.stats.pipe(Effect.flip);
      assert.strictEqual(invalid.reason, "omp_failed");
      assert.notInclude(invalid.message, "Dashboard");

      const hung = yield* controllerWith(fakeOmp({ stats: "hang" }));
      const running = yield* hung.stats.pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(OMP_CONTROL_TIMEOUTS_MS.stats);
      const error = yield* Fiber.join(running);
      assert.strictEqual(error.reason, "timeout");
    }).pipe(Effect.scoped),
  );
});

describe("OMP usage: running threads (get_session_stats)", () => {
  const session = (
    threadId: string,
    request: OmpThreadSession["process"]["request"],
  ): OmpThreadSession => ({
    threadId,
    providerSessionId: ProviderSessionId.make(`provider-${threadId}`),
    cwd: `/work/${threadId}`,
    process: { request },
    onRestartRequired: () => Effect.void,
    isBusy: () => false,
  });

  it.effect("reports each thread on its own, failures included", () =>
    Effect.gen(function* () {
      const asked: Array<{ command: string; timeoutMs: number | undefined }> = [];
      const answering = session("a", ((
        command: string,
        _params: unknown,
        options?: { timeoutMs?: number },
      ) => {
        asked.push({ command, timeoutMs: options?.timeoutMs });
        return Effect.succeed({
          sessionId: "omp-session-a",
          userMessages: 2,
          assistantMessages: 3,
          toolCalls: 4,
          toolResults: 4,
          totalMessages: 9,
          tokens: { input: 100, output: 50, cacheRead: 400, cacheWrite: 10, total: 560 },
          premiumRequests: 0,
          cost: 0.02,
          contextUsage: { tokens: 20_000, contextWindow: 200_000, percent: 10 },
        });
      }) as never);
      const hung = session("b", (() =>
        Effect.fail(
          new OmpRpcTimeoutError({
            command: "get_session_stats",
            timeoutMs: OMP_SESSION_STATS_TIMEOUT_MS,
          }),
        )) as never);
      const refused = session("c", (() =>
        Effect.fail(
          new OmpRpcCommandError({ command: "get_session_stats", detail: "no session" }),
        )) as never);
      const usage = yield* controllerWith(fakeOmp({}), [answering, hung, refused]);
      const { sessions } = yield* usage.sessions;
      assert.deepStrictEqual(asked, [
        { command: "get_session_stats", timeoutMs: OMP_SESSION_STATS_TIMEOUT_MS },
      ]);
      assert.deepStrictEqual(sessions[0], {
        threadId: "a",
        sessionId: "omp-session-a",
        cwd: "/work/a",
        status: "ok",
        stats: {
          userMessages: 2,
          assistantMessages: 3,
          toolCalls: 4,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 400,
          cacheWriteTokens: 10,
          totalTokens: 560,
          costUsd: 0.02,
          contextUsage: { tokens: 20_000, contextWindow: 200_000, percent: 10 },
        },
      });
      assert.strictEqual(sessions[1]?.status, "error");
      assert.strictEqual(sessions[1]?.sessionId, "provider-b");
      assert.include(sessions[1]?.status === "error" ? sessions[1].message : "", "5000 ms");
      assert.strictEqual(sessions[2]?.status, "error");
    }).pipe(Effect.scoped),
  );

  it.effect("lists no sessions when no thread runs", () =>
    Effect.gen(function* () {
      const usage = yield* controllerWith(fakeOmp({}));
      assert.deepStrictEqual(yield* usage.sessions, { sessions: [] });
    }).pipe(Effect.scoped),
  );
});
