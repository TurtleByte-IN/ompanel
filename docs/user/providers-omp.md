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
thread's next message, in the same OMP session. If OMP refuses the new mode,
that message fails with an error and OMP keeps its previous mode; switch back
to that mode or start a new thread.

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
