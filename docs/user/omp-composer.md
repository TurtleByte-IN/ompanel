# OMP in the composer

The composer works in OMP threads as in any other ([Messages and context](./composer.md)). This
page covers what is different for OMP.

## Steering and the queue

- A message you send while OMP works steers the running turn: OMP reads it after the current tool
  call.
- **Stop** stops the turn and withdraws messages OMP had queued.
- While OMP holds queued messages, an **OMP queue** card in the turn lists them; steering
  messages already delivered are marked sent. When a Stop withdraws messages, the card lists them.

How OMP queues steering and follow-ups is set by OMP's own settings (`steeringMode`,
`followUpMode`, `interruptMode`).

## Goals

A goal gives the thread one objective that OMP works toward and marks done.

- Select the **Goal** chip in the composer to open the Goal panel. Enter an **Objective** and an
  optional **Token budget**, then **Set a goal**.
- The panel shows the goal's status and usage, with **Pause**, **Resume** and **Drop**.
- You can also type `/goal <objective>`, `/goal set --budget <tokens> <objective>`, `/goal`
  (show), `/goal pause`, `/goal resume` or `/goal drop`. A `/goal` command runs as its own turn;
  one sent while a turn runs is refused.

OMP continues a goal between your messages only when its `goal.continuationModes` setting
includes `rpc` (**Settings → OMP → Modes**). A goal's budget cannot be changed once set.

## Plan mode

The composer's Plan toggle reaches OMP as an instruction on your next message. OMP's own plan
mode (read-only guard, plan file) is not available in Ompanel.

## Magic keywords

OMP reacts to a few words typed as plain prose:

| Word          | Effect                                                |
| ------------- | ----------------------------------------------------- |
| `ultrathink`  | The model's highest thinking level for that turn      |
| `orchestrate` | Split the work across subagents                       |
| `workflowz`   | A scripted multi-subagent workflow in the eval kernel |
| `jevify`      | Bulk classification with the eval kernel's judge      |

Type five or more letters of one to see it in the suggestion menu; click the suggestion to insert
it (the menu takes no keys). A message containing one shows it as a chip, and `ultrathink` also
lights the composer frame. A word inside code, a path or an identifier does not count. Turn a
word off with its `magicKeywords.<id>` OMP setting.

## Slash commands

The `/` menu lists OMP's commands that are safe to run from Ompanel, your skills and your prompt
templates. OMP commands that act on the machine outside the thread's approvals (for example
`/plugins install`, `/mcp add`, `/ssh`, `/stats`) are refused and not offered. `/share` is
refused too: use **Share as gist…** in the [thread menu](./omp-thread-menu.md) instead.
`/computer status` works; turning computer use on or off goes through the thread's permission
mode ([Workspace trust and approvals](./workspace-trust.md)).

Skills are mentioned as `$<name>`; see [OMP plugins and skills](./omp-plugins.md#skills).
