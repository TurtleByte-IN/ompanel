import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/** Layer supplying a setting's effective value, as `omp config list --json` reports it. */
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

/** Config file a global or project write goes to. */
export const OmpConfigScope = Schema.Literals(["global", "project"]);
export type OmpConfigScope = typeof OmpConfigScope.Type;

/**
 * How a per-thread override reaches a running thread: a session-only RPC command, the thread's
 * `--config` overlay, or not at all (the key is set per thread by a launch flag).
 */
export const OmpThreadOverrideRoute = Schema.Literals(["rpc", "overlay", "none"]);
export type OmpThreadOverrideRoute = typeof OmpThreadOverrideRoute.Type;

const OmpSettingKey = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

export const OmpSettingsField = Schema.Struct({
  key: OmpSettingKey,
  /** First key segment, for grouping. */
  group: Schema.String,
  type: OmpConfigType,
  description: Schema.String,
  source: OmpConfigSource,
  /** Effective value; absent when unset or redacted. */
  value: Schema.optionalKey(Schema.Unknown),
  /** A configured credential: OMP withholds its value. */
  redacted: Schema.Boolean,
  /**
   * A credential, set or not: its value is never shown, and Ompanel only resets it. Keys the
   * pinned OMP does not register count as credentials.
   */
  credential: Schema.Boolean,
  /** An environment variable supplies the value; Ompanel cannot change it. */
  readOnly: Schema.Boolean,
  /** A running thread reads it only at startup. */
  launchScoped: Schema.Boolean,
  threadOverride: OmpThreadOverrideRoute,
});
export type OmpSettingsField = typeof OmpSettingsField.Type;

export const OmpSettingsForm = Schema.Struct({
  fields: Schema.Array(OmpSettingsField),
});
export type OmpSettingsForm = typeof OmpSettingsForm.Type;

export const OmpSettingsReadInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Project whose `.omp/config.yml` layer is read; without one only global layers apply. */
  projectId: Schema.optionalKey(ProjectId),
});
export type OmpSettingsReadInput = typeof OmpSettingsReadInput.Type;

export const OmpSettingsWriteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: Schema.optionalKey(ProjectId),
  scope: OmpConfigScope,
  key: OmpSettingKey,
  value: Schema.Unknown,
});
export type OmpSettingsWriteInput = typeof OmpSettingsWriteInput.Type;

export const OmpSettingsResetInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: Schema.optionalKey(ProjectId),
  scope: OmpConfigScope,
  key: OmpSettingKey,
});
export type OmpSettingsResetInput = typeof OmpSettingsResetInput.Type;

export const OmpSettingsWriteResult = Schema.Struct({
  /** Every setting, re-read after the write. */
  form: OmpSettingsForm,
  /** A higher layer or environment variable that still supplies the effective value. */
  overriddenBy: Schema.optionalKey(Schema.String),
  /** Open threads now marked restart required. */
  restartRequired: Schema.Array(ThreadId),
});
export type OmpSettingsWriteResult = typeof OmpSettingsWriteResult.Type;

export const OmpThreadOverrideInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
  key: OmpSettingKey,
  value: Schema.Unknown,
});
export type OmpThreadOverrideInput = typeof OmpThreadOverrideInput.Type;

export const OmpThreadOverrideClearInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
  key: OmpSettingKey,
});
export type OmpThreadOverrideClearInput = typeof OmpThreadOverrideClearInput.Type;

export const OmpThreadOverrideResult = Schema.Struct({
  route: Schema.Literals(["rpc", "overlay"]),
  restartRequired: Schema.Boolean,
});
export type OmpThreadOverrideResult = typeof OmpThreadOverrideResult.Type;

export const OmpSettingsOperationErrorReason = Schema.Literals([
  "instance_not_found",
  "unsupported",
  "project_not_found",
  "unknown_key",
  "read_only",
  "invalid_value",
  "credential",
  "not_thread_overridable",
  "thread_not_open",
  "no_value",
  "invalid_overlay",
  "omp_failed",
  "thread_failed",
]);
export type OmpSettingsOperationErrorReason = typeof OmpSettingsOperationErrorReason.Type;

export class OmpSettingsOperationError extends Schema.TaggedError<OmpSettingsOperationError>()(
  "OmpSettingsOperationError",
  {
    reason: OmpSettingsOperationErrorReason,
    message: Schema.String,
  },
) {}
