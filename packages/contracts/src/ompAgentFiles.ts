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

/**
 * Agent-directory files Settings → OMP → Customization lists, at the paths the pinned OMP
 * discovers them (`discovery/builtin.ts`); see `ompCustomizationPathAllowed`.
 */
export const OmpCustomizationCategory = Schema.Literals([
  "skill",
  "rule",
  "prompt",
  "hook",
  "tool",
]);
export type OmpCustomizationCategory = typeof OmpCustomizationCategory.Type;

const NAME = "[A-Za-z0-9][A-Za-z0-9._-]{0,99}";

/** Paths relative to the agent directory, per kind; nothing else is reached. */
const OMP_CUSTOMIZATION_PATH_PATTERNS: Readonly<Record<OmpCustomizationCategory, RegExp>> = {
  skill: new RegExp(`^(?:skills|managed-skills)/${NAME}/SKILL\\.md$`),
  rule: new RegExp(`^(?:rules/${NAME}\\.(?:md|mdc)|RULES\\.md)$`),
  prompt: new RegExp(`^prompts/${NAME}\\.md$`),
  hook: new RegExp(`^hooks/(?:pre|post)/(?:\\*(?:\\.[A-Za-z0-9]{1,16})?|${NAME})$`),
  tool: new RegExp(`^tools/(?:${NAME}\\.(?:json|md|ts|js|sh|bash|py)|${NAME}/index\\.ts)$`),
};

export const ompCustomizationPathAllowed = (category: OmpCustomizationCategory, path: string) =>
  path.length <= 160 && OMP_CUSTOMIZATION_PATH_PATTERNS[category].test(path);

/** The MCP server files OMP reads from the agent directory, both of them, in this order. */
export const OmpMcpFileName = Schema.Literals(["mcp.json", ".mcp.json"]);
export type OmpMcpFileName = typeof OmpMcpFileName.Type;

/** A file in the instance's OMP agent directory (`omp config path`, per profile). */
export const OmpAgentFileRef = Schema.Union([
  /** The user-level advisor roster: `WATCHDOG.yml`, or `WATCHDOG.yaml` when only that exists. */
  Schema.Struct({ kind: Schema.Literal("watchdog") }),
  /** A custom agent: `agents/<name>`. */
  Schema.Struct({ kind: Schema.Literal("agent"), name: OmpAgentFileName }),
  /**
   * Custom providers: `models.yml`, or `models.yaml` when only that exists. A write is refused
   * unless OMP loads the new text in a scratch agent directory first.
   */
  Schema.Struct({ kind: Schema.Literal("models") }),
  /** User-level MCP servers. */
  Schema.Struct({ kind: Schema.Literal("mcp"), name: OmpMcpFileName }),
  /** A skill, rule, prompt template, hook or custom tool, by its path in the agent directory. */
  Schema.Struct({
    kind: Schema.Literal("custom"),
    category: OmpCustomizationCategory,
    path: Schema.String.check(Schema.isMaxLength(160)),
  }),
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

/** One MCP server as OMP's `mcp.json` declares it; headers, env and arguments are left out. */
export const OmpMcpServerEntry = Schema.Struct({
  name: Schema.String,
  file: OmpMcpFileName,
  transport: Schema.Literals(["stdio", "http", "sse"]),
  /** The command a stdio server runs, or the URL (without query or credentials) of a remote one. */
  target: Schema.optionalKey(Schema.String),
  /** `enabled: false` in the file; OMP skips the server. */
  disabled: Schema.Boolean,
});
export type OmpMcpServerEntry = typeof OmpMcpServerEntry.Type;

export const OmpMcpFileState = Schema.Struct({
  name: OmpMcpFileName,
  exists: Schema.Boolean,
  /** Present when the file exists but OMP would load no servers from it. */
  problem: Schema.optionalKey(Schema.Literals(["not_editable", "invalid_json"])),
});
export type OmpMcpFileState = typeof OmpMcpFileState.Type;

export const OmpCustomizationEntry = Schema.Struct({
  category: OmpCustomizationCategory,
  /** Path inside the agent directory, e.g. `rules/no-any.md`. */
  path: Schema.String,
  /** False for a name Ompanel does not edit, or a link that resolves outside the agent directory. */
  editable: Schema.Boolean,
});
export type OmpCustomizationEntry = typeof OmpCustomizationEntry.Type;

export const OmpAgentFilesList = Schema.Struct({
  /** The instance's OMP agent directory, as `omp config path` reports it. */
  agentDir: Schema.String,
  /** The file the WATCHDOG editor reads and writes. */
  watchdogFileName: Schema.Literals(["WATCHDOG.yml", "WATCHDOG.yaml"]),
  watchdogExists: Schema.Boolean,
  /** `agents/*.md`, by name. */
  agents: Schema.Array(OmpAgentFileEntry),
  /** The file the custom providers editor reads and writes. */
  modelsFileName: Schema.Literals(["models.yml", "models.yaml"]),
  modelsExists: Schema.Boolean,
  /**
   * Only a legacy `models.json` exists. OMP turns it into `models.yml` on its next start; until
   * then a new `models.yml` would hide it, so the editor does not create one.
   */
  modelsLegacyJson: Schema.Boolean,
  mcpFiles: Schema.Array(OmpMcpFileState),
  /** Servers of both MCP files, in the order OMP reads them. */
  mcpServers: Schema.Array(OmpMcpServerEntry),
  /** Skills, rules, prompt templates, hooks and custom tools, by kind, then path. */
  customization: Schema.Array(OmpCustomizationEntry),
});
export type OmpAgentFilesList = typeof OmpAgentFilesList.Type;

/** A model OMP listed from a custom provider when it loaded a checked `models.yml`. */
export const OmpCheckedModel = Schema.Struct({ provider: Schema.String, id: Schema.String });
export type OmpCheckedModel = typeof OmpCheckedModel.Type;

export const OmpAgentFile = Schema.Struct({
  file: OmpAgentFileRef,
  /** Path inside the agent directory, e.g. `WATCHDOG.yml` or `agents/reviewer.md`. */
  relativePath: Schema.String,
  /** Absent when the file does not exist yet. */
  content: Schema.optionalKey(Schema.String),
  version: Schema.optionalKey(OmpAgentFileVersion),
  /**
   * After a `models.yml` write: the models of the file's own providers that OMP listed when it
   * loaded the text in a scratch agent directory.
   */
  checkedModels: Schema.optionalKey(Schema.Array(OmpCheckedModel)),
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
  /** OMP did not load the new text (`models.yml`); the file on disk was left as it was. */
  "invalid",
  "omp_failed",
  "io_failed",
]);
export type OmpAgentFilesOperationErrorReason = typeof OmpAgentFilesOperationErrorReason.Type;

export const OmpAgentsUnpackInput = Schema.Struct({
  instanceId: ProviderInstanceId,
});
export type OmpAgentsUnpackInput = typeof OmpAgentsUnpackInput.Type;

/** `omp agents unpack --user`: OMP's bundled agents written to `agents/`, never over a file. */
export const OmpAgentsUnpackResult = Schema.Struct({
  /** File names written to `agents/`. */
  written: Schema.Array(Schema.String),
  /** File names already in `agents/`, left as they were. */
  skipped: Schema.Array(Schema.String),
  files: OmpAgentFilesList,
});
export type OmpAgentsUnpackResult = typeof OmpAgentsUnpackResult.Type;

export class OmpAgentFilesOperationError extends Schema.TaggedError<OmpAgentFilesOperationError>()(
  "OmpAgentFilesOperationError",
  {
    reason: OmpAgentFilesOperationErrorReason,
    message: Schema.String,
  },
) {}
