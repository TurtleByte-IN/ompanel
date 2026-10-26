// OMP's dialogs, as the omp adapter emits them (packages/provider-omp/src/server/uiRequests.ts),
// shown through the provider-agnostic approval and question cards.
import {
  EnvironmentId,
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
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import * as DateTime from "effect/DateTime";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock(import("../ChatMarkdown"), async (importOriginal) => ({
  ...(await importOriginal()),
  default: (({ text }: { text: string }) => <p>{text}</p>) as never,
}));

import { render } from "../../../test/render";
import {
  buildPendingUserInputAnswers,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const NOW = DateTime.makeUnsafe("2026-10-26T10:00:00.000Z");
const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

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
    threadId: threadRef.threadId,
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

it("shows an OMP tool approval with OMP's choices and answers with the chosen decision", async () => {
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
  const decisions: Array<ProviderApprovalDecision> = [];
  await using screen = await render(
    <>
      <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />
      <ComposerPendingApprovalActions
        requestId={approval.requestId}
        isResponding={false}
        canRespond={approval.responseCapability === "live"}
        options={approval.options}
        onRespondToApproval={async (_requestId, decision) => {
          decisions.push(decision);
        }}
      />
    </>,
  );

  await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
  await expect
    .element(screen.getByLabelText("Command"))
    .toHaveTextContent("Allow tool: bash Command: rm -rf build");
  await expect.element(screen.getByText("rm deletes files")).toBeVisible();

  await screen.getByRole("button", { name: "Approve", exact: true }).click();
  await screen.getByRole("button", { name: "Deny", exact: true }).click();
  await screen.getByRole("button", { name: "More approval options" }).click();
  await page.getByRole("menuitem", { name: "Approve rm for this session" }).click();
  expect(decisions).toEqual(["accept", "decline", "acceptForSession"]);
});

it("shows an OMP confirm as a Yes/No approval card", async () => {
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
  const approval = approvals[0]!;
  const decisions: Array<ProviderApprovalDecision> = [];
  await using screen = await render(
    <>
      <ComposerPendingApprovalPanel approval={approval} pendingCount={1} />
      <ComposerPendingApprovalActions
        requestId={approval.requestId}
        isResponding={false}
        canRespond
        options={approval.options}
        onRespondToApproval={async (_requestId, decision) => {
          decisions.push(decision);
        }}
      />
    </>,
  );
  await expect
    .element(screen.getByRole("group", { name: "App permission approval" }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "More approval options" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "No", exact: true }).click();
  await screen.getByRole("button", { name: "Yes", exact: true }).click();
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

/** The question card with the composer's draft state, answering through the same helpers. */
function AskCard({ onAnswers }: { onAnswers: (answers: unknown) => void }) {
  const { userInputs } = ompRequest("ui-ask", "user_input", ASK);
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const [questionIndex, setQuestionIndex] = useState(0);
  const prompt = userInputs[0]!;
  return (
    <>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[...userInputs]}
        cwd={undefined}
        threadRef={threadRef}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={questionIndex}
        onToggleOption={(questionId, optionValue) => {
          const question = prompt.questions.find((entry) => entry.id === questionId)!;
          setAnswers((current) => ({
            ...current,
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              current[questionId],
              optionValue,
            ),
          }));
        }}
        onAdvance={() => setQuestionIndex((index) => index + 1)}
        onDismiss={() => {}}
      />
      {/* The composer is the "Other" field: typed text becomes the custom answer. */}
      <input
        aria-label="Other"
        onChange={(event) => {
          const question = prompt.questions[questionIndex]!;
          setAnswers((current) => ({
            ...current,
            [question.id]: setPendingUserInputCustomAnswer(
              current[question.id],
              event.target.value,
              question,
            ),
          }));
        }}
      />
      <button type="button" onClick={() => setQuestionIndex((index) => index + 1)}>
        Next
      </button>
      <button
        type="button"
        onClick={() => onAnswers(buildPendingUserInputAnswers(prompt.questions, answers))}
      >
        Submit
      </button>
    </>
  );
}

it("answers an OMP ask with several options on one question and Other text on the next", async () => {
  const submitted: Array<unknown> = [];
  await using screen = await render(<AskCard onAnswers={(answers) => submitted.push(answers)} />);

  await expect.element(screen.getByText("Which parts should change?")).toBeVisible();
  await expect.element(screen.getByText("1/2")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Web \(Recommended\)/ })).toBeVisible();
  const api = screen.getByRole("button", { name: /^API/ });
  const docs = screen.getByRole("button", { name: /^Docs/ });
  await api.click();
  await docs.click();
  await expect.element(api).toHaveAttribute("aria-pressed", "true");
  await expect.element(docs).toHaveAttribute("aria-pressed", "true");
  await expect
    .element(screen.getByRole("button", { name: /Web \(Recommended\)/ }))
    .toHaveAttribute("aria-pressed", "false");

  await screen.getByRole("button", { name: "Next" }).click();
  await expect.element(screen.getByText("Which tone?")).toBeVisible();
  await screen.getByLabelText("Other").fill("Friendly but brief");
  await screen.getByRole("button", { name: "Submit" }).click();

  // The omp adapter turns these into AskAnswer {selectedOptions} and {customInput}.
  expect(submitted).toEqual([{ parts: ["API", "Docs"], tone: "Friendly but brief" }]);
});
