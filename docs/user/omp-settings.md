# OMP settings

**Settings → OMP** edits the settings of the [OMP](./providers-omp.md) instance on your primary
environment. When that environment runs several OMP instances, pick one with **OMP instance**.
The pages read and write OMP's own configuration through the `omp` command, so a change made here
is the same as one made with `omp config set`, and the reverse.

## Pages

| Page              | What it covers                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------ |
| Models & Roles    | The model for each of OMP's roles (Default, Fast, Thinking, Architect, Subtask, Web search, ...) |
| Custom providers  | OMP's `models.yml`: your own providers and models, as a form or as YAML                          |
| Routing           | Retries, fallback chains and account policies                                                    |
| Thinking          | Default thinking level and thinking budgets                                                      |
| Advisor & Agents  | The advisor, per-subagent advisor rules, `WATCHDOG.yml` and your custom agents in `agents/`      |
| Sampling          | Temperature, top-p and other sampling values                                                     |
| Approvals & Tools | Approval rules per tool, ordered bash rules and tool options                                     |
| Memory            | The memory backend (`off`, `local`, `hindsight`, `mnemopi`, `sharpshooter`) and its options      |
| Context           | Compaction                                                                                       |
| Modes             | Plan, goal and loop modes                                                                        |
| Runtime           | The eval kernel and local tiny-model options                                                     |
| Search            | Web search providers                                                                             |
| Discovery         | Where OMP looks for skills, commands, MCP config and extra context files                         |
| MCP               | The MCP servers in OMP's `mcp.json` and `.mcp.json`                                              |
| Customization     | Skills, rules, prompts, hooks, tools and agents in OMP's agent directory                         |
| Plugins           | Plugins and marketplaces; see [OMP plugins and skills](./omp-plugins.md)                         |
| Skills            | The skills a new thread loads; see [OMP plugins and skills](./omp-plugins.md)                    |
| Terminal prefs    | Settings only OMP's terminal app reads, shown read-only                                          |

## Reading a field

Each field shows its effective value and where it came from: **Default**, **Global**,
**Project**, **Overlay**, **Runtime** or **Environment**.

- The pages write OMP's global settings. **Reset** appears when the global layer sets the field.
- A field set by an environment variable is read-only: "Set by an environment variable; change it
  where OMP is launched."
- Credentials (API keys, tokens) are never entered here. A stored one shows only as **Stored** and
  can be reset. Sign in under [OMP accounts](./omp-accounts.md) instead.
- A field marked **Restarts threads** is read only when an OMP thread starts. Open threads pick up
  the change after their session restarts; other changes apply to running threads live.
- Model and provider lists that can hold entries scoped to other folders are read-only here; edit
  them in OMP's config file.

`tools.approvalMode` on **Approvals & Tools** is OMP's default for `omp` run outside Ompanel.
Ompanel threads always use the thread's [permission mode](./permission-modes.md) instead.

## Custom providers

**Custom providers** edits `models.yml` in OMP's agent directory. The form and the YAML editor
change the same text; the form keeps comments and keys it does not show. Before saving, Ompanel
asks OMP to load the new file in a scratch directory. If OMP rejects it, the save fails and the
real file is untouched. A new file is created readable only by you, since it can hold keys.

## Agent files and customization

**Advisor & Agents** edits the user advisor roster (`WATCHDOG.yml`) and your custom subagents
(`agents/*.md`). **Customization** lists and opens skills, rules and prompts (which you can also
create) and hooks and tools (open only, since they are code). **Unpack bundled agents** copies
OMP's built-in agents into `agents/` without overwriting a file.

These files live in the agent directory of the instance's OMP profile: `~/.omp/agent`, or
`~/.omp/profiles/<profile>/agent`. Open threads may keep the advisor roster they loaded until
they restart.

## Mobile

On the mobile app, **Settings → OMP** shows every page's fields read-only: value, source and
restart note. Edit settings on web or desktop.
