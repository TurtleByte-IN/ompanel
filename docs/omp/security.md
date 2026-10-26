# OMP security guards (P-09)

## Browser and computer use: Full access only

OMP's browser eval prelude (`browser.enabled`, on by default in OMP) and its
host-desktop prelude (`computer.enabled`) act outside the thread's workspace, so
Ompanel offers them only in Full access (PRD §9, §6). The adapter enforces this
on the server (`packages/provider-omp/src/server/toolGuards.ts`):

- Before a thread's `omp` starts, and before every turn, the thread's `--config`
  overlay pins `browser.enabled: false` and `computer.enabled: false` in
  Supervised, Auto-accept edits and Auto. The overlay outranks project and global
  config, so a settings write or a repo's `.omp/config.yml` cannot turn them on.
- In Full access the browser follows OMP's own config (the key is removed) and
  computer use follows the composer's Computer Use trait.
- If the overlay cannot be written when a thread leaves Full access, the turn
  fails closed (`tool_guard_unapplied`) before its prompt.
- The settings form cannot override either key per thread
  (`not_thread_overridable`), as with `tools.approvalMode`.
- OMP's runtime layer outranks the overlay; its one writer a client reaches is
  the `/computer` command. A prompt `/computer on|off|toggle` is refused
  (`computer_command_refused`); `/computer status` goes through. `/computer` is
  not offered in the composer's `/` menu.

OMP's overlay watcher applies a change within its debounce. Until then, a
switch out of Full access is still covered: both preludes run only through
`eval`, an exec-tier tool that the new approval mode, applied just before,
already asks for.

## `/share`

A composer `/share` would run OMP's own share command in the thread's session
and upload to `share.serverUrl` without the Share as gist checks
([thread-menu.md](thread-menu.md)). It is refused (`share_command_refused`) and
not offered in the `/` menu.

## Share live

Share live links reach the session outside T3 pairing. The menu item reads
`Share live (outside pairing)…` and its dialog warns every time it opens. The
mobile app has no Share live entry; OMP's `/collab` is TUI-only.

## Secrets

The OMP end-to-end suite (`apps/web/e2e/omp/ompSuite.ts`) stops the stack and
scans the server's output (except its pairing announcement), `<state>/logs`
(logs and traces) and `<state>/omp` (journals, overlays) for the pairing token,
the live suite's API keys and the fake vendor's OAuth codes; any hit fails the
run and is listed in `leaked-secrets.json` by label, never by value. Collab
links are covered by `threadMenuController.test.ts`, API keys in Ompanel's state
by `accountsController.test.ts`, and the pairing link in exported logs by
`apps/server/src/serverLogger.test.ts`.

## Windows

The job-object launcher, start-time lookup and tree kill run PowerShell and
`taskkill` by absolute path under `%SystemRoot%\System32`: Windows looks a bare
name up in the child's working directory first, which is the thread's
repository.
