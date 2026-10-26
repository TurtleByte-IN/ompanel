import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

/** The Usage page's OMP tab reads one instance at a time. */
export const OmpUsageInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type OmpUsageInput = typeof OmpUsageInput.Type;

/** One quota window of a signed-in account, from `omp usage --json` (OMP's `UsageLimit`). */
export const OmpAccountLimit = Schema.Struct({
  provider: Schema.String,
  /** The account the limit belongs to, when OMP names one. */
  accountId: Schema.optionalKey(Schema.String),
  id: Schema.String,
  label: Schema.String,
  windowLabel: Schema.optionalKey(Schema.String),
  /** Epoch ms. */
  resetsAt: Schema.optionalKey(Schema.Number),
  /** 0..1, above 1 for overage; absent when OMP reports no amount it can be derived from. */
  usedFraction: Schema.optionalKey(Schema.Number),
  used: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
  unit: Schema.String,
  status: Schema.optionalKey(Schema.Literals(["ok", "warning", "exhausted", "unknown"])),
});
export type OmpAccountLimit = typeof OmpAccountLimit.Type;

export const OmpAccountUsage = Schema.Struct({
  /** Epoch ms. */
  generatedAt: Schema.Number,
  limits: Schema.Array(OmpAccountLimit),
  /** Providers OMP queried that returned no limits. */
  providersWithoutLimits: Schema.Array(Schema.String),
});
export type OmpAccountUsage = typeof OmpAccountUsage.Type;

export const OmpStatsTotals = Schema.Struct({
  requests: Schema.Number,
  failedRequests: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  costUsd: Schema.Number,
  /** Epoch ms; 0 when there are no requests. */
  firstTimestamp: Schema.Number,
  lastTimestamp: Schema.Number,
});
export type OmpStatsTotals = typeof OmpStatsTotals.Type;

/** Totals over every session file of the instance's profile, from `omp stats --json`. */
export const OmpStatsSummary = Schema.Struct({
  overall: OmpStatsTotals,
  byModel: Schema.Array(
    Schema.Struct({ ...OmpStatsTotals.fields, provider: Schema.String, model: Schema.String }),
  ),
});
export type OmpStatsSummary = typeof OmpStatsSummary.Type;

/** RPC `get_session_stats` of one running thread (OMP's `SessionStats`, the fields shown). */
export const OmpSessionStats = Schema.Struct({
  userMessages: Schema.Number,
  assistantMessages: Schema.Number,
  toolCalls: Schema.Number,
  inputTokens: Schema.Number,
  outputTokens: Schema.Number,
  cacheReadTokens: Schema.Number,
  cacheWriteTokens: Schema.Number,
  totalTokens: Schema.Number,
  costUsd: Schema.Number,
  contextUsage: Schema.optionalKey(
    Schema.Struct({ tokens: Schema.Number, contextWindow: Schema.Number, percent: Schema.Number }),
  ),
});
export type OmpSessionStats = typeof OmpSessionStats.Type;

const OmpSessionUsageBase = {
  threadId: Schema.String,
  sessionId: Schema.String,
  cwd: Schema.String,
};

/** A running thread's stats, or why that one thread could not report them. */
export const OmpSessionUsage = Schema.Union([
  Schema.Struct({ ...OmpSessionUsageBase, status: Schema.Literal("ok"), stats: OmpSessionStats }),
  Schema.Struct({
    ...OmpSessionUsageBase,
    status: Schema.Literal("error"),
    message: Schema.String,
  }),
]);
export type OmpSessionUsage = typeof OmpSessionUsage.Type;

export const OmpSessionUsageList = Schema.Struct({ sessions: Schema.Array(OmpSessionUsage) });
export type OmpSessionUsageList = typeof OmpSessionUsageList.Type;

export const OmpUsageOperationErrorReason = Schema.Literals([
  "instance_not_found",
  "unsupported",
  "timeout",
  "omp_failed",
]);
export type OmpUsageOperationErrorReason = typeof OmpUsageOperationErrorReason.Type;

/** Carries no omp output: it may contain credentials. */
export class OmpUsageOperationError extends Schema.TaggedError<OmpUsageOperationError>()(
  "OmpUsageOperationError",
  {
    reason: OmpUsageOperationErrorReason,
    message: Schema.String,
  },
) {}
