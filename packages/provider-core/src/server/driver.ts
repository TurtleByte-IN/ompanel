// Context tags are runtime singletons; drivers need multiple instances.
import type {
  ProviderConsumeResetCreditOutcome,
  AcpRegistryListSessionsResult,
  AcpRegistryListProvidersResult,
  AcpRegistryOperationError,
  AcpRegistrySetProviderInput,
  ProviderDriverKind,
  ProviderInstanceEnvironment,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderWorkspaceSnapshot,
  OmpConfigScope,
  OmpSessionSummary,
  OmpSessionsOperationError,
  OmpSettingsForm,
  OmpSettingsOperationError,
  OmpSettingsWriteResult,
  OmpThreadOverrideResult,
  OmpAccountsList,
  OmpAccountsOperationError,
  OmpSignInState,
  OmpSignOutAccounts,
  OmpSignOutResult,
  OmpAgentFile,
  OmpAgentFileRef,
  OmpAgentFilesList,
  OmpAgentFilesOperationError,
  OmpAgentsUnpackResult,
  OmpAccountUsage,
  OmpSessionUsageList,
  OmpStatsSummary,
  OmpUsageOperationError,
  OmpMarketplaceDiscover,
  OmpPluginCommand,
  OmpPluginList,
  OmpPluginsOperationError,
  OmpPluginsReloadResult,
  OmpSkillsList,
  OmpUpdateCheck,
  OmpBranchTree,
  OmpCollabAccess,
  OmpCollabStatus,
  OmpCollabStopResult,
  OmpExportHtmlResult,
  OmpProposalAction,
  OmpResolveProposalResult,
  OmpShareGistResult,
  OmpThreadMenuOperationError,
  ThreadId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
import type * as Stream from "effect/Stream";
import type * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type * as ProviderAdapter from "./ProviderAdapter.ts";
import type { ProviderAuthController } from "./auth.ts";
import type { ProviderDriverError } from "./errors.ts";
import type { ManagedServerProvider } from "./snapshot.ts";
import type { ProviderTextGeneration } from "./textGeneration.ts";
import type { ProviderUsageReader } from "./usage.ts";

export interface ProviderDriverMetadata {
  readonly displayName: string;
  /** Defaults to true; false rejects multiple instances of a global resource. */
  readonly supportsMultipleInstances?: boolean;
  readonly hasDefaultInstance?: boolean;
}

export type ProviderWorkspaceSnapshot = ServerProvider &
  Pick<ServerProviderWorkspaceSnapshot, "slashCommandsPending" | "optionDescriptors"> & {
    /** The directory's own model list, for a driver whose models depend on the directory. */
    readonly workspaceModels?: ServerProviderWorkspaceSnapshot["models"];
  };

export interface ProviderInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly continuationIdentity: ProviderContinuationIdentity;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly enabled: boolean;
  readonly snapshot: ManagedServerProvider;
  readonly snapshotForCwd?: (
    cwd: string,
  ) => Effect.Effect<ProviderWorkspaceSnapshot, ProviderDriverError>;
  readonly refreshModels?: () => Effect.Effect<void, ProviderDriverError>;
  readonly invalidateCaches?: Effect.Effect<void>;
  readonly consumeResetCredit?: () => Effect.Effect<
    ProviderConsumeResetCreditOutcome,
    ProviderDriverError
  >;
  readonly orchestrationAdapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly textGeneration: ProviderTextGeneration;
  readonly auth?: ProviderAuthController;
  readonly acpSessionManagement?: {
    readonly listSessions: (input: {
      readonly cwd: string;
      readonly cursor?: string;
    }) => Effect.Effect<AcpRegistryListSessionsResult, AcpRegistryOperationError>;
    readonly logout: (cwd: string) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly deleteSession: (input: {
      readonly cwd: string;
      readonly sessionId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly listProviders: (
      cwd: string,
    ) => Effect.Effect<AcpRegistryListProvidersResult, AcpRegistryOperationError>;
    readonly setProvider: (
      input: Omit<AcpRegistrySetProviderInput, "instanceId" | "projectId"> & {
        readonly cwd: string;
      },
    ) => Effect.Effect<void, AcpRegistryOperationError>;
    readonly disableProvider: (input: {
      readonly cwd: string;
      readonly providerId: string;
    }) => Effect.Effect<void, AcpRegistryOperationError>;
  };
  /** OMP's own settings (`omp config`), read and written through the instance's omp. */
  readonly ompSettings?: ProviderOmpSettingsController;
  /** OMP's own provider accounts: sign-in through RPC `login`, sign-out, auth sources. */
  readonly ompAccounts?: ProviderOmpAccountsController;
  /** OMP's on-disk sessions (`<agent dir>/sessions`), listed for import as threads. */
  readonly ompSessions?: ProviderOmpSessionsController;
  /**
   * Files in OMP's agent directory: the `WATCHDOG.yml` advisor roster, `agents/*.md`, custom
   * providers (`models.yml`), MCP servers, skills, rules, prompt templates, hooks and custom tools.
   */
  readonly ompAgentFiles?: ProviderOmpAgentFilesController;
  /** The Usage page's OMP tab: account quotas, `omp stats` totals, running threads' stats. */
  readonly ompUsage?: ProviderOmpUsageController;
  /** Settings → OMP → Plugins and Skills: `omp plugin`, `omp skill list`, `omp update --check`. */
  readonly ompPlugins?: ProviderOmpPluginsController;
  /** A thread's OMP menu: Export HTML, Share gist, Share live (`/collab`), Branch tree. */
  readonly ompThreadMenu?: ProviderOmpThreadMenuController;
}

/**
 * A thread's OMP menu. Export HTML and Share gist work from the thread's session file when its
 * OMP process is not running; Share live and the branch tree need the running session.
 */
export interface ProviderOmpThreadMenuController {
  /** `export_html` in the running session, else `omp --export` on its file. */
  readonly exportHtml: (
    threadId: ThreadId,
  ) => Effect.Effect<OmpExportHtmlResult, OmpThreadMenuOperationError>;
  /** `omp share <session file> --gist`, refused before anything uploads unless `gh` is signed in. */
  readonly shareGist: (
    threadId: ThreadId,
  ) => Effect.Effect<OmpShareGistResult, OmpThreadMenuOperationError>;
  /** RPC `collab_start`; needs a sidecar with the collab RPC (contract 1.7.0). */
  readonly startCollab: (input: {
    readonly threadId: ThreadId;
    readonly access: OmpCollabAccess;
  }) => Effect.Effect<OmpCollabStatus, OmpThreadMenuOperationError>;
  readonly stopCollab: (
    threadId: ThreadId,
  ) => Effect.Effect<OmpCollabStopResult, OmpThreadMenuOperationError>;
  /** RPC `collab_status`; an idle thread has no room, an older sidecar fails `needs_newer_omp`. */
  readonly collabStatus: (
    threadId: ThreadId,
  ) => Effect.Effect<OmpCollabStatus, OmpThreadMenuOperationError>;
  /** RPC `get_tree`, reduced to the branch view. */
  readonly branchTree: (
    threadId: ThreadId,
  ) => Effect.Effect<OmpBranchTree, OmpThreadMenuOperationError>;
  /**
   * RPC `resolve_proposal`: Accept (`apply`) or Reject (`discard`) the `ast_edit` proposal the
   * tool call staged, in the running session; needs a sidecar with it (contract 1.10.0).
   */
  readonly resolveProposal: (input: {
    readonly threadId: ThreadId;
    readonly toolCallId: string;
    readonly action: OmpProposalAction;
  }) => Effect.Effect<OmpResolveProposalResult, OmpThreadMenuOperationError>;
}

/**
 * OMP's plugins, marketplaces and skills through the instance's omp, in a directory with no
 * project config, so everything is user scope. Nothing here installs an OMP update.
 */
export interface ProviderOmpPluginsController {
  /** `omp plugin list --json` and `omp plugin marketplace list`. */
  readonly list: Effect.Effect<OmpPluginList, OmpPluginsOperationError>;
  /** Runs the one `omp plugin` command the page showed, then lists again. */
  readonly run: (
    command: OmpPluginCommand,
  ) => Effect.Effect<OmpPluginList, OmpPluginsOperationError>;
  /** `omp plugin discover <marketplace>`. */
  readonly discover: (
    marketplace: string,
  ) => Effect.Effect<OmpMarketplaceDiscover, OmpPluginsOperationError>;
  /** `/reload-plugins` in every idle running thread of the instance. */
  readonly reload: Effect.Effect<OmpPluginsReloadResult>;
  /** `omp update --check`: reports only, never installs. */
  readonly checkUpdate: Effect.Effect<OmpUpdateCheck, OmpPluginsOperationError>;
  /** `omp skill list <dir> --json` in the instance's global directory. */
  readonly skills: Effect.Effect<OmpSkillsList, OmpPluginsOperationError>;
}

export interface ProviderOmpUsageController {
  /** `omp usage --json`. */
  readonly account: Effect.Effect<OmpAccountUsage, OmpUsageOperationError>;
  /** `omp stats --json`. */
  readonly stats: Effect.Effect<OmpStatsSummary, OmpUsageOperationError>;
  /** RPC `get_session_stats` of every running thread; one thread's failure is its own entry. */
  readonly sessions: Effect.Effect<OmpSessionUsageList>;
}

/**
 * Reads and writes files in the instance's OMP agent directory, resolved per call with
 * `omp config path` so the instance's profile picks the directory. Nothing outside it is reached:
 * names are plain, and links leading out of the directory are refused.
 */
export interface ProviderOmpAgentFilesController {
  readonly list: Effect.Effect<OmpAgentFilesList, OmpAgentFilesOperationError>;
  readonly read: (
    file: OmpAgentFileRef,
  ) => Effect.Effect<OmpAgentFile, OmpAgentFilesOperationError>;
  /**
   * Fails `conflict` unless the file is still at `baseVersion` (absent: does not exist). A
   * `models.yml` write fails `invalid`, leaving the file as it was, unless OMP loads the new text
   * in a scratch agent directory first.
   */
  readonly write: (input: {
    readonly file: OmpAgentFileRef;
    readonly content: string;
    readonly baseVersion: string | undefined;
  }) => Effect.Effect<OmpAgentFile, OmpAgentFilesOperationError>;
  readonly remove: (input: {
    readonly file: OmpAgentFileRef;
    readonly baseVersion: string;
  }) => Effect.Effect<OmpAgentFilesList, OmpAgentFilesOperationError>;
  /** `omp agents unpack --user`: OMP's bundled agents into `agents/`, keeping existing files. */
  readonly unpackAgents: Effect.Effect<OmpAgentsUnpackResult, OmpAgentFilesOperationError>;
}

/**
 * A session as OMP stores it. `threadId` is the thread this instance last bound to it (which may
 * since have been deleted); the server resolves `importedThreadId` from it. `roots` are the
 * listing's roots holding its `cwd`; the server attributes the session to a project from them.
 */
export type ProviderOmpSession = Omit<
  OmpSessionSummary,
  "importedThreadId" | "projectId" | "worktreePath" | "branch"
> & {
  readonly threadId: ThreadId | null;
  readonly roots: ReadonlyArray<string>;
};

export interface ProviderOmpSessionsController {
  /** The directory the instance's `omp` keeps its sessions in. */
  readonly sessionsDirectory: string;
  /**
   * Sessions newest first. `within` keeps those working in one of its folders or below (null
   * keeps all); `sessionId` keeps only that session.
   */
  readonly list: (input: {
    readonly roots: ReadonlyArray<string>;
    readonly within: ReadonlyArray<string> | null;
    readonly sessionId?: string;
  }) => Effect.Effect<ReadonlyArray<ProviderOmpSession>, OmpSessionsOperationError>;
}

/**
 * OMP sign-in and sign-out. Keys and secret answers stay `Redacted` until they are written to the
 * omp process's stdin; they never reach argv, Ompanel's state directory or logs.
 */
export interface ProviderOmpAccountsController {
  /** Providers with auth state; `cwd` adds the project's committed-config credential check. */
  readonly list: (input: {
    readonly cwd: string | undefined;
  }) => Effect.Effect<OmpAccountsList, OmpAccountsOperationError>;
  /** Starts a sign-in; fails `busy` while another runs on this instance. */
  readonly start: (input: {
    readonly providerId: string;
    readonly apiKey: Redacted.Redacted<string> | undefined;
  }) => Effect.Effect<OmpSignInState, OmpAccountsOperationError>;
  /** Answers the running sign-in's prompt; `undefined` cancels the prompt. */
  readonly answer: (input: {
    readonly flowId: string;
    readonly promptId: string;
    readonly value: Redacted.Redacted<string> | undefined;
  }) => Effect.Effect<OmpSignInState, OmpAccountsOperationError>;
  readonly cancel: Effect.Effect<OmpSignInState>;
  /** The current state, then every change. */
  readonly subscribe: Stream.Stream<OmpSignInState>;
  readonly signOutAccounts: (input: {
    readonly providerId: string;
  }) => Effect.Effect<OmpSignOutAccounts, OmpAccountsOperationError>;
  readonly signOut: (input: {
    readonly providerId: string;
    readonly credentialId: number;
  }) => Effect.Effect<OmpSignOutResult, OmpAccountsOperationError>;
}

/** `cwd` selects the project layer; `undefined` reads and writes global layers only. */
export interface ProviderOmpSettingsController {
  readonly read: (input: {
    readonly cwd: string | undefined;
  }) => Effect.Effect<OmpSettingsForm, OmpSettingsOperationError>;
  readonly write: (input: {
    readonly cwd: string | undefined;
    readonly scope: OmpConfigScope;
    readonly key: string;
    readonly value: unknown;
  }) => Effect.Effect<OmpSettingsWriteResult, OmpSettingsOperationError>;
  readonly reset: (input: {
    readonly cwd: string | undefined;
    readonly scope: OmpConfigScope;
    readonly key: string;
  }) => Effect.Effect<OmpSettingsWriteResult, OmpSettingsOperationError>;
  readonly setThreadOverride: (input: {
    readonly threadId: ThreadId;
    readonly key: string;
    readonly value: unknown;
  }) => Effect.Effect<OmpThreadOverrideResult, OmpSettingsOperationError>;
  readonly clearThreadOverride: (input: {
    readonly threadId: ThreadId;
    readonly key: string;
  }) => Effect.Effect<OmpThreadOverrideResult, OmpSettingsOperationError>;
}

export interface ProviderContinuationIdentity {
  readonly driverKind: ProviderDriverKind;
  readonly continuationKey: string;
}

export function defaultProviderContinuationIdentity(input: {
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
}): ProviderContinuationIdentity {
  return {
    driverKind: input.driverKind,
    continuationKey: `${input.driverKind}:instance:${input.instanceId}`,
  };
}

export interface ProviderDriverCreateInput<Config> {
  readonly instanceId: ProviderInstanceId;
  readonly displayName: string | undefined;
  readonly accentColor?: string | undefined;
  readonly environment: ProviderInstanceEnvironment;
  readonly enabled: boolean;
  readonly config: Config;
}

/** create calls with different instanceId/config must share no mutable state. */
export interface ProviderDriver<Config, R = never, UsageR = never> {
  readonly driverKind: ProviderDriverKind;
  readonly metadata: ProviderDriverMetadata;
  // Codec keeps DecodingServices = never; Schema would widen it through AnyProviderDriver.
  readonly configSchema: Schema.Codec<Config, unknown>;
  readonly defaultConfig: () => Config;
  /** Failures become unavailable snapshots; never throw defects. */
  readonly create: (
    input: ProviderDriverCreateInput<Config>,
  ) => Effect.Effect<ProviderInstance, ProviderDriverError, R | Scope.Scope>;
  readonly usage?: ProviderUsageReader<Config, UsageR>;
}

export type AnyProviderDriver<R = never, UsageR = unknown> = ProviderDriver<any, R, UsageR>;

export type ProviderUsageReaderEnv<Driver> =
  Driver extends ProviderDriver<any, any, infer UsageR> ? UsageR : never;
