// OMP tool and notice cards (P-04): one test per card kind, with frames shaped like OMP's tools
// at the pinned contract.
import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { readOmpToolCard, type OmpToolCard } from "@t3tools/shared/ompToolCard";
import { toolOutputImages } from "@t3tools/shared/toolOutput";
import * as DateTime from "effect/DateTime";

import { OMP_PROVIDER, OmpThreadMapper } from "./mapper.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;

const INSTANCE_ID = ProviderInstanceId.make("omp-work");
const THREAD_ID = ThreadId.make("thread:omp");
const T0 = DateTime.makeUnsafe("2026-10-26T10:00:00.000Z");
const at = (seconds: number) =>
  DateTime.makeUnsafe(Date.parse("2026-10-26T10:00:00.000Z") + seconds * 1000);
const PNG = "iVBORw0KGgo=";

function startedTurn() {
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
  const { providerThread } = mapper.bindThread(
    {
      threadId: THREAD_ID,
      state: { sessionId: "s", sessionFile: "/s.jsonl", todoPhases: [] } as never,
    },
    T0,
  );
  mapper.startTurn(
    {
      appThread: { id: THREAD_ID, title: "t" } as OrchestrationV2AppThread,
      threadId: THREAD_ID,
      runId: RunId.make("run:omp:1"),
      runOrdinal: 1,
      providerTurnOrdinal: 1,
      attemptId: RunAttemptId.make("run-attempt:omp:1"),
      rootNodeId: NodeId.make("node:omp:root"),
      providerThread,
      message: {
        messageId: "message:omp:1" as never,
        text: "hi",
        attachments: [],
        createdBy: "user",
        creationSource: "web",
      },
      modelSelection: { instanceId: INSTANCE_ID, model: "default" },
      runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/work" },
    },
    T0,
  );
  let second = 0;
  const frame = (value: Record<string, unknown>) =>
    mapper
      .handleFrame(value as never, at(++second))
      .events.flatMap((event: Event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
  const toolEnd = (toolName: string, args: unknown, result: unknown, isError = false) =>
    frame({
      type: "tool_execution_end",
      toolCallId: `call-${++second}`,
      toolName,
      args,
      result,
      isError,
    });
  return { frame, toolEnd };
}

function cardOf(items: ReadonlyArray<OrchestrationV2TurnItem>): OmpToolCard {
  const [item] = items;
  if (item?.type !== "dynamic_tool") return assert.fail(`expected dynamic_tool, got ${item?.type}`);
  const card = readOmpToolCard(item.output);
  if (card === null) return assert.fail("expected an OMP card");
  return card;
}

const text = (value: string) => ({ type: "text", text: value });

describe("OMP cards", () => {
  it("ask: single, multi and Other answers", () => {
    const { toolEnd } = startedTurn();
    const single = cardOf(
      toolEnd(
        "ask",
        { questions: [{ id: "q", question: "Pick", options: [{ label: "A" }] }] },
        {
          content: [text("User selected: A")],
          details: { question: "Pick", options: ["A"], multi: false, selectedOptions: ["A"] },
        },
      ),
    );
    assert.deepStrictEqual(single, {
      kind: "ask",
      answers: [{ question: "Pick", multi: false, selected: ["A"] }],
    });
    const many = cardOf(
      toolEnd(
        "ask",
        {},
        {
          content: [text("User answers:\n...")],
          details: {
            results: [
              {
                id: "a",
                question: "Which?",
                options: ["x", "y"],
                multi: true,
                selectedOptions: ["x", "y"],
              },
              {
                id: "b",
                question: "Name?",
                options: ["n"],
                multi: false,
                selectedOptions: [],
                customInput: "Zed",
              },
            ],
          },
        },
      ),
    );
    assert.deepStrictEqual(many, {
      kind: "ask",
      answers: [
        { question: "Which?", multi: true, selected: ["x", "y"] },
        { question: "Name?", multi: false, selected: [], custom: "Zed" },
      ],
    });
  });

  it("proposed edit: a staged ast_edit becomes applied when the agent resolves it", () => {
    const { toolEnd } = startedTurn();
    const staged = toolEnd(
      "ast_edit",
      { ops: [{ pat: "a", out: "b" }], paths: ["src"] },
      {
        content: [text("Staged as a proposal — files NOT modified yet. To apply: …\n-1:a\n+1:b")],
        details: {
          totalReplacements: 1,
          filesTouched: 1,
          filesSearched: 3,
          applied: false,
          limitReached: false,
          fileReplacements: [{ path: "src/x.ts", count: 1 }],
        },
      },
    );
    assert.deepStrictEqual(cardOf(staged), {
      kind: "proposed_edit",
      source: "ast_edit",
      state: "proposed",
      files: [{ path: "src/x.ts", count: 1 }],
      replacements: 1,
      diff: "-1:a\n+1:b",
    });
    const resolved = toolEnd(
      "write",
      { path: "xd://resolve", content: "rename is safe" },
      {
        content: [text("Applied")],
        details: {
          xdev: {
            tool: "resolve",
            mode: "execute",
            args: { reason: "rename is safe" },
            inner: {
              action: "apply",
              reason: "rename is safe",
              sourceToolName: "ast_edit",
              sourceResultDetails: {
                totalReplacements: 1,
                applied: true,
                fileReplacements: [{ path: "src/x.ts", count: 1 }],
              },
            },
          },
        },
      },
    );
    const resolveCard = cardOf(resolved);
    assert.strictEqual(resolveCard.kind === "proposed_edit" && resolveCard.state, "applied");
    // The staged card is re-emitted, now applied.
    const restaged = resolved[1];
    assert.strictEqual(restaged?.id, staged[0]?.id);
    const updated = cardOf(resolved.slice(1));
    assert.strictEqual(updated.kind === "proposed_edit" && updated.state, "applied");
  });

  it("proposed edit: conflict:// writes show the resolution", () => {
    const { toolEnd } = startedTurn();
    assert.deepStrictEqual(
      cardOf(
        toolEnd(
          "write",
          { path: "conflict://2", content: "@ours" },
          {
            content: [text("Resolved conflict #2 at lines 4–9 in src/a.ts.")],
            details: { resolvedPath: "/work/src/a.ts" },
          },
        ),
      ),
      {
        kind: "conflict_resolution",
        target: "conflict://2",
        resolvedPath: "/work/src/a.ts",
        summary: "Resolved conflict #2 at lines 4–9 in src/a.ts.",
      },
    );
  });

  it("debug: stack frames, locals and stop location", () => {
    const { toolEnd } = startedTurn();
    const frames = cardOf(
      toolEnd(
        "debug",
        { action: "stack_trace" },
        {
          content: [text("#0 main")],
          details: {
            action: "stack_trace",
            success: true,
            snapshot: {
              status: "stopped",
              stopReason: "breakpoint",
              frameName: "main",
              source: "/w/a.py",
              line: 3,
            },
            stackFrames: [{ id: 1, name: "main", source: { path: "/w/a.py" }, line: 3, column: 1 }],
          },
        },
      ),
    );
    assert.deepStrictEqual(frames, {
      kind: "debug",
      action: "stack_trace",
      state: "stopped",
      stopReason: "breakpoint",
      location: { name: "main", path: "/w/a.py", line: 3 },
      frames: [{ id: 1, name: "main", path: "/w/a.py", line: 3, column: 1 }],
    });
    const locals = cardOf(
      toolEnd(
        "debug",
        { action: "variables", scope_id: 7 },
        {
          content: [text("x = 1")],
          details: {
            action: "variables",
            success: true,
            variables: [{ name: "x", value: "1", type: "int", variablesReference: 0 }],
          },
        },
      ),
    );
    assert.deepStrictEqual(locals, {
      kind: "debug",
      action: "variables",
      variables: [{ name: "x", value: "1", type: "int" }],
    });
  });

  it("lsp: action, server and result text", () => {
    const { toolEnd } = startedTurn();
    assert.deepStrictEqual(
      cardOf(
        toolEnd(
          "lsp",
          { action: "hover", file: "src/a.ts", symbol: "foo" },
          {
            content: [text("function foo(): void")],
            details: { action: "hover", success: true, serverName: "tsserver" },
          },
        ),
      ),
      {
        kind: "lsp",
        action: "hover",
        success: true,
        server: "tsserver",
        target: "src/a.ts · foo",
        text: "function foo(): void",
      },
    );
  });

  it("eval: cells with inline images kept as output blocks", () => {
    const { toolEnd } = startedTurn();
    const items = toolEnd(
      "eval",
      { language: "py", code: "plot()" },
      {
        content: [
          text("(1 image; no text output)"),
          { type: "image", data: PNG, mimeType: "image/png" },
        ],
        details: {
          language: "python",
          cells: [{ index: 0, code: "plot()", output: "", status: "complete", durationMs: 12 }],
        },
      },
    );
    assert.deepStrictEqual(cardOf(items), {
      kind: "eval",
      language: "python",
      cells: [{ index: 0, code: "plot()", output: "", status: "complete", durationMs: 12 }],
    });
    const item = items[0];
    assert.deepStrictEqual(item?.type === "dynamic_tool" ? toolOutputImages(item.output) : null, [
      { mimeType: "image/png", data: PNG },
    ]);
  });

  it("media: generate_image images move from details into output blocks", () => {
    const { toolEnd } = startedTurn();
    const items = toolEnd(
      "generate_image",
      { subject: "a cat" },
      {
        content: [text("Generated 1 image(s): /tmp/omp-image-1.png")],
        details: {
          provider: "openai",
          model: "gpt-image-1",
          imageCount: 1,
          imagePaths: ["/tmp/omp-image-1.png"],
          images: [{ data: PNG, mimeType: "image/png" }],
        },
      },
    );
    assert.deepStrictEqual(cardOf(items), {
      kind: "generated_image",
      provider: "openai",
      model: "gpt-image-1",
      paths: ["/tmp/omp-image-1.png"],
    });
    const item = items[0];
    assert.deepStrictEqual(item?.type === "dynamic_tool" ? toolOutputImages(item.output) : null, [
      { mimeType: "image/png", data: PNG },
    ]);
  });

  it("media: tts points at the written audio file", () => {
    const { toolEnd } = startedTurn();
    assert.deepStrictEqual(
      cardOf(
        toolEnd(
          "tts",
          { text: "Hello", output_path: "out/hello.mp3" },
          {
            content: [text("Saved 10 bytes to out/hello.wav")],
            details: { bytes: 10, voiceId: "sol", codec: "wav", backend: "local-inference" },
          },
        ),
      ),
      {
        kind: "speech",
        path: "out/hello.wav",
        mimeType: "audio/wav",
        bytes: 10,
        voice: "sol",
        text: "Hello",
      },
    );
  });

  it("memory: recall, retain and xd://memory_edit", () => {
    const { toolEnd } = startedTurn();
    assert.deepStrictEqual(
      cardOf(
        toolEnd(
          "recall",
          { query: "prefs" },
          { content: [text("Found 1 relevant memories")], details: {} },
        ),
      ),
      { kind: "memory", op: "recall", query: "prefs", text: "Found 1 relevant memories" },
    );
    assert.deepStrictEqual(
      cardOf(
        toolEnd(
          "retain",
          { items: [{ content: "likes tabs", scope: "project" }] },
          { content: [text("1 memories stored.")], details: { count: 1 } },
        ),
      ),
      {
        kind: "memory",
        op: "retain",
        items: [{ content: "likes tabs", scope: "project" }],
        text: "1 memories stored.",
      },
    );
    assert.deepStrictEqual(
      cardOf(
        toolEnd(
          "write",
          { path: "xd://memory_edit", content: '{"op":"forget","id":"m1"}' },
          {
            content: [text("Memory m1 deleted in bank b (fact).")],
            details: {
              xdev: {
                tool: "memory_edit",
                mode: "execute",
                args: { op: "forget", id: "m1" },
                inner: { status: "deleted" },
              },
            },
          },
        ),
      ),
      {
        kind: "memory",
        op: "edit",
        status: "deleted",
        memoryId: "m1",
        text: "Memory m1 deleted in bank b (fact).",
      },
    );
  });

  it("advisor note, rule injection and fallback become notifications", () => {
    const { frame } = startedTurn();
    const [advisor] = frame({
      type: "message_end",
      message: {
        role: "custom",
        customType: "advisor",
        content: "…",
        details: {
          notes: [{ note: "Check the null case", severity: "blocker", advisor: "safety" }],
        },
      },
    });
    assert.deepStrictEqual(
      advisor?.type === "notification"
        ? [advisor.title, advisor.outcome, advisor.summary, advisor.detail]
        : null,
      [
        "Advisor",
        "failed",
        "Advisor: Check the null case",
        "[blocker · safety] Check the null case",
      ],
    );
    const [rule] = frame({
      type: "ttsr_triggered",
      rules: [{ name: "no-any", path: "/r/no-any.md", content: "Never use any." }],
    });
    assert.deepStrictEqual(rule?.type === "notification" ? [rule.summary, rule.detail] : null, [
      "Rule injected: no-any",
      "no-any (/r/no-any.md)\nNever use any.",
    ]);
    const [fallback] = frame({
      type: "retry_fallback_applied",
      from: "a/model-1",
      to: "b/model-2",
      role: "default",
      reason: "rate limited",
    });
    assert.deepStrictEqual(
      fallback?.type === "notification" ? [fallback.summary, fallback.detail] : null,
      ["Fallback applied: a/model-1 → b/model-2 (default)", "rate limited"],
    );
  });

  it("compaction: auto and manual runs share one card from start to end", () => {
    const { frame } = startedTurn();
    const [running] = frame({
      type: "auto_compaction_start",
      reason: "threshold",
      action: "compact",
    });
    assert.deepStrictEqual(
      running?.type === "compaction" ? [running.status, running.driver] : null,
      ["running", OMP_PROVIDER],
    );
    const [done] = frame({
      type: "auto_compaction_end",
      action: "compact",
      aborted: false,
      willRetry: false,
      result: {
        summary: "long",
        shortSummary: "Compacted",
        firstKeptEntryId: "e",
        tokensBefore: 90_000,
      },
    });
    assert.strictEqual(done?.id, running?.id);
    assert.deepStrictEqual(
      done?.type === "compaction" ? [done.status, done.summary, done.beforeTokenCount] : null,
      ["completed", "Compacted", 90_000],
    );
    const [manual] = frame({ type: "manual_compaction_start" });
    const [aborted] = frame({ type: "manual_compaction_end", aborted: true });
    assert.notStrictEqual(manual?.id, running?.id);
    assert.strictEqual(aborted?.id, manual?.id);
    assert.strictEqual(aborted?.status, "interrupted");
    frame({ type: "manual_compaction_start" });
    const [skipped] = frame({
      type: "manual_compaction_end",
      aborted: false,
      skipped: true,
      errorMessage: "Nothing to compact",
    });
    assert.deepStrictEqual(
      skipped?.type === "compaction" ? [skipped.status, skipped.summary] : null,
      ["completed", "Nothing to compact"],
    );
  });
});
