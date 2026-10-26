# OMP frames in a thread

`OmpThreadMapper` (`packages/provider-omp/src/server/mapper.ts`) turns the
frames of one `omp --mode rpc-ui` process into V2 thread events. The adapter
(`adapter.ts`) feeds it frames one at a time and does the I/O.

## Threads and turns

- Opening a thread binds it to the session the process opened: `get_state`
  gives the session id (the provider thread's native id), the title, the
  context window and the todo list. Switching to another session is not
  wired yet.
- A turn is one `prompt`. Before sending it, the adapter sets the OMP session
  name to the thread's title (`set_session_name`), so OMP never auto-titles it.
- The `prompt` response is echoed onto the frame stream, behind any
  `command_output` the prompt produced. It ends the turn when it is a failure
  (for example `session_busy`) or `agentInvoked: false` (a builtin slash
  command that ran locally; no `prompt_result` follows).
- Otherwise `prompt_result` with the prompt's id ends the turn: `completed`,
  `aborted` (interrupted) or `error` (failed; HTTP 429 is a usage limit).
- After the turn the adapter reads `get_state` and `get_session_stats`
  (2 s each; a missing answer only leaves the meter as it was).
- If the process exits during a turn, the turn fails (or is interrupted when
  the thread was being stopped).

## Frames

| Frame                                                                       | Shown as                                                           |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `message_update` `text_delta` / `text_end`                                  | Assistant message, streamed (deltas held 50 ms and sent together). |
| `message_update` `thinking_delta` / `_end`                                  | Reasoning. Thinking marked `narration` is shown as answer text.    |
| `message_end` (assistant)                                                   | Closes open text; adds its `usage` to the turn (see Usage).        |
| `tool_execution_start` / `_update` / `_end`                                 | Tool-call card, updated in place (see Tool cards).                 |
| `notice`                                                                    | System notice; the title is the notice's `source`.                 |
| `command_output`                                                            | Notification: first line as summary, full text as detail.          |
| `extension_ui_request` `notify`                                             | Notification. Other UI requests are C-03's.                        |
| `session_info_update`                                                       | Session id and title (see Title and /fresh).                       |
| anything else; any frame above outside a turn, except `session_info_update` | Ignored.                                                           |

## Tool cards

| Tool                                   | Card                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash`                                 | Command: `args.command`, the result text, `details.exitCode` (OMP sets it only when non-zero).                                                                                                                                                                         |
| `edit`                                 | File change. The path comes from `details.path`, `details.perFileResults`, `args.path`, or the first `[PATH#TAG]` header of the hashline input. `details.diff` (OMP's `+12\|text` format) is the diff payload, with added/removed line counts and `oldText`/`newText`. |
| `write` to a file                      | File change with the written content.                                                                                                                                                                                                                                  |
| `write xd://<device>`                  | Tool card titled `xd://<device>`, its input the JSON written to the device, labelled `xd://`.                                                                                                                                                                          |
| any tool on another `<scheme>://` path | Tool card labelled with the scheme (`skill://`, `agent://`, ...).                                                                                                                                                                                                      |
| `todo`                                 | The todo list, once the call ends (`details.phases`). A failed call keeps a plain tool card.                                                                                                                                                                           |
| anything else                          | Plain tool card with the arguments and result text.                                                                                                                                                                                                                    |

## Todos

OMP has no todo event. The list comes from `todo` tool results, and from
`get_state().todoPhases` after each turn (which catches `set_todos` and other
edits); the latter is shown only when it differs from the last list seen.
Phases become plan steps (`Phase: task` once there is more than one phase);
`in_progress` is running, `completed` and `abandoned` are done, `pending` and
`blocked` are pending, and blocked tasks show their blocker.

## Usage and the context meter

- Each assistant `message_end` adds its `usage` to the turn's token totals
  (input counts cache reads and writes) and updates the live meter:
  `usage.contextTokens`, or input + cache + output when absent, against the
  context window.
- At the end of the turn, `contextUsage` from `get_session_stats` (or
  `get_state`) replaces the meter, and the provider thread's context usage
  carries the session's token totals and `cost` (USD).
- `prompt_result` carries no usage.

## Title and /fresh

- Only a `/rename` typed in the turn renames the thread: its
  `session_info_update` title becomes the thread title. Titles OMP reports
  for other commands (model switch, presets) are kept as native metadata
  and never rename the thread.
- `/fresh` rotates the OMP session id but keeps the session. A new id, from
  `session_info_update` or from `get_state` after the turn, is adopted in
  place: same provider thread, new native id.
