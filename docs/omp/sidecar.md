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
2. The sidecar the desktop app ships, which it names by absolute path in the
   server's `OMPANEL_OMP_BUNDLED_PATH` environment variable, if its sha256
   matches `omp.lock`. A relative path or bare name there is an error.
3. `tools/omp/<tag>/<asset>` under the server's base directory (the download
   cache), if its sha256 matches `omp.lock`.
4. If none of these exists, the server downloads the pinned sidecar into the
   cache (see below) and uses it.

A bundled or cached file whose sha256 differs is never run, and is never
replaced by a download either: the status shows the refusal. A binary path
set by hand is shown in the status as not checked against `omp.lock`.

Every status check, and every spawn, resolves the sidecar again and re-hashes
it. The file is opened once, its owner and mode are checked on that handle,
its bytes are hashed through the same handle, and the path must still name the
same unchanged file (device, inode, size, mtime and ctime) when hashing ends.
A file swapped or rewritten in between is refused. Cached probe results are
keyed on that identity, so a replaced binary is never reported ready from the
cache.

## First-run download (web and server)

When no sidecar is bundled or cached, the server fetches
`https://github.com/<repository>/releases/download/<tag>/<asset>` from the
pinned fork release:

- It refuses before any request when `omp.lock` has no asset or no sha256 for
  the host platform, or names an asset that is not a plain file name.
- The bytes stream into a new temp file in `tools/omp/<tag>/`, created
  exclusively with mode 0700, and are hashed as they arrive (at most 1 GiB, 10
  minutes).
- Only when the sha256 matches `omp.lock` is the temp file renamed over
  `<asset>`, in the same folder, so the target is either absent or complete.
  On a mismatch or any failure the temp file is deleted.
- Concurrent checks share one download.

## Cache folder rules

On macOS and Linux the server creates `tools/omp` and `tools/omp/<tag>` with
mode 0700. It refuses to use the cache, or to download into it, when either
folder or the cached file is not owned by the current user, is writable by
group or others, or is not a plain folder or file (a symlink is refused). Only
the user who runs Ompanel can then replace the binary after it is verified.
A bundled sidecar must not be writable by group or others; it may belong to
another user, such as root for a system-wide install. Windows keeps the cache
in the user's profile and skips the POSIX checks.

## Desktop bundling

`scripts/build-desktop-artifact.ts` stages the pinned sidecar for each OMP
release target the app runs on as `omp/<target>/omp` (`omp.exe` on Windows)
in the app's resources: `darwin-arm64` or `darwin-x64` on macOS (both for a
universal app), `linux-x64` or `linux-arm64`, `win32-x64` or `win32-arm64`. It
downloads each asset from the fork release and checks its sha256 against
`omp.lock`, or takes the asset from `OMPANEL_DESKTOP_OMP_SIDECAR_DIR` (a folder
of release assets by name) and checks it the same way. A lock with no sidecar
for a target makes the build ship without OMP and log a warning; the server
then downloads it on first use.

electron-builder copies the folder as an extra resource and keeps it out of
`app.asar`. Signing must not rewrite the file, or its sha256 would no longer
match: macOS signing skips it (`signIgnore`) and Windows signing excludes it
(`signExts`). The macOS asset therefore keeps the signature the OMP release
gave it; notarizing Ompanel needs that to be a Developer ID signature, which
the fork's release CI applies once its `APPLE_*` secrets are set (until then it
signs ad hoc). A universal macOS app ships both Darwin sidecars unchanged in
both halves (`x64ArchFiles`).

At start-up the packaged desktop app looks for
`<resources>/omp/<platform>-<arch>/omp[.exe]` for its own process
architecture and, when it exists, passes the absolute path to the server in
`OMPANEL_OMP_BUNDLED_PATH`. The WSL backend gets no bundled path.

To try packaging before a release carries the assets, point
`OMPANEL_DESKTOP_OMP_LOCK` at a lock file whose `sidecars` hold the sha256 of
local stand-in binaries in `OMPANEL_DESKTOP_OMP_SIDECAR_DIR`. The app that
results carries a sidecar its own server refuses, since the server checks
against the `omp.lock` it was built with.

## Control processes

Every short-lived `omp` process Ompanel starts outside a thread goes through
`OmpControlService` (`packages/provider-omp/src/server/control.ts`). Each has a
hard deadline from spawn to exit:

| Operation                                          | Limit |
| -------------------------------------------------- | ----- |
| `omp --version`                                    | 4 s   |
| Status RPC server: `ready` + `get_login_providers` | 10 s  |
| `omp usage --json`                                 | 10 s  |
| RPC `login` session                                | 60 s  |

On a deadline the process group gets SIGTERM and, 1 s later, SIGKILL, so a
hung omp and its children never outlive the call. Probe and usage results are
cached for 30 s per provider instance, keyed by binary (path and file
identity), profile and working directory; failed usage runs are not cached,
and a successful login drops the
instance's cache. Callers sharing a result in flight share one process.

RPC control processes run `omp --mode rpc --no-session --no-tools
--no-extensions --no-skills --no-rules --no-lsp --no-title` (plus
`--profile <name>` when the instance sets one). `--no-tools` also keeps MCP
servers from starting. Login providers that extensions contribute are
therefore not listed.

## Status checks

An enabled OMP instance runs `omp --version`, then starts an RPC control
process, reads its first frame, which must be `ready`, and sends
`get_login_providers`. The process is stopped right after. The check runs in
the background: the provider list shows "Checking the OMP sidecar..." until it
finishes and never waits for it.

The instance is ready only when `ready.contractVersion` equals
`contract.version` in `omp.lock`; a sidecar that reports another version, or
none, is shown as an error.

`get_login_providers` lists OAuth providers only (`LoginProvider {id, name,
available, authenticated}`). The status card shows the signed-in ones as
authenticated; with none signed in, auth stays "unknown", because API keys and
environment credentials are not visible there.
