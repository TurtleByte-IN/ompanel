import type {
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderSession,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHostTools from "@t3tools/provider-core/server/ProviderHostTools";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import type * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { RpcServerFrame } from "../../contract/src/wire.generated.ts";
import { makeOmpHostBridge } from "./hostTools.ts";
import { ompApprovalModeFor } from "./launch.ts";
import { OMP_PROVIDER, OmpThreadMapper, type OmpTurnOutcome } from "./mapper.ts";
import type { OmpRpcRequestError, OmpRpcRequestOptions } from "./rpcProcess.ts";
import type { OmpPidfiles } from "./pidfiles.ts";
import { type OmpStateDirs, startOmpSessionProcess } from "./session.ts";
import type { OmpThreadSessions } from "./threadSessions.ts";
import type { OmpSidecarError } from "./sidecar.ts";
import {
  isOmpCancelRequest,
  isOmpDialogRequest,
  OmpUiRequests,
  type OmpCancelRequest,
  type OmpDialogRequest,
} from "./uiRequests.ts";
import {
  OMP_REVIVE_CONTRACT,
  OmpSubagentTracker,
  ompSubagentControls,
  ompTranscriptPage,
} from "./subagents.ts";

/** Streamed text is held this long so a burst of deltas becomes one update. */
const STREAM_FLUSH = Duration.millis(50);
/** Reads and title syncs around a turn; a slow answer costs only the meter or the title. */
const SIDE_REQUEST_TIMEOUT_MS = 2_000;
/** Subagent controls wait for OMP to accept them, which can include a subagent's turn setup. */
const SUBAGENT_REQUEST_TIMEOUT_MS = 30_000;
/** Reviving rebuilds a subagent session from its transcript (models, tools, extensions). */
const SUBAGENT_REVIVE_TIMEOUT_MS = 60_000;

/**
 * `revive_subagent` (RPC contract 1.4.0) is newer than the pinned contract's typed command
 * table. It is only sent when the pinned contract has it (see `ompSubagentControls`), so the
 * call is typed here until the vendored contract is re-pinned.
 */
type OmpReviveRequest = (
  command: "revive_subagent",
  params: { readonly subagentId: string; readonly message?: string },
  options?: OmpRpcRequestOptions,
) => Effect.Effect<{ readonly revived: boolean }, OmpRpcRequestError>;

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
    // A mode change reaches the live process as `set_approval_mode` before the next prompt.
    supportsRuntimeModeSwitchInSession: true,
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
  /** This instance's running thread sessions, shared with the settings engine. */
  readonly threadSessions: OmpThreadSessions;
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
  // Present inside the T3 server; without them a thread's OMP keeps its own shell and worktrees.
  const hostTools = Option.getOrUndefined(
    yield* Effect.serviceOption(ProviderHostTools.ProviderHostTools),
  );
  const mcpSessions = Option.getOrUndefined(
    yield* Effect.serviceOption(McpProviderSessions.McpProviderSessions),
  );

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
    const hostBridge = yield* makeOmpHostBridge({
      process,
      threadId: input.threadId,
      cwd,
      hostTools,
      mcpSession: mcpSessions === undefined ? undefined : yield* mcpSessions.read(input.threadId),
    });
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
    const uiRequests = new OmpUiRequests({ providerSessionId: input.providerSessionId });
    /** OMP's answer deadlines, by native request id. */
    const dialogTimers = new Map<string, Fiber.Fiber<void>>();
    const subagentControls = ompSubagentControls(process.contractVersion);
    const subagents = new OmpSubagentTracker({
      instanceId: options.instanceId,
      controls: subagentControls,
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

    const stopDialogTimer = (nativeId: string) => {
      const timer = dialogTimers.get(nativeId);
      dialogTimers.delete(nativeId);
      return timer === undefined ? Effect.void : Fiber.interrupt(timer);
    };
    // Runs under the permit, so an answer and the deadline never both reach OMP.
    const expireDialog = Effect.fnUntraced(function* (nativeId: string) {
      dialogTimers.delete(nativeId);
      const expired = uiRequests.expire(nativeId, yield* DateTime.now);
      if (expired === null) return;
      yield* process.send(expired.reply).pipe(Effect.ignore);
      yield* emit(expired.events);
    });

    const handleDialogFrame = Effect.fnUntraced(function* (
      frame: OmpDialogRequest | OmpCancelRequest,
    ) {
      const now = yield* DateTime.now;
      if (frame.method === "cancel") {
        yield* stopDialogTimer(frame.targetId);
        return yield* emit(uiRequests.close(frame.targetId, now));
      }
      const opened = uiRequests.open(frame, mapper.requestPlacement(frame.id, input.threadId), now);
      if (opened === null) {
        // Nobody can answer a dialog with no id or no choices: close it so OMP moves on.
        yield* Effect.logWarning("omp dialog request dropped", { method: frame.method });
        if (typeof frame.id === "string") {
          yield* process
            .send({ type: "extension_ui_response", id: frame.id, cancelled: true })
            .pipe(Effect.ignore);
        }
        return;
      }
      yield* emit(opened.events);
      if (opened.timeoutMs !== null) {
        const nativeId = frame.id;
        const timer = yield* Effect.sleep(Duration.millis(opened.timeoutMs)).pipe(
          Effect.andThen(exclusive(expireDialog(nativeId))),
          Effect.forkIn(scope),
        );
        dialogTimers.set(nativeId, timer);
      }
    });

    const handleFrame = Effect.fnUntraced(function* (frame: RpcServerFrame) {
      if (isOmpDialogRequest(frame) || isOmpCancelRequest(frame)) {
        return yield* handleDialogFrame(frame);
      }
      if (frame.type === "subagent_lifecycle" || frame.type === "subagent_progress") {
        yield* emit(subagents.handleFrame(frame, mapper.subagentScope, yield* DateTime.now));
        return;
      }
      if (yield* hostBridge.handleFrame(frame)) return;
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
      // Dialogs still open close unanswered; OMP is gone or going.
      yield* Effect.forEach([...dialogTimers.keys()], stopDialogTimer, { discard: true });
      yield* emit(uiRequests.closeAll(yield* DateTime.now));
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
    // Subagent lifecycle and progress frames feed the agents panel; their own session events
    // ("events") are not needed, the panel pages transcripts instead.
    yield* process
      .request(
        "set_subagent_subscription",
        { level: "progress" },
        { timeoutMs: SIDE_REQUEST_TIMEOUT_MS },
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("omp subagent subscription failed", { error: error.message }),
        ),
      );

    yield* Effect.annotateCurrentSpan({ pid: process.pid });
    // Multi-select and free-text questions reach the host only through OMP's `ask` dialog, which
    // the host has to enable; an omp without the command keeps its select/editor fallback.
    yield* process
      .request("set_ask_dialog", { enabled: true }, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS })
      .pipe(Effect.ignore);
    yield* options.threadSessions.register({
      threadId: input.threadId,
      providerSessionId: input.providerSessionId,
      cwd,
      process,
      // Ordered with frames and turns, like every other change to the session.
      onRestartRequired: Effect.fn("OmpAdapter.publishRestartRequired")(function* (keys) {
        yield* exclusive(
          Effect.gen(function* () {
            if (settled) return;
            yield* emit(mapper.setRestartRequired(keys, yield* DateTime.now));
          }),
        );
      }),
    });
    // Before the first turn, so its tools and directory handling are in place.
    yield* hostBridge.setup;

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

    /** The mode the process enforces: the launch flag, then each `set_approval_mode` OMP accepted. */
    let appliedApprovalMode = ompApprovalModeFor(input.runtimePolicy.runtimeMode);
    /**
     * Brings OMP to the turn's permission mode without a restart. A refusal (a session locked
     * to yolo by `--auto-approve`) fails the turn before its prompt, so OMP never runs a turn
     * under a mode other than the one the thread shows.
     */
    const applyApprovalMode = Effect.fnUntraced(function* (
      runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
    ) {
      const wanted = ompApprovalModeFor(runtimePolicy.runtimeMode);
      if (wanted === appliedApprovalMode) return;
      const result = yield* process
        .request("set_approval_mode", { mode: wanted }, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "OmpRpcCommandError"
              ? protocolError(
                  `OMP refused approval mode ${wanted}: ${error.detail}`,
                  "permission_mode_refused",
                )
              : protocolError(`OMP approval mode ${wanted} not applied: ${error.message}`),
          ),
        );
      if (result.mode !== wanted) {
        return yield* protocolError(
          `OMP kept approval mode ${result.mode} when asked for ${wanted}`,
          "permission_mode_refused",
        );
      }
      appliedApprovalMode = wanted;
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
      yield* applyApprovalMode(turnInput.runtimePolicy);
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

    const respond = Effect.fnUntraced(function* (
      requestInput: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput,
    ) {
      const answer = uiRequests.answer(requestInput);
      if (answer === null) {
        return yield* protocolError(`No pending OMP request ${requestInput.requestId}`);
      }
      yield* stopDialogTimer(answer.nativeId);
      yield* process.send(answer.reply);
      yield* emit(uiRequests.resolve(requestInput.requestId, yield* DateTime.now));
    });

    // OMP's own refusal ("Subagent not running: X") is what the user should read.
    const subagentRequestError = (error: OmpRpcRequestError) =>
      protocolError(error._tag === "OmpRpcCommandError" ? error.detail : error.message);
    const assertOwnThread = (providerThread: { readonly id: string }) =>
      mapper.providerThread?.id === providerThread.id
        ? Effect.void
        : Effect.fail(protocolError("OMP subagent requested for a different provider thread"));

    const controlSubagent = Effect.fnUntraced(function* (
      controlInput: Parameters<
        NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["controlSubagent"]>
      >[0],
    ) {
      yield* assertOwnThread(controlInput.providerThread);
      const subagentId = controlInput.nativeTaskId;
      const action = controlInput.action;
      switch (action.type) {
        case "kill": {
          const { cancelled } = yield* process
            .request("cancel_subagent", { subagentId }, { timeoutMs: SUBAGENT_REQUEST_TIMEOUT_MS })
            .pipe(Effect.mapError(subagentRequestError));
          if (!cancelled) return yield* protocolError(`Subagent ${subagentId} is not running`);
          return;
        }
        case "steer":
          return yield* process
            .request(
              "steer_subagent",
              { subagentId, message: action.message },
              { timeoutMs: SUBAGENT_REQUEST_TIMEOUT_MS },
            )
            .pipe(Effect.asVoid, Effect.mapError(subagentRequestError));
        case "revive": {
          if (!subagentControls.revive) {
            return yield* protocolError(
              `Reviving a subagent needs OMP RPC contract ${OMP_REVIVE_CONTRACT} or later; this build pins ${process.contractVersion}`,
            );
          }
          const requestRevive = process.request as unknown as OmpReviveRequest;
          return yield* requestRevive(
            "revive_subagent",
            {
              subagentId,
              ...(action.message === undefined ? {} : { message: action.message }),
            },
            { timeoutMs: SUBAGENT_REVIVE_TIMEOUT_MS },
          ).pipe(Effect.asVoid, Effect.mapError(subagentRequestError));
        }
      }
    });

    const readSubagentTranscript = Effect.fnUntraced(function* (
      readInput: Parameters<
        NonNullable<ProviderAdapter.ProviderAdapterV2SessionRuntime["readSubagentTranscript"]>
      >[0],
    ) {
      yield* assertOwnThread(readInput.providerThread);
      const page = yield* process
        .request(
          "get_subagent_messages",
          { subagentId: readInput.nativeTaskId, fromByte: readInput.fromByte },
          { timeoutMs: SUBAGENT_REQUEST_TIMEOUT_MS },
        )
        .pipe(Effect.mapError(subagentRequestError));
      return ompTranscriptPage(page);
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
      controlSubagent,
      readSubagentTranscript,
      steerTurn: () => unavailable("steering"),
      interruptTurn: () => unavailable("interrupts"),
      respondToRuntimeRequest: (requestInput) =>
        exclusive(respond(requestInput)).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: OMP_PROVIDER,
                requestId: requestInput.requestId,
                cause,
              }),
          ),
        ),
      readThreadSnapshot: () => unavailable("thread snapshots"),
      rollbackThread: () => unavailable("rollback"),
      forkThread: () => unavailable("fork"),
    } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
  });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: OMP_PROVIDER,
    getCapabilities: () => Effect.succeed(OMP_PROVIDER_CAPABILITIES),
    // A session that must restart for changed settings is restarted on the selection change.
    planSelectionTransition: (input) =>
      Effect.succeed(
        input.providerSessionId !== undefined &&
          options.threadSessions.restartRequired(input.providerSessionId).length > 0
          ? ({ type: "restart_session" } as const)
          : turnScopedSelectionTransition(),
      ),
    openSession,
  });
});
