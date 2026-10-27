# OMP subagents and the Agents panel

OMP agents spawn subagents (the `task` tool), which can spawn their own. The
Agents panel shows them per thread as a tree, with their status, model, cost
and transcript, and can steer, kill and revive them.

On mobile the agents sheet shows the same tree when the thread has OMP
subagents (records with `controls`): status, nesting, model, cost, tokens and
tool calls per row, and the selected subagent's transcript, paged the same way.
Tapping an OMP subagent in a thread's work log opens it there. Mobile reads;
steer, kill and revive stay on web and desktop. Both clients share the view
model in `@t3tools/client-runtime/state/agents-tree`.

## Where the records come from

- When a session opens, the adapter sends `set_subagent_subscription` with
  level `progress`, so OMP forwards `subagent_lifecycle` and
  `subagent_progress` frames. Subagents' own session events (level `events`)
  are not subscribed; the panel reads transcripts instead.
- `OmpSubagentTracker` (`packages/provider-omp/src/server/subagents.ts`) turns
  those frames into `subagent.updated` events. They are stored in the thread
  projection like every provider's subagents.

| OMP                                                        | Subagent record                                                                                             |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `id`                                                       | `nativeTaskRef.nativeId`; the record id is a node derived from the provider thread and this id              |
| `parentId` (another subagent)                              | `parentNodeId` = that subagent's record id                                                                  |
| `parentId: null`, or no `parentId` (contract before 1.2.0) | `parentNodeId` = the `task` tool call (`parentToolCallId`), else the turn's root node                       |
| `depth`                                                    | `depth` (0 for a subagent the thread's own agent spawned)                                                   |
| lifecycle `started` / `completed` / `failed` / `aborted`   | `running` / `completed` / `failed` / `cancelled`; a later `started` (a revived subagent) runs again         |
| progress `stage`, else `lastIntent`, else the current tool | `progress` (one line)                                                                                       |
| progress `resolvedModel`                                   | `model`                                                                                                     |
| progress `cost`, `tokens`, `toolCount`, `durationMs`       | `usage.costUsd`, `usage.totalTokens`, `usage.toolCalls`, `usage.durationMs`                                 |
| `description`                                              | `title` is `<id>: <description>`, `<id> (<agent>)` without one, `<id>: Vibe <cli> worker` for a vibe worker |

Progress frames that change nothing are not written again. A progress frame
never overrides a finished status; only a new `started` does.

## Vibe workers

In vibe mode ([composer.md](./composer.md#vibe-mode)) each worker session the
agent starts with `vibe_spawn` is an OMP subagent (agent `sonic` for `fast`,
`task` for `good`; description `vibe <cli> session`). From RPC contract 1.8.0
its frames carry the `vibe_spawn` call as `parentToolCallId`, on its first
turn and on every later `vibe_send` turn, so the worker hangs under that call
in the Agents panel tree, titled `<id>: Vibe <cli> worker`, with its transcript
and controls like any subagent. Its task is the brief the agent sent. Leaving
vibe mode ends every worker (`cancelled`).

## Panel actions

The panel calls two WebSocket methods; the server finds the subagent's
provider session and calls the adapter.

| Panel                     | WebSocket                                                    | OMP command                                    |
| ------------------------- | ------------------------------------------------------------ | ---------------------------------------------- |
| Transcript (paged)        | `orchestration.readSubagentTranscript` `{fromByte}`          | `get_subagent_messages {subagentId, fromByte}` |
| Steer                     | `orchestration.controlSubagent` `{type: "steer", message}`   | `steer_subagent`                               |
| Kill                      | `orchestration.controlSubagent` `{type: "kill"}`             | `cancel_subagent`                              |
| Revive (optional message) | `orchestration.controlSubagent` `{type: "revive", message?}` | `revive_subagent` (RPC contract 1.4.0)         |

- The transcript reads from byte 0, then from each page's `nextByte` while
  the subagent runs. `reset` replaces what was read. Messages are reduced to
  user, assistant, tool and system entries (each at most 4,000 characters).
- OMP answers transcript reads and controls only for subagents the running
  process reported; after the OMP process restarts, older subagents stay in
  the panel but their transcript and actions fail with OMP's reason.
- Every OMP subagent record carries `controls`. `revive` is true only when the
  pinned contract (`omp.lock`) is 1.4.0 or later: `revive_subagent` is not in
  earlier contracts, so the adapter refuses it before sending anything. The
  current pin (`v18.12.6-ompanel.5`, contract 1.9.0) has revive.
