// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CheckpointId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OmpBranchTree,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeOmpAdapter } from "./adapter.ts";
import { readOmpSessionHead, readOmpThreadSessionRecord } from "./ompSessions.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import { ompStateDirs } from "./session.ts";
import { makeOmpThreadSessions } from "./threadSessions.ts";
import {
  type FakeOmpState,
  type FakeOmpStep,
  fakeOmpFrames,
  makeFakeOmpState,
} from "./testing/fakeOmp.ts";

const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const INSTANCE_ID = ProviderInstanceId.make("omp-rewind");
const SOURCE = ThreadId.make("thread/source");
const FORK = ThreadId.make("thread/fork");
const MODEL = { instanceId: INSTANCE_ID, model: "default" };

const policy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

/** A prompt OMP accepts and never finishes: the session stays busy. */
const HANGING_PROMPT: ReadonlyArray<FakeOmpStep> = [
  { respond: { agentInvoked: true } },
  { emit: { type: "agent_start" } },
];

const makeServer = (
  state: FakeOmpState,
  commands: Record<string, ReadonlyArray<FakeOmpStep>> = {},
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
    const adapter = yield* makeOmpAdapter({
      instanceId: INSTANCE_ID,
      profile: "",
      environment: state.env({
        ...state.sessionStore(),
        ...state.script({
          commands: { prompt: fakeOmpFrames.promptTurn({ text: ["pong"] }), ...commands },
        }),
      }),
      platform,
      defaultCwd: state.dir,
      resolveBinary: Effect.succeed(state.executable()),
      dirs,
      pidfiles: yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform }),
      expectedContractVersion: "1.0.0",
      threadSessions: makeOmpThreadSessions(),
      sessions: state.sessions,
    });
    return { adapter, dirs };
  });

const openThread = (adapter: ProviderAdapter.ProviderAdapterV2["Service"], threadId: ThreadId) =>
  adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`session:${threadId}`),
    modelSelection: MODEL,
    runtimePolicy: policy,
  });
const bindThread = (session: ProviderAdapter.ProviderAdapterV2SessionRuntime, threadId: ThreadId) =>
  session.ensureThread({ threadId, modelSelection: MODEL, runtimePolicy: policy });

const appThread = (
  threadId: ThreadId,
  providerThread: OrchestrationV2ProviderThread,
  now: DateTime.Utc,
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: threadId,
  projectId: "project:omp" as OrchestrationV2AppThread["projectId"],
  title: "Rewind",
  providerInstanceId: INSTANCE_ID,
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: providerThread.id,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

const startTurn = (
  session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  threadId: ThreadId,
  providerThread: OrchestrationV2ProviderThread,
  ordinal: number,
  text: string,
) =>
  Effect.gen(function* () {
    const key = `${threadId}:${ordinal}:${text}`;
    yield* session.startTurn({
      appThread: appThread(threadId, providerThread, yield* DateTime.now),
      threadId,
      runId: RunId.make(`run:${key}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`attempt:${key}`),
      rootNodeId: NodeId.make(`node:${key}`),
      providerThread,
      message: {
        messageId: `message:${key}` as never,
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: MODEL,
      runtimePolicy: policy,
    });
  });

/** Runs one turn; returns the thread after it and the turn as it ended. */
const runTurn = (
  session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  threadId: ThreadId,
  providerThread: OrchestrationV2ProviderThread,
  ordinal: number,
  text: string,
) =>
  Effect.gen(function* () {
    yield* startTurn(session, threadId, providerThread, ordinal, text);
    const events = yield* session.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    const threads = events.flatMap((event) =>
      event.type === "provider_thread.updated" ? [event.providerThread] : [],
    );
    const turns = events.flatMap((event) =>
      event.type === "provider_turn.updated" ? [event.providerTurn] : [],
    );
    const turn = turns.at(-1);
    assert.isDefined(turn);
    return { providerThread: threads.at(-1) ?? providerThread, turn: turn! };
  });

/** Runs `texts` as turns 1..n. */
const runTurns = (
  session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  threadId: ThreadId,
  first: OrchestrationV2ProviderThread,
  texts: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    let providerThread = first;
    const turns: Array<OrchestrationV2ProviderTurn> = [];
    for (const [index, text] of texts.entries()) {
      const result = yield* runTurn(session, threadId, providerThread, index + 1, text);
      providerThread = result.providerThread;
      turns.push(result.turn);
    }
    return { providerThread, turns };
  });

const snapshotText = (snapshot: ProviderAdapter.ProviderAdapterV2ThreadSnapshot) =>
  snapshot.messages.map((message) => `${message.role}:${message.text}`);

const commandsOfType = (state: FakeOmpState, type: string) =>
  state.commands().filter((command) => command["type"] === type);

const isProtocolError = Schema.is(ProviderAdapter.ProviderAdapterProtocolError);
/** The cause's detail, for asserting what the user reads. */
const detailOf = (error: { readonly cause?: unknown }) =>
  isProtocolError(error.cause) ? error.cause.detail : String(error.cause);

/** The message entries of a session file, in order: `[id, role]`. */
const messageEntries = (file: string): ReadonlyArray<readonly [string, string]> =>
  NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; id: string; message?: { role: string } })
    .flatMap((entry) =>
      entry.type === "message" && entry.message !== undefined
        ? [[entry.id, entry.message.role] as const]
        : [],
    );
const userEntries = (file: string) =>
  messageEntries(file).flatMap(([id, role]) => (role === "user" ? [id] : []));

posixOnly("OMP rewind and fork", () => {
  it.live("each turn records the session entry of its user message", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter, dirs } = yield* makeServer(state);
      const session = yield* openThread(adapter, SOURCE);
      const bound = yield* bindThread(session, SOURCE);
      const { turns } = yield* runTurns(session, SOURCE, bound, ["one", "two"]);
      const record = yield* readOmpThreadSessionRecord(dirs.threads, SOURCE);
      const ids = userEntries(record?.sessionFile ?? "");
      assert.deepStrictEqual(
        turns.map((turn) => [turn.nativeTurnRef?.nativeId, turn.nativeTurnRef?.strength]),
        ids.map((nativeId) => [nativeId, "strong"]),
      );
      // The first turn lists the whole (empty) session, the second only what came after the
      // first turn's last entry.
      assert.deepStrictEqual(
        commandsOfType(state, "get_entries").map((command) => command["since"]),
        [undefined, messageEntries(record?.sessionFile ?? "")[1]![0]],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rewind re-renders the kept conversation and the next prompt continues there", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter, dirs } = yield* makeServer(state);
      const session = yield* openThread(adapter, SOURCE);
      const bound = yield* bindThread(session, SOURCE);
      const ran = yield* runTurns(session, SOURCE, bound, ["one", "two", "three"]);
      const before = yield* readOmpThreadSessionRecord(dirs.threads, SOURCE);

      const snapshot = yield* session.rollbackThread({
        providerThread: ran.providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-1"),
          appRunOrdinal: 1,
          providerTurn: ran.turns[0]!,
        },
        providerThreadTurns: ran.turns,
      });

      // `branch` went to the second turn's message: OMP keeps everything before it.
      assert.deepStrictEqual(
        commandsOfType(state, "branch").map((command) => command["entryId"]),
        [ran.turns[1]!.nativeTurnRef?.nativeId],
      );
      assert.deepStrictEqual(snapshotText(snapshot), ["user:one", "assistant:pong"]);
      const payload = snapshot.providerPayload as {
        readonly sessionId: string;
        readonly sessionFile: string;
        readonly restoredText: string;
        readonly branchMessages: ReadonlyArray<{ readonly entryId: string; readonly text: string }>;
        readonly branchTree: OmpBranchTree;
      };
      assert.strictEqual(payload.restoredText, "two");
      assert.deepStrictEqual(
        payload.branchMessages.map((message) => [message.entryId, message.text]),
        [[ran.turns[0]!.nativeTurnRef?.nativeId, "one"]],
      );
      assert.deepStrictEqual(
        payload.branchTree.nodes.map((node) => [node.kind, node.preview]),
        [
          ["user", "one"],
          ["assistant", ""],
        ],
      );
      // The thread follows OMP onto the new file; the old one keeps the full conversation.
      const newId = snapshot.providerThread.nativeThreadRef?.nativeId;
      assert.notStrictEqual(newId, before?.sessionId);
      assert.strictEqual(snapshot.providerThread.id, ran.providerThread.id);
      assert.strictEqual(newId, payload.sessionId);
      const after = yield* readOmpThreadSessionRecord(dirs.threads, SOURCE);
      assert.strictEqual(after?.sessionId, newId);
      assert.strictEqual(after?.sessionFile, payload.sessionFile);
      assert.strictEqual((yield* readOmpSessionHead(payload.sessionFile))?.sessionId, newId);
      assert.lengthOf(userEntries(before?.sessionFile ?? ""), 3);

      const next = yield* runTurn(session, SOURCE, snapshot.providerThread, 2, "four");
      const history = yield* session.readThreadSnapshot({ providerThread: next.providerThread });
      assert.deepStrictEqual(snapshotText(history), [
        "user:one",
        "assistant:pong",
        "user:four",
        "assistant:pong",
      ]);
      assert.strictEqual(next.turn.nativeTurnRef?.strength, "strong");
      assert.strictEqual(
        userEntries(payload.sessionFile).at(-1),
        next.turn.nativeTurnRef?.nativeId,
      );

      // Back to the start: the session keeps no message.
      const empty = yield* session.rollbackThread({
        providerThread: next.providerThread,
        target: {
          type: "thread_start",
          checkpointId: CheckpointId.make("checkpoint-0"),
          appRunOrdinal: 0,
        },
        providerThreadTurns: [ran.turns[0]!, next.turn],
      });
      assert.deepStrictEqual(snapshotText(empty), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rewind works on a thread whose omp process was restarted", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const ran = yield* Effect.gen(function* () {
        const { adapter } = yield* makeServer(state);
        const session = yield* openThread(adapter, SOURCE);
        return yield* runTurns(session, SOURCE, yield* bindThread(session, SOURCE), ["one", "two"]);
      }).pipe(Effect.scoped);

      // A new server process: the thread's session reopens, but nothing has bound it yet.
      const { adapter, dirs } = yield* makeServer(state);
      const session = yield* adapter.openSession({
        threadId: SOURCE,
        providerSessionId: ProviderSessionId.make("session:restarted"),
        modelSelection: MODEL,
        runtimePolicy: policy,
        initialNativeThreadId: ran.providerThread.nativeThreadRef?.nativeId ?? "",
      });
      const snapshot = yield* session.rollbackThread({
        providerThread: ran.providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-1"),
          appRunOrdinal: 1,
          providerTurn: ran.turns[0]!,
        },
        providerThreadTurns: ran.turns,
      });
      assert.deepStrictEqual(snapshotText(snapshot), ["user:one", "assistant:pong"]);
      assert.strictEqual(snapshot.providerThread.id, ran.providerThread.id);
      assert.strictEqual(
        (yield* readOmpThreadSessionRecord(dirs.threads, SOURCE))?.sessionId,
        snapshot.providerThread.nativeThreadRef?.nativeId,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("once OMP has branched, failed reads do not fail the rewind", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter, dirs } = yield* makeServer(state, {
        get_tree: [{ fail: "tree unavailable" }],
        get_messages_page: [{ fail: "history unavailable" }],
      });
      const session = yield* openThread(adapter, SOURCE);
      const ran = yield* runTurns(session, SOURCE, yield* bindThread(session, SOURCE), [
        "one",
        "two",
      ]);
      const snapshot = yield* session.rollbackThread({
        providerThread: ran.providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-1"),
          appRunOrdinal: 1,
          providerTurn: ran.turns[0]!,
        },
        providerThreadTurns: ran.turns,
      });
      assert.lengthOf(commandsOfType(state, "branch"), 1);
      assert.deepStrictEqual(snapshot.messages, []);
      // The thread still follows OMP onto the branched file.
      const record = yield* readOmpThreadSessionRecord(dirs.threads, SOURCE);
      assert.strictEqual(record?.sessionId, snapshot.providerThread.nativeThreadRef?.nativeId);
      assert.notStrictEqual(record?.sessionId, ran.providerThread.nativeThreadRef?.nativeId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rewinding to the latest turn changes nothing", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter } = yield* makeServer(state);
      const session = yield* openThread(adapter, SOURCE);
      const bound = yield* bindThread(session, SOURCE);
      const ran = yield* runTurns(session, SOURCE, bound, ["one"]);
      const snapshot = yield* session.rollbackThread({
        providerThread: ran.providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-1"),
          appRunOrdinal: 1,
          providerTurn: ran.turns[0]!,
        },
        providerThreadTurns: ran.turns,
      });
      assert.lengthOf(commandsOfType(state, "branch"), 0);
      assert.deepStrictEqual(snapshotText(snapshot), ["user:one", "assistant:pong"]);
      assert.strictEqual(
        snapshot.providerThread.nativeThreadRef?.nativeId,
        ran.providerThread.nativeThreadRef?.nativeId,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a turn recorded without its entry is found by when it ran", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter } = yield* makeServer(state);
      const session = yield* openThread(adapter, SOURCE);
      const bound = yield* bindThread(session, SOURCE);
      const ran = yield* runTurns(session, SOURCE, bound, ["one", "two"]);
      // As before C-11: the synthetic weak ref every turn starts with.
      const uncaptured = ran.turns.map((turn) => ({
        ...turn,
        nativeTurnRef: {
          driver: turn.nativeTurnRef!.driver,
          nativeId: `${turn.id}`,
          strength: "weak" as const,
        },
      }));
      const snapshot = yield* session.rollbackThread({
        providerThread: ran.providerThread,
        target: {
          type: "provider_turn",
          checkpointId: CheckpointId.make("checkpoint-1"),
          appRunOrdinal: 1,
          providerTurn: uncaptured[0]!,
        },
        providerThreadTurns: uncaptured,
      });
      assert.deepStrictEqual(
        commandsOfType(state, "branch").map((command) => command["entryId"]),
        [ran.turns[1]!.nativeTurnRef?.nativeId],
      );
      assert.deepStrictEqual(snapshotText(snapshot), ["user:one", "assistant:pong"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fork creates a thread on a new session file and leaves the source on its own", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter, dirs } = yield* makeServer(state);
      const source = yield* openThread(adapter, SOURCE);
      const sourceBound = yield* bindThread(source, SOURCE);
      const ran = yield* runTurns(source, SOURCE, sourceBound, ["one", "two"]);
      const sourceRecord = yield* readOmpThreadSessionRecord(dirs.threads, SOURCE);

      const target = yield* openThread(adapter, FORK);
      const forked = yield* target.forkThread({
        sourceProviderThread: ran.providerThread,
        sourceProviderTurns: ran.turns,
        providerTurnId: ran.turns[0]!.id,
        targetThreadId: FORK,
        modelSelection: MODEL,
        runtimePolicy: policy,
      });

      const forkId = forked.nativeThreadRef?.nativeId;
      assert.isString(forkId);
      assert.notStrictEqual(forkId, ran.providerThread.nativeThreadRef?.nativeId);
      assert.notStrictEqual(forked.id, ran.providerThread.id);
      assert.strictEqual(forked.appThreadId, FORK);
      assert.deepStrictEqual(forked.forkedFrom, {
        providerThreadId: ran.providerThread.id,
        providerTurnId: ran.turns[0]!.id,
      });
      // `fork` kept the first exchange: through the answer before the second message.
      const forkCommands = commandsOfType(state, "fork");
      assert.lengthOf(forkCommands, 1);
      assert.isString(forkCommands[0]!["entryId"]);
      const forkRecord = yield* readOmpThreadSessionRecord(dirs.threads, FORK);
      assert.strictEqual(forkRecord?.sessionId, forkId);
      assert.notStrictEqual(forkRecord?.sessionFile, sourceRecord?.sessionFile);
      assert.strictEqual(
        NodePath.dirname(forkRecord?.sessionFile ?? ""),
        NodePath.dirname(sourceRecord?.sessionFile ?? ""),
      );
      assert.deepStrictEqual(
        snapshotText(yield* target.readThreadSnapshot({ providerThread: forked })),
        ["user:one", "assistant:pong"],
      );

      // Both threads go on, each in its own file. T3 runs the fork under its own row's id.
      const row = { ...forked, id: "provider-thread:pending-fork-row" as typeof forked.id };
      const forkTurn = yield* runTurn(target, FORK, row, 1, "fork turn");
      assert.strictEqual(forkTurn.providerThread.id, row.id);
      const sourceTurn = yield* runTurn(source, SOURCE, ran.providerThread, 3, "source turn");
      assert.deepStrictEqual(
        snapshotText(yield* target.readThreadSnapshot({ providerThread: forkTurn.providerThread })),
        ["user:one", "assistant:pong", "user:fork turn", "assistant:pong"],
      );
      assert.deepStrictEqual(
        snapshotText(
          yield* source.readThreadSnapshot({ providerThread: sourceTurn.providerThread }),
        ),
        [
          "user:one",
          "assistant:pong",
          "user:two",
          "assistant:pong",
          "user:source turn",
          "assistant:pong",
        ],
      );
      assert.strictEqual(
        (yield* readOmpThreadSessionRecord(dirs.threads, SOURCE))?.sessionFile,
        sourceRecord?.sessionFile,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fork from the latest turn copies the whole session", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter } = yield* makeServer(state);
      const source = yield* openThread(adapter, SOURCE);
      const ran = yield* runTurns(source, SOURCE, yield* bindThread(source, SOURCE), [
        "one",
        "two",
      ]);
      const target = yield* openThread(adapter, FORK);
      const forked = yield* target.forkThread({
        sourceProviderThread: ran.providerThread,
        sourceProviderTurns: ran.turns,
        providerTurnId: ran.turns[1]!.id,
        targetThreadId: FORK,
      });
      assert.deepStrictEqual(
        commandsOfType(state, "fork").map((command) => command["entryId"]),
        [undefined],
      );
      assert.deepStrictEqual(
        snapshotText(yield* target.readThreadSnapshot({ providerThread: forked })),
        ["user:one", "assistant:pong", "user:two", "assistant:pong"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("rewind is refused while a turn runs", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter } = yield* makeServer(state, { prompt: HANGING_PROMPT });
      const session = yield* openThread(adapter, SOURCE);
      const bound = yield* bindThread(session, SOURCE);
      yield* startTurn(session, SOURCE, bound, 1, "slow");
      const error = yield* session
        .rollbackThread({
          providerThread: bound,
          target: { type: "thread_start", checkpointId: CheckpointId.make("c0"), appRunOrdinal: 0 },
          providerThreadTurns: [],
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterRollbackThreadError");
      assert.match(detailOf(error), /^Cannot rewind while the OMP session is busy/);
      assert.lengthOf(commandsOfType(state, "branch"), 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fork is refused while the source thread runs a turn", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter } = yield* makeServer(state, { prompt: HANGING_PROMPT });
      const source = yield* openThread(adapter, SOURCE);
      const bound = yield* bindThread(source, SOURCE);
      yield* startTurn(source, SOURCE, bound, 1, "slow");
      const target = yield* openThread(adapter, FORK);
      const error = yield* target
        .forkThread({ sourceProviderThread: bound, sourceProviderTurns: [], targetThreadId: FORK })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterForkThreadError");
      assert.match(detailOf(error), /^Cannot fork while the OMP session is busy/);
      assert.lengthOf(commandsOfType(state, "fork"), 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("OMP's session_busy refusal of a fork reads the same and leaves the source file", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter } = yield* makeServer(state, {
        fork: [{ fail: "Cannot fork the session while it is busy", code: "session_busy" }],
      });
      const source = yield* openThread(adapter, SOURCE);
      const ran = yield* runTurns(source, SOURCE, yield* bindThread(source, SOURCE), ["one"]);
      const target = yield* openThread(adapter, FORK);
      const error = yield* target
        .forkThread({
          sourceProviderThread: ran.providerThread,
          sourceProviderTurns: ran.turns,
          targetThreadId: FORK,
        })
        .pipe(Effect.flip);
      assert.match(detailOf(error), /^Cannot fork while the OMP session is busy/);
      // The fork's process moved off the source's file again.
      const commands = state.commands().map((command) => command["type"]);
      assert.deepStrictEqual(commands.slice(commands.lastIndexOf("fork")).slice(0, 2), [
        "fork",
        "new_session",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
