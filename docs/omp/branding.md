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

`apps/web/vercel.ts` still names upstream's `app.t3.codes` router hosts. Its rules match only
those hosts, so they do nothing on another domain; they need Ompanel's hosts before a hosted
deployment exists.

## T3 Connect (Clerk and relay)

Ompanel runs no Clerk instance or relay yet, and no build defaults to upstream's. `.env.example`
ships the Clerk publishable key, JWT template, CLI OAuth client id and `OMPANEL_RELAY_URL`
commented out and empty, so a copied `.env` and the macOS PR preview build (which bakes in
`.env.example`) have cloud features off. Upstream's values would sign users in to upstream's
Clerk and send its access token to `relay.t3.codes`. The mobile app declares passkey associated
domains only when `OMPANEL_MOBILE_PASSKEY_RP_DOMAIN` is set, so passkeys are off by default.
`brand.test.ts` fails if `.env.example` gains an uncommented upstream value. Signed macOS builds
still need `OMPANEL_CLERK_PUBLISHABLE_KEY` or `OMPANEL_CLERK_PASSKEY_RP_DOMAINS` for their passkey
entitlement.

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
  if T3 Code writes meanwhile, including rows still only in its write-ahead log. The copies then
  lose every row of `auth_sessions` (paired devices and clients) and `auth_pairing_links`, and
  every scheduled task's `webhook_token` and `webhook_secret` (the task's owner rotates a new
  webhook URL). `VACUUM` then rewrites each copy, so the deleted values do not survive in free
  pages.

What is not copied:

- `secrets/`: the session, MCP, guest-share and asset signing keys, the T3 Connect link
  credentials, and provider sign-ins (`provider-auth-*`) and secret settings values, which users
  enter again. Ompanel generates its own keys, so no token, paired device, guest-share link or relay
  identity issued by T3 Code is valid against Ompanel, and Ompanel never registers as T3 Code's
  linked environment.
- `device/`: device host records under `device/hosts` hold upstream's device daemon auth tokens.
- `logs`, `server-runtime.json`, `server-owner.sqlite`, `environment-id` and `anonymous-id`, so the
  copy is a new environment rather than a second live copy of the upstream one.
- Symlinks, at any depth. They are skipped, never followed. A symlinked `~/.t3`, `~/.t3/userdata`
  or database file refuses the whole copy (`legacy-home-symlinked`, logged, no marker): a
  relocated home is not followed.
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
- A deferred or failed start still runs Ompanel, which creates its own empty database and default
  `keybindings.json`. That start skips the automatic project and "New thread" bootstrap of a web
  start, whatever the flags say, so it writes no user rows itself (this was chosen over teaching
  the emptiness check to ignore bootstrap rows, which could not tell them from a project the user
  added on purpose). On the next start the database counts as empty because it has no events,
  projects or threads, so the copy goes ahead; the empty database, and the start's
  `keybindings.json` and `keybindings-migrations` when upstream has its own keybindings, are moved
  to `~/.ompanel/.legacy-home-migration-replaced-*`. An Ompanel database with any of those rows,
  or one it cannot read, is never replaced: the migration records `target-has-state` and stops
  for good.
- Other files and directories Ompanel already has win over the copy; directories it only created,
  such as `attachments`, are filled in.
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
- Migration inputs: `~/.t3`, and the `t3/` and `t3code/` worktree branch prefixes, which are still
  recognised as temporary branches (new ones use `ompanel/`). The desktop app reads no upstream
  Chromium profile: on Windows, seeding `Local State` from `T3 Code (Alpha)` or `t3code` would
  share the safeStorage key with upstream, so Ompanel's profile starts fresh.
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
