# Following upstream: both forks

Ompanel is two forks, and each follows its own upstream on its own schedule:

|                  | T: `TurtleByte-IN/ompanel`             | O: `TurtleByte-IN/oh-my-pi`                           |
| ---------------- | -------------------------------------- | ----------------------------------------------------- |
| Upstream         | `pingdotgg/t3code` `main`              | `can1357/oh-my-pi`, stable release tags `vX.Y.Z` only |
| Workflow         | `.github/workflows/upstream-merge.yml` | `.github/workflows/upstream-adopt.yml`                |
| When             | Mondays 06:00 UTC                      | Every six hours (`23 */6 * * *`)                      |
| Gate before a PR | none; the PR runs the full CI suite    | the RPC contract suite must pass on the merged tree   |
| Branch           | `chore/upstream-merge-<date>-<sha>`    | `chore/upstream-<tag>`                                |
| Label            | `upstream-merge`                       | `upstream-merge`                                      |
| Required check   | `Check`                                | `CI gate`                                             |
| Fork docs        | [ci.md](ci.md#upstream-merge)          | `docs/fork-release.md` ("Upstream adoption") in O     |

Both workflows read upstream over public HTTPS with the push URL set to `DISABLED`, so neither
can push upstream. Local clones should do the same:

```bash
git remote add upstream https://github.com/pingdotgg/t3code.git   # in T
git remote add upstream https://github.com/can1357/oh-my-pi.git   # in O
git remote set-url --push upstream DISABLED
```

## T: weekly merge of t3code `main`

Each run merges upstream `main` into a fresh branch off `main` and then:

- does nothing when `main` already contains upstream, or an open `upstream-merge` PR or issue
  already covers that upstream commit;
- on conflicts, opens issue `Upstream merge conflicts: pingdotgg/t3code@<sha>` with the
  conflicting files and the commands to merge by hand, and pushes nothing;
- otherwise pushes the branch, dispatches `ci.yml` on it, opens PR
  `chore: merge upstream pingdotgg/t3code@<sha>` and closes older `upstream-merge` PRs and issues.

Why the workflow dispatches CI itself, posts the `Check` status, and when it needs the optional
`UPSTREAM_MERGE_TOKEN` secret is in [ci.md](ci.md#how-the-merge-pr-gets-its-ci).

Run it by hand (a dispatch is a dry run unless `dry_run=false`):

```bash
gh workflow run upstream-merge.yml -R TurtleByte-IN/ompanel
gh workflow run upstream-merge.yml -R TurtleByte-IN/ompanel -f dry_run=false -f upstream_ref=main
```

### Reviewing a T merge PR

PRD §4 rule 4: review only what both sides changed. The PR description lists the files upstream
and the fork both changed since the merge base; those merged cleanly but are the ones to read.
The places upstream and Ompanel both edit most:

- `apps/server/src/provider/builtInDrivers.ts` (driver registry);
- `packages/contracts/src/` (shared schemas, including the `server.*Omp*` RPC methods);
- `apps/server/src/ws.ts` (server RPC handlers);
- the settings navigation (`apps/web/src/components/settings/SettingsSidebarNav.tsx`,
  `settingsSearch.ts`);
- `scripts/build-desktop-artifact.ts` (sidecar bundling) and `.github/workflows/`.

OMP code itself lives in files upstream never touches: `packages/provider-omp/`, `docs/omp/`, the
`Omp*` components in `apps/web` and `apps/mobile`, and `apps/web/e2e/omp/`.

After any merge, run the checks in [branding.md](branding.md#after-an-upstream-merge): an upstream
merge can bring back upstream environment variable prefixes, `.t3` paths and upstream URLs.
`scripts/brand-marks.test.ts` fails on the upstream product name, site, variable prefix or
founder's handle in a user-facing file outside its allowlist.

### Resolving a T conflict

The conflict issue holds the exact commands. In general:

```bash
git fetch origin main && git fetch https://github.com/pingdotgg/t3code.git <sha>
git switch -c chore/upstream-merge-<date>-<sha7> origin/main
git merge --no-ff <sha>          # resolve, then git commit
git push origin chore/upstream-merge-<date>-<sha7>
gh pr create --base main --label upstream-merge --title "chore: merge upstream pingdotgg/t3code@<sha>"
```

Push over SSH when the merge changes `.github/workflows`, which `GITHUB_TOKEN` cannot push. A PR a
person opens runs CI as usual.

PRD §4 rule 5: if an upstream refactor breaks the provider adapter contract (the V2 adapter
interface `packages/provider-omp` implements), do not merge. Hold the merge and decide whether to
adapt the provider or diverge from upstream there.

## O: adopting oh-my-pi releases

O adopts upstream release tags, not upstream `main`. Each run picks the newest stable upstream tag
(`-ompanel.N` and other suffixed tags are ignored). It stops when O `main` already contains that
tag, or when a PR from `chore/upstream-<tag>` or an `upstream-merge` issue titled
`Upstream <tag> …` exists in any state. Otherwise it merges the tag into `main` on branch
`chore/upstream-<tag>` and runs the RPC contract suite
(`OMP_RPC_CONTRACT_BASE_REF=origin/main bun run ci:test:rpc-contract`) on the result:

| Result                | What happens                                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| Merge conflicts       | Issue `Upstream <tag> not adopted: merge conflicts`, with the files and the commands to adopt by hand. Nothing pushed. |
| Contract suite fails  | Issue `Upstream <tag> not adopted: RPC contract suite failed`. The tag is skipped; the next upstream tag is tried.     |
| Contract suite passes | Push, dispatch `ci.yml`, PR `chore: adopt upstream <tag>`; older `upstream-merge` PRs and issues are closed.           |
| Push refused          | Issue `Upstream <tag> not adopted: push failed` (workflow files changed and no `UPSTREAM_MERGE_TOKEN`).                |

The workflow's three jobs (`pick`, `evaluate`, `report`) and why only `report` holds write
permissions are in O's `docs/fork-release.md`. To evaluate a skipped tag again:

```bash
gh workflow run upstream-adopt.yml -R TurtleByte-IN/oh-my-pi -f tag=<tag> -f dry_run=false
```

### Resolving an O conflict

The conflict issue holds the exact commands: merge the tag by hand on `chore/upstream-<tag>`,
resolve, commit, and run the contract suite before pushing.

```bash
git fetch origin main && git fetch --no-tags https://github.com/can1357/oh-my-pi.git refs/tags/<tag>
git switch -c chore/upstream-<tag> origin/main
git merge --no-ff <tag commit>   # resolve, then git commit
bun run ci:test:rpc-contract
git push origin chore/upstream-<tag>
gh pr create --base main --label upstream-merge --title "chore: adopt upstream <tag>"
```

PRD §4 names the places the fork shares with upstream on this side: the RPC command switch and
frame emitters under `packages/coding-agent/src/modes/rpc/`, and the settings schema. When
upstream changed the wire definitions (`packages/coding-agent/src/modes/rpc/wire/`), the contract
gate fails until the adoption PR bumps the contract version ([contract-bump.md](contract-bump.md)).

## Tags

O release tags are `v<upstream-version>-ompanel.<n>`: the upstream version the fork is based on,
then a fork counter, for example `v18.12.6-ompanel.3`. They match upstream's `v*` release trigger
and sort after the upstream base.

- Only repository and organization admins can create, move or delete `v*` tags (the "Release
  tags v*" ruleset). A pushed tag is never moved; a fix ships as the next `-ompanel.<n>`.
- Cut a tag from O `main` and push it alone. The push starts `fork-release.yml`, which runs
  `ci.yml` on the tag and publishes the release only if the tag still points at the built commit
  and that commit is on `main`.
- Contract versions are linear on O `main`. When two open PRs both bump the contract, the second
  to merge rebases and takes the next version.

T records the O tag it drives in `omp.lock`; moving that pin is in
[contract-bump.md](contract-bump.md).
