# OMP commands and skills

The composer's `/` menu and `$` skill picker for an OMP thread come from
`OmpCommandCatalog` (`packages/provider-omp/src/server/commands.ts`), one per
provider instance, keyed by the project directory. The instance's
`snapshotForCwd` returns the directory's lists; T's provider registry asks for
them when a composer opens on a project and again after its own 5-minute
workspace TTL.

## `/` commands

| Source                                            | When                                                         | Lists                                                                                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RPC `get_available_commands` in a control process | No thread has pushed a list for the directory                | OMP's builtins that run outside its TUI (`/fresh`, `/compact`, `/handoff`, `/security`, `/rename`, `/context`, `/usage`, ...) and the directory's file commands.             |
| `available_commands_update` from a thread's `omp` | At session start and whenever OMP's command metadata changes | Everything the session can run: builtins, file commands, and the extension, custom (`/review`, `/green`, `/annotate`) and MCP prompt commands a control process cannot load. |

The control process runs with `--no-extensions --no-tools` (see
[sidecar.md](./sidecar.md#control-processes)), so it never runs extension code
or starts MCP servers; that is why `/review` and other custom commands appear
only once a thread in the directory has started. A pushed list replaces the
discovered one, does not expire, and survives a forced refresh; each later push
replaces it again. The catalog puts every directory's lists on the provider
snapshot (`workspaceSnapshots`, at most 16), so a push reaches open composers
without a rescan.

Each entry keeps OMP's `name`, `description` and `input.hint`. Aliases and
subcommands are not shown; OMP still accepts them when typed. Commands with
source `skill` (`/skill:<name>`) are left out: skills have their own `$` picker.
Every list ends with `/goal` unless OMP lists one itself: OMP runs `/goal` only
in its TUI, and the adapter runs it over RPC (see
[composer.md](./composer.md#goal-mode)).

A picked command is sent as the prompt text. OMP runs builtins itself and
answers on the frame stream; commands that ask (the `/review` mode and PR
pickers) open `extension_ui_request` dialogs, shown as question cards (see
[frames.md](./frames.md#dialogs)).

## `$` skills

Skills come from `omp [--profile <name>] skill list <dir> --json` (CLI contract
`CliSkillList`). Each skill becomes a composer skill: `path` is its `SKILL.md`,
`scope` the level from `source` (`user`, `project`), and a skill with `hide`
(hidden from the model) is marked user-invocation-only; it is still offered.

The composer writes a picked skill as `$<name>`. OMP expands only
`/skill:<name>`, so before a prompt is sent the adapter rewrites the first
`$<name>` that names one of the directory's skills, at the start
(`$tdd fix it` → `/skill:tdd fix it`) or mid-prompt (`fix it $tdd` →
`fix it /skill:tdd`). OMP expands one skill per prompt; later mentions stay as
typed. Prompts that start with another `/` command, `!` or `$ ` are sent
unchanged, as is every prompt when the skill list cannot be read. OMP ignores
`/skill:` when its `skills.enableSkillCommands` setting is off.

## Caching

Discovered command lists and skill lists are kept 60 s per directory
(`OMP_COMMAND_CATALOG_TTL_MS`); callers asking for a directory at the same time
share one `omp`. A failed discovery is not kept. A forced workspace refresh
drops discovered lists and skill lists, not pushed command lists.
