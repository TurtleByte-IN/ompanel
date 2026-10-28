/**
 * `ProviderHostTools` for drivers. Drivers are built before the thread services this needs, so
 * `layer` forwards to the implementation `layerBind` publishes later through `layerBinding`.
 */
import { CommandId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import {
  type ProviderHostMcpCallResult,
  type ProviderHostMcpContent,
  type ProviderHostMcpTool,
  type ProviderHostThreadWorkspace,
  ProviderHostToolError,
  ProviderHostTools,
} from "@t3tools/provider-core/server/ProviderHostTools";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { projectScriptTerminalInput } from "@t3tools/shared/projectScripts";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";

import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { makeWorkspaceOwnerResolver } from "./WorkspaceOwner.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import {
  completionSentinel,
  completionSentinelPattern,
  makeTerminalCommandObserver,
  resolveCompletionShell,
  wrapCommandForCompletion,
} from "../terminal/TerminalCommand.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";

/** The one terminal per thread that agent commands are typed into. */
export const AGENT_TERMINAL_ID = "agent";

const COMPLETION_SENTINEL_PREFIX = "__T3_AGENT_DONE__";
const OUTPUT_LINE_MAX_LENGTH = 4_000;
const OUTPUT_MAX_LENGTH = 64 * 1024;
const OUTPUT_TRUNCATED_MARKER = "[earlier output truncated]";
const CTRL_C = "\x03";
// How long Ctrl-C gets to bring the shell back to our sentinel before the terminal is closed.
const CTRL_C_GRACE = "3 seconds";
const TERMINAL_CLOSED_NOTE =
  "[the agent terminal did not return to its prompt and was closed; the next command starts a new shell]";
// Pagers and colour make agent-read output noisy or block on a keypress nobody sends.
const AGENT_TERMINAL_ENV = {
  NO_COLOR: "1",
  FORCE_COLOR: "0",
  COLORTERM: "",
  PAGER: "cat",
  GIT_PAGER: "cat",
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

const hostToolError = (operation: ProviderHostToolError["operation"], detail: string) =>
  new ProviderHostToolError({ operation, detail });

const mapToolError = (operation: ProviderHostToolError["operation"], prefix: string) =>
  Effect.mapError((error: unknown) =>
    hostToolError(operation, `${prefix}: ${errorMessage(error)}`),
  );

/** Keeps the tail of the output within `OUTPUT_MAX_LENGTH` characters. */
function makeOutputCollector() {
  const lines: Array<string> = [];
  let length = 0;
  let truncated = false;
  return {
    push(line: string) {
      lines.push(line);
      length += line.length + 1;
      while (length > OUTPUT_MAX_LENGTH && lines.length > 1) {
        length -= lines.shift()!.length + 1;
        truncated = true;
      }
    },
    text(): string {
      return (truncated ? [OUTPUT_TRUNCATED_MARKER, ...lines] : lines).join("\n");
    },
  };
}

type McpClientContentBlock = { readonly type: string } & Record<string, unknown>;

function describeMcpContent(block: McpClientContentBlock): ProviderHostMcpContent {
  switch (block.type) {
    case "text":
      return { type: "text", text: String(block.text ?? "") };
    case "image":
      return { type: "image", data: String(block.data ?? ""), mimeType: String(block.mimeType) };
    case "audio":
      return {
        type: "text",
        text: `[audio content omitted: ${String(block.mimeType)}, ${String(block.data ?? "").length} base64 characters]`,
      };
    case "resource": {
      const resource = (block.resource ?? {}) as Record<string, unknown>;
      return typeof resource.text === "string"
        ? { type: "text", text: `[resource ${String(resource.uri)}]\n${resource.text}` }
        : {
            type: "text",
            text: `[binary resource omitted: ${String(resource.uri)}${
              typeof resource.mimeType === "string" ? ` (${resource.mimeType})` : ""
            }]`,
          };
    }
    case "resource_link":
      return {
        type: "text",
        text: `[resource link: ${String(block.name ?? "")} ${String(block.uri)}]`,
      };
    default:
      return { type: "text", text: JSON.stringify(block) };
  }
}

/** Maps an MCP `tools/call` result, including the pre-2024-11 `toolResult` shape. */
function toProviderHostMcpCallResult(result: Record<string, unknown>): ProviderHostMcpCallResult {
  const content = Array.isArray(result.content)
    ? (result.content as ReadonlyArray<McpClientContentBlock>).map(describeMcpContent)
    : "toolResult" in result
      ? [{ type: "text" as const, text: JSON.stringify(result.toolResult) }]
      : [];
  if (content.length === 0 && result.structuredContent !== undefined) {
    return {
      content: [{ type: "text", text: JSON.stringify(result.structuredContent) }],
      isError: result.isError === true,
    };
  }
  return { content, isError: result.isError === true };
}

export const make = Effect.gen(function* () {
  const terminalManager = yield* TerminalManager.TerminalManager;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  // Absent in a runtime without settings: every project is then untrusted.
  const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const setupScriptRunner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const vcsStatusBroadcaster = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const completionShell = resolveCompletionShell(
    yield* HostProcess.Platform,
    yield* HostProcess.Environment,
  );
  const { observeTerminalCompletion, watchShellReadiness } = makeTerminalCommandObserver(
    terminalManager,
    { outputLineMaxLength: OUTPUT_LINE_MAX_LENGTH },
  );

  // One shell cannot run two typed commands at once.
  const threadLocks = new Map<string, Semaphore.Semaphore>();
  const threadLock = (threadId: string) => {
    let lock = threadLocks.get(threadId);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      threadLocks.set(threadId, lock);
    }
    return lock;
  };

  // The agent shell each thread has open: its launch directory, and its pid to notice a new shell.
  const agentShells = new Map<string, { readonly cwd: string; readonly pid: number | null }>();
  const stopWatchingShells = yield* terminalManager.subscribe((event) =>
    Effect.sync(() => {
      if (
        event.terminalId === AGENT_TERMINAL_ID &&
        (event.type === "exited" || event.type === "closed")
      ) {
        agentShells.delete(event.threadId);
      }
    }),
  );
  yield* Effect.addFinalizer(() => Effect.sync(stopWatchingShells));

  const runTerminalCommandUnlocked = Effect.fn("ProviderHostTools.runTerminalCommand")(function* (
    input: Parameters<ProviderHostTools["Service"]["runTerminalCommand"]>[0],
  ) {
    const threadId = input.threadId;
    const terminalId = AGENT_TERMINAL_ID;
    const token = (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).replaceAll("-", "");
    const sentinel = completionSentinel(COMPLETION_SENTINEL_PREFIX, token);
    // The current shell, not a subshell, so `cd` and `export` persist between commands.
    const commandLine = wrapCommandForCompletion(
      input.command,
      completionShell,
      sentinel,
      "current",
    );
    const output = makeOutputCollector();
    // Shell startup output (rc-file banners) only matters if the command never got typed, e.g.
    // a startup prompt still waits for the user.
    const startupOutput = makeOutputCollector();
    let typed = false;
    const onOutputLine = input.onOutputLine;

    // Subscribe before opening and writing so neither shell startup nor the sentinel is missed.
    const observed = yield* observeTerminalCompletion({
      threadId,
      terminalId,
      sentinel,
      sentinelPattern: completionSentinelPattern(COMPLETION_SENTINEL_PREFIX, token),
      echoedWrapperLines: commandLine.split("\r").filter((line) => line.length > 0),
      ignoreOutputAfterExit: true,
      onOutputLine: (line) =>
        Effect.suspend(() => {
          if (!typed) {
            startupOutput.push(line);
            return Effect.void;
          }
          output.push(line);
          return onOutputLine === undefined ? Effect.void : onOutputLine(line);
        }),
    });
    // PowerShell has no line-editor signal; keep its immediate write.
    const readiness =
      completionShell === "powershell"
        ? undefined
        : yield* watchShellReadiness({
            threadId,
            terminalId,
            onStartupPrompt: observed.flushPartialLine,
          });
    const unsubscribe = Effect.sync(() => {
      observed.unsubscribe();
      readiness?.unsubscribe();
    });

    const run = Effect.gen(function* () {
      const known = agentShells.get(threadId);
      // An open shell keeps its launch directory; passing another would restart it and lose `cd`.
      const snapshot = yield* terminalManager
        .open({ threadId, terminalId, cwd: known?.cwd ?? input.cwd, env: AGENT_TERMINAL_ENV })
        .pipe(mapToolError("terminal", "Unable to open the agent terminal"));
      const freshShell = known === undefined || snapshot.pid === null || known.pid !== snapshot.pid;
      agentShells.set(threadId, { cwd: snapshot.cwd, pid: snapshot.pid });
      // Input typed while a new shell starts can be swallowed by an rc-file prompt.
      const shell = readiness !== undefined && freshShell ? yield* readiness.wait : "ready";
      readiness?.unsubscribe();
      if (shell === "exited") {
        yield* observed.abandon;
      } else {
        typed = true;
        yield* terminalManager
          .write({ threadId, terminalId, data: projectScriptTerminalInput(commandLine) })
          .pipe(mapToolError("terminal", "Unable to type the command into the agent terminal"));
      }
      // Not `completion`: a timeout must keep listening while Ctrl-C takes effect.
      return yield* observed.finished;
    });

    // Keep the thread's lock until Ctrl-C brings the shell back (our sentinel prints only then),
    // or the next keystrokes reach the foreground program. If it never comes (an `ssh` session),
    // close the terminal. Succeeds with whether it was closed.
    const stopCommand = Effect.gen(function* () {
      yield* terminalManager.write({ threadId, terminalId, data: CTRL_C }).pipe(Effect.ignore);
      const stopped = yield* observed.finished.pipe(Effect.timeoutOption(CTRL_C_GRACE));
      if (Option.isSome(stopped)) return false;
      // Keep a prompt the command was left waiting at (a `sudo` password prompt has no newline).
      yield* observed.flushPartialLine;
      agentShells.delete(threadId);
      yield* terminalManager.close({ threadId, terminalId }).pipe(Effect.ignore);
      return true;
    });

    return yield* Effect.gen(function* () {
      const completion = yield* run.pipe(
        Effect.timeoutOption(Duration.millis(Math.max(0, input.timeoutMs))),
        Effect.onInterrupt(() => stopCommand),
      );
      if (Option.isSome(completion)) {
        return {
          terminalId,
          output: output.text(),
          exitCode: completion.value.exitCode,
          timedOut: false,
        };
      }
      const closed = yield* stopCommand;
      const text = (typed ? output : startupOutput).text();
      return {
        terminalId,
        output: closed
          ? [text, TERMINAL_CLOSED_NOTE].filter((part) => part.length > 0).join("\n")
          : text,
        exitCode: null,
        timedOut: true,
      };
    }).pipe(Effect.ensuring(unsubscribe));
  });

  const runTerminalCommand: ProviderHostTools["Service"]["runTerminalCommand"] = (input) =>
    threadLock(input.threadId).withPermits(1)(runTerminalCommandUnlocked(input));

  const loadThread = (threadId: ThreadId) =>
    threadManagement.getThreadRecords(threadId, []).pipe(
      Effect.mapError((error) =>
        hostToolError(
          "worktree",
          error._tag === "OrchestratorProjectionError"
            ? `Thread '${threadId}' was not found.`
            : `Unable to read thread ${threadId}: ${errorMessage(error)}`,
        ),
      ),
      Effect.filterOrFail(
        (projection) => projection.thread.deletedAt === null,
        () => hostToolError("worktree", `Thread '${threadId}' was not found.`),
      ),
    );

  const loadProject = (threadId: ThreadId, projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      mapToolError("worktree", `Unable to read project ${projectId}`),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              hostToolError(
                "worktree",
                `Project '${projectId}' was not found for thread '${threadId}'.`,
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const createThreadWorktree: ProviderHostTools["Service"]["createThreadWorktree"] = Effect.fn(
    "ProviderHostTools.createThreadWorktree",
  )(function* (input) {
    const projection = yield* loadThread(input.threadId);
    if (projection.thread.archivedAt !== null) {
      return yield* hostToolError(
        "worktree",
        `Thread '${input.threadId}' is archived and cannot get a worktree.`,
      );
    }
    const project = yield* loadProject(input.threadId, projection.thread.projectId);
    const workspaceRoot = project.workspaceRoot;
    const statusCwd = projection.thread.worktreePath ?? workspaceRoot;

    const localStatus = yield* gitWorkflow
      .localStatus({ cwd: statusCwd })
      .pipe(mapToolError("worktree", "Unable to read git status"));
    if (!localStatus.isRepo) {
      return yield* hostToolError("worktree", `'${statusCwd}' is not a git repository.`);
    }
    if (localStatus.refName === null) {
      return yield* hostToolError(
        "worktree",
        `Could not determine the current branch of '${statusCwd}' (detached HEAD?); check out a branch to start the worktree from.`,
      );
    }
    const baseRef = localStatus.refName;

    const localBranchNames = yield* gitWorkflow
      .listLocalBranchNames(workspaceRoot)
      .pipe(mapToolError("worktree", "Unable to list branches"));
    if (localBranchNames.includes(input.branch)) {
      const existingRef = yield* gitWorkflow
        .listRefs({ cwd: workspaceRoot, query: input.branch, refKind: "local" })
        .pipe(
          Effect.map((result) =>
            result.refs.find((ref) => ref.name === input.branch && ref.isRemote !== true),
          ),
          Effect.orElseSucceed(() => undefined),
        );
      const checkoutPath = existingRef?.worktreePath ?? null;
      return yield* hostToolError(
        "worktree",
        `Branch '${input.branch}' already exists${
          checkoutPath === null ? "" : ` and is checked out at '${checkoutPath}'`
        }. Choose a different branch name, or delete the existing branch${
          checkoutPath === null ? "" : " and its worktree"
        } first.`,
      );
    }

    const created = yield* gitWorkflow
      .createWorktree({
        cwd: workspaceRoot,
        refName: baseRef,
        newRefName: input.branch,
        baseRefName: baseRef,
        path: null,
      })
      .pipe(mapToolError("worktree", "Unable to create the worktree"));
    return { path: created.worktree.path, branch: created.worktree.refName };
  });

  const bindThreadWorktree: ProviderHostTools["Service"]["bindThreadWorktree"] = Effect.fn(
    "ProviderHostTools.bindThreadWorktree",
  )(function* (input) {
    const { threadId, worktree } = input;
    const projection = yield* loadThread(threadId);
    if (projection.thread.archivedAt !== null) {
      return yield* hostToolError(
        "worktree",
        `Thread '${threadId}' is archived and cannot be moved to a worktree.`,
      );
    }
    const project = yield* loadProject(threadId, projection.thread.projectId);
    const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const commandId = CommandId.make(
      ["command", "host-tools", encodeURIComponent(threadId), "worktree-bind", uuid].join(":"),
    );

    const removeWorktree = gitWorkflow
      .removeWorktree({ cwd: project.workspaceRoot, path: worktree.path, force: true })
      .pipe(
        Effect.andThen(
          gitWorkflow.deleteLocalBranch({
            cwd: project.workspaceRoot,
            refName: worktree.branch,
            force: true,
          }),
        ),
        Effect.ignoreCause({ log: true }),
      );

    // Re-pointing the thread detaches the calling provider session, which can interrupt this
    // call; finish the binding and start the setup script regardless.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* threadManagement
          .dispatch({
            type: "thread.metadata.update",
            commandId,
            threadId,
            branch: worktree.branch,
            worktreePath: worktree.path,
            expectedWorktreePath: projection.thread.worktreePath,
          })
          .pipe(
            Effect.catchCause((cause) =>
              removeWorktree.pipe(
                Effect.andThen(
                  Effect.fail(
                    hostToolError(
                      "worktree",
                      `Unable to point the thread at the worktree: ${errorMessage(Cause.squash(cause))}`,
                    ),
                  ),
                ),
              ),
            ),
          );

        // The next command opens a fresh shell in the worktree instead of the old directory.
        agentShells.delete(threadId);
        yield* terminalManager
          .close({ threadId, terminalId: AGENT_TERMINAL_ID })
          .pipe(Effect.ignore);

        yield* vcsStatusBroadcaster
          .refreshStatus(worktree.path)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);

        yield* setupScriptRunner
          .runForThread({
            threadId,
            projectId: projection.thread.projectId,
            projectCwd: project.workspaceRoot,
            worktreePath: worktree.path,
            project: {
              id: project.id,
              workspaceRoot: project.workspaceRoot,
              scripts: project.scripts,
            },
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("worktree setup script failed to start", {
                threadId,
                worktreePath: worktree.path,
                detail: errorMessage(Cause.squash(cause)),
              }),
            ),
          );
      }),
    );
  });

  const listAllTools = (client: Client) =>
    Effect.tryPromise({
      try: async () => {
        const tools: Array<ProviderHostMcpTool> = [];
        let cursor: string | undefined;
        do {
          const page = await client.listTools(cursor === undefined ? undefined : { cursor });
          for (const tool of page.tools) {
            tools.push({
              name: tool.name,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema as Readonly<Record<string, unknown>>,
            });
          }
          cursor = page.nextCursor;
        } while (cursor !== undefined);
        return tools;
      },
      catch: (error) =>
        hostToolError("mcp", `Unable to list the T3 MCP tools: ${errorMessage(error)}`),
    });

  /** `dir` with symlinks resolved, or as given when it cannot be resolved. */
  const canonicalDir = (dir: string) =>
    fileSystem.realPath(dir).pipe(Effect.orElseSucceed(() => path.resolve(dir)));

  /** Each local branch checked out in a worktree of the repository at `cwd`, as git lists it. */
  const listBranchCheckouts = Effect.fn("ProviderHostTools.listBranchCheckouts")(function* (
    cwd: string,
  ) {
    const checkouts: Array<{ readonly branch: string; readonly path: string }> = [];
    let cursor: number | undefined;
    do {
      const page = yield* gitWorkflow
        .listRefs({
          cwd,
          refKind: "local",
          limit: 200,
          // The first page re-reads git so worktrees added since the last listing count.
          ...(cursor === undefined ? { refresh: true } : { cursor }),
        })
        .pipe(mapToolError("worktree", "Unable to list the project's worktrees"));
      if (!page.isRepo) return checkouts;
      for (const ref of page.refs) {
        if (ref.isRemote !== true && ref.worktreePath !== null) {
          checkouts.push({ branch: ref.name, path: ref.worktreePath });
        }
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return checkouts;
  });

  const resolveThreadWorkspace: ProviderHostTools["Service"]["resolveThreadWorkspace"] = Effect.fn(
    "ProviderHostTools.resolveThreadWorkspace",
  )(function* (input) {
    const projection = yield* loadThread(input.threadId);
    if (projection.thread.archivedAt !== null) {
      return yield* hostToolError(
        "worktree",
        `Thread '${input.threadId}' is archived and cannot move.`,
      );
    }
    const project = yield* loadProject(input.threadId, projection.thread.projectId);
    const target = yield* fileSystem
      .realPath(input.path)
      .pipe(
        Effect.mapError(() =>
          hostToolError("worktree", `'${input.path}' is not an existing directory.`),
        ),
      );
    const rootReal = yield* canonicalDir(project.workspaceRoot);
    const currentReal = yield* canonicalDir(
      projection.thread.worktreePath ?? project.workspaceRoot,
    );
    const branchCheckouts = yield* Effect.forEach(
      yield* listBranchCheckouts(project.workspaceRoot),
      (checkout) => Effect.map(canonicalDir(checkout.path), (real) => ({ ...checkout, real })),
    );
    const checkouts = [
      {
        path: project.workspaceRoot,
        real: rootReal,
        branch: branchCheckouts.find((checkout) => checkout.real === rootReal)?.branch ?? null,
        worktreePath: null,
      },
      ...branchCheckouts
        .filter((checkout) => checkout.real !== rootReal)
        .map((checkout) => ({ ...checkout, worktreePath: checkout.path })),
    ];
    const match = checkouts.find((checkout) => checkout.real === target);
    if (match !== undefined) {
      return {
        path: match.path,
        branch: match.branch,
        worktreePath: match.worktreePath,
        current: match.real === currentReal,
      } satisfies ProviderHostThreadWorkspace;
    }
    const enclosing = checkouts.find((checkout) =>
      target.startsWith(`${checkout.real}${path.sep}`),
    );
    if (enclosing !== undefined) {
      return yield* hostToolError(
        "worktree",
        `'${input.path}' is inside the checkout '${enclosing.path}'; a T3 thread works at the root of a checkout. Move to '${enclosing.path}' instead.`,
      );
    }
    return yield* hostToolError(
      "worktree",
      `'${input.path}' is not a checkout of the project '${project.title}'; a T3 thread can move only to the project's folder or one of its git worktrees. To work in '${input.path}', add it as a project in T3 and start a thread there.`,
    );
  });

  const moveThreadWorkspace: ProviderHostTools["Service"]["moveThreadWorkspace"] = Effect.fn(
    "ProviderHostTools.moveThreadWorkspace",
  )(function* (input) {
    const { threadId, workspace } = input;
    const projection = yield* loadThread(threadId);
    if (projection.thread.archivedAt !== null) {
      return yield* hostToolError("worktree", `Thread '${threadId}' is archived and cannot move.`);
    }
    if (workspace.current || projection.thread.worktreePath === workspace.worktreePath) return;
    const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const commandId = CommandId.make(
      ["command", "host-tools", encodeURIComponent(threadId), "workspace-move", uuid].join(":"),
    );
    // Re-pointing the thread detaches the calling provider session, which can interrupt this
    // call; finish the move regardless.
    yield* Effect.uninterruptible(
      Effect.gen(function* () {
        yield* threadManagement
          .dispatch({
            type: "thread.metadata.update",
            commandId,
            threadId,
            branch: workspace.branch,
            worktreePath: workspace.worktreePath,
            expectedWorktreePath: projection.thread.worktreePath,
          })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.fail(
                hostToolError(
                  "worktree",
                  `Unable to point the thread at '${workspace.path}': ${errorMessage(Cause.squash(cause))}`,
                ),
              ),
            ),
          );

        // The next command opens a fresh shell in the new checkout instead of the old directory.
        agentShells.delete(threadId);
        yield* terminalManager
          .close({ threadId, terminalId: AGENT_TERMINAL_ID })
          .pipe(Effect.ignore);

        yield* vcsStatusBroadcaster
          .refreshStatus(workspace.path)
          .pipe(Effect.ignoreCause({ log: true }), Effect.forkDetach);
      }),
    );
  });

  const workspaceOwner = makeWorkspaceOwnerResolver({ projects, gitWorkflow, fileSystem, path });

  /** Trusted only for a project's own root or git worktree, by that project's trust. */
  const workspaceTrusted: ProviderHostTools["Service"]["workspaceTrusted"] = Effect.fn(
    "ProviderHostTools.workspaceTrusted",
  )(
    function* (cwd) {
      if (Option.isNone(serverSettings)) return false;
      const owner = yield* workspaceOwner(cwd);
      if (Option.isNone(owner)) return false;
      const settings = yield* serverSettings.value.getSettings;
      // Per project only: a server-wide value is never read.
      return settings.projectSettingsOverrides[owner.value]?.trustProjectAgentConfig === true;
    },
    Effect.orElseSucceed(() => false),
  );

  const connectMcp: ProviderHostTools["Service"]["connectMcp"] = (
    session: McpProviderSessionConfig,
  ) =>
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          const client = new Client({ name: "t3-provider-host-tools", version: "1.0.0" });
          // The SDK's own transport declares `sessionId?: string` without `| undefined`, which
          // `exactOptionalPropertyTypes` rejects against its `Transport` interface.
          const transport: Transport = new StreamableHTTPClientTransport(
            new URL(session.endpoint),
            { requestInit: { headers: { Authorization: session.authorizationHeader } } },
          ) as Transport;
          try {
            await client.connect(transport);
          } catch (error) {
            await client.close().catch(() => undefined);
            throw error;
          }
          return client;
        },
        catch: (error) =>
          hostToolError("mcp", `Unable to connect to the T3 MCP server: ${errorMessage(error)}`),
      }),
      (client) => Effect.tryPromise(() => client.close()).pipe(Effect.ignoreCause({ log: true })),
    ).pipe(
      Effect.flatMap((client) =>
        listAllTools(client).pipe(
          Effect.map((tools) => ({
            tools,
            call: (name: string, args: Readonly<Record<string, unknown>>) =>
              Effect.tryPromise({
                try: () => client.callTool({ name, arguments: { ...args } }),
                catch: (error) =>
                  hostToolError("mcp", `T3 MCP tool '${name}' failed: ${errorMessage(error)}`),
              }).pipe(
                Effect.map((result) =>
                  toProviderHostMcpCallResult(result as Record<string, unknown>),
                ),
              ),
          })),
        ),
      ),
    );

  return ProviderHostTools.of({
    runTerminalCommand,
    createThreadWorktree,
    bindThreadWorktree,
    resolveThreadWorkspace,
    moveThreadWorkspace,
    connectMcp,
    workspaceTrusted,
  });
});

/** Where `layerBind` publishes the implementation that `layer` forwards to. */
export class ProviderHostToolsBinding extends Context.Service<
  ProviderHostToolsBinding,
  Deferred.Deferred<ProviderHostTools["Service"]>
>()("t3/provider/ProviderHostToolsLive/ProviderHostToolsBinding") {}

/** Shared by reference: `layer` and `layerBind` must see the same binding. */
export const layerBinding = Layer.effect(
  ProviderHostToolsBinding,
  Deferred.make<ProviderHostTools["Service"]>(),
);

/** The service drivers get; each call waits until `layerBind` has been built. */
export const layer = Layer.effect(
  ProviderHostTools,
  Effect.gen(function* () {
    const binding = yield* ProviderHostToolsBinding;
    const bound = Deferred.await(binding);
    return ProviderHostTools.of({
      runTerminalCommand: Effect.fn("ProviderHostTools.runTerminalCommand")(function* (input) {
        const tools = yield* bound;
        return yield* tools.runTerminalCommand(input);
      }),
      createThreadWorktree: Effect.fn("ProviderHostTools.createThreadWorktree")(function* (input) {
        const tools = yield* bound;
        return yield* tools.createThreadWorktree(input);
      }),
      bindThreadWorktree: Effect.fn("ProviderHostTools.bindThreadWorktree")(function* (input) {
        const tools = yield* bound;
        return yield* tools.bindThreadWorktree(input);
      }),
      resolveThreadWorkspace: Effect.fn("ProviderHostTools.resolveThreadWorkspace")(
        function* (input) {
          const tools = yield* bound;
          return yield* tools.resolveThreadWorkspace(input);
        },
      ),
      moveThreadWorkspace: Effect.fn("ProviderHostTools.moveThreadWorkspace")(function* (input) {
        const tools = yield* bound;
        return yield* tools.moveThreadWorkspace(input);
      }),
      connectMcp: Effect.fn("ProviderHostTools.connectMcp")(function* (session) {
        const tools = yield* bound;
        return yield* tools.connectMcp(session);
      }),
      workspaceTrusted: Effect.fn("ProviderHostTools.workspaceTrusted")(
        function* (cwd) {
          const tools = yield* bound;
          return yield* tools.workspaceTrusted(cwd);
        },
        Effect.orElseSucceed(() => false),
      ),
    });
  }),
).pipe(Layer.provide(layerBinding));

/** Builds the implementation from the runtime's services and publishes it to `layer`. */
export const layerBind = Layer.effectDiscard(
  Effect.gen(function* () {
    const binding = yield* ProviderHostToolsBinding;
    const tools = yield* make;
    yield* Deferred.succeed(binding, tools);
  }),
).pipe(Layer.provide(layerBinding));
