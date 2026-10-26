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

Every write to a thread overlay holds that overlay's lock, and only the adapter
changes the two guard keys: a settings-engine write based on an older read keeps the
values on disk. The adapter re-reads the overlay and re-asserts the guard before every
turn, with no cache.

OMP's overlay watcher applies a change within its debounce. On an OMP with RPC
contract 1.9.0 or later, the adapter then reads `get_state` (`browserEnabled`,
`computerEnabled`, `workspaceTrusted`) before every prompt, for up to 3 s, and fails the
turn (`tool_guard_unapplied` or `workspace_trust_unapplied`) unless OMP reports every value
it pinned. An older OMP reports none of these, so the check is skipped there.

## Workspace trust

A repository's own agent config can widen what the agent does: `.omp/config.yml` approval
rules can auto-approve bash in Supervised, and project MCP servers, extensions and hooks
run its code (#151). Ompanel treats that config as third-party code (PRD §9). The server
setting **Trust project agent config** (`trustProjectAgentConfig`, Settings → General →
Projects & threads, project-scoped; on mobile under Server controls → Agent behavior) is off by default for every project, new or existing.

- Untrusted: the thread's overlay sets `workspace.trusted: false`. OMP then ignores the
  project's `tools.approval`, `bash.patterns` and `extensions`, and loads no project MCP
  servers, extensions or hooks. A project cannot trust itself.
- Trusted: the key is removed, so OMP's default (or the user's global config) applies.
- Outside `yolo`, OMP always asks before a write to agent configuration (`.omp/`, `.pi/`,
  `.mcp.json`, `.claude/settings*.json`), so an auto-approved edit cannot widen later
  approvals (oh-my-pi#58).
- Project MCP servers and extensions load when `omp` starts. If a project's trust changed
  since its thread's `omp` started, the next turn fails with `workspace_trust_changed`,
  the overlay already holds the new value, and `omp` restarts; sending again uses it.
- The key is written only to an OMP with contract 1.9.0 or later; an older OMP would
  reject an overlay with an unknown key. Until `omp.lock` pins such a release, the setting
  has no effect.

## OMP builtins from the composer

OMP runs any prompt that starts with one of its RPC builtins, by name or alias, as that
command, outside the thread's approvals (`/mcp add … ` then `/mcp test` starts a command;
`/plugins install` or `/plugin enable`, `/move`, `/add-dir`, `/ssh`, `/export <path>` act
on the machine). The adapter resolves aliases as OMP does (`/plugin` is `/plugins`,
`/models` is `/model`, `/worktree` is `/wt`) and sends only builtins that change nothing
but this session's model knobs, context, todos or view: `advisor`, `changelog`,
`compact`, `context`, `effort`, `fast`, `force`, `forget-approvals`, `fresh`, `jobs`,
`prewalk`, `rename`, `retry`, `slow`, `todo` (only no subcommand, `append`, `start`,
`done`, `drop`, `rm` and `help`; `export` and `import` write and read any path, `copy`
uses the host's clipboard), `usage` (only no subcommand or `show`; `reset` spends a
provider rate-limit reset), `wt` (handled by Ompanel's host), plus `/computer status`.
`/stats` is refused: its dashboard serves every OMP session's transcript without
authentication on whatever `--host` it is given and opens a browser. Every other
builtin is refused (`builtin_command_refused`; `/share` with `share_command_refused`,
since it would upload past the Share as gist checks) and is not offered in the `/` menu.
Skills (`/skill:…`) and prompt templates are prompts and go through.

The builtin table is taken from the pinned source (`toolGuards.ts`) and must be
re-derived on every re-pin. The adapter also refuses any builtin, or alias, that the
running OMP lists in `available_commands_update` and the table lacks, so a builtin a
re-pin adds is refused until it is reviewed.

## Share live

Share live links reach the session outside T3 pairing. The menu item reads
`Share live (outside pairing)…` and its dialog warns every time it opens. The
mobile app has no Share live entry; OMP's `/collab` is TUI-only.

## Secrets

The OMP end-to-end suite (`apps/web/e2e/omp/ompSuite.ts`) stops the stack and
scans the server's output (except its pairing announcement), `<state>/logs`
(logs and traces), `<state>/omp` (journals, overlays), `statev2.sqlite` and its WAL,
OMP's own sessions and logs, the workspace the agent worked in (files, `.git`, any
`.omp/`), every OTLP metric export the server sent, and what CI
uploads (the suite's screenshots, Playwright traces opened entry by entry, and
Playwright's results directory), in raw, URL-encoded and JSON-escaped form, for the
pairing token, the live suite's API keys and the fake vendor's OAuth codes; any hit
fails the run and is listed in `leaked-secrets.json` by label, never by value.
Tracing starts after pairing, and the sign-in step pauses it while the code is
copied from the vendor's page (`untraced`), so neither secret reaches a trace.
The HTML report and `results.json` are written after the suite and are not scanned;
they carry the traces already scanned and the test output. Collab
links are covered by `threadMenuController.test.ts`, API keys in Ompanel's state
by `accountsController.test.ts`, and the pairing link in exported logs by
`apps/server/src/serverLogger.test.ts`.

## Windows

The job-object launcher, start-time lookup and tree kill run PowerShell and
`taskkill` by absolute path under `%SystemRoot%\System32`: Windows looks a bare
name up in the child's working directory first, which is the thread's
repository.
