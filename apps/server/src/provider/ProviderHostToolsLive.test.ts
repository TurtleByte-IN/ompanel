// @effect-diagnostics nodeBuiltinImport:off -- the MCP SDK serves Node requests; the sudo probe is a one-off sync spawn.
// @effect-diagnostics globalConsoleInEffect:off -- the real-PTY tests print the terminal transcript as evidence.
import * as NodeChildProcess from "node:child_process";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, vi } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadProjection,
  type Project,
  ProjectId,
  ProviderInstanceId,
  type TerminalEvent,
  type TerminalSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import { ProviderHostTools } from "@t3tools/provider-core/server/ProviderHostTools";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import { TestClock } from "effect/testing";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import { stripTerminalControl } from "../terminal/TerminalCommand.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ProviderHostToolsLive from "./ProviderHostToolsLive.ts";

const threadId = ThreadId.make("thread-host-tools");
const projectId = ProjectId.make("project-host-tools");
const workspaceRoot = "/repo/project";
const terminalId = ProviderHostToolsLive.AGENT_TERMINAL_ID;
const eventBase = { threadId, terminalId, sequence: 1, createdAt: "2026-01-01T00:00:00.000Z" };

const snapshot = (cwd: string, pid: number): TerminalSessionSnapshot => ({
  threadId,
  terminalId,
  cwd,
  worktreePath: null,
  status: "running",
  pid,
  history: "",
  exitCode: null,
  exitSignal: null,
  label: "zsh",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

const sentinelOf = (data: string) => /(__T3_AGENT_DONE___[0-9a-f]+:)/.exec(data)?.[1];

const project = {
  id: projectId,
  title: "Host tools project",
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  deletedAt: null,
} as Project;

const makeProjection = (worktreePath: string | null = null): OrchestrationV2ThreadProjection =>
  ({
    thread: {
      id: threadId,
      projectId,
      title: "Host tools thread",
      branch: "dev",
      worktreePath,
      archivedAt: null,
      deletedAt: null,
    },
  }) as OrchestrationV2ThreadProjection;

interface HarnessOptions {
  /** Output the fake shell prints for a typed command; `undefined` leaves it running. */
  readonly reply?: (command: string) => string | undefined;
  readonly threadWorktreePath?: string | null;
  /** A real terminal manager instead of the scripted fake. */
  readonly terminalManager?: TerminalManager.TerminalManager["Service"];
  readonly shell?: string;
}

const makeHarness = Effect.fn(function* (options: HarnessOptions = {}) {
  const listeners = new Set<(event: TerminalEvent) => Effect.Effect<void>>();
  const writes = yield* Queue.unbounded<string>();
  const emit = (event: TerminalEvent) =>
    Effect.forEach([...listeners], (listener) => listener(event), { discard: true });
  const output = (data: string) => emit({ ...eventBase, type: "output", data });

  let shellPid: number | null = null;
  // Order of terminal operations, to check a command is typed only into a reopened shell.
  const calls: Array<string> = [];
  const open = vi.fn((input: { readonly cwd: string }) =>
    Effect.gen(function* () {
      calls.push("open");
      if (shellPid === null) {
        shellPid = 4242;
        yield* emit({ ...eventBase, type: "started", snapshot: snapshot(input.cwd, shellPid) });
        // An rc-file banner, which is not part of any command's output.
        yield* output("Welcome to the shell\r\n% \x1b[?2004h");
      }
      return snapshot(input.cwd, shellPid);
    }),
  );
  const close = vi.fn((_: unknown) =>
    Effect.suspend(() => {
      shellPid = null;
      return emit({ ...eventBase, type: "closed" });
    }),
  );
  const terminals = Layer.mock(TerminalManager.TerminalManager)({
    open,
    close,
    subscribe: (listener) =>
      Effect.sync(() => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
    write: (input) =>
      Queue.offer(writes, input.data).pipe(
        Effect.tap(() => Effect.sync(() => calls.push(input.data === "\x03" ? "ctrl-c" : "write"))),
        Effect.andThen(
          Effect.suspend(() => {
            const replied = input.data === "\x03" ? undefined : options.reply?.(input.data);
            return replied === undefined ? Effect.void : output(replied);
          }),
        ),
      ),
    closeIdle: () => Effect.void,
  });

  const dispatch = vi.fn((_: unknown) => Effect.succeed({ sequence: 1, storedEvents: [] }));
  const createWorktree = vi.fn(
    (input: { readonly newRefName?: string | undefined; readonly refName: string }) =>
      Effect.succeed({
        worktree: {
          path: `/worktrees/project/${input.newRefName}`,
          refName: input.newRefName ?? "detached",
        },
      }),
  );
  const localStatus = vi.fn((_: { readonly cwd: string }) =>
    Effect.succeed({
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "dev",
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
    }),
  );
  const runForThread = vi.fn((input: { readonly worktreePath: string }) =>
    Effect.succeed({
      status: "started",
      async: true,
      scriptId: "setup",
      scriptName: "Setup",
      scriptCommand: "vp i",
      terminalId: "setup-setup",
      cwd: input.worktreePath,
    } as const),
  );

  const tools = yield* ProviderHostToolsLive.make.pipe(
    Effect.provide(
      Layer.mergeAll(
        options.terminalManager === undefined
          ? terminals
          : Layer.succeed(TerminalManager.TerminalManager, options.terminalManager),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          dispatch,
          getThreadRecords: () =>
            Effect.succeed(makeProjection(options.threadWorktreePath ?? null)),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some(project)),
        }),
        Layer.mock(GitWorkflowService.GitWorkflowService)({
          localStatus,
          listLocalBranchNames: () => Effect.succeed(["dev"]),
          listRefs: () =>
            Effect.succeed({
              refs: [{ name: "dev", current: true, isDefault: false, worktreePath: workspaceRoot }],
              isRepo: true,
              hasPrimaryRemote: true,
              nextCursor: null,
              totalCount: 1,
            }),
          createWorktree,
          removeWorktree: () => Effect.void,
          deleteLocalBranch: () => Effect.void,
        }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({ runForThread }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshStatus: () => Effect.die("refreshStatus stub"),
        }),
        NodeCrypto.layer,
      ),
    ),
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Environment, { SHELL: options.shell ?? "/bin/zsh" }),
  );
  return {
    tools,
    writes,
    calls,
    output,
    open,
    close,
    dispatch,
    createWorktree,
    localStatus,
    runForThread,
  };
});

/** The fake shell: echo the typed command, print the reply, then the sentinel and a prompt. */
const replyWith =
  (body: string, exitCode: number) =>
  (command: string): string | undefined => {
    const sentinel = sentinelOf(command);
    return sentinel === undefined
      ? undefined
      : `${command.trim()}\r\n${body}\r\n${sentinel}${exitCode}\r\n% `;
  };

const closedNote =
  "[the agent terminal did not return to its prompt and was closed; the next command starts a new shell]";

describe("ProviderHostToolsLive terminal", () => {
  it.effect("returns the command's output and exit code from the agent terminal", () =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      const { tools, writes, open } = yield* makeHarness({ reply: replyWith("a\r\nb", 3) });
      const result = yield* tools.runTerminalCommand({
        threadId,
        cwd: "/repo/project",
        command: "printf 'a\\nb\\n'; exit 3",
        timeoutMs: 60_000,
        onOutputLine: (line) => Effect.sync(() => lines.push(line)),
      });

      expect(result).toEqual({ terminalId, output: "a\nb", exitCode: 3, timedOut: false });
      expect(lines).toEqual(["a", "b"]);
      expect(open).toHaveBeenCalledTimes(1);
      expect(open.mock.calls[0]![0]).toMatchObject({
        threadId,
        terminalId,
        cwd: "/repo/project",
        env: { NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat" },
      });
      const written = yield* Queue.takeAll(writes);
      expect(written).toHaveLength(1);
      expect(written[0]).toMatch(/^ \{ printf 'a\\nb\\n'; exit 3\r\}; printf/);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the open shell and its directory for the next command", () =>
    Effect.gen(function* () {
      const { tools, open } = yield* makeHarness({ reply: replyWith("ok", 0) });
      yield* tools.runTerminalCommand({ threadId, cwd: "/a", command: "cd sub", timeoutMs: 1_000 });
      yield* tools.runTerminalCommand({ threadId, cwd: "/b", command: "pwd", timeoutMs: 1_000 });
      expect(open.mock.calls.map(([input]) => input.cwd)).toEqual(["/a", "/a"]);
    }).pipe(Effect.scoped),
  );

  it.effect("sends Ctrl-C on timeout and waits for the shell to take input again", () =>
    Effect.gen(function* () {
      const { tools, writes, output } = yield* makeHarness();
      const fiber = yield* tools
        .runTerminalCommand({ threadId, cwd: "/repo", command: "sudo -v", timeoutMs: 5_000 })
        .pipe(Effect.forkChild);
      const typed = yield* Queue.take(writes);
      expect(typed).toContain("sudo -v");
      yield* output(`${typed.trim()}\r\nPassword:`);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Queue.take(writes)).toBe("\x03");
      expect(fiber.pollUnsafe()).toBeUndefined();

      yield* output(`\r\nsudo: a password is required\r\n${sentinelOf(typed)}1\r\n% `);
      expect(yield* Fiber.join(fiber)).toEqual({
        terminalId,
        output: "Password:\nsudo: a password is required",
        exitCode: null,
        timedOut: true,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a prompt the timed-out command was left waiting at", () =>
    Effect.gen(function* () {
      const { tools, writes, output } = yield* makeHarness();
      const fiber = yield* tools
        .runTerminalCommand({ threadId, cwd: "/repo", command: "read x", timeoutMs: 5_000 })
        .pipe(Effect.forkChild);
      const typed = yield* Queue.take(writes);
      yield* output(`${typed.trim()}\r\nName? `);
      yield* TestClock.adjust("5 seconds");
      yield* TestClock.adjust("3 seconds");
      expect(yield* Fiber.join(fiber)).toEqual({
        terminalId,
        output: `Name?\n${closedNote}`,
        exitCode: null,
        timedOut: true,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("closes the terminal when Ctrl-C does not bring the shell back", () =>
    Effect.gen(function* () {
      const { tools, writes, output, open, close, calls } = yield* makeHarness();
      const stuck = yield* tools
        .runTerminalCommand({ threadId, cwd: "/repo", command: "ssh host", timeoutMs: 5_000 })
        .pipe(Effect.forkChild);
      const typed = yield* Queue.take(writes);
      yield* output(`${typed.trim()}\r\nremote$ `);
      yield* TestClock.adjust("5 seconds");
      expect(yield* Queue.take(writes)).toBe("\x03");
      yield* TestClock.adjust("3 seconds");
      expect((yield* Fiber.join(stuck)).output).toBe(`remote$\n${closedNote}`);
      expect(close).toHaveBeenCalledTimes(1);
      expect(close.mock.calls[0]![0]).toEqual({ threadId, terminalId });

      const next = yield* tools
        .runTerminalCommand({ threadId, cwd: "/repo", command: "pwd", timeoutMs: 60_000 })
        .pipe(Effect.forkChild);
      const nextTyped = yield* Queue.take(writes);
      expect(open).toHaveBeenCalledTimes(2);
      expect(calls).toEqual(["open", "write", "ctrl-c", "open", "write"]);
      yield* output(`${nextTyped.trim()}\r\n/repo\r\n${sentinelOf(nextTyped)}0\r\n% `);
      expect(yield* Fiber.join(next)).toMatchObject({ output: "/repo", exitCode: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("sends Ctrl-C when the caller interrupts the command", () =>
    Effect.gen(function* () {
      const { tools, writes, output, close } = yield* makeHarness();
      const fiber = yield* tools
        .runTerminalCommand({ threadId, cwd: "/repo", command: "sleep 100", timeoutMs: 60_000 })
        .pipe(Effect.forkChild);
      const typed = yield* Queue.take(writes);
      const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      expect(yield* Queue.take(writes)).toBe("\x03");
      yield* output(`${typed.trim()}\r\n^C\r\n${sentinelOf(typed)}130\r\n% `);
      yield* Fiber.join(interrupting);
      expect(close).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );

  it.effect("closes the terminal when an interrupted command does not stop", () =>
    Effect.gen(function* () {
      const { tools, writes, close } = yield* makeHarness();
      const fiber = yield* tools
        .runTerminalCommand({ threadId, cwd: "/repo", command: "ssh host", timeoutMs: 60_000 })
        .pipe(Effect.forkChild);
      yield* Queue.take(writes);
      const interrupting = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);
      expect(yield* Queue.take(writes)).toBe("\x03");
      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(interrupting);
      expect(close.mock.calls[0]![0]).toEqual({ threadId, terminalId });
    }).pipe(Effect.scoped),
  );

  it.effect("reports no exit code when the terminal closes before the command ends", () =>
    Effect.gen(function* () {
      const { tools, writes, close } = yield* makeHarness();
      const fiber = yield* tools
        .runTerminalCommand({ threadId, cwd: "/repo", command: "exit", timeoutMs: 60_000 })
        .pipe(Effect.forkChild);
      yield* Queue.take(writes);
      yield* close({});
      const result = yield* Fiber.join(fiber);
      expect(result).toMatchObject({ exitCode: null, timedOut: false });
    }).pipe(Effect.scoped),
  );

  it.effect("runs one command at a time per thread", () =>
    Effect.gen(function* () {
      const { tools, writes, output } = yield* makeHarness();
      const first = yield* tools
        .runTerminalCommand({ threadId, cwd: "/repo", command: "echo one", timeoutMs: 60_000 })
        .pipe(Effect.forkChild);
      const firstWrite = yield* Queue.take(writes);
      const second = yield* tools
        .runTerminalCommand({ threadId, cwd: "/repo", command: "echo two", timeoutMs: 60_000 })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.size(writes)).toBe(0);

      yield* output(`${firstWrite.trim()}\r\none\r\n${sentinelOf(firstWrite)}0\r\n% `);
      expect(yield* Fiber.join(first)).toMatchObject({ output: "one", exitCode: 0 });
      const secondWrite = yield* Queue.take(writes);
      expect(secondWrite).toContain("echo two");
      yield* output(`${secondWrite.trim()}\r\ntwo\r\n${sentinelOf(secondWrite)}1\r\n% `);
      expect(yield* Fiber.join(second)).toMatchObject({ output: "two", exitCode: 1 });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the tail of long output", () =>
    Effect.gen(function* () {
      const line = "x".repeat(1_000);
      const body = Array.from({ length: 100 }, (_, index) => `${index}${line}`).join("\r\n");
      const { tools } = yield* makeHarness({ reply: replyWith(body, 0) });
      const result = yield* tools.runTerminalCommand({
        threadId,
        cwd: "/repo",
        command: "yes",
        timeoutMs: 60_000,
      });
      const lines = result.output.split("\n");
      expect(lines[0]).toBe("[earlier output truncated]");
      expect(lines.at(-1)).toBe(`99${line}`);
      expect(result.output.length).toBeLessThanOrEqual(64 * 1024 + 64);
    }).pipe(Effect.scoped),
  );
});

describe("ProviderHostToolsLive worktrees", () => {
  it.effect("creates a worktree from the thread's current branch", () =>
    Effect.gen(function* () {
      const { tools, createWorktree, localStatus } = yield* makeHarness();
      const worktree = yield* tools.createThreadWorktree({ threadId, branch: "feature/x" });
      expect(worktree).toEqual({ path: "/worktrees/project/feature/x", branch: "feature/x" });
      expect(localStatus.mock.calls[0]![0]).toEqual({ cwd: workspaceRoot });
      expect(createWorktree.mock.calls[0]![0]).toEqual({
        cwd: workspaceRoot,
        refName: "dev",
        newRefName: "feature/x",
        baseRefName: "dev",
        path: null,
      });
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a branch name that already exists", () =>
    Effect.gen(function* () {
      const { tools, createWorktree } = yield* makeHarness();
      const error = yield* tools
        .createThreadWorktree({ threadId, branch: "dev" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ operation: "worktree" });
      expect(error.detail).toContain("Branch 'dev' already exists");
      expect(createWorktree).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );

  it.effect("binds the thread, restarts its agent shell and runs the setup script", () =>
    Effect.gen(function* () {
      const { tools, dispatch, close, runForThread } = yield* makeHarness({
        threadWorktreePath: "/worktrees/project/old",
      });
      yield* tools.bindThreadWorktree({
        threadId,
        worktree: { path: "/worktrees/project/feature/x", branch: "feature/x" },
      });
      expect(dispatch.mock.calls[0]![0]).toMatchObject({
        type: "thread.metadata.update",
        threadId,
        branch: "feature/x",
        worktreePath: "/worktrees/project/feature/x",
        expectedWorktreePath: "/worktrees/project/old",
      });
      expect(close.mock.calls[0]![0]).toEqual({ threadId, terminalId });
      expect(runForThread.mock.calls[0]![0]).toMatchObject({
        threadId,
        worktreePath: "/worktrees/project/feature/x",
      });
    }).pipe(Effect.scoped),
  );
});

describe("ProviderHostToolsLive late binding", () => {
  it.effect("forwards driver calls to the implementation bound after the drivers", () =>
    Effect.gen(function* () {
      const tools = yield* ProviderHostTools;
      const binding = yield* ProviderHostToolsLive.ProviderHostToolsBinding;
      const pending = yield* tools
        .runTerminalCommand({ threadId, cwd: "/repo", command: "echo hi", timeoutMs: 1_000 })
        .pipe(Effect.forkChild);
      yield* Deferred.succeed(
        binding,
        ProviderHostTools.of({
          runTerminalCommand: (input) =>
            Effect.succeed({ terminalId, output: input.command, exitCode: 0, timedOut: false }),
          createThreadWorktree: () => Effect.die("unused"),
          bindThreadWorktree: () => Effect.die("unused"),
          connectMcp: () => Effect.die("unused"),
        }),
      );
      expect((yield* Fiber.join(pending)).output).toBe("echo hi");
    }).pipe(
      // Separate references to the shared binding layer must resolve to one binding, also
      // through `Layer.unwrap` as in the provider instance registry hydration.
      Effect.provide(
        Layer.merge(
          Layer.unwrap(Effect.succeed(ProviderHostToolsLive.layer)),
          ProviderHostToolsLive.layerBinding,
        ),
      ),
    ),
  );
});

/** A stateless streamable-HTTP MCP server with one `echo` tool, recording request credentials. */
function listenMcpServer() {
  const seenAuth: string[] = [];
  const http = NodeHttp.createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? "");
    const mcp = new Server(
      { name: "host-tools-test", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "echo",
          description: "Echoes text",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async (request) => ({
      content: [
        { type: "text", text: `echo: ${String(request.params.arguments?.text)}` },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "resource_link", uri: "file:///notes.md", name: "notes" },
      ],
    }));
    // No session id generator: stateless, a fresh server per request.
    const transport = new StreamableHTTPServerTransport({});
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    // The SDK's transport class and interface disagree under `exactOptionalPropertyTypes`.
    const serverTransport = transport as Parameters<typeof mcp.connect>[0];
    void mcp.connect(serverTransport).then(() => transport.handleRequest(req, res));
  });
  const { promise, resolve } = Promise.withResolvers<{
    readonly url: string;
    readonly http: NodeHttp.Server;
    readonly seenAuth: ReadonlyArray<string>;
  }>();
  http.listen(0, "127.0.0.1", () => {
    const { port } = http.address() as NodeNet.AddressInfo;
    resolve({ url: `http://127.0.0.1:${port}/mcp`, http, seenAuth });
  });
  return promise;
}

function closeMcpServer(http: NodeHttp.Server) {
  const { promise, resolve } = Promise.withResolvers<void>();
  http.closeAllConnections();
  http.close(() => resolve());
  return promise;
}

const startMcpServer = Effect.acquireRelease(Effect.promise(listenMcpServer), ({ http }) =>
  Effect.promise(() => closeMcpServer(http)),
);

describe("ProviderHostToolsLive MCP client", () => {
  it.live("lists and calls the thread's T3 MCP tools with the session credential", () =>
    Effect.gen(function* () {
      const server = yield* startMcpServer;
      const { tools } = yield* makeHarness();
      const session: McpProviderSessionConfig = {
        environmentId: EnvironmentId.make("environment-host-tools"),
        threadId,
        providerSessionId: "provider-session-host-tools",
        providerInstanceId: ProviderInstanceId.make("omp"),
        endpoint: server.url,
        authorizationHeader: "Bearer host-tools-token",
        browserToolsAvailable: false,
      };
      const client = yield* tools.connectMcp(session);
      expect(client.tools).toEqual([
        {
          name: "echo",
          description: "Echoes text",
          inputSchema: { type: "object", properties: { text: { type: "string" } } },
        },
      ]);
      const result = yield* client.call("echo", { text: "hi" });
      expect(result).toEqual({
        isError: false,
        content: [
          { type: "text", text: "echo: hi" },
          { type: "image", data: "aGk=", mimeType: "image/png" },
          { type: "text", text: "[resource link: notes file:///notes.md]" },
        ],
      });
      expect(server.seenAuth.length).toBeGreaterThan(0);
      expect(new Set(server.seenAuth)).toEqual(new Set(["Bearer host-tools-token"]));
    }).pipe(Effect.scoped),
  );

  it.live("fails with an MCP error when the server is unreachable", () =>
    Effect.gen(function* () {
      const { tools } = yield* makeHarness();
      const error = yield* tools
        .connectMcp({
          environmentId: EnvironmentId.make("environment-host-tools"),
          threadId,
          providerSessionId: "provider-session-host-tools",
          providerInstanceId: ProviderInstanceId.make("omp"),
          endpoint: "http://127.0.0.1:9/mcp",
          authorizationHeader: "Bearer secret-token",
          browserToolsAvailable: false,
        })
        .pipe(Effect.flip);
      expect(error.operation).toBe("mcp");
      expect(error.detail).not.toContain("secret-token");
    }).pipe(Effect.scoped),
  );
});

// The shell the server would start for this user, with their real rc files; Windows has none.
const loginShell = NodeOS.userInfo().shell;
const nodePtyLoads = (() => {
  if (loginShell === null) return false;
  try {
    NodeModule.createRequire(import.meta.url)("node-pty");
    return true;
  } catch {
    return false;
  }
})();
// Only a sudo that would really ask: no askpass helper, no cached or passwordless credential.
const sudoAsksForPassword =
  nodePtyLoads &&
  process.env.SUDO_ASKPASS === undefined &&
  NodeChildProcess.spawnSync("sudo", ["-n", "true"], { stdio: "ignore" }).status === 1;

const makeLiveTools = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-host-tools-" });
  const manager = yield* TerminalManager.makeWithOptions({
    logsDir: `${baseDir}/logs`,
    ptyAdapter: yield* PtyAdapter.PtyAdapter,
    shellResolver: () => loginShell ?? "/bin/sh",
  });
  const { tools } = yield* makeHarness({
    terminalManager: manager,
    shell: loginShell ?? "/bin/sh",
  });
  return { manager, tools, cwd: baseDir };
});

// Skipped without a posix login shell (Windows) or a loadable node-pty: no real PTY to drive.
describe.runIf(nodePtyLoads)("ProviderHostToolsLive with a real PTY", () => {
  const layerLive = Layer.mergeAll(
    NodeServices.layer,
    ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
    NodePtyAdapter.layer.pipe(Layer.provide(NodeServices.layer)),
  );

  it.live("runs a command in the user's shell and reports its exit code", () =>
    Effect.gen(function* () {
      const { tools, cwd } = yield* makeLiveTools;
      const result = yield* tools.runTerminalCommand({
        threadId,
        cwd,
        // A subshell: the command runs in the agent's own shell, where `exit` would end it.
        command: "printf 'a\\nb\\n'; (exit 3)",
        timeoutMs: 30_000,
      });
      console.log(`[real PTY] result: ${JSON.stringify(result)}`);
      expect(result.exitCode).toBe(3);
      expect(result.timedOut).toBe(false);
      expect(result.output.split("\n")).toEqual(expect.arrayContaining(["a", "b"]));
    }).pipe(Effect.scoped, Effect.provide(layerLive)),
  );

  it.live("keeps `cd` and `export` for the next command in the same shell", () =>
    Effect.gen(function* () {
      const { tools, cwd } = yield* makeLiveTools;
      const fileSystem = yield* FileSystem.FileSystem;
      const target = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-host-tools-cd-" });
      const first = yield* tools.runTerminalCommand({
        threadId,
        cwd,
        command: `cd '${target}' && export K08_PERSIST=yes`,
        timeoutMs: 30_000,
      });
      expect(first).toMatchObject({ exitCode: 0, timedOut: false });
      const second = yield* tools.runTerminalCommand({
        threadId,
        cwd,
        command: `pwd -P; printf '%s\\n' "$K08_PERSIST"`,
        timeoutMs: 30_000,
      });
      console.log(`[real PTY] after cd/export: ${JSON.stringify(second)}`);
      expect(second).toMatchObject({
        output: `${yield* fileSystem.realPath(target)}\nyes`,
        exitCode: 0,
      });
    }).pipe(Effect.scoped, Effect.provide(layerLive)),
  );

  // Skipped unless sudo would really prompt: with an askpass helper, cached credentials or
  // passwordless sudo (CI runners) there is no password prompt to observe.
  it.live.runIf(sudoAsksForPassword)(
    "leaves a sudo password prompt waiting in the terminal until Ctrl-C",
    () =>
      Effect.gen(function* () {
        const { manager, tools, cwd } = yield* makeLiveTools;
        let transcript = "";
        const prompted = yield* Deferred.make<void>();
        const unsubscribe = yield* manager.subscribe((event) => {
          if (event.terminalId !== terminalId || event.type !== "output") return Effect.void;
          transcript += event.data;
          return /[Pp]assword/.test(transcript)
            ? Deferred.succeed(prompted, undefined).pipe(Effect.asVoid)
            : Effect.void;
        });
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));

        const sudo = yield* tools
          .runTerminalCommand({ threadId, cwd, command: "sudo -k && sudo -v", timeoutMs: 60_000 })
          .pipe(Effect.forkChild);
        yield* Deferred.await(prompted);
        const promptTranscript = stripTerminalControl(transcript);
        console.log(`[real PTY] terminal output while sudo waits:\n${promptTranscript}`);
        expect(promptTranscript).toMatch(/[Pp]assword/);
        // The wrapper's exit-code sentinel has not been printed: the command is still running.
        expect(promptTranscript).not.toMatch(/__T3_AGENT_DONE___[0-9a-f]+:\d/);
        expect(sudo.pollUnsafe()).toBeUndefined();

        yield* Fiber.interrupt(sudo);
        const after = yield* tools.runTerminalCommand({
          threadId,
          cwd,
          command: "echo after-sudo",
          timeoutMs: 30_000,
        });
        console.log(
          `[real PTY] terminal output after Ctrl-C:\n${stripTerminalControl(transcript).slice(promptTranscript.length)}`,
        );
        console.log(`[real PTY] next command: ${JSON.stringify(after)}`);
        expect(after).toMatchObject({ exitCode: 0, timedOut: false });
        expect(after.output.split("\n")).toContain("after-sudo");
      }).pipe(Effect.scoped, Effect.provide(layerLive)),
  );
});
