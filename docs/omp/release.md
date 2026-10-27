# Releasing Ompanel

Ompanel ships from `TurtleByte-IN/ompanel` through the release workflow it inherited from t3code
(`.github/workflows/release.yml`, one `release-desktop.yml` call per platform). This page covers
what the fork changed and how to cut a release. The upstream checklist,
[docs/operations/release.md](../operations/release.md), still describes each job in detail.

## What a release contains

One GitHub Release per tag, with:

| Platform | Desktop app                           | CLI archive (`ompanel-<version>-<target>`) |
| -------- | ------------------------------------- | ------------------------------------------ |
| macOS    | `.dmg` and `.zip`, arm64 and x64      | `darwin-arm64.tar.gz`                      |
| Windows  | NSIS installer `.exe`, x64 and arm64  | `win32-x64.zip`, `win32-arm64.zip`         |
| Linux    | `.AppImage` and `.deb`, x64 and arm64 | `linux-x64.tar.gz`, `linux-arm64.tar.gz`   |

There is no macOS x64 CLI archive: Node single executables do not run on x64 macOS. Stable and
nightly releases also carry the updater manifests (`*.yml`) and `*.blockmap` files; preview
releases do not.

`SHA256SUMS` lists the sha256 of every other asset on the release, written from the exact bytes
that are uploaded. The installer scripts check the CLI archive against it; anyone can check the
rest with `sha256sum -c SHA256SUMS` (`shasum -a 256 -c SHA256SUMS` on macOS).

Each desktop app ships the pinned OMP sidecar for its platform in its resources
([sidecar.md](sidecar.md#desktop-bundling)). The CLI archive does not: its server downloads the
pinned sidecar into `<OMPANEL_HOME>/tools/omp/<tag>/` on first use and checks it against
`omp.lock` ([sidecar.md](sidecar.md#first-run-download-web-and-server)).

## Cutting a release

| Kind              | How                                                                                       | Built from  | Signed, npm                     | GitHub Release           |
| ----------------- | ----------------------------------------------------------------------------------------- | ----------- | ------------------------------- | ------------------------ |
| Release candidate | `git tag vX.Y.Z-rc.N <commit> && git push origin vX.Y.Z-rc.N`                             | any commit  | only if `<commit>` is on `main` | prerelease, never latest |
| Stable            | `git tag vX.Y.Z <commit on main> && git push origin vX.Y.Z`, or dispatch `channel=stable` | `main` only | yes                             | latest                   |
| Preview           | Actions → Release → Run workflow, `channel=preview`, any branch                           | that branch | never                           | prerelease, no updater   |
| Nightly           | scheduled, once `OMPANEL_NIGHTLY_RELEASES` is `true`, or dispatch `channel=nightly`       | `main` only | yes                             | prerelease               |

Only repository admins can create, move or delete `v*` tags (ruleset "Release tags (v\*): admins
only"; `-nightly.` and `-preview.` tags, which the release workflow creates itself, are exempt).

Any tag with a suffix after `X.Y.Z` (other than `-nightly.` and `-preview.`, which the trigger
ignores) is a release candidate. It may be cut from any commit, so a branch can be released before
it merges; `v0.0.0-ompanel-rc.1` to `-rc.3` were cut from the branch that set this pipeline up.
A candidate is a GitHub prerelease, is never marked latest, and never runs the finalize job, so it
never commits a version bump to `main`. A candidate from a commit that is not on `main` builds
unsigned and never publishes to npm, whatever secrets exist: only reviewed code gets the signing
identity. Plain `vX.Y.Z` tags must point at a commit on `main`.

Those rules live in the workflow, which a tagged commit can edit, so they are not the security
boundary. The boundary is the `release` environment ([Signing](#signing)): the signing secrets and
npm publishing exist only there, and every run that reaches it waits for a reviewer.

Watch the run with `gh run watch -R TurtleByte-IN/ompanel`. It takes about half an hour (the first
candidate took 27 minutes): the release reruns lint, typecheck and the test suites, builds six
desktop targets and five CLI archives, uploads them as a draft release, verifies the draft, then
publishes it. A run that signs stops twice for approval (the desktop builds, then npm). A reviewer
other than the person who cut the tag approves it under the run's "Review deployments"; see
[Signing](#signing) for why that is not enforced yet (B-010).

Scheduled nightlies are off on the fork because each one is a full release run that competes with
pull request CI for runners. Set the repository variable `OMPANEL_NIGHTLY_RELEASES` to `true` to
turn them on.

## Verification

Before anything is uploaded, every build job smoke-tests its own CLI archive
(`scripts/smoke-cli-archive.ts --omp-sidecar`): the archive must report the release version,
serve the web app, and download the pinned OMP sidecar with the sha256 in `omp.lock`. Windows
archives run this on a Windows runner of their own architecture.

The `release` job then uploads everything as a draft release, which nobody outside the
repository can see or download, and keeps the hashes of the bytes it uploaded as the
`release-checksums` workflow artifact. Reading a draft needs a token that can write contents, so
one job, `stage_draft`, copies the draft's assets into workflow artifacts. `verify_release` then
runs with read-only permissions, so the binaries it launches can change nothing in the
repository, and installs the draft the way users will get it, on Linux x64, macOS arm64 and
Windows x64:

1. Takes the draft's assets from `stage_draft` and checks each one against `SHA256SUMS`. The
   Linux job gets every asset and also fails if any platform's assets are missing.
2. Runs the one-line installer from the release commit
   (`raw.githubusercontent.com/TurtleByte-IN/ompanel/<tag>/scripts/install.sh`, or
   `install.ps1`) with `OMPANEL_VERSION` set, in a throwaway `OMPANEL_HOME`, and runs
   `ompanel --version`. A draft has no public download URL, so `OMPANEL_RELEASE_BASE_URL` points
   the installer at a local mirror of the draft's `SHA256SUMS` and CLI archive.
3. Starts the installed CLI's server in a fresh home and waits for it to download the OMP sidecar
   and verify its sha256.
4. Installs and launches the desktop app: the `.AppImage` and the `.deb` on Linux (under
   `xvfb-run`), the app from the `.dmg` on macOS, and the NSIS installer run silently (`/S`) on
   Windows. `apps/desktop/scripts/smoke-omp.mjs` with `OMPANEL_DESKTOP_SMOKE_EXECUTABLE` set
   launches the installed executable, and passes only when the backend answers, the main window
   opens, and OMP turns ready on the bundled sidecar without downloading one.

Only when all three pass does `publish_release` run. It downloads every asset of the draft again,
hashes it, and compares it with `release-checksums`: an asset swapped, added or removed since the
build stops the release. Then it makes the draft public (and, for a plain `vX.Y.Z`, the latest
release) and checks that the public `SHA256SUMS` URL serves the recorded file. npm, the hosted web
app, the version bump and announcements all wait for it. A failed check leaves an unpublished
draft: fix the cause, delete the draft, and cut the next tag.

Screenshots and logs are uploaded as `release-verify-<target>`.

## Installing from a release

```bash
# macOS, Linux
curl -fsSL https://raw.githubusercontent.com/TurtleByte-IN/ompanel/main/scripts/install.sh | sh
# a specific release, including a candidate
curl -fsSL https://raw.githubusercontent.com/TurtleByte-IN/ompanel/main/scripts/install.sh | OMPANEL_VERSION=0.0.0-ompanel-rc.1 sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/TurtleByte-IN/ompanel/main/scripts/install.ps1 | iex
```

The installer picks the archive for the host, downloads `SHA256SUMS` and the archive from the
release, refuses a sha256 mismatch, and links `ompanel` into `~/.local/bin`. Without
`OMPANEL_VERSION` it installs the latest stable release, so until the first stable release exists
only `OMPANEL_VERSION` works. [docs/user/install.md](../user/install.md) lists the other variables.

Known issue: on macOS the CLI executable aborts at start (`SeaDeserializer::Read ... (magic) ==
(kMagic)`) when `DYLD_INSERT_LIBRARIES` is set, as some window-management tools do, so the installer
reports "the downloaded executable does not run" (ompanel#168). Unset the variable to install and run.

## Signing

Signing is decided per platform from the secrets present, at build time, and only for a build of a
commit on `main` (see [Cutting a release](#cutting-a-release)). With no secrets the release still
ships, unsigned.

Store every signing secret below as an **environment secret of `release`** (Settings →
Environments → `release`), never as a repository secret. That environment:

- requires a reviewer before any job that uses it starts. Today the only reviewer is `Quelaan1`,
  the repository admin account the release tooling runs as.
- accepts deployments only from `v*` tags and `main`.
- is used by the six desktop build jobs when the build may sign, and by `publish_cli`.

A run from an unreviewed commit therefore never sees a signing key, and a run that would sign
waits for a human. The npm trusted publisher for `ompanel` should name `release.yml` and the
`release` environment, so npm refuses an OIDC token from anywhere else.

**Blocker B-010: do not add any signing secret yet.** With one reviewer and "Prevent self-review"
off, the account that pushes a tag can approve its own run, so the approval adds no second pair of
eyes. Before the first signing secret goes into `release`, a second human must be added as a
required reviewer and "Prevent self-review" turned on (Settings → Environments → `release`), so
nobody can sign a build they cut themselves.

**macOS** (B-001): signed and notarized only when all of these exist; with any of the first five
missing the app is unsigned, and with those five but not the last two the build fails.

| Name                         | Kind                | Value                                                               |
| ---------------------------- | ------------------- | ------------------------------------------------------------------- |
| `CSC_LINK`                   | `release` secret    | base64 of the Developer ID Application certificate and key (`.p12`) |
| `CSC_KEY_PASSWORD`           | `release` secret    | password of that `.p12`                                             |
| `APPLE_API_KEY`              | `release` secret    | contents of an App Store Connect API key (`.p8`), used to notarize  |
| `APPLE_API_KEY_ID`           | `release` secret    | that key's ID                                                       |
| `APPLE_API_ISSUER`           | `release` secret    | that key's issuer ID                                                |
| `MACOS_PROVISIONING_PROFILE` | `release` secret    | base64 provisioning profile for `in.turtlebyte.ompanel`             |
| `APPLE_TEAM_ID`              | repository variable | 10-character Apple Developer Team ID                                |

The workflow notarizes with an App Store Connect API key, not an Apple ID and app-specific
password. `CSC_LINK` and `CSC_KEY_PASSWORD` alone also sign the macOS CLI archive with the
Developer ID; without them it is signed ad hoc. The bundled OMP sidecar keeps the signature the
OMP fork's release gave it, and notarization needs that to be a Developer ID signature too, so
the fork's release must be signed first ([sidecar.md](sidecar.md#desktop-bundling)). The upstream
checklist walks through creating each value
([macOS](../operations/release.md#2-apple-signing--notarization-setup-macos)).

**Windows** (B-002): signed through Azure Trusted Signing, not a `.pfx` certificate, when all
seven `release` environment secrets exist: `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`,
`AZURE_TRUSTED_SIGNING_ENDPOINT`, `AZURE_TRUSTED_SIGNING_ACCOUNT_NAME`,
`AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE_NAME`, `AZURE_TRUSTED_SIGNING_PUBLISHER_NAME`
([setup](../operations/release.md#3-azure-trusted-signing-setup-windows)). They sign the
installer and the CLI archive's executable.

**Linux** packages are not signed.

Until then, users opening an unsigned build see the OS warning: on macOS, right-click the app and
choose Open (or run `xattr -dr com.apple.quarantine "/Applications/Ompanel (Beta).app"`); on
Windows, SmartScreen's "More info", then "Run anyway".

## Optional jobs

Jobs that need a service the fork does not have yet are skipped, not failed:

| Job                                                              | Runs when                                                                                                                                                        |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `publish_cli` (npm `ompanel` launcher)                           | a build of a commit on `main`, repository variable `OMPANEL_NPM_PUBLISH` is `true` (needs B-003 and an npm trusted publisher), and a `release` reviewer approved |
| `build_web`, `deploy_web`, `build_marketing`, `deploy_marketing` | secret `VERCEL_TOKEN` is set                                                                                                                                     |
| `announce_discord`                                               | the hosted web app deployed                                                                                                                                      |
| `finalize` (version bump on `main`)                              | a plain `vX.Y.Z` release and secret `RELEASE_APP_ID` is set                                                                                                      |
| `publish_aur`                                                    | never on the fork (`publish-aur.yml` is upstream-only)                                                                                                           |
| relay tracing and Ompanel Connect config                         | secret `CLOUDFLARE_API_TOKEN` and the relay variables are set (B-009); without them the apps ship without Ompanel Connect                                        |

A partly configured relay (some of `RELAY_DOMAIN`/`RELAY_API_ZONE_NAME`, `CLERK_PUBLISHABLE_KEY`,
`CLERK_JWT_TEMPLATE`, `CLERK_CLI_OAUTH_CLIENT_ID` set, others not) still fails the release.
