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
(`{version, threadId, sessionId, reportedSessionId, sessionFile}`,
owner-only), and again whenever `get_state` (read after each turn) reports a
change. The same directory holds the thread's frame journal, `journal.ndjson`
([journal.md](journal.md)).

Two ids matter. `sessionId` is the file's own id: the one in its name and
header, which `/wt` keeps. `reportedSessionId` is what `get_state` reports. In
the pinned fork `/fresh` rotates only the reported id (provider-side stream
state; `AgentSession.freshSession`). The file, its name and its header keep
theirs, and reloading the file reports the file id again. The thread's native
id (`nativeThreadRef.nativeId`) follows the reported id, so after `/fresh`
only the record links the thread to its file.

## Reopening a thread

When T3 reopens a thread (after a server restart, a settings restart, or `/wt`)
it passes the thread's native id as `initialNativeThreadId`. The adapter:

1. maps it to the file id through the thread's record (it matches either id);
   without a record the native id is taken as the file id;
2. looks for the file: the recorded `sessionFile` if its header still has the
   file id, else the newest file named `*_<file id>.jsonl` in any bucket (this
   is how a thread follows `/wt`);
3. sends `switch_session {sessionPath}`; if OMP cannot restore the session's
   saved model, it retries with the model the process runs
   (`switch_session {sessionPath, provider, modelId}`);
4. checks with `get_state` that OMP now runs that file.

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

## Rewind and fork

The code is in `sessionBranches.ts` and the adapter's `rollbackThread` and
`forkThread`. Both go through OMP's session tree; T3's own checkpoints restore
the files as for every other provider.

### Which entry a turn is

Each entry of a session file has an id and a `parentId`; the file's leaf is
the entry the conversation continues from. After each turn the adapter lists
what the turn appended (`get_entries {since: <leaf before the turn>}`; the
whole listing, filtered by the turn's start time, when that leaf is unknown)
and records the turn's first user message entry as the turn's
`nativeTurnRef`. A turn that wrote no user message (a builtin command) gets
`null`. OMP keeps entry ids when it copies a session, so the refs stay valid
in the files a rewind or fork writes.

A turn from before this was recorded keeps its synthetic weak ref; it is found
by its time window on the current path (`get_entries`), since OMP and Ompanel
share the clock.

### Rewind

Rewinding to turn N (or to the thread start) cuts the session before the user
message of the first later turn that left one still in the session
(`get_branch_messages` lists the session's user messages):

1. Refused while a turn runs: the adapter's own turn, or OMP reporting
   `isStreaming`/`isCompacting` (a wake-up T3 did not start). OMP itself lets
   `branch` run during a turn, which would split the transcript (PRD §12).
   Turns wait while a rewind or fork runs.
2. `branch {entryId}` moves the session onto a new file in the same bucket
   holding everything before that message (an empty session when it was the
   first), with a new session id and the old file as `parentSession`. The old
   file keeps the full conversation. OMP sends no `session_info_update`.
3. The adapter reads `get_state`, moves the thread's native id to the new
   session and records the new file in `session.json`, so a reopened thread
   resumes the rewound conversation.
4. The snapshot returned to T3 is re-read from the new file
   (`get_messages_page`); its payload carries `restoredText` (the removed
   message, OMP's `branch` result), `branchMessages` (the user messages left,
   each a later rewind point) and `branchTree`.

The next prompt continues from the cut. A thread whose process was stopped
(idle, server restart) is first bound to its recorded session, as a turn would
bind it. Once `branch` succeeded, a failed read after it (state, messages,
tree, history) is logged and left out of the snapshot instead of failing the
rewind, so T3 never keeps turns OMP dropped; the next turn's `get_state`
records the file if the rewind could not.

### Fork

T3 forks lazily: the new thread's first turn opens its own process and calls
`forkThread` there with the source thread and the turn to fork from.

1. Refused while the source thread runs a turn (its live session in this
   instance, by `isBusy` and `get_state`), and with the same message when OMP
   answers `fork` with `session_busy`.
2. The new thread's process opens the source's file (`switchOmpSession` with
   the source thread's record). OMP refuses to open a session recorded for
   another directory, so a fork into another worktree fails with that reason.
3. Forking from the latest turn is `fork {}`: a copy of the whole session.
   From an earlier turn, the cut is found as for a rewind, and `fork
   {entryId}` keeps the session through the nearest message entry before it
   (OMP only forks at message entries; `get_entries {since: <previous user
   message>}` finds it).
4. OMP writes the new file in the same bucket and moves the process onto it.
   The new thread is bound to it and recorded; the source thread and its file
   are untouched, so the source's own process never shares a file. If
   anything fails after the switch, the process leaves the source's file with
   `new_session`.

### Branch tree (P-06)

`readOmpBranchTree` (`get_tree`) and the `branchTree` in `readThreadSnapshot`
and rewind payloads reduce the session tree to user and assistant messages,
branch summaries and compactions: flat `nodes` (parents first, each with the
nearest kept ancestor as `parentId`, a preview and OMP's label), the `leafId`
and the `activePath` from the root to it. A rewind's earlier branch lives in
the parent file (`parentSession` in the header), not in this tree.
