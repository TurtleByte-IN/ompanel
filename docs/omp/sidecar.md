# The OMP sidecar pin

Ompanel drives one release of the OMP fork (`TurtleByte-IN/oh-my-pi`).
`packages/provider-omp/omp.lock` names that release and is the only place the
pin is recorded:

| Field      | Meaning                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------- |
| `tag`      | Fork release tag, `v<upstream-version>-ompanel.<n>`.                                     |
| `commit`   | Commit the tag points at. The contract check fails if the tag moves.                     |
| `version`  | Version `omp --version` reports for that release.                                        |
| `contract` | `contractVersion` and `schemaHash` of the RPC contract at the tag.                       |
| `sidecars` | Per platform: the release asset name and its sha256 from the release's `SHA256SUMS.txt`. |

A platform with no released asset has no `sidecars` entry. Ompanel then finds
no managed sidecar on that platform, and only an explicit binary path works.

`src/ompLock.ts` mirrors `omp.lock` for the bundled server. `ompLock.test.ts`
fails when the two differ.

## The vendored RPC contract

`packages/provider-omp/contract/` is a byte-for-byte copy of
`packages/rpc-contract` at the pinned tag (`contract.json`,
`rpc-wire.schema.json` and `src/`). Formatting and lint skip it.

`vp run --filter @t3tools/provider-omp contract:check` fetches the tag from the
public fork with `git` (no credentials), then fails when:

- the tag no longer points at `commit`,
- the tag's `contractVersion` or `schemaHash` differs from `omp.lock`,
- any vendored file is missing, extra, or differs by a single byte.

CI runs it in the `Lint` job of `ci.yml`.

## Moving the pin

1. Set `tag`, `commit`, `version` and `contract` in `omp.lock` and in
   `src/ompLock.ts`.
2. Run `vp run --filter @t3tools/provider-omp contract:vendor`. It replaces
   `contract/` with the tag's files and then runs the check.
3. Copy each platform's sha256 from the release's `SHA256SUMS.txt`
   (`gh release view <tag> -R TurtleByte-IN/oh-my-pi`) into `sidecars`.
   Leave out platforms the release has no asset for.

## Finding the sidecar

The server never looks up `omp` on `PATH`. It takes the first of:

1. The instance's binary path, if set. It must be an absolute path (a leading
   `~` is expanded). Ompanel runs it as given, without a sha256 check, and fails
   if it does not exist rather than falling back.
2. The sidecar the desktop app ships, if its sha256 matches `omp.lock`.
3. `<tag>/<asset>` in the download cache, if its sha256 matches `omp.lock`.

A bundled or cached file whose sha256 differs is never run.
