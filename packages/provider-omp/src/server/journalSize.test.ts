// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OMP_PROVIDER_CAPABILITIES } from "./adapter.ts";
import {
  makeOmpJournalWriter,
  OmpDetachedRun,
  OmpJournaledMapper,
  OmpJournalRecorder,
  ompJournalDetachedEntry,
  ompJournalDetachedTail,
  ompJournalOpenEntry,
  parseOmpJournal,
  readOmpJournalTail,
  replayOmpJournal,
  type OmpJournalEntry,
} from "./journal.ts";
import { OMP_PROVIDER } from "./mapper.ts";
import {
  JOURNAL_INSTANCE_ID,
  JOURNAL_THREAD_ID,
  journalTurnInput,
  ompThreadView,
} from "./testing/journalFixtures.ts";

const EPOCH = 1_700_000_000_000;
const at = (ms: number) => DateTime.makeUnsafe(EPOCH + ms);

const providerSession = (now: DateTime.Utc) => ({
  id: ProviderSessionId.make("session-journal-size"),
  driver: OMP_PROVIDER,
  providerInstanceId: JOURNAL_INSTANCE_ID,
  status: "ready" as const,
  cwd: "/work",
  model: "default",
  capabilities: OMP_PROVIDER_CAPABILITIES,
  createdAt: now,
  updatedAt: now,
  lastError: null,
});

const openEntry = (ms: number) =>
  ompJournalOpenEntry({
    threadId: JOURNAL_THREAD_ID,
    instanceId: JOURNAL_INSTANCE_ID,
    contractVersion: "1.6.0",
    providerSession: providerSession(at(ms)),
    now: at(ms),
  });

const line = (entry: OmpJournalEntry) => `${JSON.stringify(entry)}\n`;

const scratchDir = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-journal-size-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
);

/** OMP's bash output so far, as a tool update carries it: all of it, capped at 50 KiB. */
const cumulativeOutput = (polls: number) =>
  "x".repeat(99).concat("\n").repeat(Math.min(polls, 512));

describe("OMP journal size", () => {
  it("keeps one update per running tool every 5 s, its last one, and none outside a turn", () => {
    const entries: Array<OmpJournalEntry> = [];
    const recorder = new OmpJournalRecorder((entry) => entries.push(entry));
    recorder.record(openEntry(0));
    const mapper = new OmpJournaledMapper(
      { instanceId: JOURNAL_INSTANCE_ID, providerSession: providerSession(at(0)) },
      recorder,
    );
    const live: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
    const bound = mapper.bindThread(
      { threadId: JOURNAL_THREAD_ID, state: { sessionId: "size-session" } },
      at(0),
    );
    live.push(...bound.events);
    live.push(...mapper.startTurn(journalTurnInput(bound.providerThread, 1, at(0)), at(0)));
    const frame = (value: Record<string, unknown> & { readonly type: string }, ms: number) =>
      live.push(...mapper.handleFrame(value, at(ms)).events);
    frame({ type: "tool_execution_start", toolCallId: "bash", toolName: "bash", args: {} }, 1);
    frame({ type: "tool_execution_start", toolCallId: "fetch", toolName: "fetch", args: {} }, 1);
    // A command streaming for 1,000 s, polled every 250 ms, next to a tool reporting progress.
    const POLLS = 4_000;
    for (let poll = 1; poll <= POLLS; poll += 1) {
      const ms = 10 + poll * 250;
      frame(
        {
          type: "tool_execution_update",
          toolCallId: "bash",
          toolName: "bash",
          args: { command: "make" },
          partialResult: { content: [{ type: "text", text: cumulativeOutput(poll) }] },
        },
        ms,
      );
      if (poll % 4 === 0) {
        frame(
          {
            type: "tool_execution_update",
            toolCallId: "fetch",
            toolName: "fetch",
            partialResult: { content: [{ type: "text", text: `fetched ${poll}` }] },
          },
          ms,
        );
      }
    }
    const endMs = 20 + POLLS * 250;
    frame(
      {
        type: "tool_execution_end",
        toolCallId: "bash",
        toolName: "bash",
        result: { content: [{ type: "text", text: cumulativeOutput(POLLS) }] },
        isError: false,
      },
      endMs,
    );
    live.push(...mapper.finalizeTurn({ status: "completed" }, {}, at(endMs + 1)));
    const inTurn = entries.length;

    // A background job parked after the turn keeps updating its tool for hours.
    for (let poll = 1; poll <= 1_000; poll += 1) {
      frame(
        {
          type: "tool_execution_update",
          toolCallId: "job",
          toolName: "bash",
          partialResult: { content: [{ type: "text", text: cumulativeOutput(poll) }] },
        },
        endMs + poll * 250,
      );
    }
    assert.strictEqual(entries.length, inTurn, "frames outside a turn are not journaled");

    const updates = (toolCallId: string) =>
      entries.filter(
        (entry) =>
          entry.k === "frame" &&
          entry.frame.type === "tool_execution_update" &&
          entry.frame["toolCallId"] === toolCallId,
      );
    // One every 5 s of 1,000 s, plus the held last one.
    assert.isAtMost(updates("bash").length, 202);
    assert.isAtMost(updates("fetch").length, 202);
    // The fetch never ended: its last update is written before the turn ends.
    const lastFetch = updates("fetch").at(-1);
    assert.include(JSON.stringify(lastFetch), `fetched ${POLLS}`);
    const bytes = entries.reduce((total, entry) => total + line(entry).length, 0);
    // Every update in full would be about 190 MB.
    assert.isBelow(bytes, 12 * 1024 * 1024);

    const replay = replayOmpJournal(entries);
    assert.strictEqual(replay.skipped, 0);
    assert.deepStrictEqual(ompThreadView(replay.events), ompThreadView(live));
  });

  it("holds only the latest update of each tool while a run waits for its turn", () => {
    const run = new OmpDetachedRun();
    const tool = (type: string, extra: Record<string, unknown> = {}) =>
      ({ type, toolCallId: "job", toolName: "bash", ...extra }) as { readonly type: string };
    run.push({ type: "agent_start" });
    run.push(tool("tool_execution_start"));
    for (let poll = 1; poll <= 1_000; poll += 1) {
      run.push(
        tool("tool_execution_update", {
          partialResult: { content: [{ type: "text", text: `poll ${poll}` }] },
        }),
      );
    }
    run.push(tool("tool_execution_end"));
    const { frames } = run.take();
    assert.deepStrictEqual(
      frames.map((frame) => frame.type),
      ["agent_start", "tool_execution_start", "tool_execution_update", "tool_execution_end"],
    );
    assert.include(JSON.stringify(frames[2]), "poll 1000");
  });

  it.live("rotates while a process writes past the cap; the new file starts at its segment", () =>
    Effect.gen(function* () {
      const dir = yield* scratchDir;
      const file = NodePath.join(dir, "journal.ndjson");
      yield* Effect.gen(function* () {
        const writer = yield* makeOmpJournalWriter(file, { rotateBytes: 4_096 });
        writer.record(openEntry(0));
        for (let index = 0; index < 200; index += 1) {
          writer.record(
            ompJournalDetachedEntry(
              { type: "notice", message: `line ${index}` } as never,
              at(index),
            ),
          );
          if (index % 10 === 9) yield* writer.flush;
        }
      }).pipe(Effect.scoped);

      const current = NodeFS.readFileSync(file, "utf8");
      assert.isBelow(current.length, 4_096 + 2_048);
      assert.isTrue(NodeFS.existsSync(NodePath.join(dir, "journal.1.ndjson")));
      assert.isTrue(current.startsWith('{"k":"open"'));
      const tail = yield* readOmpJournalTail(file);
      assert.strictEqual(tail.entries[0]?.k, "open");
      assert.include(JSON.stringify(ompJournalDetachedTail(tail.entries).at(-1)), "line 199");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("ends a torn last line, so it cannot swallow the next process's first line", () =>
    Effect.gen(function* () {
      const dir = yield* scratchDir;
      const file = NodePath.join(dir, "journal.ndjson");
      // The previous process held a run and was killed mid-write.
      NodeFS.writeFileSync(
        file,
        line(openEntry(0)) +
          line(ompJournalDetachedEntry({ type: "agent_start" }, at(1))) +
          '{"k":"detached","at":2,"frame":{"ty',
      );
      yield* Effect.gen(function* () {
        const writer = yield* makeOmpJournalWriter(file);
        writer.record(openEntry(10));
        writer.record(ompJournalDetachedEntry({ type: "notice" }, at(11)));
      }).pipe(Effect.scoped);

      const all = parseOmpJournal(NodeFS.readFileSync(file, "utf8"));
      assert.strictEqual(all.skipped, 1);
      assert.strictEqual(all.entries.filter((entry) => entry.k === "open").length, 2);
      const tail = yield* readOmpJournalTail(file);
      assert.deepStrictEqual(
        tail.entries.map((entry) => [entry.k, "at" in entry ? entry.at : null]),
        [
          ["open", EPOCH + 10],
          ["detached", EPOCH + 11],
        ],
      );
      assert.deepStrictEqual(ompJournalDetachedTail(tail.entries), [{ type: "notice" }]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("reads only the last segment, found back from the end across 1 MiB chunks", () =>
    Effect.gen(function* () {
      const dir = yield* scratchDir;
      const file = NodePath.join(dir, "journal.ndjson");
      const filler = line(
        ompJournalDetachedEntry({ type: "notice", message: "f".repeat(1_000) } as never, at(1)),
      );
      const head = line(openEntry(0)) + filler.repeat(3_000);
      // The last segment is exactly 1 MiB, so its `open` line starts on a chunk boundary.
      const open = line(openEntry(20));
      const entry = line(ompJournalDetachedEntry({ type: "agent_start" }, at(21)));
      const padding = 1024 * 1024 - open.length - entry.length;
      const padded = line(
        ompJournalDetachedEntry({ type: "notice", message: "" } as never, at(22)),
      );
      const last = line(
        ompJournalDetachedEntry(
          { type: "notice", message: "p".repeat(padding - padded.length) } as never,
          at(22),
        ),
      );
      const segment = open + entry + last;
      assert.strictEqual(Buffer.byteLength(segment), 1024 * 1024);
      NodeFS.writeFileSync(file, head + segment);

      const tail = yield* readOmpJournalTail(file);
      assert.strictEqual(tail.skipped, 0);
      assert.deepStrictEqual(
        tail.entries.map((parsed) => parsed.k),
        ["open", "detached", "detached"],
      );
      assert.strictEqual(tail.entries[0]?.k === "open" ? tail.entries[0].at : null, EPOCH + 20);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
