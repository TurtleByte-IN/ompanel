// @effect-diagnostics nodeBuiltinImport:off - hashing must read the inode it stats (fstat on an open handle) and compare ctime/inode, which Effect's FileSystem does not expose; Effect also has no incremental sha256 digest.
import * as NodeCrypto from "node:crypto";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  OMP_LOCK,
  type OmpLock,
  type OmpSidecarAsset,
  type OmpSidecarPlatform,
} from "../ompLock.ts";

/** Set by the desktop app to the sidecar it ships in its resources. */
export const OMP_BUNDLED_SIDECAR_ENV = "OMPANEL_OMP_BUNDLED_PATH";

export type OmpLinuxLibc = "gnu" | "musl";

function detectOmpLinuxLibc(): OmpLinuxLibc {
  try {
    const report = process.report?.getReport() as
      | { readonly header?: { readonly glibcVersionRuntime?: unknown } }
      | undefined;
    return typeof report?.header?.glibcVersionRuntime === "string" ? "gnu" : "musl";
  } catch {
    return "musl";
  }
}

export const OmpHostLinuxLibc = Context.Reference<OmpLinuxLibc>(
  "@t3tools/provider-omp/server/sidecar/OmpHostLinuxLibc",
  { defaultValue: detectOmpLinuxLibc },
);

/**
 * The user id cache folders and files must belong to. Undefined on Windows, where the cache
 * lives in the user's profile and POSIX owner and mode bits do not apply.
 */
export const OmpHostUserId = Context.Reference<number | undefined>(
  "@t3tools/provider-omp/server/sidecar/OmpHostUserId",
  { defaultValue: () => process.getuid?.() },
);

export function ompSidecarPlatform(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
  linuxLibc: OmpLinuxLibc,
): OmpSidecarPlatform | undefined {
  if (architecture !== "arm64" && architecture !== "x64") return undefined;
  switch (platform) {
    case "darwin":
      return `darwin-${architecture}`;
    case "win32":
      return `win32-${architecture}`;
    case "linux":
      return linuxLibc === "musl" ? `linux-musl-${architecture}` : `linux-${architecture}`;
    default:
      return undefined;
  }
}

/** A release asset name is a single path segment; anything else could escape the cache folder. */
export function isSafeOmpAssetName(asset: string): boolean {
  return (
    asset.length > 0 &&
    asset !== "." &&
    asset !== ".." &&
    !asset.startsWith(".") &&
    !/[/\\:\0]/u.test(asset)
  );
}

const SHA256_HEX = /^[0-9a-f]{64}$/u;

export type OmpSidecarSource = "override" | "bundled" | "cache";

export interface OmpSidecar {
  readonly path: string;
  readonly source: OmpSidecarSource;
  /** False only for an explicit override, which the user vouches for. */
  readonly verified: boolean;
  /**
   * Device, inode, size, mtime and ctime of the file as it was checked. Any replacement or
   * rewrite of the file changes it, so caches of results about this binary key on it.
   */
  readonly identity: string;
}

export const OmpSidecarErrorReason = Schema.Literals([
  "override_not_absolute",
  "override_missing",
  "bundled_not_absolute",
  "unsupported_platform",
  "missing_sha256",
  "invalid_asset_name",
  "insecure_permissions",
  "unreadable",
  "sha256_mismatch",
  "download_failed",
  "not_found",
  /** The instance's launch settings (launch arguments, agent directory) are refused. */
  "invalid_launch_settings",
]);
export type OmpSidecarErrorReason = typeof OmpSidecarErrorReason.Type;

export class OmpSidecarError extends Schema.TaggedError<OmpSidecarError>()("OmpSidecarError", {
  reason: OmpSidecarErrorReason,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export interface OmpSidecarResolveInput {
  /** Explicit binary path from the instance settings; empty means none. */
  readonly overridePath: string;
  /** Sidecar shipped with the app, if any; must be absolute so `PATH` is never consulted. */
  readonly bundledPath: string | undefined;
  /** Directory holding downloaded sidecars as `<tag>/<asset>`. */
  readonly cacheDir: string;
}

export const ompSidecarCachePath = (
  path: Path.Path,
  cacheDir: string,
  lock: OmpLock,
  asset: string,
): string => path.join(cacheDir, lock.tag, asset);

/**
 * The pinned asset for this host. Fails when the lock has no usable entry: no asset for the
 * platform, an asset name that is not a single path segment, or no sha256 to verify against.
 */
export const pinnedOmpSidecar = Effect.fn("pinnedOmpSidecar")(function* (lock: OmpLock) {
  const hostPlatform = yield* HostProcess.Platform;
  const platform = ompSidecarPlatform(
    hostPlatform,
    yield* HostProcess.Architecture,
    // Only a Linux asset depends on the libc. Detecting it builds a process report, which on
    // Windows intermittently corrupted the heap and crashed the server at startup.
    hostPlatform === "linux" ? yield* OmpHostLinuxLibc : "gnu",
  );
  const pinned = platform === undefined ? undefined : lock.sidecars[platform];
  if (platform === undefined || pinned === undefined) {
    return yield* new OmpSidecarError({
      reason: "unsupported_platform",
      detail: `OMP ${lock.tag} has no sidecar for this platform${platform ? ` (${platform})` : ""}. Set the OMP binary path to an omp executable.`,
    });
  }
  if (!isSafeOmpAssetName(pinned.asset)) {
    return yield* new OmpSidecarError({
      reason: "invalid_asset_name",
      detail: `omp.lock names the ${platform} sidecar "${pinned.asset}", which is not a plain file name.`,
    });
  }
  if (!SHA256_HEX.test(pinned.sha256.toLowerCase())) {
    return yield* new OmpSidecarError({
      reason: "missing_sha256",
      detail: `omp.lock has no sha256 for the ${platform} sidecar of OMP ${lock.tag}, so Ompanel cannot verify it.`,
    });
  }
  return { platform, asset: pinned.asset, sha256: pinned.sha256.toLowerCase() } satisfies {
    readonly platform: OmpSidecarPlatform;
  } & OmpSidecarAsset;
});

const statIdentity = (stats: NodeFS.BigIntStats): string =>
  [stats.dev, stats.ino, stats.size, stats.mtimeNs, stats.ctimeNs].join(":");

const isMissing = (cause: unknown) => {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;
  return code === "ENOENT" || code === "ENOTDIR";
};

/** `lstat`, or undefined when nothing exists at the path. */
const lstatOrUndefined = (filePath: string) =>
  Effect.tryPromise({
    try: () =>
      NodeFSP.lstat(filePath, { bigint: true }).catch((cause: unknown) => {
        if (isMissing(cause)) return undefined;
        throw cause;
      }),
    catch: (cause) =>
      new OmpSidecarError({
        reason: "unreadable",
        detail: `Ompanel cannot inspect ${filePath}.`,
        cause,
      }),
  });

/**
 * Owner and mode rule for the download cache: each folder and the file must belong to the
 * user and be writable by nobody else, so no other account can swap the binary after it is
 * verified.
 */
const describeUnsafeOwnership = (
  stats: { readonly uid: bigint | number; readonly mode: bigint | number },
  userId: number,
): string | undefined => {
  if (Number(stats.uid) !== userId) return "is not owned by the current user";
  if ((Number(stats.mode) & 0o022) !== 0) return "is writable by other users";
  return undefined;
};

const insecurePermissionsError = (target: string, problem: string) =>
  new OmpSidecarError({
    reason: "insecure_permissions",
    detail: `Refused to use the OMP sidecar cache: ${target} ${problem}.`,
  });

/** Checks the cache folder rule for an existing directory; a symlink is refused. */
export const checkPrivateDirectory = Effect.fn("checkPrivateDirectory")(function* (
  directory: string,
) {
  const userId = yield* OmpHostUserId;
  const stats = yield* lstatOrUndefined(directory);
  if (stats === undefined) return false;
  if (!stats.isDirectory()) {
    return yield* insecurePermissionsError(directory, "is not a plain directory");
  }
  if (userId === undefined) return true;
  const problem = describeUnsafeOwnership(stats, userId);
  if (problem) return yield* insecurePermissionsError(directory, problem);
  return true;
});

export type OmpFileCheck =
  /** Explicit override: the user vouches for the file; no hash or permission check. */
  | { readonly kind: "none" }
  /** Bundled with the app: must not be writable by group or others. */
  | { readonly kind: "shared"; readonly sha256: string }
  /** Download cache: owned by the user, writable by nobody else, not a symlink. */
  | { readonly kind: "private"; readonly sha256: string };

export type OmpFileInspection =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Mismatch"; readonly digest: string }
  | { readonly _tag: "Ok"; readonly identity: string };

const HASH_CHUNK_BYTES = 1024 * 1024;

/**
 * Opens the file once, checks owner and mode on that handle, hashes its bytes through the same
 * handle, then confirms the path still names the same unchanged inode. A file replaced or
 * rewritten at any point during the check is refused rather than reported as verified.
 */
const inspectOmpSidecarFile = Effect.fn("inspectOmpSidecarFile")(function* (
  filePath: string,
  check: OmpFileCheck,
) {
  const userId = yield* OmpHostUserId;
  if (check.kind === "private") {
    const link = yield* lstatOrUndefined(filePath);
    if (link === undefined) return { _tag: "Missing" } satisfies OmpFileInspection;
    if (!link.isFile()) {
      return yield* insecurePermissionsError(filePath, "is not a regular file");
    }
  }
  const outcome = yield* Effect.tryPromise({
    try: async (): Promise<
      | OmpFileInspection
      | { readonly _tag: "NotFile" | "Changed" }
      | {
          readonly _tag: "Unsafe";
          readonly problem: string;
        }
    > => {
      let handle: NodeFSP.FileHandle;
      try {
        handle = await NodeFSP.open(filePath, "r");
      } catch (cause) {
        if (isMissing(cause)) return { _tag: "Missing" };
        throw cause;
      }
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile()) return { _tag: "NotFile" };
        if (check.kind !== "none" && userId !== undefined) {
          const problem =
            check.kind === "private"
              ? describeUnsafeOwnership(before, userId)
              : (Number(before.mode) & 0o022) !== 0
                ? "is writable by other users"
                : undefined;
          if (problem) return { _tag: "Unsafe", problem };
        }
        if (check.kind === "none") return { _tag: "Ok", identity: statIdentity(before) };
        const hash = NodeCrypto.createHash("sha256");
        const buffer = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
        let position = 0;
        for (;;) {
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
          if (bytesRead === 0) break;
          hash.update(buffer.subarray(0, bytesRead));
          position += bytesRead;
        }
        const after = await NodeFSP.stat(filePath, { bigint: true });
        const afterHandle = await handle.stat({ bigint: true });
        const identity = statIdentity(before);
        if (statIdentity(after) !== identity || statIdentity(afterHandle) !== identity) {
          return { _tag: "Changed" };
        }
        const digest = hash.digest("hex");
        return digest === check.sha256 ? { _tag: "Ok", identity } : { _tag: "Mismatch", digest };
      } finally {
        await handle.close();
      }
    },
    catch: (cause) =>
      new OmpSidecarError({
        reason: "unreadable",
        detail: `Ompanel cannot read the OMP executable at ${filePath}.`,
        cause,
      }),
  });
  switch (outcome._tag) {
    case "NotFile":
      return { _tag: "Missing" } satisfies OmpFileInspection;
    case "Unsafe":
      return yield* insecurePermissionsError(filePath, outcome.problem);
    case "Changed":
      return yield* new OmpSidecarError({
        reason: "sha256_mismatch",
        detail: `Refused to run ${filePath}: it changed while Ompanel was verifying it.`,
      });
    default:
      return outcome;
  }
});

/**
 * Resolves the omp executable: explicit override, then the bundled sidecar, then the download
 * cache. Bundled and cached files run only when their sha256 matches `omp.lock`; `PATH` is never
 * searched. Every call re-reads and re-hashes the file, so call it right before each spawn and
 * never reuse an earlier result's path.
 */
export const makeOmpSidecarResolver = Effect.fn("makeOmpSidecarResolver")(function* (
  lock: OmpLock = OMP_LOCK,
) {
  const path = yield* Path.Path;

  const resolve = Effect.fn("OmpSidecar.resolve")(function* (input: OmpSidecarResolveInput) {
    const overridePath = input.overridePath.trim();
    if (overridePath.length > 0) {
      const expanded = expandHome(overridePath, yield* HostProcess.HomeDirectory, path);
      if (!path.isAbsolute(expanded)) {
        return yield* new OmpSidecarError({
          reason: "override_not_absolute",
          detail: `The OMP binary path must be absolute; "${overridePath}" is not.`,
        });
      }
      const inspection = yield* inspectOmpSidecarFile(expanded, { kind: "none" });
      if (inspection._tag !== "Ok") {
        return yield* new OmpSidecarError({
          reason: "override_missing",
          detail: `No OMP executable exists at the configured binary path ${expanded}.`,
        });
      }
      return {
        path: expanded,
        source: "override",
        verified: false,
        identity: inspection.identity,
      } satisfies OmpSidecar;
    }

    if (input.bundledPath && !path.isAbsolute(input.bundledPath)) {
      return yield* new OmpSidecarError({
        reason: "bundled_not_absolute",
        detail: `The bundled OMP sidecar path must be absolute; "${input.bundledPath}" is not.`,
      });
    }

    const pinned = yield* pinnedOmpSidecar(lock);
    const refused: Array<string> = [];

    if (input.bundledPath) {
      const inspection = yield* inspectOmpSidecarFile(input.bundledPath, {
        kind: "shared",
        sha256: pinned.sha256,
      });
      if (inspection._tag === "Ok") {
        return {
          path: input.bundledPath,
          source: "bundled",
          verified: true,
          identity: inspection.identity,
        } satisfies OmpSidecar;
      }
      if (inspection._tag === "Mismatch") refused.push(input.bundledPath);
    }

    const tagDir = path.join(input.cacheDir, lock.tag);
    if ((yield* checkPrivateDirectory(input.cacheDir)) && (yield* checkPrivateDirectory(tagDir))) {
      const cachePath = ompSidecarCachePath(path, input.cacheDir, lock, pinned.asset);
      const inspection = yield* inspectOmpSidecarFile(cachePath, {
        kind: "private",
        sha256: pinned.sha256,
      });
      if (inspection._tag === "Ok") {
        return {
          path: cachePath,
          source: "cache",
          verified: true,
          identity: inspection.identity,
        } satisfies OmpSidecar;
      }
      if (inspection._tag === "Mismatch") refused.push(cachePath);
    }

    if (refused.length > 0) {
      return yield* new OmpSidecarError({
        reason: "sha256_mismatch",
        detail: `Refused to run ${refused.join(", ")}: its sha256 does not match OMP ${lock.tag}.`,
      });
    }
    return yield* new OmpSidecarError({
      reason: "not_found",
      detail: `The OMP ${lock.tag} sidecar is not installed.`,
    });
  });

  return { resolve };
});

function expandHome(value: string, home: string, path: Path.Path): string {
  if (value === "~") return home;
  if (value.startsWith("~/") || value.startsWith("~\\")) return path.join(home, value.slice(2));
  return value;
}
