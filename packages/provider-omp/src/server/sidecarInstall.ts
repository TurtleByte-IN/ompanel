// @effect-diagnostics nodeBuiltinImport:off - the download is written through one exclusive file handle (O_EXCL, mode 0700) and hashed as it streams; Effect's FileSystem has neither.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";

import { OMP_LOCK, type OmpLock } from "../ompLock.ts";
import {
  checkPrivateDirectory,
  makeOmpSidecarResolver,
  OmpSidecarError,
  ompSidecarCachePath,
  pinnedOmpSidecar,
  type OmpSidecarResolveInput,
} from "./sidecar.ts";

/** A release asset larger than this is refused rather than allowed to fill the disk. */
const OMP_SIDECAR_DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;
const OMP_SIDECAR_DOWNLOAD_TIMEOUT = Duration.minutes(10);

/** The pinned release asset on the OMP fork's GitHub release. */
export const ompSidecarDownloadUrl = (lock: OmpLock, asset: string): string =>
  `https://github.com/${lock.repository}/releases/download/${encodeURIComponent(lock.tag)}/${encodeURIComponent(asset)}`;

const downloadFailed = (detail: string, cause?: unknown) =>
  new OmpSidecarError({ reason: "download_failed", detail, cause });

/** Creates `directory` with mode 0700 if absent, then applies the cache folder rule to it. */
const ensurePrivateDirectory = Effect.fn("ensurePrivateDirectory")(function* (directory: string) {
  // Recursive creation succeeds on an existing folder; the mode only applies to new ones.
  yield* Effect.tryPromise({
    try: () => NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 }),
    catch: (cause) => downloadFailed(`Ompanel cannot create ${directory}.`, cause),
  });
  if (!(yield* checkPrivateDirectory(directory))) {
    return yield* downloadFailed(`${directory} disappeared while Ompanel was creating it.`);
  }
});

/**
 * Downloads the pinned sidecar into `<cacheDir>/<tag>/<asset>` through an exclusive 0700 temp file
 * that is renamed over the target only when its sha256 matches `omp.lock`, and deleted otherwise.
 * Refuses with no request when the lock has no sha256 for the host, or the cache folders are unsafe.
 */
export const installOmpSidecar = Effect.fn("installOmpSidecar")(function* (
  input: { readonly cacheDir: string },
  lock: OmpLock = OMP_LOCK,
) {
  const path = yield* Path.Path;
  const pinned = yield* pinnedOmpSidecar(lock);
  const tagDir = path.join(input.cacheDir, lock.tag);
  yield* ensurePrivateDirectory(input.cacheDir);
  yield* ensurePrivateDirectory(tagDir);

  const target = ompSidecarCachePath(path, input.cacheDir, lock, pinned.asset);
  const tempPath = path.join(
    tagDir,
    `.${pinned.asset}.${NodeCrypto.randomBytes(8).toString("hex")}.download`,
  );
  const url = ompSidecarDownloadUrl(lock, pinned.asset);
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);

  const download = Effect.gen(function* () {
    const handle = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => NodeFSP.open(tempPath, "wx", 0o700),
        catch: (cause) => downloadFailed(`Ompanel cannot create ${tempPath}.`, cause),
      }),
      (handle) => Effect.tryPromise(() => handle.close()).pipe(Effect.ignore),
    );
    const hash = NodeCrypto.createHash("sha256");
    let received = 0;
    const response = yield* client
      .get(url)
      .pipe(Effect.mapError((cause) => downloadFailed(`Downloading ${url} failed.`, cause)));
    yield* response.stream.pipe(
      Stream.mapError((cause) => downloadFailed(`Downloading ${url} failed.`, cause)),
      Stream.runForEach((chunk) =>
        Effect.gen(function* () {
          received += chunk.byteLength;
          if (received > OMP_SIDECAR_DOWNLOAD_MAX_BYTES) {
            return yield* downloadFailed(
              `${url} is larger than ${OMP_SIDECAR_DOWNLOAD_MAX_BYTES} bytes; refused.`,
            );
          }
          hash.update(chunk);
          yield* Effect.tryPromise({
            try: () => handle.writeFile(chunk),
            catch: (cause) => downloadFailed(`Ompanel cannot write ${tempPath}.`, cause),
          });
        }),
      ),
    );
    yield* Effect.tryPromise({
      try: () => handle.sync(),
      catch: (cause) => downloadFailed(`Ompanel cannot write ${tempPath}.`, cause),
    });
    return hash.digest("hex");
  }).pipe(Effect.scoped);

  const verifyAndInstall = Effect.gen(function* () {
    const digest = yield* download.pipe(
      Effect.timeoutOrElse({
        duration: OMP_SIDECAR_DOWNLOAD_TIMEOUT,
        orElse: () =>
          Effect.fail(
            downloadFailed(
              `Downloading ${url} did not finish within ${Duration.format(OMP_SIDECAR_DOWNLOAD_TIMEOUT)}.`,
            ),
          ),
      }),
    );
    if (digest !== pinned.sha256) {
      return yield* new OmpSidecarError({
        reason: "sha256_mismatch",
        detail: `Refused the download of ${url}: its sha256 ${digest} does not match OMP ${lock.tag}.`,
      });
    }
    // Same folder, so the rename is atomic: the target is either absent or the verified file.
    yield* Effect.tryPromise({
      try: () => NodeFSP.rename(tempPath, target),
      catch: (cause) => downloadFailed(`Ompanel cannot install ${target}.`, cause),
    });
    return target;
  });

  // No partial or refused download stays behind; after the rename the temp path is gone.
  return yield* verifyAndInstall.pipe(
    Effect.ensuring(
      Effect.tryPromise(() => NodeFSP.rm(tempPath, { force: true })).pipe(Effect.ignore),
    ),
  );
});

/**
 * The resolver plus first-run download: when neither a bundled nor a cached sidecar exists, it
 * installs the pinned one into the cache and resolves again. A bundled or cached file that fails
 * verification is reported, never replaced by a download. Concurrent callers share one download.
 */
export const makeOmpSidecarProvisioner = Effect.fn("makeOmpSidecarProvisioner")(function* (
  lock: OmpLock = OMP_LOCK,
) {
  const resolver = yield* makeOmpSidecarResolver(lock);
  const path = yield* Path.Path;
  const installing = yield* Semaphore.make(1);

  const resolve = Effect.fn("OmpSidecar.resolveOrInstall")(function* (
    input: OmpSidecarResolveInput,
  ) {
    return yield* resolver.resolve(input).pipe(
      Effect.catchIf(
        (error) => error.reason === "not_found",
        () =>
          installing.withPermits(1)(
            resolver.resolve(input).pipe(
              Effect.catchIf(
                (error) => error.reason === "not_found",
                () =>
                  installOmpSidecar({ cacheDir: input.cacheDir }, lock).pipe(
                    Effect.provideService(Path.Path, path),
                    Effect.andThen(resolver.resolve(input)),
                  ),
              ),
            ),
          ),
      ),
    );
  });

  return { resolve };
});
