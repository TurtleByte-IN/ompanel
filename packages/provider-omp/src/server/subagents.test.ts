import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2Subagent,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";

import { OMP_PROVIDER } from "./mapper.ts";
import {
  contractAtLeast,
  type OmpSubagentScope,
  OmpSubagentTracker,
  ompSubagentControls,
  ompTranscriptEntries,
  ompTranscriptPage,
} from "./subagents.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;

const at = (seconds: number) =>
  DateTime.makeUnsafe(Date.parse("2026-10-26T10:00:00.000Z") + seconds * 1000);

const PROVIDER_THREAD = ProviderThreadId.make("provider-thread:omp:a");
const SCOPE: OmpSubagentScope = {
  threadId: ThreadId.make("thread:omp"),
  providerThreadId: PROVIDER_THREAD,
  runId: RunId.make("run:1"),
  rootNodeId: NodeId.make("node:run:1:root"),
};

const tracker = (contract = "1.2.0") =>
  new OmpSubagentTracker({
    instanceId: ProviderInstanceId.make("omp-work"),
    controls: ompSubagentControls(contract),
  });

const lifecycle = (payload: Record<string, unknown>) => ({
  type: "subagent_lifecycle",
  payload: { agent: "task", agentSource: "bundled", index: 0, ...payload },
});

const progress = (
  id: string,
  fields: Record<string, unknown>,
  lineage: Record<string, unknown> = {},
) => ({
  type: "subagent_progress",
  payload: {
    index: 0,
    agent: "task",
    agentSource: "bundled",
    task: "Map the auth flow",
    ...lineage,
    progress: { id, status: "running", toolCount: 0, tokens: 0, cost: 0, durationMs: 0, ...fields },
  },
});

const subagentsOf = (events: ReadonlyArray<Event>): Array<OrchestrationV2Subagent> =>
  events.flatMap((event) => (event.type === "subagent.updated" ? [event.subagent] : []));

describe("OmpSubagentTracker", () => {
  it("hangs nested subagents under their parent's node using parentId and depth", () => {
    const subagents = tracker();
    const root = subagentsOf(
      subagents.handleFrame(
        lifecycle({ id: "Planner", status: "started", parentId: null, depth: 0 }),
        SCOPE,
        at(0),
      ),
    );
    const child = subagentsOf(
      subagents.handleFrame(
        lifecycle({ id: "Reader", status: "started", parentId: "Planner", depth: 1 }),
        SCOPE,
        at(1),
      ),
    );
    const grandchild = subagentsOf(
      subagents.handleFrame(
        lifecycle({ id: "Grep", status: "started", parentId: "Reader", depth: 2 }),
        SCOPE,
        at(2),
      ),
    );

    assert.strictEqual(root[0]?.parentNodeId, SCOPE.rootNodeId);
    assert.strictEqual(root[0]?.depth, 0);
    assert.strictEqual(child[0]?.parentNodeId, root[0]?.id);
    assert.strictEqual(child[0]?.depth, 1);
    assert.strictEqual(grandchild[0]?.parentNodeId, child[0]?.id);
    assert.strictEqual(grandchild[0]?.depth, 2);
    assert.strictEqual(child[0]?.id, OmpSubagentTracker.nodeId(PROVIDER_THREAD, "Reader"));
    assert.deepStrictEqual(grandchild[0]?.nativeTaskRef, {
      driver: OMP_PROVIDER,
      nativeId: "Grep",
      strength: "strong",
    });
  });

  it("hangs a subagent from a contract without lineage under the task call that spawned it", () => {
    const subagents = tracker("1.0.0");
    const [record] = subagentsOf(
      subagents.handleFrame(
        lifecycle({ id: "Scout", status: "started", parentToolCallId: "call-task" }),
        SCOPE,
        at(0),
      ),
    );
    assert.strictEqual(
      record?.parentNodeId,
      NodeId.make("node:provider:omp:native-item:call-task"),
    );
    assert.strictEqual(record?.depth, undefined);
  });

  it("maps progress to the step, model, cost and tool calls, and skips repeats", () => {
    const subagents = tracker();
    subagents.handleFrame(lifecycle({ id: "Reader", status: "started" }), SCOPE, at(0));
    const frame = progress("Reader", {
      stage: "Reading src/auth.ts",
      resolvedModel: "anthropic/claude-sonnet-5",
      cost: 0.0123,
      tokens: 4_200,
      toolCount: 3,
      durationMs: 12_500,
    });
    const [record] = subagentsOf(subagents.handleFrame(frame, SCOPE, at(1)));

    assert.strictEqual(record?.status, "running");
    assert.strictEqual(record?.progress, "Reading src/auth.ts");
    assert.strictEqual(record?.model, "anthropic/claude-sonnet-5");
    assert.strictEqual(record?.prompt, "Map the auth flow");
    assert.deepStrictEqual(record?.usage, {
      costUsd: 0.0123,
      totalTokens: 4_200,
      toolCalls: 3,
      durationMs: 12_500,
    });
    assert.deepStrictEqual(subagents.handleFrame(frame, SCOPE, at(2)), []);
  });

  it("ends on the lifecycle frame and restarts when a revived subagent starts again", () => {
    const subagents = tracker("1.4.0");
    subagents.handleFrame(lifecycle({ id: "Reader", status: "started" }), SCOPE, at(0));
    const [killed] = subagentsOf(
      subagents.handleFrame(lifecycle({ id: "Reader", status: "aborted" }), SCOPE, at(5)),
    );
    // A progress frame racing the kill does not bring it back.
    const late = subagentsOf(
      subagents.handleFrame(progress("Reader", { status: "running", toolCount: 4 }), SCOPE, at(6)),
    );
    const [revived] = subagentsOf(
      subagents.handleFrame(
        lifecycle({ id: "Reader", status: "started" }),
        { ...SCOPE, runId: null, rootNodeId: null },
        at(10),
      ),
    );

    assert.strictEqual(killed?.status, "cancelled");
    assert.deepStrictEqual(killed?.completedAt, at(5));
    assert.strictEqual(late[0]?.status, "cancelled");
    assert.strictEqual(revived?.status, "running");
    assert.strictEqual(revived?.completedAt, null);
    assert.deepStrictEqual(revived?.startedAt, at(10));
    // Revived outside a turn, it stays where it was spawned.
    assert.strictEqual(revived?.runId, SCOPE.runId);
    assert.strictEqual(revived?.parentNodeId, killed?.parentNodeId);
    assert.isTrue(revived?.controls?.revive);
  });

  it("drops frames that arrive before a thread is bound", () => {
    assert.deepStrictEqual(
      tracker().handleFrame(lifecycle({ id: "Early", status: "started" }), null, at(0)),
      [],
    );
  });
});

describe("OMP subagent controls", () => {
  it("offers revive only from RPC contract 1.4.0", () => {
    assert.isFalse(ompSubagentControls("1.0.0").revive);
    assert.isFalse(ompSubagentControls("1.3.0").revive);
    assert.isTrue(ompSubagentControls("1.4.0").revive);
    assert.isTrue(ompSubagentControls("2.0.0").revive);
    assert.deepStrictEqual(ompSubagentControls("1.0.0"), {
      transcript: true,
      steer: true,
      kill: true,
      revive: false,
    });
    assert.isTrue(contractAtLeast("1.10.0", "1.4.0"));
  });
});

describe("OMP subagent transcripts", () => {
  it("reduces messages to viewer entries", () => {
    const page = ompTranscriptPage({
      sessionFile: "/sessions/a/Reader.jsonl",
      fromByte: 0,
      nextByte: 812,
      reset: false,
      entries: [],
      messages: [
        { role: "user", content: "Map the auth flow", timestamp: 0 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "Reading the entry point." },
            { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/auth.ts" } },
          ],
          timestamp: 0,
        } as never,
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "read",
          content: [{ type: "text", text: "export function login() {}" }],
          isError: false,
          timestamp: 0,
        },
      ],
    });

    assert.deepStrictEqual(page, {
      fromByte: 0,
      nextByte: 812,
      reset: false,
      entries: [
        { role: "user", text: "Map the auth flow" },
        { role: "assistant", text: "Reading the entry point." },
        { role: "tool", toolName: "read", text: '{"path":"src/auth.ts"}' },
        { role: "tool", toolName: "read", text: "export function login() {}" },
      ],
    });
  });

  it("keeps tool errors and summaries", () => {
    assert.deepStrictEqual(
      ompTranscriptEntries({
        role: "toolResult",
        toolName: "bash",
        content: [{ type: "text", text: "exit 1" }],
        isError: true,
      }),
      [{ role: "tool", toolName: "bash", text: "exit 1", isError: true }],
    );
    assert.deepStrictEqual(
      ompTranscriptEntries({ role: "compactionSummary", summary: "Earlier work" }),
      [{ role: "system", text: "Earlier work" }],
    );
    assert.deepStrictEqual(ompTranscriptEntries({ role: "custom", content: "" }), []);
  });
});
