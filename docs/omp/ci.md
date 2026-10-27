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

## Required checks

Branch protection on `main` requires one status check, `Check` (the last job in
`ci.yml`). It passes only when every other `ci.yml` job passed, or was skipped
because `changes` found the pull request cannot affect it. A failed or
cancelled job fails it. Through it, every pull request is gated on:

- format and lint: `Lint` (`vp check`, which formats every file, plus knip and
  the generated GraphQL checks);
- typecheck: `Build and Typecheck`;
- unit tests: `Test`, `Test Web`, `Test Server 1`–`8` and `Rust`;
- end-to-end: `OMP E2E` (gates G1 and G2, [testing.md](testing.md#end-to-end)), for
  changes that reach the web app or the server;
- server boot: `Server Boot Smoke`, for changes that reach the server, web or
  desktop build. It builds the server as `pnpm dev:desktop` and releases do,
  then runs `node scripts/smoke-server-boot.ts --target node --target electron`:
  `apps/server/dist/bin.mjs` must answer `/.well-known/t3/environment` under
  plain Node (the CLI) and under Electron's Node with a fd 3 bootstrap (the
  desktop backend), then stay up 15 s. An exit at any point fails the job, so a
  backend that would crash-loop in the desktop app cannot merge. Run the same
  command locally after `vp run --filter t3 build`.
- desktop on every OS: `Desktop Smoke macOS arm64`, `Linux x64`, `Linux arm64`,
  `Windows x64` and `Windows arm64`, for the same changes. Each builds the
  desktop app and server (`vp run --filter @t3tools/desktop --filter t3 build`)
  on its own runner, then runs `node apps/desktop/scripts/smoke-omp.mjs`
  (under `xvfb-run` on Linux). The script launches `dist-electron/boot.cjs`,
  the entry the packaged app runs, with a throwaway home and OMP enabled with
  no binary path. `omp --mode rpc` exits when no default model resolves
  (ompanel#144), so the throwaway OMP home gets a loopback model provider
  that is never prompted. On macOS the app runs with `--use-mock-keychain`,
  since a locked runner keychain would block the main process with a prompt.
  It passes only when the backend logs ready and answers
  `/.well-known/t3/environment`, the main window opens, and the OMP row on
  Settings → Providers turns ready. It then checks that the sidecar that ran
  is this platform's `omp.lock` asset: downloaded into
  `<OMPANEL_HOME>/tools/omp/<tag>/` with the sha256 in the lock. A screenshot
  of the providers page and the app's log are uploaded as
  `desktop-smoke-<platform>-<arch>`; on failure the backend logs and the
  output of the cached sidecar run with the status check's flags are too.
  The job has only `contents: read` (no OIDC token), and the script drops
  `ACTIONS_*`, `GITHUB_TOKEN` and `GH_TOKEN` from the environment the app and
  the downloaded sidecar inherit. A first check that ends in "did not answer
  within 20 s" (a cold first start, ompanel#147) gets one refresh after the
  30 s probe cache expires; any other error fails at once. On Windows the job
  first runs
  `processTree.windows.test.ts`, which kills real process trees under the
  job-object launcher ([processes.md](processes.md#stopping)). Its waits
  allow for the ~20-30 s launcher start on `windows-11-arm` (ompanel#145).
  Locally, run
  the build, then the script; set `OMPANEL_DESKTOP_SMOKE_ARTIFACTS` to keep the
  screenshot somewhere other than `apps/desktop/.smoke-omp`.

A new job joins the gate by being added to `Check`'s `needs`; the branch
protection setting does not change. Workflows other than `ci.yml` (PR size,
vouch, mobile fingerprint, `OMP live`) are not required. `OMP live`
(`omp-live.yml`, nightly) runs the OMP live suite when the repository secret
`OMPANEL_LIVE_ANTHROPIC_API_KEY` is set and otherwise passes with a "skipped"
notice ([testing.md](testing.md#live-suite)).

## Jobs that run only upstream

These jobs need secrets or infrastructure that only `pingdotgg/t3code` has.
On the fork they are skipped, not failed. `release.yml` runs on the fork
itself and skips only the jobs whose credentials are missing
([release.md](release.md#optional-jobs)).

| Workflow                            | Job(s)                                                           | Gate                                               |
| ----------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| `deploy-relay.yml`                  | `deploy_relay`                                                   | repository (upstream)                              |
| `mobile-android-apk.yml`            | `mirror`                                                         | repository (upstream)                              |
| `mobile-eas-production.yml`         | `production`                                                     | repository (upstream)                              |
| `publish-aur.yml`                   | `publish`                                                        | repository (upstream)                              |
| `mobile-eas-preview.yml`            | `preview`                                                        | `EXPO_TOKEN` presence check and a label (upstream) |
| `relay-preview.yml`                 | `deploy_preview`                                                 | repository (added for the fork)                    |
| `relay-preview-cleanup.yml`         | `cleanup_pr`, `list_closed_previews` (and `sweep_pr` through it) | repository (added for the fork)                    |
| `web-preview.yml`                   | `deploy`                                                         | repository (added for the fork)                    |
| `desktop-macos-preview-publish.yml` | `resolve` (and the signed `build` and `publish` through it)      | repository (added for the fork)                    |

The `cleanup` job in `desktop-macos-preview-publish.yml` stays ungated. It runs
when a pull request closes or loses the `preview:mac` label. It only deletes
this repository's own preview release assets with `GITHUB_TOKEN`, and on the
fork it usually finds nothing to delete.

The shared task cache in `.github/actions/setup-ci-deps` is also limited to
upstream, so fork jobs build and test without a remote cache.

## Timeouts

The `Test` job in `ci.yml` took about 8 minutes on a 4 vCPU hosted runner,
against a 10-minute limit. Its limit is now 15 minutes. The other jobs finished
well inside their upstream limits, so those are unchanged.

## Upstream merge

`.github/workflows/upstream-merge.yml` merges `pingdotgg/t3code` `main` into
the fork every Monday at 06:00 UTC (PRD §4, merge cadence; §10, upstream
merge). It fetches upstream over public HTTPS with its push URL disabled, so it
cannot push upstream. Every `gh` call runs with `GH_REPO` set to this fork:
once the `upstream` remote exists, `gh` would otherwise resolve upstream as the
target repository (the first non-dry run failed exactly that way, with a 403
creating the label on `pingdotgg/t3code`). It merges into a fresh branch off
`main`, named `chore/upstream-merge-<date>-<sha>`. Then one of these happens:

- `main` already contains upstream: nothing.
- The merge conflicts: it opens an issue labelled `upstream-merge`, titled
  `Upstream merge conflicts: pingdotgg/t3code@<sha>`. The issue lists the
  conflicting files and the commands to do the merge by hand. Nothing is
  pushed.
- The merge is clean: it pushes the branch, opens a pull request labelled
  `upstream-merge`, and dispatches `ci.yml` on the branch. The PR description
  lists the files both upstream and the fork changed since the merge base.
  Those merged without conflicts but are the ones to review (PRD §4, rule 4).

A run does nothing when an open `upstream-merge` PR or issue already covers
the same upstream commit. A new merge PR closes older open `upstream-merge`
PRs and issues, because it contains their upstream commits. Closed branches are
kept.

### How the merge PR gets its CI

A pull request opened with `GITHUB_TOKEN` starts no `pull_request` workflows.
So the merge workflow runs `gh workflow run ci.yml --ref <branch>`, and
`ci.yml` accepts `workflow_dispatch` for this. Change detection has no base
commit in a dispatched run, so every job runs.

Branch protection does not count the check runs of a dispatched run: the PR
lists none of them, and its required `Check` stays "Expected" even after the
dispatched `Check` job passes. So the merge workflow posts a commit status
named `Check` on the merge commit. It is `pending` from the dispatch, and
`success` or `failure` once the dispatched run ends, linking to that run. The
status comes from `GITHUB_TOKEN`, i.e. the GitHub Actions app, which is the
source the required check accepts. The merge job therefore waits for CI, about
20 minutes, and has a 120-minute limit. If it times out, the status stays
`pending`. Push to the branch (an empty commit is enough) to run CI the usual
way.

The PR therefore cannot merge until the full suite passes. A push to the branch
by a person, for example a fix, runs CI the usual way.

### What GITHUB_TOKEN cannot do

`GITHUB_TOKEN` cannot push a commit that changes `.github/workflows`. When an
upstream merge changes a workflow file, the push fails. The workflow then opens
an `Upstream merge push failed: …` issue with the error and fails the run.
Do that merge by hand with the commands from a conflict issue, pushing over SSH.

An optional repository secret, `UPSTREAM_MERGE_TOKEN`, removes this gap. It is
a fine-grained token for this repository with read and write access to
contents, pull requests, issues, actions and workflows. With it, the workflow
pushes and opens the PR as the token's owner. That PR runs CI like any other,
so nothing is dispatched. Only an admin can create the token; until then, the
`GITHUB_TOKEN` path above applies.

`GITHUB_TOKEN` can open a pull request only when "Allow GitHub Actions to
create and approve pull requests" is on, both for the TurtleByte-IN
organization and for this repository (Settings → Actions → General). The
organization has it off, so the repository cannot turn it on. While it is off,
`gh pr create` fails after the push and the CI dispatch. The workflow then
opens an `Upstream merge ready for a PR: …` issue instead. It holds a link that
opens the PR from the pushed branch, and the PR description to paste. A PR a
person opens runs CI as usual. The `UPSTREAM_MERGE_TOKEN` secret avoids this
too.

### Running it by hand

```bash
# Dry run (the default for a dispatch): merge on the runner and report the
# PR or conflict issue it would open in the run summary. Writes nothing.
gh workflow run upstream-merge.yml -R TurtleByte-IN/ompanel

# A real run. upstream_ref takes a branch, tag or full commit SHA.
gh workflow run upstream-merge.yml -R TurtleByte-IN/ompanel \
  -f dry_run=false -f upstream_ref=main
```
