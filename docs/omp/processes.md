# OMP session processes

Every thread on an OMP instance runs its own `omp` process. The code is in
`packages/provider-omp/src/server/` (`session.ts`, `rpcProcess.ts`,
`processTree.ts`, `pidfiles.ts`).

## Command line

```
omp --mode rpc-ui --approval-mode <mode> [--profile <name>] --config <overlay> --cwd <dir>
```

| Flag              | Value                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `--approval-mode` | Always passed. Supervised → `always-ask`, Auto-accept edits → `write`, Full access → `yolo`. A thread stored as Auto runs `always-ask`. |
| `--profile`       | The instance's profile setting; left out for OMP's default profile.                                                                     |
| `--config`        | The thread's overlay, `<stateDir>/omp/threads/<thread id>/overlay.yml` (owner-only). It is an empty mapping for now.                    |
| `--cwd`           | The thread's worktree, or the server's working directory when the thread names none.                                                    |

The binary is resolved (and its sha256 checked, see [sidecar.md](./sidecar.md))
right before each spawn. The process gets the server's environment plus the
instance's environment overrides.

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
vendored contract's `RpcWireCommands`.

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
