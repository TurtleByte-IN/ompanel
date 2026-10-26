# OMP threads and sessions

Every OMP thread in Ompanel is one OMP session file, the same file `omp` in a
terminal writes and lists. A conversation started in Ompanel shows up in
`omp --resume`, and a session started in a terminal can be imported as a
thread. The code is in `packages/provider-omp/src/server/` (`ompSessions.ts`,
`sessionBinding.ts`, `sessionHistory.ts`, and the adapter's `openSession` and
`bindThread`).

## Where OMP keeps sessions (pinned fork)

```
<sessions dir>/<bucket>/<timestamp>_<session id>.jsonl
```

- One bucket per working directory (`-work-app` for `~/work/app`,
  `-tmp-…` under the temp root, `--<path>--` elsewhere). Ompanel never computes
  bucket names: it finds files by the session id in their name.
- `<sessions dir>` is `<agent dir>/sessions`. The agent dir is
  `PI_CODING_AGENT_DIR`, else `~/.omp/agent`; with a profile it is
  `~/.omp/profiles/<profile>/agent` and `PI_CODING_AGENT_DIR` is ignored. The
  profile is the instance's `--profile`, else `OMP_PROFILE`, else `PI_PROFILE`.
  `PI_CONFIG_DIR` renames `.omp`. On Linux and macOS, once
  `$XDG_DATA_HOME/omp` (or `$XDG_DATA_HOME/omp/profiles/<profile>`) exists, the
  sessions dir is `sessions` inside it. `PI_CODING_AGENT_SESSION_DIR` puts every
  session in that one directory, without buckets.
- Ompanel resolves this once per instance from the environment the instance
  runs `omp` with (`resolveOmpSessionsLocation`).
- A file starts with a fixed-width `{"type":"title"}` slot (current files), then
  the `{"type":"session","id","cwd","timestamp"}` header, then entries. OMP
  writes a new session's file only once the session has an assistant message.
- `/wt` moves the file into the worktree's bucket under the same name and sets
  the header `cwd` to the worktree. Subagent transcripts live in a directory
  named after the parent file, as `<agent id>.jsonl`; they are not sessions.

## New thread

The thread's process starts in the thread's directory (`--cwd`), so OMP creates
the session in that directory's bucket. The adapter reads `get_state`; when OMP's
`autoResume` setting reopened the directory's last conversation
(`messageCount > 0`), it sends `new_session` so the new thread does not take
that conversation over.

When the thread binds, the adapter records the session in the thread's state
directory, `<stateDir>/omp/threads/<thread id>/session.json`
(`{version, threadId, sessionId, sessionFile}`, owner-only). The record is
rewritten whenever the session changes (`/fresh` starts a new session id; the
adapter reads it with `get_state` after each turn). The thread's native id
(`nativeThreadRef.nativeId`) is the OMP session id.

## Reopening a thread

When T3 reopens a thread (after a server restart, a settings restart, or `/wt`)
it passes the session id as `initialNativeThreadId`. The adapter:

1. looks for the file: the recorded `sessionFile` if its header still has the
   session id, else the newest file named `*_<id>.jsonl` in any bucket (this is
   how a thread follows `/wt`);
2. sends `switch_session {sessionPath}`; if OMP cannot restore the session's
   saved model, it retries with the model the process runs
   (`switch_session {sessionPath, provider, modelId}`);
3. checks with `get_state` that OMP now runs that session.

If the session cannot be found or opened, the process keeps a fresh session and
`resumeThread` fails with the reason. T3 then binds the thread to a fresh native
session and hands the conversation over as context (its usual resume fallback).

`open_session {sessionDir}` (newest session in a directory) is not used: a
thread's session lives in a bucket shared with every other session in that
directory, and `/wt` moves it, so only the session id identifies it.

## History

`get_messages_page {cursor?, limit?}` pages one in-memory snapshot of the
session, oldest first, at most 256 messages and 768 KiB per page; `nextCursor`
is absent on the last page. A cursor goes stale (`code: "stale_cursor"`) when
the session changes between pages; the reader then starts over (twice at most).
OMP refuses while a turn streams (`session_busy`).
`readOmpHistoryPages` returns the pages in order; `ompHistoryMessages` maps user
and assistant text to thread messages outside any run, with ids derived from
`<session id>:history:<index>` so a second read updates the same messages.
Tool results, bash runs, summaries and synthetic messages are left out.

- `readThreadSnapshot` returns that history for the bound thread.
- A thread that has no run yet but whose session already has messages (an
  imported session) gets its history emitted as `message.updated` when it
  binds, which happens when its first turn starts.

## Import

Settings → the OMP instance → **OMP sessions** lists the sessions whose header
`cwd` is the chosen project's root (symlinks resolved), newest first, without
empty untitled stubs, at most 500. Importing one creates a thread in that
project whose native id is the session id
(`server.listOmpSessions`, `server.importOmpSession`). The thread id is derived
from the instance and session id, so importing twice returns the same thread; a
session a thread of this instance already runs (by its record) is shown as
imported.

## For rewind and fork (C-11)

- Switching the live process to a session by id: `switchOmpSession`.
- Recording which session a thread runs: `recordOmpThreadSession`, or the
  adapter's `recordSession` (skips unchanged writes).
- Re-reading the conversation after `branch`: `readOmpHistoryPages` and
  `ompHistoryMessages` (the adapter's `readHistory`).
- OMP's `fork {entryId?}` writes a new session file in the same bucket and
  switches the live process to it; a fork into another thread has to record
  the new file for the target thread and switch the source back with
  `switchOmpSession`.
