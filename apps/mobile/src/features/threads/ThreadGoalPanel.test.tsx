import { EnvironmentId, ThreadId, type OrchestrationV2ProviderGoal } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
  TextInput: (props: {
    readonly accessibilityLabel: string;
    readonly value: string;
    readonly onChangeText: (value: string) => void;
  }) => (
    <textarea
      aria-label={props.accessibilityLabel}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
  }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock("../../state/entities", () => ({ useThreadShell: () => null }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => true }));
const outbox = vi.hoisted(() => ({ enqueue: vi.fn(async (_message: unknown) => undefined) }));
vi.mock("../../state/thread-outbox", () => ({ enqueueThreadOutboxMessage: outbox.enqueue }));
vi.mock("../../lib/commandMetadata", () => ({
  makeQueuedMessageMetadata: () => ({
    commandId: "command-1",
    messageId: "message-1",
    createdAt: "2026-10-27T00:00:00.000Z",
  }),
}));

import { enqueueOmpCommandTurn, GoalPanelView } from "./ThreadGoalPanel";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

const GOAL: OrchestrationV2ProviderGoal = {
  objective: "Ship the mobile goal sheet",
  status: "active",
  tokensUsed: 1_200,
  tokenBudget: 50_000,
} as OrchestrationV2ProviderGoal;

function render(
  goal: OrchestrationV2ProviderGoal | null,
  options: { working?: boolean; disabled?: boolean; error?: string | null } = {},
) {
  const sent: Array<{ text: string; failure: string }> = [];
  act(() =>
    root.render(
      <GoalPanelView
        goal={goal}
        working={options.working ?? false}
        disabled={options.disabled ?? false}
        error={options.error ?? null}
        onSendCommand={(text, failure) => sent.push({ text, failure })}
      />,
    ),
  );
  return sent;
}

const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find((node) => node.textContent === label) ??
  null;

const press = (label: string) => act(() => button(label)!.click());

function type(label: string, value: string) {
  const input = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("enqueueOmpCommandTurn", () => {
  it("queues the command text as its own turn on the thread's settings", async () => {
    await enqueueOmpCommandTurn({
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      text: "/goal pause",
    });
    expect(outbox.enqueue).toHaveBeenCalledWith({
      environmentId: "env",
      threadId: "thread",
      messageId: "message-1",
      commandId: "command-1",
      text: "/goal pause",
      attachments: [],
      createdAt: "2026-10-27T00:00:00.000Z",
    });
  });
});

describe("GoalPanelView", () => {
  it("summarises the goal: status, objective, usage and budget", () => {
    render(GOAL);
    const text = container.textContent ?? "";
    expect(text).toContain("Goal set");
    expect(text).toContain("Ship the mobile goal sheet");
    expect(text).toContain("tokens");
    expect(text).toContain(`Token budget: ${(50_000).toLocaleString()}`);
    expect(text).toContain("goal.continuationModes");
    // An active goal has no set form.
    expect(container.querySelector('textarea[aria-label="Objective"]')).toBeNull();
  });

  it("sends /goal pause and /goal drop for an active goal", () => {
    const sent = render(GOAL);
    expect(button("Resume")).toBeNull();
    press("Pause");
    press("Drop");
    expect(sent).toEqual([
      { text: "/goal pause", failure: "Failed to pause goal." },
      { text: "/goal drop", failure: "Failed to drop goal." },
    ]);
  });

  it("sends /goal resume for a paused goal", () => {
    const sent = render({ ...GOAL, status: "paused" });
    expect(button("Pause")).toBeNull();
    press("Resume");
    expect(sent.map((entry) => entry.text)).toEqual(["/goal resume"]);
  });

  it("hides the actions while the thread is working", () => {
    render(GOAL, { working: true });
    expect(container.textContent).toContain("Pursuing goal");
    expect(container.textContent).toContain(
      "You can pause, resume or drop the goal once this turn ends.",
    );
    expect(button("Pause")).toBeNull();
    expect(button("Drop")).toBeNull();
  });

  it("sets a goal with a token budget", () => {
    const sent = render(null);
    expect(container.textContent).toContain("No goal set");
    expect(button("Set goal")!.disabled).toBe(true);
    type("Objective", "Fix the  flaky\ntest");
    type("Token budget (optional)", "20000");
    press("Set goal");
    expect(sent).toEqual([
      { text: "/goal set --budget 20000 Fix the flaky test", failure: "Failed to set goal." },
    ]);
  });

  it("sets a goal without a budget", () => {
    const sent = render(null);
    type("Objective", "Write docs");
    press("Set goal");
    expect(sent.map((entry) => entry.text)).toEqual(["/goal set Write docs"]);
  });

  it("blocks an invalid budget", () => {
    const sent = render(null);
    type("Objective", "Write docs");
    type("Token budget (optional)", "1.5");
    expect(container.textContent).toContain("Enter a whole number of tokens.");
    expect(button("Set goal")!.disabled).toBe(true);
    press("Set goal");
    expect(sent).toEqual([]);
  });

  it("offers a new goal once the goal is complete, and waits while working", () => {
    render({ ...GOAL, status: "complete" });
    expect(container.textContent).toContain("Goal complete");
    expect(container.textContent).toContain("Set a new goal");
    render({ ...GOAL, status: "complete" }, { working: true });
    type("Objective", "Next");
    expect(button("Set goal")!.disabled).toBe(true);
  });

  it("shows why a command did not send", () => {
    render(GOAL, { error: "Failed to save the queued message." });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Failed to save the queued message.",
    );
  });
});
