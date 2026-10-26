import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";

import { OMP_PROVIDER, OmpThreadMapper, type OmpRequestPlacement } from "./mapper.ts";
import { OmpUiRequests, type OmpDialogRequest } from "./uiRequests.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;

const SESSION_ID = ProviderSessionId.make("provider-session:omp");
const THREAD_ID = ThreadId.make("thread:omp");
const T0 = DateTime.makeUnsafe("2026-10-26T10:00:00.000Z");
const T1 = DateTime.makeUnsafe("2026-10-26T10:00:05.000Z");

const PLACEMENT: OmpRequestPlacement = {
  threadId: THREAD_ID,
  runId: RunId.make("run:omp:1"),
  rootNodeId: NodeId.make("node:omp:root"),
  providerThreadId: ProviderThreadId.make("provider-thread:omp"),
  providerTurnId: ProviderTurnId.make("provider-turn:omp:1"),
  ordinal: 104,
};

const ofType = <T extends Event["type"]>(events: ReadonlyArray<Event>, type: T) =>
  events.filter((event): event is Extract<Event, { type: T }> => event.type === type);

/** Opens `frame` and returns its request id and turn item. */
function open(requests: OmpUiRequests, frame: Record<string, unknown>) {
  const opened = requests.open(
    { type: "extension_ui_request", ...frame } as OmpDialogRequest,
    PLACEMENT,
    T0,
  );
  assert.isNotNull(opened);
  const [request] = ofType(opened!.events, "runtime_request.updated");
  const [item] = ofType(opened!.events, "turn_item.updated");
  return {
    requestId: request!.runtimeRequest.id,
    runtimeRequest: request!.runtimeRequest,
    item: item!.turnItem,
    node: ofType(opened!.events, "node.updated")[0]!.node,
    timeoutMs: opened!.timeoutMs,
  };
}

const userInput = (item: OrchestrationV2TurnItem) => {
  assert.strictEqual(item.type, "user_input_request");
  return item as Extract<OrchestrationV2TurnItem, { type: "user_input_request" }>;
};

const approval = (item: OrchestrationV2TurnItem) => {
  assert.strictEqual(item.type, "approval_request");
  return item as Extract<OrchestrationV2TurnItem, { type: "approval_request" }>;
};

describe("OmpUiRequests", () => {
  it("opens a select as a single-choice question placed in the turn", () => {
    const requests = new OmpUiRequests({ providerSessionId: SESSION_ID });
    const opened = open(requests, {
      id: "ui-1",
      method: "select",
      title: "Pick a branch",
      options: ["main", "dev"],
      optionDetails: [{ description: "Default branch" }, {}],
    });
    assert.deepStrictEqual(
      [
        opened.runtimeRequest.kind,
        opened.runtimeRequest.status,
        opened.runtimeRequest.providerTurnId,
        opened.runtimeRequest.responseCapability,
        opened.runtimeRequest.nativeRequestRef?.nativeId,
      ],
      [
        "user_input",
        "pending",
        PLACEMENT.providerTurnId,
        { type: "live", providerSessionId: SESSION_ID },
        "ui-1",
      ],
    );
    assert.deepStrictEqual(
      [opened.node.kind, opened.node.status, opened.node.runId, opened.node.parentNodeId],
      ["user_input_request", "waiting", PLACEMENT.runId, PLACEMENT.rootNodeId],
    );
    const item = userInput(opened.item);
    assert.deepStrictEqual(
      [item.status, item.ordinal, item.requestId],
      ["waiting", 104, opened.requestId],
    );
    assert.deepStrictEqual(item.questions, [
      {
        id: "ui-1",
        header: "Pick a branch",
        question: "Pick a branch",
        options: [
          { label: "main", description: "Default branch", value: "main" },
          { label: "dev", description: "dev", value: "dev" },
        ],
        multiSelect: false,
        allowCustomAnswer: false,
      },
    ]);
    assert.strictEqual(opened.timeoutMs, null);

    assert.deepStrictEqual(
      requests.answer({ requestId: opened.requestId, answers: { "ui-1": "dev" } }),
      {
        nativeId: "ui-1",
        reply: { type: "extension_ui_response", id: "ui-1", value: "dev" },
      },
    );
    // Only one of the options answers a select; anything else rejects it.
    assert.deepStrictEqual(
      requests.answer({ requestId: opened.requestId, answers: { "ui-1": "feature" } })?.reply,
      { type: "extension_ui_response", id: "ui-1", cancelled: true },
    );

    const resolved = requests.resolve(opened.requestId, T1);
    assert.deepStrictEqual(
      [
        ofType(resolved, "runtime_request.updated")[0]?.runtimeRequest.status,
        ofType(resolved, "node.updated")[0]?.node.status,
        ofType(resolved, "turn_item.updated")[0]?.turnItem.status,
      ],
      ["resolved", "completed", "completed"],
    );
    assert.isNull(requests.answer({ requestId: opened.requestId, answers: { "ui-1": "dev" } }));
    assert.strictEqual(requests.pendingCount, 0);
  });

  it("opens a tool approval select as an approval card and answers with OMP's labels", () => {
    const requests = new OmpUiRequests({ providerSessionId: SESSION_ID });
    const opened = open(requests, {
      id: "ui-2",
      method: "select",
      title: "Allow tool: bash\nReason: rm deletes files\nCommand: rm -rf build",
      options: ["Approve", "Approve rm for this session", "Deny"],
    });
    assert.strictEqual(opened.runtimeRequest.kind, "command");
    assert.strictEqual(opened.node.kind, "approval_request");
    const item = approval(opened.item);
    assert.deepStrictEqual(
      [item.title, item.requestKind, item.prompt, item.reason, item.options],
      [
        "Allow tool: bash",
        "command",
        "Allow tool: bash\nCommand: rm -rf build",
        "rm deletes files",
        [
          { decision: "accept", label: "Approve" },
          { decision: "acceptForSession", label: "Approve rm for this session" },
          { decision: "decline", label: "Deny" },
        ],
      ],
    );
    const reply = (
      decision: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput["decision"],
    ) =>
      requests.answer({
        requestId: opened.requestId,
        ...(decision === undefined ? {} : { decision }),
      })?.reply;
    assert.deepStrictEqual(reply("accept"), {
      type: "extension_ui_response",
      id: "ui-2",
      value: "Approve",
    });
    assert.deepStrictEqual(reply("acceptForSession"), {
      type: "extension_ui_response",
      id: "ui-2",
      value: "Approve rm for this session",
    });
    assert.deepStrictEqual(reply("decline"), {
      type: "extension_ui_response",
      id: "ui-2",
      value: "Deny",
    });
    // A cancelled approval is a reject: OMP denies the call.
    assert.deepStrictEqual(reply("cancel"), {
      type: "extension_ui_response",
      id: "ui-2",
      cancelled: true,
    });
    assert.deepStrictEqual(reply(undefined), {
      type: "extension_ui_response",
      id: "ui-2",
      cancelled: true,
    });
  });

  it("offers the narrowest remembered grant of an always-ask-cached approval", () => {
    const requests = new OmpUiRequests({ providerSessionId: SESSION_ID });
    const opened = open(requests, {
      id: "ui-3",
      method: "select",
      title: "Allow tool: edit\nPath: ~/src/app.ts",
      options: [
        "Approve Directory: ~/src",
        "Approve File",
        "Always Approve Directory: ~/src",
        "Always Approve File",
        "Approve Once",
        "Deny",
      ],
    });
    const item = approval(opened.item);
    assert.strictEqual(item.requestKind, "file-change");
    assert.deepStrictEqual(
      item.options?.map((option) => [option.decision, option.label]),
      [
        ["accept", "Approve Once"],
        ["acceptForSession", "Approve File"],
        ["acceptAlways", "Always Approve File"],
        ["decline", "Deny"],
      ],
    );
    assert.deepStrictEqual(
      (["accept", "acceptForSession", "acceptAlways"] as const).map(
        (decision) => requests.answer({ requestId: opened.requestId, decision })?.reply,
      ),
      [
        { type: "extension_ui_response", id: "ui-3", value: "Approve Once" },
        { type: "extension_ui_response", id: "ui-3", value: "Approve File" },
        { type: "extension_ui_response", id: "ui-3", value: "Always Approve File" },
      ],
    );
  });

  it("opens a confirm as a yes/no approval card", () => {
    const requests = new OmpUiRequests({ providerSessionId: SESSION_ID });
    const opened = open(requests, {
      id: "ui-4",
      method: "confirm",
      title: "Overwrite notes.md?",
      message: "It has unsaved edits.",
      timeout: 30_000,
    });
    assert.strictEqual(opened.runtimeRequest.kind, "permission");
    assert.strictEqual(opened.timeoutMs, 30_000);
    const item = approval(opened.item);
    assert.deepStrictEqual(
      [item.prompt, item.options],
      [
        "Overwrite notes.md?\nIt has unsaved edits.",
        [
          { decision: "accept", label: "Yes" },
          { decision: "decline", label: "No" },
        ],
      ],
    );
    assert.deepStrictEqual(
      (["accept", "decline", "cancel"] as const).map(
        (decision) => requests.answer({ requestId: opened.requestId, decision })?.reply,
      ),
      [
        { type: "extension_ui_response", id: "ui-4", confirmed: true },
        { type: "extension_ui_response", id: "ui-4", confirmed: false },
        { type: "extension_ui_response", id: "ui-4", cancelled: true },
      ],
    );
  });

  it("opens input and editor as free-text questions; an empty answer is still an answer", () => {
    const requests = new OmpUiRequests({ providerSessionId: SESSION_ID });
    const input = open(requests, {
      id: "ui-5",
      method: "input",
      title: "API key",
      placeholder: "sk-...",
      timeout: 5_000,
    });
    assert.strictEqual(input.timeoutMs, 5_000);
    assert.deepStrictEqual(userInput(input.item).questions, [
      {
        id: "ui-5",
        header: "API key",
        question: "sk-...",
        options: [
          { label: "Submit empty value", description: "Answer with an empty value.", value: "" },
        ],
        allowCustomAnswer: true,
      },
    ]);
    assert.deepStrictEqual(
      requests.answer({ requestId: input.requestId, answers: { "ui-5": "" } })?.reply,
      { type: "extension_ui_response", id: "ui-5", value: "" },
    );
    assert.deepStrictEqual(
      requests.answer({ requestId: input.requestId, decision: "cancel" })?.reply,
      {
        type: "extension_ui_response",
        id: "ui-5",
        cancelled: true,
      },
    );

    // `editor` has no deadline in the contract; a stray one is not honoured.
    const editor = open(requests, {
      id: "ui-6",
      method: "editor",
      title: "Commit message",
      prefill: "fix: things",
      timeout: 1,
    });
    assert.strictEqual(editor.timeoutMs, null);
    assert.deepStrictEqual(userInput(editor.item).questions, [
      {
        id: "ui-6",
        header: "Commit message",
        question: "Commit message",
        options: [],
        allowCustomAnswer: true,
        initialAnswer: "fix: things",
      },
    ]);
    assert.deepStrictEqual(
      requests.answer({ requestId: editor.requestId, answers: { "ui-6": "fix: better things" } })
        ?.reply,
      { type: "extension_ui_response", id: "ui-6", value: "fix: better things" },
    );
  });

  it("opens an ask as one question card per question with multi-select and Other", () => {
    const requests = new OmpUiRequests({ providerSessionId: SESSION_ID });
    const opened = open(requests, {
      id: "ui-7",
      method: "ask",
      timeout: 60_000,
      questions: [
        {
          id: "stack",
          header: "Stack",
          question: "Which parts should change?",
          multi: true,
          options: [
            { label: "API", description: "Server routes" },
            { label: "Web" },
            { label: "Docs", preview: "docs/omp" },
          ],
          recommended: 1,
        },
        {
          id: "style",
          question: "Which style?",
          options: [{ label: "Terse" }, { label: "Verbose" }],
        },
      ],
    });
    assert.strictEqual(opened.timeoutMs, 60_000);
    const item = userInput(opened.item);
    assert.deepStrictEqual(item.questions, [
      {
        id: "stack",
        header: "Stack",
        question: "Which parts should change?",
        options: [
          { label: "API", description: "Server routes", value: "API" },
          { label: "Web (Recommended)", description: "Web", value: "Web" },
          { label: "Docs", description: "Docs", value: "Docs", preview: "docs/omp" },
        ],
        multiSelect: true,
        allowCustomAnswer: true,
      },
      {
        id: "style",
        header: "Question 2",
        question: "Which style?",
        options: [
          { label: "Terse", description: "Terse", value: "Terse" },
          { label: "Verbose", description: "Verbose", value: "Verbose" },
        ],
        multiSelect: false,
        allowCustomAnswer: true,
      },
    ]);

    // Multi-select picks labels; free text ("Other") becomes `customInput`; both in OMP's order.
    assert.deepStrictEqual(
      requests.answer({
        requestId: opened.requestId,
        answers: { style: "  Somewhere in between  ", stack: ["Docs", "API", "Nope", "API"] },
      })?.reply,
      {
        type: "extension_ui_response",
        id: "ui-7",
        answers: [
          { id: "stack", selectedOptions: ["Docs", "API"] },
          { id: "style", selectedOptions: [], customInput: "Somewhere in between" },
        ],
      },
    );
    assert.deepStrictEqual(
      requests.answer({
        requestId: opened.requestId,
        answers: { stack: "Other text", style: "Terse" },
      })?.reply,
      {
        type: "extension_ui_response",
        id: "ui-7",
        answers: [
          { id: "stack", selectedOptions: [], customInput: "Other text" },
          { id: "style", selectedOptions: ["Terse"] },
        ],
      },
    );
    assert.deepStrictEqual(
      requests.answer({ requestId: opened.requestId, decision: "cancel" })?.reply,
      {
        type: "extension_ui_response",
        id: "ui-7",
        cancelled: true,
      },
    );
  });

  it("gives ask questions with unusable ids a positional id and maps answers back", () => {
    const requests = new OmpUiRequests({ providerSessionId: SESSION_ID });
    const opened = open(requests, {
      id: "ui-8",
      method: "ask",
      questions: [
        { id: "same", question: "First?", options: [{ label: "A" }] },
        { id: "same", question: "Second?", options: [{ label: "B" }] },
      ],
    });
    assert.deepStrictEqual(
      userInput(opened.item).questions.map((question) => question.id),
      ["same", "question-2"],
    );
    assert.deepStrictEqual(
      requests.answer({ requestId: opened.requestId, answers: { same: "A", "question-2": "B" } })
        ?.reply,
      {
        type: "extension_ui_response",
        id: "ui-8",
        answers: [
          { id: "same", selectedOptions: ["A"] },
          { id: "same", selectedOptions: ["B"] },
        ],
      },
    );
  });

  it("times a dialog out with cancelled+timedOut and expires the card", () => {
    const requests = new OmpUiRequests({ providerSessionId: SESSION_ID });
    const opened = open(requests, {
      id: "ui-9",
      method: "confirm",
      title: "Go?",
      message: "",
      timeout: 10,
    });
    const expired = requests.expire("ui-9", T1);
    assert.deepStrictEqual(expired?.reply, {
      type: "extension_ui_response",
      id: "ui-9",
      cancelled: true,
      timedOut: true,
    });
    assert.deepStrictEqual(
      [
        ofType(expired!.events, "runtime_request.updated")[0]?.runtimeRequest.status,
        ofType(expired!.events, "node.updated")[0]?.node.status,
        ofType(expired!.events, "turn_item.updated")[0]?.turnItem.status,
      ],
      ["expired", "cancelled", "cancelled"],
    );
    // Gone: a late answer and a second deadline find nothing.
    assert.isNull(requests.answer({ requestId: opened.requestId, decision: "accept" }));
    assert.isNull(requests.expire("ui-9", T1));
  });

  it("closes the dialog a cancel names by targetId, without a reply", () => {
    const requests = new OmpUiRequests({ providerSessionId: SESSION_ID });
    const first = open(requests, { id: "ui-10", method: "input", title: "Name" });
    const second = open(requests, { id: "ui-11", method: "input", title: "Other name" });
    const closed = requests.close("ui-10", T1);
    assert.deepStrictEqual(
      ofType(closed, "runtime_request.updated").map((event) => [
        event.runtimeRequest.id,
        event.runtimeRequest.status,
      ]),
      [[first.requestId, "cancelled"]],
    );
    assert.deepStrictEqual(requests.close("ui-unknown", T1), []);
    assert.isNull(requests.answer({ requestId: first.requestId, answers: { "ui-10": "x" } }));
    assert.isNotNull(requests.answer({ requestId: second.requestId, answers: { "ui-11": "x" } }));

    const all = requests.closeAll(T1);
    assert.deepStrictEqual(
      ofType(all, "runtime_request.updated").map((event) => event.runtimeRequest.id),
      [second.requestId],
    );
    assert.strictEqual(requests.pendingCount, 0);
  });

  it("refuses a dialog with no id, no choices or no questions", () => {
    const requests = new OmpUiRequests({ providerSessionId: SESSION_ID });
    const tryOpen = (frame: Record<string, unknown>) =>
      requests.open({ type: "extension_ui_request", ...frame } as OmpDialogRequest, PLACEMENT, T0);
    assert.isNull(tryOpen({ method: "confirm", title: "No id", message: "" }));
    assert.isNull(tryOpen({ id: "ui-12", method: "select", title: "Nothing", options: [] }));
    assert.isNull(tryOpen({ id: "ui-13", method: "ask", questions: [] }));
    assert.strictEqual(requests.pendingCount, 0);
    // A repeated request leaves the open card alone.
    const confirm = { id: "ui-14", method: "confirm", title: "Go?", message: "" };
    assert.lengthOf(tryOpen(confirm)?.events ?? [], 3);
    assert.deepStrictEqual(tryOpen(confirm), { events: [], timeoutMs: null });
    assert.strictEqual(requests.pendingCount, 1);
  });
});

describe("OmpThreadMapper UI frames", () => {
  const INSTANCE_ID = ProviderInstanceId.make("omp-work");
  const mapper = () =>
    new OmpThreadMapper({
      instanceId: INSTANCE_ID,
      providerSession: {
        id: SESSION_ID,
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
  const started = () => {
    const m = mapper();
    const { providerThread } = m.bindThread(
      { threadId: THREAD_ID, state: { sessionId: "session-a", sessionFile: "/s/a.jsonl" } },
      T0,
    );
    m.startTurn(
      {
        appThread: { id: THREAD_ID, title: "OMP thread" } as OrchestrationV2AppThread,
        threadId: THREAD_ID,
        runId: PLACEMENT.runId!,
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("run-attempt:omp:1"),
        rootNodeId: PLACEMENT.rootNodeId!,
        providerThread,
        message: {
          messageId: "message:omp:1" as never,
          text: "Hi",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection: { instanceId: INSTANCE_ID, model: "default" },
        runtimePolicy: { runtimeMode: "full-access", interactionMode: "default", cwd: "/work" },
      },
      T0,
    );
    return { mapper: m, providerThread };
  };

  it("places a request in the active turn, or on the thread between turns", () => {
    const idle = mapper();
    assert.deepStrictEqual(idle.requestPlacement("ui-1", THREAD_ID), {
      threadId: THREAD_ID,
      runId: null,
      rootNodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      ordinal: 0,
    });
    const { mapper: busy, providerThread } = started();
    const placement = busy.requestPlacement("ui-2", ThreadId.make("unused"));
    assert.deepStrictEqual(
      [placement.threadId, placement.runId, placement.rootNodeId, placement.providerThreadId],
      [THREAD_ID, PLACEMENT.runId, PLACEMENT.rootNodeId, providerThread.id],
    );
    assert.strictEqual(placement.providerTurnId, busy.activeProviderTurnId);
    // The same request keeps its slot; the next one comes after it.
    assert.strictEqual(busy.requestPlacement("ui-2", THREAD_ID).ordinal, placement.ordinal);
    assert.strictEqual(busy.requestPlacement("ui-3", THREAD_ID).ordinal, placement.ordinal + 1);
  });

  it("shows open_url and set_editor_text as notifications and ignores TUI styling", () => {
    const { mapper: m } = started();
    const frames = [
      {
        type: "extension_ui_request",
        id: "ui-1",
        method: "open_url",
        url: "https://auth.example/authorize?x=1",
        instructions: "Sign in to GitHub\nthen come back",
      },
      { type: "extension_ui_request", id: "ui-2", method: "open_url", url: "https://example.com" },
      { type: "extension_ui_request", id: "ui-3", method: "set_editor_text", text: "/review src" },
      {
        type: "extension_ui_request",
        id: "ui-4",
        method: "setStatus",
        statusKey: "git",
        statusText: "main",
      },
      {
        type: "extension_ui_request",
        id: "ui-5",
        method: "setWidget",
        widgetKey: "w",
        widgetLines: ["x"],
      },
      { type: "extension_ui_request", id: "ui-6", method: "setTitle", title: "omp" },
    ];
    const items = frames
      .flatMap((frame) => m.handleFrame(frame, T1).events)
      .flatMap((event) => (event.type === "turn_item.updated" ? [event.turnItem] : []));
    assert.deepStrictEqual(
      items.map((item) =>
        item.type === "notification" ? [item.summary, item.detail, item.outcome] : item.type,
      ),
      [
        [
          "Sign in to GitHub",
          "Sign in to GitHub\nthen come back\n\nhttps://auth.example/authorize?x=1",
          "updated",
        ],
        ["OMP asks you to open a link", "https://example.com", "updated"],
        ["OMP suggested a message", "/review src", "updated"],
      ],
    );
  });
});
