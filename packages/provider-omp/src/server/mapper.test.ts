import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";

import type { SessionState, SessionStats } from "../../contract/src/wire.generated.ts";
import { OMP_PROVIDER, OmpThreadMapper, ompTodoSteps } from "./mapper.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;

const INSTANCE_ID = ProviderInstanceId.make("omp-work");
const THREAD_ID = ThreadId.make("thread:omp");
const T0 = DateTime.makeUnsafe("2026-10-26T10:00:00.000Z");
const at = (seconds: number) =>
  DateTime.makeUnsafe(Date.parse("2026-10-26T10:00:00.000Z") + seconds * 1000);

const STATE: SessionState = {
  sessionId: "session-a",
  sessionFile: "/sessions/a.jsonl",
  contextUsage: { tokens: 1_000, contextWindow: 200_000, percent: 0.5 },
  todoPhases: [],
};

const appThread = (title = "OMP thread"): OrchestrationV2AppThread => ({
  createdBy: "user",
  creationSource: "web",
  id: THREAD_ID,
  projectId: "project:omp" as OrchestrationV2AppThread["projectId"],
  title,
  providerInstanceId: INSTANCE_ID,
  modelSelection: { instanceId: INSTANCE_ID, model: "default" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
  forkedFrom: null,
  createdAt: T0,
  updatedAt: T0,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
});

/** A mapper bound to `STATE` with one turn running `text`. */
function startedTurn(text = "Hello omp", state: SessionState = STATE) {
  const mapper = new OmpThreadMapper({
    instanceId: INSTANCE_ID,
    providerSession: {
      id: ProviderSessionId.make("provider-session:omp"),
      driver: OMP_PROVIDER,
      providerInstanceId: INSTANCE_ID,
      status: "ready",
      cwd: "/work",
      model: "default",
      capabilities: {} as OrchestrationV2ProviderCapabilities,
      createdAt: T0,
      updatedAt: T0,
      lastError: null,
    },
  });
  const { providerThread } = mapper.bindThread({ threadId: THREAD_ID, state }, T0);
  const runId = RunId.make("run:omp:1");
  const startEvents = mapper.startTurn(
    {
      appThread: appThread(),
      threadId: THREAD_ID,
      runId,
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("run-attempt:omp:1"),
      rootNodeId: NodeId.make("node:omp:root"),
      providerThread,
      message: {
        messageId: "message:omp:1" as never,
        text,
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: { instanceId: INSTANCE_ID, model: "default" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/work",
      },
    },
    T0,
  );
  return { mapper, providerThread, startEvents };
}

const turnItems = (events: ReadonlyArray<Event>) =>
  events.flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));

const ofType = <T extends Event["type"]>(events: ReadonlyArray<Event>, type: T) =>
  events.filter((event): event is Extract<Event, { type: T }> => event.type === type);

const textDelta = (contentIndex: number, delta: string, type = "text_delta") => ({
  type: "message_update",
  messageId: "msg-1",
  message: { role: "assistant" },
  assistantMessageEvent: { type, contentIndex, delta },
});

const USAGE = {
  input: 1_200,
  output: 300,
  cacheRead: 4_000,
  cacheWrite: 500,
  totalTokens: 6_000,
  contextTokens: 5_800,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.02 },
};

describe("OmpThreadMapper", () => {
  it("binds the thread to the live session with its context meter", () => {
    const { providerThread, startEvents } = startedTurn();
    assert.strictEqual(providerThread.nativeThreadRef?.nativeId, "session-a");
    assert.deepStrictEqual(providerThread.contextUsage?.maxTokens, 200_000);
    assert.deepStrictEqual(
      startEvents.map((event) => event.type),
      ["provider_turn.updated", "provider_thread.updated", "provider_session.updated"],
    );
  });

  it("holds assistant deltas until a flush and completes the message on text_end", () => {
    const { mapper } = startedTurn();
    mapper.handleFrame(
      { type: "message_start", messageId: "msg-1", message: { role: "assistant" } } as never,
      at(1),
    );
    const first = mapper.handleFrame(textDelta(0, "Hel") as never, at(1));
    const second = mapper.handleFrame(textDelta(0, "lo") as never, at(1));
    assert.isTrue(first.streaming);
    assert.deepStrictEqual([...first.events, ...second.events], []);

    const flushed = mapper.flushStreaming(at(2));
    const [message] = ofType(flushed, "message.updated");
    assert.strictEqual(message?.message.text, "Hello");
    assert.isTrue(message?.message.streaming);
    assert.deepStrictEqual(mapper.flushStreaming(at(2)), []);

    const ended = mapper.handleFrame(
      {
        type: "message_update",
        messageId: "msg-1",
        message: { role: "assistant" },
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello there" },
      } as never,
      at(3),
    );
    const [item] = turnItems(ended.events);
    assert.strictEqual(item?.type, "assistant_message");
    assert.strictEqual(item?.type === "assistant_message" ? item.text : null, "Hello there");
    assert.strictEqual(item?.status, "completed");
    assert.isFalse(ofType(ended.events, "message.updated")[0]?.message.streaming);
  });

  it("streams thinking as reasoning, and narration thinking as the answer", () => {
    const { mapper } = startedTurn();
    mapper.handleFrame(
      { type: "message_start", messageId: "msg-1", message: { role: "assistant" } } as never,
      at(1),
    );
    mapper.handleFrame(textDelta(0, "Considering", "thinking_delta") as never, at(1));
    mapper.handleFrame(
      {
        type: "message_update",
        messageId: "msg-1",
        message: { role: "assistant" },
        assistantMessageEvent: {
          type: "thinking_delta",
          contentIndex: 1,
          delta: "I will check the tests.",
          partial: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "Considering" },
              { type: "thinking", thinking: "I will check the tests.", narration: true },
            ],
          },
        },
      } as never,
      at(1),
    );
    const items = turnItems(mapper.flushStreaming(at(2)));
    assert.deepStrictEqual(
      items.map((item) => [item.type, "text" in item ? item.text : null]),
      [
        ["reasoning", "Considering"],
        ["assistant_message", "I will check the tests."],
      ],
    );
  });

  it("maps a hashline edit to a file change card carrying its diff", () => {
    const { mapper } = startedTurn();
    const args = {
      input: "*** Begin Patch\n[src/app.ts#1A2B]\nPUT 3.=3:\n+const x = 2;\n*** End Patch",
    };
    const started = mapper.handleFrame(
      { type: "tool_execution_start", toolCallId: "call-1", toolName: "edit", args } as never,
      at(1),
    );
    const [running] = turnItems(started.events);
    assert.strictEqual(running?.status, "running");
    assert.strictEqual(running?.type === "file_change" ? running.fileName : null, "src/app.ts");

    const ended = mapper.handleFrame(
      {
        type: "tool_execution_end",
        toolCallId: "call-1",
        toolName: "edit",
        result: {
          content: [{ type: "text", text: "Updated src/app.ts" }],
          details: {
            diff: "-3|const x = 1;\n+3|const x = 2;",
            path: "/work/src/app.ts",
            op: "update",
            oldText: "const x = 1;\n",
            newText: "const x = 2;\n",
          },
        },
        isError: false,
      } as never,
      at(2),
    );
    const [card] = turnItems(ended.events);
    assert.strictEqual(card?.status, "completed");
    if (card?.type !== "file_change") return assert.fail(`expected file_change, got ${card?.type}`);
    assert.strictEqual(card.fileName, "/work/src/app.ts");
    assert.strictEqual(card.diffStr, "-3|const x = 1;\n+3|const x = 2;");
    assert.strictEqual(card.additions, 1);
    assert.strictEqual(card.deletions, 1);
    assert.strictEqual(card.newStr, "const x = 2;\n");
    assert.deepStrictEqual(card.changes, [{ operation: "update", path: "/work/src/app.ts" }]);
    // Start and end update the same card.
    assert.strictEqual(card.id, running?.id);
    assert.strictEqual(card.ordinal, running?.ordinal);
  });

  it("maps bash to a command card and labels xd:// devices by scheme", () => {
    const { mapper } = startedTurn();
    const bash = mapper.handleFrame(
      {
        type: "tool_execution_end",
        toolCallId: "call-bash",
        toolName: "bash",
        args: { command: "false" },
        result: { content: [{ type: "text", text: "exit 1" }], details: { exitCode: 1 } },
        isError: true,
      } as never,
      at(1),
    );
    const [command] = turnItems(bash.events);
    assert.deepStrictEqual(
      command?.type === "command_execution"
        ? [command.status, command.input, command.output, command.exitCode]
        : null,
      ["failed", "false", "exit 1", 1],
    );

    const xd = mapper.handleFrame(
      {
        type: "tool_execution_start",
        toolCallId: "call-xd",
        toolName: "write",
        args: { path: "xd://github", content: '{"op":"pr_view","number":3}' },
      } as never,
      at(2),
    );
    const [device] = turnItems(xd.events);
    if (device?.type !== "dynamic_tool")
      return assert.fail(`expected dynamic_tool, got ${device?.type}`);
    assert.strictEqual(device.title, "xd://github");
    assert.strictEqual(device.toolName, "xd://github");
    assert.deepStrictEqual(device.toolSource, {
      key: "omp-uri:xd",
      name: "xd://",
      kind: "integration",
    });
    assert.deepStrictEqual(device.input, { op: "pr_view", number: 3 });

    const other = mapper.handleFrame(
      {
        type: "tool_execution_start",
        toolCallId: "call-find",
        toolName: "find",
        args: { pattern: "*.ts" },
      } as never,
      at(3),
    );
    const [generic] = turnItems(other.events);
    assert.deepStrictEqual(
      generic?.type === "dynamic_tool" ? [generic.toolName, generic.input] : null,
      ["find", { pattern: "*.ts" }],
    );
  });

  it("shows todo tool results as the turn's todo list", () => {
    const { mapper } = startedTurn();
    const phases = [
      {
        name: "Build",
        tasks: [
          { content: "Write mapper", status: "completed" },
          { content: "Wire adapter", status: "in_progress" },
        ],
      },
      { name: "Ship", tasks: [{ content: "Open PR", status: "blocked", blocker: "CI" }] },
    ];
    assert.deepStrictEqual(
      turnItems(
        mapper.handleFrame(
          {
            type: "tool_execution_start",
            toolCallId: "call-todo",
            toolName: "todo",
            args: { op: "start" },
          } as never,
          at(1),
        ).events,
      ),
      [],
    );
    const ended = mapper.handleFrame(
      {
        type: "tool_execution_end",
        toolCallId: "call-todo",
        toolName: "todo",
        result: { content: [], details: { op: "start", phases, storage: "session" } },
      } as never,
      at(2),
    );
    const [plan] = ofType(ended.events, "plan.updated");
    const expectedSteps: Array<OrchestrationV2PlanStep> = [
      { id: "0:0", text: "Build: Write mapper", status: "completed" },
      { id: "0:1", text: "Build: Wire adapter", status: "running" },
      { id: "1:0", text: "Ship: Open PR (blocked: CI)", status: "pending" },
    ];
    assert.deepStrictEqual(plan?.plan.kind === "todo_list" ? plan.plan.steps : null, expectedSteps);
    const [item] = turnItems(ended.events);
    assert.deepStrictEqual(item?.type === "todo_list" ? item.steps : null, expectedSteps);
    // The same list from get_state at the end of the turn is not repeated.
    assert.deepStrictEqual(
      ofType(
        mapper.finalizeTurn(
          { status: "completed" },
          { state: { ...STATE, todoPhases: phases as never } },
          at(3),
        ),
        "plan.updated",
      ),
      [],
    );
  });

  it("emits todos that changed outside a tool call when the turn ends", () => {
    const { mapper } = startedTurn();
    const events = mapper.finalizeTurn(
      { status: "completed" },
      {
        state: {
          ...STATE,
          todoPhases: [{ name: "Only", tasks: [{ content: "Edited by user", status: "pending" }] }],
        },
      },
      at(1),
    );
    const [plan] = ofType(events, "plan.updated");
    assert.deepStrictEqual(plan?.plan.kind === "todo_list" ? plan.plan.steps : null, [
      { id: "0:0", text: "Edited by user", status: "pending" },
    ]);
    assert.deepStrictEqual(
      ompTodoSteps([{ name: "x", tasks: [{ content: "Dropped", status: "abandoned" }] }]),
      [{ id: "0:0", text: "Dropped (abandoned)", status: "completed" }],
    );
  });

  it("reports usage from assistant message_end and the context meter from session stats", () => {
    const { mapper } = startedTurn();
    const ended = mapper.handleFrame(
      {
        type: "message_end",
        messageId: "msg-1",
        message: { role: "assistant", content: [], usage: USAGE, stopReason: "stop" },
      } as never,
      at(1),
    );
    const [live] = ofType(ended.events, "provider_turn.updated");
    assert.deepStrictEqual(live?.providerTurn.tokenUsage, {
      usedTokens: 5_800,
      maxTokens: 200_000,
      inputTokens: 5_700,
      cachedInputTokens: 4_000,
      outputTokens: 300,
      updatedAt: DateTime.formatIso(at(1)),
    });
    assert.deepStrictEqual(live?.providerTurn.turnTokenUsage, {
      usageScope: "main_agent",
      usageStatus: "complete",
      inputTokens: 5_700,
      cachedInputTokens: 4_000,
      cacheCreationTokens: 500,
      outputTokens: 300,
      hasSubagents: false,
    });

    const stats: SessionStats = {
      sessionId: "session-a",
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 1_200, output: 300, cacheRead: 4_000, cacheWrite: 500, total: 6_000 },
      premiumRequests: 0,
      cost: 0.02,
      contextUsage: { tokens: 6_100, contextWindow: 200_000, percent: 3.05 },
    };
    const final = mapper.finalizeTurn({ status: "completed" }, { state: STATE, stats }, at(2));
    const [turn] = ofType(final, "provider_turn.updated");
    assert.strictEqual(turn?.providerTurn.status, "completed");
    assert.deepStrictEqual(turn?.providerTurn.tokenUsage, {
      usedTokens: 6_100,
      maxTokens: 200_000,
      updatedAt: DateTime.formatIso(at(2)),
    });
    const thread = ofType(final, "provider_thread.updated").at(-1)?.providerThread;
    assert.strictEqual(thread?.status, "idle");
    assert.deepStrictEqual(thread?.contextUsage, {
      usedTokens: 6_100,
      maxTokens: 200_000,
      totalProcessedTokens: 6_000,
      inputTokens: 5_700,
      cachedInputTokens: 4_000,
      outputTokens: 300,
      cost: { amount: 0.02, currency: "USD" },
      compactsAutomatically: true,
    });
    const [terminal] = ofType(final, "turn.terminal");
    assert.strictEqual(terminal?.status, "completed");
    assert.isFalse(mapper.hasActiveTurn);
  });

  it("renames the thread only for an explicit /rename", () => {
    const plain = startedTurn("/model sonnet").mapper;
    const implicit = plain.handleFrame(
      { type: "session_info_update", sessionId: "session-a", title: "Auto title" } as never,
      at(1),
    );
    assert.deepStrictEqual(ofType(implicit.events, "app_thread.created"), []);
    assert.strictEqual(
      ofType(implicit.events, "provider_thread.updated")[0]?.providerThread.nativeMetadata?.title,
      "Auto title",
    );

    const renamed = startedTurn("/rename Frame mapper").mapper;
    const explicit = renamed.handleFrame(
      { type: "session_info_update", sessionId: "session-a", title: "Frame mapper" } as never,
      at(1),
    );
    const [created] = ofType(explicit.events, "app_thread.created");
    assert.strictEqual(created?.appThread.id, THREAD_ID);
    assert.strictEqual(created?.appThread.title, "Frame mapper");
  });

  it("adopts a new session id in place after /fresh", () => {
    const { mapper, providerThread } = startedTurn("/fresh");
    const swapped = mapper.handleFrame(
      { type: "session_info_update", sessionId: "session-b" } as never,
      at(1),
    );
    const [updated] = ofType(swapped.events, "provider_thread.updated");
    assert.strictEqual(updated?.providerThread.id, providerThread.id);
    assert.strictEqual(updated?.providerThread.nativeThreadRef?.nativeId, "session-b");

    // At the pinned tag `/fresh` sends no frame; `get_state` after the turn carries the new id.
    const quiet = startedTurn("/fresh");
    const settled = quiet.mapper.handleFrame(
      {
        type: "response",
        id: "ompanel-3",
        command: "prompt",
        success: true,
        data: { agentInvoked: false },
      } as never,
      at(1),
    );
    assert.deepStrictEqual(settled.settled, { status: "completed" });
    const final = quiet.mapper.finalizeTurn(
      { status: "completed" },
      { state: { ...STATE, sessionId: "session-c" } },
      at(2),
    );
    const thread = ofType(final, "provider_thread.updated").at(-1)?.providerThread;
    assert.strictEqual(thread?.id, quiet.providerThread.id);
    assert.strictEqual(thread?.nativeThreadRef?.nativeId, "session-c");
  });

  it("shows builtin command output, notices and notify requests in the turn", () => {
    const { mapper } = startedTurn("/context");
    const events = [
      { type: "command_output", text: "\nContext: 12% used\nSystem: 3k" },
      { type: "notice", level: "warning", message: "Memory is off", source: "Memory" },
      {
        type: "extension_ui_request",
        id: "ui-1",
        method: "notify",
        message: "Build done",
        notifyType: "info",
      },
    ].flatMap((frame) => mapper.handleFrame(frame as never, at(1)).events);
    const items = turnItems(events);
    assert.deepStrictEqual(
      items.map((item) =>
        item.type === "notification"
          ? [item.type, item.summary, item.detail ?? null]
          : item.type === "system_notice"
            ? [item.type, item.message, item.title]
            : [item.type],
      ),
      [
        ["notification", "Context: 12% used", "\nContext: 12% used\nSystem: 3k"],
        ["system_notice", "Memory is off", "Memory"],
        ["notification", "Build done", null],
      ],
    );
    assert.strictEqual(new Set(items.map((item) => item.id)).size, 3);
  });

  it("ignores unknown frames and frames outside a turn", () => {
    const { mapper } = startedTurn();
    assert.deepStrictEqual(
      mapper.handleFrame({ type: "frame_from_the_future", payload: 1 } as never, at(1)),
      { events: [], streaming: false, settled: null },
    );
    mapper.finalizeTurn({ status: "completed" }, {}, at(2));
    assert.deepStrictEqual(
      mapper.handleFrame({ type: "notice", level: "info", message: "late" } as never, at(3)).events,
      [],
    );
  });

  it("settles on prompt_result for its own prompt and reports failures", () => {
    const { mapper } = startedTurn();
    mapper.handleFrame(
      { type: "response", id: "ompanel-2", command: "prompt", success: true } as never,
      at(1),
    );
    const stale = mapper.handleFrame(
      {
        type: "prompt_result",
        id: "ompanel-1",
        agentInvoked: true,
        status: "completed",
        sessionSettled: true,
      } as never,
      at(2),
    );
    assert.isNull(stale.settled);
    const result = mapper.handleFrame(
      {
        type: "prompt_result",
        id: "ompanel-2",
        agentInvoked: true,
        status: "error",
        sessionSettled: true,
        error: { message: "rate limited", retryable: true, httpStatus: 429 },
      } as never,
      at(3),
    );
    assert.strictEqual(result.settled?.status, "failed");
    const final = mapper.finalizeTurn(result.settled!, {}, at(4));
    const [terminal] = ofType(final, "turn.terminal");
    assert.deepStrictEqual(
      terminal?.status === "failed"
        ? [terminal.failure.class, terminal.failure.message, terminal.failure.retryable]
        : null,
      ["usage_limit", "rate limited", true],
    );
    assert.strictEqual(turnItems(final).at(-1)?.type, "error");

    const rejected = startedTurn().mapper.handleFrame(
      {
        type: "response",
        id: "ompanel-9",
        command: "prompt",
        success: false,
        error: "session busy",
        code: "session_busy",
      } as never,
      at(1),
    );
    assert.deepStrictEqual(
      rejected.settled?.status === "failed"
        ? [rejected.settled.failure.message, rejected.settled.failure.code]
        : null,
      ["session busy", "session_busy"],
    );
  });

  it("maps an aborted prompt to an interrupted turn", () => {
    const { mapper } = startedTurn();
    const result = mapper.handleFrame(
      {
        type: "prompt_result",
        agentInvoked: true,
        status: "aborted",
        sessionSettled: true,
      } as never,
      at(1),
    );
    assert.deepStrictEqual(result.settled, { status: "interrupted" });
  });

  it("completes a turn OMP recovered from a model error by auto-retry", () => {
    const { mapper } = startedTurn();
    mapper.handleFrame(
      { type: "response", id: "ompanel-2", command: "prompt", success: true } as never,
      at(1),
    );
    const frames = [
      {
        type: "message_end",
        message: {
          role: "assistant",
          content: [],
          stopReason: "error",
          errorMessage: "overloaded",
        },
      },
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 10,
        errorMessage: "overloaded",
      },
      { type: "auto_retry_end", success: true, attempt: 1 },
      {
        type: "message_end",
        message: { role: "assistant", content: [], usage: USAGE, stopReason: "stop" },
      },
    ];
    for (const frame of frames) assert.isNull(mapper.handleFrame(frame as never, at(2)).settled);
    const result = mapper.handleFrame(
      {
        type: "prompt_result",
        id: "ompanel-2",
        agentInvoked: true,
        status: "completed",
        sessionSettled: true,
      } as never,
      at(3),
    );
    assert.deepStrictEqual(result.settled, { status: "completed" });
    const [terminal] = ofType(mapper.finalizeTurn(result.settled!, {}, at(4)), "turn.terminal");
    assert.deepStrictEqual(terminal === undefined ? null : [terminal.status, terminal.failure], [
      "completed",
      null,
    ]);
  });
});
