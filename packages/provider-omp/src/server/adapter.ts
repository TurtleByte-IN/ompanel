import type {
  ChatAttachment,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderSession,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderHostTools from "@t3tools/provider-core/server/ProviderHostTools";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  t3AcpPromptWithInstructions,
  type T3AcpInstructionState,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import {
  isProviderNativeImageAttachment,
  providerMessageTextWithAttachmentPaths,
} from "@t3tools/provider-core/server/attachmentPrompt";
import {
  type ProviderSelectionTransitionInput,
  turnScopedSelectionTransition,
} from "@t3tools/provider-core/server/selectionTransition";
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

import type {
  Goal,
  GoalResult,
  ImageContent,
  RpcServerFrame,
  SessionState,
} from "../../contract/src/wire.generated.ts";
import { type OmpGoalCommand, parseOmpGoalCommand } from "../composer.ts";
import { OMP_GUARDED_KEYS } from "../configForm.ts";
import type { OmpCommandHooks } from "./commands.ts";
import { OMP_GOAL_BUDGET_REPLY, ompGoalReply } from "./goal.ts";
import { makeOmpHostBridge } from "./hostTools.ts";
import {
  isOmpRunYield,
  makeOmpJournalWriter,
  ompJournalDetachedEntry,
  ompJournalDetachedTail,
  ompJournalEventsEntry,
  ompJournalOpenEntry,
  ompJournalPath,
  ompRunOutcome,
  OmpDetachedRun,
  OmpJournaledMapper,
  OmpJournaledSubagents,
  OmpJournaledUiRequests,
  OmpJournalRecorder,
  OmpToolUpdateCoalescer,
  readOmpJournalTail,
} from "./journal.ts";
import { ompApprovalModeFor } from "./launch.ts";
import { isOmpExtensionStatusRequest, OMP_PROVIDER, type OmpTurnOutcome } from "./mapper.ts";
import {
  isOmpProposalGone,
  isOmpProposalNotPending,
  OMP_RESOLVE_PROPOSAL_TIMEOUT_MS,
  ompProposalsResolvable,
  requestResolveProposal,
} from "./proposals.ts";
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
import {
  OMP_DEFAULT_MODEL_SLUG,
  ompRoleOverlayValue,
  parseOmpModelSlug,
  readOmpTraitSelection,
} from "./modelTraits.ts";
import { ompOverlayValue, ompOverlayWith } from "./settingsEngine.ts";
import {
  type OmpThreadSessions,
  readOmpThreadOverlay,
  writeOmpThreadOverlay,
} from "./threadSessions.ts";
import type { OmpSidecarError } from "./sidecar.ts";
import {
  isOmpCancelRequest,
  isOmpDialogRequest,
  type OmpCancelRequest,
  type OmpDialogRequest,
} from "./uiRequests.ts";
import { OMP_REVIVE_CONTRACT, ompSubagentControls, ompTranscriptPage } from "./subagents.ts";
import {
  ompContractLabel,
  ompErrorClass,
  ompErrorsTotal,
  ompFramesDroppedTotal,
  ompSessionsTotal,
  ompTurnsTotal,
  recordOmpMetric,
} from "./telemetry.ts";
import {
  ompGuardMismatches,
  ompGuardedToolOverlay,
  ompRefusedSlashCommand,
  type OmpReportedBuiltins,
  ompReportedBuiltins,
  ompWorkspaceTrustAvailable,
} from "./toolGuards.ts";
import { ompVibeModeAvailable } from "./vibe.ts";

/** Streamed text is held this long so a burst of deltas becomes one update. */
const STREAM_FLUSH = Duration.millis(50);
/** Reads and title syncs around a turn; a slow answer costs only the meter or the title. */
const SIDE_REQUEST_TIMEOUT_MS = 2_000;
/** OMP reloads an overlay 200 ms after it changes; its guard is confirmed for up to 3 s. */
const GUARD_CONFIRM_ATTEMPTS = 30;
const GUARD_CONFIRM_INTERVAL = Duration.millis(100);
/** Model and trait commands; `set_model` may refresh the model's metadata first. */
const SELECTION_REQUEST_TIMEOUT_MS = 10_000;
/** The overlay key the role chip writes (docs/omp/models.md). */
const ROLE_OVERLAY_KEY = "modelRoles.default";
/** Stands for the model a prewalk handoff left OMP on, which no selection names. */
const PREWALK_HANDOFF_MODEL = "\0prewalk";
/** Subagent controls wait for OMP to accept them, which can include a subagent's turn setup. */
const SUBAGENT_REQUEST_TIMEOUT_MS = 30_000;
/** Reviving rebuilds a subagent session from its transcript (models, tools, extensions). */
const SUBAGENT_REVIVE_TIMEOUT_MS = 60_000;
/** Session switches, rewinds and forks load, index and copy the whole transcript. */
const SESSION_CHANGE_TIMEOUT_MS = 60_000;
/** Reads of the session tree for a rewind or fork, which list user messages or entries. */
const TREE_READ_TIMEOUT_MS = 30_000;
/** A steer or follow-up is acknowledged once OMP admitted it (hooks, skill images included). */
const STEER_REQUEST_TIMEOUT_MS = 30_000;
/** OMP acknowledges an abort once the agent loop stopped, which can wait on a tool call. */
const ABORT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * What an `omp --mode rpc-ui` session supports. Rollback maps to OMP's `branch`, a fork to
 * `fork` (docs/omp/sessions.md); delegation reaches T3's provider-agnostic thread MCP through
 * OMP's own subagents.
 */
export const OMP_PROVIDER_CAPABILITIES = {
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
    // A forced restart (a selection change mid-turn, "interrupt and send") stops the turn and
    // starts the new attempt with `abort_and_prompt` (docs/omp/composer.md).
    supportsSteeringByInterruptRestart: true,
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
  /** The instance's launch arguments, appended to every thread's `omp --mode rpc-ui`. */
  readonly launchArgs?: ReadonlyArray<string>;
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
  /**
   * `ompVersion` on this instance's metrics (`telemetry.ts`): the pinned tag for a verified
   * sidecar, `custom` for a user-supplied binary. Defaults to `unknown`.
   */
  readonly ompVersion?: string;
  /** This instance's running thread sessions, shared with the settings engine. */
  readonly threadSessions: OmpThreadSessions;
  /** Where the instance's `omp` keeps its session files (`resolveOmpSessionsLocation`). */
  readonly sessions: OmpSessionsLocation;
  /** The instance's `/` and `$` catalog: pushed command lists in, `$skill` prompt rewrite out. */
  readonly commands?: OmpCommandHooks;
  /** Where T3 saved a message's attachment; absent, attachments are named but not sent. */
  readonly resolveAttachmentPath?: (attachment: ChatAttachment) => string | null;
  /** The text the host extracted from a saved document, named in the prompt next to it. */
  readonly resolveExtractedTextPath?:
    | ((path: string) => Effect.Effect<string | undefined>)
    | undefined;
}

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
  // The live layer inside the T3 server; elsewhere offers are dropped (the default).
  const continuations = yield* ProviderContinuationRequests.ProviderContinuationRequests;

  const withAdapterFiles = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  /** Sets one key of the thread's overlay; OMP reloads the overlay live. */
  const setOverlayKey = Effect.fnUntraced(function* (
    threadId: string,
    key: string,
    value: unknown,
  ) {
    const current = yield* withAdapterFiles(readOmpThreadOverlay(options.dirs.threads, threadId));
    if (ompOverlayValue(current, key) === value) return;
    const next = yield* ompOverlayWith(current, key, value);
    yield* withAdapterFiles(writeOmpThreadOverlay(options.dirs.threads, threadId, next));
  });

  /**
   * `modelRoles.default: "@<role>"` for a role other than default. Back on default, only a role
   * alias (which Ompanel wrote) is removed; a model a settings override put there stays.
   */
  const syncRoleOverlay = Effect.fnUntraced(function* (
    threadId: string,
    role: ReturnType<typeof readOmpTraitSelection>["role"],
  ) {
    const wanted = ompRoleOverlayValue(role);
    if (wanted === undefined) {
      const current = yield* withAdapterFiles(readOmpThreadOverlay(options.dirs.threads, threadId));
      const present = ompOverlayValue(current, ROLE_OVERLAY_KEY);
      if (typeof present !== "string" || !present.startsWith("@")) return;
    }
    yield* setOverlayKey(threadId, ROLE_OVERLAY_KEY, wanted);
  });

  /** Whether this instance's OMP honours `workspace.trusted` and reports the guard in `get_state`. */
  const workspaceTrustAvailable = ompWorkspaceTrustAvailable(options.expectedContractVersion);

  /**
   * Pins the browser and computer-use preludes to the thread's permission mode, and
   * `workspace.trusted` to its project's trust, in its overlay (toolGuards.ts). Returns the
   * values written.
   */
  const syncToolGuard = Effect.fnUntraced(function* (
    threadId: string,
    runtimeMode: ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"],
    computer: boolean | undefined,
    trusted: boolean,
  ) {
    const wanted = ompGuardedToolOverlay(
      runtimeMode,
      computer,
      workspaceTrustAvailable ? trusted : undefined,
    );
    const current = yield* withAdapterFiles(readOmpThreadOverlay(options.dirs.threads, threadId));
    let next = current;
    for (const key of OMP_GUARDED_KEYS) {
      if (ompOverlayValue(next, key) !== wanted[key]) {
        next = yield* ompOverlayWith(next, key, wanted[key]);
      }
    }
    if (next !== current) {
      yield* withAdapterFiles(
        writeOmpThreadOverlay(options.dirs.threads, threadId, next, { ownsGuardKeys: true }),
      );
    }
    return wanted;
  });

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
    const ompVersion = options.ompVersion ?? "unknown";
    const recordStartFailure = (error: unknown) =>
      recordOmpMetric(ompSessionsTotal, {
        ompVersion,
        ompContract: "unknown",
        outcome: "failed",
        errorClass: ompErrorClass(error),
      });
    const binaryPath = yield* options.resolveBinary.pipe(
      Effect.tapError(recordStartFailure),
      Effect.mapError(openError),
    );
    // The role chip is read at startup, so the overlay must hold it before the process starts.
    yield* syncRoleOverlay(input.threadId, readOmpTraitSelection(input.modelSelection).role).pipe(
      Effect.mapError(openError),
    );
    // The preludes are advertised from the first system prompt, and project MCP servers and
    // extensions load at start, so the guard holds before start.
    const startedTrusted = input.runtimePolicy.workspaceTrusted === true;
    yield* syncToolGuard(
      input.threadId,
      input.runtimePolicy.runtimeMode,
      readOmpTraitSelection(input.modelSelection).computer,
      startedTrusted,
    ).pipe(Effect.mapError(openError));
    // An older OMP would reject the key, so it stays out: say so, without the workspace path.
    if (!workspaceTrustAvailable && !startedTrusted) {
      yield* Effect.logWarning("OMP does not enforce this project's untrusted workspace", {
        contractVersion: options.expectedContractVersion,
        requiredContractVersion: "1.9.0",
      });
    }
    const process = yield* startOmpSessionProcess({
      binaryPath,
      profile: options.profile,
      ...(options.launchArgs === undefined ? {} : { launchArgs: options.launchArgs }),
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
      Effect.tapError(recordStartFailure),
      Effect.mapError(openError),
    );
    // Version labels only: never content, paths or secrets (PRD §9, telemetry.ts).
    const metricBase = { ompVersion, ompContract: ompContractLabel(process.contractVersion) };
    yield* recordOmpMetric(ompSessionsTotal, { ...metricBase, outcome: "started" });

    const scope = yield* Effect.scope;
    // The journal (journal.ts, docs/omp/journal.md). A run the previous process saw start while
    // no turn was attached, and no turn took, is carried over for this process's next turn.
    const journalFile = ompJournalPath(path, options.dirs.threads, input.threadId);
    const carried = ompJournalDetachedTail(
      (yield* readOmpJournalTail(journalFile).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
      )).entries,
    );
    const journal = yield* makeOmpJournalWriter(journalFile).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const recorder = new OmpJournalRecorder(journal.record);
    const hostBridge = yield* makeOmpHostBridge({
      process,
      threadId: input.threadId,
      cwd,
      hostTools,
      readMcpSession:
        mcpSessions === undefined
          ? // @effect-diagnostics-next-line effectSucceedWithVoid:off - A missing MCP session is undefined, not void.
            Effect.succeed(undefined)
          : mcpSessions.read(input.threadId),
    });
    const now = yield* DateTime.now;
    const mapper = new OmpJournaledMapper(
      {
        instanceId: options.instanceId,
        proposalsResolvable: ompProposalsResolvable(process.contractVersion),
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
      },
      recorder,
    );
    recorder.record(
      ompJournalOpenEntry({
        threadId: input.threadId,
        instanceId: options.instanceId,
        contractVersion: process.contractVersion,
        providerSession: mapper.providerSession,
        now,
      }),
    );
    const uiRequests = new OmpJournaledUiRequests(
      { providerSessionId: input.providerSessionId },
      recorder,
    );
    /** OMP's answer deadlines, by native request id. */
    const dialogTimers = new Map<string, Fiber.Fiber<void>>();
    const subagentControls = ompSubagentControls(process.contractVersion);
    const subagents = new OmpJournaledSubagents(
      { instanceId: options.instanceId, controls: subagentControls },
      recorder,
    );
    /** A run OMP started with no turn attached, waiting for one (see `offerWake`). */
    const detached = new OmpDetachedRun();
    /** A parked job keeps updating its tool while the run waits: those lines are thinned. */
    const detachedUpdates = new OmpToolUpdateCoalescer();
    const recordDetached = (frame: { readonly type: string }, at: DateTime.Utc) => {
      const entry = ompJournalDetachedEntry(frame, at);
      for (const line of detachedUpdates.admit(frame, entry, DateTime.toEpochMillis(at))) {
        journal.record(line);
      }
    };
    detached.adopt(carried);
    for (const frame of carried) recordDetached(frame, now);
    /** The continuation T3 was asked for, until a turn takes the run or T3 declines it. */
    let wake: object | null = null;
    /** The last `prompt_result` said a background job can still wake the session. */
    let awaitingWake = false;
    /** The active turn is a continuation: no prompt, the run's yield ends it. */
    let autonomousTurn = false;
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
    /** The builtins OMP last listed for this session (toolGuards.ts `ompReportedBuiltins`). */
    let reportedBuiltins: OmpReportedBuiltins = {};
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
      autonomousTurn = false;
      yield* recordOmpMetric(ompTurnsTotal, {
        ...metricBase,
        outcome: outcome.status,
        ...(outcome.status === "failed" ? { errorClass: outcome.failure.class } : {}),
      });
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
        yield* recordOmpMetric(ompFramesDroppedTotal, {
          ...metricBase,
          reason: "dialog_unanswerable",
        });
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

    /** A Stop is waiting for `abort_and_restore_queue`; the turn's end waits with it. */
    let stopInFlight = false;
    let deferredSettle: OmpTurnOutcome | null = null;

    /** Feeds one frame to the active turn (or to nothing, outside one) and settles it when due. */
    const mapFrame = Effect.fnUntraced(function* (frame: { readonly type: string }) {
      const result = mapper.handleFrame(frame, yield* DateTime.now);
      yield* emit(result.events);
      if (result.dropped !== null) {
        yield* recordOmpMetric(ompFramesDroppedTotal, { ...metricBase, reason: result.dropped });
      }
      if (result.streaming && !flushScheduled) {
        flushScheduled = true;
        yield* scheduleFlush;
      }
      // The idle check's reply is echoed too, so it lands after every frame before it.
      if (result.confirmIdle) {
        yield* process
          .request("get_state", undefined, {
            timeoutMs: SIDE_REQUEST_TIMEOUT_MS,
            echoResponse: true,
          })
          .pipe(
            Effect.catch(() =>
              exclusive(
                Effect.gen(function* () {
                  const outcome = mapper.steerLost();
                  if (outcome !== null) yield* finalize(outcome, true);
                }),
              ),
            ),
            Effect.ignore,
            Effect.forkIn(scope),
          );
      }
      // A continuation has no prompt, so no `prompt_result`: the run's yield ends it.
      const settledTurn =
        result.settled ??
        (autonomousTurn && mapper.hasActiveTurn && isOmpRunYield(frame)
          ? ompRunOutcome(frame)
          : null);
      if (settledTurn === null) return;
      // A Stop waiting for OMP's answer ends the turn once it has it (`interruptTurn`).
      if (stopInFlight) deferredSettle = settledTurn;
      else yield* finalize(settledTurn, true);
    });

    /**
     * Asks T3 to run a continuation turn for the detached run (`adapter_buffered`: the turn
     * replays what OMP already sent). Needs a bound thread; one bound later asks then.
     */
    const offerWake = Effect.fnUntraced(function* () {
      const thread = mapper.providerThread;
      const appThreadId = thread?.appThreadId;
      if (thread == null || appThreadId == null || wake !== null || !detached.pending) return;
      const current = {};
      wake = current;
      yield* Effect.logInfo("omp started a run on its own; asking for a continuation", {
        providerThreadId: thread.id,
      });
      yield* continuations.offer({
        threadId: appThreadId,
        providerThreadId: thread.id,
        driver: OMP_PROVIDER,
        detail: null,
        // A user turn may have taken the run meanwhile; then nothing is left to continue.
        dispatchIfCurrent: (dispatch) =>
          wake === current && detached.pending ? Effect.asSome(dispatch) : Effect.succeedNone,
        clearIfCurrent: () =>
          Effect.sync(() => {
            if (wake === current) wake = null;
          }),
      });
    });

    const handleFrame = Effect.fnUntraced(function* (frame: RpcServerFrame) {
      if (isOmpDialogRequest(frame) || isOmpCancelRequest(frame)) {
        return yield* handleDialogFrame(frame);
      }
      // Only the fact: the extension's path and message stay out of telemetry.
      if (frame.type === "extension_error") {
        yield* recordOmpMetric(ompErrorsTotal, { ...metricBase, errorClass: "extension" });
      }
      if (frame.type === "subagent_lifecycle" || frame.type === "subagent_progress") {
        yield* emit(subagents.handleFrame(frame, mapper.subagentScope, yield* DateTime.now));
        return;
      }
      if (frame.type === "available_commands_update") {
        reportedBuiltins = ompReportedBuiltins(frame.commands);
        if (options.commands !== undefined) {
          yield* options.commands.onAvailableCommands(cwd, frame.commands);
        }
        return;
      }
      // Goal mode is session state, not turn output: it changes inside and between turns.
      if (frame.type === "goal_updated") {
        yield* emit(mapper.applyGoal(frame.goal ?? null, yield* DateTime.now));
        return;
      }
      // So are extension status lines and widgets: the strip updates with no turn, at once.
      if (isOmpExtensionStatusRequest(frame)) {
        yield* emit(mapper.applyExtensionStatus(frame, yield* DateTime.now));
        return;
      }
      if (yield* hostBridge.handleFrame(frame)) return;
      if (frame.type === "prompt_result") awaitingWake = frame.sessionSettled === false;
      if (frame.type === "session_settled") awaitingWake = false;
      // A run OMP started with no turn attached waits for one instead of being dropped.
      if (!mapper.hasActiveTurn && !sessionChanging && detached.accepts(frame)) {
        detached.push(frame);
        recordDetached(frame, yield* DateTime.now);
        if (frame.type === "agent_start") yield* offerWake();
        return;
      }
      yield* mapFrame(frame);
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
      // So do staged edit previews: OMP keeps them in memory only.
      yield* emit(mapper.settleProposals(yield* DateTime.now));
      // And extension status lines: the extensions that set them are gone.
      yield* emit(mapper.clearExtensionStatus(yield* DateTime.now));
      yield* emit(mapper.setSessionStatus(status, lastError, yield* DateTime.now));
      yield* Queue.end(events);
    });
    // Frames are drained so the process never blocks on a full pipe. Only frame types are
    // logged, never content. Collab room frames (`collab_*`) change nothing the thread shows and
    // a room's links are capabilities, so they never reach the mapper or the journal.
    yield* process.frames.pipe(
      Stream.runForEach((frame) =>
        Effect.logDebug("omp frame", { type: frame.type }).pipe(
          Effect.andThen(
            String(frame.type).startsWith("collab_") ? Effect.void : exclusive(handleFrame(frame)),
          ),
        ),
      ),
      Effect.matchEffect({
        onFailure: (error) =>
          recordOmpMetric(ompErrorsTotal, { ...metricBase, errorClass: ompErrorClass(error) }).pipe(
            Effect.andThen(exclusive(settle("error", error.message))),
          ),
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
      // Accept or Reject on a card; the card follows once OMP answers, ordered with frames.
      resolveProposal: Effect.fn("OmpAdapter.resolveProposal")(function* (request) {
        const answer = yield* requestResolveProposal(process, request, {
          timeoutMs: OMP_RESOLVE_PROPOSAL_TIMEOUT_MS,
        }).pipe(
          // Gone: the card stops offering and leaves the staged list. Held by another resolve, or
          // unanswered: it stops offering but stays staged, so the agent's result settles it.
          Effect.tapError((error) =>
            isOmpProposalNotPending(error) || error._tag === "OmpRpcTimeoutError"
              ? exclusive(
                  Effect.gen(function* () {
                    if (settled) return;
                    const now = yield* DateTime.now;
                    yield* emit(
                      isOmpProposalGone(error)
                        ? mapper.resolveProposal(request.toolCallId, "proposed", now)
                        : mapper.withdrawProposalOffer(request.toolCallId, now),
                    );
                  }),
                )
              : Effect.void,
          ),
        );
        yield* exclusive(
          Effect.gen(function* () {
            if (settled) return;
            const state = answer.action === "apply" ? "applied" : "discarded";
            yield* emit(mapper.resolveProposal(request.toolCallId, state, yield* DateTime.now));
          }),
        );
        return answer;
      }),
    });
    // Before the first turn, so its tools and directory handling are in place.
    yield* hostBridge.setup;

    /** What OMP runs: the launch model until a `set_model`, then each pick OMP accepted. */
    let appliedModel: string = OMP_DEFAULT_MODEL_SLUG;
    /** The model OMP started the session on, restored when the thread goes back to default. */
    let baselineModel: { readonly provider: string; readonly modelId: string } | undefined;
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
      // The process's own fresh session runs the model OMP's config (and the role chip's
      // overlay) resolves at launch: OMP default for this thread.
      if (state.model !== undefined) {
        baselineModel = { provider: state.model.provider, modelId: state.model.id };
      }
      const nativeId = existing?.nativeThreadRef?.nativeId;
      if (nativeId != null && nativeId !== state.sessionId) {
        state = yield* withFiles(switchOmpSession({ ...binding, sessionId: nativeId })).pipe(
          Effect.mapError((error) =>
            protocolError(`OMP session ${nativeId} could not be resumed: ${error.message}`),
          ),
        );
        // A resumed session reloads the model it recorded, which need not be OMP default.
        if (
          state.model !== undefined &&
          (state.model.provider !== baselineModel?.provider ||
            state.model.id !== baselineModel?.modelId)
        ) {
          appliedModel = `${state.model.provider}/${state.model.id}`;
        }
      }
      const result = mapper.bindThread(
        { threadId, state, ...(existing === undefined ? {} : { existing }) },
        yield* DateTime.now,
      );
      yield* emit(result.events);
      yield* recordSession(state);
      // A run the previous process left waiting reattaches once the thread is known again.
      yield* offerWake();
      if (existing?.lastRunOrdinal === null && (state.messageCount ?? 0) > 0) {
        const sessionId = state.sessionId;
        yield* readHistory(threadId, sessionId).pipe(
          Effect.flatMap((messages) => {
            const imported = messages.map((message) => ({
              type: "message.updated" as const,
              driver: OMP_PROVIDER,
              message,
            }));
            recorder.record(ompJournalEventsEntry(imported));
            return emit(imported);
          }),
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

    /**
     * Before every turn, re-pins the guard keys from the overlay on disk (no cache), then on
     * contract 1.9.0 waits until `get_state` reports them; either failing ends the turn before its
     * prompt. Project MCP servers and extensions load only at start, so a trust change restarts OMP.
     */
    const applyToolGuard = Effect.fnUntraced(function* (
      threadId: string,
      runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
      modelSelection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"],
    ) {
      const computer = readOmpTraitSelection(modelSelection).computer;
      const restricted = runtimePolicy.runtimeMode !== "full-access";
      const trusted = runtimePolicy.workspaceTrusted === true;
      const wanted = yield* syncToolGuard(
        threadId,
        runtimePolicy.runtimeMode,
        computer,
        trusted,
      ).pipe(
        Effect.catch((error) =>
          restricted || (workspaceTrustAvailable && !trusted)
            ? Effect.fail(
                protocolError(
                  `OMP's overlay could not be written for this permission mode and project trust: ${error.message}`,
                  restricted ? "tool_guard_unapplied" : "workspace_trust_unapplied",
                ),
              )
            : traitRefused("computer")(error).pipe(Effect.as(undefined)),
        ),
      );
      if (!workspaceTrustAvailable || wanted === undefined) return;
      if (trusted !== startedTrusted) {
        // The overlay now holds the new trust; the process the next turn opens starts with it.
        yield* process.close().pipe(Effect.ignore, Effect.forkIn(scope));
        return yield* protocolError(
          "This project's trust changed after OMP started; OMP restarts to load or drop the project's own agent config. Send the message again.",
          "workspace_trust_changed",
        );
      }
      let mismatched = ompGuardMismatches(wanted, {});
      for (let attempt = 0; attempt < GUARD_CONFIRM_ATTEMPTS; attempt++) {
        const state: unknown = yield* process
          .request("get_state", undefined, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS })
          .pipe(Effect.orElseSucceed(() => ({})));
        mismatched = ompGuardMismatches(wanted, state);
        if (mismatched.length === 0) return;
        yield* Effect.sleep(GUARD_CONFIRM_INTERVAL);
      }
      return yield* protocolError(
        `OMP did not apply ${mismatched.join(", ")} from the thread's overlay`,
        mismatched.includes("workspace.trusted")
          ? "workspace_trust_unapplied"
          : "tool_guard_unapplied",
      );
    });

    const applied: {
      thinking?: string;
      fastMode?: boolean;
      advisor?: boolean;
      prewalk?: boolean;
      vibe?: boolean;
    } = {};
    const selectionError = (command: string) => (error: OmpRpcRequestError) =>
      protocolError(
        `OMP ${command} failed: ${error._tag === "OmpRpcCommandError" ? error.detail : error.message}`,
      );
    /** A trait OMP refused (fast mode on a model without it) leaves the turn running. */
    const traitRefused = (trait: string) => (error: unknown) =>
      Effect.logWarning("omp trait not applied", {
        trait,
        detail: error instanceof Error ? error.message : String(error),
      });

    /**
     * Brings OMP to the turn's model and traits before its prompt. T3 owns the selection, so it
     * is re-applied by value, never by OMP's `cycle_*` commands (docs/omp/models.md).
     */
    const applySelection = Effect.fnUntraced(function* (
      modelSelection: ProviderAdapter.ProviderAdapterV2TurnInput["modelSelection"],
    ) {
      const traits = readOmpTraitSelection(modelSelection);
      if (traits.model !== appliedModel) {
        const target =
          traits.model === OMP_DEFAULT_MODEL_SLUG ? baselineModel : parseOmpModelSlug(traits.model);
        if (target === undefined && traits.model !== OMP_DEFAULT_MODEL_SLUG) {
          return yield* protocolError(`OMP model '${traits.model}' must be provider/model`);
        }
        if (target !== undefined) {
          yield* process
            .request("set_model", target, { timeoutMs: SELECTION_REQUEST_TIMEOUT_MS })
            .pipe(Effect.mapError(selectionError("set_model")));
          // OMP re-applies the new model's own thinking level, and fast mode is per model
          // family: both are re-sent for the new model.
          delete applied.thinking;
          delete applied.fastMode;
        }
        appliedModel = traits.model;
      }
      if (traits.thinking !== undefined && traits.thinking !== applied.thinking) {
        yield* process
          .request(
            "set_thinking_level",
            { level: traits.thinking },
            { timeoutMs: SELECTION_REQUEST_TIMEOUT_MS },
          )
          .pipe(Effect.mapError(selectionError("set_thinking_level")));
        applied.thinking = traits.thinking;
      }
      if (traits.fastMode !== undefined && traits.fastMode !== applied.fastMode) {
        const enabled = traits.fastMode;
        yield* process
          .request("set_fast_mode", { enabled }, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS })
          .pipe(
            Effect.tap(() => Effect.sync(() => (applied.fastMode = enabled))),
            Effect.catch(traitRefused("fastMode")),
          );
      }
      if (traits.advisor !== undefined && traits.advisor !== applied.advisor) {
        const enabled = traits.advisor;
        yield* process
          .request("set_advisor", { enabled }, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS })
          .pipe(
            Effect.tap(() => Effect.sync(() => (applied.advisor = enabled))),
            Effect.catch(traitRefused("advisor")),
          );
      }
      // A handoff is spent by the turn it ran on, so an armed prewalk is re-armed every turn.
      if (traits.prewalk === true || (traits.prewalk === false && applied.prewalk === true)) {
        const armed = traits.prewalk;
        yield* process
          .request("set_prewalk", { armed }, { timeoutMs: SIDE_REQUEST_TIMEOUT_MS })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                applied.prewalk = armed;
                // OMP's handoff switches the model for good; the next turn restores the pick.
                if (armed) appliedModel = PREWALK_HANDOFF_MODEL;
              }),
            ),
            Effect.catch(traitRefused("prewalk")),
          );
      }
      // `set_vibe_mode` arrived with OMP_VIBE_CONTRACT; older sidecars run vibe mode only in
      // their TUI, and the composer does not offer the trait for them.
      if (
        traits.vibe !== undefined &&
        traits.vibe !== applied.vibe &&
        ompVibeModeAvailable(process.contractVersion)
      ) {
        const enabled = traits.vibe;
        yield* process
          .request("set_vibe_mode", { enabled }, { timeoutMs: SELECTION_REQUEST_TIMEOUT_MS })
          .pipe(
            Effect.tap((result) =>
              Effect.gen(function* () {
                applied.vibe = result.enabled;
                if (result.enabled) return;
                // Leaving vibe mode kills every worker; a killed worker may send no final frame.
                const now = yield* DateTime.now;
                for (const id of subagents.liveVibeWorkerIds()) {
                  const ended = { type: "subagent_lifecycle", payload: { id, status: "aborted" } };
                  yield* emit(subagents.handleFrame(ended, mapper.subagentScope, now));
                }
              }),
            ),
            Effect.catch(traitRefused("vibe")),
          );
      }
    });

    /**
     * A message as OMP takes it (`prompt`, `steer`, `follow_up`, `abort_and_prompt`): the text,
     * with every attachment named by its saved path, and image attachments as image blocks.
     */
    const promptPayload = Effect.fnUntraced(function* (
      text: string,
      attachments: ReadonlyArray<ChatAttachment>,
    ) {
      const resolvePath = options.resolveAttachmentPath ?? (() => null);
      const images: Array<ImageContent> = [];
      for (const attachment of attachments) {
        if (!isProviderNativeImageAttachment(attachment)) continue;
        const path = resolvePath(attachment);
        if (path === null) continue;
        const bytes = yield* fileSystem
          .readFile(path)
          .pipe(
            Effect.mapError((error) =>
              protocolError(`Attachment ${attachment.name} could not be read: ${error.message}`),
            ),
          );
        images.push({
          type: "image",
          data: Buffer.from(bytes).toString("base64"),
          mimeType: attachment.mimeType,
        });
      }
      const message = yield* providerMessageTextWithAttachmentPaths({
        text,
        attachments,
        resolveAttachmentPath: resolvePath,
        resolveExtractedTextPath: options.resolveExtractedTextPath,
      });
      return images.length === 0 ? { message } : { message, images };
    });

    /**
     * The interaction mode OMP last heard about. RPC has no plan mode (`/plan` is TUI-only), so
     * Plan reaches OMP as an instruction on the first prompt after each mode change. Every
     * process starts from Default, so default-mode prompts stay verbatim in the session.
     */
    let instructionState: T3AcpInstructionState = { interactionMode: "default", hasT3Mcp: false };
    /** The run and attempt of the last turn, to tell a restarted attempt from a new run. */
    let lastTurn: { readonly runId: string; readonly attemptId: string } | null = null;
    let appliedSessionName: string | null = null;

    /**
     * A `/goal` command other than setting a goal, run over RPC: OMP's own `/goal` is TUI-only.
     * The turn shows OMP's answer and ends without a prompt.
     */
    const runGoalCommand = Effect.fnUntraced(function* (
      turnInput: ProviderAdapter.ProviderAdapterV2TurnInput,
      command: Exclude<OmpGoalCommand, { readonly op: "create" }>,
    ) {
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
      lastTurn = { runId: turnInput.runId, attemptId: turnInput.attemptId };
      // OMP forgets a completed goal the thread still shows (`ompStateGoal`): show and drop it here.
      const shown = mapper.providerThread?.goal ?? null;
      const completed = shown?.status === "complete" ? shown : null;
      const answer:
        | { readonly text: string; readonly goal?: Goal | null }
        | { readonly error: string } =
        command.op === "budget"
          ? { text: OMP_GOAL_BUDGET_REPLY }
          : command.op === "invalid"
            ? { error: command.reason }
            : completed !== null && command.op === "get"
              ? { text: `Goal complete: ${completed.objective}` }
              : completed !== null && command.op === "drop"
                ? { text: `Goal dropped: ${completed.objective}`, goal: null }
                : yield* process
                    .request(
                      "goal",
                      { op: command.op },
                      { timeoutMs: SELECTION_REQUEST_TIMEOUT_MS },
                    )
                    .pipe(
                      Effect.map((result: GoalResult) => ({
                        text: ompGoalReply(command.op, result),
                        ...(command.op === "get" ? {} : { goal: result.goal }),
                      })),
                      Effect.catch((error: OmpRpcRequestError) =>
                        Effect.succeed({
                          error: error._tag === "OmpRpcCommandError" ? error.detail : error.message,
                        }),
                      ),
                    );
      yield* exclusive(
        Effect.gen(function* () {
          if (mapper.activeProviderTurnId !== providerTurnId) return;
          if ("error" in answer) {
            return yield* finalize(
              {
                status: "failed",
                failure: makeProviderFailure({ message: answer.error, class: "provider_error" }),
              },
              true,
            );
          }
          const now = yield* DateTime.now;
          if (answer.goal !== undefined) yield* emit(mapper.applyGoal(answer.goal, now));
          // Shown as OMP shows a builtin command's output (`command_output`).
          const output = { type: "command_output", text: answer.text };
          yield* emit(mapper.handleFrame(output, now).events);
          yield* finalize({ status: "completed" }, true);
        }),
      );
    });

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
      // T3 dispatches a continuation for a run OMP started on its own (`offerWake`).
      const isContinuation =
        turnInput.message.createdBy === "agent" && turnInput.message.creationSource === "provider";
      // OMP's `/goal` runs only in its TUI, so Ompanel runs it over RPC (docs/omp/composer.md).
      const goalCommand =
        isContinuation || turnInput.message.attachments.length > 0
          ? null
          : parseOmpGoalCommand(turnInput.message.text);
      // A goal command can resume a run, so the permission mode and its tool guard come first.
      yield* applyApprovalMode(turnInput.runtimePolicy);
      yield* applyToolGuard(turnInput.threadId, turnInput.runtimePolicy, turnInput.modelSelection);
      if (goalCommand !== null && goalCommand.op !== "create") {
        return yield* runGoalCommand(turnInput, goalCommand);
      }
      // A new goal's objective is its first prompt, as OMP's own `/goal <objective>` sends it.
      const messageText = goalCommand === null ? turnInput.message.text : goalCommand.objective;
      // OMP expands a skill only as `/skill:<name>`; the composer writes `$<name>`.
      const promptText =
        options.commands === undefined
          ? messageText
          : yield* options.commands.resolvePrompt(cwd, messageText);
      const refused = isContinuation
        ? undefined
        : ompRefusedSlashCommand(promptText, reportedBuiltins, {
            hostOwnsCwdChange: hostBridge.ownsCwdChange(),
          });
      if (refused !== undefined) return yield* protocolError(refused.detail, refused.reason);
      yield* applySelection(turnInput.modelSelection);
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
      const state: T3AcpInstructionState = {
        interactionMode: turnInput.runtimePolicy.interactionMode,
        hasT3Mcp: false,
      };
      const text = t3AcpPromptWithInstructions({
        prompt: promptText,
        state,
        previousState: instructionState,
      });
      // A leading slash command (a rewritten `$skill` too) goes out unwrapped; the mode is
      // stated on a later prompt.
      const stated =
        text !== promptText || instructionState.interactionMode === state.interactionMode;
      const payload = yield* promptPayload(text, turnInput.message.attachments);
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
          const turnId = mapper.activeProviderTurnId;
          // The turn takes a run OMP started on its own: its frames so far are this turn's first.
          // A continuation has no prompt; the run's yield, replayed here or still to come, ends it.
          wake = null;
          const run = detached.take();
          // The turn records the frames it takes; held detached lines are not needed any more.
          detachedUpdates.drain();
          autonomousTurn = isContinuation;
          let replayed = 0;
          while (replayed < run.frames.length && mapper.activeProviderTurnId === turnId) {
            yield* mapFrame(run.frames[replayed]!);
            replayed += 1;
          }
          // The run yielded inside the replay: a later run OMP started waits for its own turn.
          const next = run.frames.findIndex(
            (frame, index) => index >= replayed && frame.type === "agent_start",
          );
          if (next !== -1) {
            const now = yield* DateTime.now;
            const rest = run.frames.slice(next);
            if (run.fromPreviousProcess) detached.adopt(rest);
            else for (const frame of rest) detached.push(frame);
            for (const frame of rest) recordDetached(frame, now);
            yield* offerWake();
          }
          if (isContinuation && mapper.activeProviderTurnId === turnId) {
            if (run.frames.length === 0) {
              // A user turn took the run first: nothing is left to continue.
              yield* finalize({ status: "completed" }, true);
            } else if (run.fromPreviousProcess) {
              // The process that ran it has exited; the run cannot go on.
              yield* finalize({ status: "interrupted" }, true);
            }
          }
          return turnId;
        }),
      );
      // A continuation sends nothing: no instructions reached OMP, and no prompt to restart.
      if (isContinuation) return;
      // A credential T3 issued or replaced since the last prompt brings its MCP tools.
      yield* hostBridge.refreshMcp;
      if (stated) instructionState = state;
      // A new attempt of the last turn's run is T3 restarting it ("interrupt and send", a
      // selection change): OMP aborts whatever it still runs or holds and takes the prompt.
      const restart =
        lastTurn !== null &&
        lastTurn.runId === turnInput.runId &&
        lastTurn.attemptId !== turnInput.attemptId;
      lastTurn = { runId: turnInput.runId, attemptId: turnInput.attemptId };
      // The reply is echoed onto the frame stream, behind any `command_output` the prompt
      // produced, and settles the turn there. A prompt that never reached OMP settles here.
      const requestOptions = { timeoutMs: null, echoResponse: true } as const;
      const sent: Effect.Effect<unknown, OmpRpcRequestError> = restart
        ? process.request("abort_and_prompt", payload, requestOptions)
        : process.request("prompt", payload, requestOptions);
      // The goal starts once OMP runs its objective: created first, an `rpc` goal continuation
      // could take the idle session before the objective arrives. A refusal (goal mode off, a
      // paused goal) is noted in the turn; the objective still runs as a prompt.
      const goalCreated: Effect.Effect<void> =
        goalCommand === null
          ? Effect.void
          : process
              .request(
                "goal",
                {
                  op: "create",
                  objective: goalCommand.objective,
                  ...(goalCommand.tokenBudget === undefined
                    ? {}
                    : { token_budget: goalCommand.tokenBudget }),
                },
                { timeoutMs: SELECTION_REQUEST_TIMEOUT_MS },
              )
              .pipe(
                Effect.asVoid,
                Effect.catch((error: OmpRpcRequestError) =>
                  exclusive(
                    Effect.gen(function* () {
                      if (mapper.activeProviderTurnId !== providerTurnId) return;
                      const detail =
                        error._tag === "OmpRpcCommandError" ? error.detail : error.message;
                      const notice = {
                        type: "notice",
                        source: "Goal",
                        message: `OMP did not set the goal: ${detail}`,
                      };
                      yield* emit(mapper.handleFrame(notice, yield* DateTime.now).events);
                    }),
                  ),
                ),
              );
      yield* sent.pipe(
        Effect.andThen(() => goalCreated),
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

    const assertActiveTurn = (providerTurnId: string) =>
      mapper.activeProviderTurnId === providerTurnId
        ? Effect.void
        : Effect.fail(protocolError(`OMP turn ${providerTurnId} is not active`));

    /**
     * `steer` while the agent loop runs, `follow_up` after it. A late one still runs in OMP, so
     * the turn stays open until that run ends; replies are echoed to stay ordered with frames.
     */
    const steerTurn = Effect.fnUntraced(function* (
      steerInput: ProviderAdapter.ProviderAdapterV2SteerInput,
    ) {
      const providerTurnId = steerInput.providerTurnId;
      // A goal command is an RPC action, never text for the model (`runGoalCommand`).
      if (
        steerInput.message.attachments.length === 0 &&
        parseOmpGoalCommand(steerInput.message.text) !== null
      ) {
        return yield* protocolError(
          "Goal commands run as their own turn. Send it again once this turn ends.",
        );
      }
      const payload = yield* promptPayload(steerInput.message.text, steerInput.message.attachments);
      const followUp = yield* exclusive(
        Effect.gen(function* () {
          yield* assertActiveTurn(providerTurnId);
          mapper.steerSent();
          return mapper.agentEnded;
        }),
      );
      const requestOptions = { timeoutMs: STEER_REQUEST_TIMEOUT_MS, echoResponse: true } as const;
      yield* (
        followUp
          ? process.request("follow_up", payload, requestOptions)
          : process.request("steer", payload, requestOptions)
      ).pipe(
        // No reply reached the frame stream: the message counts as never sent.
        Effect.tapError((error) =>
          error._tag === "OmpRpcCommandError"
            ? Effect.void
            : exclusive(
                Effect.gen(function* () {
                  if (mapper.activeProviderTurnId !== providerTurnId) return;
                  const outcome = mapper.steerLost();
                  if (outcome !== null) yield* finalize(outcome, true);
                }),
              ),
        ),
        Effect.mapError(subagentRequestError),
      );
    });

    /**
     * Stop, always as `abort_and_restore_queue`: a plain `abort` lets OMP drain its queue into
     * a new run after the Stop. The turn's settlement waits for OMP's answer, whatever order
     * the answer and `prompt_result` arrive in, so the withdrawn messages are listed on the
     * stopped turn before it ends.
     */
    const interruptTurn = Effect.fnUntraced(function* (
      interruptInput: ProviderAdapter.ProviderAdapterV2InterruptInput,
    ) {
      if (mapper.activeProviderTurnId === null && interruptInput.requestRuntimeRestart === true) {
        return;
      }
      yield* exclusive(
        Effect.gen(function* () {
          yield* assertActiveTurn(interruptInput.providerTurnId);
          mapper.beginStop();
          stopInFlight = true;
        }),
      );
      const answer = yield* process
        .request("abort_and_restore_queue", undefined, { timeoutMs: ABORT_REQUEST_TIMEOUT_MS })
        .pipe(Effect.exit);
      yield* exclusive(
        Effect.gen(function* () {
          stopInFlight = false;
          const restored =
            answer._tag === "Success"
              ? {
                  steering: answer.value.steering.map((message) => message.text),
                  followUp: answer.value.followUp.map((message) => message.text),
                }
              : null;
          yield* emit(mapper.endStop(restored, yield* DateTime.now));
          const outcome =
            deferredSettle ??
            // A prompt that had finished, held for a message the Stop withdrew: nothing runs.
            // A background `/compact` or `/handoff` the Stop cancelled sends nothing more.
            (answer._tag === "Success" &&
            ((mapper.holdingOutcome && mapper.agentEnded) || mapper.awaitingCommandOutput)
              ? ({ status: "interrupted" } as const)
              : null);
          deferredSettle = null;
          if (outcome !== null) yield* finalize(outcome, true);
        }),
      );
      if (answer._tag === "Failure") {
        return yield* Effect.failCause(answer.cause).pipe(Effect.mapError(subagentRequestError));
      }
    });

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
      // A background job can still wake the session, or a run it woke waits for its turn: idle
      // release would kill the process and the job with it.
      hasPendingBackgroundWork: Effect.sync(() => awaitingWake || detached.pending),
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
      steerTurn: (steerInput) =>
        steerTurn(steerInput).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterSteerRunError({
                driver: OMP_PROVIDER,
                providerThreadId: steerInput.providerThread.id,
                providerTurnId: steerInput.providerTurnId,
                cause,
              }),
          ),
        ),
      interruptTurn: (interruptInput) =>
        interruptTurn(interruptInput).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapter.ProviderAdapterInterruptError({
                driver: OMP_PROVIDER,
                providerThreadId: interruptInput.providerThread.id,
                providerTurnId: interruptInput.providerTurnId,
                cause,
              }),
          ),
        ),
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
    getCapabilities: Effect.fn("OmpAdapter.getCapabilities")(function () {
      return Effect.succeed(OMP_PROVIDER_CAPABILITIES);
    }),
    // A session that must restart for changed settings is restarted on the selection change.
    // The role chip is read only at startup (openSession writes it to the overlay first).
    planSelectionTransition: Effect.fn("OmpAdapter.planSelectionTransition")(function (
      input: ProviderSelectionTransitionInput,
    ) {
      return Effect.succeed(
        input.providerSessionId !== undefined &&
          (options.threadSessions.restartRequired(input.providerSessionId).length > 0 ||
            readOmpTraitSelection(input.current).role !== readOmpTraitSelection(input.target).role)
          ? ({ type: "restart_session" } as const)
          : turnScopedSelectionTransition(),
      );
    }),
    openSession,
  });
});
