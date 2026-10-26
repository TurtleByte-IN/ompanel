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
  OmpAccountUsage,
  OmpSessionUsageList,
  OmpStatsSummary,
  OmpUsageOperationError,
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
  Pick<ServerProviderWorkspaceSnapshot, "slashCommandsPending" | "optionDescriptors">;

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
  /** Files in OMP's agent directory: the `WATCHDOG.yml` advisor roster and `agents/*.md`. */
  readonly ompAgentFiles?: ProviderOmpAgentFilesController;
  /** The Usage page's OMP tab: account quotas, `omp stats` totals, running threads' stats. */
  readonly ompUsage?: ProviderOmpUsageController;
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
  /** Fails `conflict` unless the file is still at `baseVersion` (absent: does not exist). */
  readonly write: (input: {
    readonly file: OmpAgentFileRef;
    readonly content: string;
    readonly baseVersion: string | undefined;
  }) => Effect.Effect<OmpAgentFile, OmpAgentFilesOperationError>;
  readonly remove: (input: {
    readonly file: OmpAgentFileRef;
    readonly baseVersion: string;
  }) => Effect.Effect<OmpAgentFilesList, OmpAgentFilesOperationError>;
}

/**
 * A session as OMP stores it. `threadId` is the thread this instance last bound to it (which may
 * since have been deleted); the server resolves `importedThreadId` from it.
 */
export type ProviderOmpSession = Omit<OmpSessionSummary, "importedThreadId"> & {
  readonly threadId: ThreadId | null;
};

export interface ProviderOmpSessionsController {
  /** Sessions whose working directory is `cwd`, newest first. */
  readonly list: (input: {
    readonly cwd: string;
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
