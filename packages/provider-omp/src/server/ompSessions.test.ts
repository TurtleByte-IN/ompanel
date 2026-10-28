// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { AgentMessage, MessagesPage } from "../../contract/src/wire.generated.ts";
import {
  findOmpSessionFile,
  listOmpSessions,
  parseOmpSessionHead,
  readOmpThreadSessionRecord,
  readOmpThreadSessionRecords,
  resolveOmpSessionsLocation,
  writeOmpThreadSessionRecord,
} from "./ompSessions.ts";
import { OmpRpcCommandError } from "./rpcProcess.ts";
import { ompHistoryMessages, readOmpHistoryPages } from "./sessionHistory.ts";
import { fakeOmpFrames } from "./testing/fakeOmp.ts";

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  effect.pipe(Effect.provide(NodeServices.layer));

const scratch = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-sessions-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

const user = (text: string, extra: Partial<AgentMessage> = {}): AgentMessage =>
  ({
    role: "user",
    content: [{ type: "text", text }],
    timestamp: 1_793_000_000_000,
    ...extra,
  }) as AgentMessage;

/** A session file as the pinned OMP writes it: a padded title slot, the header, entries. */
const sessionFile = (input: {
  readonly id: string;
  readonly cwd: string;
  readonly title?: string;
  readonly messages?: ReadonlyArray<AgentMessage>;
}) => {
  const lines: Array<string> = [];
  if (input.title !== undefined) {
    const slot = JSON.stringify({
      type: "title",
      v: 1,
      title: input.title,
      source: "auto",
      pad: "",
    });
    lines.push(slot.replace('"pad":""', `"pad":"${" ".repeat(Math.max(0, 255 - slot.length))}"`));
  }
  lines.push(
    JSON.stringify({
      type: "session",
      version: 3,
      id: input.id,
      timestamp: "2026-10-25T13:56:16.733Z",
      cwd: input.cwd,
    }),
    JSON.stringify({ type: "model_change", id: "m0", parentId: null, timestamp: "", model: "x/y" }),
  );
  (input.messages ?? []).forEach((message, index) =>
    lines.push(
      JSON.stringify({ type: "message", id: `e${index}`, parentId: null, timestamp: "", message }),
    ),
  );
  return `${lines.join("\n")}\n`;
};

const writeSession = (
  root: string,
  bucket: string,
  name: string,
  body: string,
  mtimeSeconds: number,
) => {
  const file = NodePath.join(root, bucket, name);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, body);
  NodeFS.utimesSync(file, mtimeSeconds, mtimeSeconds);
  return file;
};

describe("resolveOmpSessionsLocation", () => {
  const resolve = (
    environment: NodeJS.ProcessEnv,
    profile = "",
    platform: NodeJS.Platform = "darwin",
  ) =>
    run(resolveOmpSessionsLocation({ environment, profile, platform, homeDir: "/home/fallback" }));

  it.effect("follows OMP's agent dir: home, profile, PI_CODING_AGENT_DIR, PI_CONFIG_DIR", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* resolve({ HOME: "/home/u" }), {
        root: "/home/u/.omp/agent/sessions",
        flat: false,
      });
      assert.deepStrictEqual(yield* resolve({}), {
        root: "/home/fallback/.omp/agent/sessions",
        flat: false,
      });
      assert.strictEqual(
        (yield* resolve({ HOME: "/home/u" }, "work")).root,
        "/home/u/.omp/profiles/work/agent/sessions",
      );
      assert.strictEqual(
        (yield* resolve({ HOME: "/home/u", OMP_PROFILE: "env-profile" })).root,
        "/home/u/.omp/profiles/env-profile/agent/sessions",
      );
      assert.strictEqual(
        (yield* resolve({ HOME: "/home/u", OMP_PROFILE: "default" })).root,
        "/home/u/.omp/agent/sessions",
      );
      assert.strictEqual(
        (yield* resolve({ HOME: "/home/u", PI_CODING_AGENT_DIR: "/agents/a" })).root,
        "/agents/a/sessions",
      );
      // A named profile ignores PI_CODING_AGENT_DIR, as OMP's DirResolver does.
      assert.strictEqual(
        (yield* resolve({ HOME: "/home/u", PI_CODING_AGENT_DIR: "/agents/a" }, "work")).root,
        "/home/u/.omp/profiles/work/agent/sessions",
      );
      assert.strictEqual(
        (yield* resolve({ HOME: "/home/u", PI_CONFIG_DIR: ".pi" })).root,
        "/home/u/.pi/agent/sessions",
      );
      assert.deepStrictEqual(yield* resolve({ PI_CODING_AGENT_SESSION_DIR: "/flat/sessions" }), {
        root: "/flat/sessions",
        flat: true,
      });
    }),
  );

  it.effect("moves under XDG_DATA_HOME only once its omp directory exists", () =>
    Effect.gen(function* () {
      const xdg = yield* scratch;
      const environment = { HOME: "/home/u", XDG_DATA_HOME: xdg };
      assert.strictEqual((yield* resolve(environment)).root, "/home/u/.omp/agent/sessions");
      NodeFS.mkdirSync(NodePath.join(xdg, "omp"));
      assert.strictEqual((yield* resolve(environment)).root, NodePath.join(xdg, "omp", "sessions"));
      assert.strictEqual(
        (yield* resolve(environment, "", "win32")).root,
        NodePath.join("/home/fallback", ".omp", "agent", "sessions"),
      );
      // A named profile needs its own XDG profile directory.
      assert.strictEqual(
        (yield* resolve(environment, "work")).root,
        "/home/u/.omp/profiles/work/agent/sessions",
      );
      NodeFS.mkdirSync(NodePath.join(xdg, "omp", "profiles", "work"), { recursive: true });
      assert.strictEqual(
        (yield* resolve(environment, "work")).root,
        NodePath.join(xdg, "omp", "profiles", "work", "sessions"),
      );
    }).pipe(Effect.scoped),
  );
});

describe("parseOmpSessionHead", () => {
  it("reads the title slot, the header and the first user message", () => {
    const head = parseOmpSessionHead(
      "/s/a.jsonl",
      sessionFile({
        id: "s-1",
        cwd: "/work/app",
        title: "🔑 Fix the login",
        messages: [user("hidden", { synthetic: true }), user("Make it work\nplease")],
      }),
    );
    assert.deepStrictEqual(head, {
      sessionId: "s-1",
      sessionFile: "/s/a.jsonl",
      cwd: "/work/app",
      title: "🔑 Fix the login",
      firstMessage: "Make it work",
      createdAt: "2026-10-25T13:56:16.733Z",
      hasMessages: true,
    });
  });

  it("rejects files that do not start with a session header", () => {
    assert.isNull(parseOmpSessionHead("/s/x.jsonl", '{"type":"message","id":"a"}\n'));
    assert.isNull(parseOmpSessionHead("/s/x.jsonl", ""));
    // A header cut off by the read window is not a header.
    assert.isNull(parseOmpSessionHead("/s/x.jsonl", '{"type":"session","id":"s'));
  });
});

describe("OMP session files", () => {
  it.effect("lists the sessions of one directory, newest first, without empty stubs", () =>
    run(
      Effect.gen(function* () {
        const root = yield* scratch;
        const work = NodePath.join(root, "work");
        NodeFS.mkdirSync(work);
        writeSession(
          root,
          "-work",
          "2026-10-24T10-00-00-000Z_old.jsonl",
          sessionFile({ id: "old", cwd: work, messages: [user("first question")] }),
          1_000,
        );
        writeSession(
          root,
          "-work",
          "2026-10-25T10-00-00-000Z_new.jsonl",
          sessionFile({ id: "new", cwd: work, title: "Newest", messages: [user("hi")] }),
          2_000,
        );
        // An empty stub, another project, a subagent transcript and a stray file.
        writeSession(
          root,
          "-work",
          "2026-10-25T11-00-00-000Z_stub.jsonl",
          sessionFile({ id: "stub", cwd: work }),
          3_000,
        );
        writeSession(
          root,
          "-other",
          "2026-10-25T12-00-00-000Z_other.jsonl",
          sessionFile({ id: "other", cwd: "/elsewhere", messages: [user("x")] }),
          4_000,
        );
        writeSession(
          root,
          "-work/2026-10-25T10-00-00-000Z_new",
          "agent-1.jsonl",
          sessionFile({ id: "sub", cwd: work, messages: [user("x")] }),
          5_000,
        );
        writeSession(root, "-work", "notes.txt", "not a session", 6_000);

        const only = (dir: string) => ({ roots: [dir], within: [dir] });
        const sessions = yield* listOmpSessions({ root, flat: false }, only(work));
        assert.deepStrictEqual(
          sessions.map((session) => [session.sessionId, session.title, session.firstMessage]),
          [
            ["new", "Newest", "hi"],
            ["old", null, "first question"],
          ],
        );
        assert.strictEqual(sessions[0]?.updatedAt, "1970-01-01T00:33:20.000Z");
        // A symlinked spelling of the directory finds the same sessions.
        const link = NodePath.join(root, "link");
        NodeFS.symlinkSync(work, link);
        assert.lengthOf(yield* listOmpSessions({ root, flat: false }, only(link)), 2);
        assert.deepStrictEqual(
          yield* listOmpSessions({ root: NodePath.join(root, "missing"), flat: false }, only(work)),
          [],
        );
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("matches sessions in folders below a root and attributes each to its roots", () =>
    run(
      Effect.gen(function* () {
        const root = yield* scratch;
        const project = NodePath.join(root, "project");
        const nested = NodePath.join(project, "packages", "app");
        const worktree = NodePath.join(root, "worktrees", "feature");
        const sibling = NodePath.join(root, "project-other");
        for (const dir of [nested, worktree, sibling]) NodeFS.mkdirSync(dir, { recursive: true });
        const write = (id: string, cwd: string, at: number) =>
          writeSession(
            root,
            `-${id}`,
            `2026-10-25T10-00-00-000Z_${id}.jsonl`,
            sessionFile({ id, cwd, messages: [user(id)] }),
            at,
          );
        write("root", project, 1_000);
        write("nested", nested, 2_000);
        write("worktree", worktree, 3_000);
        // Shares the root's name as a prefix but is not below it.
        write("sibling", sibling, 4_000);
        const location = { root, flat: false };

        const inProject = yield* listOmpSessions(location, {
          roots: [project, nested, worktree],
          within: [project, worktree],
        });
        assert.deepStrictEqual(
          inProject.map((session) => [session.sessionId, session.roots]),
          [
            ["worktree", [worktree]],
            ["nested", [project, nested]],
            ["root", [project]],
          ],
        );

        const everywhere = yield* listOmpSessions(location, { roots: [project], within: null });
        assert.deepStrictEqual(
          everywhere.map((session) => [session.sessionId, session.roots]),
          [
            ["sibling", []],
            ["worktree", []],
            ["nested", [project]],
            ["root", [project]],
          ],
        );

        const one = yield* listOmpSessions(location, {
          roots: [],
          within: null,
          sessionId: "nested",
        });
        assert.deepStrictEqual(
          one.map((session) => session.sessionId),
          ["nested"],
        );
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("finds a session by id where it was, or wherever /wt moved it", () =>
    run(
      Effect.gen(function* () {
        const root = yield* scratch;
        const name = "2026-10-25T10-00-00-000Z_s-9.jsonl";
        const body = sessionFile({ id: "s-9", cwd: "/repo", messages: [user("q")] });
        const original = writeSession(root, "-repo", name, body, 1_000);
        const location = { root, flat: false };
        assert.strictEqual(yield* findOmpSessionFile(location, "s-9", original), original);
        NodeFS.rmSync(original);
        const moved = writeSession(root, "-worktrees-repo-x", name, body, 2_000);
        assert.strictEqual(yield* findOmpSessionFile(location, "s-9", original), moved);
        assert.strictEqual(yield* findOmpSessionFile(location, "s-9"), moved);
        assert.isNull(yield* findOmpSessionFile(location, "missing"));
        // A file named for the id that holds another session does not count.
        writeSession(
          root,
          "-x",
          "2026-10-26T10-00-00-000Z_s-7.jsonl",
          sessionFile({ id: "other", cwd: "/x" }),
          3_000,
        );
        assert.isNull(yield* findOmpSessionFile(location, "s-7"));
        // PI_CODING_AGENT_SESSION_DIR keeps sessions without buckets.
        const flat = writeSession(root, "", "2026-10-25T10-00-00-000Z_f-1.jsonl", body, 1);
        assert.isNull(yield* findOmpSessionFile({ root, flat: true }, "f-1"));
        assert.strictEqual(yield* findOmpSessionFile({ root, flat: true }, "s-9", flat), flat);
      }).pipe(Effect.scoped),
    ),
  );

  it.effect("records each thread's session in its thread directory", () =>
    run(
      Effect.gen(function* () {
        const threads = yield* scratch;
        assert.isNull(yield* readOmpThreadSessionRecord(threads, "thread/a"));
        yield* writeOmpThreadSessionRecord(threads, {
          threadId: "thread/a",
          sessionId: "s-1",
          reportedSessionId: "fresh-1",
          sessionFile: "/s/1.jsonl",
        });
        yield* writeOmpThreadSessionRecord(threads, {
          threadId: "thread/b",
          sessionId: "s-2",
          reportedSessionId: "s-2",
          sessionFile: null,
        });
        const file = NodePath.join(threads, encodeURIComponent("thread/a"), "session.json");
        assert.strictEqual(NodeFS.statSync(file).mode & 0o777, 0o600);
        assert.deepStrictEqual(yield* readOmpThreadSessionRecord(threads, "thread/a"), {
          version: 1,
          threadId: "thread/a",
          sessionId: "s-1",
          reportedSessionId: "fresh-1",
          sessionFile: "/s/1.jsonl",
        });
        NodeFS.writeFileSync(
          NodePath.join(threads, encodeURIComponent("thread/b"), "session.json"),
          "{broken",
        );
        assert.deepStrictEqual(
          [...(yield* readOmpThreadSessionRecords(threads)).entries()],
          [["s-1", "thread/a"]],
        );
      }).pipe(Effect.scoped),
    ),
  );
});

describe("session history", () => {
  /** A `request` that pages `messages` like OMP and logs every `get_messages_page` it got. */
  const pagingProcess = (messages: ReadonlyArray<AgentMessage>, staleOnce = false) => {
    const calls: Array<{ readonly cursor?: string; readonly limit?: number }> = [];
    let stale = staleOnce;
    const request = (command: string, params: { cursor?: string; limit?: number }) =>
      Effect.suspend(() => {
        assert.strictEqual(command, "get_messages_page");
        calls.push(params);
        if (params.cursor !== undefined && stale) {
          stale = false;
          return Effect.fail(
            new OmpRpcCommandError({
              command,
              detail: "RPC message cursor is stale",
              code: "stale_cursor",
            }),
          );
        }
        const offset = params.cursor === undefined ? 0 : Number(params.cursor);
        const page = messages.slice(offset, offset + (params.limit ?? 100));
        const next = offset + page.length;
        return Effect.succeed({
          messages: page,
          totalMessages: messages.length,
          ...(next < messages.length ? { nextCursor: String(next) } : {}),
        } satisfies MessagesPage);
      });
    return { calls, process: { request } as never };
  };

  const conversation = [
    user("one"),
    fakeOmpFrames.assistant([{ type: "text", text: "two" }]),
    user("three"),
    fakeOmpFrames.assistant([
      { type: "thinking", thinking: "hidden" },
      { type: "toolCall", id: "t", name: "read", arguments: {} },
    ]),
    {
      role: "toolResult",
      toolCallId: "t",
      toolName: "read",
      content: [{ type: "text", text: "file" }],
      isError: false,
      timestamp: 0,
    } as AgentMessage,
    fakeOmpFrames.assistant([{ type: "text", text: "four" }]),
  ];

  it.effect("returns every page, oldest first, following nextCursor", () =>
    Effect.gen(function* () {
      const { calls, process } = pagingProcess(conversation);
      const pages = yield* readOmpHistoryPages(process, { limit: 4 });
      assert.deepStrictEqual(
        pages.map((page) => page.messages.length),
        [4, 2],
      );
      assert.deepStrictEqual(calls, [{ limit: 4 }, { limit: 4, cursor: "4" }]);
      assert.deepStrictEqual(
        pages.flatMap((page) => page.messages),
        conversation,
      );
    }),
  );

  it.effect("starts over when the session changed between pages", () =>
    Effect.gen(function* () {
      const { calls, process } = pagingProcess(conversation, true);
      const pages = yield* readOmpHistoryPages(process, { limit: 2 });
      assert.deepStrictEqual(
        pages.flatMap((page) => page.messages),
        conversation,
      );
      assert.deepStrictEqual(
        calls.map((call) => call.cursor ?? null),
        [null, "2", null, "2", "4"],
      );
    }),
  );

  it.effect("maps user and assistant text to thread messages outside any run", () =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const messages = ompHistoryMessages({
        threadId: ThreadId.make("thread/h"),
        sessionId: "s-h",
        messages: [...conversation, user("synthetic", { synthetic: true })],
        now,
      });
      assert.deepStrictEqual(
        messages.map((message) => [message.role, message.text, message.runId]),
        [
          ["user", "one", null],
          ["assistant", "two", null],
          ["user", "three", null],
          ["assistant", "four", null],
        ],
      );
      // Ids follow the message's place in the session, so a second read updates in place.
      const again = ompHistoryMessages({
        threadId: ThreadId.make("thread/h"),
        sessionId: "s-h",
        messages: conversation,
        now,
      });
      assert.deepStrictEqual(
        again.map((message) => message.id),
        messages.map((message) => message.id),
      );
      assert.strictEqual(DateTime.toEpochMillis(messages[0]!.createdAt), 1_793_000_000_000);
    }),
  );
});
