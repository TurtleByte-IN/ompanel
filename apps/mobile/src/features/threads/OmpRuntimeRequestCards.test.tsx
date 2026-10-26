// OMP's dialogs, as the omp adapter emits them (packages/provider-omp/src/server/uiRequests.ts),
// answered through the mobile approval and question cards.
import {
  NodeId,
  ProviderDriverKind,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import type { ThreadUserInputQuestion } from "@t3tools/client-runtime/state/thread-requests";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import * as DateTime from "effect/DateTime";
import { act, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

type Pressable = {
  readonly children?: ReactNode;
  readonly accessibilityLabel?: string;
  readonly accessibilityRole?: string;
  readonly accessibilityState?: { readonly checked?: boolean };
  readonly disabled?: boolean;
  readonly onPress?: () => void;
};

vi.mock("react-native", () => {
  const Box = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    View: Box,
    ScrollView: Box,
    Platform: { OS: "android" },
    Pressable: (props: Pressable) => (
      <button
        type="button"
        aria-label={props.accessibilityLabel}
        role={props.accessibilityRole === "button" ? undefined : props.accessibilityRole}
        aria-checked={props.accessibilityState?.checked}
        disabled={props.disabled}
        onClick={props.onPress}
      >
        {props.children}
      </button>
    ),
  };
});
vi.mock("react-native-reanimated", () => {
  const transition = { duration: () => transition, easing: () => transition };
  return {
    default: { View: ({ children }: { children?: ReactNode }) => <div>{children}</div> },
    Easing: { out: () => undefined, cubic: undefined },
    FadeInUp: transition,
    FadeOutDown: transition,
    useAnimatedStyle: () => ({}),
    useSharedValue: (value: number) => ({ value }),
  };
});
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress?: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("../../components/ui/ControlPill", () => ({ ControlPill: () => null }));
vi.mock("../../native/SelectableMarkdownText", () => ({
  SelectableMarkdownText: ({ markdown }: { markdown: string }) => <p>{markdown}</p>,
}));
vi.mock("../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => () => undefined }));
vi.mock("../files/FileMarkdownPreview", () => ({
  useMarkdownPreviewStyles: () => ({ nativeTextStyle: {} }),
}));
vi.mock("./QuestionAttachments", () => ({
  QuestionAttachments: (props: {
    question: ThreadUserInputQuestion;
    value: string;
    onChangeText: (value: string) => void;
  }) => (
    <input
      aria-label={`${props.question.header} answer`}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));

import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";
import { PendingApprovalCard } from "./PendingApprovalCard";
import { PendingUserInputCard } from "./PendingUserInputCard";

const NOW = DateTime.makeUnsafe("2026-10-26T10:00:00.000Z");
const threadId = ThreadId.make("thread");

/** One pending OMP request and its card item, as `runtime_request.updated` and `turn_item.updated` carry them. */
function ompRequest(
  nativeId: string,
  kind: OrchestrationV2RuntimeRequest["kind"],
  item: Record<string, unknown>,
) {
  const id = RuntimeRequestId.make(
    `runtime-request:provider:omp:session:session-omp:native-request:${nativeId}`,
  );
  const runtimeRequest: OrchestrationV2RuntimeRequest = {
    id,
    nodeId: NodeId.make(`node:runtime-request:${id}`),
    providerTurnId: null,
    nativeRequestRef: { driver: ProviderDriverKind.make("omp"), nativeId, strength: "strong" },
    kind,
    status: "pending",
    responseCapability: { type: "live", providerSessionId: ProviderSessionId.make("session-omp") },
    createdAt: NOW,
    resolvedAt: null,
  };
  const turnItem = {
    id: TurnItemId.make(`turn-item:runtime-request:${id}`),
    threadId,
    runId: null,
    nodeId: runtimeRequest.nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: runtimeRequest.nativeRequestRef,
    parentItemId: null,
    ordinal: 1,
    status: "waiting",
    startedAt: NOW,
    completedAt: null,
    updatedAt: NOW,
    requestId: id,
    ...item,
  } as OrchestrationV2TurnItem;
  return derivePendingThreadRequests({ runtimeRequests: [runtimeRequest], turnItems: [turnItem] });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function button(name: string): HTMLButtonElement {
  const match = Array.from(container.querySelectorAll("button")).find(
    (element) => element.getAttribute("aria-label") === name || element.textContent === name,
  );
  if (!match) throw new Error(`No button ${name}`);
  return match;
}

function click(element: HTMLElement) {
  act(() => element.click());
}

it("answers an OMP tool approval with OMP's own choices", async () => {
  const { approvals } = ompRequest("ui-approve", "command", {
    type: "approval_request",
    title: "Allow tool: bash",
    requestKind: "command",
    prompt: "Allow tool: bash\nCommand: rm -rf build",
    reason: "rm deletes files",
    options: [
      { decision: "accept", label: "Approve" },
      { decision: "acceptForSession", label: "Approve rm for this session" },
      { decision: "decline", label: "Deny" },
    ],
  });
  const approval = approvals[0]!;
  const decisions: ProviderApprovalDecision[] = [];
  act(() =>
    root.render(
      <PendingApprovalCard
        canOperateThread
        approval={approval}
        respondingApprovalId={null}
        onRespond={async (requestId, decision) => {
          expect(requestId).toBe(approval.requestId);
          decisions.push(decision);
        }}
      />,
    ),
  );

  expect(container.textContent).toContain("Approval needed");
  expect(container.textContent).toContain("rm deletes files");
  click(button("Approve"));
  click(button("Approve rm for this session"));
  click(button("Deny"));
  expect(decisions).toEqual(["accept", "acceptForSession", "decline"]);
});

it("answers an OMP confirm as Yes/No", () => {
  const { approvals } = ompRequest("ui-confirm", "permission", {
    type: "approval_request",
    title: "Overwrite notes.md?",
    requestKind: "permission",
    prompt: "Overwrite notes.md?\nIt has unsaved edits.",
    options: [
      { decision: "accept", label: "Yes" },
      { decision: "decline", label: "No" },
    ],
  });
  const decisions: ProviderApprovalDecision[] = [];
  act(() =>
    root.render(
      <PendingApprovalCard
        canOperateThread
        approval={approvals[0]!}
        respondingApprovalId={null}
        onRespond={async (_requestId, decision) => {
          decisions.push(decision);
        }}
      />,
    ),
  );
  expect(container.querySelectorAll("button")).toHaveLength(2);
  click(button("No"));
  click(button("Yes"));
  expect(decisions).toEqual(["decline", "accept"]);
});

const ASK = {
  type: "user_input_request",
  title: "Questions",
  questions: [
    {
      id: "parts",
      header: "Parts",
      question: "Which parts should change?",
      options: [
        { label: "API", description: "Server routes", value: "API" },
        { label: "Web (Recommended)", description: "Web", value: "Web" },
        { label: "Docs", description: "Docs", value: "Docs" },
      ],
      multiSelect: true,
      allowCustomAnswer: true,
    },
    {
      id: "tone",
      header: "Tone",
      question: "Which tone?",
      options: [{ label: "Terse", description: "Terse", value: "Terse" }],
      multiSelect: false,
      allowCustomAnswer: true,
    },
  ],
};

/** The question card with the drafts the thread screen keeps, built by the same helpers. */
function AskCard(props: { readonly onSubmit: (answers: unknown) => void }) {
  const { userInputs } = ompRequest("ui-ask", "user_input", ASK);
  const request = userInputs[0]!;
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const answers = buildPendingUserInputAnswers(request.questions, drafts);
  return (
    <PendingUserInputCard
      canOperateThread
      pendingUserInput={request}
      maxHeight={{ value: 600 } as never}
      collapsed={false}
      onToggleCollapsed={() => undefined}
      drafts={drafts}
      answers={answers}
      respondingUserInputId={null}
      onSelectOption={(_requestId, question, value) =>
        setDrafts((current) => ({
          ...current,
          [question.id]: togglePendingUserInputOptionSelection(
            question,
            current[question.id],
            value,
          ),
        }))
      }
      onChangeCustomAnswer={(_requestId, questionId, customAnswer) =>
        setDrafts((current) => {
          const question = request.questions.find((entry) => entry.id === questionId)!;
          return {
            ...current,
            [questionId]: setPendingUserInputCustomAnswer(
              question,
              current[questionId],
              customAnswer,
            ),
          };
        })
      }
      onSubmit={async () => props.onSubmit(answers)}
      onDismiss={async () => undefined}
    />
  );
}

it("answers an OMP ask: several options for a multi-select, free text for another", () => {
  const submitted: unknown[] = [];
  act(() => root.render(<AskCard onSubmit={(answers) => submitted.push(answers)} />));

  expect(container.textContent).toContain("Which parts should change?");
  const checkboxes = container.querySelectorAll('[role="checkbox"]');
  expect(checkboxes).toHaveLength(3);
  expect(button("Submit answers").disabled).toBe(true);

  click(button("APIServer routes"));
  click(button("Web (Recommended)Web"));
  expect(button("APIServer routes").getAttribute("aria-checked")).toBe("true");

  const tone = container.querySelector<HTMLInputElement>('input[aria-label="Tone answer"]')!;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(tone, "Friendly");
    tone.dispatchEvent(new Event("input", { bubbles: true }));
  });

  expect(button("Submit answers").disabled).toBe(false);
  click(button("Submit answers"));
  expect(submitted).toEqual([{ parts: ["API", "Web"], tone: "Friendly" }]);
});
