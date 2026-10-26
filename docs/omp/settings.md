# OMP settings

Ompanel never keeps its own copy of OMP's settings schema. The settings engine
(`packages/provider-omp/src/server/settingsEngine.ts`) builds every form from
`omp config list --json --cwd <project>` and writes only through `omp config set`
and `omp config reset`, using OMP's CLI JSON contract 1.0.0.

## Rules the engine enforces

- Each field shows the effective value and the layer that supplied it:
  `default`, `global`, `project`, `overlay`, `runtime` or `env`.
- A field whose source is `env` is read-only: set, reset and thread overrides
  are refused before any `omp` process starts.
- Writes run `omp config set --scope global|project --cwd <project> --json -- <key> <JSON>`.
  The value is JSON for every type, which OMP's parser accepts, and the `--`
  stops a negative number from being read as a flag. The engine then re-reads
  `config list` rather than trusting the `set` output (oh-my-pi#23).
- There is no `config get` anywhere in Ompanel. It prints credentials unmasked;
  `config list` withholds them (`redacted: true`, no `value`).
- A credential is never set through the engine, stored or not. `config set`
  takes the value in argv, which other local users can read, and an overlay
  would copy it to disk. A credential can still be reset, and its value never
  reaches the client. OMP redacts a credential only once it holds a value, so
  the engine does not trust `config list` for this. It fails closed: a key is
  a credential unless the pinned OMP registers it without a credential marker
  (`credential: true` or `ui.secret`). Text and record keys whose last word
  names a secret (`…Token`, `…Password`, `…ApiKey`) count as well. The
  registered keys and credentials live in `src/ompSettingKeys.generated.ts`,
  generated from the pinned tag's settings registry.

## Launch-scoped keys

A running RPC omp applies most edits live. It watches `config.yml`, project
settings and `--config` overlays (`main.ts`, `startWatching` for `rpc` and
`rpc-ui`), and its consumers re-read settings or subscribe to them. A key is
launch-scoped when the session reads it only while it starts. A global change
to such a key marks every open thread on the instance "restart required". A
project change marks only threads whose working directory is inside that
project.

The list lives in `OMP_LAUNCH_SCOPED_KEYS` (`packages/provider-omp/src/configForm.ts`).
It was derived from O main `a3aff57a7e`. The scan collected every setting
`createAgentSession` (`sdk.ts`) reads, dropped those covered by a `.listen()`
or `onEffectiveChange` subscription anywhere in `packages/coding-agent/src`,
and dropped those read again on each use.

| Key                      | Why it needs a restart (O main `a3aff57a7e`)                                            |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `memory.backend`         | `sdk.ts` `startMemoryBackend` resolves and starts the backend once per session          |
| `mnemopi.embeddingModel` | read when the Mnemopi backend starts (`mnemopi/config.ts`); its description says so too |
| `mcp.startupTimeoutMs`   | only used by MCP discovery during session construction (`sdk.ts`)                       |
| `plan.enabled`           | decides plan-mode tool wiring when the tool registry is built (`sdk.ts`)                |
| `plan.defaultOnStartup`  | read only at startup (`main.ts`)                                                        |
| `goal.enabled`           | the goal tool registers at construction; turning it off never unregisters it            |

Re-check the list when the pin moves. The CLI contract does not report
launch scope yet, so the list is maintained by hand.

## Per-thread overrides

An override changes one key for one thread:

- If the pinned RPC contract has a session-only command for the key, the
  engine sends it to the running thread. These commands never write
  `config.yml`: `defaultThinkingLevel` → `set_thinking_level`, `steeringMode` /
  `followUpMode` / `interruptMode` → `set_*_mode`, `compaction.enabled` →
  `set_auto_compaction`, `retry.enabled` → `set_auto_retry`,
  `providers.cacheWarming` → `set_cache_warming`. The thread must be running.
  Clearing the override sends the value the config layers resolve to.
- `tools.approvalMode` cannot be overridden per thread. Every thread starts
  with `--approval-mode` from its runtime mode, and a flag outranks overlays.
- For any other key, the engine edits the thread's `--config` overlay. The
  overlay is a comment line followed by JSON, which OMP's YAML loader reads
  unchanged. It is replaced by a rename, so OMP's live reload never reads half
  a file. OMP reloads the overlay live, so only launch-scoped keys mark the
  thread "restart required". The overlay survives a respawn.

The engine does not use `set_advisor` (O-2, in the pinned contract since
1.3.0): `advisor.enabled` goes through the overlay, which OMP applies live.

## Restart required

The adapter registers every running thread with the instance's thread
registry (`server/threadSessions.ts`). When a launch-scoped key changes for
a thread, the session's provider state gains `restartRequired: [keys]`
(`OrchestrationV2ProviderSession`), which reaches the thread projection
through `provider_session.updated`. The next model selection change on that
session returns `restart_session` from `planSelectionTransition`. Stopping
the thread's session also restarts it, and its replacement starts clean.

## Server API

The OMP provider instance exposes the engine as `ompSettings`. The server
serves it over these RPC methods:

| Method                          | Scope                   |
| ------------------------------- | ----------------------- |
| `server.readOmpSettings`        | `orchestration:read`    |
| `server.writeOmpSetting`        | `providers:manage`      |
| `server.resetOmpSetting`        | `providers:manage`      |
| `server.setOmpThreadOverride`   | `orchestration:operate` |
| `server.clearOmpThreadOverride` | `orchestration:operate` |

A `projectId` selects the project layer, at the project's workspace root.
Without one, calls run in `<stateDir>/omp`, which has no project config. Errors
are `OmpSettingsOperationError` and never carry `omp` output.

## Settings pages

Settings → OMP Models & Roles, Routing, Thinking, Advisor & Agents, Sampling,
Approvals & Tools, Memory, Context, Modes, Runtime, Search, Discovery and
Terminal prefs each show a slice of
the engine's form for the primary environment's OMP instance (a picker appears
when it runs several). The pages write the global layer and add no write path
of their own; env-set keys stay read-only and credentials reset-only. The key
lists live in `OMP_SETTINGS_PAGES` (`packages/provider-omp/src/settingsPages.ts`);
a key ending in `.` takes the whole group. A test checks every listed key
against the pinned registry.

The pages fit a 390px phone viewport (browser tests render each page in the settings column
beside the collapsed nav rail). Mobile has Settings → OMP: every page's fields as read-only
summaries (value, source layer, restart note; credentials show only whether one is stored).
Editing stays on web and desktop; OMP sign-in on mobile lives under Provider accounts
([accounts.md](accounts.md)).

| Page              | Keys                                                                                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Models & Roles    | `modelRoles` (one field per role), `modelRoleStorage`, `modelTags`, `modelProviderOrder`, `cycleOrder`, `enabledModels`, `disabledProviders`, `includeModelInPrompt`                                         |
| Routing           | `retry.*` (incl. `retry.fallbackChains`), `auth.accountPolicies`, `task.agentAccountPools`, `enabledModels` / `enabledProviders` / `disabledProviders` (read-only), `providers.anthropic.serverSideFallback` |
| Thinking          | `defaultThinkingLevel`, `hideThinkingBlock`, `thinkingBudgets.*`, `providers.autoThinkingMaxEffort`                                                                                                          |
| Advisor & Agents  | `advisor.*`, `task.agentAdvisor` (one rule per subagent: `on`, `off` or a model), plus the `WATCHDOG.yml` and `agents/` file editors below                                                                   |
| Sampling          | `temperature`, `topP`, `topK`, `minP`, `presencePenalty`, `repetitionPenalty`, `textVerbosity`, `personality`, `tier.*`                                                                                      |
| Approvals & Tools | `tools.approvalMode`, `tools.approval` (rules editor), `bash.patterns` (ordered rules editor), `bashInterceptor.*`, `tools.intentTracing`, `tools.xdev`, `tools.xdevDocs`, `tools.xdevInlineDevices`         |
| Memory            | `memory.backend` (`off` `local` `hindsight` `mnemopi` `sharpshooter`), `memories.*` (local), `hindsight.*`, `mnemopi.*`, `sharpshooter.*`; `hindsight.apiToken`, `mnemopi.*ApiKey` are reset-only            |
| Context           | `compaction.*` (incl. `compaction.methodOrder`)                                                                                                                                                              |
| Modes             | `plan.*`, `goal.*`, `loop.*`                                                                                                                                                                                 |
| Runtime           | `eval.*` (incl. `eval.py`, `eval.js`), `providers.tinyModelDevice`, `providers.tinyModelDtype`, plus a read-only PTY row                                                                                     |
| Search            | `web_search.enabled`, `modelRoles` (`web` role only), `retry.fallbackChains` (`web` chain only), `providers.webSearchTimeoutSeconds`, `exa.*`, `searxng.*`                                                   |
| Discovery         | `enabledProviders` / `disabledProviders` (read-only), `skills.enabled`, `skills.enable*` sources, `commands.enableClaudeUser/Project`, `mcp.enableProjectConfig`, `contextFiles.extra`                       |
| Terminal prefs    | `startup.*`, `theme.*`, `statusLine.*`, `tui.*`, `terminal.*`, all read-only and marked terminal-only, plus a `keybindings.yml` note                                                                         |

`modelRoles` covers OMP's 16 roles: `default smol slow vision plan commit tiny
memory task advisor widget image web speech dictation judge` (OMP has no
`designer` role). Clearing a role's model removes it from the record. The PRD's
top-level `fallbackChains` is `retry.fallbackChains` in OMP.

`enabledModels`, `enabledProviders` and `disabledProviders` accept path-scoped
entries (`{path, models}` / `{paths, providers}`). `config list` returns them
already resolved for its working directory, and the engine has no raw read, so
writing the shown value back would delete every entry scoped to another
folder. The pages show these three read-only (`OMP_PATH_SCOPED_KEYS`), with no
Reset; edit them in OMP's config file.

### Memory, runtime, search and terminal prefs

OMP starts protocol sessions (RPC, ACP) with `memory.backend` off unless a
config layer sets it, so the Memory page's global value is what turns memory on
for Ompanel threads.

OMP has no PTY setting. `--no-pty` and `PI_NO_PTY` turn it off in the terminal
app, and `rpc-ui` mode (Ompanel's threads) always runs bash without one, so the
Runtime page shows PTY as a read-only row.

`web_search` picks providers through the `web` model role: `modelRoles.web`
is the first `web/<provider>` selector and `retry.fallbackChains.web` the rest
(OMP migrated the old `providers.webSearch*` order there). The Search page
edits only those two entries and writes every other role and chain back as it
read them. It offers no Reset on `modelRoles` or `retry.fallbackChains`, since a
Reset clears the whole key in the global layer (every role, every chain);
clearing the web field removes just the `web` entry.

Terminal prefs (`terminalOnly` in `OMP_SETTINGS_PAGES`) are read only by OMP's
terminal UI; every field there is read-only, with no Reset. `keybindings.yml` is
a file in the agent directory, not a setting.

PRD §7 keys the pinned OMP does not register: `compaction.strategy` (now
`compaction.methodOrder`), any PTY key, a `web_search` provider-order key (now
the `web` role) and an Exa API key (`exa.*` has only `enabled` and
`searchDelayMs`; the key comes from sign-in or `EXA_API_KEY`). A test asserts
these stay absent.

### Approvals

`tools.approvalMode` on the page is OMP's default for `omp` run outside
Ompanel. Ompanel threads always launch with `--approval-mode` from their
permission mode (Supervised → `always-ask`, Auto-accept edits → `write`, Full
access → `yolo`), which outranks the setting; the page says so next to the
control, and a test keeps that text in step with `ompApprovalModeFor`.

`tools.approval` maps a tool (or a policy key such as `write`) to `allow`,
`prompt` or `deny`, and applies in every mode. `bash.patterns` is an ordered
list of `{match, approval}` with `*` as the only wildcard. Both editors change
one entry per write and pass every other entry through unchanged, including
values OMP would ignore (shown as such, removable).

## Agent directory files

Advisor & Agents also edits two kinds of files in the instance's OMP agent
directory:

- `WATCHDOG.yml`, the user-level advisor roster (`advisor/config.ts`). When only
  `WATCHDOG.yaml` exists, that file is edited in place, as OMP's own
  `/advisor configure` does. Project-level `WATCHDOG.yml` files are not edited
  here.
- `agents/*.md`, the user's custom subagents (`task/discovery.ts`).

The directory is what `omp [--profile <p>] config path` prints for the
instance, so it follows the instance's profile (`~/.omp/profiles/<p>/agent`),
`OMP_PROFILE` and `PI_CODING_AGENT_DIR`; the default profile is
`~/.omp/agent`. It is asked on every call.
One gap is OMP's: with a custom `PI_CODING_AGENT_DIR` (no named profile), OMP's
subagent discovery still reads `~/.omp/agent/agents`, while `config path`,
`WATCHDOG.yml` and `omp agents unpack` use the override (#83).

The server reaches nothing outside that directory
(`packages/provider-omp/src/server/agentFiles.ts`):

- agent names must be plain `.md` names (`OMP_AGENT_FILE_NAME_PATTERN`): no
  folders, no leading dot. Other `.md` files OMP loads are listed as not
  editable.
- `agents/` and each file may be links only if they resolve inside the agent
  directory (which may itself be a link, e.g. into a dotfiles checkout); a
  write through such a link changes its target, a delete removes the link.
  Reads open the resolved file with `O_NOFOLLOW`.
- files must be UTF-8 text up to 512 KiB.
- a write names the version (sha256) it read, or none to create; a changed or
  already-existing file fails `conflict`. A write goes to a temporary file
  beside the target, then one rename.

| Method                      | Scope              |
| --------------------------- | ------------------ |
| `server.listOmpAgentFiles`  | `providers:manage` |
| `server.readOmpAgentFile`   | `providers:manage` |
| `server.writeOmpAgentFile`  | `providers:manage` |
| `server.deleteOmpAgentFile` | `providers:manage` |

Errors are `OmpAgentFilesOperationError`. OMP reads the advisor roster when a
thread starts, so open threads may keep the roster they loaded until they
restart.
