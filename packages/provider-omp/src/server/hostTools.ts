/**
 * T3 for a thread's OMP (K-08; docs/omp/host-tools.md): a `terminal` host tool in place of the
 * disabled `bash`, the thread's T3 MCP tools as host tools, and `/wt` via `host_cwd_change_request`.
 * Features the pinned contract lacks stay off.
 */
import type { ThreadId } from "@t3tools/contracts";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import type * as ProviderHostTools from "@t3tools/provider-core/server/ProviderHostTools";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Scope from "effect/Scope";

import type {
  HostCwdChangeRequest,
  HostCwdChangeResult,
  HostToolCallRequest,
  HostToolDefinition,
  HostToolResultPayload,
  RpcServerFrame,
} from "../../contract/src/wire.generated.ts";
import type { OmpRpcProcess } from "./rpcProcess.ts";

/** Name of the host tool that replaces OMP's built-in `bash`. */
export const OMP_HOST_TERMINAL_TOOL = "terminal";
/** First RPC contract with `set_tool_enabled` (oh-my-pi C-04). */
const OMP_TOOL_TOGGLE_CONTRACT = "1.1.0";
/** First RPC contract with `set_host_cwd_change` and `host_cwd_change_request` (oh-my-pi#38). */
export const OMP_HOST_CWD_CHANGE_CONTRACT = "1.5.0";

const DEFAULT_TIMEOUT_SECONDS = 300;
const MAX_TIMEOUT_SECONDS = 3_600;
/** Partial output is streamed to OMP at most this often. */
const UPDATE_INTERVAL_MS = 250;
const UPDATE_TAIL_CHARS = 16_384;
/** C0/C1 controls other than `\n` and `\t`, DEL, and bidi overrides/isolates. */
const HIDDEN_COMMAND_CHARACTER =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069]/u;

/** Same major, and a minor (then patch) at least `minimum`'s. */
export const contractAtLeast = (version: string, minimum: string): boolean => {
  const parse = (value: string) => value.split(".").map((part) => Number.parseInt(part, 10));
  const [major, minor = 0, patch = 0] = parse(version);
  const [needMajor, needMinor = 0, needPatch = 0] = parse(minimum);
  if (major !== needMajor) return false;
  return minor !== needMinor ? minor > needMinor : patch >= needPatch;
};

const OMP_HOST_TERMINAL_DEFINITION: HostToolDefinition = {
  name: OMP_HOST_TERMINAL_TOOL,
  label: "Terminal",
  description: [
    "Run a shell command in the user's terminal for this thread and return its output and exit code.",
    "This is the shell tool: use it wherever you would use bash.",
    "Commands run one at a time in one persistent interactive shell, so `cd` and exported variables carry over to later commands.",
    "The user can watch the terminal and type into it: a command that asks for a password (sudo, ssh) waits there for the user.",
    "Do not start servers or watchers that never exit; they hold the terminal until the timeout interrupts them.",
  ].join(" "),
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to run." },
      timeout: {
        type: "number",
        description: `Seconds before the command is interrupted with Ctrl-C (default ${DEFAULT_TIMEOUT_SECONDS}, max ${MAX_TIMEOUT_SECONDS}).`,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  loadMode: "essential",
};

export interface OmpHostBridgeInput {
  readonly process: OmpRpcProcess;
  readonly threadId: ThreadId;
  readonly cwd: string;
  /** T3's host services; absent outside the T3 server (then the bridge does nothing). */
  readonly hostTools: ProviderHostTools.ProviderHostTools["Service"] | undefined;
  /** The thread's T3 MCP credential, when T3 issued one. */
  readonly mcpSession: McpProviderSessionConfig | undefined;
}

export interface OmpHostBridge {
  /** Registers the host tools and turns on host-owned directory changes. Never fails. */
  readonly setup: Effect.Effect<void>;
  /** Handles host requests; returns false for frames that are not host requests. */
  readonly handleFrame: (frame: RpcServerFrame) => Effect.Effect<boolean>;
}

const text = (value: string): HostToolResultPayload => ({
  content: [{ type: "text", text: value }],
});

/** Terminal output as the model sees it: output, then how the command ended. */
export const formatTerminalResult = (
  result: ProviderHostTools.ProviderHostTerminalCommandResult,
  timeoutSeconds: number,
): HostToolResultPayload => {
  const ending = result.timedOut
    ? `Command timed out after ${timeoutSeconds} s and was interrupted.`
    : result.exitCode === null
      ? "Command ended without an exit code (the terminal closed or it was interrupted)."
      : result.exitCode === 0
        ? ""
        : `Command exited with code ${result.exitCode}.`;
  const body = result.output.length > 0 ? result.output : "(no output)";
  return {
    content: [{ type: "text", text: ending === "" ? body : `${body}\n\n${ending}` }],
    details: {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      terminalId: result.terminalId,
    },
  };
};

export const makeOmpHostBridge = Effect.fn("makeOmpHostBridge")(function* (
  input: OmpHostBridgeInput,
): Effect.fn.Return<OmpHostBridge, never, Scope.Scope> {
  const { process, threadId, hostTools } = input;
  if (hostTools === undefined) {
    return { setup: Effect.void, handleFrame: () => Effect.succeed(false) } satisfies OmpHostBridge;
  }
  // Host calls run beside the frame loop; a cancel interrupts the one it names.
  const calls = yield* FiberMap.make<string>();
  // The MCP connection lives as long as the session that created the bridge.
  const sessionScope = yield* Effect.scope;
  let mcp: ProviderHostTools.ProviderHostMcpClient | undefined;
  let mcpToolNames = new Set<string>();
  let terminalRegistered = false;
  let cwd = input.cwd;

  const reply = (id: string, result: HostToolResultPayload, isError = false) =>
    process.send({ type: "host_tool_result", id, result, ...(isError ? { isError } : {}) });

  const connectMcp = Effect.gen(function* () {
    if (input.mcpSession === undefined) return [];
    // A T3 MCP server that does not answer must not hold the session open.
    const client = yield* hostTools
      .connectMcp(input.mcpSession)
      .pipe(Effect.timeout("15 seconds"), Effect.provideService(Scope.Scope, sessionScope));
    mcp = client;
    mcpToolNames = new Set(client.tools.map((tool) => tool.name));
    return client.tools.map((tool): HostToolDefinition => ({
      name: tool.name,
      description: tool.description,
      parameters: { ...tool.inputSchema },
    }));
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("T3 MCP tools are unavailable to OMP", { detail: error.message }).pipe(
        Effect.as([]),
      ),
    ),
  );

  const disableBuiltinBash = Effect.gen(function* () {
    if (!contractAtLeast(process.contractVersion, OMP_TOOL_TOGGLE_CONTRACT)) {
      yield* Effect.logInfo("OMP keeps its own bash: the pinned contract has no set_tool_enabled", {
        contractVersion: process.contractVersion,
      });
      return false;
    }
    const result = yield* process.request("set_tool_enabled", { tool: "bash", enabled: false });
    return result.enabled === false;
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not disable OMP's bash; commands stay inside OMP", {
        detail: error.message,
      }).pipe(Effect.as(false)),
    ),
  );

  const restoreBuiltinBash = process
    .request("set_tool_enabled", { tool: "bash", enabled: true })
    .pipe(
      Effect.asVoid,
      Effect.catch((error) =>
        Effect.logWarning("Could not turn OMP's bash back on; the thread has no shell", {
          detail: error.message,
        }),
      ),
    );

  const setup = Effect.gen(function* () {
    terminalRegistered = yield* disableBuiltinBash;
    const bashDisabled = terminalRegistered;
    const tools = [
      ...(terminalRegistered ? [OMP_HOST_TERMINAL_DEFINITION] : []),
      ...(yield* connectMcp),
    ];
    if (tools.length > 0) {
      yield* process.request("set_host_tools", { tools }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("OMP refused T3's host tools", { detail: error.message }).pipe(
            Effect.andThen(
              Effect.sync(() => {
                terminalRegistered = false;
                mcpToolNames = new Set();
              }),
            ),
            // Without the T3 terminal the thread needs OMP's own bash back (the terminal fallback).
            Effect.andThen(bashDisabled ? restoreBuiltinBash : Effect.void),
          ),
        ),
      );
    }
    if (contractAtLeast(process.contractVersion, OMP_HOST_CWD_CHANGE_CONTRACT)) {
      yield* process
        .request("set_host_cwd_change", { enabled: true })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("OMP keeps handling /wt and /move itself", { detail: error.message }),
          ),
        );
    }
  });

  const runTerminal = Effect.fnUntraced(function* (call: HostToolCallRequest) {
    const command = call.arguments["command"];
    if (typeof command !== "string" || command.trim().length === 0) {
      return yield* reply(call.id, text("`command` must be a non-empty string."), true);
    }
    // The approval prompt cannot show these, but the shell acts on them (\r ends a line, ESC and
    // C1 codes drive the terminal, bidi overrides reorder what is displayed): never run them.
    const hidden = HIDDEN_COMMAND_CHARACTER.exec(command);
    if (hidden !== null) {
      const codePoint = (hidden[0].codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
      return yield* reply(
        call.id,
        text(
          `The command contains the control character U+${codePoint}, which the approval prompt cannot show; it was not run. Use only printable text, newlines and tabs.`,
        ),
        true,
      );
    }
    const requested = call.arguments["timeout"];
    const timeoutSeconds =
      typeof requested === "number" && Number.isFinite(requested) && requested > 0
        ? Math.min(requested, MAX_TIMEOUT_SECONDS)
        : DEFAULT_TIMEOUT_SECONDS;
    let streamed = "";
    let lastUpdateMs = 0;
    const onOutputLine = Effect.fn("OmpHostBridge.onOutputLine")(function* (line: string) {
      streamed = `${streamed}${line}\n`.slice(-UPDATE_TAIL_CHARS);
      const now = yield* Clock.currentTimeMillis;
      if (now - lastUpdateMs < UPDATE_INTERVAL_MS) return;
      lastUpdateMs = now;
      yield* process
        .send({ type: "host_tool_update", id: call.id, partialResult: text(streamed) })
        .pipe(Effect.ignore);
    });
    const result = yield* hostTools.runTerminalCommand({
      threadId,
      cwd,
      command,
      timeoutMs: Math.round(timeoutSeconds * 1_000),
      onOutputLine,
    });
    yield* reply(call.id, formatTerminalResult(result, timeoutSeconds));
  });

  const runMcp = Effect.fnUntraced(function* (
    client: ProviderHostTools.ProviderHostMcpClient,
    call: HostToolCallRequest,
  ) {
    const result = yield* client.call(call.toolName, call.arguments);
    yield* reply(
      call.id,
      { content: result.content.map((block) => ({ ...block })) },
      result.isError,
    );
  });

  const handleToolCall = (call: HostToolCallRequest) =>
    Effect.suspend(() => {
      if (call.toolName === OMP_HOST_TERMINAL_TOOL && terminalRegistered) return runTerminal(call);
      if (mcp !== undefined && mcpToolNames.has(call.toolName)) return runMcp(mcp, call);
      return reply(call.id, text(`Host tool "${call.toolName}" is not registered.`), true);
    }).pipe(
      Effect.catch((error) => reply(call.id, text(error.message), true)),
      Effect.ignore,
    );

  const answerCwdChange = (
    request: HostCwdChangeRequest,
    answer: Omit<HostCwdChangeResult, "type" | "id">,
  ) =>
    process.send({ type: "host_cwd_change_result", id: request.id, ...answer }).pipe(Effect.ignore);

  const handleCwdChange = Effect.fn("OmpHostBridge.handleCwdChange")(function* (
    request: HostCwdChangeRequest,
  ) {
    if (request.reason === "move") {
      return yield* answerCwdChange(request, {
        accepted: false,
        error:
          "a T3 thread stays in its project or worktree; start a new thread in that directory instead",
      });
    }
    const branch = request.branch?.trim() ?? "";
    if (branch.length === 0) {
      return yield* answerCwdChange(request, { accepted: false, error: "no branch name" });
    }
    const created = yield* hostTools.createThreadWorktree({ threadId, branch }).pipe(Effect.result);
    if (created._tag === "Failure") {
      return yield* answerCwdChange(request, { accepted: false, error: created.failure.message });
    }
    const worktree = created.success;
    // Answer first: binding the thread detaches this session once this turn has ended, and OMP
    // has moved its session into the worktree by then.
    yield* answerCwdChange(request, { accepted: true, cwd: worktree.path });
    cwd = worktree.path;
    yield* hostTools.bindThreadWorktree({ threadId, worktree }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("OMP moved into a T3 worktree the thread could not be bound to", {
          worktreePath: worktree.path,
          detail: error.message,
        }),
      ),
    );
  });

  const handleFrame = Effect.fn("OmpHostBridge.handleFrame")(function* (
    frame: RpcServerFrame,
  ): Effect.fn.Return<boolean> {
    if (frame.type === "host_tool_call") {
      yield* FiberMap.run(calls, frame.id, handleToolCall(frame));
      return true;
    }
    if (frame.type === "host_tool_cancel") {
      yield* FiberMap.remove(calls, frame.targetId);
      return true;
    }
    if (frame.type === "host_cwd_change_request") {
      yield* FiberMap.run(calls, frame.id, handleCwdChange(frame));
      return true;
    }
    if (frame.type === "host_cwd_change_cancel") {
      yield* FiberMap.remove(calls, frame.targetId);
      return true;
    }
    return false;
  });

  return { setup, handleFrame } satisfies OmpHostBridge;
});
