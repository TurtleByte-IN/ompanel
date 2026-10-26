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
- A stored credential (a redacted field) is never replaced through the engine.
  `config set` takes the value in argv, which other local users can read, and
  an overlay would copy it to disk. It can still be reset. OMP marks a
  credential only once it holds a value, so an unset credential key still
  looks like a plain string field.

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

- If OMP has a session-only RPC command for the key, the engine sends it. The
  thread must be running. These commands never write `config.yml`:
  `tools.approvalMode` → `set_approval_mode`, `advisor.enabled` → `set_advisor`,
  `defaultThinkingLevel` → `set_thinking_level`, `steeringMode` /
  `followUpMode` / `interruptMode` → `set_*_mode`, `compaction.enabled` →
  `set_auto_compaction`, `retry.enabled` → `set_auto_retry`,
  `providers.cacheWarming` → `set_cache_warming`. Clearing the override sends
  the value the config layers resolve to.
- For any other key, the engine edits the thread's `--config` overlay. The
  overlay is a comment line followed by JSON, which OMP's YAML loader reads
  unchanged. OMP reloads the overlay live, so only launch-scoped keys mark the
  thread "restart required".

The engine reaches threads through `OmpThreadSettingsHost`. The thread session
layer implements it, and it must keep an existing overlay when it respawns a
thread.
