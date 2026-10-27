# The OMP thread menu

An OMP thread's menu (the thread's title in the chat header, or right-click
the thread in the sidebar) has an **OMP** section (PRD FR-21, §6 `/collab`):

| Item                          | What it does                                                                                     | Needs                          |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| Export HTML                   | Downloads the thread's OMP session as one self-contained page, `omp-session-<file id>.html`.     | Read access                    |
| Share as gist…                | After you confirm, uploads the session, encrypted, to a secret GitHub gist with your `gh` login. | Operate access, `gh` signed in |
| Share live (outside pairing)… | Opens a collab room on the running session and shows its links and a QR code.                    | Operate access, OMP 1.7.0 RPC  |
| Stop sharing live             | Ends the thread's room; guests are told goodbye.                                                 | Operate access                 |
| Branch tree                   | Shows every branch of the session, with the path the thread continues from highlighted.          | Read access, a running session |

The section appears only on threads that run on an OMP instance. Read-only
connections keep Export HTML and Branch tree; the sharing items are disabled.

## Export HTML

A running thread renders its page with RPC `export_html`; an idle one runs
`omp [--profile p] --export <session file> <out>` on the file the thread last
ran (`session.json`, [sessions.md](sessions.md)). Either way OMP writes into a
private scratch directory under `<stateDir>/omp/exports/` (owner-only), the
server reads the page back, removes the directory, and the browser downloads
it. Nothing is written into the project. A thread that never sent a message
has no session file yet and says so.

## Share as gist

`omp share <session file> --gist` seals the session with a fresh key and
uploads it with `gh gist create`; the viewer link carries the key in its
fragment, so the gist alone cannot be read. When `gh` is missing or signed out
OMP does not fail: it uploads to its own share server instead. So the server
runs `gh auth status` first, in the instance's environment, and refuses before
anything leaves the machine:

- `gh` not found: "Sharing as a gist needs the GitHub CLI (gh). Install it,
  run `gh auth login`, then try again. Nothing was uploaded."
- `gh` signed out: "The GitHub CLI (gh) is not signed in. Run `gh auth login`,
  then try again. Nothing was uploaded."

Ompanel never lets that fallback upload anything. `omp share` runs with a
config overlay (`PI_CONFIG_FILES`, which outranks global and project settings)
that sets `share.serverUrl` to `https://share-server-disabled.invalid`, a host
that can never resolve (RFC 6761). This is the one place Ompanel sets
`PI_CONFIG_FILES`, because `omp share` takes no `--config`: the flag is
rejected after the subcommand and ignored before it, as checked on the pinned
binary. The variable holds one path and replaces any inherited list. OMP splits
it on `;` (Windows) or `:`, so a state directory path containing that
separator is refused. So:

- If the gist fails after the check (a network error, a revoked token), OMP's
  fallback upload fails too. The dialog says "OMP could not create the gist.
  Nothing was uploaded".
- A cloned repo's `.omp/config.yml` cannot choose the share host either: the
  overlay wins.

OMP builds the link as `<share.serverUrl>/<gist id>#<key>`. Ompanel accepts only
a link on the blocked host with a matching `Gist:` line, then rebuilds it on
OMP's own viewer, `https://my.omp.sh/s/<gist id>#<key>`. Any other output is
refused.

Checked against the pinned omp, with `gh` absent and a repo setting present
(`program/evidence/p-06/share-gist-overlay.txt`):

- without the overlay, OMP tried to upload to the repo's host;
- with it, OMP tried the blocked host;
- both runs exited 1, and nothing was uploaded.

The upload runs once per click: the dialog asks first, and a second click while
it runs joins the first.

A `/share` typed in the composer would run OMP's own share command in the
thread's session, which uploads to `share.serverUrl` without this dialog, the
`gh` check or the blocked-host overlay. The adapter refuses it before it
reaches OMP and points to this menu item (`server/toolGuards.ts`).

## Share live

Share live is OMP's `/collab` for a thread running in Ompanel. It needs the RPC
commands `collab_start`, `collab_status` and `collab_stop` (OMP RPC contract
1.7.0, the fork's `docs/rpc.md`); the pinned sidecar (`v18.12.6-ompanel.4`,
contract 1.8.0) has them. Against a sidecar below 1.7.0 the dialog says so as it
opens and the Start button stays disabled:

> Share live needs OMP RPC contract 1.7.0 or later; this Ompanel runs OMP
> `<version>` (contract `<contract>`). Update Ompanel to a build with a newer
> OMP.

The room belongs to the thread's running OMP process, so the thread must be
running (send a message first); a room ends when you stop it, when the
thread's process stops (idle release, archive, server shutdown), and on a
session change such as a rewind or fork. Pick **View only** (guests watch) or
**View and prompt** (guests can also prompt, interrupt and answer dialogs;
their prompts run with the thread's permissions). The dialog shows the browser
link with its QR code and the `omp join` link, and lists who joined.

**The links bypass T3 pairing.** Anyone holding one reaches the session through
OMP's collab relay (`collab.relayUrl` in OMP's settings), outside T3's pairing,
scopes and approvals. The menu item says so (`Share live (outside pairing)…`)
and the dialog says it every time it opens. Share live exists in the web and
desktop thread menu and in the mobile OMP sheet ([Mobile](#mobile)); OMP's own
`/collab` command is TUI-only, so a composer prompt cannot open a room.

The links are capabilities, so Ompanel never records them. They travel from
OMP's response to the dialog only:

- The adapter keeps `collab_*` frames out of the thread's mapping and its
  journal ([journal.md](journal.md)).
- Room requests are sent with `dropLateResponse`. An answer that arrives after
  the request gave up (a timeout, a closed dialog) is dropped by the RPC process
  instead of reaching the journal.
- A start that does not come back with a room is followed by `collab_stop`, so
  no room stays open that nobody sees. That covers a timeout, a caller that
  went away, and an answer Ompanel cannot read.
- Logs record only frame types, and spans carry only the instance and thread
  ids.

`threadMenuController.test.ts` drives a fake OMP whose room links carry a
marker token, during a running turn. The fake sends one frame that wrongly
carries a link, and delays its room answers past short deadlines, so they
land late mid-turn. The test checks that the lost start was stopped, and that
the token reaches neither the journal nor any log line.

## Branch tree

RPC `get_tree` on the running session, reduced as in
[sessions.md](sessions.md#branch-tree-p-06): user and assistant messages,
branch summaries and compactions, each under its nearest kept ancestor. The
dialog draws it with the thread details panel's rows: a lone child continues
its parent's line, a fork indents its branches and shows the fork icon, the
active path is highlighted and the leaf is marked `current`. A thread whose
session is not running says so; send a message to start it.

## Mobile

On mobile an OMP thread's header has an **OMP** button (sparkles) that opens
the OMP sheet; it is absent on other providers' threads. The sheet lists Goal
(opens the goal sheet, [composer.md](composer.md#goal-mode)), Export HTML,
Share as gist, Share live, Stop sharing live and Branch tree, and uses the same
server RPCs as web:

- Export HTML writes the page to the app's cache (`html-exports/`) and opens the
  system share sheet, so it can be saved to Files or sent; failures show an
  alert.
- Share as gist shows the same warning and asks before uploading, then the
  share link with a Copy button and the gist address, or the failure message.
- Share live shows the "This link bypasses T3 pairing" warning, with web's
  text, before a room starts and while it is open. Pick View only or View and
  prompt, then Start sharing; an open room shows the browser and `omp join`
  links with Copy buttons, who joined, and Stop sharing. It refreshes every 5
  seconds while open. Mobile has no QR code.
- Stop sharing live ends the room and says whether one was running.
- Branch tree draws the same rows (`ompBranchTreeRows` in
  `packages/provider-omp/src/branchTree.ts`, shared with web): forks indent,
  the active path is highlighted and the leaf is marked `current`.

The views are `apps/mobile/src/features/threads/OmpThreadMenu.tsx`.

## Server API

| RPC                             | Scope                   |
| ------------------------------- | ----------------------- |
| `server.exportOmpThreadHtml`    | `orchestration:read`    |
| `server.getOmpThreadBranchTree` | `orchestration:read`    |
| `server.shareOmpThreadGist`     | `orchestration:operate` |
| `server.startOmpThreadCollab`   | `orchestration:operate` |
| `server.getOmpThreadCollab`     | `orchestration:operate` |
| `server.stopOmpThreadCollab`    | `orchestration:operate` |

Reading a room's status needs operate access because the status carries its
links. Errors are `OmpThreadMenuOperationError` with a `reason`:
`not_running`, `no_session`, `needs_newer_omp`, `gh_unavailable`, `timeout`,
`omp_failed`, `instance_not_found` or `unsupported`. The provider side is
`packages/provider-omp/src/server/threadMenuController.ts`; the dialogs are
`apps/web/src/components/chat/OmpThreadMenu.tsx` (mobile: [Mobile](#mobile)).
