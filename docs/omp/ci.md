# CI on the Ompanel fork

Upstream t3code runs its workflows on Blacksmith runners. Blacksmith is not
installed on `TurtleByte-IN/ompanel`, so jobs with a `blacksmith-*` label
queued forever. Every workflow now uses GitHub-hosted runners. The fork is
public, so these runners are free. A standard public-repository Linux runner
has 4 vCPU and 16 GB RAM.

## Runner mapping

| Upstream label                             | Hosted label                                                                     |
| ------------------------------------------ | -------------------------------------------------------------------------------- |
| `blacksmith-{2,4,8,16,32}vcpu-ubuntu-2404` | `ubuntu-24.04`                                                                   |
| `blacksmith-16vcpu-ubuntu-2404-arm`        | `ubuntu-24.04-arm`                                                               |
| `blacksmith-{6,12}vcpu-macos-26`           | `macos-26` (arm64; macOS x64 desktop builds are cross-compiled there, as before) |
| `blacksmith-8vcpu-windows-2025`            | `windows-2025`                                                                   |

No workflow used Blacksmith-specific actions. Caching already went through
`actions/cache`, and the cache keys are unchanged.
`.github/actions/setup-apt-mirrors` writes its mirror list to
`/etc/apt/ubuntu-mirrors.txt` (formerly `blacksmith-ubuntu-mirrors.txt`).

## Jobs that run only upstream

These jobs need secrets or infrastructure that only `pingdotgg/t3code` has.
On the fork they are skipped, not failed:

| Workflow                            | Job(s)                                                           | Gate                                                 |
| ----------------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------- |
| `release.yml`                       | all (via `resolve_commit`)                                       | `github.repository == 'pingdotgg/t3code'` (upstream) |
| `deploy-relay.yml`                  | `deploy_relay`                                                   | repository (upstream)                                |
| `mobile-android-apk.yml`            | `mirror`                                                         | repository (upstream)                                |
| `mobile-eas-production.yml`         | `production`                                                     | repository (upstream)                                |
| `publish-aur.yml`                   | `publish`                                                        | repository (upstream)                                |
| `mobile-eas-preview.yml`            | `preview`                                                        | `EXPO_TOKEN` presence check and a label (upstream)   |
| `relay-preview.yml`                 | `deploy_preview`                                                 | repository (added for the fork)                      |
| `relay-preview-cleanup.yml`         | `cleanup_pr`, `list_closed_previews` (and `sweep_pr` through it) | repository (added for the fork)                      |
| `web-preview.yml`                   | `deploy`                                                         | repository (added for the fork)                      |
| `desktop-macos-preview-publish.yml` | `resolve` (and the signed `build` and `publish` through it)      | repository (added for the fork)                      |

The shared task cache in `.github/actions/setup-ci-deps` is also limited to
upstream, so fork jobs build and test without a remote cache.

## Timeouts

The `Test` job in `ci.yml` took about 8 minutes on a 4 vCPU hosted runner,
against a 10-minute limit. Its limit is now 15 minutes. The other jobs finished
well inside their upstream limits, so those are unchanged.
