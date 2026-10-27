# Bumping the OMP contract and moving the pin

A change to what `omp --mode rpc-ui` accepts or sends reaches Ompanel in three steps: O bumps its
RPC contract, O cuts a release tag, and T re-pins to that tag. T accepts only the exact contract
version in `omp.lock`: a sidecar that reports any other version is refused at `ready`
([processes.md](processes.md#handshake)), so every contract bump in O needs a re-pin in T before
Ompanel can run it.

## 1. O: bump the contract

The contract is described once, as omptype schemas under
`packages/coding-agent/src/modes/rpc/wire/` in O. O's `docs/rpc-contract.md` has the full rules.

1. Change the wire definitions and the server code that produces the frames.
2. Run `bun run gen:rpc`. It regenerates `packages/rpc-contract/`, exits 1 and prints the new
   `schemaHash` when the shape no longer matches the recorded version.
3. Pick the next version:

   | Bump  | When                                                                                                                                                                                                   |
   | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
   | major | An existing host can break: a field, command or frame removed or renamed, a type narrowed, a field made required, an enum value removed, a default or a command's `result`/`nullable`/`unwrap` changed |
   | minor | An addition hosts may ignore: a new command, frame, definition, optional field or parameter, or a new enum value on a frame the server sends                                                           |
   | patch | The hash changed but neither what the server accepts nor what it sends did (for example `clientOmit`)                                                                                                  |

4. Append `{ "version": "<next>", "schemaHash": "<printed hash>" }` to
   `packages/coding-agent/src/modes/rpc/wire/contract-history.json`. The history is append-only:
   never edit, remove or reorder an entry that reached `main`.
5. Set the same `version` in `packages/rpc-contract/package.json`.
6. Run `bun run gen:rpc` again; it must exit 0. Commit the regenerated files with the history
   entry.
7. Add an entry naming the new contract version to `packages/coding-agent/CHANGELOG.md`.

Rewording documentation (`description`, `title`, `$comment`, a command's `doc`) does not change
the hash and needs no bump.

The `RPC contract` job in O's `ci.yml` (`bun run ci:test:rpc-contract`) enforces this: the
current shape must match the last history entry, versions must ascend, the package version must
equal the last entry, the base branch's history must be an unchanged prefix, and generated files
must be fresh. Contract versions are linear on O `main`, so when two open PRs both bump, the
second to merge rebases and takes the next version.

### The CLI JSON contract

`omp config list|set|reset --json`, `omp models --json`, `omp plugin list --json` and
`omp skill list --json` form a second contract with its own version, `cliContractVersion`. To
change one of those outputs, update its definition in
`packages/coding-agent/src/cli/contract/index.ts`, run `bun run gen:rpc`, append to
`packages/coding-agent/src/cli/contract/contract-history.json`, run `bun run gen:rpc` again and
add a changelog entry. The `packages/rpc-contract/package.json` version stays the RPC contract
version. No subcommand reports the CLI contract at runtime; T relies on the tag pin.

## 2. O: cut a release tag

Tags are `v<upstream-version>-ompanel.<n>`, cut from O `main` by an admin and pushed alone:

```bash
git tag v<upstream-version>-ompanel.<n> origin/main
git push origin v<upstream-version>-ompanel.<n>
```

The push runs `fork-release.yml`, which runs O's `ci.yml` on the tag and, if every gate passes,
publishes a GitHub release with the eight `omp-*` binaries, one `<asset>.sha256` per asset and
`SHA256SUMS.txt`. A release takes about 1.5 to 2.5 hours. A pushed tag is never moved; a fix
ships as the next `-ompanel.<n>`. Details: O's `docs/fork-release.md` and
[fork-and-merge.md](fork-and-merge.md#tags).

## 3. T: re-pin

Work in a branch of T. Each step names what fails when it is skipped.

1. **Update the lock.** Set `tag`, `commit`, `version`, `contract` (`version`, `schemaHash`) and
   `cliContract` (`version`, `schemaHash`) in `packages/provider-omp/omp.lock` and the same
   values in `packages/provider-omp/src/ompLock.ts` (`ompLock.test.ts` fails when they differ).
   The contract values are in the tag's `packages/rpc-contract/contract.json` and
   `cli-contract.json`.
2. **Vendor the contract.**

   ```bash
   vp run --filter @t3tools/provider-omp contract:vendor
   ```

   This runs `packages/provider-omp/scripts/check-contract.ts --write`: it fetches the tag from
   the public fork with `git` (no credentials), replaces `packages/provider-omp/contract/` with
   the tag's `packages/rpc-contract` files (`contract.json`, `rpc-wire.schema.json`,
   `cli-contract.json`, `cli-contract.schema.json`, `src/`), regenerates
   `src/ompSettingKeys.generated.ts` from the tag's settings registry, and then runs the check.
   `vp run --filter @t3tools/provider-omp contract:check` alone checks without writing; CI runs it
   in the `Lint` job. It fails when the tag moved off `commit`, when a version or hash differs
   from the lock, or when any vendored file differs by a byte.

3. **Add the sidecar hashes.** Once the release is published, copy each platform's sha256 from
   its `SHA256SUMS.txt` into `sidecars` in both `omp.lock` and `src/ompLock.ts`:

   ```bash
   gh release view <tag> -R TurtleByte-IN/oh-my-pi
   gh release download <tag> -R TurtleByte-IN/oh-my-pi -p SHA256SUMS.txt -O -
   ```

   Leave out a platform the release has no asset for; Ompanel then has no managed sidecar there.
   The server and desktop packaging refuse any binary whose sha256 differs
   ([sidecar.md](sidecar.md)).

4. **Fix the code against the new types.** The vendored `RpcWireCommands` and frame types change
   with the contract; the typecheck shows what moved. When the new version reaches a feature gate
   (`OMP_*_CONTRACT`, [provider-internals.md](provider-internals.md#features-gated-on-the-contract)),
   the feature turns on; replace any hand-written stand-in for a wire type there with the
   vendored one.
5. **Re-record the replay fixtures** with a checkout of O at the new commit:
   `pnpm --filter t3 record:omp-replay --omp-source <checkout>`
   ([testing.md](testing.md#recording)). The replay suite fails while a transcript names another
   tag or contract version.
6. **Re-check what the pin decides by hand:**
   - `OMP_LAUNCH_SCOPED_KEYS` in `packages/provider-omp/src/configForm.ts`, which the CLI contract
     does not report ([settings.md](settings.md#launch-scoped-keys));
   - the keys in `OMP_SETTINGS_PAGES`, which a test checks against the regenerated registry;
   - the control fake's `PINNED_*` outputs in
     `packages/provider-omp/src/server/testing/fakeOmpControl.ts`, captured from the pinned
     sidecar, where a CLI or RPC output changed shape;
   - pages that name the pinned tag or contract: [open-questions.md](open-questions.md),
     [testing.md](testing.md), [subagents.md](subagents.md), [host-tools.md](host-tools.md),
     [thread-menu.md](thread-menu.md) and `docs/operations/observability.md`.

Desktop packaging and the first-run download read `omp.lock`, so they ship the new sidecar with
no further change.
