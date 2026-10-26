import type {
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderSession,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
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

import type { RpcServerFrame, SessionState } from "../../contract/src/wire.generated.ts";
import type { OmpCommandHooks } from "./commands.ts";
import { makeOmpHostBridge } from "./hostTools.ts";
import { ompApprovalModeFor } from "./launch.ts";
import { OMP_PROVIDER, OmpThreadMapper, type OmpTurnOutcome } from "./mapper.ts";
import type { OmpSessionsLocation } from "./ompSessions.ts";
import type { OmpRpcRequestError } from "./rpcProcess.ts";
import type { OmpPidfiles } from "./pidfiles.ts";
import { type OmpStateDirs, startOmpSessionProcess } from "./session.ts";
import {
  ensureFreshOmpSession,
  recordOmpThreadSession,
  switchOmpSession,
} from "./sessionBinding.ts";
import { ompHistoryMessages, readOmpHistoryPages } from "./sessionHistory.ts";
import {
  ompBranchTree,
  ompDroppedTurns,
  ompSessionEntries,
  ompTurnUserEntry,
  resolveOmpCut,
  readOmpBranchTree,
  resolveOmpForkEntry,
} from "./sessionBranches.ts";
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
/** Session switches, rewinds and forks load, index and copy the whole transcript. */
const SESSION_CHANGE_TIMEOUT_MS = 60_000;
/** Reads of the session tree for a rewind or fork, which list user messages or entries. */
const TREE_READ_TIMEOUT_MS = 30_000;

/**
 * What an `omp --mode rpc-ui` session supports. Rollback maps to OMP's `branch`, a fork to
 * `fork` (docs/omp/sessions.md); delegation reaches T3's provider-agnostic thread MCP through
 * OMP's own subagents.
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
  /** Where the instance's `omp` keeps its session files (`resolveOmpSessionsLocation`). */
  readonly sessions: OmpSessionsLocation;
  /** The instance's `/` and `$` catalog: pushed command lists in, `$skill` prompt rewrite out. */
  readonly commands?: OmpCommandHooks;
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

/** A rewind or fork refused because the session is still being written (PRD §12). */
const busyError = (action: string) =>
  protocolError(
    `Cannot ${action} while the OMP session is busy: a turn is still running. Wait for it to finish or stop it, then try again`,
    "previous_turn_active",
  );

/** OMP's `session_busy` refusal reads like Ompanel's own; anything else keeps OMP's words. */
const sessionChangeError = (action: string) => (error: OmpRpcRequestError) =>
  error._tag === "OmpRpcCommandError" && error.code === "session_busy"
    ? busyError(action)
    : protocolError(
        `OMP could not ${action}: ${error._tag === "OmpRpcCommandError" ? error.detail : error.message}`,
      );

/**
 * OMP's orchestration adapter. Opening a session starts the thread's `omp --mode rpc-ui`
 * process, completes the protocol handshake and puts the process on the thread's OMP session
 * (a fresh one, or the one the thread ran before; docs/omp/sessions.md). A turn is one
 * `prompt`, and every frame goes through `OmpThreadMapper`.
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

    /** The thread's session: found in `options.sessions`, remembered in the thread directory. */
    const binding = {
      process,
      location: options.sessions,
      threadsDir: options.dirs.threads,
      threadId: input.threadId,
    };
    const withFiles = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
      effect.pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
    let recorded: Pick<SessionState, "sessionId" | "sessionFile"> | null = null;
    /** Records the session the thread runs whenever it changes (`/fresh` starts a new one). */
    const recordSession = (state: Pick<SessionState, "sessionId" | "sessionFile">) =>
      recorded?.sessionId === state.sessionId && recorded.sessionFile === state.sessionFile
        ? Effect.void
        : withFiles(recordOmpThreadSession(binding, state)).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                recorded = state;
              }),
            ),
          );
    /** The session's user and assistant messages, read page by page, as thread messages. */
    const readHistory = Effect.fnUntraced(function* (threadId: ThreadId, sessionId: string) {
      const pages = yield* readOmpHistoryPages(process);
      return ompHistoryMessages({
        threadId,
        sessionId,
        messages: pages.flatMap((page) => page.messages),
        now: yield* DateTime.now,
      });
    });

    /**
     * The session's leaf after the last turn this process saw, so the next turn lists only its
     * own entries (`get_entries {since}`); undefined until read and after the session changed.
     */
    let sessionLeaf: string | null | undefined;
    /** When the active turn started, in epoch milliseconds, for a listing without a leaf. */
    let turnStartedAt = 0;
    /** A rewind or fork is moving the session to another file. */
    let sessionChanging = false;
    /** The user message entry the turn's prompt wrote (sessionBranches.ts); undefined: unread. */
    const captureTurnEntry = Effect.fnUntraced(function* () {
      const previous = sessionLeaf;
      sessionLeaf = undefined;
      const list = (since: string | undefined) =>
        process
          .request("get_entries", since === undefined ? {} : { since }, {
            timeoutMs: SIDE_REQUEST_TIMEOUT_MS,
          })
          .pipe(Effect.option);
      let known = previous;
      let listing = yield* list(previous ?? undefined);
      // An unknown cursor means the session moved under the turn (`/new`, a switch).
      if (Option.isNone(listing) && typeof previous === "string") {
        known = undefined;
        listing = yield* list(undefined);
      }
      if (Option.isNone(listing)) return undefined;
      const entries = ompSessionEntries(listing.value.entries);
      if (entries === null) return undefined;
      sessionLeaf = listing.value.leafId;
      return ompTurnUserEntry({
        entries,
        leafId: listing.value.leafId,
        previousLeafId: known,
        turnStartedAt,
      });
    });

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
      const turnEntryId = refresh ? yield* captureTurnEntry() : undefined;
      yield* emit(
        mapper.finalizeTurn(
          outcome,
          {
            ...(Option.isSome(state) ? { state: state.value } : {}),
            ...(Option.isSome(stats) ? { stats: stats.value } : {}),
            ...(turnEntryId === undefined ? {} : { turnEntryId }),
          },
          yield* DateTime.now,
        ),
      );
      if (Option.isSome(state) && mapper.providerThread !== null) yield* recordSession(state.value);
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
      if (frame.type === "available_commands_update") {
        if (options.commands !== undefined) {
          yield* options.commands.onAvailableCommands(cwd, frame.commands);
        }
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
    // A running turn is aborted first: OMP would otherwise drain it, still under the mode it
    // started with, after T3 detached the session (for example for a stricter permission mode).
    yield* Effect.addFinalizer(() =>
      (mapper.hasActiveTurn
        ? process
            .request("abort", undefined, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS })
            .pipe(Effect.ignore)
        : Effect.void
      ).pipe(
        Effect.andThen(process.close()),
        Effect.andThen(exclusive(settle("stopped", null))),
        Effect.ignore,
      ),
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
    // A known thread reopens its session before anything runs in it. One that cannot be
    // reopened keeps a fresh session, and resuming the thread reports why (T3 then starts a
    // fresh native thread and hands the conversation over).
    const nativeSessionId = input.initialNativeThreadId;
    const reopened =
      nativeSessionId !== undefined &&
      (yield* withFiles(switchOmpSession({ ...binding, sessionId: nativeSessionId })).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("omp session not reopened", {
            sessionId: nativeSessionId,
            detail: error.message,
          }).pipe(Effect.as(false)),
        ),
      ));
    // A process that is already gone settles the session as an error on its frame stream.
    if (!reopened) {
      yield* ensureFreshOmpSession(process).pipe(
        Effect.catchTags({
          OmpRpcError: (error) =>
            Effect.logWarning("omp session not checked", { detail: error.message }),
        }),
        Effect.mapError(openError),
      );
    }
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
      isBusy: () => mapper.hasActiveTurn || sessionChanging,
    });
    // Before the first turn, so its tools and directory handling are in place.
    yield* hostBridge.setup;

    /**
     * Binds the thread to its OMP session: the one it ran before (reopened if the process runs
     * another), else the process's own fresh session. A thread with no run yet whose session
     * already holds a conversation (an imported session) gets that history as its messages.
     */
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
      let state = yield* process.request("get_state", undefined);
      const nativeId = existing?.nativeThreadRef?.nativeId;
      if (nativeId != null && nativeId !== state.sessionId) {
        state = yield* withFiles(switchOmpSession({ ...binding, sessionId: nativeId })).pipe(
          Effect.mapError((error) =>
            protocolError(`OMP session ${nativeId} could not be resumed: ${error.message}`),
          ),
        );
      }
      const result = mapper.bindThread(
        { threadId, state, ...(existing === undefined ? {} : { existing }) },
        yield* DateTime.now,
      );
      yield* emit(result.events);
      yield* recordSession(state);
      if (existing?.lastRunOrdinal === null && (state.messageCount ?? 0) > 0) {
        const sessionId = state.sessionId;
        yield* readHistory(threadId, sessionId).pipe(
          Effect.flatMap((messages) =>
            emit(
              messages.map((message) => ({
                type: "message.updated" as const,
                driver: OMP_PROVIDER,
                message,
              })),
            ),
          ),
          Effect.catch((error) =>
            Effect.logWarning("omp session history not loaded", {
              sessionId,
              detail: error.message,
            }),
          ),
        );
      }
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
      // A fork binds before T3 has a row for it; T3 then runs it under its own row's id, with the
      // native session the fork returned. The row is the thread from then on (`mapper.startTurn`).
      if (
        bound.id !== turnInput.providerThread.id &&
        turnInput.providerThread.nativeThreadRef?.nativeId !== bound.nativeThreadRef?.nativeId
      ) {
        return yield* protocolError("OMP turn requested for a different provider thread");
      }
      if (mapper.hasActiveTurn) {
        return yield* protocolError(
          `OMP provider thread ${bound.id} already has an active turn`,
          "previous_turn_active",
        );
      }
      yield* applyApprovalMode(turnInput.runtimePolicy);
      // OMP expands a skill only as `/skill:<name>`; the composer writes `$<name>`.
      const promptText =
        options.commands === undefined
          ? turnInput.message.text
          : yield* options.commands.resolvePrompt(cwd, turnInput.message.text);
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
          if (sessionChanging) {
            return yield* protocolError(
              "OMP is rewinding or forking this session; start the turn once it is done",
              "previous_turn_active",
            );
          }
          turnStartedAt = DateTime.toEpochMillis(yield* DateTime.now);
          yield* emit(mapper.startTurn(turnInput, yield* DateTime.now));
          return mapper.activeProviderTurnId;
        }),
      );
      // The reply is echoed onto the frame stream, behind any `command_output` the prompt
      // produced, and settles the turn there. A prompt that never reached OMP settles here.
      yield* process
        .request("prompt", { message: promptText }, { timeoutMs: null, echoResponse: true })
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
          return yield* process
            .request(
              "revive_subagent",
              {
                subagentId,
                ...(action.message === undefined ? {} : { message: action.message }),
              },
              { timeoutMs: SUBAGENT_REVIVE_TIMEOUT_MS },
            )
            .pipe(Effect.asVoid, Effect.mapError(subagentRequestError));
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

    /**
     * The conversation as OMP holds it now, paged with `get_messages_page`: user and assistant
     * messages outside any run. OMP refuses while a turn streams (`session_busy`).
     */
    const readThreadSnapshot = Effect.fnUntraced(function* (
      snapshotInput: ProviderAdapter.ProviderAdapterV2ReadThreadSnapshotInput,
    ) {
      yield* assertOwnThread(snapshotInput.providerThread);
      const state = yield* process.request("get_state", undefined, {
        timeoutMs: SIDE_REQUEST_TIMEOUT_MS,
      });
      const messages = yield* readHistory(
        snapshotInput.providerThread.appThreadId ?? input.threadId,
        state.sessionId,
      );
      const branchTree = yield* readOmpBranchTree(process, TREE_READ_TIMEOUT_MS).pipe(
        Effect.option,
      );
      return {
        providerThread: mapper.providerThread ?? snapshotInput.providerThread,
        providerTurns: [],
        messages,
        runtimeRequests: [],
        providerPayload: {
          sessionId: state.sessionId,
          sessionFile: state.sessionFile ?? null,
          branchTree: Option.getOrNull(branchTree),
        },
      } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
    });

    /** A rewind or fork is changing the session; turns and other changes wait for it. */
    const claimSessionChange = (action: string) =>
      exclusive(
        Effect.suspend(() => {
          if (mapper.hasActiveTurn) return Effect.fail(busyError(action));
          if (sessionChanging) {
            return Effect.fail(
              protocolError(`Cannot ${action}: another rewind or fork is running`),
            );
          }
          sessionChanging = true;
          return Effect.void;
        }),
      );
    const releaseSessionChange = Effect.sync(() => {
      sessionChanging = false;
    });
    /** OMP's own view: a turn T3 did not start (a wake-up) or a compaction also writes the file. */
    const assertSessionIdle = (action: string, target: Pick<typeof process, "request"> = process) =>
      target.request("get_state", undefined, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS }).pipe(
        Effect.mapError((error) => protocolError(`OMP session state unreadable: ${error.message}`)),
        Effect.filterOrFail(
          (state) => state.isStreaming !== true && state.isCompacting !== true,
          () => busyError(action),
        ),
      );
    const treeError = (action: string) => (error: { readonly message: string }) =>
      protocolError(`OMP could not ${action}: ${error.message}`);

    /**
     * Rewinds to the end of the target turn: `branch` to the user message of the first turn left
     * out, which moves the session onto a new file holding everything before it. The thread
     * follows the new file, and the conversation is re-read from it.
     */
    const rollbackThread = Effect.fnUntraced(function* (
      rollbackInput: ProviderAdapter.ProviderAdapterV2RollbackThreadInput,
    ) {
      // A thread whose process was stopped (idle, server restart) comes back unbound: bind it to
      // its recorded session first, as a turn would (docs/omp/sessions.md).
      const bound =
        mapper.providerThread ??
        (yield* bindThread(
          rollbackInput.providerThread.appThreadId ?? input.threadId,
          rollbackInput.providerThread,
        ));
      if (bound.id !== rollbackInput.providerThread.id) {
        return yield* protocolError("OMP rewind requested for a thread this session does not run");
      }
      const target = rollbackInput.target;
      const dropped = ompDroppedTurns(
        target.type === "thread_start" ? 0 : target.providerTurn.ordinal,
        rollbackInput.providerThreadTurns.filter((turn) => turn.providerThreadId === bound.id),
      );
      yield* claimSessionChange("rewind");
      return yield* Effect.gen(function* () {
        yield* assertSessionIdle("rewind");
        const cut = yield* resolveOmpCut({
          process,
          dropped,
          timeoutMs: TREE_READ_TIMEOUT_MS,
        }).pipe(Effect.mapError(treeError("find the turn to rewind to")));
        let restoredText: string | null = null;
        if (cut.entryId !== null) {
          const result = yield* process
            .request("branch", { entryId: cut.entryId }, { timeoutMs: SESSION_CHANGE_TIMEOUT_MS })
            .pipe(Effect.mapError(sessionChangeError("rewind")));
          if (result.cancelled) {
            return yield* protocolError("An OMP extension cancelled the rewind");
          }
          restoredText = result.text;
          sessionLeaf = undefined;
        }
        // `branch` has moved OMP on: from here a failed read must not fail the rewind, or T3 would
        // keep the turns OMP dropped. The next turn's `get_state` adopts and records the file.
        const optional = <A, E extends { readonly message: string }>(
          what: string,
          effect: Effect.Effect<A, E>,
        ) =>
          effect.pipe(
            Effect.tapError((error) =>
              Effect.logWarning(`omp rewind: could not ${what}`, { detail: error.message }),
            ),
            Effect.option,
          );
        const state = yield* optional(
          "read the rewound session",
          process.request("get_state", undefined, { timeoutMs: SESSION_CHANGE_TIMEOUT_MS }),
        );
        if (Option.isSome(state)) {
          yield* exclusive(
            Effect.gen(function* () {
              yield* emit(mapper.adoptSession(state.value.sessionId, yield* DateTime.now));
            }),
          );
          yield* recordSession(state.value);
        }
        const kept = yield* optional(
          "list the rewound session's messages",
          process.request("get_branch_messages", undefined, { timeoutMs: TREE_READ_TIMEOUT_MS }),
        );
        if (
          cut.entryId !== null &&
          Option.isSome(kept) &&
          kept.value.messages.some((message) => message.entryId === cut.entryId)
        ) {
          yield* Effect.logWarning("omp rewind: OMP kept the message it was to remove", {
            entryId: cut.entryId,
          });
        }
        const tree = yield* optional(
          "read the rewound session tree",
          process.request("get_tree", undefined, { timeoutMs: TREE_READ_TIMEOUT_MS }),
        );
        if (Option.isSome(tree)) sessionLeaf = tree.value.leafId;
        const sessionId = Option.isSome(state)
          ? state.value.sessionId
          : (bound.nativeThreadRef?.nativeId ?? "");
        const messages = yield* optional(
          "re-read the rewound conversation",
          readHistory(input.threadId, sessionId),
        );
        return {
          providerThread: mapper.providerThread ?? bound,
          providerTurns: [],
          messages: Option.getOrElse(messages, () => []),
          runtimeRequests: [],
          providerPayload: {
            sessionId,
            sessionFile: Option.isSome(state) ? (state.value.sessionFile ?? null) : null,
            /** The user message the rewind removed, for the composer to offer again. */
            restoredText,
            /** The user messages the session keeps, each a point a later rewind can go back to. */
            branchMessages: Option.isSome(kept) ? kept.value.messages : null,
            branchTree: Option.isSome(tree) ? ompBranchTree(tree.value) : null,
          },
        } satisfies ProviderAdapter.ProviderAdapterV2ThreadSnapshot;
      }).pipe(Effect.ensuring(releaseSessionChange));
    });

    /**
     * Forks another thread's session into this one, which T3 opened for the fork and has not run
     * yet. The process opens the source's file and `fork` writes a new file holding the source
     * through the fork turn, in the same bucket; the source thread and its file stay as they were.
     */
    const forkThread = Effect.fnUntraced(function* (
      forkInput: ProviderAdapter.ProviderAdapterV2ForkThreadInput,
    ) {
      if (forkInput.targetThreadId !== input.threadId) {
        return yield* protocolError(
          "An OMP fork must go into the thread this session was opened for",
        );
      }
      if (mapper.providerThread !== null) {
        return yield* protocolError("This OMP session already runs a thread; a fork needs its own");
      }
      const source = forkInput.sourceProviderThread;
      const sourceSessionId = source.nativeThreadRef?.nativeId;
      if (sourceSessionId == null) {
        return yield* protocolError("The thread to fork has no OMP session yet");
      }
      const sourceTurns = (forkInput.sourceProviderTurns ?? []).filter(
        (turn) => turn.providerThreadId === source.id,
      );
      const forkTurn = sourceTurns.find((turn) => turn.id === forkInput.providerTurnId);
      if (forkInput.providerTurnId !== undefined && forkTurn === undefined) {
        return yield* protocolError(
          `The turn to fork from (${forkInput.providerTurnId}) is unknown`,
        );
      }
      // The source's own process writes its file while a turn runs there.
      const sourceThreadId = source.appThreadId ?? undefined;
      const live =
        sourceThreadId === undefined ? undefined : options.threadSessions.get(sourceThreadId);
      if (live?.isBusy() === true) return yield* busyError("fork");
      if (live !== undefined) yield* assertSessionIdle("fork", live.process);

      yield* claimSessionChange("fork");
      const forked = Effect.gen(function* () {
        const opened = yield* withFiles(
          switchOmpSession({
            ...binding,
            threadId: sourceThreadId ?? input.threadId,
            sessionId: sourceSessionId,
          }),
        ).pipe(Effect.mapError(treeError(`open the session ${sourceSessionId} to fork`)));
        const dropped =
          forkTurn === undefined ? [] : ompDroppedTurns(forkTurn.ordinal, sourceTurns);
        const cut = yield* resolveOmpCut({
          process,
          dropped,
          timeoutMs: TREE_READ_TIMEOUT_MS,
        }).pipe(Effect.mapError(treeError("find the turn to fork from")));
        const forkEntry =
          cut.entryId === null
            ? undefined
            : yield* resolveOmpForkEntry({
                process,
                cut: { ...cut, entryId: cut.entryId },
                timeoutMs: TREE_READ_TIMEOUT_MS,
              }).pipe(Effect.mapError(treeError("find where to fork")));
        const { cancelled } =
          forkEntry === null
            ? // Nothing before the cut: the fork starts empty, as a child of the source.
              yield* process
                .request(
                  "new_session",
                  { parentSession: opened.sessionFile ?? sourceSessionId },
                  { timeoutMs: SESSION_CHANGE_TIMEOUT_MS },
                )
                .pipe(Effect.mapError(sessionChangeError("fork")))
            : yield* process
                .request("fork", forkEntry === undefined ? {} : { entryId: forkEntry }, {
                  timeoutMs: SESSION_CHANGE_TIMEOUT_MS,
                })
                .pipe(Effect.mapError(sessionChangeError("fork")));
        if (cancelled) return yield* protocolError("An OMP extension cancelled the fork");
        const state = yield* process
          .request("get_state", undefined, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS })
          .pipe(Effect.mapError(treeError("read the forked session")));
        if (state.sessionId === opened.sessionId || state.sessionFile === opened.sessionFile) {
          return yield* protocolError("OMP did not write a new session file for the fork");
        }
        return state;
      }).pipe(
        // Never leave this process on the source's file: two processes would write it.
        Effect.onError(() =>
          process
            .request("new_session", {}, { timeoutMs: SESSION_CHANGE_TIMEOUT_MS })
            .pipe(Effect.ignore),
        ),
      );
      return yield* Effect.gen(function* () {
        const state = yield* forked;
        sessionLeaf = undefined;
        const now = yield* DateTime.now;
        const result = yield* exclusive(
          Effect.gen(function* () {
            const bound = mapper.bindThread(
              {
                threadId: forkInput.targetThreadId,
                state,
                existing: {
                  ...source,
                  id: IdAllocator.derive.providerThread({
                    driver: OMP_PROVIDER,
                    nativeThreadId: state.sessionId,
                  }),
                  appThreadId: forkInput.targetThreadId,
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: options.instanceId,
                  ownerNodeId: forkInput.ownerNodeId ?? null,
                  nativeConversationHeadRef: null,
                  firstRunOrdinal: null,
                  lastRunOrdinal: null,
                  handoffIds: [],
                  pendingBackgroundTasks: [],
                  forkedFrom: {
                    providerThreadId: source.id,
                    ...(forkInput.providerTurnId === undefined
                      ? {}
                      : { providerTurnId: forkInput.providerTurnId }),
                  },
                  createdAt: now,
                  updatedAt: now,
                },
              },
              now,
            );
            yield* emit(bound.events);
            return bound.providerThread;
          }),
        );
        yield* recordSession(state);
        return result;
      }).pipe(Effect.ensuring(releaseSessionChange));
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
      readThreadSnapshot: (snapshotInput) =>
        readThreadSnapshot(snapshotInput).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
                driver: OMP_PROVIDER,
                providerThreadId: snapshotInput.providerThread.id,
                cause,
              }),
          ),
        ),
      rollbackThread: (rollbackInput) =>
        rollbackThread(rollbackInput).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterRollbackThreadError({
                driver: OMP_PROVIDER,
                providerThreadId: rollbackInput.providerThread.id,
                checkpointId: rollbackInput.target.checkpointId,
                cause,
              }),
          ),
        ),
      forkThread: (forkInput) =>
        forkThread(forkInput).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterForkThreadError({
                driver: OMP_PROVIDER,
                providerThreadId: forkInput.sourceProviderThread.id,
                cause,
              }),
          ),
        ),
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
