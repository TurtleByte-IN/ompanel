/**
 * T3 server capabilities a provider can hand to its agent as tools of its own: run a command in
 * the thread's T3 terminal, give a thread a T3-managed worktree, and reach the thread's T3 MCP
 * toolkits (preview, orchestration/delegation, worktree, …). Implemented in `apps/server`, which
 * owns the terminal manager, git workflow and MCP server; provider packages only see this seam.
 */
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

export class ProviderHostToolError extends Schema.TaggedError<ProviderHostToolError>()(
  "ProviderHostToolError",
  {
    operation: Schema.Literals(["terminal", "worktree", "mcp"]),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface ProviderHostTerminalCommandInput {
  readonly threadId: ThreadId;
  /** Directory the thread's agent terminal opens in when it is not open yet. */
  readonly cwd: string;
  readonly command: string;
  /** The command is interrupted (Ctrl-C) after this long and reported as timed out. */
  readonly timeoutMs: number;
  /** Each output line as it arrives, terminal control sequences removed. */
  readonly onOutputLine?: (line: string) => Effect.Effect<void>;
}

export interface ProviderHostTerminalCommandResult {
  /** The T3 terminal the command ran in; the user can open it in the thread's terminal drawer. */
  readonly terminalId: string;
  /** Output lines joined with `\n`, keeping the tail when it is long. */
  readonly output: string;
  /** `null` when the terminal closed, the command was interrupted, or it timed out. */
  readonly exitCode: number | null;
  readonly timedOut: boolean;
}

export interface ProviderHostWorktree {
  readonly path: string;
  readonly branch: string;
}

export interface ProviderHostMcpTool {
  readonly name: string;
  readonly description: string;
  /** JSON Schema of the tool's arguments. */
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

export type ProviderHostMcpContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

export interface ProviderHostMcpCallResult {
  readonly content: ReadonlyArray<ProviderHostMcpContent>;
  readonly isError: boolean;
}

/** A connection to the thread's T3 MCP server; closed with the scope it was opened in. */
export interface ProviderHostMcpClient {
  readonly tools: ReadonlyArray<ProviderHostMcpTool>;
  readonly call: (
    name: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<ProviderHostMcpCallResult, ProviderHostToolError>;
}

export class ProviderHostTools extends Context.Service<
  ProviderHostTools,
  {
    /**
     * Runs `command` in the thread's agent terminal, a T3 terminal session the user can watch
     * and type into (a `sudo` password prompt waits there for the user). Commands of one
     * thread run one at a time. Interrupting the effect sends Ctrl-C to the command.
     */
    readonly runTerminalCommand: (
      input: ProviderHostTerminalCommandInput,
    ) => Effect.Effect<ProviderHostTerminalCommandResult, ProviderHostToolError>;
    /**
     * Creates a T3 worktree for the thread's project on a new `branch`, starting from the branch
     * the thread is on. Does not move the thread; see `bindThreadWorktree`.
     */
    readonly createThreadWorktree: (input: {
      readonly threadId: ThreadId;
      readonly branch: string;
    }) => Effect.Effect<ProviderHostWorktree, ProviderHostToolError>;
    /**
     * Points the thread at `worktree` (thread metadata) and runs the project's setup script
     * there. Changing the workspace detaches the thread's live provider session.
     */
    readonly bindThreadWorktree: (input: {
      readonly threadId: ThreadId;
      readonly worktree: ProviderHostWorktree;
    }) => Effect.Effect<void, ProviderHostToolError>;
    /** Connects to the thread's T3 MCP server with its session credential and lists its tools. */
    readonly connectMcp: (
      session: McpProviderSessionConfig,
    ) => Effect.Effect<ProviderHostMcpClient, ProviderHostToolError, Scope.Scope>;
  }
>()("@t3tools/provider-core/server/ProviderHostTools") {}
