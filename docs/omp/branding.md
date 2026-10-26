# Branding

Ompanel is a fork of [T3 Code](https://github.com/pingdotgg/t3code). "T3" and "Theo" are not
covered by upstream's MIT grant, so the product carries its own name, identifiers, links and
artwork, and keeps upstream's `LICENSE` with a TurtleByte copyright line added.

## The brand module

[`packages/shared/src/brand.ts`](../../packages/shared/src/brand.ts) (`@t3tools/shared/brand`)
holds the identity values: the lowercase slug and CLI command, environment prefix, home
directory, reverse-DNS app id and repository. Code that needs one of these imports it instead of
repeating the literal, so a value changes in one place. `packages/contracts` cannot import
`shared`, so the few contract values that name the product (such as the default worktree branch
prefix) are plain literals.

| Value                                     | Ompanel                                                              | Upstream             |
| ----------------------------------------- | -------------------------------------------------------------------- | -------------------- |
| Product                                   | `Ompanel`                                                            | `T3 Code`            |
| CLI, executable, URL scheme, systemd unit | `ompanel` (`ompanel-dev` in development)                             | `t3`, `t3code`       |
| Environment variables                     | `OMPANEL_*`                                                          | `T3CODE_*`           |
| Home directory                            | `~/.ompanel`                                                         | `~/.t3`              |
| Worktree branch prefix                    | `ompanel/`                                                           | `t3/`                |
| App, bundle and package id, launchd label | `in.turtlebyte.ompanel` (`.dev`, `.preview`)                         | `com.t3tools.t3code` |
| Releases, update feed, model manifest     | `TurtleByte-IN/ompanel`                                              | `pingdotgg/t3code`   |
| Product analytics                         | none unless `OMPANEL_POSTHOG_KEY` and `OMPANEL_POSTHOG_HOST` are set | `ingest.t3.codes`    |

Different OS identities let Ompanel and T3 Code be installed side by side without sharing a
profile, URL handler, background service or desktop control socket.

## Environment variables

Every `T3CODE_*` variable is now `OMPANEL_*`, and the old names are not read, not even for one
release. A fallback would let an ambient `T3CODE_HOME` set for T3 Code point Ompanel at T3 Code's
live database. [Moving from T3 Code](../user/install.md#moving-from-t3-code) tells users to rename
theirs.

## Moving data from `~/.t3`

The only compatibility path is a one-time copy of the upstream home, in
[`apps/server/src/legacyHomeMigration.ts`](../../apps/server/src/legacyHomeMigration.ts). It runs
when the server starts on the default production state directory (`~/.ompanel/userdata`), which
also covers the desktop app because it passes that directory to its backend.

- It copies `~/.t3/userdata` into a staging directory, then moves entries into place, database
  files last, and writes `~/.ompanel/legacy-home-migration.json`. The marker makes later starts a
  no-op, and an interrupted run redoes the copy.
- It never writes to `~/.t3`. Worktrees stay under `~/.t3/worktrees`, where the copied threads
  and git's own worktree links expect them; the agent-session scanner treats both homes' worktree
  roots as managed.
- It skips `logs`, `server-runtime.json`, `environment-id` and `anonymous-id`, so the copy is a new
  environment rather than a second live copy of the upstream one.
- It does nothing when the target already has a database, and it waits while the upstream server
  is running, because a copy taken during writes could be torn.

## Names kept on purpose

These stay upstream's because they are internal, persisted, or shared with upstream formats.
Renaming them would only add merge conflicts or break existing data.

- Workspace identities that are never published: the `@t3tools/*` scope, the server workspace
  package `t3` (it namespaces every Effect service key, so renaming it would rewrite hundreds of
  keys on every merge), and `oxlint-plugin-t3code` with its `t3code/` rule names. The published
  npm launcher is `ompanel`.
- Persisted and wire identifiers: `t3code:*` and `t3code.*` storage keys, the MCP server id
  `t3-code` and its `t3_*` tools, the `t3-thread:`, `t3-context:` and `t3-citation:` link
  protocols, relay JWT types, `/.well-known/t3/environment`, the `t3` credential owner,
  OpenTelemetry service names and DOM data attributes.
- Upstream project files: `t3.json` and `.t3code/vcs.json`, read so repositories set up for T3
  Code keep working.
- Migration inputs: `~/.t3`, the upstream desktop profile names `T3 Code (Alpha)` and `t3code`,
  and the `t3/` and `t3code/` worktree branch prefixes, which are still recognised as temporary
  branches (new ones use `ompanel/`).
- Workflow gates on `github.repository == 'pingdotgg/t3code'`, which keep upstream's release,
  deploy and store jobs from running on the fork until Ompanel's own release pipeline replaces
  them.
- Third-party registrations made for upstream: the Grok OAuth referrer `t3code` and the Expo
  owner in `apps/mobile/app.config.ts`.

## After an upstream merge

Weekly upstream merges can bring back upstream names. Check each of these:

1. New `T3CODE_*` variables: rename them to `OMPANEL_*`, including in workflows and docs.
2. New paths joined with `".t3"`, new bundle ids, URL schemes or service names: use the brand
   module.
3. Release, update and download URLs (`cliRelease.ts`, `desktopUpdate.logic.ts`,
   `ModelManifest.ts`, `scripts/install.*`, `scripts/npm-launcher/ompanel.mjs`): they must point at
   `TurtleByte-IN/ompanel`.
4. `apps/server/src/telemetry/AnalyticsService.ts` must keep an empty default PostHog key and host.
5. New files under `~/.t3/userdata` that identify one install or a live process: add them to the
   migration's skip list.
