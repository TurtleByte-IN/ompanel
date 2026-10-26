# OMP composer runtime

How the composer's controls reach an OMP thread (`packages/provider-omp/src/server/adapter.ts`).

## Sending

A message is one RPC `prompt`. Every attachment is named in the text by its saved path, and image
attachments T3 can send natively also go as `images` blocks (`ImageContent`, base64). Steers,
follow-ups and restarts carry attachments the same way.

## Steering and the queue

T3 steers a running OMP turn (capability `supportsActiveSteering`):

| T3 action                                                            | OMP command                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Message while the agent loop runs                                    | `steer` (lands after the current tool call, or at the turn's end under OMP's `interruptMode: wait`) |
| Message after `agent_end`, before the turn settled                   | `follow_up` (runs when the session resumes)                                                         |
| Stop                                                                 | `abort`; `abort_and_restore_queue` when OMP still holds queued messages                             |
| Restart of a run ("interrupt and send", a selection change mid-turn) | `abort_and_prompt` for the new attempt (`supportsSteeringByInterruptRestart`)                       |

Messages queued while the turn runs stay in T3's own queue and start the next turn.

OMP's `queue_update` snapshots render as one "OMP queue" card per turn: running while OMP holds
messages (steering entries already sent into the stream are marked "sent"), completed once the
queue drains. A Stop that withdraws queued messages lists them on the stopped turn, since they
never ran. An `abort` alone would let OMP drain its queue into a new run after the Stop.

Queue behaviour itself (`steeringMode`, `followUpMode`, `interruptMode`) is an OMP setting, applied
to a running thread over RPC by the settings engine (`docs/omp/settings.md`).

## Plan mode

The pinned RPC contract has no plan mode: OMP's `/plan` is TUI-only (`handleTui`), so prompting
`/plan` over RPC does nothing. The composer's Plan toggle therefore reaches OMP as an instruction
(`t3AcpPromptWithInstructions`) on the first prompt after each mode change. Each omp process starts
from Default, so default-mode prompts stay verbatim. A prompt that starts with a slash command goes out unwrapped and the
mode is stated on the next one. OMP's native plan mode (read-only guard, plan file, review) needs a
new RPC command in the fork; tracked in TurtleByte-IN/oh-my-pi#48.
