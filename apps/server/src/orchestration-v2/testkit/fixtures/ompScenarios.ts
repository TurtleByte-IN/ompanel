// @effect-diagnostics nodeBuiltinImport:off - checks run in the recorder too, outside vitest.
import * as NodeAssert from "node:assert/strict";

import type { RpcServerFrame } from "@t3tools/provider-omp/rpc";
import * as Effect from "effect/Effect";

import type { OmpReplayScenario } from "../../Adapters/OmpAdapterV2.testkit.ts";

/**
 * OMP transport scenarios, recorded from the pinned fork with a scripted local model that answers
 * every turn with "pong" and stalls on a turn containing "slow". Each scenario asserts what it
 * observed, live while recording and again on every replay. Transcripts live in
 * `omp_<name>/omp_transcript.ndjson` next to this file.
 */

const ofType = <T extends RpcServerFrame["type"]>(frames: ReadonlyArray<RpcServerFrame>, type: T) =>
  frames.filter((frame): frame is Extract<RpcServerFrame, { type: T }> => frame.type === type);

export const OMP_REPLAY_SCENARIOS: ReadonlyArray<OmpReplayScenario> = [
  {
    name: "context",
    description: "`/context` prints the context report as command_output, with no model turn.",
    run: (session) =>
      Effect.gen(function* () {
        const { agentInvoked, from } = yield* session.prompt("/context");
        NodeAssert.equal(agentInvoked, false, "/context started a model turn");
        const output = yield* session.waitFor(
          "command_output",
          (frame) => frame.type === "command_output",
          from,
        );
        NodeAssert.ok(output.type === "command_output" && output.text.length > 0);
      }),
  },
  {
    name: "rename",
    description: "`/rename` reports the new title in session_info_update and get_state.",
    run: (session) =>
      Effect.gen(function* () {
        const from = session.frames.length;
        yield* session.prompt("/rename Replay title");
        const update = yield* session.waitFor(
          "session_info_update",
          (frame) => frame.type === "session_info_update",
          from,
        );
        NodeAssert.equal(update.type === "session_info_update" && update.title, "Replay title");
        const state = yield* session.request("get_state", undefined);
        NodeAssert.equal(state.sessionName, "Replay title");
      }),
  },
  {
    name: "fresh",
    description:
      "`/fresh` after a turn starts a new provider session id. On the pinned tag OMP announces it " +
      "only in command_output (no session_info_update) and closes the prompt as an aborted " +
      "prompt_result, so the host reads the new id from get_state.",
    run: (session) =>
      Effect.gen(function* () {
        yield* session.prompt("hello");
        const before = (yield* session.request("get_state", undefined)).sessionId;
        const from = session.frames.length;
        yield* session.request("prompt", { message: "/fresh" });
        const output = yield* session.waitFor(
          "command_output",
          (frame) => frame.type === "command_output",
          from,
        );
        NodeAssert.ok(output.type === "command_output" && output.text.startsWith("Fresh"));
        const after = (yield* session.request("get_state", undefined)).sessionId;
        NodeAssert.notEqual(after, before, "/fresh kept the session id");
      }),
  },
  {
    name: "compact",
    description: "`/compact` after two turns summarises the session through the model.",
    run: (session) =>
      Effect.gen(function* () {
        // Long enough that the kept tail (`compaction.keepRecentTokens`) leaves it to summarise.
        yield* session.prompt(`first question: ${"tell me about the weather. ".repeat(40)}`);
        yield* session.prompt("second question");
        yield* session.prompt("third question");
        const { agentInvoked, from } = yield* session.prompt("/compact");
        NodeAssert.equal(agentInvoked, false);
        const output = yield* session.waitFor(
          "command_output",
          (frame) => frame.type === "command_output",
          from,
        );
        NodeAssert.ok(
          output.type === "command_output" && !output.text.includes("failed"),
          output.type === "command_output" ? output.text : "no output",
        );
      }),
  },
  {
    name: "cancel",
    description: "`abort` while the model streams ends the turn as aborted.",
    run: (session) =>
      Effect.gen(function* () {
        const from = session.frames.length;
        yield* session.request("prompt", { message: "slow answer please" });
        yield* session.waitFor("streaming", (frame) => frame.type === "message_update", from);
        yield* session.request("abort", undefined);
        const result = yield* session.waitFor(
          "prompt_result",
          (frame) => frame.type === "prompt_result",
          from,
        );
        NodeAssert.equal(result.type === "prompt_result" && result.status, "aborted");
      }),
  },
  {
    name: "branch",
    description: "`branch` to the first user message rewinds the session to before it.",
    run: (session) =>
      Effect.gen(function* () {
        yield* session.prompt("first question");
        yield* session.prompt("second question");
        const { messages } = yield* session.request("get_branch_messages", undefined);
        const first = messages.find((message) => message.text.includes("first question"));
        NodeAssert.ok(first !== undefined, "get_branch_messages has no first question");
        const result = yield* session.request("branch", { entryId: first.entryId });
        NodeAssert.equal(result.cancelled, false);
        NodeAssert.equal(result.text, first.text);
        const after = yield* session.request("get_messages", undefined);
        NodeAssert.equal(after.messages.length, 0, "branch to the first message kept messages");
      }),
  },
  {
    name: "switch_session",
    description: "`switch_session` back after `new_session` restores the session id and file.",
    run: (session) =>
      Effect.gen(function* () {
        yield* session.prompt("hello");
        const first = yield* session.request("get_state", undefined);
        NodeAssert.ok(first.sessionFile !== undefined, "get_state has no sessionFile");
        yield* session.request("new_session", {});
        const fresh = yield* session.request("get_state", undefined);
        NodeAssert.notEqual(fresh.sessionId, first.sessionId, "new_session kept the session id");
        const { cancelled } = yield* session.request("switch_session", {
          sessionPath: first.sessionFile,
        });
        NodeAssert.equal(cancelled, false);
        const switched = yield* session.request("get_state", undefined);
        NodeAssert.equal(switched.sessionId, first.sessionId);
        NodeAssert.equal(switched.sessionFile, first.sessionFile);
      }),
  },
];

export const ompTranscriptUrl = (scenario: string) =>
  new URL(`./omp_${scenario}/omp_transcript.ndjson`, import.meta.url);
