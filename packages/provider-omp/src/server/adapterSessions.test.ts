// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHostTools from "@t3tools/provider-core/server/ProviderHostTools";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { makeOmpAdapter } from "./adapter.ts";
import { OMP_HOST_CWD_CHANGE_CONTRACT } from "./hostTools.ts";
import { OMP_PROVIDER } from "./mapper.ts";
import {
  listOmpSessions,
  readOmpSessionHead,
  readOmpThreadSessionRecord,
  readOmpThreadSessionRecords,
} from "./ompSessions.ts";
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

const INSTANCE_ID = ProviderInstanceId.make("omp-sessions");
const THREAD_ID = ThreadId.make("thread/sessions");
const MODEL = { instanceId: INSTANCE_ID, model: "default" };

const policy = (cwd: string | null = null) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd,
  });

/**
 * One Ompanel server's OMP adapter over the fake, which keeps sessions on disk. A second call
 * with the same state is the same server after a restart: same state directory, same sessions.
 */
const makeServer = (
  state: FakeOmpState,
  options: {
    readonly contract?: string;
    readonly autoResume?: boolean;
    readonly script?: Parameters<FakeOmpState["script"]>[0];
  } = {},
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
    const contract = options.contract ?? "1.0.0";
    const adapter = yield* makeOmpAdapter({
      instanceId: INSTANCE_ID,
      profile: "",
      environment: state.env({
        ...state.sessionStore(state.sessions.root, { autoResume: options.autoResume ?? false }),
        ...state.script(options.script ?? { commands: { prompt: promptSteps("pong") } }),
        FAKE_OMP_CONTRACT: contract,
      }),
      platform,
      defaultCwd: state.dir,
      resolveBinary: Effect.succeed(state.executable()),
      dirs,
      pidfiles: yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform }),
      expectedContractVersion: contract,
      threadSessions: makeOmpThreadSessions(),
      sessions: state.sessions,
    });
    return { adapter, dirs };
  });

const promptSteps = (text: string): ReadonlyArray<FakeOmpStep> =>
  fakeOmpFrames.promptTurn({ text: [text] });

const appThread = (
  providerThread: OrchestrationV2ProviderThread,
  now: DateTime.Utc,
): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: THREAD_ID,
  projectId: "project:omp" as OrchestrationV2AppThread["projectId"],
  title: "Sessions",
  providerInstanceId: INSTANCE_ID,
  modelSelection: MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: providerThread.id,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
  forkedFrom: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** Runs one turn and returns the thread as it stands after it, with the turn's events. */
const runTurn = (
  session: ProviderAdapter.ProviderAdapterV2SessionRuntime,
  providerThread: OrchestrationV2ProviderThread,
  ordinal: number,
  text: string,
) =>
  Effect.gen(function* () {
    yield* session.startTurn({
      appThread: appThread(providerThread, yield* DateTime.now),
      threadId: THREAD_ID,
      runId: RunId.make(`run:sessions:${ordinal}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(`run-attempt:sessions:${ordinal}`),
      rootNodeId: NodeId.make(`node:sessions:${ordinal}`),
      providerThread,
      message: {
        messageId: `message:sessions:${ordinal}` as never,
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: MODEL,
      runtimePolicy: policy(),
    });
    const events = yield* session.events.pipe(
      Stream.takeUntil((event) => event.type === "turn.terminal"),
      Stream.runCollect,
    );
    const updated = events.flatMap((event) =>
      event.type === "provider_thread.updated" ? [event.providerThread] : [],
    );
    return { events, providerThread: updated.at(-1) ?? providerThread };
  });

const snapshotText = (snapshot: ProviderAdapter.ProviderAdapterV2ThreadSnapshot) =>
  snapshot.messages.map((message) => `${message.role}:${message.text}`);

const commandsOfType = (state: FakeOmpState, type: string) =>
  state.commands().filter((command) => command["type"] === type);

/** A provider thread T3 created for an imported session: a native id and no run yet. */
const importedProviderThread = (sessionId: string, now: DateTime.Utc) =>
  ({
    id: IdAllocator.derive.providerThread({ driver: OMP_PROVIDER, nativeThreadId: sessionId }),
    driver: OMP_PROVIDER,
    providerInstanceId: INSTANCE_ID,
    providerSessionId: ProviderSessionId.make("session-import"),
    appThreadId: THREAD_ID,
    ownerNodeId: null,
    nativeThreadRef: { driver: OMP_PROVIDER, nativeId: sessionId, strength: "strong" },
    nativeConversationHeadRef: null,
    status: "idle",
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    pendingBackgroundTasks: [],
    contextUsage: null,
    nativeMetadata: null,
    goal: null,
    createdAt: now,
    updatedAt: now,
  }) satisfies OrchestrationV2ProviderThread;

posixOnly("OMP thread sessions", () => {
  it.live("a new thread creates its session in its directory's bucket and records it", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter, dirs } = yield* makeServer(state);
      const work = NodePath.join(state.dir, "work");
      NodeFS.mkdirSync(work);
      const { providerThread, snapshot } = yield* Effect.gen(function* () {
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-new"),
          modelSelection: MODEL,
          runtimePolicy: policy(work),
        });
        const bound = yield* session.ensureThread({
          threadId: THREAD_ID,
          modelSelection: MODEL,
          runtimePolicy: policy(work),
        });
        const turn = yield* runTurn(session, bound, 1, "hello");
        return {
          providerThread: turn.providerThread,
          snapshot: yield* session.readThreadSnapshot({ providerThread: turn.providerThread }),
        };
      }).pipe(Effect.scoped);

      // The thread's session is a fresh one: the process's own, no `new_session` needed.
      assert.lengthOf(commandsOfType(state, "new_session"), 0);
      assert.lengthOf(commandsOfType(state, "switch_session"), 0);
      const sessionId = providerThread.nativeThreadRef?.nativeId;
      assert.isString(sessionId);
      const record = yield* readOmpThreadSessionRecord(dirs.threads, THREAD_ID);
      assert.strictEqual(record?.sessionId, sessionId);
      // OMP's session file sits in the bucket of the thread's directory and holds the turn.
      const sessionFile = record?.sessionFile ?? "";
      assert.strictEqual(
        NodePath.dirname(sessionFile),
        NodePath.join(state.sessions.root, work.replace(/[\\/:]/g, "-")),
      );
      assert.strictEqual((yield* readOmpSessionHead(sessionFile))?.sessionId, sessionId);
      assert.deepStrictEqual(snapshotText(snapshot), ["user:hello", "assistant:pong"]);
      const payload = snapshot.providerPayload as {
        readonly sessionId: string;
        readonly sessionFile: string;
        readonly branchTree: { readonly activePath: ReadonlyArray<string> } | null;
      };
      assert.deepStrictEqual([payload.sessionId, payload.sessionFile], [sessionId, sessionFile]);
      // The branch view's tree (sessionBranches.ts): the turn's two messages, on the active path.
      assert.lengthOf(payload.branchTree?.activePath ?? [], 2);
      const listed = yield* listOmpSessions(state.sessions, work);
      assert.deepStrictEqual(
        listed.map((session) => [session.sessionId, session.firstMessage]),
        [[sessionId, "hello"]],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a new thread does not take over a conversation OMP's autoResume reopened", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const first = yield* Effect.gen(function* () {
        const { adapter } = yield* makeServer(state);
        const session = yield* adapter.openSession({
          threadId: ThreadId.make("thread/earlier"),
          providerSessionId: ProviderSessionId.make("session-earlier"),
          modelSelection: MODEL,
          runtimePolicy: policy(),
        });
        const bound = yield* session.ensureThread({
          threadId: ThreadId.make("thread/earlier"),
          modelSelection: MODEL,
          runtimePolicy: policy(),
        });
        return (yield* runTurn(session, bound, 1, "earlier")).providerThread;
      }).pipe(Effect.scoped);

      const second = yield* Effect.gen(function* () {
        const { adapter } = yield* makeServer(state, { autoResume: true });
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-new"),
          modelSelection: MODEL,
          runtimePolicy: policy(),
        });
        return yield* session.ensureThread({
          threadId: THREAD_ID,
          modelSelection: MODEL,
          runtimePolicy: policy(),
        });
      }).pipe(Effect.scoped);

      assert.lengthOf(commandsOfType(state, "new_session"), 1);
      assert.notStrictEqual(second.nativeThreadRef?.nativeId, first.nativeThreadRef?.nativeId);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reopening a thread after a server restart resumes the same session and history", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const before = yield* Effect.gen(function* () {
        const { adapter } = yield* makeServer(state);
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-1"),
          modelSelection: MODEL,
          runtimePolicy: policy(),
        });
        const bound = yield* session.ensureThread({
          threadId: THREAD_ID,
          modelSelection: MODEL,
          runtimePolicy: policy(),
        });
        return (yield* runTurn(session, bound, 1, "remember 42")).providerThread;
      }).pipe(Effect.scoped);
      const sessionId = before.nativeThreadRef?.nativeId ?? "";
      const firstFile = (yield* readOmpThreadSessionRecord(
        ompStateDirs(yield* Path.Path, NodePath.join(state.dir, "state")).threads,
        THREAD_ID,
      ))?.sessionFile;

      // A new server: a new adapter and process over the same state and sessions.
      const after = yield* Effect.gen(function* () {
        const { adapter } = yield* makeServer(state);
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-2"),
          modelSelection: MODEL,
          runtimePolicy: policy(),
          initialNativeThreadId: sessionId,
        });
        const resumed = yield* session.resumeThread({
          providerThread: before,
          threadId: THREAD_ID,
          modelSelection: MODEL,
          runtimePolicy: policy(),
        });
        const historyBefore = yield* session.readThreadSnapshot({ providerThread: resumed });
        const turn = yield* runTurn(session, resumed, 2, "what was it?");
        const historyAfter = yield* session.readThreadSnapshot({
          providerThread: turn.providerThread,
        });
        return { resumed, historyBefore, historyAfter };
      }).pipe(Effect.scoped);

      assert.deepStrictEqual(
        commandsOfType(state, "switch_session").map((c) => c["sessionPath"]),
        [firstFile],
      );
      assert.strictEqual(after.resumed.id, before.id);
      assert.strictEqual(after.resumed.nativeThreadRef?.nativeId, sessionId);
      assert.deepStrictEqual(snapshotText(after.historyBefore), [
        "user:remember 42",
        "assistant:pong",
      ]);
      assert.deepStrictEqual(snapshotText(after.historyAfter), [
        "user:remember 42",
        "assistant:pong",
        "user:what was it?",
        "assistant:pong",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("after /fresh a reopened thread resumes the same session file", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const threadsDir = ompStateDirs(yield* Path.Path, NodePath.join(state.dir, "state")).threads;
      const before = yield* Effect.gen(function* () {
        const { adapter } = yield* makeServer(state);
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-1"),
          modelSelection: MODEL,
          runtimePolicy: policy(),
        });
        const bound = yield* session.ensureThread({
          threadId: THREAD_ID,
          modelSelection: MODEL,
          runtimePolicy: policy(),
        });
        const first = yield* runTurn(session, bound, 1, "remember 42");
        return (yield* runTurn(session, first.providerThread, 2, "/fresh")).providerThread;
      }).pipe(Effect.scoped);

      // OMP now reports a new id, and the thread adopted it; the file keeps its own.
      const record = yield* readOmpThreadSessionRecord(threadsDir, THREAD_ID);
      const freshId = before.nativeThreadRef?.nativeId ?? "";
      assert.match(freshId, /^fresh-/);
      assert.strictEqual(record?.reportedSessionId, freshId);
      const sessionFile = record?.sessionFile ?? "";
      assert.notStrictEqual(record?.sessionId, freshId);
      assert.strictEqual((yield* readOmpSessionHead(sessionFile))?.sessionId, record?.sessionId);
      // The import list shows the session as this thread's.
      assert.strictEqual(
        (yield* readOmpThreadSessionRecords(threadsDir)).get(record?.sessionId ?? ""),
        THREAD_ID,
      );

      const after = yield* Effect.gen(function* () {
        const { adapter } = yield* makeServer(state);
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-2"),
          modelSelection: MODEL,
          runtimePolicy: policy(),
          initialNativeThreadId: freshId,
        });
        const resumed = yield* session.resumeThread({
          providerThread: before,
          threadId: THREAD_ID,
        });
        return {
          resumed,
          snapshot: yield* session.readThreadSnapshot({ providerThread: resumed }),
        };
      }).pipe(Effect.scoped);

      assert.deepStrictEqual(
        commandsOfType(state, "switch_session").map((command) => command["sessionPath"]),
        [sessionFile],
      );
      assert.strictEqual(after.resumed.id, before.id);
      assert.deepStrictEqual(snapshotText(after.snapshot), ["user:remember 42", "assistant:pong"]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("a thread whose session is gone reports why it cannot resume, on a fresh session", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const now = yield* DateTime.now;
      const result = yield* Effect.gen(function* () {
        const { adapter } = yield* makeServer(state);
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-gone"),
          modelSelection: MODEL,
          runtimePolicy: policy(),
          initialNativeThreadId: "deleted-session",
        });
        const resumed = yield* session
          .resumeThread({
            providerThread: importedProviderThread("deleted-session", now),
            threadId: THREAD_ID,
          })
          .pipe(Effect.result);
        // T3's fallback: the same row without a native id binds to the fresh session.
        const fresh = yield* session.ensureThread({
          threadId: THREAD_ID,
          modelSelection: MODEL,
          runtimePolicy: policy(),
          existingProviderThread: {
            ...importedProviderThread("deleted-session", now),
            nativeThreadRef: null,
          },
        });
        return { resumed, fresh };
      }).pipe(Effect.scoped);
      assert.strictEqual(result.resumed._tag, "Failure");
      if (result.resumed._tag === "Failure") {
        assert.match(String(result.resumed.failure.cause), /deleted-session/);
      }
      assert.notStrictEqual(result.fresh.nativeThreadRef?.nativeId, "deleted-session");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("an imported session shows its history, paged in order, as the thread's messages", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const work = NodePath.join(state.dir, "work");
      NodeFS.mkdirSync(work);
      // A session OMP wrote in a terminal, longer than one 256-message page.
      const sessionId = "terminal-session";
      const bucket = NodePath.join(state.sessions.root, "-terminal");
      NodeFS.mkdirSync(bucket, { recursive: true });
      const messages = Array.from({ length: 300 }, (_, index) =>
        index % 2 === 0
          ? {
              role: "user",
              content: [{ type: "text", text: `q${index / 2}` }],
              timestamp: 1_000 + index,
            }
          : fakeOmpFrames.assistant([{ type: "text", text: `a${(index - 1) / 2}` }]),
      );
      const file = NodePath.join(bucket, `2026-10-20T10-00-00-000Z_${sessionId}.jsonl`);
      NodeFS.writeFileSync(
        file,
        [
          JSON.stringify({ type: "title", v: 1, title: "From the terminal", source: "auto" }),
          JSON.stringify({ type: "session", version: 3, id: sessionId, timestamp: "", cwd: work }),
          ...messages.map((message, index) =>
            JSON.stringify({
              type: "message",
              id: `e${index}`,
              parentId: null,
              timestamp: "",
              message,
            }),
          ),
        ].join("\n") + "\n",
      );
      const listed = yield* listOmpSessions(state.sessions, work);
      assert.deepStrictEqual(
        listed.map((session) => [session.sessionId, session.title]),
        [[sessionId, "From the terminal"]],
      );

      const now = yield* DateTime.now;
      const events = yield* Effect.gen(function* () {
        const { adapter } = yield* makeServer(state);
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-import"),
          modelSelection: MODEL,
          runtimePolicy: policy(work),
          initialNativeThreadId: sessionId,
        });
        yield* session.resumeThread({
          providerThread: importedProviderThread(sessionId, now),
          threadId: THREAD_ID,
        });
        return yield* session.events.pipe(
          Stream.filter((event) => event.type === "message.updated"),
          Stream.take(300),
          Stream.runCollect,
        );
      }).pipe(Effect.scoped);

      const pages = commandsOfType(state, "get_messages_page");
      assert.lengthOf(pages, 2);
      assert.isUndefined(pages[0]?.["cursor"]);
      assert.isString(pages[1]?.["cursor"]);
      const texts = events.flatMap((event) =>
        event.type === "message.updated" ? [event.message.text] : [],
      );
      assert.deepStrictEqual(
        texts,
        Array.from({ length: 300 }, (_, index) =>
          index % 2 === 0 ? `q${index / 2}` : `a${(index - 1) / 2}`,
        ),
      );
      const first = events[0];
      if (first?.type === "message.updated") {
        assert.strictEqual(first.message.threadId, THREAD_ID);
        assert.isNull(first.message.runId);
        assert.strictEqual(first.message.role, "user");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("after /wt the restarted session in the worktree resumes the same conversation", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const repo = NodePath.join(state.dir, "repo");
      const worktree = NodePath.join(state.dir, "worktrees", "repo-feature-x");
      NodeFS.mkdirSync(repo);
      NodeFS.mkdirSync(worktree, { recursive: true });
      const bound: Array<string> = [];
      const hostTools = ProviderHostTools.ProviderHostTools.of({
        runTerminalCommand: () => Effect.die("unused"),
        createThreadWorktree: () => Effect.succeed({ path: worktree, branch: "feature/x" }),
        bindThreadWorktree: (input) => Effect.sync(() => void bound.push(input.worktree.path)),
        resolveThreadWorkspace: () => Effect.die("unused"),
        moveThreadWorkspace: () => Effect.die("unused"),
        connectMcp: () => Effect.die("unused"),
        workspaceTrusted: () => Effect.succeed(false),
      });
      const script = {
        commands: {
          set_tool_enabled: [{ respond: { enabled: false } }],
          set_host_tools: [{ respond: { toolNames: [] } }],
          set_host_cwd_change: [{ respond: { enabled: true } }],
        },
      };
      const before = yield* Effect.gen(function* () {
        const { adapter } = yield* makeServer(state, {
          contract: OMP_HOST_CWD_CHANGE_CONTRACT,
          script: {
            commands: {
              ...script.commands,
              prompt: [
                { respond: { agentInvoked: true } },
                {
                  emit: {
                    type: "host_cwd_change_request",
                    id: "cwd-wt",
                    reason: "worktree",
                    cwd: repo,
                    branch: "feature/x",
                  },
                },
                { sleepMs: 300 },
                ...promptSteps("moved").slice(1),
              ],
            },
          },
        });
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-repo"),
          modelSelection: MODEL,
          runtimePolicy: policy(repo),
        });
        const thread = yield* session.ensureThread({
          threadId: THREAD_ID,
          modelSelection: MODEL,
          runtimePolicy: policy(repo),
        });
        return (yield* runTurn(session, thread, 1, "/wt feature/x")).providerThread;
      }).pipe(Effect.provideService(ProviderHostTools.ProviderHostTools, hostTools), Effect.scoped);
      assert.deepStrictEqual(bound, [worktree]);
      const sessionId = before.nativeThreadRef?.nativeId ?? "";

      // OMP moved the session file into the worktree's bucket while it drained.
      const worktreeBucket = NodePath.join(state.sessions.root, worktree.replace(/[\\/:]/g, "-"));
      assert.lengthOf(NodeFS.readdirSync(worktreeBucket), 1);

      const after = yield* Effect.gen(function* () {
        const { adapter } = yield* makeServer(state, {
          contract: OMP_HOST_CWD_CHANGE_CONTRACT,
          script,
        });
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-worktree"),
          modelSelection: MODEL,
          runtimePolicy: policy(worktree),
          initialNativeThreadId: sessionId,
        });
        const resumed = yield* session.resumeThread({
          providerThread: before,
          threadId: THREAD_ID,
        });
        return {
          resumed,
          snapshot: yield* session.readThreadSnapshot({ providerThread: resumed }),
        };
      }).pipe(Effect.provideService(ProviderHostTools.ProviderHostTools, hostTools), Effect.scoped);

      const argv = state.argv().argv;
      assert.strictEqual(argv[argv.indexOf("--cwd") + 1], worktree);
      const switched = commandsOfType(state, "switch_session").map((c) => String(c["sessionPath"]));
      assert.lengthOf(switched, 1);
      assert.strictEqual(NodePath.dirname(switched[0] ?? ""), worktreeBucket);
      assert.strictEqual(after.resumed.nativeThreadRef?.nativeId, sessionId);
      assert.deepStrictEqual(snapshotText(after.snapshot), [
        "user:/wt feature/x",
        "assistant:moved",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
