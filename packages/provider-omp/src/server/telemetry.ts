/**
 * OMP driver metrics (PRD §9): driver kind, OMP version, error class and frame drops only.
 * Every attribute key is on `OMP_METRIC_ATTRIBUTE_RULES` and every value must pass its rule,
 * or it becomes `other`, so no prompt, reply, path or secret can become a label.
 */
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";

import type { OmpLock } from "../ompLock.ts";
import { OMP_PROVIDER } from "./mapper.ts";
import { OmpFramingError } from "./rpcFrames.ts";

export const ompSessionsTotal = Metric.counter("t3_omp_sessions_total", {
  description: "OMP session processes started (spawn plus handshake), by outcome and error class.",
});

export const ompTurnsTotal = Metric.counter("t3_omp_turns_total", {
  description: "OMP turns that ended, by outcome and, for failed turns, error class.",
});

export const ompErrorsTotal = Metric.counter("t3_omp_errors_total", {
  description: "OMP driver errors outside a turn's own outcome (lost transport, extension errors).",
});

export const ompFramesDroppedTotal = Metric.counter("t3_omp_frames_dropped_total", {
  description:
    "OMP frames that reached nothing: dropped by the sidecar or by the driver, by reason.",
});

const SEMVER = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:-[0-9A-Za-z]{1,32}(?:\.[0-9A-Za-z]{1,32}){0,4})?$/;

export const OMP_ERROR_CLASSES = [
  // Starting a session.
  "sidecar",
  "spawn",
  "ready",
  "negotiate",
  "contract_mismatch",
  // A running session.
  "protocol",
  "framing_frame_too_large",
  "framing_invalid_frame",
  "framing_chunk",
  "write",
  "closed",
  "rpc_command",
  "rpc_timeout",
  "extension",
  // A failed turn (`OrchestrationV2ProviderFailureClass`).
  "usage_limit",
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
  "other",
] as const;
export type OmpErrorClass = (typeof OMP_ERROR_CLASSES)[number];

export const OMP_FRAME_DROP_REASONS = [
  /** OMP could not fit an event in the transport limits and sent `rpc_frame_error` instead. */
  "sidecar_oversize",
  /** A turn-scoped frame arrived with no turn to attach it to (and no detached run took it). */
  "out_of_turn",
  /** A dialog with no id or no choices: nobody can answer it, so it is cancelled. */
  "dialog_unanswerable",
] as const;
export type OmpFrameDropReason = (typeof OMP_FRAME_DROP_REASONS)[number];

const OUTCOMES = ["started", "failed", "completed", "interrupted"] as const;

const oneOf =
  (values: ReadonlyArray<string>) =>
  (value: string): boolean =>
    values.includes(value);

/**
 * The only attribute keys an OMP metric may carry, with the values each accepts. Adding a key
 * here is a privacy decision: it must never be able to hold user content.
 */
export const OMP_METRIC_ATTRIBUTE_RULES = {
  /** Driver kind. */
  provider: oneOf([OMP_PROVIDER]),
  /** The sidecar build: the pinned fork tag, or `custom` for a user-supplied binary. */
  ompVersion: (value: string) => value === "custom" || value === "unknown" || SEMVER.test(value),
  /** RPC contract the running sidecar reported in its handshake. */
  ompContract: (value: string) => value === "unknown" || SEMVER.test(value),
  outcome: oneOf(OUTCOMES),
  errorClass: oneOf(OMP_ERROR_CLASSES),
  reason: oneOf(OMP_FRAME_DROP_REASONS),
} as const satisfies Record<string, (value: string) => boolean>;

export type OmpMetricAttributeKey = keyof typeof OMP_METRIC_ATTRIBUTE_RULES;

export interface OmpMetricAttributes {
  readonly ompVersion: string;
  readonly ompContract: string;
  readonly outcome?: (typeof OUTCOMES)[number];
  readonly errorClass?: OmpErrorClass;
  readonly reason?: OmpFrameDropReason;
}

const isRuleKey = (key: string): key is OmpMetricAttributeKey =>
  Object.hasOwn(OMP_METRIC_ATTRIBUTE_RULES, key);

/** The attributes as recorded: allow-listed keys only, any value off its rule becomes `other`. */
export function ompMetricAttributes(
  attributes: OmpMetricAttributes,
): ReadonlyArray<[OmpMetricAttributeKey, string]> {
  const entries: Array<[OmpMetricAttributeKey, string]> = [["provider", OMP_PROVIDER]];
  for (const [key, value] of Object.entries(attributes)) {
    if (!isRuleKey(key) || key === "provider" || typeof value !== "string") continue;
    entries.push([key, OMP_METRIC_ATTRIBUTE_RULES[key](value) ? value : "other"]);
  }
  return entries;
}

export const recordOmpMetric = (
  metric: Metric.Metric<number, unknown>,
  attributes: OmpMetricAttributes,
): Effect.Effect<void> =>
  Metric.update(Metric.withAttributes(metric, ompMetricAttributes(attributes)), 1);

/** `ompVersion` for a sidecar verified against `omp.lock`: the fork tag without its `v`. */
export const ompLockVersionLabel = (lock: Pick<OmpLock, "tag">): string =>
  lock.tag.replace(/^v/, "");

/** `ompContract` from a handshake value, which comes off the wire. */
export const ompContractLabel = (contractVersion: string | null | undefined): string =>
  contractVersion != null && SEMVER.test(contractVersion) ? contractVersion : "unknown";

/** The class of a driver error, from its tag and reason only; its message is never read. */
export function ompErrorClass(error: unknown): OmpErrorClass {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;
  switch (tag) {
    case "OmpSidecarError":
      return "sidecar";
    case "OmpContractMismatchError":
      return "contract_mismatch";
    case "OmpRpcCommandError":
      return "rpc_command";
    case "OmpRpcTimeoutError":
      return "rpc_timeout";
    case "OmpRpcError": {
      const { reason, cause } = error as { readonly reason: string; readonly cause?: unknown };
      if (reason === "protocol" && cause instanceof OmpFramingError) {
        return `framing_${cause.reason}`;
      }
      return oneOf(OMP_ERROR_CLASSES)(reason) ? (reason as OmpErrorClass) : "other";
    }
    default:
      return "other";
  }
}
