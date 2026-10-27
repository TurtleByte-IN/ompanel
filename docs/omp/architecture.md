# Ompanel and OMP: architecture

Ompanel drives OMP (oh-my-pi) as a sidecar process. Two forks make this work:

| Fork | Repository                                | Upstream           | What it adds                                                                                |
| ---- | ----------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------- |
| T    | `TurtleByte-IN/ompanel` (this repository) | `pingdotgg/t3code` | The OMP provider (`packages/provider-omp`), its settings pages, thread menu and usage tab   |
| O    | `TurtleByte-IN/oh-my-pi`                  | `can1357/oh-my-pi` | The RPC commands and frames Ompanel needs, and `packages/rpc-contract`, the contract T pins |

How each fork follows its upstream is in [fork-and-merge.md](fork-and-merge.md).

## The pieces

| Piece             | Where                                              | Role                                                                                                                                                                    |
| ----------------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Clients           | `apps/web`, `apps/desktop`, `apps/mobile`          | Threads, Settings → OMP pages, the Usage tab. They talk to the server only; none of them starts `omp`.                                                                  |
| Server            | `apps/server`                                      | Registers `OmpDriver` in `BUILT_IN_DRIVERS` (`apps/server/src/provider/builtInDrivers.ts`) and serves the `server.*Omp*` RPC methods (`apps/server/src/ws.ts`).         |
| OMP provider      | `packages/provider-omp`                            | The driver, the thread adapter, the control service, the settings engine and the controllers behind every OMP page. See [provider-internals.md](provider-internals.md). |
| Vendored contract | `packages/provider-omp/contract/`                  | Byte-for-byte copy of O's `packages/rpc-contract` at the pinned tag: RPC wire schema and CLI JSON contract, with generated TypeScript types.                            |
| The pin           | `packages/provider-omp/omp.lock`, `src/ompLock.ts` | The O release tag, its commit, contract versions and the sha256 of every platform's sidecar ([sidecar.md](sidecar.md)).                                                 |
| OMP sidecar       | an `omp` binary from an O release                  | Runs the agent. Bundled with the desktop app, or downloaded by the server on first use, and checked against `omp.lock` before every run.                                |

The provider package has separate entry points so browser code never imports server code:
`@t3tools/provider-omp/client` (`ompClient`, used by the web and mobile settings forms and by
`apps/server/src/settingsSecrets.ts`), `./settings`, `./configForm`, `./settingsPages`,
`./modelsConfig` and `./composer` (shared with the web app), `./server` (`OmpDriver`), `./rpc` (the
process layer, for the server's replay testkit), `./server/usage` (the usage format, for the
server's usage tests) and `./sidecar` (for desktop packaging).

## Processes

Ompanel starts three kinds of `omp` process. None of them is looked up on `PATH`.

```
client (web, desktop, mobile)
   │  server RPC: orchestration, server.*Omp* methods
   ▼
apps/server ── OmpDriver, one per OMP instance
   ├── OmpAdapter ──────────── omp --mode rpc-ui …            one per thread, lives with the thread
   ├── OmpControlService ───── omp --version, omp config …,  short-lived, hard deadline each
   │                           omp --mode rpc --no-session …
   └── text generation ─────── omp -p --no-session …          one-shot per commit message or title
```

- **Thread processes.** Every thread owns one `omp --mode rpc-ui` process with its own
  `--config` overlay and an explicit `--approval-mode`. Stopping the thread drains and exits it,
  and kills its whole process tree if it does not exit. See [processes.md](processes.md).
- **Control processes.** Status checks, settings reads and writes, sign-in, usage, plugins,
  skills, export and share run through `OmpControlService`
  (`packages/provider-omp/src/server/control.ts`), each under a deadline. They never touch a
  thread's process. See [sidecar.md](sidecar.md#control-processes).
- **Text generation.** Commit messages, PR text, branch names and thread titles run a one-shot
  `omp -p` in an empty directory Ompanel owns. See [sidecar.md](sidecar.md#text-generation).

## RPC frames

A thread process speaks newline-delimited JSON on stdin and stdout:

1. The first frame is `ready`. Its `contractVersion` must equal `contract.version` in
   `omp.lock`, or the session is refused before any command is sent.
2. `negotiate_protocol` moves to protocol 2: lines of at most 1 MiB, with `rpc_chunk` sequences
   that carry one logical frame of up to 64 MiB.
3. Commands are typed by the vendored contract (`RpcWireCommands`). Frames go through
   `OmpThreadMapper`, which turns them into V2 thread events, and every frame is written to the
   thread's journal so a reconnecting client can replay it.

Details: [processes.md](processes.md#handshake) (handshake and framing),
[frames.md](frames.md) (what each frame becomes), [journal.md](journal.md) (journal and replay),
[host-tools.md](host-tools.md) (T3 tools OMP calls back into).

## Getting the sidecar

The server resolves the binary again, and re-hashes it, before every status check and every
spawn. In order: the instance's binary path (unchecked), the desktop app's bundled sidecar
(`OMPANEL_OMP_BUNDLED_PATH`), the download cache, or a fresh download from the pinned O release.
Desktop packaging (`scripts/build-desktop-artifact.ts`) stages the pinned asset for each target
and checks its sha256 against `omp.lock`. See [sidecar.md](sidecar.md#finding-the-sidecar) and
[sidecar.md](sidecar.md#desktop-bundling).

A sidecar that reports another contract version shows as an error on the OMP status card. Moving
the pin to a new O release is in [contract-bump.md](contract-bump.md).

## State on disk

Ompanel's own files, under the server's state directory:

| Path                                                | Holds                                                                                    |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `<stateDir>/omp/processes/<pid>.json`               | Pidfiles of live thread processes, swept at boot ([processes.md](processes.md#pidfiles)) |
| `<stateDir>/omp/threads/<thread id>/overlay.yml`    | The thread's `--config` overlay ([settings.md](settings.md#per-thread-overrides))        |
| `<stateDir>/omp/threads/<thread id>/session.json`   | Which OMP session file the thread runs ([sessions.md](sessions.md))                      |
| `<stateDir>/omp/threads/<thread id>/journal.ndjson` | The frame journal ([journal.md](journal.md))                                             |
| `<stateDir>/omp/text-generation/`                   | Working directory of text generation                                                     |
| `<stateDir>/omp/exports/`                           | HTML exports from the thread menu ([thread-menu.md](thread-menu.md))                     |
| `<baseDir>/tools/omp/<tag>/<asset>`                 | Downloaded sidecar cache ([sidecar.md](sidecar.md#cache-folder-rules))                   |

Global settings calls, which must see no project config, run in `<stateDir>/omp`.

OMP keeps its own config, credentials and sessions in its agent directory
(`~/.omp/agent`, or `~/.omp/profiles/<profile>/agent` for an instance with a profile). Threads
map one to one onto OMP session files there, so a conversation shows up in `omp --resume` too
([sessions.md](sessions.md#where-omp-keeps-sessions-pinned-fork)).

## Settings

Ompanel keeps no copy of OMP's settings schema. Forms come from `omp config list --json` and
writes go through `omp config set|reset`. Which page touches which key or command is in
[settings-mapping.md](settings-mapping.md); the engine's rules are in [settings.md](settings.md).
