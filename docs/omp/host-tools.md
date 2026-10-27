# OMP host tools

A thread's `omp` process uses parts of T3 instead of its own: shell commands run
in the thread's T3 terminal, T3's MCP tools are available to the agent, and
`/wt` creates a T3 worktree. The OMP side is
`packages/provider-omp/src/server/hostTools.ts`. The T3 side is the
`ProviderHostTools` service (`packages/provider-core/src/server/ProviderHostTools.ts`),
implemented in `apps/server/src/provider/ProviderHostToolsLive.ts`.

All of this is set up when the session opens, before the first prompt. When the
T3 server does not provide `ProviderHostTools`, the session falls back to OMP's
own shell and worktree handling. When a step fails, it is logged and the
session opens without that feature.

## Terminal

OMP's built-in `bash` is turned off with `set_tool_enabled`. A host tool named
`terminal` replaces it, with the parameters `command` and `timeout` (seconds;
default 300, maximum 3600).

- The host tool gets its own name because a host tool cannot reuse the name of
  a built-in tool, even one that has been turned off. This was checked against
  OMP: `set_tool_enabled bash false` followed by `set_host_tools [bash]` fails
  with `RPC host tool "bash" conflicts with an existing tool`. The same name is
  accepted only when OMP is started without the built-in (`--tools` listing the
  tools to keep). That flag replaces OMP's whole default tool set, so it is not
  used.
- Commands run in the thread's agent terminal (terminal id `agent`). It is a
  T3 terminal session, so it appears in the thread's terminal drawer. The
  user can watch it and type into it. A `sudo` or `ssh` password prompt waits
  there until the user answers.
- Commands of one thread run one at a time in the same interactive shell, so
  `cd` and exported variables carry over. On timeout or cancel, Ctrl-C is
  sent to the command. If the shell does not come back to its prompt within
  3 s (for example `ssh` is still running, or Ctrl-C also cancelled the
  completion marker), the agent terminal is closed, and the next command starts
  a new shell in the thread's directory. The next command is never typed into
  a program that is still running.
- Permission mode: the thread's mode becomes OMP's `--approval-mode`
  ([processes.md](./processes.md)). OMP's approval gate treats host tools as
  `exec` tools. So Supervised and Auto-accept edits threads are asked before
  each command, and Full access threads are not. The approval prompt shows the
  command (oh-my-pi#38).
- A command containing a control character other than newline and tab (for
  example `\r` or ESC), or a bidirectional-override character, is refused
  without running. The approval prompt cannot show these characters, but the
  shell would act on them.
- The tool card is a command card, the same as OMP's own `bash`. It shows the
  exit code from the result's `details.exitCode`.

### Fallback: OMP's own `bash`

OMP keeps its built-in `bash` when the T3 terminal is not routed: outside the
T3 server (no `ProviderHostTools`), when the pinned contract has no
`set_tool_enabled`, or when `set_tool_enabled` fails. If OMP turns `bash` off
but then refuses `set_host_tools`, the bridge turns `bash` back on, so the
thread always has a shell. These commands run inside OMP, without a PTY
(`rpc-ui` sets `PI_NO_PTY`), so they do not appear in the terminal drawer and
cannot answer a password prompt.

Their output streams anyway. OMP reports a running command with
`tool_execution_update`, whose `partialResult` is a snapshot of its output
window (it grows, then scrolls past its budget). The mapper sends the part not
yet shown as `command_output.delta` on the command card, the same live,
unpersisted channel Codex uses; the persisted card gets the whole output at
`tool_execution_end`. Terminal escapes are stripped from both. `bash` output
never arrives as `command_output` (that frame is builtin slash-command output)
or `tool_stream_update` (only `edit` streams its arguments that way). The T3
terminal host tool streams through the same path, from its
`host_tool_update` tail.

### Keyboard shortcuts

Keyboard shortcuts in a thread are T3's own (Settings → Keybindings).
OMP's `keybindings.yml` and its TUI settings belong to OMP's terminal app: no
OMP process here has a TUI, and the Terminal prefs settings page shows those
keys read-only ([settings.md](./settings.md)).

## T3 MCP tools

When T3 issues the thread an MCP credential (`McpProviderSessions`), the
session connects to the thread's T3 MCP server. Every tool the server lists is
registered with `set_host_tools` under its own name. This covers preview,
orchestration and delegation (`delegate_task`, …), worktree, pull requests and
the other toolkits the thread's credential allows. A call is forwarded to the
T3 MCP server over that connection. Text and image results come back as OMP
tool content. The connection closes with the session.

## Worktrees (`/wt`, `/move`)

The session turns on `set_host_cwd_change`. After that, OMP sends a
`host_cwd_change_request` instead of changing directory itself.

- `/wt [branch]` (`reason: "worktree"`): T3 creates a worktree for the thread's
  project. It is on the new branch and starts from the branch the thread is
  on. The session answers `accepted` with the worktree path, and OMP moves its
  session there. Then the thread is bound to the worktree: its metadata is
  updated, the project's setup script runs, and the agent terminal is closed
  so the next command opens in the worktree.
- Changing a thread's workspace detaches its provider session. A turn still
  running finishes first; this is the `/wt` turn itself, which binds the
  thread before OMP has replied, so it completes normally. Until then the
  session stays the thread's: archiving or deleting the thread, or a stricter
  permission mode, still ends that turn at once (archive and delete revoke its
  T3 MCP credential). Then the session is released and OMP exits; so does a
  turn that fails to start, and if OMP exits or crashes first, the thread's
  background jobs are cleared with it. The next message starts OMP in the
  worktree, which reopens the same OMP session from the worktree's bucket
  ([sessions.md](./sessions.md#reopening-a-thread)). OMP writes a session file
  only once it has a reply, so after a `/wt` sent as a thread's first message
  there is nothing to reopen and the next message starts a fresh session.
- `/move <path>` (`reason: "move"`) is refused: a T3 thread stays in its project
  or worktree. To work in another directory, start a new thread there.
- A worktree that cannot be created (not a git repository, detached HEAD, the
  branch exists, …) is refused with T3's reason. OMP shows it as
  `Worktree creation rejected by host: <reason>`.

## Contract versions

| Feature                                                  | Needs RPC contract  |
| -------------------------------------------------------- | ------------------- |
| `set_host_tools` (MCP tools)                             | 1.0.0               |
| `set_tool_enabled` (terminal in place of `bash`)         | 1.1.0               |
| `set_host_cwd_change`, `host_cwd_change_request` (`/wt`) | 1.5.0 (oh-my-pi#38) |

The session compares the pinned contract (`omp.lock`) against these versions.
It leaves out what the pinned sidecar cannot do. The current pin
(v18.12.6-ompanel.5, RPC 1.9.0) has all three.
