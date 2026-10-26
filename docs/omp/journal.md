# The OMP frame journal

Every OMP thread keeps a journal of what its sessions sent and what the
adapter did with it (FR-7). Replaying the journal rebuilds the thread exactly
as a client watching it live saw it, and a run OMP starts while no turn is
attached waits in the journal until a turn takes it. The code is
`packages/provider-omp/src/server/journal.ts`; the adapter (`adapter.ts`)
writes it.

## Where it is

```
<stateDir>/omp/threads/<thread id>/journal.ndjson
```

Next to the thread's `session.json` ([sessions.md](sessions.md)), owner-only
(directory `0700`, file `0600`): it holds the conversation, the same content as
the OMP session file. A thread is one OMP session in Ompanel, so this is the
session's journal; entries carry the session id changes (`/fresh`, rewind).

Each process that runs the thread appends one segment, which starts with an
`open` line. Lines reach the file in batches every 100 ms and when the session
closes; a crash loses at most the last batch. A crash mid-write can leave a torn
last line: the next process ends it with a newline before writing, so its own
`open` line stays whole.

## How big it gets

- A journal over 32 MiB moves to `journal.1.ndjson` (replacing the one before),
  when a process opens it and while a process writes it. The new file starts
  with the writing process's `open` line. A thread's journal therefore stays
  under about 64 MiB on disk.
- A replay from a file that rotated mid-process starts from the rotation: the
  turn in progress then is missing its start, and its lines are skipped.
- Opening a thread reads the last segment only, back from the end of the file
  in 1 MiB chunks, never the whole file.
- Frames that arrive outside a turn are not written, except
  `session_info_update` (the only one that changes anything there). A parked
  background job keeps updating its tool for hours after the turn; none of that
  reaches the journal, unless the frames belong to a run OMP started on its own
  (see Background runs).
- A running tool's `tool_execution_update` carries all its output so far, and
  bash sends one every 250 ms. The journal keeps one update per tool call every
  5 s, and always the last one, written before the call's end or the turn's end.
  The tool card then ends as it did live; only superseded snapshots, and the
  live-only output deltas computed from them, are not replayed. A run held for
  a turn keeps only the latest update of each tool, in memory and on disk.

## What a line holds

One JSON object per line, `k` its kind, `at` the epoch milliseconds the live
session used as "now":

| `k`                                                         | Recorded when                                                                       |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `open`                                                      | A process starts: thread, instance, RPC contract version, provider session.         |
| `bind`                                                      | The thread binds to its OMP session (`get_state` and the existing provider thread). |
| `turn`                                                      | A turn starts (the whole turn input, schema-encoded).                               |
| `frame`                                                     | A frame goes to the mapper ([frames.md](frames.md)).                                |
| `subagent`                                                  | A `subagent_lifecycle` / `subagent_progress` frame ([subagents.md](subagents.md)).  |
| `place`, `dialog`, `resolve`, `expire`, `close`, `closeAll` | A dialog card is placed, opened, answered, timed out or closed.                     |
| `flush`                                                     | Held streaming text is sent (every 50 ms while text streams).                       |
| `finalize`                                                  | A turn ends, with what `get_state` / `get_session_stats` returned.                  |
| `adopt`, `status`, `restart`                                | A rewind moves the session, the session status changes, settings need a restart.    |
| `events`                                                    | Events made outside the mapper (an imported session's history).                     |
| `detached`                                                  | A frame of a run no turn holds (see Background runs).                               |

Frames are kept as the mapping reads them. A `message_update` carries the whole
partial message on every delta; the journal keeps the delta and the one content
block's type. `message_end` keeps the message's role and usage (an advisor note
stays whole); `agent_end` how its last assistant message stopped;
`message_start` its role and id; `agent_start`, `turn_start`, `turn_end` only
their type. Every other frame, including types this build does not know, is
kept as it came. Frames the host-tool bridge answers (`host_tool_call`, ...)
are not journaled: they change nothing a client shows.

## Replay

`replayOmpJournal(entries)` feeds each segment through a fresh mapper,
subagent tracker and dialog set, in order, and returns the events. Every input
that changes those objects is a line, and every output depends only on the
inputs and the recorded times, so the replay rebuilds the thread view the live
sessions left: every turn, message, item, card and request as it last was. It
emits the live events in order, less those of thinned tool updates. Unknown
frame types map to nothing, as they did live. `parseOmpJournal` skips lines
that are not JSON or not a known kind (a torn last line, a newer build's
kinds); the replay skips entries it cannot decode or apply. Neither ever fails
on them.

T3's own tabs reattach from the server: the orchestration event store keeps
every event the server ingested, and a client switching to a thread resumes
from its last sequence. The journal holds what that store never sees: the
adapter's own inputs, and runs that arrived when no run was listening.

## Background runs

OMP reports a prompt done when the agent yields, but a background job (an
async task, a delivery) can wake the session later: `prompt_result` then says
`sessionSettled: false`, and OMP starts a run of its own (`agent_start` ...
`agent_end` with `yielded`), then sends `session_settled`. T3 listens to a
session only while one of its runs is active, so such a run used to be dropped,
answer and usage included (ompanel#41).

Now:

1. A run that starts with no turn attached is held, frame by frame, as
   `detached` lines.
2. The adapter asks T3 for a continuation (`ProviderContinuationRequests`,
   `adapter_buffered`): T3 queues a "Background task completed." message from the
   agent, and runs it as a turn.
3. That turn sends no prompt. It replays the held frames into itself (recorded
   again as `frame` lines) and ends at the run's yield, replayed or still to
   come, with the outcome of its last assistant message. Then it reads
   `get_state` and `get_session_stats` like any turn.
4. If the user starts a turn first, that turn takes the held frames and sends
   its prompt; OMP queues the prompt into the run. The continuation T3 was asked
   for is then no longer current and is not dispatched.

While a background job can still wake the session, or a run waits for its turn,
the session reports pending background work, so T3 does not release it as idle
(which would kill the job with the process).

## Reattach after a restart

When a thread's process stops while a run waits (server restart, idle release,
settings restart), the run stays in the journal. The next process for the
thread reads the last segment, takes the `detached` lines after its last turn,
records them in its own segment, and asks for a continuation once the thread is
bound. That turn replays the run; a run that never reached its yield ends
interrupted, since the process that ran it is gone.

## Performance

PRD §9: replaying a 10k-frame session takes under 200 ms. The benchmark,
`journal.perf.test.ts`, records a session of 10,088 frames (104 turns, each a
streamed answer of 80 deltas, a tool call with 8 updates 5 s apart so none is
thinned, flushes and usage; 11,130 lines, 2.1 MB), writes it to disk, and holds
the median of five replays,
from reading the file to the last event, to 200 ms. It also checks the replay
reproduces the live thread view.

It is a wall-clock benchmark, so it runs only with `OMP_JOURNAL_BENCH=1`
(`OMP_JOURNAL_BENCH=1 vp test run --config ../../vite.config.ts
src/server/journal.perf.test.ts` in `packages/provider-omp`). CI runs it in its
own step of the `Test` job, after the parallel suites, so their load does not
decide it; the step logs the five times.

| Machine                           | Five replays (ms)            | Median | Margin to 200 ms |
| --------------------------------- | ---------------------------- | ------ | ---------------- |
| GitHub `ubuntu-24.04` runner (CI) | 30.7, 31.1, 24.6, 22.7, 24.3 | 24.6   | about 8×         |
| Same runner type, a slower CI run | 55.7, 66.1, 48.3, 45.0, 48.4 | 48.4   | about 4×         |
| Apple M5 Pro, Node 26.12.1        | 16.9, 16.6, 16.2, 15.1, 15.4 | 16.2   | about 12×        |

Runner speed varies between CI runs by about 2×, and the first replay in a
process is the slowest (66 ms in the slower run, 17 to 42 ms locally). Even the
slowest single replay seen stays 3× under the budget.
