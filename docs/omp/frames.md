# OMP frames in a thread

`OmpThreadMapper` (`packages/provider-omp/src/server/mapper.ts`) turns the
frames of one `omp --mode rpc-ui` process into V2 thread events. The adapter
(`adapter.ts`) feeds it frames one at a time and does the I/O.

## Threads and turns

- Opening a thread binds it to the session the process opened: `get_state`
  gives the session id (the provider thread's native id), the title, the
  context window and the todo list. A thread that ran an earlier session
  reopens it with `switch_session` first ([sessions.md](sessions.md#reopening-a-thread)).
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
- A run OMP starts on its own after a turn (`prompt_result` said
  `sessionSettled: false` and a background job woke the session) is held
  until T3 runs a continuation turn for it, which replays it and ends at the
  run's yield ([journal.md](journal.md#background-runs)).
- Every frame the mapper reads is journaled ([journal.md](journal.md)).

## Frames

| Frame                                                                                                    | Shown as                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `message_update` `text_delta` / `text_end`                                                               | Assistant message, streamed (deltas held 50 ms and sent together).                                                                                                                                                                                                              |
| `message_update` `thinking_delta` / `_end`                                                               | Reasoning. Thinking marked `narration` is shown as answer text.                                                                                                                                                                                                                 |
| `message_end` (assistant)                                                                                | Closes open text; adds its `usage` to the turn (see Usage).                                                                                                                                                                                                                     |
| `message_end` (custom, `customType: "advisor"`)                                                          | Notification titled Advisor: the first note as summary, every note with severity and advisor as detail. A `blocker` note marks it failed.                                                                                                                                       |
| `auto_compaction_start` / `_end`, `manual_compaction_start` / `_end`                                     | One compaction card per run, running from start to end. The end's `result.shortSummary` (or `summary`) and `tokensBefore` fill it; `aborted` is interrupted, `skipped` completes with OMP's reason, an error fails it. Manual end has no `action`/`willRetry`; neither is used. |
| `ttsr_triggered`                                                                                         | Notification "Rule injected: names", each rule's path and content as detail.                                                                                                                                                                                                    |
| `retry_fallback_applied`                                                                                 | Notification "Fallback applied: from → to (role)", the reason as detail.                                                                                                                                                                                                        |
| `goal_updated`                                                                                           | The provider thread's `goal`, inside a turn or between turns; a dropped goal clears it ([composer.md](./composer.md#goal-mode)).                                                                                                                                                |
| `tool_execution_start` / `_update` / `_end`                                                              | Tool-call card, updated in place (see Tool cards). For `bash` and the T3 `terminal` tool, `_update` output goes out as `command_output.delta` instead ([host-tools.md](./host-tools.md#fallback-omps-own-bash)).                                                                |
| `notice`                                                                                                 | System notice; the title is the notice's `source`.                                                                                                                                                                                                                              |
| `command_output`                                                                                         | Notification: first line as summary, full text as detail.                                                                                                                                                                                                                       |
| `extension_ui_request` `notify`                                                                          | Notification in the thread with source `agent` (failed outcome for `notifyType: "error"`). The user also gets a desktop, web or phone alert for it ([notifications.md](notifications.md)).                                                                                      |
| `extension_ui_request` `open_url`                                                                        | Notification: the instructions' first line, the link as detail.                                                                                                                                                                                                                 |
| `extension_ui_request` `set_editor_text`                                                                 | Notification carrying the text (T has no remote composer channel).                                                                                                                                                                                                              |
| `extension_ui_request` dialogs and `cancel`                                                              | Approval cards and question cards (see Dialogs).                                                                                                                                                                                                                                |
| `extension_ui_request` `setStatus` / `setWidget` / `setTitle`                                            | Ignored: they style OMP's own TUI; T keeps its own title ([why](open-questions.md#extension-setstatus-and-setwidget)).                                                                                                                                                          |
| `session_info_update`                                                                                    | Session id and title (see Title and /fresh).                                                                                                                                                                                                                                    |
| `subagent_lifecycle` / `subagent_progress`                                                               | Subagent records for the agents panel (see [subagents.md](subagents.md)); at any time, not only in a turn.                                                                                                                                                                      |
| anything else; any frame above outside a turn, except `session_info_update`, dialogs and subagent frames | Ignored (frames of a run OMP started on its own wait for a turn, see above).                                                                                                                                                                                                    |

## Tool cards

| Tool                                         | Card                                                                                                                                                                                                                                                                   |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bash`                                       | Command: `args.command`, the result text, `details.exitCode` (OMP sets it only when non-zero).                                                                                                                                                                         |
| `edit`                                       | File change. The path comes from `details.path`, `details.perFileResults`, `args.path`, or the first `[PATH#TAG]` header of the hashline input. `details.diff` (OMP's `+12\|text` format) is the diff payload, with added/removed line counts and `oldText`/`newText`. |
| `write` to a file                            | File change with the written content.                                                                                                                                                                                                                                  |
| `write xd://<device>`                        | Tool card titled `xd://<device>`, its input the JSON written to the device, labelled `xd://`. A device with a card below (`debug`, `lsp`, memory, `resolve`/`reject`, ...) gets that card, from `details.xdev.args` and `details.xdev.inner`.                          |
| `write conflict://N`                         | Conflict card: the target and OMP's resolution line, with `details.resolvedPath`.                                                                                                                                                                                      |
| any tool on another `<scheme>://` path       | Tool card labelled with the scheme (`skill://`, `agent://`, ...).                                                                                                                                                                                                      |
| `todo`                                       | The todo list, once the call ends (`details.phases`). A failed call keeps a plain tool card.                                                                                                                                                                           |
| `ask`                                        | The answers (`details` for one question, `details.results` for several): selected options, "Other" free text, notes. The live question is the C-03 dialog card.                                                                                                        |
| `ast_edit`                                   | Proposed edit: files, replacement count and diff. OMP stages it (`details.applied: false`) until the agent writes `xd://resolve` or `xd://reject`; then the card turns applied or discarded. OMP has no host command to accept or reject, so the card has no buttons.  |
| `debug`                                      | DAP inspector: action, state and stop reason, frame and location, stack frames, scopes, locals (`variables`), evaluation result.                                                                                                                                       |
| `lsp`                                        | Action, server, file and symbol, and the result text.                                                                                                                                                                                                                  |
| `eval`                                       | Cells (`details.cells`: code, output, status, duration) and the result's image blocks inline, served from the item.                                                                                                                                                    |
| `generate_image`                             | The pictures from `details.images`, moved into the output as image blocks and served from the item (no remote fetch), with provider, model and saved paths.                                                                                                            |
| `tts`                                        | Audio player for the file at `args.output_path` (`.wav` when `details.codec` is wav), voice and size. OMP has no voice tool; live voice is a session feature.                                                                                                          |
| `recall`, `retain`, `reflect`, `memory_edit` | Memory card: the operation, query or items, edit status, and the result text.                                                                                                                                                                                          |
| anything else                                | Plain tool card with the arguments and result text.                                                                                                                                                                                                                    |

Carded tools keep OMP's content blocks in the item output and add the card under `ompCard`
(`OmpToolCard` in `@t3tools/contracts`); the web item inspector and the mobile work log render it
in place of the raw output.

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

## Dialogs

`OmpUiRequests` (`packages/provider-omp/src/server/uiRequests.ts`) turns the
dialogs OMP opens into V2 runtime requests; the adapter sends the
`extension_ui_response` and runs the deadlines. Each request is live-only
(`responseCapability: live`); it sits in the active turn, or on the thread when
OMP asks between turns.

| Request                            | Card                                                                                                                                                                        | Reply                                                                                        |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `select` titled `Allow tool: NAME` | Approval card: `bash`/`eval`/`ssh`/`python`/`exec` are commands, `edit`/`write`/`ast_edit`/`apply_patch`/`notebook` file changes, `read` a file read, the rest permissions. | `value`: the label of the choice (see Approvals).                                            |
| any other `select`                 | Question, single choice, no free text; `optionDetails` become option descriptions.                                                                                          | `value`: the chosen option.                                                                  |
| `confirm`                          | Approval card (permission) with Yes / No.                                                                                                                                   | `confirmed: true` / `false`.                                                                 |
| `input`                            | Question with free text, plus "Submit empty value".                                                                                                                         | `value`.                                                                                     |
| `editor`                           | Question with free text, prefilled with `prefill`.                                                                                                                          | `value`.                                                                                     |
| `ask`                              | One question per OMP question; `multi` allows several options; free text ("Other") is always allowed; the `recommended` option is labelled so.                              | `answers`: one `AskAnswer {id, selectedOptions, customInput?}` per question, in OMP's order. |
| `cancel`                           | Closes the card of `targetId` (cancelled).                                                                                                                                  | None: OMP has already settled the dialog.                                                    |

- **ask:** the adapter sends `set_ask_dialog {enabled: true}` right after the
  handshake. Without it OMP falls back to `select`/`editor` and has no
  multi-select or free text. An omp without the command keeps the fallback.
  A question answered with option labels sends them as `selectedOptions`;
  free text that is not an option label is `customInput`. Question ids are
  OMP's own unless blank, padded or repeated (then `question-N`).
- **Deadlines:** `timeout` (ms) on `select`, `confirm`, `input` and `ask`
  starts a timer when the card opens; `editor` has none. When it fires, OMP
  gets `{cancelled: true, timedOut: true}` (an `ask` then takes its recommended
  answers) and the request becomes `expired`. OMP runs the same deadline and
  sends `cancel` for it, whichever comes first.
- **Cancel = reject:** the `cancel` decision, or no usable answer, replies
  `{cancelled: true}`, which OMP reads as "no", "deny" or no answer.
- When the process exits, open cards close (cancelled) with no reply.

### Approvals

OMP's rpc-ui mode has no approval dialog; it asks with a `select` whose options
are `[grant labels…, grant always-labels…, Approve | Approve Once, session?, Deny]`
(`approvalChoiceLabels` in OMP's `tools/approval.ts`). The card offers:

| Decision           | Label sent back                                                                |
| ------------------ | ------------------------------------------------------------------------------ |
| `accept`           | `Approve` (or `Approve Once` when grants are offered).                         |
| `acceptForSession` | `Approve SUBJECT for this session`, else the narrowest grant (`Approve File`). |
| `acceptAlways`     | The narrowest grant's always-label (`Always Approve File`), when grants exist. |
| `decline`          | `Deny`.                                                                        |

When OMP offers both a folder and a file grant, the card offers the file one:
the folder grant would cover more than the call being approved. The card shows
the prompt verbatim, except the `Reason:` line of OMP's header (the line after
`Allow tool: NAME`, or after `Origin: MCP server tool`), which becomes the
card's reason. A `Reason:` line anywhere else is part of the tool's arguments,
which the model wrote, so it stays in the prompt and never becomes the reason.
