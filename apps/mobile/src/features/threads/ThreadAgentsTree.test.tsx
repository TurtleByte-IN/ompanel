import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentControlAction,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type PressableProps = {
  readonly children?: ReactNode;
  readonly accessibilityLabel?: string;
  readonly accessibilityState?: { readonly expanded?: boolean };
  readonly onPress?: () => void;
  readonly style?: { readonly paddingLeft?: number };
};

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
  Pressable: (props: PressableProps) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel}
      aria-expanded={props.accessibilityState?.expanded}
      data-indent={props.style?.paddingLeft}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
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
  Button: (props: {
    label: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      type="button"
      data-control
      aria-label={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
const commands = vi.hoisted(() => ({
  control: { permissionAtom: () => "control-permission" },
  read: {},
  // The transcript read never settles, so only the control call is observed.
  readSpy: () => new Promise<never>(() => undefined),
  controlSpy: (_input: unknown): Promise<unknown> => Promise.resolve({ _tag: "Success" }),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => true }));
vi.mock("../../state/orchestration", () => ({
  orchestrationEnvironment: {
    controlSubagent: commands.control,
    readSubagentTranscript: commands.read,
  },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: unknown) =>
    command === commands.control ? commands.controlSpy : commands.readSpy,
}));

import {
  AgentsTreeView,
  ThreadAgentsTree,
  type SubagentControlsView,
  type SubagentTranscriptView,
} from "./ThreadAgentsTree";

const threadId = ThreadId.make("thread");
const CONTROLS = { transcript: true, steer: true, kill: true, revive: true };

function subagent(
  id: string,
  parent: string,
  startedAtMs: number,
  overrides: Partial<OrchestrationV2Subagent> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make(id),
    parentNodeId: NodeId.make(parent),
    threadId,
    childThreadId: null,
    runId: null,
    driver: ProviderDriverKind.make("omp"),
    providerInstanceId: ProviderInstanceId.make("omp"),
    title: null,
    prompt: `${id} prompt`,
    model: null,
    status: "running",
    progress: null,
    result: null,
    startedAt: DateTime.makeUnsafe(startedAtMs),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe(startedAtMs),
    controls: CONTROLS,
    ...overrides,
  } as OrchestrationV2Subagent;
}

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

const SUBAGENTS = [
  subagent("explore", "root", 1_000, {
    title: "Explore the repo",
    model: "claude-sonnet",
    usage: { costUsd: 0.0123, totalTokens: 12_500, toolCalls: 3 },
  }),
  subagent("explore-child", "explore", 2_000, { status: "completed" }),
  subagent("review", "root", 3_000, { status: "failed" }),
];

const NO_CONTROLS: SubagentControlsView = {
  permitted: false,
  busy: null,
  error: null,
  onControl: async () => false,
};

function render(
  selectedId: string | null,
  transcript: SubagentTranscriptView = { entries: [], error: null, loading: false },
  handlers: { onSelect?: (id: string) => void; onOpenThread?: (id: ThreadId) => void } = {},
  controls: SubagentControlsView = NO_CONTROLS,
  subagents: ReadonlyArray<OrchestrationV2Subagent> = SUBAGENTS,
) {
  act(() =>
    root.render(
      <AgentsTreeView
        subagents={subagents}
        selectedId={selectedId}
        transcript={transcript}
        controls={controls}
        onSelect={handlers.onSelect ?? (() => undefined)}
        onOpenThread={handlers.onOpenThread ?? (() => undefined)}
      />,
    ),
  );
}

const rows = () =>
  Array.from(container.querySelectorAll<HTMLButtonElement>("button:not([data-control])"));
const control = (name: string) =>
  container.querySelector<HTMLButtonElement>(`button[data-control][aria-label="${name}"]`);

/** Types into a React-controlled textarea the way a user does. */
function type(label: string, value: string) {
  const input = container.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function recordingControls(
  overrides: Partial<SubagentControlsView> = {},
  succeed = true,
): { controls: SubagentControlsView; actions: OrchestrationV2SubagentControlAction[] } {
  const actions: OrchestrationV2SubagentControlAction[] = [];
  return {
    actions,
    controls: {
      ...NO_CONTROLS,
      permitted: true,
      onControl: async (action) => {
        actions.push(action);
        return succeed;
      },
      ...overrides,
    },
  };
}

describe("AgentsTreeView", () => {
  it("lists the subagent tree in order with status, nesting and usage", () => {
    render(null);
    expect(rows().map((row) => row.getAttribute("aria-label"))).toEqual([
      "Explore the repo, Working",
      "explore-child prompt, Completed, level 2",
      "review prompt, Failed",
    ]);
    expect(rows().map((row) => row.dataset.indent)).toEqual(["0", "14", "0"]);
    expect(rows()[0]!.textContent).toContain(
      "claude-sonnet · $0.0123 · 12.5K tokens · 3 tool calls",
    );
    expect(container.querySelector('[aria-label="Transcript"]')).toBeNull();
  });

  it("selects a subagent and shows its transcript by role", () => {
    const selected: string[] = [];
    render(null, undefined, { onSelect: (id) => selected.push(id) });
    act(() => rows()[2]!.click());
    expect(selected).toEqual(["review"]);

    render("review", {
      loading: false,
      error: null,
      entries: [
        { role: "user", text: "Review the diff" },
        { role: "tool", toolName: "read", text: "src/a.ts", isError: false },
        { role: "assistant", text: "Looks good" },
      ],
    });
    expect(rows()[2]!.getAttribute("aria-expanded")).toBe("true");
    const transcript = container.querySelector('[aria-label="Transcript"]')!;
    expect(transcript.textContent).toBe(
      "UserReview the diffTool · readsrc/a.tsAssistantLooks good",
    );
  });

  it("shows loading and read errors instead of an empty transcript", () => {
    render("explore", { entries: [], error: null, loading: true });
    expect(container.textContent).toContain("Reading transcript…");
    render("explore", {
      entries: [],
      error: "This subagent's provider session is not running.",
      loading: false,
    });
    expect(container.textContent).toContain("This subagent's provider session is not running.");
  });

  it("opens a subagent that has its own thread instead of a transcript", () => {
    const opened: ThreadId[] = [];
    act(() =>
      root.render(
        <AgentsTreeView
          subagents={[
            subagent("child", "root", 1, { childThreadId: ThreadId.make("child-thread") }),
          ]}
          selectedId={null}
          transcript={{ entries: [], error: null, loading: false }}
          controls={NO_CONTROLS}
          onSelect={() => undefined}
          onOpenThread={(id) => opened.push(id)}
        />,
      ),
    );
    act(() => rows()[0]!.click());
    expect(opened).toEqual(["child-thread"]);
  });
});

describe("AgentsTreeView controls", () => {
  it("steers a running subagent with the typed message and clears it after", async () => {
    const { controls, actions } = recordingControls();
    render("explore", undefined, {}, controls);
    expect(control("Send to Explore the repo")!.disabled).toBe(true);
    type("Message to Explore the repo", "  Focus on src/  ");
    expect(control("Send to Explore the repo")!.disabled).toBe(false);
    await act(async () => control("Send to Explore the repo")!.click());
    expect(actions).toEqual([{ type: "steer", message: "Focus on src/" }]);
    expect(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message to Explore the repo"]',
      )!.value,
    ).toBe("");
  });

  it("kills a running subagent", async () => {
    const { controls, actions } = recordingControls();
    render("explore", undefined, {}, controls);
    await act(async () => control("Kill Explore the repo")!.click());
    expect(actions).toEqual([{ type: "kill" }]);
    // Revive is for stopped agents only.
    expect(control("Revive Explore the repo")).toBeNull();
  });

  it("revives a stopped subagent, with or without a message", async () => {
    const { controls, actions } = recordingControls();
    render("review", undefined, {}, controls);
    expect(control("Kill review prompt")).toBeNull();
    expect(container.querySelector('textarea[aria-label="Message to review prompt"]')).toBeNull();
    await act(async () => control("Revive review prompt")!.click());
    type("Message to revive review prompt with", "Try again with tests");
    await act(async () => control("Revive review prompt")!.click());
    expect(actions).toEqual([
      { type: "revive" },
      { type: "revive", message: "Try again with tests" },
    ]);
  });

  it("keeps the message and shows the failure when a control fails", async () => {
    const { controls } = recordingControls(
      { error: "This subagent's provider session is not running." },
      false,
    );
    render("explore", undefined, {}, controls);
    type("Message to Explore the repo", "Stop");
    await act(async () => control("Send to Explore the repo")!.click());
    expect(
      container.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Message to Explore the repo"]',
      )!.value,
    ).toBe("Stop");
    expect(container.textContent).toContain("This subagent's provider session is not running.");
  });

  it("disables every control while one runs", () => {
    const { controls } = recordingControls({ busy: "kill" });
    render("explore", undefined, {}, controls);
    expect(control("Kill Explore the repo")!.textContent).toBe("Killing…");
    expect(control("Kill Explore the repo")!.disabled).toBe(true);
    expect(control("Send to Explore the repo")!.disabled).toBe(true);
  });

  it("shows no controls without permission or when the provider offers none", () => {
    render("explore", undefined, {}, NO_CONTROLS);
    expect(container.querySelector("[data-control]")).toBeNull();
    const { controls } = recordingControls();
    render("explore", undefined, {}, controls, [
      subagent("explore", "root", 1_000, {
        title: "Explore the repo",
        controls: { transcript: true, steer: false, kill: false, revive: false },
      }),
    ]);
    expect(container.querySelector("[data-control]")).toBeNull();
  });
});

describe("ThreadAgentsTree", () => {
  it("sends the control for the selected subagent of this thread", async () => {
    const calls: unknown[] = [];
    commands.controlSpy = (input) => {
      calls.push(input);
      return Promise.resolve({ _tag: "Success" });
    };
    act(() =>
      root.render(
        <ThreadAgentsTree
          environmentId={"env" as never}
          threadId={threadId}
          subagents={SUBAGENTS}
          initialSelectedId="explore"
          onOpenThread={() => undefined}
        />,
      ),
    );
    await act(async () => control("Kill Explore the repo")!.click());
    expect(calls).toEqual([
      {
        environmentId: "env",
        input: { threadId, subagentId: "explore", action: { type: "kill" } },
      },
    ]);
  });
});
