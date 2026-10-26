# OMP

OMP (Oh My Pi) is Ompanel's own coding agent. Ompanel pins one OMP release and
runs it as a sidecar, so OMP does not need to be on the server's `PATH`.

OMP support is a preview. Ompanel can find and check the OMP sidecar, but
conversations, commit messages and thread titles through OMP are not available
yet. The OMP provider is off by default.

## Set Up OMP

1. Open **Settings → Providers** and enable OMP.
2. Leave **Binary path** empty to use the sidecar Ompanel manages, or set it to
   the absolute path of an `omp` executable, such as a development build.
   Ompanel runs that file as given and does not check it.
3. Set **Profile** to keep this instance's OMP config, logins and sessions
   apart from your others. OMP stores each profile under
   `~/.omp/profiles/<name>`. Leave it empty for OMP's default profile.

Add another OMP instance for each separate account or configuration, each with
its own profile.

## Permissions

OMP enforces the thread's [permission mode](./permission-modes.md) itself:

| Mode                  | OMP approval mode | Asks before                                  |
| --------------------- | ----------------- | -------------------------------------------- |
| **Supervised**        | `always-ask`      | Commands and file changes; reads run freely  |
| **Auto-accept edits** | `write`           | Commands; reads and file edits run freely    |
| **Full access**       | `yolo`            | Nothing, unless your OMP settings require it |

OMP has no automatic review, so it offers no **Auto**. A thread already set to
**Auto** runs in **Supervised**.

Change the mode in the composer at any time. The new mode applies from the
thread's next message, in the same OMP session. Choosing a stricter mode while
OMP is working stops the current response first. If OMP refuses the new mode,
that message fails with an error and OMP keeps its previous mode; switch back
to that mode or start a new thread.

## Commands, Shortcuts and Notifications

OMP runs shell commands in the thread's terminal, where you can watch them and
answer password prompts. When that terminal is not available to OMP, OMP runs
commands itself: their output still appears live on the command card, but they
cannot ask for a password.

Ompanel's keyboard shortcuts work the same in OMP threads as in any other.
OMP's own key bindings (`keybindings.yml`) apply only to the `omp` terminal app.

Messages OMP or an OMP extension shows to you (for example "Build done")
appear in the thread. Desktop and phone notifications come, as for other
agents, when a thread finishes, fails, or needs your approval or input; OMP's
messages do not send one of their own yet.

## Status Checks

Ompanel checks OMP by running `omp --version` (it waits up to 4 seconds) and
starting OMP's RPC server just long enough to read its ready message. That check
opens no session and starts no tools, extensions or MCP servers. Ompanel reuses
the result for 30 seconds.

The provider card shows an error when:

- no OMP sidecar is installed for this platform and no binary path is set,
- a sidecar file does not match the release Ompanel pins, so Ompanel refuses to
  run it,
- the binary path does not exist or is not absolute,
- OMP speaks a different version of the RPC protocol than this Ompanel release.

OMP updates arrive with Ompanel updates. Ompanel does not update OMP on its own.
**Settings → OMP → Plugins → Check for updates** runs `omp update --check`,
which only says whether a newer OMP exists.

## Plugins and Skills

**Settings → OMP → Plugins** lists the plugins and marketplaces of this OMP
profile. You can install a plugin (an npm package, `github:user/repo`, a git
URL, a local path, or `name@marketplace` from **Browse**), enable, disable or
uninstall it, and add or remove marketplaces. Before anything runs, Ompanel
shows the exact `omp plugin` command and waits for you to confirm.

Plugins are third-party code. An enabled plugin runs on your machine with your
permissions in every OMP thread: its tools (the agent calls them as `xd://`
devices), hooks, commands, skills and MCP servers. Install only what you trust.

New threads load plugins when they start. **Reload plugins** also reloads them
in running threads that are not in the middle of a response.

**Settings → OMP → Skills** lists the skills a new thread loads, including
those plugins bring, and opens any of them in your editor.
