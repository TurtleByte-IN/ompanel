/**
 * The Usage page's OMP tab (PRD FR-14): account quotas from `omp usage --json`, totals over the
 * last 24 hours from `omp stats --json` (its fixed default range), and RPC `get_session_stats` of each running thread. Each
 * source fails on its own, so a slow `omp stats` never hides the account quotas.
 */
import {
  OmpUsageOperationError,
  type OmpAccountLimit,
  type OmpSessionUsage,
  type OmpStatsTotals,
} from "@t3tools/contracts";
import type { ProviderOmpUsageController } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { OmpControlError, OmpControlService, OmpControlTarget } from "./control.ts";
import type { OmpSidecarError } from "./sidecar.ts";
import type { OmpThreadSessions } from "./threadSessions.ts";

/** Per-thread deadline for `get_session_stats`; the stats are in memory, so this is generous. */
export const OMP_SESSION_STATS_TIMEOUT_MS = 5_000;

const ompFailed = (error: OmpControlError | OmpSidecarError) =>
  new OmpUsageOperationError({
    reason:
      error._tag === "OmpControlError" && error.reason === "timeout" ? "timeout" : "omp_failed",
    message: error.message,
  });

/** OMP's `UsageLimit`; anything it does not match is skipped rather than failing the list. */
const UsageLimit = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  scope: Schema.Struct({ provider: Schema.String, accountId: Schema.optional(Schema.String) }),
  window: Schema.optional(
    Schema.Struct({ label: Schema.String, resetsAt: Schema.optional(Schema.Number) }),
  ),
  amount: Schema.Struct({
    used: Schema.optional(Schema.Number),
    limit: Schema.optional(Schema.Number),
    usedFraction: Schema.optional(Schema.Number),
    remainingFraction: Schema.optional(Schema.Number),
    unit: Schema.String,
  }),
  status: Schema.optional(Schema.Literals(["ok", "warning", "exhausted", "unknown"])),
});
const decodeUsageLimit = Schema.decodeUnknownOption(UsageLimit);

/** OMP's `resolveUsedFraction`: explicit fraction, used/limit, percent, inverted remaining. */
const usedFraction = (amount: typeof UsageLimit.Type.amount): number | undefined => {
  if (amount.usedFraction !== undefined) return amount.usedFraction;
  if (amount.used !== undefined && amount.limit !== undefined && amount.limit > 0) {
    return amount.used / amount.limit;
  }
  if (amount.unit === "percent" && amount.used !== undefined) return amount.used / 100;
  if (amount.remainingFraction !== undefined) return Math.max(0, 1 - amount.remainingFraction);
  return undefined;
};

const toOmpAccountLimit = (raw: unknown): OmpAccountLimit | undefined => {
  const decoded = decodeUsageLimit(raw);
  if (decoded._tag === "None") return undefined;
  const limit = decoded.value;
  const fraction = usedFraction(limit.amount);
  return {
    provider: limit.scope.provider,
    ...(limit.scope.accountId === undefined ? {} : { accountId: limit.scope.accountId }),
    id: limit.id,
    label: limit.label,
    ...(limit.window === undefined ? {} : { windowLabel: limit.window.label }),
    ...(limit.window?.resetsAt === undefined ? {} : { resetsAt: limit.window.resetsAt }),
    ...(fraction === undefined || !Number.isFinite(fraction) ? {} : { usedFraction: fraction }),
    ...(limit.amount.used === undefined ? {} : { used: limit.amount.used }),
    ...(limit.amount.limit === undefined ? {} : { limit: limit.amount.limit }),
    unit: limit.amount.unit,
    ...(limit.status === undefined ? {} : { status: limit.status }),
  };
};

const toTotals = (stats: {
  readonly totalRequests: number;
  readonly failedRequests: number;
  readonly totalInputTokens: number;
  readonly totalOutputTokens: number;
  readonly totalCacheReadTokens: number;
  readonly totalCacheWriteTokens: number;
  readonly totalCost: number;
  readonly firstTimestamp: number;
  readonly lastTimestamp: number;
}): OmpStatsTotals => ({
  requests: stats.totalRequests,
  failedRequests: stats.failedRequests,
  inputTokens: stats.totalInputTokens,
  outputTokens: stats.totalOutputTokens,
  cacheReadTokens: stats.totalCacheReadTokens,
  cacheWriteTokens: stats.totalCacheWriteTokens,
  costUsd: stats.totalCost,
  firstTimestamp: stats.firstTimestamp,
  lastTimestamp: stats.lastTimestamp,
});

export const makeOmpUsageController = (input: {
  readonly control: OmpControlService;
  /** This instance's omp, resolved and verified for this call, run in `cwd`. */
  readonly target: (cwd: string) => Effect.Effect<OmpControlTarget, OmpSidecarError>;
  /** A directory with no project config; usage and stats are per profile, not per project. */
  readonly globalCwd: string;
  readonly sessions: Pick<OmpThreadSessions, "list">;
}): ProviderOmpUsageController => {
  const { control } = input;
  const target = input.target(input.globalCwd);

  return {
    account: target.pipe(
      Effect.flatMap((resolved) => control.usage(resolved)),
      Effect.map((report) => ({
        generatedAt: report.generatedAt,
        limits: report.reports.flatMap((entry) =>
          entry.limits.flatMap((raw) => toOmpAccountLimit(raw) ?? []),
        ),
        providersWithoutLimits: report.reports
          .filter((entry) => entry.limits.length === 0)
          .map((entry) => entry.provider),
      })),
      Effect.mapError(ompFailed),
      Effect.withSpan("OmpUsage.account"),
    ),
    stats: target.pipe(
      Effect.flatMap((resolved) => control.stats(resolved)),
      Effect.map((report) => ({
        overall: toTotals(report.overall),
        byModel: report.byModel.map((model) => ({
          ...toTotals(model),
          provider: model.provider,
          model: model.model,
        })),
      })),
      Effect.mapError(ompFailed),
      Effect.withSpan("OmpUsage.stats"),
    ),
    sessions: input.sessions.list.pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(
          sessions,
          (session): Effect.Effect<OmpSessionUsage> => {
            const base = {
              threadId: session.threadId,
              sessionId: String(session.providerSessionId),
              cwd: session.cwd,
            };
            return session.process
              .request("get_session_stats", undefined, {
                timeoutMs: OMP_SESSION_STATS_TIMEOUT_MS,
              })
              .pipe(
                Effect.map((stats): OmpSessionUsage => ({
                  ...base,
                  sessionId: stats.sessionId,
                  status: "ok",
                  stats: {
                    userMessages: stats.userMessages,
                    assistantMessages: stats.assistantMessages,
                    toolCalls: stats.toolCalls,
                    inputTokens: stats.tokens.input,
                    outputTokens: stats.tokens.output,
                    cacheReadTokens: stats.tokens.cacheRead,
                    cacheWriteTokens: stats.tokens.cacheWrite,
                    totalTokens: stats.tokens.total,
                    costUsd: stats.cost,
                    ...(stats.contextUsage === undefined
                      ? {}
                      : {
                          contextUsage: {
                            tokens: stats.contextUsage.tokens,
                            contextWindow: stats.contextUsage.contextWindow,
                            percent: stats.contextUsage.percent,
                          },
                        }),
                  },
                })),
                Effect.catch((error) =>
                  Effect.succeed<OmpSessionUsage>({
                    ...base,
                    status: "error",
                    message: error.message,
                  }),
                ),
              );
          },
          { concurrency: "unbounded" },
        ),
      ),
      Effect.map((sessions) => ({ sessions })),
      Effect.withSpan("OmpUsage.sessions"),
    ),
  };
};
