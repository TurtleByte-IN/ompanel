# OMP provider internals

A map of `packages/provider-omp/src/server/` for someone changing it. Each section names the
files and links the page with the details. The big picture is in
[architecture.md](architecture.md).

## The driver

`driver.ts` exports `OmpDriver`, which the server lists in `BUILT_IN_DRIVERS`. The driver
supports several instances; each instance has its own settings (`settings.ts`, `OmpSettings`):

| Field                     | Meaning                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------ |
| `binaryPath`              | Absolute path to an `omp` to run instead of the managed sidecar. Not checked against `omp.lock`. |
| `profile`                 | OMP profile, passed as `--profile`. Empty for OMP's default profile.                             |
| `enabled`, `customModels` | Hidden from the form.                                                                            |

`OmpDriver.create` builds, per instance:

| Part                    | File                                         | Used for                                                                                                                |
| ----------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Sidecar resolver        | `sidecar.ts`, `sidecarInstall.ts`            | Finding, hashing and downloading the binary before every check and spawn ([sidecar.md](sidecar.md))                     |
| `OmpControlService`     | `control.ts`                                 | Every short-lived `omp` process ([sidecar.md](sidecar.md#control-processes))                                            |
| Command catalog         | `commands.ts`                                | The `/` and `$` menus per directory, cached 60 s ([commands.md](commands.md))                                           |
| Provider snapshot       | `status.ts`                                  | The status card and model list (below)                                                                                  |
| Pidfiles                | `pidfiles.ts`                                | Sweeping process trees an earlier server left ([processes.md](processes.md#pidfiles))                                   |
| Thread session registry | `threadSessions.ts`                          | Running threads, shared by the adapter and the settings engine                                                          |
| Orchestration adapter   | `adapter.ts`                                 | Threads (below)                                                                                                         |
| Text generation         | `textGeneration.ts`                          | Commit messages, PR text, branch names, titles ([sidecar.md](sidecar.md#text-generation))                               |
| `ompSettings`           | `settingsController.ts`, `settingsEngine.ts` | Settings pages and per-thread overrides ([settings.md](settings.md))                                                    |
| `ompAccounts`           | `accountsController.ts`                      | Sign-in and sign-out ([accounts.md](accounts.md))                                                                       |
| `ompSessions`           | `ompSessions.ts`                             | Listing OMP sessions to import ([sessions.md](sessions.md#import))                                                      |
| `ompAgentFiles`         | `agentFiles.ts`, `modelsCheck.ts`            | `WATCHDOG.yml`, `agents/`, `models.yml`, MCP and customization files ([settings.md](settings.md#agent-directory-files)) |
| `ompUsage`              | `usageController.ts`                         | The Usage page's OMP tab (below)                                                                                        |
| `ompPlugins`            | `pluginsController.ts`                       | Plugins, marketplaces, update check, skills ([settings.md](settings.md#plugins-and-skills))                             |
| `ompThreadMenu`         | `threadMenuController.ts`                    | Export HTML, Share as gist, Share live, branch tree ([thread-menu.md](thread-menu.md))                                  |

The server reaches the controllers through `apps/server/src/ws.ts`, which finds the thread's or
the request's OMP instance and fails when it has no such controller.

## Status

`checkProvider` in `driver.ts` resolves the sidecar, then runs `control.probe`: `omp --version`,
then an RPC control process that must start with `ready`, answers `get_login_providers` and
`get_available_models`, and is stopped. `ompProviderSnapshot` (`status.ts`) turns the result into
the card:

| Outcome                                     | Status           | Message                                                             |
| ------------------------------------------- | ---------------- | ------------------------------------------------------------------- |
| Instance disabled                           | initial snapshot | none; nothing runs                                                  |
| No binary could be resolved                 | error            | why (missing, hash mismatch, cache permissions, download failure)   |
| OMP refuses RPC for want of a model         | warning          | `OMP_NEEDS_SETUP_MESSAGE`; the start of [onboarding](onboarding.md) |
| `--version` or the RPC process failed       | error            | which stage failed                                                  |
| `ready.contractVersion` is not `omp.lock`'s | error            | the version OMP speaks and the one Ompanel needs                    |
| Ready                                       | ready            | none, or a note that a custom binary is not checked                 |

Auth is "authenticated" when a login provider reports `authenticated`, and "unknown" otherwise,
since not every credential source is listed. The model catalog on the snapshot comes from
`get_available_models` ([models.md](models.md#model-catalog)).

## A thread's session

`makeOmpAdapter` (`adapter.ts`) implements the V2 provider adapter. Its capabilities are
`OMP_PROVIDER_CAPABILITIES` in the same file. Opening a session:

1. Writes the role chip and the tool guards into the thread's overlay (`syncRoleOverlay`,
   `syncToolGuard`; [models.md](models.md#role-chip), [security.md](security.md)).
2. Resolves the binary and starts `omp --mode rpc-ui` (`session.ts`, `launch.ts`,
   `rpcProcess.ts`), with a pidfile. The handshake checks the contract version
   ([processes.md](processes.md#handshake)).
3. Opens the thread's journal and reattaches a run the previous process left waiting
   (`journal.ts`; [journal.md](journal.md)).
4. Subscribes to subagent frames at level `progress` (`set_subagent_subscription`) and turns on
   OMP's `ask` dialog (`set_ask_dialog`).
5. Reopens the thread's OMP session with `switch_session`, or makes sure the process runs a fresh
   one (`sessionBinding.ts`; [sessions.md](sessions.md)).
6. Registers the thread with the instance's registry (`threadSessions.ts`), so settings overrides
   and "restart required" reach it.
7. Registers host tools and `/wt` handling (`hostTools.ts`; [host-tools.md](host-tools.md)).

A turn sends one `prompt`. Before it, the adapter names the session after the thread
(`set_session_name`) and, when the permission mode changed, sends `set_approval_mode`
([processes.md](processes.md#permission-mode-changes)). After it, it reads `get_state` and
`get_session_stats` with a 2 s limit each. Closing the session aborts a running turn, closes
stdin and lets OMP drain for up to 10 s before the tree is killed
([processes.md](processes.md#stopping)).

`planSelectionTransition` returns `restart_session` when a launch-scoped setting changed for the
session or the role chip changed; any other selection change applies within the session.

Rewind and fork use OMP's session tree (`sessionBranches.ts`); history pages come from
`get_messages_page` (`sessionHistory.ts`). Both are in [sessions.md](sessions.md#rewind-and-fork).

## Frames

`OmpThreadMapper` (`mapper.ts`) is pure state: the adapter feeds it one frame at a time with the
current time and sends the events it returns. Related pure modules:

| File             | Turns                                                              | Page                                 |
| ---------------- | ------------------------------------------------------------------ | ------------------------------------ |
| `mapper.ts`      | message, thinking, tool, compaction, notice and session frames     | [frames.md](frames.md)               |
| `ompCards.ts`    | tool `details` into structured tool cards and notices              | [frames.md](frames.md#tool-cards)    |
| `uiRequests.ts`  | `extension_ui_request` dialogs into approval and question cards    | [frames.md](frames.md#dialogs)       |
| `subagents.ts`   | `subagent_lifecycle` and `subagent_progress` into subagent records | [subagents.md](subagents.md)         |
| `goal.ts`        | OMP's goal into the provider thread's goal                         | [composer.md](composer.md#goal-mode) |
| `modelTraits.ts` | the model catalog and composer traits                              | [models.md](models.md)               |

Unknown frames are ignored, so a newer minor contract does not break a thread.

## Features gated on the contract

Code for an RPC command newer than some pins checks `ready.contractVersion` (or the pinned
version) with `contractAtLeast` before it uses the command, and leaves the feature off below it:

| Constant                       | Version | File                      | Feature                               |
| ------------------------------ | ------- | ------------------------- | ------------------------------------- |
| `OMP_TOOL_TOGGLE_CONTRACT`     | 1.1.0   | `hostTools.ts`            | terminal host tool in place of `bash` |
| `OMP_REVIVE_CONTRACT`          | 1.4.0   | `subagents.ts`            | revive a subagent                     |
| `OMP_HOST_CWD_CHANGE_CONTRACT` | 1.5.0   | `hostTools.ts`            | `/wt` through Ompanel's worktrees     |
| `OMP_LOGIN_INPUT_CONTRACT`     | 1.6.0   | `control.ts`              | API-key sign-in, masked prompts       |
| `OMP_COLLAB_CONTRACT`          | 1.7.0   | `threadMenuController.ts` | Share live                            |
| `OMP_VIBE_CONTRACT`            | 1.8.0   | `vibe.ts`                 | vibe mode                             |
| `OMP_WORKSPACE_TRUST_CONTRACT` | 1.9.0   | `toolGuards.ts`           | workspace trust                       |

A re-pin that reaches one of these versions turns the feature on. Replace any hand-written
stand-in for a wire type in the gated code with the vendored type then
([contract-bump.md](contract-bump.md)).

## Control service

`makeOmpControlService` (`control.ts`) runs every `omp` that is not a thread: one-shot CLI
commands and short RPC servers started with `--mode rpc --no-session --no-tools --no-extensions
--no-skills --no-rules --no-lsp --no-title`. Each operation has a deadline in
`OMP_CONTROL_TIMEOUTS_MS`; probe and usage results are cached 30 s
(`OMP_CONTROL_CACHE_TTL_MS`). A control server that needs no model of its own (sign-in,
sign-out, provider and command lists) is started again on a placeholder model when OMP refuses
to start without one, so a fresh install can still sign in. The full table of operations and
deadlines is in [sidecar.md](sidecar.md#control-processes).

## Usage

Two sources feed the Usage page:

- `usage.ts` (`ompUsageReader`, the driver's `usage`) reads token usage from OMP's session files:
  assistant `message` and `model_usage` entries. A `task` tool's summed usage is skipped, since
  each subagent's own transcript is read.
- `usageController.ts` (`ompUsage`) serves the OMP tab: account quotas from `omp usage --json`,
  the last 24 hours from `omp stats --json`, and `get_session_stats` of each running thread. Each
  source fails on its own.

In a thread, the context meter comes from `get_session_stats` and each assistant message's
`usage` ([frames.md](frames.md#usage-and-the-context-meter)).

## Telemetry

`telemetry.ts` records driver metrics only: driver kind, OMP version, error class and frame drops.
Every attribute must pass `OMP_METRIC_ATTRIBUTE_RULES` or is reported as `other`, so no prompt,
reply, path or secret becomes a label.

## Tests

The fake `omp` for thread processes, the control fake, the replay fixtures, the end-to-end
suites and the live suite are in [testing.md](testing.md).
