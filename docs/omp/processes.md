# OMP session processes

Every thread on an OMP instance runs its own `omp` process. The code is in
`packages/provider-omp/src/server/` (`session.ts`, `rpcProcess.ts`,
`processTree.ts`, `pidfiles.ts`).

## Command line

```
omp --mode rpc-ui --approval-mode <mode> [--profile <name>] --config <overlay> --cwd <dir> [launch args]
```

| Flag              | Value                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--approval-mode` | Always passed. Supervised → `always-ask`, Auto-accept edits → `write`, Full access → `yolo`. A thread stored as Auto runs `always-ask`.                                                                                |
| `--profile`       | The instance's profile setting; left out for OMP's default profile.                                                                                                                                                    |
| `--config`        | The thread's overlay, `<stateDir>/omp/threads/<thread id>/overlay.yml` (owner-only). Created as an empty mapping; a respawn keeps it, because it holds the thread's settings overrides ([settings.md](./settings.md)). |
| `--cwd`           | The thread's worktree, or the server's working directory when the thread names none.                                                                                                                                   |

The instance's **Launch arguments** come last. `resolveOmpLaunchArgs` in
`launch.ts` refuses a flag Ompanel sets or relies on, `--api-key` (a secret in
argv), and a token OMP would read as a prompt; the refusal fails the sidecar
lookup, so the status card and every spawn show it. The same arguments end the
control server's command line, never a subcommand's. Text generation's
`omp -p --no-tools --no-extensions` gets only what `ompPrintLaunchArgs` keeps
(`--thinking`, `--service-tier` and switches that turn things off): `--tools`
overrides `--no-tools`, and `-e`, `--hook`, `--plugin-dir` or an extension's
flag load code despite `--no-extensions`.

Every control server (`omp --mode rpc`, started in the project's directory)
also gets `--config <overlay>`, a file chosen by the project's trust. The
server decides trust (`trustProjectAgentConfig`, per project) for a directory
that is a project's own workspace root or one of its git worktrees (the
worktree listing `vcs.listRefs` and threads use); a folder inside a project and
any other directory are untrusted:

- untrusted holds `workspace.trusted: false` and `mcp.enableProjectConfig: false`.
  `--no-tools` and `--no-extensions` do not stop OMP from loading a project's
  custom tools (`.omp/tools`, `.claude/tools`), plugin tools or MCP servers, and a
  `--config` overlay outranks the project layer, which cannot set
  `workspace.trusted`. The project's own commands and `enabledModels` do not apply.
- trusted holds only `mcp.enableProjectConfig: false`, so the user's own
  `workspace.trusted` still applies (as in a thread's overlay): the project's
  commands, tools and model scope load, and its MCP servers still do not.

Control sessions and the lists found through them are keyed by the directory and
the trust state, so a list found for one state is never served for the other.
When a server setting changes, every cached directory whose project's trust
differs from what its lists were found under is rediscovered and republished.
`OMP_CONTROL_OVERLAYS` in `control.ts` holds both. The files live in
`<stateDir>/omp/control`, Ompanel's private state (directory created 0700, a
symlink or a directory owned by another user is refused, a loose mode is
tightened); a temp directory would let another local user plant a file. Every
spawn writes the file afresh through a staging file and a rename, so a removed,
stale or planted file never reaches `omp` (which rejects a missing `--config`).
`workspace.trusted` needs RPC contract 1.9.0 or later, as the thread overlay does.

The binary is resolved (and its sha256 checked, see [sidecar.md](./sidecar.md))
right before each spawn. The process gets the server's environment plus the
instance's environment overrides. An instance **Agent directory** sets
`PI_CODING_AGENT_DIR` (with `OMP_PROFILE` and `PI_PROFILE` dropped) for every
`omp` the instance runs. Ompanel sets no `OTEL_*` variable and no `telemetry.*`
key, so OMP's own OTLP export follows the user's environment and OMP settings.

The same command line runs on macOS, Linux and Windows:

- Overlays go in as `--config <path>`, one argument per file, so no path
  separator is involved. Ompanel sets `PI_CONFIG_FILES`, whose list OMP
  splits on `:` on Unix and `;` on Windows, in one place only: `omp share`
  takes no `--config`, so "Share as gist" passes its overlay there as a
  single path and refuses a path that contains the platform's separator
  ([thread-menu.md](./thread-menu.md#share-as-gist)). A `PI_CONFIG_FILES` the
  user exports reaches thread sessions unchanged, and OMP splits it itself;
  control processes drop it ([sidecar.md](./sidecar.md#control-processes)).
- Ompanel never runs `omp config init-xdg`. That command exits non-zero on
  Windows and moves no data elsewhere. Ompanel instead follows the directories
  OMP already resolves, XDG roots included once they exist
  ([sessions.md](./sessions.md)).

`launch.test.ts` fails if server, desktop or provider code mentions
`init-xdg`, or sets `PI_CONFIG_FILES` anywhere but the "Share as gist" call.

### Approval mode is required (O-9)

OMP's own default for `tools.approvalMode` is `yolo`, so an `omp` started
without `--approval-mode` would run every tool unasked. The process layer
(`startOmpRpcProcess`) therefore refuses to spawn any command line that does not
carry `--approval-mode` followed by one of `always-ask`, `always-ask-cached`,
`write` or `yolo`; the session then fails to start with an `OmpRpcError`
(`reason: "spawn"`) and no process is created. This covers a runtime mode the
build does not know as well as a caller that builds its own command line. The
fork's `omp --mode rpc-ui` refuses to start without the flag as well from tag
v18.12.6-ompanel.4 (TurtleByte-IN/oh-my-pi#46), which `omp.lock` pins or exceeds; the check
here stays as the earlier, structured failure.

## Permission mode changes

Changing a live thread's permission mode keeps its process: the adapter declares
`supportsRuntimeModeSwitchInSession`, so the orchestrator does not detach the
session. Before the next prompt the adapter compares the turn's mapped approval
mode with the one the process enforces and, if they differ, sends
`set_approval_mode {mode}` (a runtime override; OMP's `config.yml` is not written).
OMP refuses anything but `yolo` in a session started with `--auto-approve`/`--yolo`.
A refusal fails that turn before its prompt with the reason
`permission_mode_refused`; the process keeps the mode it had, and the next turn
in a different mode asks again.

A turn already running keeps the mode it started with, so the orchestrator
still detaches a `running` or `waiting` session when the mode tightens. Closing
a session with a turn in flight sends `abort` before closing stdin; otherwise
OMP would drain that turn, under its old mode, for up to the 10 s graceful exit.

## Handshake

1. The first frame must be `ready` (30 s limit).
2. `ready` must offer protocol 2 with 1 MiB frames and 64 MiB reassembly.
3. `ready.contractVersion` must equal `contract.version` in `omp.lock`.
   Anything else, or no version at all, refuses the sidecar: the session
   fails to open and the process tree is killed before any command is sent.
4. `negotiate_protocol {protocolVersion: 2}`; the response must report
   protocol 2 and the same contract version.

After the handshake the process exposes a frame stream (every frame except
responses to Ompanel's own commands) and a typed command API keyed by the
vendored contract's `RpcWireCommands`. A command sent with `echoResponse`
also has its response put on the frame stream, after every frame OMP wrote
before it; turns use this for `prompt`. What the frames mean for a thread is
in [frames.md](./frames.md).

Before the thread's first prompt, the session registers T3's terminal and MCP
tools and hands `/wt` to T3; see [host-tools.md](./host-tools.md).

## Framing

Stdout is newline-delimited JSON. A line over 1 MiB, a line that is not a
JSON object with a string `type`, or a malformed `rpc_chunk` sequence is a
protocol error: the session fails and the tree is killed. `rpc_chunk` frames
are refused before protocol 2 is negotiated, and a sequence that declares
more than 64 MiB is refused before any of it is decoded. Stderr is counted,
never logged.

## Stopping

Stopping a thread closes the process's stdin. OMP drains the work it has
accepted, writes its session file and exits 0. If it has not exited after
10 s, the tree is killed. Processes it started that are still running after a
clean exit are killed too.

Killing a tree:

- POSIX: `omp` leads its own process group. The group gets SIGTERM, then
  SIGKILL 2 s later. On Linux the process also runs in the server's systemd
  agent scope when one is configured.
- Windows: `omp` runs under a PowerShell launcher that first puts itself in a
  job object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, then starts `omp` with
  inherited stdio. Every descendant inherits the job, and only the launcher
  holds the job handle, so the tree dies when the launcher dies for any
  reason. Stop runs `taskkill /T /F` on the launcher.
  The Windows CI runners kill real trees through this launcher
  (`processTree.windows.test.ts`): a stop ends the launcher, `omp`, its child
  and its grandchild. Terminating only the launcher ends them too, because
  closing the job's last handle kills the job.

## Pidfiles

Each spawn writes `<stateDir>/omp/processes/<pid>.json` with the process's
start time, the server's pid and a per-boot id. A clean stop removes it.

When an OMP instance is created (server boot or a settings change), pidfiles
left by an earlier server are swept:

| Found                                                    | Action                                    |
| -------------------------------------------------------- | ----------------------------------------- |
| Written by this server, or by another server still alive | Left alone.                               |
| Process alive with the recorded start time               | Tree killed, pidfile removed.             |
| Process alive with another start time (pid reused)       | Left alone, pidfile removed.              |
| `omp` gone (its pid may since belong to anything)        | Nothing signalled, pidfile removed.       |
| Start time unknown on this platform                      | Left alone, pidfile kept for a later try. |

The sweep only signals a process it can identify as the `omp` it recorded.
Processes an `omp` left behind after it already exited are not reaped by the
sweep, because a dead process's pid (and process-group id) can be reused by an
unrelated program; on Linux the systemd agent scope, when configured, still
reaps them.

Start times come from `/proc/<pid>/stat` on Linux, `ps -o lstart=` on macOS
and other Unixes, and `Get-Process` on Windows.
