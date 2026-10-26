import type {
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderSession,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { RpcServerFrame } from "../../contract/src/wire.generated.ts";
import { OMP_PROVIDER, OmpThreadMapper, type OmpTurnOutcome } from "./mapper.ts";
import type { OmpPidfiles } from "./pidfiles.ts";
import { type OmpStateDirs, startOmpSessionProcess } from "./session.ts";
import type { OmpSidecarError } from "./sidecar.ts";

/** Streamed text is held this long so a burst of deltas becomes one update. */
const STREAM_FLUSH = Duration.millis(50);
/** Reads and title syncs around a turn; a slow answer costs only the meter or the title. */
const SIDE_REQUEST_TIMEOUT_MS = 2_000;

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
    emitsPlanUpdated: true,
    emitsTodoList: true,
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

/** Operations other Ompanel items wire up; this build refuses them. */
const unavailable = (operation: string) =>
  Effect.fail(
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: OMP_PROVIDER,
      detail: `OMP ${operation} is not available in this Ompanel build yet`,
    }),
  );

const protocolError = (detail: string, reason?: ProviderAdapter.ProviderAdapterFailureReason) =>
  new ProviderAdapter.ProviderAdapterProtocolError({
    driver: OMP_PROVIDER,
    detail,
    ...(reason === undefined ? {} : { reason }),
  });

/**
 * OMP's orchestration adapter. Opening a session starts the thread's `omp --mode rpc-ui`
 * process and completes the protocol handshake; the thread binds to the live OMP session, a
 * turn is one `prompt`, and every frame goes through `OmpThreadMapper`.
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

    const scope = yield* Effect.scope;
    const now = yield* DateTime.now;
    const mapper = new OmpThreadMapper({
      instanceId: options.instanceId,
      providerSession: {
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
      } satisfies OrchestrationV2ProviderSession,
    });
    const events = yield* Queue.unbounded<
      ProviderAdapter.ProviderAdapterV2Event,
      ProviderAdapter.ProviderAdapterV2Error | Cause.Done
    >();
    const emit = (list: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
      list.length === 0 ? Effect.void : Queue.offerAll(events, list).pipe(Effect.asVoid);
    // Frames, turn starts and flushes all change the mapper; one at a time keeps events ordered.
    const permit = yield* Semaphore.make(1);
    const exclusive = permit.withPermits(1);

    let flushScheduled = false;
    const scheduleFlush = Effect.sleep(STREAM_FLUSH).pipe(
      Effect.andThen(
        exclusive(
          Effect.gen(function* () {
            flushScheduled = false;
            yield* emit(mapper.flushStreaming(yield* DateTime.now));
          }),
        ),
      ),
      Effect.forkIn(scope),
    );

    const finalize = Effect.fnUntraced(function* (outcome: OmpTurnOutcome, refresh: boolean) {
      // Usage and todos live in the session, not in `prompt_result`: read them once per turn.
      const read = <A, E>(effect: Effect.Effect<A, E>) =>
        refresh ? effect.pipe(Effect.option) : Effect.succeed(Option.none<A>());
      const state = yield* read(
        process.request("get_state", undefined, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS }),
      );
      const stats = yield* read(
        process.request("get_session_stats", undefined, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS }),
      );
      yield* emit(
        mapper.finalizeTurn(
          outcome,
          {
            ...(Option.isSome(state) ? { state: state.value } : {}),
            ...(Option.isSome(stats) ? { stats: stats.value } : {}),
          },
          yield* DateTime.now,
        ),
      );
    });

    const handleFrame = Effect.fnUntraced(function* (frame: RpcServerFrame) {
      const result = mapper.handleFrame(frame, yield* DateTime.now);
      yield* emit(result.events);
      if (result.streaming && !flushScheduled) {
        flushScheduled = true;
        yield* scheduleFlush;
      }
      if (result.settled !== null) yield* finalize(result.settled, true);
    });

    let settled = false;
    const settle = Effect.fn("OmpAdapter.settleSession")(function* (
      status: "stopped" | "error",
      lastError: string | null,
    ) {
      if (settled) return;
      settled = true;
      // A turn still open when the process goes away ends here: stopped, or lost.
      if (mapper.hasActiveTurn) {
        yield* finalize(
          status === "stopped"
            ? { status: "interrupted" }
            : {
                status: "failed",
                failure: makeProviderFailure({
                  message: lastError ?? "omp exited unexpectedly.",
                  class: "transport_error",
                }),
              },
          false,
        );
      }
      yield* emit(mapper.setSessionStatus(status, lastError, yield* DateTime.now));
      yield* Queue.end(events);
    });
    // Frames are drained so the process never blocks on a full pipe. Only frame types are
    // logged, never content.
    yield* process.frames.pipe(
      Stream.runForEach((frame) =>
        Effect.logDebug("omp frame", { type: frame.type }).pipe(
          Effect.andThen(exclusive(handleFrame(frame))),
        ),
      ),
      Effect.matchEffect({
        onFailure: (error) => exclusive(settle("error", error.message)),
        onSuccess: () => exclusive(settle("stopped", null)),
      }),
      Effect.forkScoped,
    );
    // Stopping the thread closes stdin first, so OMP can finish its session file; the tree is
    // killed only if that stalls (and by the spawn's own finalizer, whatever happens here).
    yield* Effect.addFinalizer(() =>
      process.close().pipe(Effect.andThen(exclusive(settle("stopped", null))), Effect.ignore),
    );

    yield* Effect.annotateCurrentSpan({ pid: process.pid });

    /** Binds the thread to the session this process opened; switching sessions is C-10's. */
    const bindThread = Effect.fnUntraced(function* (
      threadId: ProviderAdapter.ProviderAdapterV2EnsureThreadInput["threadId"],
      existing: ProviderAdapter.ProviderAdapterV2EnsureThreadInput["existingProviderThread"],
    ) {
      const bound = mapper.providerThread;
      if (bound !== null) {
        if (existing !== undefined && existing.id !== bound.id) {
          return yield* protocolError("This OMP session is bound to another provider thread");
        }
        return bound;
      }
      const state = yield* process.request("get_state", undefined);
      const nativeId = existing?.nativeThreadRef?.nativeId;
      if (nativeId !== undefined && nativeId !== state.sessionId) {
        return yield* unavailable("resuming an earlier session");
      }
      const result = mapper.bindThread(
        { threadId, state, ...(existing === undefined ? {} : { existing }) },
        yield* DateTime.now,
      );
      yield* emit(result.events);
      return result.providerThread;
    });

    let appliedSessionName: string | null = null;
    const startTurn = Effect.fnUntraced(function* (
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
    ) {
      const bound = mapper.providerThread;
      if (bound === null) return yield* protocolError("OMP session has no bound thread");
      if (bound.id !== turnInput.providerThread.id) {
        return yield* protocolError("OMP turn requested for a different provider thread");
      }
      if (mapper.hasActiveTurn) {
        return yield* protocolError(
          `OMP provider thread ${bound.id} already has an active turn`,
          "previous_turn_active",
        );
      }
      // T3 names the thread; OMP keeps it as a user-set title, which its own titling respects.
      const title = turnInput.appThread.title;
      if (title !== appliedSessionName) {
        yield* process
          .request("set_session_name", { name: title }, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS })
          .pipe(
            Effect.tap(() => Effect.sync(() => (appliedSessionName = title))),
            Effect.ignore,
          );
      }
      const providerTurnId = yield* exclusive(
        Effect.gen(function* () {
          if (mapper.hasActiveTurn) {
            return yield* protocolError("OMP turn ownership changed before it could start");
          }
          yield* emit(mapper.startTurn(turnInput, yield* DateTime.now));
          return mapper.activeProviderTurnId;
        }),
      );
      // The reply is echoed onto the frame stream, behind any `command_output` the prompt
      // produced, and settles the turn there. A prompt that never reached OMP settles here.
      yield* process
        .request(
          "prompt",
          { message: turnInput.message.text },
          { timeoutMs: null, echoResponse: true },
        )
        .pipe(
          Effect.catchTags({
            OmpRpcError: (error) =>
              exclusive(
                mapper.activeProviderTurnId === providerTurnId
                  ? finalize(
                      {
                        status: "failed",
                        failure: makeProviderFailure({
                          message: error.message,
                          class: "transport_error",
                        }),
                      },
                      false,
                    )
                  : Effect.void,
              ),
          }),
          Effect.ignore,
          Effect.forkIn(scope),
        );
    });

    return {
      instanceId: options.instanceId,
      driver: OMP_PROVIDER,
      providerSessionId: input.providerSessionId,
      get providerSession() {
        return mapper.providerSession;
      },
      events: Stream.fromQueue(events),
      backgroundTasksEndWithProcess: true,
      ensureThread: (threadInput) =>
        bindThread(threadInput.threadId, threadInput.existingProviderThread).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterEnsureThreadError({
                driver: OMP_PROVIDER,
                threadId: threadInput.threadId,
                cause,
              }),
          ),
        ),
      resumeThread: (threadInput) =>
        bindThread(
          threadInput.threadId ?? threadInput.providerThread.appThreadId ?? input.threadId,
          threadInput.providerThread,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterResumeThreadError({
                driver: OMP_PROVIDER,
                providerSessionId: input.providerSessionId,
                providerThreadId: threadInput.providerThread.id,
                cause,
              }),
          ),
        ),
      startTurn: (turnInput) =>
        startTurn(turnInput).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: OMP_PROVIDER,
                threadId: turnInput.threadId,
                providerThreadId: turnInput.providerThread.id,
                runId: turnInput.runId,
                cause,
              }),
          ),
        ),
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
