import {
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { OmpPidfiles } from "./pidfiles.ts";
import { type OmpStateDirs, startOmpSessionProcess } from "./session.ts";
import type { OmpSidecarError } from "./sidecar.ts";

const OMP_PROVIDER = ProviderDriverKind.make("omp");

/**
 * What an `omp --mode rpc-ui` session supports. Rollback and fork map to OMP's `branch` and
 * `switch_session`; delegation reaches T3's provider-agnostic thread MCP through OMP's own
 * subagents.
 */
const OMP_PROVIDER_CAPABILITIES = {
  runtimePolicy: { enforcement: "client-boundary" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: true,
    canForkFromTurn: true,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: true,
    canForkSubagentThread: true,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface OmpAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly profile: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** Working directory for threads that do not name one. */
  readonly defaultCwd: string;
  /** Resolves and verifies the binary; called right before every spawn, never cached. */
  readonly resolveBinary: Effect.Effect<string, OmpSidecarError>;
  readonly dirs: OmpStateDirs;
  readonly pidfiles: OmpPidfiles;
  /** `contract.version` from `omp.lock`. */
  readonly expectedContractVersion: string;
  readonly readyTimeoutMs?: number;
}

/** Operations that need OMP frames mapped to thread events, which this build does not do yet. */
const unavailable = (operation: string) =>
  Effect.fail(
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: OMP_PROVIDER,
      detail: `OMP ${operation} is not available in this Ompanel build yet`,
    }),
  );

/**
 * OMP's orchestration adapter. Opening a session starts the thread's `omp --mode rpc-ui`
 * process and completes the protocol handshake; thread and turn operations are not mapped yet.
 */
export const makeOmpAdapter = Effect.fn("makeOmpAdapter")(function* (options: OmpAdapterOptions) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const openSession = Effect.fn("OmpAdapter.openSession")(function* (
    input: ProviderAdapter.ProviderAdapterV2OpenSessionInput,
  ) {
    const openError = (cause: unknown) =>
      new ProviderAdapter.ProviderAdapterOpenSessionError({
        driver: OMP_PROVIDER,
        providerSessionId: input.providerSessionId,
        cause,
      });
    const cwd = input.runtimePolicy.cwd ?? options.defaultCwd;
    const binaryPath = yield* options.resolveBinary.pipe(Effect.mapError(openError));
    const process = yield* startOmpSessionProcess({
      binaryPath,
      profile: options.profile,
      runtimeMode: input.runtimePolicy.runtimeMode,
      cwd,
      threadId: input.threadId,
      environment: options.environment,
      platform: options.platform,
      dirs: options.dirs,
      pidfiles: options.pidfiles,
      expectedContractVersion: options.expectedContractVersion,
      ...(options.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: options.readyTimeoutMs }),
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError(openError),
    );

    const now = yield* DateTime.now;
    let providerSession: OrchestrationV2ProviderSession = {
      id: input.providerSessionId,
      driver: OMP_PROVIDER,
      providerInstanceId: options.instanceId,
      status: "ready",
      cwd,
      model: input.modelSelection.model,
      capabilities: OMP_PROVIDER_CAPABILITIES,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    const events = yield* Queue.unbounded<
      ProviderAdapter.ProviderAdapterV2Event,
      ProviderAdapter.ProviderAdapterV2Error | Cause.Done
    >();
    let settled = false;
    const settle = Effect.fn("OmpAdapter.settleSession")(function* (
      status: "stopped" | "error",
      lastError: string | null,
    ) {
      if (settled) return;
      settled = true;
      providerSession = { ...providerSession, status, lastError, updatedAt: yield* DateTime.now };
      yield* Queue.offer(events, {
        type: "provider_session.updated",
        driver: OMP_PROVIDER,
        providerSession,
      });
      yield* Queue.end(events);
    });
    // Frames are drained so the process never blocks on a full pipe; mapping them to thread
    // events is the frame mapper's job. Only frame types are logged, never content.
    yield* process.frames.pipe(
      Stream.runForEach((frame) => Effect.logDebug("omp frame", { type: frame.type })),
      Effect.matchEffect({
        onFailure: (error) => settle("error", error.message),
        onSuccess: () => settle("stopped", null),
      }),
      Effect.forkScoped,
    );
    // Stopping the thread closes stdin first, so OMP can finish its session file; the tree is
    // killed only if that stalls (and by the spawn's own finalizer, whatever happens here).
    yield* Effect.addFinalizer(() =>
      process.close().pipe(Effect.andThen(settle("stopped", null)), Effect.ignore),
    );

    yield* Effect.annotateCurrentSpan({ pid: process.pid });

    return {
      instanceId: options.instanceId,
      driver: OMP_PROVIDER,
      providerSessionId: input.providerSessionId,
      providerSession,
      events: Stream.fromQueue(events),
      backgroundTasksEndWithProcess: true,
      ensureThread: () => unavailable("thread creation"),
      resumeThread: () => unavailable("thread resume"),
      startTurn: () => unavailable("turns"),
      steerTurn: () => unavailable("steering"),
      interruptTurn: () => unavailable("interrupts"),
      respondToRuntimeRequest: () => unavailable("runtime requests"),
      readThreadSnapshot: () => unavailable("thread snapshots"),
      rollbackThread: () => unavailable("rollback"),
      forkThread: () => unavailable("fork"),
    } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
  });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OMP_PROVIDER,
    getCapabilities: () => Effect.succeed(OMP_PROVIDER_CAPABILITIES),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession,
  });
});
