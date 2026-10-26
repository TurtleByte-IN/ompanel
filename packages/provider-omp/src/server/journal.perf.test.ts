// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OMP_PROVIDER_CAPABILITIES } from "./adapter.ts";
import {
  OmpJournaledMapper,
  OmpJournalRecorder,
  ompJournalOpenEntry,
  parseOmpJournal,
  replayOmpJournal,
  type OmpJournalEntry,
} from "./journal.ts";
import { OMP_PROVIDER } from "./mapper.ts";
import { fakeOmpFrames } from "./testing/fakeOmp.ts";
import {
  JOURNAL_INSTANCE_ID,
  JOURNAL_THREAD_ID,
  journalTurnInput,
  ompThreadView,
} from "./testing/journalFixtures.ts";

/** At least this many frames, the session size PRD §9 sets the budget for. */
const FRAMES = 10_000;
/** PRD §9: replaying a 10k-frame session takes under 200 ms. */
const BUDGET_MS = 200;
const RUNS = 5;
/** Each recorded turn below sends 97 frames. */
const TURNS = Math.ceil(FRAMES / 97);

/** A recorded session of `FRAMES` frames: streamed answers, tool cards, flushes, usage. */
const recordSession = () => {
  const entries: Array<OmpJournalEntry> = [];
  const recorder = new OmpJournalRecorder((entry) => entries.push(entry));
  let clock = 1_700_000_000_000;
  const tick = () => DateTime.makeUnsafe((clock += 3));
  const providerSession = {
    id: ProviderSessionId.make("session-bench"),
    driver: OMP_PROVIDER,
    providerInstanceId: JOURNAL_INSTANCE_ID,
    status: "ready" as const,
    cwd: "/work",
    model: "default",
    capabilities: OMP_PROVIDER_CAPABILITIES,
    createdAt: tick(),
    updatedAt: tick(),
    lastError: null,
  };
  recorder.record(
    ompJournalOpenEntry({
      threadId: JOURNAL_THREAD_ID,
      instanceId: JOURNAL_INSTANCE_ID,
      contractVersion: "1.6.0",
      providerSession,
      now: tick(),
    }),
  );
  const mapper = new OmpJournaledMapper(
    { instanceId: JOURNAL_INSTANCE_ID, providerSession },
    recorder,
  );
  const live: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  const bound = mapper.bindThread(
    { threadId: JOURNAL_THREAD_ID, state: { sessionId: "bench-session" } },
    tick(),
  );
  live.push(...bound.events);
  let frames = 0;
  const frame = (value: Record<string, unknown> & { readonly type: string }) => {
    frames += 1;
    const result = mapper.handleFrame(value, tick());
    live.push(...result.events);
    return result;
  };
  for (let ordinal = 1; ordinal <= TURNS; ordinal += 1) {
    live.push(...mapper.startTurn(journalTurnInput(bound.providerThread, ordinal, tick()), tick()));
    frame({ type: "response", command: "prompt", id: `p${ordinal}`, success: true, data: {} });
    frame({ type: "agent_start" });
    frame({ type: "message_start", messageId: `m${ordinal}`, message: { role: "assistant" } });
    const words: Array<string> = [];
    for (let index = 0; index < 80; index += 1) {
      const delta = `word${index} `;
      words.push(delta);
      // OMP sends the whole partial message with every delta.
      const partial = { role: "assistant", content: [{ type: "text", text: words.join("") }] };
      frame({
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
      });
      if (index % 10 === 9) live.push(...mapper.flushStreaming(tick()));
    }
    frame({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: words.join("") },
    });
    frame({
      type: "message_end",
      message: { role: "assistant", usage: fakeOmpFrames.usage, stopReason: "toolUse" },
    });
    const toolCallId = `call-${ordinal}`;
    frame({ type: "tool_execution_start", toolCallId, toolName: "bash", args: { command: "ls" } });
    for (let index = 0; index < 8; index += 1) {
      // 5 s apart, so the journal keeps every one (it thins faster updates).
      clock += 5_000;
      frame({
        type: "tool_execution_update",
        toolCallId,
        toolName: "bash",
        partialResult: { content: [{ type: "text", text: `line ${index}` }] },
      });
    }
    frame({
      type: "tool_execution_end",
      toolCallId,
      toolName: "bash",
      result: { content: [{ type: "text", text: "a.txt" }] },
      isError: false,
    });
    frame({ type: "agent_end", messages: [] });
    const settled = frame({
      type: "prompt_result",
      id: `p${ordinal}`,
      status: "completed",
      agentInvoked: true,
      sessionSettled: true,
    }).settled;
    if (settled !== null) live.push(...mapper.finalizeTurn(settled, {}, tick()));
  }
  return { entries, live, frames };
};

/**
 * PRD §9 budget, from reading the file to the last event. A benchmark, so it runs only with
 * `OMP_JOURNAL_BENCH=1`: CI runs it in its own step, alone on the runner (docs/omp/journal.md).
 * The median of five replays is held to the budget, so one GC pause does not fail it.
 */
describe.runIf(process.env.OMP_JOURNAL_BENCH === "1")("OMP journal replay performance", () => {
  it.live(`replays a ${FRAMES}-frame session from disk in under ${BUDGET_MS} ms`, () =>
    Effect.gen(function* () {
      const { entries, live, frames } = recordSession();
      assert.isAtLeast(frames, FRAMES);
      // Every frame is replayed, none thinned away.
      assert.isAtLeast(entries.filter((entry) => entry.k === "frame").length, FRAMES);
      const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-journal-bench-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
      );
      const file = NodePath.join(dir, "journal.ndjson");
      NodeFS.writeFileSync(file, entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      const replayFromDisk = () =>
        replayOmpJournal(parseOmpJournal(NodeFS.readFileSync(file, "utf8")).entries);

      const timings: Array<number> = [];
      for (let run = 0; run < RUNS; run += 1) {
        const started = yield* Clock.currentTimeNanos;
        replayFromDisk();
        timings.push(Number((yield* Clock.currentTimeNanos) - started) / 1e6);
      }
      const median = timings.toSorted((left, right) => left - right)[Math.floor(RUNS / 2)]!;
      const report = `${frames} frames, ${entries.length} lines: ${timings.map((ms) => ms.toFixed(1)).join(", ")} ms`;
      yield* Effect.logInfo(`omp journal replay: ${report}`);
      assert.isBelow(median, BUDGET_MS, report);

      // The timed replay is the real one: it rebuilds what the live session showed.
      const replay = replayFromDisk();
      assert.strictEqual(replay.skipped, 0);
      assert.deepStrictEqual(ompThreadView(replay.events), ompThreadView(live));
    }).pipe(Effect.scoped),
  );
});
