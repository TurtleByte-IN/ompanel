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

| Value                                      | Ompanel                                                                            | Upstream                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------------ |
| Product                                    | `Ompanel`                                                                          | `T3 Code`                                  |
| CLI, executable, URL scheme, systemd unit  | `ompanel` (`ompanel-dev` in development)                                           | `t3`, `t3code`                             |
| Desktop profile directory                  | `ompanel` (`Ompanel (Dev)` in development)                                         | `T3 Code (Alpha)`, `T3 Code (Dev)`         |
| Linux desktop file, AppStream, `.deb` docs | `ompanel.desktop`, `in.turtlebyte.ompanel.metainfo.xml`, `/usr/share/doc/ompanel/` | `t3code.desktop`, `/usr/share/doc/t3code/` |
| GNOME SnapShot extension                   | `snap-shot@turtlebyte.in`, D-Bus `org.gnome.Shell.Extensions.OmpanelSnapShot`      | `snap-shot@t3.codes`, `…T3SnapShot`        |
| Niri SnapShot D-Bus interface              | `in.turtlebyte.Ompanel.SnapShot` at `/in/turtlebyte/Ompanel/SnapShot`              | `com.t3tools.SnapShot`                     |
| Hosted web app                             | none (`HOSTED_APP_URL` unset)                                                      | `app.t3.codes`                             |
| Environment variables                      | `OMPANEL_*`                                                                        | `T3CODE_*`                                 |
| Home directory                             | `~/.ompanel`                                                                       | `~/.t3`                                    |
| Worktree branch prefix                     | `ompanel/`                                                                         | `t3/`                                      |
| App, bundle and package id, launchd label  | `in.turtlebyte.ompanel` (`.dev`, `.preview`)                                       | `com.t3tools.t3code`                       |
| Releases, update feed, model manifest      | `TurtleByte-IN/ompanel`                                                            | `pingdotgg/t3code`                         |
| Product analytics                          | none unless `OMPANEL_POSTHOG_KEY` and `OMPANEL_POSTHOG_HOST` are set               | `ingest.t3.codes`                          |

Different OS identities let Ompanel and T3 Code be installed side by side without sharing a
profile, URL handler, background service, desktop control socket, package file or GNOME extension.
The SnapShot names were renamed rather than kept: Ompanel has never shipped them, so no installed
extension or user dotfile binding refers to the old ones, and the GNOME uuid and D-Bus name would
otherwise collide when both apps install their extension.

## Hosted web app

Upstream runs a hosted web app at `app.t3.codes`. Ompanel runs none, so `HOSTED_APP_URL` in the
brand module is unset and nothing defaults to an upstream origin. Those flows carry credentials:
a hosted pairing link puts a pairing token in a URL fragment that the hosted app's JavaScript
reads, so pointing them at a third-party origin would hand it a session on the Ompanel server.

With no hosted app configured:

- Pairing links and QR codes for HTTPS endpoints (for example Tailscale serve) are the server's
  own direct `/pair#token=…` URL; `buildHostedPairingUrl` returns `null`.
- CLI cloud commands are off (`hasCloudPublicConfig` requires `OMPANEL_HOSTED_APP_URL`), because
  their sign-in runs through the hosted app's `/connect` page.
- Codex sign-in returns only to the desktop app or a loopback web origin.
- Copied prompt links are app deep links (`ompanel://new?prompt=…`), and no web origin is accepted
  as a prompt link.
- `release.yml` refuses to build or alias a hosted web deployment unless
  `OMPANEL_WEB_ROUTER_URL`, `OMPANEL_WEB_LATEST_DOMAIN` and `OMPANEL_WEB_NIGHTLY_DOMAIN` are set.

A deployment that runs its own hosted app sets `VITE_HOSTED_APP_URL` for the web build and
`OMPANEL_HOSTED_APP_URL` for the server, or sets `HOSTED_APP_URL` in the brand module to cover
the desktop and the Codex return check as well.

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

What is copied:

- Everything in `~/.t3/userdata` except the entries below: settings, keybindings, themes,
  attachments, provider status caches and the like.
- `state.sqlite` and `statev2.sqlite`, through SQLite's backup API, so the copy is consistent even
  if T3 Code writes meanwhile. The copies then lose every row of `auth_sessions` (paired devices
  and clients) and `auth_pairing_links`.

What is not copied:

- `secrets/`: the session, MCP, guest-share and asset signing keys, the T3 Connect link
  credentials, and provider sign-ins (`provider-auth-*`) and secret settings values, which users
  enter again. Ompanel generates its own keys, so no token, paired device, guest-share link or relay
  identity issued by T3 Code is valid against Ompanel, and Ompanel never registers as T3 Code's
  linked environment.
- `logs`, `server-runtime.json`, `server-owner.sqlite`, `environment-id` and `anonymous-id`, so the
  copy is a new environment rather than a second live copy of the upstream one.
- Symlinks, at any depth. They are skipped, never followed.
- Worktrees. They stay under `~/.t3/worktrees`, where the copied threads and git's own worktree
  links expect them; the agent-session scanner treats both homes' worktree roots as managed.

When it runs and retries:

- It never writes to `~/.t3`. Whether T3 Code is running is read from its `server-runtime.json`
  and from its `server-owner.sqlite` lock, read-only.
- It defers, writing no marker, while T3 Code is running, while an Ompanel server owns
  `~/.ompanel/userdata`, or while another Ompanel server holds the migration lock
  (`~/.ompanel/legacy-home-migration.lock`, an SQLite exclusive transaction that the OS releases
  if the holder dies; a second server waits up to 60 seconds for it). A failed copy also writes no
  marker. Every case retries on the next start.
- A deferred or failed start still runs Ompanel, which creates its own empty database. On the
  next start that database counts as empty because it has no events, projects or threads, so the
  copy goes ahead; the empty database is moved to `~/.ompanel/.legacy-home-migration-replaced-*`.
  An Ompanel database with any of those rows, or one it cannot read, is never replaced: the
  migration records `target-has-state` and stops for good.
- Files and directories Ompanel already has win over the copy; directories it only created, such
  as `attachments`, are filled in.
- The copy is built in `~/.ompanel/.legacy-home-migration` and marked complete there, then moved
  in with the databases last. A restart after a crash finishes a complete staging copy, skipping
  databases already moved, and discards an incomplete one. `~/.ompanel/legacy-home-migration.json`
  then makes every later start a no-op.

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
- Migration inputs: `~/.t3`, the upstream desktop profile names `T3 Code (Alpha)` and `t3code`
  (Windows only; development builds never read upstream's `T3 Code (Dev)`),
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
   migration's skip list. New tables that hold credentials: add them to its cleared tables.
6. New `t3.codes` defaults, especially anything that builds a URL carrying a token: source it
   from `HOSTED_APP_URL` and keep it off when that is unset.
7. Run `vp test run scripts/brand-marks.test.ts` (from `scripts/`: `pnpm run test`). It fails on
   any `T3 Code`, `t3.codes`, `T3CODE_` or Theo handle in a user-facing file that is not on its
   allowlist, which mirrors this page.

## Copy and links

User-visible text says Ompanel, and "T3 Connect" is "Ompanel Connect". Code reads the display
name, repository URL and releases URL from the brand module (`PRODUCT_NAME`, `REPOSITORY_URL`,
`RELEASES_URL`). Code identifiers that contain `T3` (`T3ConnectUserProfilePage`, `t3-*` mobile
modules, `font-t3-*` classes) stay, like the other internal names above.

Upstream's hosted services (`app.t3.codes`, `relay.t3.codes`, `clerk.t3.codes`, the `t3.codes`
site) have no Ompanel equivalent until `ompanel.dev` exists (blocker B-003), so links to them were
replaced or removed:

| Upstream link                                  | Now                                                                                                         |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `t3.codes/install.sh`, `install.ps1`           | `raw.githubusercontent.com/TurtleByte-IN/ompanel/main/scripts/…`                                            |
| `t3.codes/download`                            | GitHub releases (`RELEASES_URL`)                                                                            |
| `t3.codes` homepage, "Created in" footer       | GitHub repository (`REPOSITORY_URL`)                                                                        |
| `t3.codes/privacy-policy` (web, mobile)        | removed with its settings row and welcome note; mobile Legal opens `LICENSE`                                |
| `t3.codes/security-policy`, `security@ping.gg` | GitHub private vulnerability reporting                                                                      |
| App Store / Google Play listings               | removed; the mobile app is not published for Ompanel                                                        |
| GitHub Discussions (ideas)                     | GitHub issues; blank issues are enabled                                                                     |
| winget, Scoop, Homebrew, AUR packages          | removed from install docs; AUR PKGBUILDs renamed `ompanel-bin` and `ompanel-nightly-bin`, not yet published |
| `app.t3.codes` in user docs                    | "the hosted web app"; prompt-link examples use `https://<web-app>/`                                         |

Still pointing at upstream, because they are infrastructure rather than links and are only used
when a build opts into the hosted services: `apps/web/vercel.ts`, the mobile Clerk passkey domain
in `apps/mobile/app.config.ts`, `.env.example`, `infra/relay/src/monitoring.ts`, and the hosted
app channels in `docs/operations/release.md`, `docs/operations/relay-observability.md` and
`.github/workflows/release.yml`.  The `t3.json` schema URL is upstream's project-file format.

The `T3 Tools Inc.` copyright line in `LICENSE` stays: the MIT grant requires keeping it.
