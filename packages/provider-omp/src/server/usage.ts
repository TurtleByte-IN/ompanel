/**
 * Token usage in OMP session files: assistant `message` and `model_usage` entries. A `task` tool
 * result's summed usage is skipped: each subagent's own transcript is scanned, so it would count twice.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { OmpSettings } from "../settings.ts";
import { resolveOmpInstanceLaunch } from "./launch.ts";
import { resolveOmpSessionsLocation } from "./ompSessions.ts";

const OmpScanState = Schema.Struct({ sessionId: Schema.mutableKey(Schema.String) });
const Usage = Schema.Struct({
  input: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.Unknown),
  cacheRead: Schema.optional(Schema.Unknown),
  cacheWrite: Schema.optional(Schema.Unknown),
  reasoningTokens: Schema.optional(Schema.Unknown),
  cost: Schema.optional(Schema.Struct({ total: Schema.Unknown })),
});
const Identity = { id: Schema.NonEmptyString, timestamp: Schema.String };
const Model = { provider: Schema.NonEmptyString, model: Schema.NonEmptyString };
const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({
    ...Identity,
    type: Schema.Literal("message"),
    message: Schema.Struct({ ...Model, role: Schema.Literal("assistant"), usage: Usage }),
  }),
  Schema.Struct({ ...Identity, ...Model, type: Schema.Literal("model_usage"), usage: Usage }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

function parseRecord(parsed: unknown, state: typeof OmpScanState.Type): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session") {
    state.sessionId = entry.id;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const source = entry.type === "message" ? entry.message : entry;
  const usage = source.usage;
  const model = `${source.provider}/${source.model}`;
  const outputTokens = tokenCount(usage.output);
  const totals = {
    // OMP's input and cache counters are disjoint, as in Pi.
    uncachedInputTokens: tokenCount(usage.input),
    cachedInputTokens: tokenCount(usage.cacheRead),
    cacheCreationTokens: tokenCount(usage.cacheWrite),
    outputTokens,
    reasoningTokens: Math.min(outputTokens, tokenCount(usage.reasoningTokens)),
  };
  const cost = usage.cost?.total;
  // Subscription logins record zero cost; fall back to the shared price table then.
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: "omp",
      timestampMs,
      model,
      rateModel: source.model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      // Forked sessions copy entry IDs and timestamps; the model keeps short IDs apart.
      dedupeKey: JSON.stringify(["omp", entry.id, entry.timestamp, model]),
    },
  ];
}

export const ompUsageFormat: TranscriptUsageFormat<typeof OmpScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    provider: true,
    model: true,
    usage: true,
    message: { role: true, provider: true, model: true, usage: true },
  },
  usageMarkers: ['"usage"', '"session"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "" }), schema: OmpScanState },
};

export type OmpUsageReaderEnv = FileSystem.FileSystem | Path.Path;

/**
 * The instance's session directory, resolved like its threads do (profile, agent directory, env
 * overrides): the environment is the one every omp of the instance runs with.
 */
export const ompUsageReader: ProviderUsageReader<OmpSettings, OmpUsageReaderEnv> = {
  kind: "transcripts",
  provider: "omp",
  format: ompUsageFormat,
  directories: Effect.fn("ompUsageReader.directories")(function* ({ config, environment }) {
    const homeDir = yield* HostProcess.HomeDirectory;
    const profile = config?.profile ?? "";
    // Launch arguments do not move sessions; a refused agent dir leaves the driver's fallback.
    const launch = resolveOmpInstanceLaunch({
      agentDir: config?.agentDir ?? "",
      launchArgs: "",
      profile,
      environment,
      homeDir,
    });
    const location = yield* resolveOmpSessionsLocation({
      environment: launch.ok ? launch.environment : environment,
      profile,
      platform: yield* HostProcess.Platform,
      homeDir,
    });
    return [{ dir: location.root }];
  }),
};
