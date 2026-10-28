# Workspace trust and approvals

A repository can carry its own agent config. For OMP that is `.omp/config.yml` and related files:
approval rules that can auto-approve commands, and MCP servers, extensions and hooks that run code
on your machine. Ompanel treats that config as third-party code and ignores it until you trust
the project.

## Trust a project

Select the project, then turn on **Trust project agent config**:

- Web and desktop: **Settings → Threads → Project agent config**.
- Mobile: **Settings → Threads → Project agent config**.

The toggle shows only when a project is selected. Trust is off by default for every project, new
or existing, and is set per project only.

| Project     | What OMP does                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------ |
| Not trusted | Ignores the project's approval rules, bash rules and extensions; loads no project MCP servers, extensions or hooks |
| Trusted     | Uses the project's agent config like your own                                                                      |

A running OMP thread restarts its agent on its next message after you change trust.

Trust belongs to the folder the project pointed at when you granted it. If you change the
project's workspace root, Ompanel turns trust off, and you decide again for the new folder. Your
other project settings stay as they were. Renaming a project or editing its scripts keeps trust.

Trust needs OMP RPC contract 1.9.0. When the server's OMP is older, the setting reads "Not
enforced by this server's OMP version": OMP still uses the project's own config whatever you
choose.

## Approvals

The thread's [permission mode](./permission-modes.md) decides when OMP asks before acting; see
[OMP permissions](./providers-omp.md#permissions). In every mode except Full access, OMP also asks
before any write to agent configuration (`.omp/`, `.pi/`, `.mcp.json`, `.claude/settings*.json`),
so an approved edit cannot widen later approvals.

Approval rules you set yourself live on **Settings → OMP → Approvals & Tools**
([OMP settings](./omp-settings.md)).

## Browser and computer use

OMP's browser and desktop-control tools act outside the project, so Ompanel allows them only in
Full access. In the other modes they are off, and neither a settings change nor a repository's
config can turn them on. In Full access the browser follows your OMP settings and computer use
follows the composer's Computer Use option.

## Commands from the composer

OMP commands that act on the machine outside the thread's approvals are refused when typed in the
composer; see [OMP in the composer](./omp-composer.md#slash-commands).

## Sharing

**Share live** links reach the session outside Ompanel pairing and approvals; see
[OMP thread menu](./omp-thread-menu.md#share-live).
