// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { makeOmpAdapter } from "./adapter.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import { ompStateDirs } from "./session.ts";
import { fakeOmpFrames, makeFakeOmpState } from "./testing/fakeOmp.ts";

const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const INSTANCE_ID = ProviderInstanceId.make("omp-work");
const THREAD_ID = ThreadId.make("thread/turn");
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

const EDIT_RESULT = {
  content: [{ type: "text", text: "Updated src/app.ts" }],
  details: { diff: "-1|const x = 1;\n+1|const x = 2;", path: "/work/src/app.ts", op: "update" },
};

posixOnly("OmpAdapter turns", () => {
  it.live("sends a prompt and maps its frames to text, a tool card, usage and a terminal", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const script = state.script({
        commands: {
          get_state: [
            {
              respond: {
                sessionId: "fake-session",
                sessionFile: "/fake/sessions/fake-session.jsonl",
                contextUsage: { tokens: 1_000, contextWindow: 100_000, percent: 1 },
                todoPhases: [],
              },
            },
          ],
          get_session_stats: [
            {
              respond: {
                sessionId: "fake-session",
                userMessages: 1,
                assistantMessages: 1,
                toolCalls: 1,
                toolResults: 1,
                totalMessages: 3,
                tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
                premiumRequests: 0,
                cost: 0.001,
                contextUsage: { tokens: 1_015, contextWindow: 100_000, percent: 1.02 },
              },
            },
          ],
          // JSON has no `undefined`: an absent `respond` would leave the command unanswered.
          set_session_name: [{ respond: null }],
          prompt: fakeOmpFrames.promptTurn({
            text: ["Hel", "lo"],
            thinking: ["Thinking"],
            tool: {
              toolCallId: "call-edit",
              toolName: "edit",
              args: {
                input:
                  "*** Begin Patch\n[src/app.ts#1A2B]\nPUT 1.=1:\n+const x = 2;\n*** End Patch",
              },
              result: EDIT_RESULT,
            },
          }),
        },
      });
      const path = yield* Path.Path;
      const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
      const adapter = yield* makeOmpAdapter({
        instanceId: INSTANCE_ID,
        profile: "",
        environment: state.env(script),
        platform,
        defaultCwd: state.dir,
        resolveBinary: Effect.succeed(state.executable()),
        dirs,
        pidfiles: yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform }),
        expectedContractVersion: "1.0.0",
      });

      const events = yield* Effect.gen(function* () {
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-turn"),
          modelSelection: { instanceId: INSTANCE_ID, model: "default" },
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId: THREAD_ID,
          modelSelection: { instanceId: INSTANCE_ID, model: "default" },
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        const appThread: OrchestrationV2AppThread = {
          createdBy: "user",
          creationSource: "web",
          id: THREAD_ID,
          projectId: "project:omp" as OrchestrationV2AppThread["projectId"],
          title: "Turn thread",
          providerInstanceId: INSTANCE_ID,
          modelSelection: { instanceId: INSTANCE_ID, model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        const runId = RunId.make("run:turn:1");
        yield* session.startTurn({
          appThread,
          threadId: THREAD_ID,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("run-attempt:turn:1"),
          rootNodeId: NodeId.make("node:turn:root"),
          providerThread,
          message: {
            messageId: "message:turn:1" as never,
            text: "Change x to 2",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: INSTANCE_ID, model: "default" },
          runtimePolicy,
        });
        return yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
      }).pipe(Effect.scoped);

      const commands = state.commands().map((command) => command["type"]);
      assert.includeMembers(commands, [
        "get_state",
        "set_session_name",
        "prompt",
        "get_session_stats",
      ]);
      assert.deepInclude(state.commands(), {
        type: "prompt",
        id: state.commands().find((command) => command["type"] === "prompt")?.["id"],
        message: "Change x to 2",
      });

      const items = events.flatMap((event) =>
        event.type === "turn_item.updated" ? [event.turnItem] : [],
      );
      const answer = items.findLast((item) => item.type === "assistant_message");
      assert.strictEqual(answer?.type === "assistant_message" ? answer.text : null, "Hello");
      assert.strictEqual(answer?.status, "completed");
      const reasoning = items.find((item) => item.type === "reasoning");
      assert.strictEqual(reasoning?.type === "reasoning" ? reasoning.text : null, "Thinking");
      const card = items.findLast((item) => item.type === "file_change");
      assert.deepStrictEqual(
        card?.type === "file_change" ? [card.status, card.fileName, card.diffStr] : null,
        ["completed", "/work/src/app.ts", EDIT_RESULT.details.diff],
      );

      const turns = events.flatMap((event) =>
        event.type === "provider_turn.updated" ? [event.providerTurn] : [],
      );
      // Live usage from the assistant message_end, then the context meter from session stats.
      assert.isTrue(
        turns.some(
          (turn) =>
            turn.status === "running" &&
            turn.turnTokenUsage?.usageStatus === "complete" &&
            turn.tokenUsage?.usedTokens === 15,
        ),
      );
      const last = turns.at(-1);
      assert.strictEqual(last?.status, "completed");
      assert.deepStrictEqual(
        [
          last?.tokenUsage?.usedTokens,
          last?.tokenUsage?.maxTokens,
          last?.turnTokenUsage?.inputTokens,
        ],
        [1_015, 100_000, 10],
      );
      const thread = events
        .flatMap((event) =>
          event.type === "provider_thread.updated" ? [event.providerThread] : [],
        )
        .at(-1);
      assert.deepStrictEqual(thread?.contextUsage?.cost, { amount: 0.001, currency: "USD" });
      const terminal = events.at(-1);
      assert.deepStrictEqual(
        terminal?.type === "turn.terminal" ? [terminal.status, terminal.failure] : null,
        ["completed", null],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
