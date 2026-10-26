import { RegistryProvider } from "@effect/atom-react";
import {
  EnvironmentId,
  NodeId,
  OrchestrationV2SubagentControlError,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentTranscriptPage,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

import { AgentsPanel } from "./AgentsPanel";
import "~/index.css";

interface ReadRequest {
  readonly environmentId: string;
  readonly input: { readonly threadId: string; readonly subagentId: string; fromByte?: number };
}

const mocks = vi.hoisted(() => ({
  subagents: [] as ReadonlyArray<unknown>,
  control: vi.fn<(request: unknown) => Promise<{ _tag: "Success"; value: void }>>(),
  read: vi.fn<(request: ReadRequest) => Promise<unknown>>(),
}));

vi.mock("~/state/entities", () => ({
  useThreadProjection: () => ({ projection: { subagents: mocks.subagents } }),
}));
vi.mock("~/state/orchestration", async () => {
  // vi.mock factories are hoisted above static imports.
  const { Atom } = await import("effect/reactivity");
  const allowed = Atom.make(true);
  return {
    orchestrationEnvironment: {
      controlSubagent: { label: "control-subagent", permissionAtom: () => allowed },
      readSubagentTranscript: { label: "read-subagent-transcript" },
    },
  };
});
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: { label: string }) =>
    command.label === "control-subagent" ? mocks.control : mocks.read,
}));

const environmentId = EnvironmentId.make("environment-a");
const threadId = ThreadId.make("thread-1");
const controls = { transcript: true, steer: true, kill: true, revive: true };

const subagent = (
  id: string,
  overrides: Partial<OrchestrationV2Subagent> & Pick<OrchestrationV2Subagent, "status">,
): OrchestrationV2Subagent => ({
  id: NodeId.make(id),
  threadId,
  runId: null,
  parentNodeId: NodeId.make("thread-agent"),
  origin: "provider_native",
  createdBy: "agent",
  driver: ProviderDriverKind.make("omp"),
  providerInstanceId: ProviderInstanceId.make("omp"),
  providerThreadId: null,
  childThreadId: null,
  nativeTaskRef: null,
  prompt: `Task for ${id}`,
  title: id,
  model: "claude-sonnet-4-5",
  result: null,
  startedAt: DateTime.makeUnsafe("2026-10-26T10:00:00.000Z"),
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-26T10:05:00.000Z"),
  controls,
  ...overrides,
});

const fixture: ReadonlyArray<OrchestrationV2Subagent> = [
  subagent("Planner", {
    status: "running",
    progress: "Reading the router",
    usage: { costUsd: 0.0123, totalTokens: 18_400, toolCalls: 7 },
  }),
  subagent("Researcher", {
    status: "running",
    parentNodeId: NodeId.make("Planner"),
    startedAt: DateTime.makeUnsafe("2026-10-26T10:01:00.000Z"),
    depth: 1,
    usage: { costUsd: 0.004, totalTokens: 5_200, toolCalls: 1 },
  }),
  subagent("Grep worker", {
    status: "completed",
    parentNodeId: NodeId.make("Researcher"),
    startedAt: DateTime.makeUnsafe("2026-10-26T10:02:00.000Z"),
    depth: 2,
    result: "Found 3 call sites.",
    usage: { costUsd: 0.0009 },
  }),
  subagent("Reviewer", {
    status: "failed",
    startedAt: DateTime.makeUnsafe("2026-10-26T10:03:00.000Z"),
    model: "gpt-5",
    result: "Model quota exceeded.",
  }),
];

const transcriptPage = (
  fromByte: number,
  nextByte: number,
  entries: OrchestrationV2SubagentTranscriptPage["entries"],
): { _tag: "Success"; value: OrchestrationV2SubagentTranscriptPage } => ({
  _tag: "Success",
  value: { fromByte, nextByte, reset: false, entries },
});

function setup() {
  vi.resetAllMocks();
  mocks.subagents = fixture;
  mocks.control.mockResolvedValue({ _tag: "Success", value: undefined });
  mocks.read.mockImplementation(async (request) => {
    const fromByte = request.input.fromByte ?? 0;
    if (fromByte === 0) {
      return transcriptPage(0, 40, [
        { role: "user", text: "Find where the router is configured." },
        { role: "assistant", text: "Searching the app shell." },
      ]);
    }
    if (fromByte === 40) {
      return transcriptPage(40, 75, [{ role: "tool", toolName: "grep", text: "src/router.ts:12" }]);
    }
    return transcriptPage(fromByte, fromByte, []);
  });
  const container = document.createElement("div");
  container.style.width = "420px";
  container.style.height = "720px";
  container.className = "bg-background text-foreground";
  return container;
}

const panel = () => (
  <RegistryProvider>
    <AgentsPanel threadRef={{ environmentId, threadId }} />
  </RegistryProvider>
);

const rowDepths = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-agent-row]")].map((row) => [
    row.dataset.agentRow,
    row.dataset.depth,
    row.parentElement?.closest<HTMLElement>("[data-agent-row]")?.dataset.agentRow ?? null,
  ]);

describe("AgentsPanel", () => {
  it("shows an empty state without subagents", async () => {
    const container = setup();
    mocks.subagents = [];
    await using screen = await render(panel(), { container });
    await expect.element(screen.getByText("No agents yet")).toBeVisible();
    expect(mocks.read).not.toHaveBeenCalled();
  });

  it("renders the nested tree, pages the transcript, and sends each control", async () => {
    const container = setup();
    await using screen = await render(panel(), { container });

    expect(rowDepths(container)).toEqual([
      ["Planner", "0", null],
      ["Researcher", "1", "Planner"],
      ["Grep worker", "2", "Researcher"],
      ["Reviewer", "0", null],
    ]);
    await expect
      .element(screen.getByText("claude-sonnet-4-5 · $0.0123 · 18.4K tokens · 7 tool calls"))
      .toBeVisible();

    // A running agent: the transcript reads from 0, then polls from the returned nextByte.
    await screen.getByRole("button", { name: "Researcher, Running" }).click();
    await expect.element(screen.getByText("Searching the app shell.")).toBeVisible();
    // The second page arrives on the first poll, 1.5 s later.
    await expect.element(screen.getByText("src/router.ts:12"), { timeout: 5000 }).toBeVisible();
    const reads = mocks.read.mock.calls.map(([request]) => request);
    expect(reads.slice(0, 2)).toEqual([
      { environmentId, input: { threadId, subagentId: "Researcher", fromByte: 0 } },
      { environmentId, input: { threadId, subagentId: "Researcher", fromByte: 40 } },
    ]);
    const toolEntry = container.querySelector<HTMLElement>('[data-role="tool"]');
    expect(toolEntry?.textContent).toBe("grepsrc/router.ts:12");

    // Review artifact of the nested tree; `__screenshots__/` is git-ignored.
    await page.screenshot({ path: "__screenshots__/agents-panel.png", element: container });

    await screen.getByLabelText("Message to Researcher").fill("  Also check the tests.  ");
    await screen.getByRole("button", { name: "Send" }).click();
    await vi.waitFor(() => expect(mocks.control).toHaveBeenCalledTimes(1));
    expect(mocks.control).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        threadId,
        subagentId: "Researcher",
        action: { type: "steer", message: "Also check the tests." },
      },
    });

    await screen.getByRole("button", { name: "Kill" }).click();
    await vi.waitFor(() => expect(mocks.control).toHaveBeenCalledTimes(2));
    expect(mocks.control).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId, subagentId: "Researcher", action: { type: "kill" } },
    });

    // A finished agent: no steer or kill, revive with an optional message.
    await screen.getByRole("button", { name: "Grep worker, Completed" }).click();
    await expect.element(screen.getByText("Found 3 call sites.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Kill" }).query()).toBeNull();
    expect(screen.getByRole("button", { name: "Send" }).query()).toBeNull();
    await screen.getByLabelText("Message to revive Grep worker with").fill("Look in tests too.");
    await screen.getByRole("button", { name: "Revive" }).click();
    await vi.waitFor(() => expect(mocks.control).toHaveBeenCalledTimes(3));
    expect(mocks.control).toHaveBeenLastCalledWith({
      environmentId,
      input: {
        threadId,
        subagentId: "Grep worker",
        action: { type: "revive", message: "Look in tests too." },
      },
    });

    // Revive without a message sends no message field.
    await screen.getByRole("button", { name: "Reviewer, Failed" }).click();
    await screen.getByRole("button", { name: "Revive" }).click();
    await vi.waitFor(() => expect(mocks.control).toHaveBeenCalledTimes(4));
    expect(mocks.control).toHaveBeenLastCalledWith({
      environmentId,
      input: { threadId, subagentId: "Reviewer", action: { type: "revive" } },
    });
  });

  it("shows a failed control's message", async () => {
    const container = setup();
    mocks.control.mockResolvedValue({
      _tag: "Failure",
      cause: Cause.fail(
        new OrchestrationV2SubagentControlError({
          threadId,
          subagentId: NodeId.make("Planner"),
          reason: "unavailable",
        }),
      ),
    } as never);
    await using screen = await render(panel(), { container });
    await screen.getByRole("button", { name: "Planner, Running" }).click();
    await screen.getByRole("button", { name: "Kill" }).click();
    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("This subagent's provider session is not running.");
  });
});
