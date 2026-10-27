# OMP plugins and skills

## Plugins

**Settings → OMP → Plugins** lists the plugins (**Installed**) and **Marketplaces** of the OMP
instance's profile. You can:

- **Install** a plugin: an npm package, `github:user/repo`, a git URL, a local path, or
  `name@marketplace` picked from **Browse**.
- **Enable**, **Disable** or **Uninstall** a plugin.
- **Add marketplace** or **Remove marketplace**.

Before anything runs, the page shows "Ompanel will run this command:" with the exact
`omp plugin` command and waits for you to confirm. Plugins install for your user, never into a
project.

Plugins are third-party code. An enabled plugin runs on your machine with your permissions in
every OMP thread: its tools, hooks, commands, skills and MCP servers. Install only what you
trust.

New threads load plugins when they start. **Reload plugins** also reloads them in running
threads that are not in the middle of a response.

### OMP updates

**Check for updates** runs `omp update --check`, which only says whether a newer OMP exists. OMP
updates arrive with Ompanel updates; Ompanel does not update OMP on its own. See
[Updating Ompanel](./updating.md).

## Skills

**Settings → OMP → Skills** lists the skills a new OMP thread loads, including those plugins
bring, and opens any of them in your editor. To create a skill, use
**Settings → OMP → Customization** ([OMP settings](./omp-settings.md#agent-files-and-customization)).

Use a skill in a thread by mentioning it as `$<name>` in your message (Ompanel sends the first
such mention to OMP as `/skill:<name>`), or let the agent pick it.

## Limits

- Plugin commands have a deadline: three minutes to install, change or remove, 15 seconds to
  list or browse.
- **Settings → OMP → Discovery** controls which other sources (Claude Code commands, project MCP
  config) OMP reads skills and commands from.
- Project-level plugins, MCP servers and hooks from a repository's `.omp/` load only when you
  trust the project; see [Workspace trust and approvals](./workspace-trust.md).
