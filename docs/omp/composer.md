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
| Stop                                                                 | `abort_and_restore_queue` (a plain `abort` lets OMP drain its queue into a new run)                 |
| Restart of a run ("interrupt and send", a selection change mid-turn) | `abort_and_prompt` for the new attempt (`supportsSteeringByInterruptRestart`)                       |

Messages queued while the turn runs stay in T3's own queue and start the next turn.

OMP's `queue_update` snapshots render as one "OMP queue" card per turn: running while OMP holds
messages (steering entries already sent into the stream are marked "sent"), completed once the
queue drains. During a Stop the snapshots no longer mean delivery: the turn's end waits for
OMP's answer, in whichever order it and `prompt_result` arrive, and the card closes listing the
messages the Stop withdrew.

A steer or follow-up can reach OMP after the turn's prompt finished; OMP then runs it as a new
run. The turn stays open for it: replies to steers are echoed onto the frame stream, and a
finished prompt with a message still unanswered or queued is held until that run's `agent_end`,
or until an echoed `get_state` shows OMP idle with nothing queued.

Queue behaviour itself (`steeringMode`, `followUpMode`, `interruptMode`) is an OMP setting, applied
to a running thread over RPC by the settings engine (`docs/omp/settings.md`).

## Plan mode

The pinned RPC contract has no plan mode: OMP's `/plan` is TUI-only (`handleTui`), so prompting
`/plan` over RPC does nothing. The composer's Plan toggle therefore reaches OMP as an instruction
(`t3AcpPromptWithInstructions`) on the first prompt after each mode change. Each omp process starts
from Default, so default-mode prompts stay verbatim. A prompt that starts with a slash command goes out unwrapped and the
mode is stated on the next one. OMP's native plan mode (read-only guard, plan file, review) needs a
new RPC command in the fork; tracked in TurtleByte-IN/oh-my-pi#48.

## Goal mode

OMP's goal mode keeps one objective for the session: the agent gets the `goal` tool, works
toward the objective, and marks it done. OMP's `/goal` runs only in its TUI, so the adapter runs
a prompt that is a `/goal` command (`parseOmpGoalCommand` in
`packages/provider-omp/src/composer.ts`) over the RPC `goal` command instead of sending it:

| Composer                                     | OMP                                             | The turn                                    |
| -------------------------------------------- | ----------------------------------------------- | ------------------------------------------- |
| `/goal <objective>`, `/goal set <objective>` | `goal {op: "create", objective}`                | prompts the objective, as OMP's TUI does    |
| `/goal set --budget <tokens> <objective>`    | `goal {op: "create", objective, token_budget}`  | prompts the objective                       |
| `/goal`, `/goal show`                        | `goal {op: "get"}`                              | shows the goal, its status and what it used |
| `/goal pause`, `/goal resume`                | `goal {op: "pause"}`, `goal {op: "resume"}`     | shows OMP's answer; nothing is prompted     |
| `/goal drop`, `/goal clear`                  | `goal {op: "drop"}`                             | shows OMP's answer; nothing is prompted     |
| `/goal budget …`                             | none: RPC cannot change a running goal's budget | says so                                     |

A refused op (goal mode off in `goal.enabled`, plan mode on, no paused goal to resume) fails
the turn with OMP's reason. A new goal is created only after OMP has taken its objective as the
prompt, so a goal continuation (`goal.continuationModes` with `rpc`) cannot run before the
objective arrives; if OMP refuses the goal then, the turn notes "OMP did not set the goal" and
the objective still runs. Like every provider's `/goal`, the command must run as its own turn:
one sent while a turn runs is refused, never steered into the turn as text. `/goal` is added to
the `/` menu (see [commands.md](./commands.md)).

The thread's goal comes from OMP: `get_state.goal` when the session binds and after each turn,
and every `goal_updated` frame, inside a turn or between turns. It is the provider thread's
`goal` (`active`, `paused`, `budget_limited`, `complete`; a dropped goal is none), so the
thread shell, sidebar and goal banner show it. In the web composer an OMP thread has a Goal
chip that opens the Goal side panel: the objective, status and usage, Pause, Resume and Drop,
and a form that sets a goal with an optional token budget. The panel and the banner send the
commands above.

OMP continues a goal on its own between turns only when its `goal.continuationModes` setting
includes `rpc` (Settings → OMP → Modes); those runs reach the thread as continuation turns.
Otherwise each message works toward the goal.

On mobile the floating goal pill above an OMP thread's composer opens the **Goal** sheet, and
so does **Goal** in the thread's OMP sheet (the sparkles button in the thread header), so a
thread without a goal can set one. The sheet shows the same summary, Pause, Resume and Drop,
the set form with its optional token budget ("Enter a whole number of tokens." for anything but
a positive whole number) and the `goal.continuationModes` note. Each action is queued as its own
`/goal …` user turn through the thread outbox, the path the composer sends through; while the
thread is working the actions wait for the turn to end. The sheet is
`apps/mobile/src/features/threads/ThreadGoalPanel.tsx`.

## Vibe mode

In vibe mode the agent directs persistent `fast` and `good` worker sessions (`vibe_spawn`,
`vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`) and only reads files itself. It is the
composer's **Vibe Mode** trait (see [models.md](./models.md)): before a prompt the adapter sends
`set_vibe_mode {enabled}` when the trait changed; turning it off ends the workers. OMP refuses
vibe mode while plan or goal mode is on, refuses a new goal while vibe mode is on, and refuses
`new_session` and `fork` (Fork thread) while it is on; rewind (`branch`) and session switches
keep vibe mode as the target session recorded it. A refused trait is logged and the turn runs.

`set_vibe_mode` arrives with RPC contract `OMP_VIBE_CONTRACT` (1.8.0,
`packages/provider-omp/src/server/vibe.ts`); the pinned sidecar (`v18.12.6-ompanel.4`) has it.
Below that contract the composer does not offer the trait and the adapter never sends the
command; `/vibe` stays in OMP's TUI.

Each worker is an OMP subagent, shown in the thread's Agents panel tree under the `vibe_spawn`
call that started it (see [subagents.md](./subagents.md#vibe-workers)).

## Role chip

On an OMP thread that runs as a role other than `default`, the composer bar shows a
`Role: <name>` chip beside the traits control. It updates when the role changes.
Clicking it opens the traits menu, where the Role select changes it. On the
default role there is no chip, as with any trait left at its default. The role
itself is described in [models.md](./models.md#role-chip).
The chip is web and desktop only; the mobile composer has no traits menu.

## Magic keywords

OMP reacts to a few words typed as standalone prose: `ultrathink` (the model's highest
thinking level for that turn), `orchestrate` (split the work across subagents), `workflowz` (a
scripted multi-subagent workflow in the eval kernel) and `jevify` (bulk classification with the
eval kernel's judge). OMP adds the hidden notice itself, so prompts go out unchanged; each word
can be turned off with its `magicKeywords.<id>` setting.

The web composer of an OMP thread offers them: typing five or more letters of one shows it in
the suggestion menu, which takes no keys (Tab, Enter and the arrows keep their usual meaning;
click the suggestion to insert it), and a prompt that contains one shows it as a chip (`ultrathink` also
lights the composer frame). The list (`OMP_MAGIC_KEYWORDS` in `composer.ts`) mirrors OMP's
`modes/magic-keywords.ts` at the pinned tag; a word inside code, a path or an identifier does
not count, as in OMP.
