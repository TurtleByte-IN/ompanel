// Shared by the server's settings engine and the client's settings form; keep it browser-safe.
import {
  OmpConfigScope,
  OmpConfigSource,
  OmpConfigType,
  type OmpSettingsField,
  type OmpSettingsForm,
  type OmpThreadOverrideRoute,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import type {
  CacheWarmingMode,
  InterruptMode,
  QueueMode,
  RpcWireCommands,
  ThinkingLevel,
} from "../contract/src/wire.generated.ts";
import { OMP_CREDENTIAL_SETTING_KEYS, OMP_SETTING_KEYS } from "./ompSettingKeys.generated.ts";

/**
 * `omp config list|set|reset --json` output, from OMP's CLI JSON contract 1.0.0
 * (`packages/rpc-contract/cli-contract.schema.json` on the fork).
 */
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

/**
 * Keys that follow the thread's permission mode, so a per-thread override would never apply: the
 * approval mode is a launch flag (`--approval-mode`), which outranks overlays, and the browser
 * and computer-use preludes are pinned in the overlay by the adapter (server/toolGuards.ts).
 */
export const OMP_GUARDED_TOOL_KEYS = ["browser.enabled", "computer.enabled"] as const;

const OMP_PERMISSION_MODE_KEYS: Readonly<Record<string, true>> = {
  "tools.approvalMode": true,
  ...Object.fromEntries(OMP_GUARDED_TOOL_KEYS.map((key) => [key, true] as const)),
};

type ThreadRpcCommandName =
  | "set_thinking_level"
  | "set_steering_mode"
  | "set_follow_up_mode"
  | "set_interrupt_mode"
  | "set_auto_compaction"
  | "set_auto_retry"
  | "set_cache_warming";

/** A session-only RPC command that overrides one setting for one thread without a restart. */
export type OmpThreadRpcCommand = {
  readonly [K in ThreadRpcCommandName]: {
    readonly type: K;
    readonly params: RpcWireCommands[K]["params"];
  };
}[ThreadRpcCommandName];

const oneOf =
  <const T extends string>(values: ReadonlyArray<T>) =>
  (value: unknown): value is T =>
    typeof value === "string" && (values as ReadonlyArray<string>).includes(value);

const isThinkingLevel = oneOf<ThinkingLevel>([
  "inherit",
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
const isQueueMode = oneOf<QueueMode>(["all", "one-at-a-time"]);
const isInterruptMode = oneOf<InterruptMode>(["immediate", "wait"]);
const isCacheWarmingMode = oneOf<CacheWarmingMode>(["off", "streaming", "idle"]);

/**
 * Commands of the pinned RPC contract that change exactly one setting for the running session
 * and never write config.yml (`modes/rpc/rpc-mode.ts`). Other keys go through the overlay.
 */
const THREAD_RPC_COMMANDS: Readonly<
  Record<string, (value: unknown) => OmpThreadRpcCommand | undefined>
> = {
  defaultThinkingLevel: (value) =>
    isThinkingLevel(value) ? { type: "set_thinking_level", params: { level: value } } : undefined,
  steeringMode: (value) =>
    isQueueMode(value) ? { type: "set_steering_mode", params: { mode: value } } : undefined,
  followUpMode: (value) =>
    isQueueMode(value) ? { type: "set_follow_up_mode", params: { mode: value } } : undefined,
  interruptMode: (value) =>
    isInterruptMode(value) ? { type: "set_interrupt_mode", params: { mode: value } } : undefined,
  "compaction.enabled": (value) =>
    typeof value === "boolean"
      ? { type: "set_auto_compaction", params: { enabled: value } }
      : undefined,
  "retry.enabled": (value) =>
    typeof value === "boolean" ? { type: "set_auto_retry", params: { enabled: value } } : undefined,
  "providers.cacheWarming": (value) =>
    isCacheWarmingMode(value) ? { type: "set_cache_warming", params: { mode: value } } : undefined,
};

/** The RPC command applying `value` to a thread, or `undefined` when the key has none or the value does not fit. */
export const ompThreadRpcCommand = (
  key: string,
  value: unknown,
): OmpThreadRpcCommand | undefined =>
  Object.hasOwn(THREAD_RPC_COMMANDS, key) ? THREAD_RPC_COMMANDS[key]?.(value) : undefined;

const threadOverrideRoute = (key: string): OmpThreadOverrideRoute =>
  Object.hasOwn(OMP_PERMISSION_MODE_KEYS, key)
    ? "none"
    : Object.hasOwn(THREAD_RPC_COMMANDS, key)
      ? "rpc"
      : "overlay";

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

const KNOWN_SETTINGS = new Set(OMP_SETTING_KEYS);
const KNOWN_CREDENTIALS = new Set(OMP_CREDENTIAL_SETTING_KEYS);
const SECRET_NOUNS = new Set([
  "token",
  "secret",
  "secrets",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "cookie",
  "cookies",
]);
const KEY_QUALIFIERS = new Set(["api", "access", "private", "secret", "client", "auth", "signing"]);

/** Whether the key's last word names a secret: `searxng.token`, `hindsight.apiToken`, `x.llmApiKey`. */
const namesSecret = (key: string): boolean => {
  const words = key
    .split(/[._-]/)
    .flatMap((segment) => segment.match(/[A-Z]?[a-z0-9]+|[A-Z]+(?![a-z])/g) ?? [])
    .map((word) => word.toLowerCase());
  const last = words.at(-1) ?? "";
  const before = words.at(-2) ?? "";
  return (
    SECRET_NOUNS.has(last) || ((last === "key" || last === "keys") && KEY_QUALIFIERS.has(before))
  );
};

/**
 * Fail-closed: a key is a credential unless the pinned OMP registers it without a credential
 * marker. OMP's `config list` only redacts credentials that hold a value, so an unset one would
 * otherwise look like plain text. Text and record keys named like a secret count too.
 */
export const isOmpCredentialKey = (key: string, type: OmpConfigType): boolean =>
  KNOWN_CREDENTIALS.has(key) ||
  !KNOWN_SETTINGS.has(key) ||
  ((type === "string" || type === "record") && namesSecret(key));

/** One field per key, in OMP's settings-panel order. A credential's value is never carried. */
export const buildOmpSettingsForm = (list: OmpConfigList): OmpSettingsForm => ({
  fields: Object.entries(list).map(([key, entry]): OmpSettingsField => {
    const credential = entry.redacted === true || isOmpCredentialKey(key, entry.type);
    return {
      key,
      group: key.split(".", 1)[0] ?? key,
      type: entry.type,
      description: entry.description,
      source: entry.source,
      ...(credential || entry.value === undefined ? {} : { value: entry.value }),
      redacted: entry.redacted === true,
      credential,
      readOnly: entry.source === "env",
      launchScoped: Object.hasOwn(OMP_LAUNCH_SCOPED_KEYS, key),
      threadOverride: threadOverrideRoute(key),
    };
  }),
});
