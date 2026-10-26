import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * File name of a custom agent in `<agent dir>/agents/`: a plain `.md` name, no folders. OMP loads
 * every `*.md` there; Ompanel only edits names that cannot leave the folder.
 */
export const OMP_AGENT_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,123}\.md$/;

/** Largest file the editors read or write. */
export const OMP_AGENT_FILE_MAX_BYTES = 512 * 1024;

export const OmpAgentFileName = Schema.String.check(
  Schema.isPattern(OMP_AGENT_FILE_NAME_PATTERN),
  Schema.isMaxLength(128),
);

/** A file in the instance's OMP agent directory (`omp config path`, per profile). */
export const OmpAgentFileRef = Schema.Union([
  /** The user-level advisor roster: `WATCHDOG.yml`, or `WATCHDOG.yaml` when only that exists. */
  Schema.Struct({ kind: Schema.Literal("watchdog") }),
  /** A custom agent: `agents/<name>`. */
  Schema.Struct({ kind: Schema.Literal("agent"), name: OmpAgentFileName }),
]);
export type OmpAgentFileRef = typeof OmpAgentFileRef.Type;

/** sha256 of the file's bytes, hex; a write must name the version it replaces. */
const OmpAgentFileVersion = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const OmpAgentFileEntry = Schema.Struct({
  name: Schema.String,
  /**
   * False for a name Ompanel does not edit, or a link that resolves outside the agent
   * directory; OMP may still load it.
   */
  editable: Schema.Boolean,
});
export type OmpAgentFileEntry = typeof OmpAgentFileEntry.Type;

export const OmpAgentFilesList = Schema.Struct({
  /** The instance's OMP agent directory, as `omp config path` reports it. */
  agentDir: Schema.String,
  /** The file the WATCHDOG editor reads and writes. */
  watchdogFileName: Schema.Literals(["WATCHDOG.yml", "WATCHDOG.yaml"]),
  watchdogExists: Schema.Boolean,
  /** `agents/*.md`, by name. */
  agents: Schema.Array(OmpAgentFileEntry),
});
export type OmpAgentFilesList = typeof OmpAgentFilesList.Type;

export const OmpAgentFile = Schema.Struct({
  file: OmpAgentFileRef,
  /** Path inside the agent directory, e.g. `WATCHDOG.yml` or `agents/reviewer.md`. */
  relativePath: Schema.String,
  /** Absent when the file does not exist yet. */
  content: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(OmpAgentFileVersion),
});
export type OmpAgentFile = typeof OmpAgentFile.Type;

export const OmpAgentFilesListInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type OmpAgentFilesListInput = typeof OmpAgentFilesListInput.Type;

export const OmpAgentFileReadInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  file: OmpAgentFileRef,
});
export type OmpAgentFileReadInput = typeof OmpAgentFileReadInput.Type;

export const OmpAgentFileWriteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  file: OmpAgentFileRef,
  content: Schema.String.check(Schema.isMaxLength(OMP_AGENT_FILE_MAX_BYTES)),
  /** The version read before editing; absent to create a file that must not exist yet. */
  baseVersion: Schema.optionalKey(OmpAgentFileVersion),
});
export type OmpAgentFileWriteInput = typeof OmpAgentFileWriteInput.Type;

export const OmpAgentFileDeleteInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  file: OmpAgentFileRef,
  baseVersion: OmpAgentFileVersion,
});
export type OmpAgentFileDeleteInput = typeof OmpAgentFileDeleteInput.Type;

export const OmpAgentFilesOperationErrorReason = Schema.Literals([
  "instance_not_found",
  "unsupported",
  /** Not a plain file inside the agent directory: a folder, device, or a link leading out. */
  "not_editable",
  "too_large",
  /** The file changed since it was read, or exists when a create expected none. */
  "conflict",
  "not_found",
  "omp_failed",
  "io_failed",
]);
export type OmpAgentFilesOperationErrorReason = typeof OmpAgentFilesOperationErrorReason.Type;

export class OmpAgentFilesOperationError extends Schema.TaggedError<OmpAgentFilesOperationError>()(
  "OmpAgentFilesOperationError",
  {
    reason: OmpAgentFilesOperationErrorReason,
    message: Schema.String,
  },
) {}
