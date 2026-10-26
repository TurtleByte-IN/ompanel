# The OMP thread menu

An OMP thread's menu (the thread's title in the chat header, or right-click
the thread in the sidebar) has an **OMP** section (PRD FR-21, §6 `/collab`):

| Item              | What it does                                                                                     | Needs                          |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------ |
| Export HTML       | Downloads the thread's OMP session as one self-contained page, `omp-session-<file id>.html`.     | Read access                    |
| Share as gist…    | After you confirm, uploads the session, encrypted, to a secret GitHub gist with your `gh` login. | Operate access, `gh` signed in |
| Share live…       | Opens a collab room on the running session and shows its links and a QR code.                    | Operate access, OMP 1.7.0 RPC  |
| Stop sharing live | Ends the thread's room; guests are told goodbye.                                                 | Operate access                 |
| Branch tree       | Shows every branch of the session, with the path the thread continues from highlighted.          | Read access, a running session |

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

If the gist still fails after that check (a network error, a revoked token),
OMP falls back to its share server; the dialog then shows the link with a
warning that the share server was used. The upload runs once per click: the
dialog asks first, and a second click while it runs joins the first.

## Share live

Share live is OMP's `/collab` for a thread running in Ompanel. It needs the RPC
commands `collab_start`, `collab_status` and `collab_stop` (OMP RPC contract
1.7.0, the fork's `docs/rpc.md`). Until the sidecar `omp.lock` pins is on that
contract, the dialog says so as it opens and the Start button stays disabled:

> Share live needs OMP RPC contract 1.7.0 or later; this Ompanel runs OMP
> 18.12.6-ompanel.3 (contract 1.6.0). Update Ompanel to a build with a newer
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
scopes and approvals. The dialog says this every time it opens.

The links are capabilities, so Ompanel never records them: they travel from
OMP's response to the dialog only. The adapter keeps `collab_*` frames out of
the thread's mapping and its journal ([journal.md](journal.md)), logs record
only frame types, and spans carry the instance and thread ids only.
`threadMenuController.test.ts` drives a fake OMP whose room links carry a
marker token (and one frame that wrongly carries a link) and checks the token
reaches neither the journal nor any log line.

## Branch tree

RPC `get_tree` on the running session, reduced as in
[sessions.md](sessions.md#branch-tree-p-06): user and assistant messages,
branch summaries and compactions, each under its nearest kept ancestor. The
dialog draws it with the thread details panel's rows: a lone child continues
its parent's line, a fork indents its branches and shows the fork icon, the
active path is highlighted and the leaf is marked `current`. A thread whose
session is not running says so; send a message to start it.

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
`apps/web/src/components/chat/OmpThreadMenu.tsx`.
