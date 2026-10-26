// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import type {
  AgentMessage,
  AssistantMessage,
  AssistantMessageEvent,
  RpcServerFrame,
  SubagentLifecyclePayload,
  Usage,
} from "../../../contract/src/wire.generated.ts";
import type { OmpSessionsLocation } from "../ompSessions.ts";
import { isProcessAlive } from "../processTree.ts";

/**
 * One reaction of the fake. `respond`/`fail` answer the triggering command with its id; the
 * string `"$id"` anywhere inside `emit`/`emitChunked`/`respond` is replaced by that id.
 */
export type FakeOmpStep =
  | { readonly respond: unknown }
  | { readonly fail: string; readonly code?: string }
  | { readonly emit: RpcServerFrame | Record<string, unknown> }
  /** Written as v2 `rpc_chunk` frames of 256 KiB. */
  | { readonly emitChunked: RpcServerFrame | Record<string, unknown> }
  /** Written to stdout verbatim, for framing violations. */
  | { readonly writeRaw: string }
  | { readonly sleepMs: number }
  /** Exits once stdout is flushed; later steps never run. */
  | { readonly exit: number };

/**
 * What the fake does beyond `ready` and the handshake. Steps run in order, one chain per
 * process; a command's steps run on every receipt of it. Unscripted commands keep the defaults:
 * `get_state` reports the current session id (a `session_info_update` the fake wrote changes
 * it), anything else fails with `code: "unsupported"`.
 */
export interface FakeOmpScript {
  /** Right after `ready`, before the handshake. */
  readonly afterReady?: ReadonlyArray<FakeOmpStep>;
  /** After the `negotiate_protocol` response; defaults to a `notice` "negotiated". */
  readonly afterNegotiate?: ReadonlyArray<FakeOmpStep>;
  readonly commands?: Readonly<Record<string, ReadonlyArray<FakeOmpStep>>>;
}

export const FAKE_OMP_FIXTURE = NodeURL.fileURLToPath(
  new URL("./fakeOmp.fixture.mjs", import.meta.url),
);

export interface FakeOmpTree {
  readonly omp: number;
  readonly child: number;
  readonly grandchild: number;
}

/** A scratch directory the fake writes its observations into, removed with the scope. */
export const makeFakeOmpState = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-omp-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
).pipe(
  Effect.map((dir) => ({
    dir,
    env: (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({
      ...process.env,
      FAKE_OMP_STATE: dir,
      ...vars,
    }),
    argv: (): { readonly argv: ReadonlyArray<string>; readonly cwd: string } =>
      JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "argv.json"), "utf8")),
    /** The adapter's `sessions` option: OMP's sessions directory for this fake. */
    sessions: {
      root: NodePath.join(dir, "omp-sessions"),
      flat: false,
    } satisfies OmpSessionsLocation,
    /** Env vars that make the fake keep sessions on disk under `root` (default `sessions.root`). */
    sessionStore: (
      root: string = NodePath.join(dir, "omp-sessions"),
      options: { readonly autoResume?: boolean } = {},
    ): Record<string, string> => ({
      FAKE_OMP_SESSIONS_DIR: root,
      ...(options.autoResume === true ? { FAKE_OMP_AUTO_RESUME: "1" } : {}),
    }),
    /** Writes `script` for the next fake started with these vars; merge into `env(...)`. */
    script: (script: FakeOmpScript): Record<string, string> => {
      const file = NodePath.join(NodeFS.mkdtempSync(NodePath.join(dir, "script-")), "script.json");
      NodeFS.writeFileSync(file, JSON.stringify(script));
      return { FAKE_OMP_SCRIPT: file };
    },
    /** Every command the fake read from stdin, in order. */
    commands: (): ReadonlyArray<Record<string, unknown>> => {
      const file = NodePath.join(dir, "commands.jsonl");
      return NodeFS.existsSync(file)
        ? NodeFS.readFileSync(file, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        : [];
    },
    events: (): ReadonlyArray<string> => {
      const file = NodePath.join(dir, "events.log");
      return NodeFS.existsSync(file)
        ? NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean)
        : [];
    },
    tree: (): FakeOmpTree | undefined => {
      const file = NodePath.join(dir, "tree.json");
      return NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : undefined;
    },
    /** A `#!/bin/sh` omp that execs the fake, so its pid is the fake's pid. */
    executable: (): string => {
      const file = NodePath.join(dir, "omp");
      NodeFS.writeFileSync(
        file,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_OMP_FIXTURE)} "$@"\n`,
        { mode: 0o755 },
      );
      return file;
    },
  })),
);

export type FakeOmpState = Effect.Success<typeof makeFakeOmpState>;

/** Polls `check` with wall time until it holds or `timeoutMs` passes. */
export const waitUntil = (check: () => boolean, timeoutMs = 10_000) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (!check()) {
      if ((yield* Clock.currentTimeMillis) > deadline) return false;
      yield* Effect.sleep("20 millis");
    }
    return true;
  });

export const allDead = (pids: ReadonlyArray<number>) => pids.every((pid) => !isProcessAlive(pid));

const FAKE_USAGE: Usage = {
  input: 10,
  output: 5,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 15,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const assistant = (content: AssistantMessage["content"]): AssistantMessage => ({
  role: "assistant",
  content,
  api: "openai-completions",
  provider: "fake",
  model: "fake-model",
  usage: FAKE_USAGE,
  stopReason: content.some((block) => block.type === "toolCall") ? "toolUse" : "stop",
  timestamp: 0,
});

export interface FakeOmpTool {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly result: unknown;
  readonly isError?: boolean;
}

export interface FakeOmpPromptTurn {
  /** Streamed as one `text_delta` per entry. */
  readonly text: ReadonlyArray<string>;
  readonly thinking?: ReadonlyArray<string>;
  readonly tool?: FakeOmpTool;
  readonly messageId?: string;
}

/** Wire frames shaped like the pinned contract, for scripting the fake. */
export const fakeOmpFrames = {
  usage: FAKE_USAGE,
  assistant,
  notice: (message: string): RpcServerFrame => ({ type: "notice", level: "info", message }),
  /** `/rename` carries the title; `/fresh` and session switches carry a new `sessionId`. */
  sessionInfoUpdate: (sessionId: string, title?: string): RpcServerFrame => ({
    type: "session_info_update",
    sessionId,
    ...(title === undefined ? {} : { title }),
  }),
  subagentLifecycle: (
    payload: Partial<SubagentLifecyclePayload> & Pick<SubagentLifecyclePayload, "id" | "status">,
  ): RpcServerFrame => ({
    type: "subagent_lifecycle",
    payload: { agent: "task", agentSource: "bundled", index: 0, ...payload },
  }),
  subagentEvent: (id: string, event: RpcServerFrame): Record<string, unknown> => ({
    type: "subagent_event",
    payload: { id, event },
  }),
  commandOutput: (text: string): RpcServerFrame => ({ type: "command_output", text }),
  /**
   * The steps of one accepted `prompt`: ack, `agent_start`, a streamed assistant message (thinking
   * then text deltas), an optional tool execution, `agent_end`, then `prompt_result` for `$id`.
   */
  promptTurn: (turn: FakeOmpPromptTurn): ReadonlyArray<FakeOmpStep> => {
    const messageId = turn.messageId ?? "fake-message-1";
    const thinking = (turn.thinking ?? []).join("");
    const text = turn.text.join("");
    const blocks: AssistantMessage["content"] = [
      ...(thinking === "" ? [] : [{ type: "thinking" as const, thinking }]),
      { type: "text" as const, text },
      ...(turn.tool === undefined
        ? []
        : [
            {
              type: "toolCall" as const,
              id: turn.tool.toolCallId,
              name: turn.tool.toolName,
              arguments: turn.tool.args,
            },
          ]),
    ];
    const final = assistant(blocks);
    const partial = assistant([]);
    const update = (event: AssistantMessageEvent): FakeOmpStep => ({
      emit: { type: "message_update", message: partial, assistantMessageEvent: event, messageId },
    });
    const textIndex = thinking === "" ? 0 : 1;
    const messages: Array<AgentMessage> = [final];
    const toolSteps: Array<FakeOmpStep> = [];
    if (turn.tool !== undefined) {
      const { toolCallId, toolName, args, result } = turn.tool;
      const isError = turn.tool.isError ?? false;
      toolSteps.push(
        { emit: { type: "tool_execution_start", toolCallId, toolName, args } },
        { emit: { type: "tool_execution_end", toolCallId, toolName, result, isError } },
      );
      messages.push({
        role: "toolResult",
        toolCallId,
        toolName,
        content: [{ type: "text", text: JSON.stringify(result) }],
        isError,
        timestamp: 0,
      });
    }
    return [
      { respond: { agentInvoked: true } },
      { emit: { type: "agent_start" } },
      { emit: { type: "turn_start" } },
      { emit: { type: "message_start", message: partial, messageId } },
      update({ type: "start", partial }),
      ...(thinking === ""
        ? []
        : [
            update({ type: "thinking_start", contentIndex: 0, partial }),
            ...(turn.thinking ?? []).map((delta) =>
              update({ type: "thinking_delta", contentIndex: 0, delta, partial }),
            ),
            update({ type: "thinking_end", contentIndex: 0, content: thinking, partial }),
          ]),
      update({ type: "text_start", contentIndex: textIndex, partial }),
      ...turn.text.map((delta) =>
        update({ type: "text_delta", contentIndex: textIndex, delta, partial }),
      ),
      update({ type: "text_end", contentIndex: textIndex, content: text, partial }),
      update({
        type: "done",
        reason: turn.tool === undefined ? "stop" : "toolUse",
        message: final,
      }),
      { emit: { type: "message_end", message: final, messageId } },
      ...toolSteps,
      { emit: { type: "turn_end", message: final, toolResults: [] } },
      { emit: { type: "agent_end", messages } },
      {
        emit: {
          type: "prompt_result",
          id: "$id",
          status: "completed",
          agentInvoked: true,
          sessionSettled: true,
        },
      },
    ];
  },
};
