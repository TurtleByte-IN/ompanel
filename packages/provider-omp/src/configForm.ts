// Shared by the server's settings engine and the client's settings form; keep it browser-safe.
import * as Schema from "effect/Schema";

/**
 * `omp config list|set|reset --json` output, from OMP's CLI JSON contract 1.0.0
 * (`packages/rpc-contract/cli-contract.schema.json` on the fork).
 */
export const OmpConfigSource = Schema.Literals([
  "default",
  "global",
  "project",
  "overlay",
  "runtime",
  "env",
]);
export type OmpConfigSource = typeof OmpConfigSource.Type;

export const OmpConfigType = Schema.Literals([
  "boolean",
  "string",
  "number",
  "enum",
  "array",
  "record",
]);
export type OmpConfigType = typeof OmpConfigType.Type;

export const OmpConfigScope = Schema.Literals(["global", "project"]);
export type OmpConfigScope = typeof OmpConfigScope.Type;

export const OmpConfigEntry = Schema.Struct({
  type: OmpConfigType,
  description: Schema.String,
  source: OmpConfigSource,
  value: Schema.optional(Schema.Unknown),
  redacted: Schema.optional(Schema.Literal(true)),
});
export type OmpConfigEntry = typeof OmpConfigEntry.Type;

export const OmpConfigList = Schema.Record(Schema.String, OmpConfigEntry);
export type OmpConfigList = typeof OmpConfigList.Type;

export const OmpConfigSetResult = Schema.Struct({
  key: Schema.String,
  scope: OmpConfigScope,
  value: Schema.optional(Schema.Unknown),
  overriddenBy: Schema.optional(Schema.String),
  fallbackEnv: Schema.optional(Schema.String),
});
export type OmpConfigSetResult = typeof OmpConfigSetResult.Type;

export const OmpConfigResetResult = Schema.Struct({
  key: Schema.String,
  scope: OmpConfigScope,
  value: Schema.optional(Schema.Unknown),
  redacted: Schema.optional(Schema.Literal(true)),
});
export type OmpConfigResetResult = typeof OmpConfigResetResult.Type;

/**
 * Keys a running thread reads only while it starts, so a change reaches it only after a restart.
 * Everything else applies live: an RPC omp watches config.yml, project settings and `--config`
 * overlays (`main.ts` `startWatching`) and its consumers re-read or subscribe. Derived from O main
 * a3aff57a7e; see docs/omp/settings.md for each key's source.
 */
const OMP_LAUNCH_SCOPED_KEYS: Readonly<Record<string, true>> = {
  "goal.enabled": true,
  "mcp.startupTimeoutMs": true,
  "memory.backend": true,
  "mnemopi.embeddingModel": true,
  "plan.defaultOnStartup": true,
  "plan.enabled": true,
};

/** A session-scoped RPC command that overrides one setting for one thread without a restart. */
export interface OmpThreadRpcCommand {
  readonly type: string;
  readonly [field: string]: unknown;
}

const stringCommand =
  (type: string, field: string) =>
  (value: unknown): OmpThreadRpcCommand | undefined =>
    typeof value === "string" ? { type, [field]: value } : undefined;

const booleanCommand =
  (type: string) =>
  (value: unknown): OmpThreadRpcCommand | undefined =>
    typeof value === "boolean" ? { type, enabled: value } : undefined;

/**
 * RPC commands that change exactly one setting for the running session only; none writes
 * config.yml (O main `modes/rpc/rpc-mode.ts`). Other keys go through the thread's overlay.
 */
const THREAD_RPC_COMMANDS: Readonly<
  Record<string, (value: unknown) => OmpThreadRpcCommand | undefined>
> = {
  "tools.approvalMode": stringCommand("set_approval_mode", "mode"),
  "advisor.enabled": booleanCommand("set_advisor"),
  defaultThinkingLevel: stringCommand("set_thinking_level", "level"),
  steeringMode: stringCommand("set_steering_mode", "mode"),
  followUpMode: stringCommand("set_follow_up_mode", "mode"),
  interruptMode: stringCommand("set_interrupt_mode", "mode"),
  "compaction.enabled": booleanCommand("set_auto_compaction"),
  "retry.enabled": booleanCommand("set_auto_retry"),
  "providers.cacheWarming": stringCommand("set_cache_warming", "mode"),
};

export type OmpThreadOverrideRoute = "rpc" | "overlay";

/** The RPC command applying `value` to a thread, or `undefined` when the key has none or the value does not fit. */
export const ompThreadRpcCommand = (
  key: string,
  value: unknown,
): OmpThreadRpcCommand | undefined =>
  Object.hasOwn(THREAD_RPC_COMMANDS, key) ? THREAD_RPC_COMMANDS[key]?.(value) : undefined;

/** Whether `value` has the shape OMP accepts for `type`; enum values are checked by OMP. */
export const ompConfigValueFits = (type: OmpConfigType, value: unknown): boolean => {
  switch (type) {
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "string":
    case "enum":
      return typeof value === "string";
    case "array":
      return Array.isArray(value);
    case "record":
      return typeof value === "object" && value !== null && !Array.isArray(value);
  }
};

export interface OmpSettingsField {
  readonly key: string;
  /** First key segment, for grouping. */
  readonly group: string;
  readonly type: OmpConfigType;
  readonly description: string;
  /** Layer supplying the effective value. */
  readonly source: OmpConfigSource;
  /** Effective value; absent when unset or redacted. */
  readonly value?: unknown;
  /** A configured credential: OMP withholds its value. */
  readonly redacted: boolean;
  /** An environment variable supplies the value; Ompanel cannot change it. */
  readonly readOnly: boolean;
  readonly launchScoped: boolean;
  readonly threadOverride: OmpThreadOverrideRoute;
}

export interface OmpSettingsForm {
  readonly fields: ReadonlyArray<OmpSettingsField>;
}

/** One field per key, in OMP's settings-panel order. */
export const buildOmpSettingsForm = (list: OmpConfigList): OmpSettingsForm => ({
  fields: Object.entries(list).map(([key, entry]) => ({
    key,
    group: key.split(".", 1)[0] ?? key,
    type: entry.type,
    description: entry.description,
    source: entry.source,
    ...(entry.redacted === true || entry.value === undefined ? {} : { value: entry.value }),
    redacted: entry.redacted === true,
    readOnly: entry.source === "env",
    launchScoped: Object.hasOwn(OMP_LAUNCH_SCOPED_KEYS, key),
    threadOverride: Object.hasOwn(THREAD_RPC_COMMANDS, key) ? "rpc" : "overlay",
  })),
});
