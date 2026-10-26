import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
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
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../state/orchestration", () => ({ orchestrationEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { AgentsTreeView, type SubagentTranscriptView } from "./ThreadAgentsTree";

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

function render(
  selectedId: string | null,
  transcript: SubagentTranscriptView = { entries: [], error: null, loading: false },
  handlers: { onSelect?: (id: string) => void; onOpenThread?: (id: ThreadId) => void } = {},
) {
  act(() =>
    root.render(
      <AgentsTreeView
        subagents={SUBAGENTS}
        selectedId={selectedId}
        transcript={transcript}
        onSelect={handlers.onSelect ?? (() => undefined)}
        onOpenThread={handlers.onOpenThread ?? (() => undefined)}
      />,
    ),
  );
}

const rows = () => Array.from(container.querySelectorAll("button"));

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
          onSelect={() => undefined}
          onOpenThread={(id) => opened.push(id)}
        />,
      ),
    );
    act(() => rows()[0]!.click());
    expect(opened).toEqual(["child-thread"]);
  });
});
