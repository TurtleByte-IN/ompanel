// @effect-diagnostics nodeBuiltinImport:off - the owner-only control overlay is written synchronously while the service is built, so the service needs no FileSystem and no session waits on it.
/**
 * OmpControlService: every short-lived `omp` process Ompanel starts outside a thread runs here
 * under a hard deadline; on it the process group gets SIGTERM, then SIGKILL after
 * {@link OMP_CONTROL_KILL_GRACE_MS}, so a hung omp never outlives the call.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSpawnCommand, SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  ReadyEvent,
} from "../../contract/src/wire.generated.ts";
import type {
  OmpConfigScope,
  OmpMarketplace,
  OmpMarketplacePlugin,
  OmpUpdateCheck,
} from "@t3tools/contracts";

import {
  OmpConfigLayerList,
  OmpConfigList,
  OmpConfigResetResult,
  OmpConfigSetResult,
} from "../configForm.ts";
import { OmpCatalogModel } from "./modelTraits.ts";
import { OmpAnsi } from "./ompAnsi.ts";

/** Hard deadline per operation, from spawn to exit. */
export const OMP_CONTROL_TIMEOUTS_MS = {
  /** `omp --version`. */
  version: 4_000,
  /**
   * The probe's RPC server: `ready` frame, `get_login_providers` and `get_available_models`. With
   * no default model, OMP first awaits one model-discovery pass (up to 15 s per fetch,
   * `RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS`) before refusing, so a shorter deadline turns a fresh
   * install into "did not answer" instead of "needs setup".
   */
  ready: 20_000,
  /** `omp usage --json`. */
  usage: 10_000,
  /**
   * `omp stats --json`. It first ingests every new session entry into OMP's stats database, so a
   * first run over a long history takes longer than a plain read.
   */
  stats: 60_000,
  /** An RPC `login` session, from spawn until the provider stores the credential. */
  login: 60_000,
  /** `omp config list|set|reset --json`. */
  config: 10_000,
  /** `omp skill list --json`, or an RPC server's `ready` plus `get_available_commands`. */
  catalog: 10_000,
  /**
   * An RPC server in a scratch agent directory: `ready` and `get_available_models`. It starts
   * without the agent directory's caches, so it gets longer than the probe.
   */
  modelsCheck: 15_000,
  /** `omp agents unpack --user --json`. */
  agents: 10_000,
  /** `omp plugin list --json`, `omp plugin marketplace list` and `omp plugin discover`. */
  plugins: 15_000,
  /**
   * An `omp plugin` command that changes something: an install or a new marketplace clones or
   * downloads, so it gets far longer than a read.
   */
  pluginCommand: 180_000,
  /** `omp update --check`: one request to OMP's release service. */
  update: 20_000,
  /** `omp --export <session file> <out.html>`: renders the whole session into one page. */
  export: 60_000,
  /** `gh auth status`: verifies the stored token with GitHub. */
  ghAuth: 10_000,
  /** `omp share --gist`: seals the session, then `gh gist create` uploads it. */
  share: 120_000,
} as const;
export type OmpControlBudget = keyof typeof OMP_CONTROL_TIMEOUTS_MS;

/** SIGTERM grace before SIGKILL when a deadline stops a process group. */
export const OMP_CONTROL_KILL_GRACE_MS = 1_000;
/** How long one instance reuses a probe or usage result. */
export const OMP_CONTROL_CACHE_TTL_MS = 30_000;
/**
 * First RPC contract whose `login` takes `input` and `secretInput` and whose provider list
 * includes API-key providers (oh-my-pi O-8). Older servers would drop `input` and ask for the key
 * in an unmasked prompt, so Ompanel never sends a key to them.
 */
export const OMP_LOGIN_INPUT_CONTRACT = "1.6.0";

/** True when semver `version` is at least `minimum`; an absent or unreadable version is not. */
export const ompContractAtLeast = (version: string | undefined, minimum: string): boolean => {
  const parse = (text: string | undefined) => {
    const match = text === undefined ? null : /^(\d+)\.(\d+)\.(\d+)/.exec(text);
    return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const have = parse(version);
  const need = parse(minimum);
  if (have === null || need === null) return false;
  for (let index = 0; index < 3; index++) {
    if (have[index]! !== need[index]!) return have[index]! > need[index]!;
  }
  return true;
};

/**
 * A control process must not open a session, run hooks or extensions, or start MCP servers: no
 * session file, no built-in tools, no extensions, skills, rules, LSP or title model. Login
 * providers that extensions contribute are therefore not listed. `--no-tools` does not stop MCP
 * discovery, so every control session also loads {@link OMP_CONTROL_OVERLAY}.
 */
export const OMP_CONTROL_RPC_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-lsp",
  "--no-title",
] as const;

/**
 * The `--config` overlay of every control session, which starts in the project before it is
 * trusted: `workspace.trusted: false` stops OMP loading the project's own code (`--no-tools`
 * does not), and the project's MCP config stays off. It outranks the project layer.
 */
const OMP_CONTROL_OVERLAY = "workspace:\n  trusted: false\nmcp:\n  enableProjectConfig: false\n";

/**
 * The lines `omp --mode rpc` writes to stderr before exiting 1 when no model resolves: no default
 * model, no credentials, no `models.yml` (a fresh install). From `main.ts` (`!isInteractive &&
 * !session.model`) and `sdk.ts` (`modelFallbackMessage`) at the `omp.lock` tag. Only this test
 * reads stderr; the text itself is never kept.
 */
const OMP_UNCONFIGURED_STDERR =
  /No default model selected\.|No model available matching enabledModels|No models available\./;

/**
 * The model a control server is started with once OMP refused to start for want of one. It only
 * has to resolve in OMP's built-in catalog (credentials are not needed for that), so sign-in and
 * the provider list work before `omp setup` has picked a model. `--model` overrides the default
 * role for that process only (`Settings.overrideModelRoles`); nothing is written to `config.yml`.
 */
export const OMP_SETUP_PLACEHOLDER_MODEL = "anthropic/claude-sonnet-4-5";

/** One instance's omp: the resolved binary and how to run it. */
export interface OmpControlTarget {
  readonly binaryPath: string;
  /** Identity of the verified binary file; a swapped binary misses the cache. */
  readonly binaryIdentity?: string;
  readonly profile: string;
  /**
   * The instance's launch arguments: appended to `omp --mode rpc` only. One-shot subcommands
   * (`config`, `plugin`, `update`, ...) take their own flags and reject unknown ones.
   */
  readonly launchArgs?: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export type OmpControlOperation =
  | "version"
  | "usage"
  | "stats"
  | "rpc"
  | "login_providers"
  | "login"
  | "logout_accounts"
  | "logout"
  | "config_list"
  | "config_layer"
  | "config_set"
  | "config_reset"
  | "config_path"
  | "skill_list"
  | "available_commands"
  | "available_models"
  | "models_check"
  | "agents_unpack"
  | "plugin_list"
  | "plugin_command"
  | "marketplace_list"
  | "marketplace_discover"
  | "update_check"
  | "export_html"
  | "gh_auth"
  | "share_gist";

/** Carries no process output: stderr and stdout may contain credentials. */
export class OmpControlError extends Schema.TaggedError<OmpControlError>()("OmpControlError", {
  operation: Schema.Literals([
    "version",
    "usage",
    "stats",
    "rpc",
    "login_providers",
    "login",
    "logout_accounts",
    "logout",
    "config_list",
    "config_layer",
    "config_set",
    "config_reset",
    "config_path",
    "skill_list",
    "available_commands",
    "available_models",
    "models_check",
    "agents_unpack",
    "plugin_list",
    "plugin_command",
    "marketplace_list",
    "marketplace_discover",
    "update_check",
    "export_html",
    "gh_auth",
    "share_gist",
  ]),
  reason: Schema.Literals([
    "missing",
    "spawn",
    "timeout",
    "exit",
    "invalid",
    "rejected",
    "unsupported",
    /** `omp --mode rpc` exited before `ready` because no model resolves: OMP needs `omp setup`. */
    "unconfigured",
  ]),
  timeoutMs: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  /** The RPC failure message for `rejected`. */
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "missing":
        return `OMP ${this.operation} failed: the executable was not found.`;
      case "spawn":
        return `OMP ${this.operation} failed: the executable could not be started.`;
      case "timeout":
        return `OMP ${this.operation} timed out after ${this.timeoutMs ?? 0} ms and was stopped.`;
      case "exit":
        return `OMP ${this.operation} exited with code ${this.exitCode ?? "unknown"}.`;
      case "invalid":
        return `OMP ${this.operation} returned output Ompanel could not read.`;
      case "rejected":
        return `OMP ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
      case "unsupported":
        return `OMP ${this.operation} needs a newer OMP${this.detail === undefined ? "" : `: ${this.detail}`}.`;
      case "unconfigured":
        return `OMP ${this.operation} could not start: OMP has no model or sign-in yet.`;
    }
  }
}

const ReadyFrame = Schema.Struct({
  type: Schema.Literal("ready"),
  protocolVersion: Schema.optional(Schema.Number),
  contractVersion: Schema.optional(Schema.String),
});
const decodeReadyFrame = Schema.decodeUnknownEffect(ReadyFrame);

/**
 * `LoginProvider`; `apiKey`, `source` and `envVar` arrive from contract 1.6.0 on and are absent
 * from older servers, which list OAuth providers only.
 */
const LoginProviderSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  available: Schema.Boolean,
  authenticated: Schema.Boolean,
  apiKey: Schema.optionalKey(Schema.Boolean),
  source: Schema.optionalKey(Schema.Literals(["runtime", "config", "oauth", "api_key", "env"])),
  envVar: Schema.optionalKey(Schema.String),
});
export type OmpLoginProvider = typeof LoginProviderSchema.Type;
const decodeLoginProviders = Schema.decodeUnknownEffect(
  Schema.Struct({ providers: Schema.Array(LoginProviderSchema) }),
);

const decodeCatalog = Schema.decodeUnknownEffect(
  Schema.Struct({ models: Schema.Array(OmpCatalogModel) }),
);

const LogoutAccountSchema = Schema.Struct({
  credentialId: Schema.Int,
  provider: Schema.String,
  label: Schema.String,
  detail: Schema.String,
  type: Schema.Literals(["api_key", "oauth"]),
  active: Schema.Boolean,
});
export type OmpLogoutAccount = typeof LogoutAccountSchema.Type;
const decodeLogoutAccounts = Schema.decodeUnknownEffect(
  Schema.Struct({ accounts: Schema.Array(LogoutAccountSchema) }),
);
const decodeLogoutResult = Schema.decodeUnknownEffect(
  Schema.Struct({ remainingSource: Schema.optionalKey(Schema.String) }),
);

const ResponseFrame = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.optional(Schema.String),
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
const decodeResponseFrame = Schema.decodeUnknownOption(ResponseFrame);

const UiRequestFrame = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String,
  method: Schema.String,
});
const isUiRequestFrame = Schema.is(UiRequestFrame);

/**
 * `omp usage --json` (`cli/usage-cli.ts`). Not part of OMP's versioned CLI JSON contract, so
 * only the envelope is checked; reports keep OMP's `UsageReport` shape minus `raw`.
 */
export const OmpUsageReport = Schema.Struct({
  generatedAt: Schema.Number,
  reports: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      fetchedAt: Schema.Number,
      limits: Schema.Array(Schema.Unknown),
    }),
  ),
  accountsWithoutUsage: Schema.optional(Schema.Array(Schema.Unknown)),
  disabledCredentials: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type OmpUsageReport = typeof OmpUsageReport.Type;
const decodeUsageReport = Schema.decodeEffect(Schema.fromJsonString(OmpUsageReport));

/** `AggregatedStats` of `@oh-my-pi/omp-stats`: the totals Ompanel shows. */
const OmpStatsTotals = Schema.Struct({
  totalRequests: Schema.Number,
  failedRequests: Schema.Number,
  totalInputTokens: Schema.Number,
  totalOutputTokens: Schema.Number,
  totalCacheReadTokens: Schema.Number,
  totalCacheWriteTokens: Schema.Number,
  totalCost: Schema.Number,
  firstTimestamp: Schema.Number,
  lastTimestamp: Schema.Number,
});

/**
 * `omp stats --json` (`cli/stats-cli.ts`): `DashboardStats` of `@oh-my-pi/omp-stats`, an
 * unversioned shape, so only the fields Ompanel shows are read; the time series are dropped.
 */
export const OmpStatsReport = Schema.Struct({
  overall: OmpStatsTotals,
  byModel: Schema.Array(
    Schema.Struct({ ...OmpStatsTotals.fields, model: Schema.String, provider: Schema.String }),
  ),
});
export type OmpStatsReport = typeof OmpStatsReport.Type;
const decodeStatsReport = Schema.decodeEffect(Schema.fromJsonString(OmpStatsReport));
const decodeConfigList = Schema.decodeEffect(Schema.fromJsonString(OmpConfigList));
const decodeConfigLayerList = Schema.decodeEffect(Schema.fromJsonString(OmpConfigLayerList));
const decodeConfigSetResult = Schema.decodeEffect(Schema.fromJsonString(OmpConfigSetResult));
const decodeConfigResetResult = Schema.decodeEffect(Schema.fromJsonString(OmpConfigResetResult));
const encodeJsonValue = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** `omp skill list <dir> --json`: the CLI contract's `CliSkillList`. */
const OmpSkillList = Schema.Struct({
  skills: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      description: Schema.String,
      filePath: Schema.String,
      baseDir: Schema.String,
      source: Schema.String,
      hide: Schema.Boolean,
    }),
  ),
  warnings: Schema.Array(Schema.Struct({ skillPath: Schema.String, message: Schema.String })),
});
export type OmpSkillList = typeof OmpSkillList.Type;
const decodeSkillList = Schema.decodeEffect(Schema.fromJsonString(OmpSkillList));

/**
 * The fields of the wire contract's `AvailableSlashCommand` Ompanel shows. `source` stays a
 * string, so a source a newer omp adds does not fail the whole list.
 */
const AvailableSlashCommandSchema = Schema.Struct({
  name: Schema.String,
  source: Schema.String,
  aliases: Schema.optionalKey(Schema.Array(Schema.String)),
  description: Schema.optionalKey(Schema.String),
  input: Schema.optionalKey(Schema.Struct({ hint: Schema.optionalKey(Schema.String) })),
});
export type OmpAvailableSlashCommand = typeof AvailableSlashCommandSchema.Type;
const decodeAvailableCommands = Schema.decodeUnknownEffect(
  Schema.Struct({ commands: Schema.Array(AvailableSlashCommandSchema) }),
);

/** The two fields of a `get_available_models` entry the `models.yml` check reads. */
const ListedModelSchema = Schema.Struct({ provider: Schema.String, id: Schema.String });
export type OmpListedModel = typeof ListedModelSchema.Type;
const decodeListedModels = Schema.decodeUnknownEffect(
  Schema.Struct({ models: Schema.Array(ListedModelSchema) }),
);

/** `omp agents unpack --json` (`cli/agents-cli.ts` `UnpackResult`): absolute paths. */
const OmpAgentsUnpack = Schema.Struct({
  targetDir: Schema.String,
  total: Schema.Number,
  written: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.String),
});
export type OmpAgentsUnpack = typeof OmpAgentsUnpack.Type;
const decodeAgentsUnpack = Schema.decodeEffect(Schema.fromJsonString(OmpAgentsUnpack));

/**
 * `omp plugin list --json` (`cli/plugin-cli.ts` `handleList`): npm plugins as `InstalledPlugin`,
 * marketplace plugins as `InstalledPluginSummary`. Only the fields Ompanel shows are read.
 */
export const OmpPluginListReport = Schema.Struct({
  npm: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      version: Schema.String,
      enabled: Schema.Boolean,
      manifest: Schema.Struct({ description: Schema.optionalKey(Schema.String) }),
    }),
  ),
  marketplace: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      scope: Schema.Literals(["user", "project"]),
      entries: Schema.Array(
        Schema.Struct({ version: Schema.String, enabled: Schema.optionalKey(Schema.Boolean) }),
      ),
      shadowedBy: Schema.optionalKey(Schema.Literal("project")),
    }),
  ),
});
export type OmpPluginListReport = typeof OmpPluginListReport.Type;
const decodePluginList = Schema.decodeEffect(Schema.fromJsonString(OmpPluginListReport));

const textLines = (stdout: string): ReadonlyArray<string> =>
  OmpAnsi.strip(stdout).replaceAll("\r", "").split("\n");

/**
 * `omp plugin marketplace list` has no `--json` in the pinned omp: after a heading it prints
 * `  <name>  <source>` per marketplace, or `No marketplaces configured`.
 */
export const parseOmpMarketplaceList = (stdout: string): ReadonlyArray<OmpMarketplace> =>
  textLines(stdout).flatMap((line) => {
    const match = /^ {2}(\S+) {2}(\S.*)$/.exec(line);
    return match === null ? [] : [{ name: match[1]!, source: match[2]!.trim() }];
  });

/**
 * `omp plugin discover <marketplace>` has no `--json` either: `  <name>[@<version>]` per plugin,
 * its description on the next line indented by four.
 */
export const parseOmpMarketplaceDiscover = (
  stdout: string,
): ReadonlyArray<OmpMarketplacePlugin> => {
  const plugins: Array<OmpMarketplacePlugin> = [];
  for (const line of textLines(stdout)) {
    const description = /^ {4}(\S.*)$/.exec(line);
    if (description !== null) {
      const last = plugins.at(-1);
      if (last !== undefined && last.description === undefined) {
        plugins[plugins.length - 1] = { ...last, description: description[1]!.trim() };
      }
      continue;
    }
    const entry = /^ {2}(\S+)$/.exec(line);
    if (entry === null) continue;
    const spec = entry[1]!;
    const at = spec.lastIndexOf("@");
    plugins.push(
      at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : { name: spec },
    );
  }
  return plugins;
};

/** `omp update --check` prints text only (`cli/update-cli.ts` `runUpdateCommand`). */
export const parseOmpUpdateCheck = (stdout: string): OmpUpdateCheck => {
  const text = textLines(stdout).join("\n");
  const currentVersion = /Current version: (\S+)/.exec(text)?.[1] ?? null;
  const offered = /New version available: (\S+)/.exec(text)?.[1] ?? null;
  if (/is installed and kept up to date by /.test(text)) {
    return { status: "managed", currentVersion, latestVersion: null };
  }
  if (offered !== null) return { status: "available", currentVersion, latestVersion: offered };
  if (/Already up to date/.test(text)) {
    return { status: "current", currentVersion, latestVersion: currentVersion };
  }
  return { status: "unknown", currentVersion, latestVersion: null };
};

export type OmpProbeFailure =
  | { readonly stage: "version"; readonly reason: "missing" | "spawn" | "timeout" | "exit" }
  | {
      readonly stage: "ready";
      readonly reason: "spawn" | "timeout" | "exit" | "invalid" | "unconfigured";
    };

export type OmpProbeResult =
  | {
      readonly status: "ready";
      readonly version: string | null;
      readonly ready: Pick<ReadyEvent, "protocolVersion" | "contractVersion">;
      /** Login providers and whether each is signed in; `null` when OMP refused the request. */
      readonly loginProviders: ReadonlyArray<OmpLoginProvider> | null;
      /** `get_available_models`; `null` when OMP refused or sent an unreadable list. */
      readonly models: ReadonlyArray<OmpCatalogModel> | null;
    }
  | ({ readonly status: "failed"; readonly version: string | null } & OmpProbeFailure);

/** The login providers and the contract of the omp that listed them. */
export interface OmpLoginProviderList {
  readonly contractVersion: string | undefined;
  readonly providers: ReadonlyArray<OmpLoginProvider>;
}

export interface OmpLoginOptions {
  /**
   * Answer to the flow's first prompt (an API key), written into the `login` command on the
   * process's stdin. Needs {@link OMP_LOGIN_INPUT_CONTRACT}.
   */
  readonly input?: Redacted.Redacted<string>;
  /** The handler masks `input` requests marked `secret`. Needs {@link OMP_LOGIN_INPUT_CONTRACT}. */
  readonly secretInput?: boolean;
}

/** Answers one extension UI request of a login session; `undefined` sends nothing. */
export type OmpLoginUiHandler = (
  request: ExtensionUiRequest,
) => Effect.Effect<ExtensionUiResponse | undefined>;

export interface OmpControlService {
  /** `omp --version` (4 s). The version string, or `null` when it prints none. */
  readonly version: (target: OmpControlTarget) => Effect.Effect<string | null, OmpControlError>;
  /** `omp usage --json` (10 s), cached 30 s. */
  readonly usage: (
    target: OmpControlTarget,
    options?: { readonly provider?: string },
  ) => Effect.Effect<OmpUsageReport, OmpControlError>;
  /**
   * `omp stats --json` (60 s), cached 30 s: totals over the rolling last 24 hours, OMP's default
   * range; the pinned CLI has no range flag.
   */
  readonly stats: (target: OmpControlTarget) => Effect.Effect<OmpStatsReport, OmpControlError>;
  /** RPC `get_login_providers` in a fresh server (20 s), uncached. */
  readonly loginProviders: (
    target: OmpControlTarget,
  ) => Effect.Effect<OmpLoginProviderList, OmpControlError>;
  /**
   * RPC `login` (60 s). The server asks the host to open the authorization URL and may ask for
   * a pasted code or a key; `onUiRequest` answers those. `options` need contract
   * {@link OMP_LOGIN_INPUT_CONTRACT}; an older omp fails `unsupported` before anything is sent.
   * Success drops this instance's cache.
   */
  readonly login: (
    target: OmpControlTarget,
    providerId: string,
    onUiRequest: OmpLoginUiHandler,
    options?: OmpLoginOptions,
  ) => Effect.Effect<void, OmpControlError>;
  /** RPC `get_logout_accounts` (20 s): the stored credentials sign-out can remove. */
  readonly logoutAccounts: (
    target: OmpControlTarget,
    providerId: string,
  ) => Effect.Effect<ReadonlyArray<OmpLogoutAccount>, OmpControlError>;
  /** RPC `logout` (20 s); drops this instance's cache. `remainingSource` names auth that still applies. */
  readonly logout: (
    target: OmpControlTarget,
    providerId: string,
    credentialId: number,
  ) => Effect.Effect<{ readonly remainingSource?: string }, OmpControlError>;
  /**
   * Status probe: `--version`, then `ready`, `get_login_providers` and `get_available_models`.
   * Cached 30 s, except an `unconfigured` result: `omp setup` in a terminal ends that state outside
   * Ompanel, and the next check has to see it.
   */
  readonly probe: (target: OmpControlTarget) => Effect.Effect<OmpProbeResult>;
  /** Drops every cached result of this instance. */
  readonly invalidate: Effect.Effect<void>;
  /** `omp config list --json --cwd <target.cwd>` (10 s), uncached: every field with its source layer. */
  readonly configList: (target: OmpControlTarget) => Effect.Effect<OmpConfigList, OmpControlError>;
  /**
   * `omp config list --scope <scope> --json --cwd <target.cwd>` (10 s), uncached: only the keys
   * that layer sets, as written. An OMP before CLI contract 1.1.0 refuses `--scope` here and
   * fails `exit`.
   */
  readonly configLayer: (
    target: OmpControlTarget,
    scope: OmpConfigScope,
  ) => Effect.Effect<OmpConfigLayerList, OmpControlError>;
  /**
   * `omp config set --scope <scope> --cwd <target.cwd> --json -- <key> <JSON value>` (10 s).
   * There is deliberately no `config get`: it prints credentials unmasked.
   */
  readonly configSet: (
    target: OmpControlTarget,
    input: { readonly key: string; readonly value: unknown; readonly scope: OmpConfigScope },
  ) => Effect.Effect<OmpConfigSetResult, OmpControlError>;
  /** `omp config reset --scope <scope> --cwd <target.cwd> --json -- <key>` (10 s). */
  readonly configReset: (
    target: OmpControlTarget,
    input: { readonly key: string; readonly scope: OmpConfigScope },
  ) => Effect.Effect<OmpConfigResetResult, OmpControlError>;
  /**
   * `omp [--profile p] config path` (10 s): the agent directory of the target's profile and
   * environment (`PI_CODING_AGENT_DIR`, `OMP_PROFILE`), the one line it prints.
   */
  readonly configPath: (target: OmpControlTarget) => Effect.Effect<string, OmpControlError>;
  /**
   * `omp [--profile p] skill list <target.cwd> --json` (10 s), uncached: the skills a session in
   * that directory would load, as `omp skill list` resolves them.
   */
  readonly skillList: (target: OmpControlTarget) => Effect.Effect<OmpSkillList, OmpControlError>;
  /**
   * RPC `get_available_commands` in a fresh control server in `target.cwd` (10 s), uncached.
   * The control server runs without extensions, skills, tools or MCP, so the list holds OMP's
   * builtins and the directory's file commands only; a thread's own server reports the rest.
   */
  readonly availableCommands: (
    target: OmpControlTarget,
  ) => Effect.Effect<ReadonlyArray<OmpAvailableSlashCommand>, OmpControlError>;
  /**
   * RPC `get_available_models` in a fresh control server in `target.cwd` (20 s, as the probe's),
   * uncached: the models a session there may pick, after the directory's project config and
   * path-scoped `enabledModels` / `disabledProviders`. A directory whose scope matches no model
   * lists none.
   */
  readonly availableModels: (
    target: OmpControlTarget,
  ) => Effect.Effect<ReadonlyArray<OmpCatalogModel>, OmpControlError>;
  /**
   * RPC `get_available_models` (15 s) from a fresh control server whose agent directory is
   * `agentDir` (`PI_CODING_AGENT_DIR`; the profile is dropped, since a profile outranks it), run
   * with `--approval-mode always-ask`. Fails `exit` when omp quits before `ready`, as it does when
   * it finds no model at all.
   */
  readonly modelsInAgentDir: (
    target: OmpControlTarget,
    agentDir: string,
  ) => Effect.Effect<ReadonlyArray<OmpListedModel>, OmpControlError>;
  /** `omp [--profile p] agents unpack --user --json` (10 s): never overwrites an existing file. */
  readonly agentsUnpack: (
    target: OmpControlTarget,
  ) => Effect.Effect<OmpAgentsUnpack, OmpControlError>;
  /** `omp [--profile p] plugin list --json` (15 s), uncached. */
  readonly pluginList: (
    target: OmpControlTarget,
  ) => Effect.Effect<OmpPluginListReport, OmpControlError>;
  /** `omp [--profile p] plugin marketplace list` (15 s), uncached. */
  readonly marketplaceList: (
    target: OmpControlTarget,
  ) => Effect.Effect<ReadonlyArray<OmpMarketplace>, OmpControlError>;
  /** `omp [--profile p] plugin discover <marketplace>` (15 s), uncached. */
  readonly marketplaceDiscover: (
    target: OmpControlTarget,
    marketplace: string,
  ) => Effect.Effect<ReadonlyArray<OmpMarketplacePlugin>, OmpControlError>;
  /**
   * `omp [--profile p] <args>` (180 s) for one `omp plugin` command that changes something;
   * succeeds on exit 0. Drops this instance's cache.
   */
  readonly pluginCommand: (
    target: OmpControlTarget,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, OmpControlError>;
  /** `omp [--profile p] update --check` (20 s): reports, never installs. */
  readonly updateCheck: (
    target: OmpControlTarget,
  ) => Effect.Effect<OmpUpdateCheck, OmpControlError>;
  /**
   * `omp [--profile p] --export <sessionFile> <outputPath>` (60 s): the session file as one
   * self-contained HTML page, as RPC `export_html` renders a running session.
   */
  readonly exportHtml: (
    target: OmpControlTarget,
    input: { readonly sessionFile: string; readonly outputPath: string },
  ) => Effect.Effect<void, OmpControlError>;
  /**
   * `gh auth status` in the target's environment (10 s): whether `omp share --gist` can create a
   * gist there. OMP falls back to its share server when it cannot, so this runs first.
   */
  readonly gistReady: (
    target: OmpControlTarget,
  ) => Effect.Effect<"ready" | "missing" | "signed_out">;
  /** `omp [--profile p] share <sessionFile> --gist` (120 s): uploads, so never retried. */
  readonly shareGist: (
    target: OmpControlTarget,
    sessionFile: string,
  ) => Effect.Effect<OmpShareReport, OmpControlError>;
}

/** What `omp share` printed: the viewer link, the gist behind it, and whether it trimmed. */
export interface OmpShareReport {
  readonly url: string;
  /** Null when OMP could not create the gist and used its share server. */
  readonly gistUrl: string | null;
  readonly truncated: boolean;
}

/** Parses `omp share`'s `Share URL:` / `Gist:` / `Note:` lines; null without a share URL. */
export const parseOmpShareOutput = (stdout: string): OmpShareReport | null => {
  const value = (label: string) =>
    stdout
      .split("\n")
      .find((line) => line.startsWith(`${label}: `))
      ?.slice(label.length + 2)
      .trim();
  const url = value("Share URL");
  if (url === undefined || url === "") return null;
  return {
    url,
    gistUrl: value("Gist") || null,
    truncated: stdout.includes("Note: large content was trimmed"),
  };
};

export interface OmpControlServiceOptions {
  readonly timeoutsMs?: Partial<Record<OmpControlBudget, number>>;
  readonly killGraceMs?: number;
  readonly cacheTtlMs?: number;
}

const profileArgs = (profile: string): ReadonlyArray<string> =>
  profile === "" ? [] : ["--profile", profile];

/** Environment variables that pick an agent directory other than `PI_CODING_AGENT_DIR`. */
const AGENT_DIR_OVERRIDES = ["OMP_PROFILE", "PI_PROFILE", "PI_CODING_AGENT_DIR", "PI_CONFIG_FILES"];

/** `environment` with `agentDir` as the agent directory and nothing that would outrank it. */
const agentDirEnvironment = (
  environment: NodeJS.ProcessEnv,
  agentDir: string,
): NodeJS.ProcessEnv => {
  const next: NodeJS.ProcessEnv = { ...environment };
  for (const key of AGENT_DIR_OVERRIDES) delete next[key];
  next["PI_CODING_AGENT_DIR"] = agentDir;
  return next;
};

interface RpcSession {
  readonly ready: typeof ReadyFrame.Type;
  /** Sends one command and returns its response data; other frames go to `onFrame`. */
  readonly request: (
    command: { readonly type: string } & Record<string, unknown>,
    onFrame?: (frame: unknown) => Effect.Effect<void, OmpControlError>,
  ) => Effect.Effect<unknown, OmpControlError>;
  readonly send: (frame: unknown) => Effect.Effect<void>;
}

const encoder = new TextEncoder();

/**
 * Builds one instance's control service. Results are cached per service, so each provider
 * instance gets its own cache; cached work runs in the service scope, so a caller that gives up
 * never strands the callers sharing that result.
 */
export const makeOmpControlService = Effect.fn("makeOmpControlService")(function* (
  options: OmpControlServiceOptions = {},
): Effect.fn.Return<
  OmpControlService,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const timeouts = { ...OMP_CONTROL_TIMEOUTS_MS, ...options.timeoutsMs };
  const killGraceMs = options.killGraceMs ?? OMP_CONTROL_KILL_GRACE_MS;
  const cacheTtlMs = options.cacheTtlMs ?? OMP_CONTROL_CACHE_TTL_MS;

  // The control overlay is written once per service, into an owner-only temp directory the
  // service scope removes. A failed write fails every control session instead of running one
  // that would start the project's MCP servers.
  const overlay = yield* Effect.acquireRelease(
    Effect.try(() => {
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ompanel-omp-control-"));
      const file = NodePath.join(dir, "control-overlay.yml");
      try {
        NodeFS.writeFileSync(file, OMP_CONTROL_OVERLAY, { mode: 0o600 });
      } catch (cause) {
        NodeFS.rmSync(dir, { recursive: true, force: true });
        throw cause;
      }
      return file;
    }).pipe(Effect.result),
    (written) =>
      Result.isSuccess(written)
        ? Effect.sync(() =>
            NodeFS.rmSync(NodePath.dirname(written.success), { recursive: true, force: true }),
          )
        : Effect.void,
  );

  const command = (
    target: OmpControlTarget,
    args: ReadonlyArray<string>,
    stdin: ChildProcess.CommandInput,
  ) =>
    ChildProcess.make(target.binaryPath, [...args], {
      cwd: target.cwd,
      env: target.environment,
      extendEnv: false,
      stdin,
      forceKillAfter: killGraceMs,
    });

  /** Runs `use` under the budget's deadline; the deadline closes the scope, which stops the process group. */
  const withDeadline = <A, E, R>(
    operation: OmpControlOperation,
    budget: OmpControlBudget,
    use: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | OmpControlError, Exclude<R, Scope.Scope>> =>
    Effect.scoped(use).pipe(
      Effect.timeoutOption(timeouts[budget]),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new OmpControlError({ operation, reason: "timeout", timeoutMs: timeouts[budget] }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const collect = (
    operation: OmpControlOperation,
    budget: OmpControlBudget,
    target: OmpControlTarget,
    args: ReadonlyArray<string>,
  ) =>
    withDeadline(
      operation,
      budget,
      spawnAndCollect(target.binaryPath, command(target, args, "ignore")).pipe(
        Effect.mapError(
          (cause) =>
            new OmpControlError({
              operation,
              reason: isCommandMissingCause(cause) ? "missing" : "spawn",
              cause,
            }),
        ),
      ),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  const version = Effect.fn("OmpControl.version")(function* (target: OmpControlTarget) {
    // The version belongs to the binary, not the profile.
    const output = yield* collect("version", "version", target, ["--version"]);
    if (output.code !== 0) {
      return yield* new OmpControlError({
        operation: "version",
        reason: "exit",
        exitCode: output.code,
      });
    }
    return parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  });

  const usageUncached = Effect.fn("OmpControl.usage")(function* (
    target: OmpControlTarget,
    provider: string | undefined,
  ) {
    const output = yield* collect("usage", "usage", target, [
      ...profileArgs(target.profile),
      "usage",
      "--json",
      ...(provider === undefined ? [] : ["--provider", provider]),
    ]);
    if (output.code !== 0) {
      return yield* new OmpControlError({
        operation: "usage",
        reason: "exit",
        exitCode: output.code,
      });
    }
    return yield* decodeUsageReport(output.stdout.trim()).pipe(
      Effect.mapError(
        (cause) => new OmpControlError({ operation: "usage", reason: "invalid", cause }),
      ),
    );
  });

  const statsUncached = Effect.fn("OmpControl.stats")(function* (target: OmpControlTarget) {
    // stderr carries sync progress; stdout is the JSON report alone.
    const output = yield* collect("stats", "stats", target, [
      ...profileArgs(target.profile),
      "stats",
      "--json",
    ]);
    if (output.code !== 0) {
      return yield* new OmpControlError({
        operation: "stats",
        reason: "exit",
        exitCode: output.code,
      });
    }
    return yield* decodeStatsReport(output.stdout.trim()).pipe(
      Effect.mapError(
        (cause) => new OmpControlError({ operation: "stats", reason: "invalid", cause }),
      ),
    );
  });

  /** Runs `omp [--profile p] config <args>` and decodes its JSON stdout. */
  const runConfig = <A>(
    operation: "config_list" | "config_layer" | "config_set" | "config_reset",
    target: OmpControlTarget,
    args: ReadonlyArray<string>,
    decode: (stdout: string) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    collect(operation, "config", target, [...profileArgs(target.profile), "config", ...args]).pipe(
      Effect.flatMap((output) =>
        output.code === 0
          ? decode(output.stdout.trim()).pipe(
              Effect.mapError(
                (cause) => new OmpControlError({ operation, reason: "invalid", cause }),
              ),
            )
          : Effect.fail(new OmpControlError({ operation, reason: "exit", exitCode: output.code })),
      ),
    );

  const configLayer = Effect.fn("OmpControl.configLayer")(function* (
    target: OmpControlTarget,
    scope: OmpConfigScope,
  ) {
    return yield* runConfig(
      "config_layer",
      target,
      ["list", "--scope", scope, "--json", "--cwd", target.cwd],
      decodeConfigLayerList,
    );
  });

  const configList = Effect.fn("OmpControl.configList")(function* (target: OmpControlTarget) {
    return yield* runConfig(
      "config_list",
      target,
      ["list", "--json", "--cwd", target.cwd],
      decodeConfigList,
    );
  });

  const configSet = Effect.fn("OmpControl.configSet")(function* (
    target: OmpControlTarget,
    input: { readonly key: string; readonly value: unknown; readonly scope: OmpConfigScope },
  ) {
    // OMP parses the text by the key's type and accepts JSON for every type; `--` keeps a negative
    // number from reading as a flag. Values arrive decoded from JSON, so they always encode.
    const valueText = yield* encodeJsonValue(input.value).pipe(Effect.orDie);
    return yield* runConfig(
      "config_set",
      target,
      ["set", "--scope", input.scope, "--cwd", target.cwd, "--json", "--", input.key, valueText],
      decodeConfigSetResult,
    );
  });

  const configReset = Effect.fn("OmpControl.configReset")(function* (
    target: OmpControlTarget,
    input: { readonly key: string; readonly scope: OmpConfigScope },
  ) {
    return yield* runConfig(
      "config_reset",
      target,
      ["reset", "--scope", input.scope, "--cwd", target.cwd, "--json", "--", input.key],
      decodeConfigResetResult,
    );
  });

  const configPath = Effect.fn("OmpControl.configPath")(function* (target: OmpControlTarget) {
    const output = yield* collect("config_path", "config", target, [
      ...profileArgs(target.profile),
      "config",
      "path",
    ]);
    if (output.code !== 0) {
      return yield* new OmpControlError({
        operation: "config_path",
        reason: "exit",
        exitCode: output.code,
      });
    }
    // One line, the directory; extra lines are not trusted. The caller checks it is absolute.
    const dir = output.stdout.trim();
    if (dir === "" || dir.includes("\n")) {
      return yield* new OmpControlError({ operation: "config_path", reason: "invalid" });
    }
    return dir;
  });

  /** Starts `omp --mode rpc`, waits for `ready`, and hands the session to `use`. */
  const openRpcSession = Effect.fn("OmpControl.openRpcSession")(function* (
    operation: OmpControlOperation,
    target: OmpControlTarget,
    extraArgs: ReadonlyArray<string> = [],
  ): Effect.fn.Return<RpcSession, OmpControlError, Scope.Scope> {
    const sessionScope = yield* Effect.scope;
    if (Result.isFailure(overlay)) {
      return yield* new OmpControlError({ operation, reason: "spawn", cause: overlay.failure });
    }
    // A temp cleaner may have removed the file under a long-lived server, and OMP rejects a
    // missing `--config` file: put it back before every spawn.
    yield* Effect.try({
      try: () => {
        if (NodeFS.existsSync(overlay.success)) return;
        NodeFS.mkdirSync(NodePath.dirname(overlay.success), { recursive: true, mode: 0o700 });
        NodeFS.writeFileSync(overlay.success, OMP_CONTROL_OVERLAY, { mode: 0o600 });
      },
      catch: (cause) => new OmpControlError({ operation, reason: "spawn", cause }),
    });
    const outgoing = yield* Queue.unbounded<Uint8Array>();
    const child = yield* spawner
      .spawn(
        command(
          target,
          [
            ...profileArgs(target.profile),
            ...OMP_CONTROL_RPC_ARGS,
            "--config",
            overlay.success,
            ...extraArgs,
            ...(target.launchArgs ?? []),
          ],
          Stream.fromQueue(outgoing),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new OmpControlError({
              operation,
              reason: isCommandMissingCause(cause) ? "missing" : "spawn",
              cause,
            }),
        ),
      );

    // stderr is drained so a chatty omp cannot block on a full pipe. Its text is never kept: it
    // is only checked for OMP's "no model" refusal, settled once stderr closes.
    const unconfigured = yield* Deferred.make<boolean>();
    yield* child.stderr.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runFold(
        () => false,
        (seen: boolean, line: string) => seen || OMP_UNCONFIGURED_STDERR.test(line),
      ),
      Effect.orElseSucceed(() => false),
      Effect.flatMap((seen) => Deferred.succeed(unconfigured, seen)),
      Effect.forkIn(sessionScope),
    );
    const frames = yield* Queue.unbounded<unknown, OmpControlError>();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        if (line.trim().length === 0) return Effect.void;
        try {
          return Queue.offer(frames, JSON.parse(line) as unknown);
        } catch {
          // OMP writes only JSON frames; drop stray text rather than guess.
          return Effect.void;
        }
      }),
      Effect.matchEffect({
        onFailure: (cause) =>
          Queue.fail(frames, new OmpControlError({ operation, reason: "exit", cause })),
        onSuccess: () =>
          Effect.all([
            child.exitCode.pipe(Effect.map(Number), Effect.option),
            Deferred.await(unconfigured),
          ]).pipe(
            Effect.flatMap(([code, noModel]) =>
              Queue.fail(
                frames,
                new OmpControlError({
                  operation,
                  reason: noModel ? "unconfigured" : "exit",
                  ...(Option.isSome(code) ? { exitCode: code.value } : {}),
                }),
              ),
            ),
          ),
      }),
      Effect.forkIn(sessionScope),
    );

    const first = yield* Queue.take(frames);
    const ready = yield* decodeReadyFrame(first).pipe(
      Effect.mapError((cause) => new OmpControlError({ operation, reason: "invalid", cause })),
    );

    const send = (frame: unknown) =>
      Queue.offer(outgoing, encoder.encode(`${JSON.stringify(frame)}\n`)).pipe(Effect.asVoid);

    let nextId = 0;
    const request: RpcSession["request"] = Effect.fnUntraced(function* (body, onFrame) {
      const id = `ompanel-control-${nextId++}`;
      yield* send({ ...body, id });
      while (true) {
        const frame = yield* Queue.take(frames);
        const response = decodeResponseFrame(frame);
        if (Option.isSome(response) && response.value.id === id) {
          if (response.value.success) return response.value.data;
          return yield* new OmpControlError({
            operation,
            reason: "rejected",
            ...(response.value.error === undefined ? {} : { detail: response.value.error }),
          });
        }
        if (onFrame !== undefined) yield* onFrame(frame);
      }
    });

    return { ready, request, send };
  });

  /**
   * {@link openRpcSession} for control servers that need no model of their own (sign-in, sign-out,
   * provider and command lists): when OMP refuses to start for want of one, it is started again on
   * {@link OMP_SETUP_PLACEHOLDER_MODEL}, so a fresh install can still sign in.
   */
  const openControlRpcSession = (operation: OmpControlOperation, target: OmpControlTarget) =>
    openRpcSession(operation, target).pipe(
      Effect.catchIf(
        (error) => error.reason === "unconfigured",
        () => openRpcSession(operation, target, ["--model", OMP_SETUP_PLACEHOLDER_MODEL]),
      ),
    );

  const readLoginProviders = (operation: OmpControlOperation, session: RpcSession) =>
    session.request({ type: "get_login_providers" }).pipe(
      Effect.flatMap(decodeLoginProviders),
      Effect.map((data) => data.providers),
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(new OmpControlError({ operation, reason: "invalid", cause })),
      }),
    );

  const loginProviders = Effect.fn("OmpControl.loginProviders")(function* (
    target: OmpControlTarget,
  ) {
    return yield* withDeadline(
      "login_providers",
      "ready",
      openControlRpcSession("login_providers", target).pipe(
        Effect.flatMap((session) =>
          readLoginProviders("login_providers", session).pipe(
            Effect.map((providers): OmpLoginProviderList => ({
              contractVersion: session.ready.contractVersion,
              providers,
            })),
          ),
        ),
      ),
    );
  });

  const probeUncached = Effect.fn("OmpControl.probe")(function* (
    target: OmpControlTarget,
  ): Effect.fn.Return<OmpProbeResult> {
    const versionResult = yield* version(target).pipe(Effect.result);
    if (versionResult._tag === "Failure") {
      const failure = versionResult.failure;
      return {
        status: "failed",
        version: null,
        stage: "version",
        reason:
          failure.reason === "missing" || failure.reason === "timeout" || failure.reason === "exit"
            ? failure.reason
            : "spawn",
      };
    }
    const parsedVersion = versionResult.success;
    const rpcResult = yield* withDeadline(
      "rpc",
      "ready",
      Effect.gen(function* () {
        const session = yield* openRpcSession("rpc", target);
        const providers = yield* readLoginProviders("rpc", session).pipe(
          Effect.map((list): ReadonlyArray<OmpLoginProvider> | null => list),
          // A refused or unreadable list leaves auth unknown; the server itself is fine.
          Effect.catchIf(
            (error) => error.reason === "rejected" || error.reason === "invalid",
            () => Effect.succeed(null),
          ),
        );
        const models = yield* session.request({ type: "get_available_models" }).pipe(
          Effect.flatMap(decodeCatalog),
          Effect.map((data): ReadonlyArray<OmpCatalogModel> | null => data.models),
          Effect.catchTags({ SchemaError: () => Effect.succeed(null) }),
          // The composer then offers OMP's default model only.
          Effect.catchIf(
            (error) => error.reason === "rejected",
            () => Effect.succeed(null),
          ),
        );
        return { ready: session.ready, providers, models };
      }),
    ).pipe(Effect.result);
    if (rpcResult._tag === "Failure") {
      const { reason } = rpcResult.failure;
      return {
        status: "failed",
        version: parsedVersion,
        stage: "ready",
        reason:
          reason === "timeout" ||
          reason === "exit" ||
          reason === "invalid" ||
          reason === "unconfigured"
            ? reason
            : "spawn",
      };
    }
    const { protocolVersion, contractVersion } = rpcResult.success.ready;
    return {
      status: "ready",
      version: parsedVersion,
      ready: {
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        ...(contractVersion === undefined ? {} : { contractVersion }),
      },
      loginProviders: rpcResult.success.providers,
      models: rpcResult.success.models,
    };
  });

  const login = Effect.fn("OmpControl.login")(function* (
    target: OmpControlTarget,
    providerId: string,
    onUiRequest: OmpLoginUiHandler,
    options: OmpLoginOptions = {},
  ) {
    const input = options.input === undefined ? undefined : Redacted.value(options.input);
    yield* withDeadline(
      "login",
      "login",
      Effect.gen(function* () {
        const session = yield* openControlRpcSession("login", target);
        const supported = ompContractAtLeast(
          session.ready.contractVersion,
          OMP_LOGIN_INPUT_CONTRACT,
        );
        // An older omp would ignore `input` and ask for the key unmasked: refuse before sending.
        if (input !== undefined && !supported) {
          return yield* new OmpControlError({
            operation: "login",
            reason: "unsupported",
            detail: `API-key sign-in needs RPC contract ${OMP_LOGIN_INPUT_CONTRACT}; this OMP reports ${session.ready.contractVersion ?? "none"}`,
          });
        }
        yield* session
          .request(
            {
              type: "login",
              providerId,
              // The key travels only here: inside the command on the process's stdin.
              ...(input === undefined ? {} : { input }),
              // Older servers never send secret prompts; they fail the login instead.
              ...(options.secretInput === true && supported ? { secretInput: true } : {}),
            },
            (frame) => {
              if (!isUiRequestFrame(frame)) return Effect.void;
              return onUiRequest(frame as ExtensionUiRequest).pipe(
                Effect.flatMap((response) =>
                  response === undefined ? Effect.void : session.send(response),
                ),
              );
            },
          )
          .pipe(
            // OMP's failure text could quote what it was given; never pass the key on.
            Effect.mapError((error) =>
              input !== undefined && input !== "" && error.detail?.includes(input) === true
                ? new OmpControlError({
                    operation: error.operation,
                    reason: error.reason,
                    detail: error.detail.replaceAll(input, "[redacted]"),
                  })
                : error,
            ),
          );
      }),
    );
    yield* invalidate;
  });

  /** One RPC command in a fresh server under the 20 s `ready` budget. */
  const rpcCommand = <A>(
    operation: "logout_accounts" | "logout",
    target: OmpControlTarget,
    command: { readonly type: string } & Record<string, unknown>,
    decode: (data: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    withDeadline(
      operation,
      "ready",
      openControlRpcSession(operation, target).pipe(
        Effect.flatMap((session) => session.request(command)),
        Effect.flatMap((data) =>
          decode(data).pipe(
            Effect.mapError(
              (cause) => new OmpControlError({ operation, reason: "invalid", cause }),
            ),
          ),
        ),
      ),
    );

  const logoutAccounts = Effect.fn("OmpControl.logoutAccounts")(function* (
    target: OmpControlTarget,
    providerId: string,
  ) {
    const data = yield* rpcCommand(
      "logout_accounts",
      target,
      { type: "get_logout_accounts", providerId },
      decodeLogoutAccounts,
    );
    return data.accounts;
  });

  const logout = Effect.fn("OmpControl.logout")(function* (
    target: OmpControlTarget,
    providerId: string,
    credentialId: number,
  ) {
    const result = yield* rpcCommand(
      "logout",
      target,
      { type: "logout", providerId, credentialId },
      decodeLogoutResult,
    );
    yield* invalidate;
    return result;
  });

  const skillList = Effect.fn("OmpControl.skillList")(function* (target: OmpControlTarget) {
    const output = yield* collect("skill_list", "catalog", target, [
      ...profileArgs(target.profile),
      "skill",
      "list",
      target.cwd,
      "--json",
    ]);
    if (output.code !== 0) {
      return yield* new OmpControlError({
        operation: "skill_list",
        reason: "exit",
        exitCode: output.code,
      });
    }
    return yield* decodeSkillList(output.stdout.trim()).pipe(
      Effect.mapError(
        (cause) => new OmpControlError({ operation: "skill_list", reason: "invalid", cause }),
      ),
    );
  });

  const availableCommands = Effect.fn("OmpControl.availableCommands")(function* (
    target: OmpControlTarget,
  ) {
    const data = yield* withDeadline(
      "available_commands",
      "catalog",
      openControlRpcSession("available_commands", target).pipe(
        Effect.flatMap((session) => session.request({ type: "get_available_commands" })),
        Effect.flatMap((response) =>
          decodeAvailableCommands(response).pipe(
            Effect.mapError(
              (cause) =>
                new OmpControlError({ operation: "available_commands", reason: "invalid", cause }),
            ),
          ),
        ),
      ),
    );
    return data.commands;
  });

  const availableModels = Effect.fn("OmpControl.availableModels")(function* (
    target: OmpControlTarget,
  ) {
    const data = yield* withDeadline(
      "available_models",
      "ready",
      // A scope that matches no model stops OMP before `ready`; the placeholder start lists none.
      openControlRpcSession("available_models", target).pipe(
        Effect.flatMap((session) => session.request({ type: "get_available_models" })),
        Effect.flatMap((response) =>
          decodeCatalog(response).pipe(
            Effect.mapError(
              (cause) =>
                new OmpControlError({ operation: "available_models", reason: "invalid", cause }),
            ),
          ),
        ),
      ),
    );
    return data.models;
  });

  const modelsInAgentDir = Effect.fn("OmpControl.modelsInAgentDir")(function* (
    target: OmpControlTarget,
    agentDir: string,
  ) {
    const scratch: OmpControlTarget = {
      ...target,
      profile: "",
      environment: agentDirEnvironment(target.environment, agentDir),
    };
    const data = yield* withDeadline(
      "models_check",
      "modelsCheck",
      // OMP's own default is `yolo` (O-9): no omp starts without an explicit approval mode, even
      // one with its tools off.
      openRpcSession("models_check", scratch, ["--approval-mode", "always-ask"]).pipe(
        Effect.flatMap((session) => session.request({ type: "get_available_models" })),
        Effect.flatMap((response) =>
          decodeListedModels(response).pipe(
            Effect.mapError(
              (cause) =>
                new OmpControlError({ operation: "models_check", reason: "invalid", cause }),
            ),
          ),
        ),
      ),
    );
    return data.models;
  });

  const agentsUnpack = Effect.fn("OmpControl.agentsUnpack")(function* (target: OmpControlTarget) {
    const output = yield* collect("agents_unpack", "agents", target, [
      ...profileArgs(target.profile),
      "agents",
      "unpack",
      "--user",
      "--json",
    ]);
    if (output.code !== 0) {
      return yield* new OmpControlError({
        operation: "agents_unpack",
        reason: "exit",
        exitCode: output.code,
      });
    }
    return yield* decodeAgentsUnpack(output.stdout.trim()).pipe(
      Effect.mapError(
        (cause) => new OmpControlError({ operation: "agents_unpack", reason: "invalid", cause }),
      ),
    );
  });

  /** Runs `omp [--profile p] <args>` and fails `exit` unless it exits 0. */
  const runText = (
    operation: OmpControlOperation,
    budget: OmpControlBudget,
    target: OmpControlTarget,
    args: ReadonlyArray<string>,
  ) =>
    collect(operation, budget, target, [...profileArgs(target.profile), ...args]).pipe(
      Effect.flatMap((output) =>
        output.code === 0
          ? Effect.succeed(output.stdout)
          : Effect.fail(new OmpControlError({ operation, reason: "exit", exitCode: output.code })),
      ),
    );

  const pluginList = Effect.fn("OmpControl.pluginList")(function* (target: OmpControlTarget) {
    const stdout = yield* runText("plugin_list", "plugins", target, ["plugin", "list", "--json"]);
    return yield* decodePluginList(stdout.trim()).pipe(
      Effect.mapError(
        (cause) => new OmpControlError({ operation: "plugin_list", reason: "invalid", cause }),
      ),
    );
  });

  const marketplaceList = Effect.fn("OmpControl.marketplaceList")(function* (
    target: OmpControlTarget,
  ) {
    const stdout = yield* runText("marketplace_list", "plugins", target, [
      "plugin",
      "marketplace",
      "list",
    ]);
    return parseOmpMarketplaceList(stdout);
  });

  const marketplaceDiscover = Effect.fn("OmpControl.marketplaceDiscover")(function* (
    target: OmpControlTarget,
    marketplace: string,
  ) {
    const stdout = yield* runText("marketplace_discover", "plugins", target, [
      "plugin",
      "discover",
      marketplace,
    ]);
    return parseOmpMarketplaceDiscover(stdout);
  });

  const updateCheck = Effect.fn("OmpControl.updateCheck")(function* (target: OmpControlTarget) {
    const stdout = yield* runText("update_check", "update", target, ["update", "--check"]);
    return parseOmpUpdateCheck(stdout);
  });

  const exportHtml = Effect.fn("OmpControl.exportHtml")(function* (
    target: OmpControlTarget,
    input: { readonly sessionFile: string; readonly outputPath: string },
  ) {
    yield* runText("export_html", "export", target, [
      "--export",
      input.sessionFile,
      input.outputPath,
    ]);
  });

  /** A deadline, a failed spawn or a non-zero exit all mean `omp share` would not make a gist. */
  const gistReady = Effect.fn("OmpControl.gistReady")(function* (target: OmpControlTarget) {
    // Windows runs a bare `gh` from the thread's repository before PATH, so `gh` is resolved
    // here to an absolute PATH entry and a repository-local gh.exe is never started.
    const platform = yield* HostProcess.Platform;
    const resolveExecutable = yield* SpawnExecutableResolution;
    const ghPath = resolveExecutable("gh", platform, target.environment);
    if (ghPath === undefined) return "missing" as const;
    // A .cmd/.bat gh (a package-manager shim) needs the shell dispatch resolveSpawnCommand builds.
    const launch = yield* resolveSpawnCommand(ghPath, ["auth", "status"], {
      env: target.environment,
      extendEnv: false,
    });
    return yield* withDeadline(
      "gh_auth",
      "ghAuth",
      spawnAndCollect(
        ghPath,
        ChildProcess.make(launch.command, launch.args, {
          shell: launch.shell,
          cwd: target.cwd,
          env: target.environment,
          extendEnv: false,
          stdin: "ignore",
          forceKillAfter: killGraceMs,
        }),
      ),
    ).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.map((result) => (result.code === 0 ? ("ready" as const) : ("signed_out" as const))),
      Effect.catch((cause) =>
        Effect.succeed(
          isCommandMissingCause(cause) ? ("missing" as const) : ("signed_out" as const),
        ),
      ),
    );
  });

  const shareGist = Effect.fn("OmpControl.shareGist")(function* (
    target: OmpControlTarget,
    sessionFile: string,
  ) {
    const stdout = yield* runText("share_gist", "share", target, ["share", sessionFile, "--gist"]);
    const report = parseOmpShareOutput(stdout);
    if (report === null) {
      return yield* new OmpControlError({ operation: "share_gist", reason: "invalid" });
    }
    return report;
  });

  interface CacheEntry {
    readonly deferred: Deferred.Deferred<unknown, unknown>;
    settledAt: number | null;
  }
  const entries = new Map<string, CacheEntry>();

  /** Shares one run per key while it is in flight and for `cacheTtlMs` after it succeeds. */
  const cached = <A, E>(key: string, run: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      const existing = entries.get(key);
      if (
        existing !== undefined &&
        (existing.settledAt === null || now - existing.settledAt < cacheTtlMs)
      ) {
        return Deferred.await(existing.deferred as Deferred.Deferred<A, E>);
      }
      const deferred = Deferred.makeUnsafe<A, E>();
      const entry: CacheEntry = {
        deferred: deferred as Deferred.Deferred<unknown, unknown>,
        settledAt: null,
      };
      entries.set(key, entry);
      return run.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.flatMap(Clock.currentTimeMillis, (settledAt) => {
            if (Exit.isSuccess(exit)) entry.settledAt = settledAt;
            // Failures are not kept: the next caller retries.
            else if (entries.get(key) === entry) entries.delete(key);
            return Deferred.done(deferred, exit);
          }),
        ),
        Effect.forkIn(scope),
        Effect.andThen(Deferred.await(deferred)),
      );
    });

  const targetKey = (target: OmpControlTarget) =>
    [target.binaryPath, target.binaryIdentity ?? "", target.profile, target.cwd].join("\0");

  const invalidate = Effect.sync(() => entries.clear());

  return {
    version,
    usage: (target, usageOptions) =>
      cached(
        ["usage", targetKey(target), usageOptions?.provider ?? ""].join("\0"),
        usageUncached(target, usageOptions?.provider),
      ),
    stats: (target) => cached(["stats", targetKey(target)].join("\0"), statsUncached(target)),
    loginProviders,
    login,
    logoutAccounts,
    logout,
    probe: (target) =>
      cached(
        ["probe", targetKey(target)].join("\0"),
        // A failed run is not kept, so the unconfigured result travels as the failure.
        probeUncached(target).pipe(
          Effect.filterOrFail(
            (result) => result.status !== "failed" || result.reason !== "unconfigured",
            (result) => result,
          ),
        ),
      ).pipe(Effect.catch(Effect.succeed)),
    invalidate,
    configList,
    configLayer,
    configSet,
    configReset,
    configPath,
    skillList,
    availableCommands,
    availableModels,
    modelsInAgentDir,
    agentsUnpack,
    pluginList,
    marketplaceList,
    marketplaceDiscover,
    pluginCommand: Effect.fn("OmpControl.pluginCommand")(function* (target, args) {
      yield* runText("plugin_command", "pluginCommand", target, args);
      yield* invalidate;
    }),
    updateCheck,
    exportHtml,
    gistReady,
    shareGist,
  } satisfies OmpControlService;
});
