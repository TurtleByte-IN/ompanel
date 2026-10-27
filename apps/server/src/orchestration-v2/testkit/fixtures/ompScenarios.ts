// @effect-diagnostics nodeBuiltinImport:off - checks run in the recorder too, outside vitest.
import * as NodeAssert from "node:assert/strict";

import type { AgentMessage, RpcServerFrame } from "@t3tools/provider-omp/rpc";
import * as Effect from "effect/Effect";

import type { OmpReplayScenario, OmpScenarioSession } from "../../Adapters/OmpAdapterV2.testkit.ts";

/**
 * OMP transport scenarios, recorded from the pinned fork with a scripted local model that answers
 * every turn with "pong" and stalls on a turn containing "slow". Each scenario asserts what it
 * observed, live while recording and again on every replay. Transcripts live in
 * `omp_<name>/omp_transcript.ndjson` next to this file.
 */

const ofType = <T extends RpcServerFrame["type"]>(frames: ReadonlyArray<RpcServerFrame>, type: T) =>
  frames.filter((frame): frame is Extract<RpcServerFrame, { type: T }> => frame.type === type);

/** A `message` entry's message; `get_entries` types entries as raw records. */
const entryMessage = (entry: Record<string, unknown>): AgentMessage | undefined => {
  const message = entry["message"];
  // OMP's `SessionMessageEntry.message` is an `AgentMessage`.
  return entry["type"] === "message" && typeof message === "object" && message !== null
    ? (message as AgentMessage)
    : undefined;
};
const isUserEntry = (entry: Record<string, unknown>) => entryMessage(entry)?.role === "user";
const userText = (entry: Record<string, unknown>) => {
  const message = entryMessage(entry);
  if (message?.role !== "user") return undefined;
  return typeof message.content === "string"
    ? message.content
    : message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
};

export const OMP_REPLAY_SCENARIOS: ReadonlyArray<OmpReplayScenario> = [
  {
    name: "context",
    description: "`/context` prints the context report as command_output, with no model turn.",
    run: Effect.fn("OmpReplay.context")(function* (session: OmpScenarioSession) {
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
    run: Effect.fn("OmpReplay.rename")(function* (session: OmpScenarioSession) {
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
    run: Effect.fn("OmpReplay.fresh")(function* (session: OmpScenarioSession) {
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
    run: Effect.fn("OmpReplay.compact")(function* (session: OmpScenarioSession) {
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
    name: "handoff",
    description:
      "`/handoff` after three turns acks `{ agentInvoked: false }`, then writes the handoff " +
      "document through the model as a compaction entry on the same session (no new session " +
      "id or file, no compaction frames) and reports it in one closing command_output.",
    run: Effect.fn("OmpReplay.handoff")(function* (session: OmpScenarioSession) {
      // Long enough that the kept tail (`compaction.keepRecentTokens`) leaves it to summarise.
      yield* session.prompt(`first question: ${"tell me about the weather. ".repeat(40)}`);
      yield* session.prompt("second question");
      yield* session.prompt("third question");
      const before = yield* session.request("get_state", undefined);
      const { agentInvoked, from } = yield* session.prompt("/handoff focus on the weather");
      NodeAssert.equal(agentInvoked, false, "/handoff started a model turn");
      const output = yield* session.waitFor(
        "command_output",
        (frame) => frame.type === "command_output",
        from,
      );
      NodeAssert.equal(
        output.type === "command_output" && output.text,
        "Context handed off and compacted in place.",
      );
      const after = yield* session.request("get_state", undefined);
      NodeAssert.equal(after.sessionId, before.sessionId, "/handoff changed the session id");
      NodeAssert.equal(after.sessionFile, before.sessionFile, "/handoff changed the file");
      NodeAssert.deepEqual(
        session.frames
          .slice(from)
          .map((frame) => frame.type)
          .filter((type) => type.includes("compaction") || type === "session_info_update"),
        [],
        "/handoff sent compaction or session frames",
      );
      const { entries } = yield* session.request("get_entries", {});
      NodeAssert.ok(
        entries.some((entry) => entry["type"] === "compaction"),
        "/handoff wrote no compaction entry",
      );
    }),
  },
  {
    name: "security",
    description:
      "`/security` (list stored scans) answers in command_output with no model turn; with " +
      "OMP's default `security.enabled: false` it says security is disabled.",
    run: Effect.fn("OmpReplay.security")(function* (session: OmpScenarioSession) {
      const { agentInvoked, from } = yield* session.prompt("/security");
      NodeAssert.equal(agentInvoked, false, "/security started a model turn");
      const output = yield* session.waitFor(
        "command_output",
        (frame) => frame.type === "command_output",
        from,
      );
      NodeAssert.ok(
        output.type === "command_output" && output.text.includes("Security is disabled"),
        output.type === "command_output" ? output.text : "no output",
      );
    }),
  },
  {
    name: "cancel",
    description: "`abort` while the model streams ends the turn as aborted.",
    run: Effect.fn("OmpReplay.cancel")(function* (session: OmpScenarioSession) {
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
    run: Effect.fn("OmpReplay.branch")(function* (session: OmpScenarioSession) {
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
    name: "rewind",
    description:
      "`branch` to the second user message moves the session onto a new file that keeps the " +
      "first exchange; `get_branch_messages` and `get_tree` show only the kept path, and the " +
      "next prompt continues from there.",
    run: Effect.fn("OmpReplay.rewind")(function* (session: OmpScenarioSession) {
      yield* session.prompt("first question");
      yield* session.prompt("second question");
      const before = yield* session.request("get_state", undefined);
      const listed = yield* session.request("get_entries", {});
      const users = listed.entries.filter(isUserEntry);
      NodeAssert.equal(users.length, 2, "two prompts are not two user entries");
      const second = users[1]!;
      const { messages } = yield* session.request("get_branch_messages", undefined);
      NodeAssert.deepEqual(
        messages.map((message) => message.entryId),
        users.map((entry) => entry["id"]),
      );
      const from = session.frames.length;
      const result = yield* session.request("branch", { entryId: String(second["id"]) });
      NodeAssert.equal(result.cancelled, false);
      NodeAssert.equal(result.text, "second question");
      const after = yield* session.request("get_state", undefined);
      NodeAssert.notEqual(after.sessionId, before.sessionId, "branch kept the session id");
      NodeAssert.ok(after.sessionFile !== undefined && after.sessionFile !== before.sessionFile);
      NodeAssert.equal(after.isStreaming, false);
      NodeAssert.equal(
        ofType(session.frames.slice(from), "session_info_update").length,
        0,
        "branch announced the new session; hosts read it from get_state",
      );
      const kept = yield* session.request("get_branch_messages", undefined);
      NodeAssert.deepEqual(
        kept.messages.map((message) => message.entryId),
        [users[0]!["id"]],
      );
      const tree = yield* session.request("get_tree", undefined);
      NodeAssert.equal(tree.tree.length, 1, "a branched session has one root");
      NodeAssert.ok(typeof tree.leafId === "string");
      yield* session.prompt("third question");
      const history = yield* session.request("get_messages", undefined);
      NodeAssert.deepEqual(
        history.messages.map((message) => message.role),
        ["user", "assistant", "user", "assistant"],
      );
      const since = yield* session.request("get_entries", { since: tree.leafId! });
      NodeAssert.deepEqual(
        since.entries.filter(isUserEntry).map(userText),
        ["third question"],
        "get_entries since the old leaf lists only the new turn",
      );
    }),
  },
  {
    name: "fork",
    description:
      "`fork {entryId}` at the first answer writes a new session file holding the first " +
      "exchange and moves the process onto it; the source file is unchanged.",
    run: Effect.fn("OmpReplay.fork")(function* (session: OmpScenarioSession) {
      yield* session.prompt("first question");
      yield* session.prompt("second question");
      const source = yield* session.request("get_state", undefined);
      const listed = yield* session.request("get_entries", {});
      const firstAnswer = listed.entries.find((entry) => entryMessage(entry)?.role === "assistant");
      NodeAssert.ok(firstAnswer !== undefined, "no assistant entry");
      const { cancelled } = yield* session.request("fork", {
        entryId: String(firstAnswer["id"]),
      });
      NodeAssert.equal(cancelled, false);
      const forked = yield* session.request("get_state", undefined);
      NodeAssert.notEqual(forked.sessionId, source.sessionId);
      NodeAssert.ok(forked.sessionFile !== undefined && forked.sessionFile !== source.sessionFile);
      const kept = yield* session.request("get_branch_messages", undefined);
      NodeAssert.deepEqual(
        kept.messages.map((message) => message.text),
        ["first question"],
      );
      yield* session.request("switch_session", { sessionPath: source.sessionFile! });
      const back = yield* session.request("get_branch_messages", undefined);
      NodeAssert.deepEqual(
        back.messages.map((message) => message.text),
        ["first question", "second question"],
      );
    }),
  },
  {
    name: "fork_busy",
    description:
      "`fork` while the model streams is refused with `session_busy`; `get_state` reports " +
      "`isStreaming` meanwhile.",
    run: Effect.fn("OmpReplay.fork_busy")(function* (session: OmpScenarioSession) {
      yield* session.prompt("first question");
      const from = session.frames.length;
      yield* session.request("prompt", { message: "slow answer please" });
      yield* session.waitFor("streaming", (frame) => frame.type === "message_update", from);
      const state = yield* session.request("get_state", undefined);
      NodeAssert.equal(state.isStreaming, true);
      const refused = yield* Effect.result(session.request("fork", {}));
      NodeAssert.ok(
        refused._tag === "Failure" &&
          refused.failure._tag === "OmpRpcCommandError" &&
          refused.failure.code === "session_busy",
        "fork while streaming was not refused with session_busy",
      );
      yield* session.request("abort", undefined);
      yield* session.waitFor("prompt_result", (frame) => frame.type === "prompt_result", from);
    }),
  },
  {
    name: "switch_session",
    description: "`switch_session` back after `new_session` restores the session id and file.",
    run: Effect.fn("OmpReplay.switch_session")(function* (session: OmpScenarioSession) {
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
  {
    name: "messages_page",
    description:
      "`get_messages_page` pages the session oldest first and follows `nextCursor` to the end.",
    run: Effect.fn("OmpReplay.messages_page")(function* (session: OmpScenarioSession) {
      yield* session.prompt("first");
      yield* session.prompt("second");
      const first = yield* session.request("get_messages_page", { limit: 3 });
      NodeAssert.equal(first.totalMessages, 4, "two turns are not four messages");
      NodeAssert.equal(first.messages.length, 3);
      NodeAssert.ok(first.nextCursor !== undefined, "a partial page has no nextCursor");
      const second = yield* session.request("get_messages_page", {
        limit: 3,
        cursor: first.nextCursor,
      });
      NodeAssert.equal(second.messages.length, 1);
      NodeAssert.equal(second.nextCursor, undefined, "the last page has a nextCursor");
      const roles = [...first.messages, ...second.messages].map((message) => message.role);
      NodeAssert.deepEqual(roles, ["user", "assistant", "user", "assistant"]);
      const firstUser = first.messages[0];
      NodeAssert.ok(firstUser?.role === "user");
      const text =
        typeof firstUser.content === "string"
          ? firstUser.content
          : firstUser.content.flatMap((block) => (block.type === "text" ? [block.text] : []));
      NodeAssert.deepEqual([text].flat(), ["first"]);
    }),
  },
];

export const ompTranscriptUrl = (scenario: string) =>
  new URL(`./omp_${scenario}/omp_transcript.ndjson`, import.meta.url);
