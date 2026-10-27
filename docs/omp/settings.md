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
- One exception: a credential OMP resolves through its config-value resolver
  (`OMP_SECRET_REFERENCE_KEYS` in `configForm.ts`, today `auth.broker.token`)
  may be set to where OMP reads the secret instead of the secret: an
  upper-case environment variable name or a `!command` OMP runs and reads
  stdout from (`resolveConfigValue`, `auth-broker/discover.ts`). Anything else,
  including a token itself, is refused as a credential (`isOmpSecretReference`).

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

| Key                           | Why it needs a restart (O main `a3aff57a7e`)                                                                                |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `memory.backend`              | `sdk.ts` `startMemoryBackend` resolves and starts the backend once per session                                              |
| `mnemopi.embeddingModel`      | read when the Mnemopi backend starts (`mnemopi/config.ts`); its description says so too                                     |
| `mcp.startupTimeoutMs`        | only used by MCP discovery during session construction (`sdk.ts`)                                                           |
| `plan.enabled`                | decides plan-mode tool wiring when the tool registry is built (`sdk.ts`)                                                    |
| `plan.defaultOnStartup`       | read only at startup (`main.ts`)                                                                                            |
| `goal.enabled`                | the goal tool registers at construction; turning it off never unregisters it                                                |
| `telemetry.otlpExportEnabled` | OMP registers its OTLP exporters once at startup (`main.ts`, `telemetry-export.ts`); its own description says "next launch" |

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
through `provider_session.updated`. The web thread view shows "Restart to apply"
and the keys above the composer (`useRestartRequiredBanner`), and the mobile thread
screen a matching card (`RestartRequiredCard`), both with a Restart button
that is held while a turn runs. Restart stops the thread's session, as the
thread's stop-session command does; the next turn starts a replacement that
reads the current settings and starts clean. The next model selection change
on a marked session also returns `restart_session` from
`planSelectionTransition`.

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

Plugins and skills (`ompPlugins` on the instance) have their own methods, all
`providers:manage`: `server.listOmpPlugins`, `server.runOmpPluginCommand`,
`server.discoverOmpMarketplace`, `server.reloadOmpPlugins`,
`server.checkOmpUpdate` and `server.listOmpSkills`. Their errors are
`OmpPluginsOperationError` and never carry `omp` output, which can echo a spec
or URL with credentials in it; spans record only the action.

A `projectId` selects the project layer, at the project's workspace root.
Without one, calls run in `<stateDir>/omp`, which has no project config. Errors
are `OmpSettingsOperationError` and never carry `omp` output.

## Settings pages

Settings → OMP Models & Roles, Routing, Thinking, Advisor & Agents, Sampling,
Approvals & Tools, Memory, Context, Modes, Runtime, Search, Discovery, MCP,
Customization, Plugins, Skills, Terminal prefs and All settings (advanced) each show a slice of
the engine's form for the primary environment's OMP instance (a picker appears
when it runs several). They add no write path of their own; env-set keys stay
read-only and credentials reset-only. The key
lists live in `OMP_SETTINGS_PAGES` (`packages/provider-omp/src/settingsPages.ts`);
a key ending in `.` takes the whole group. A test checks every listed key
against the pinned registry. Custom providers has no keys: it edits
`models.yml` only (below). [settings-mapping.md](settings-mapping.md) lists,
per page, the keys, files, server methods and `omp` commands it uses.

All settings (advanced) (`remainder` in `OMP_SETTINGS_PAGES`) lists, in key
order, every key `config list` reports that no other page lists, minus the keys
another part of Ompanel shows (`OMP_SETTINGS_SHOWN_ELSEWHERE`: `auth.broker.url`
and `auth.broker.token`, on Accounts). A unit test checks that every key the
pinned OMP registers is on a page, on the advanced page or on that list, and the
G2 E2E checks the same for a real `omp config list`.

### Global and project layer

When the environment has projects, each settings page has a layer switch:
Global, or Project: `<title>`. Global reads in Ompanel's own directory (no
project config) and writes `omp config set --scope global`. A project reads
`config list --cwd <workspaceRoot>`, so values show what applies in that
project and the source badge says Project where its `.omp/config.yml` sets a
key; writes and Reset go to that file (`--scope project --cwd <workspaceRoot>`).
Reset is offered only for keys the selected layer sets. A project change marks
only threads inside that project restart required. Map settings (`record` type,
such as `modelRoles` or `tools.approval`) are read-only on a project: OMP
deep-merges maps across layers and reports only the merged map, so writing it
back would copy every global entry into the project and a removed entry would
merge back in. Edit them on Global; a project's own entries go with Reset.

The pages fit a 390px phone viewport (browser tests render each page in the settings column
beside the collapsed nav rail). Mobile has Settings → OMP: every page's fields as read-only
summaries (value, source layer, restart note; credentials show only whether one is stored).
Editing stays on web and desktop; OMP sign-in on mobile lives under Provider accounts
([accounts.md](accounts.md)).

**Mobile.** Below each OMP instance's settings, Settings → OMP on mobile also lists, read-only
and over the same RPCs as web: Plugins (installed plugins with version, source, enabled and
project-override state, plus marketplaces) and Skills (name, source, hidden flag, path, OMP's
warnings) from `server.listOmpPlugins` and `server.listOmpSkills`; Advisor & Agents files, MCP
servers (name, transport, command or URL, disabled, file state) and Customization files by kind
from one `server.listOmpAgentFiles` read; and OMP sessions, one project at a time from
`server.listOmpSessions`. Each part loads and fails on its own. Mobile has no install, enable,
reload, update check, open, create, unpack or import action: those change the host and stay on
web and desktop. Session import in particular creates a thread and is not offered on mobile.

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
| Runtime           | `eval.*` (incl. `eval.py`, `eval.js`), `providers.tinyModelDevice`, `providers.tinyModelDtype`, `telemetry.otlpExportEnabled`, plus a read-only PTY row                                                      |
| Search            | `web_search.enabled`, `modelRoles` (`web` role only), `retry.fallbackChains` (`web` chain only), `providers.webSearchTimeoutSeconds`, `exa.*`, `searxng.*`                                                   |
| Discovery         | `enabledProviders` / `disabledProviders` (read-only), `skills.enabled`, `skills.enable*` sources, `commands.enableClaudeUser/Project`, `mcp.enableProjectConfig`, `contextFiles.extra`                       |
| MCP               | `mcp.*`, plus the MCP server list below                                                                                                                                                                      |
| Customization     | `ttsr.*`, `skills.customDirectories`, `skills.ignoredSkills`, `skills.includeSkills`, plus the agent-directory files below                                                                                   |
| Plugins           | `extensions`, `disabledExtensions`, `extensionHandlers.*`, `marketplace.*`, plus the plugin list, marketplaces and update check below                                                                        |
| Skills            | `skills.registryUrl`, plus the resolved skill list below                                                                                                                                                     |
| Terminal prefs    | `startup.*`, `theme.*`, `statusLine.*`, `tui.*`, `terminal.*`, all read-only and marked terminal-only, plus a `keybindings.yml` note                                                                         |
| All settings      | every other key, in key order (e.g. `bash.enabled`, `browser.*`, `ask.*`, `async.*`, `autoResume`)                                                                                                           |

`modelRoles` covers OMP's 16 roles: `default smol slow vision plan commit tiny
memory task advisor widget image web speech dictation judge` (OMP has no
`designer` role). Clearing a role's model removes it from the record. The PRD's
top-level `fallbackChains` is `retry.fallbackChains` in OMP.

`enabledModels`, `enabledProviders` and `disabledProviders` accept path-scoped
entries (`{path, models}` / `{paths, providers}`). `config list` returns them
already resolved for its working directory, so writing the shown value back would
delete every entry scoped to another folder. With an OMP that lists a layer as
written (`omp config list --scope global --json`, CLI contract 1.1.0,
oh-my-pi#60), the engine reads the global layer next to every `config list` and
gives these fields `globalEntries`; the web pages then edit the global list's
plain entries (one per line) and list the folder entries read-only. Every write
appends the global layer's folder entries again, and Reset removes only the plain
entries. Project-scope writes of these keys are refused (`path_scoped`). With the
pinned OMP, which refuses `--scope` on `list`, the fields stay read-only, as on
mobile.

### Memory, runtime, search and terminal prefs

OMP starts protocol sessions (RPC, ACP) with `memory.backend` off unless a
config layer sets it, so the Memory page's global value is what turns memory on
for Ompanel threads.

OMP has no PTY setting. `--no-pty` and `PI_NO_PTY` turn it off in the terminal
app, and `rpc-ui` mode (Ompanel's threads) always runs bash without one, so the
Runtime page shows PTY as a read-only row.

OMP's own telemetry is OMP's setting. OMP exports traces, logs and metrics only
when `telemetry.otlpExportEnabled` is on and an `OTEL_EXPORTER_OTLP_*` endpoint
is in its environment. Ompanel passes the user's environment through unchanged
and never sets `telemetry.*` or any `OTEL_*` variable itself (`driver.test.ts`,
"never sets OMP telemetry or OTEL_* beyond the user's environment"); the
Runtime page turns the export off or on.

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
| `server.unpackOmpAgents`    | `providers:manage` |

Errors are `OmpAgentFilesOperationError`. OMP reads the advisor roster when a
thread starts, so open threads may keep the roster they loaded until they
restart.

### Custom providers (`models.yml`)

Settings → OMP → Custom providers edits `models.yml` (or `models.yaml` when
only that exists) as a form and as YAML; both change the same unsaved text,
and the form changes only the keys it shows (comments and other keys are
kept). A new file is created owner-only (`0600`): it can hold literal keys.
When only a legacy `models.json` exists, nothing is created until OMP has
migrated it.

A save is checked by OMP before the file is replaced
(`packages/provider-omp/src/server/modelsCheck.ts`): the text, plus one marker
provider with a static model, goes into an owner-only scratch agent directory,
and `omp --mode rpc --no-session --no-tools … --approval-mode always-ask` runs
there (`PI_CODING_AGENT_DIR`, profile variables dropped) and answers
`get_available_models` (15 s deadline). OMP validates `models.yml` on load and
drops every custom provider when it rejects it, so the marker's model is
listed exactly when OMP accepted the file. If it is missing, or OMP quits
before `ready`, the write fails `invalid` and the real file is untouched. The
scratch directory is removed afterwards. `apiKey: "!command"` values run as
they would in any OMP session. `T3_TEST_OMP_BINARY=<omp> vp test` runs the
check against a real omp under a throwaway HOME.

### MCP and Customization

Settings → OMP → MCP lists the servers in `mcp.json` and `.mcp.json` of the
agent directory (name, transport, command or URL without query or
credentials; never arguments, headers or environment) and opens either file;
new ones are created owner-only. A repository's `.omp/mcp.json` is not shown.
Ompanel's own MCP server is separate; its URL is under Settings → Connections.

Settings → OMP → Customization lists and opens, at the paths OMP discovers
them: `skills/<name>/SKILL.md` and `managed-skills/<name>/SKILL.md`,
`rules/*.{md,mdc}` and `RULES.md`, `prompts/*.md`, `hooks/{pre,post}/*`,
`tools/*.{json,md,ts,js,sh,bash,py}` and `tools/<name>/index.ts`, plus
`agents/*.md`. Paths are checked against
`ompCustomizationPathAllowed`; every folder on the way and the file
itself must resolve inside the agent directory (a folder linking out is not
listed). New skills, rules and prompts can be created there; hooks and tools
are code and are only opened. "Unpack bundled agents" runs
`omp [--profile p] agents unpack --user --json`, which never overwrites a file.

## Plugins and Skills

Settings → OMP → Plugins runs the pinned `omp` in the instance's state
directory (no project config, so everything is user scope):

| What the page does           | Command                                                    | Deadline |
| ---------------------------- | ---------------------------------------------------------- | -------- |
| List installed plugins       | `omp [--profile p] plugin list --json`                     | 15 s     |
| List marketplaces            | `omp [--profile p] plugin marketplace list` (text)         | 15 s     |
| Browse one marketplace       | `omp [--profile p] plugin discover <name>` (text)          | 15 s     |
| Install                      | `omp [--profile p] plugin install <spec>`                  | 180 s    |
| Uninstall / enable / disable | `omp [--profile p] plugin uninstall\|enable\|disable <id>` | 180 s    |
| Add / remove a marketplace   | `omp [--profile p] plugin marketplace add\|remove <x>`     | 180 s    |
| Check for updates            | `omp [--profile p] update --check` (text)                  | 20 s     |

The pinned omp prints `marketplace list`, `discover` and `update --check` as
text only; Ompanel strips terminal escapes and reads the lines
(`parseOmpMarketplaceList`, `parseOmpMarketplaceDiscover`,
`parseOmpUpdateCheck` in `control.ts`).

The provider probe runs the same `update --check` after each snapshot
(`makeOmpUpdateNotice` in `updateNotice.ts`, from the driver's
`enrichSnapshot`), never ahead of it. An `available` answer becomes the
snapshot's `versionAdvisory` (`behind_latest`, `canUpdate: false`, no update
command; `ompVersionAdvisory` in `status.ts` words it for the pinned sidecar or
a custom binary), so the provider card shows the notice without a click. Answers
are cached per binary identity for an hour, failures for five minutes; a failed
check adds no advisory. It is skipped when the probe found no usable omp or
the server's `enableProviderUpdateChecks` is off.

Every change goes through one confirmation dialog that shows the exact command
line (`formatOmpCommandLine` over `ompPluginCommandArgs`, the same arguments
the server runs). Install, enable and adding a marketplace also say the plugin
or catalog is third-party code: a plugin runs with the user's permissions in
every thread, and its tools reach the agent as `xd://` devices. A spec, name or
source must be one argument with no control characters, surrounding space or
leading `-` (`ompPluginTargetAllowed`), so it never reads as a flag; a leading
`~` is refused as well, since no shell expands it on the way to omp. The shown
line quotes every argument a shell would expand (`[ ]`, `~`, `=`, spaces), so
pasting it into a terminal passes omp the same arguments. A command
that exits non-zero reports only its exit code; run the shown command in a
terminal to see OMP's message.

**Reload plugins** sends OMP's builtin `/reload-plugins` as an RPC `prompt` to
every running thread of the instance that is not mid-turn (OMP answers it
locally, `agentInvoked: false`); busy threads are counted and left alone, and
new threads load plugins when they start. Changes and reloads drop the
instance's per-workspace command and skill catalog.

The update check only reports. The sidecar is pinned, so a newer OMP reaches
Ompanel with an app update; Ompanel never runs `omp update`.

The MCP page carries the same third-party note for MCP servers, whose tools OMP
mounts as `xd://` devices by default (`tools.xdev`).

Settings → OMP → Skills lists `omp [--profile p] skill list <state dir> --json`:
user skills, other agents' user skills and plugin skills, with OMP's `source`,
the hidden flag and OMP's warnings. **Open in editor** opens the `SKILL.md` in
the preferred editor. A repository's own skills show in its threads' `$` menu.
