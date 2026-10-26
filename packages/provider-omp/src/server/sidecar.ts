// @effect-diagnostics nodeBuiltinImport:off - Effect has no incremental sha256 digest.
import * as NodeCrypto from "node:crypto";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { OMP_LOCK, type OmpLock, type OmpSidecarPlatform } from "../ompLock.ts";

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

export type OmpSidecarSource = "override" | "bundled" | "cache";

export interface OmpSidecar {
  readonly path: string;
  readonly source: OmpSidecarSource;
  /** False only for an explicit override, which the user vouches for. */
  readonly verified: boolean;
}

export const OmpSidecarErrorReason = Schema.Literals([
  "override_not_absolute",
  "override_missing",
  "unsupported_platform",
  "sha256_mismatch",
  "not_found",
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
  /** Sidecar shipped with the app, if any. */
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
 * Resolves the omp executable: explicit override, then the bundled sidecar, then the download
 * cache. Bundled and cached files run only when their sha256 matches `omp.lock`; `PATH` is never
 * searched.
 */
export const makeOmpSidecarResolver = Effect.fn("makeOmpSidecarResolver")(function* (
  lock: OmpLock = OMP_LOCK,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Hashing a sidecar reads the whole executable; reuse the digest while the file is unchanged.
  const digests = yield* Ref.make(new Map<string, string>());

  const regularFile = (filePath: string) =>
    fileSystem
      .stat(filePath)
      .pipe(Effect.option, Effect.map(Option.filter((info) => info.type === "File")));

  const sha256Of = Effect.fn("OmpSidecar.sha256Of")(function* (
    filePath: string,
    info: FileSystem.File.Info,
  ) {
    const key = `${filePath}\0${info.size}\0${Option.match(info.mtime, {
      onNone: () => "",
      onSome: (mtime) => mtime.getTime(),
    })}`;
    const cached = (yield* Ref.get(digests)).get(key);
    if (cached !== undefined) return cached;
    const hash = NodeCrypto.createHash("sha256");
    yield* fileSystem
      .stream(filePath)
      .pipe(Stream.runForEach((chunk) => Effect.sync(() => hash.update(chunk))));
    const digest = hash.digest("hex");
    yield* Ref.update(digests, (current) => new Map(current).set(key, digest));
    return digest;
  });

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
      if (Option.isNone(yield* regularFile(expanded))) {
        return yield* new OmpSidecarError({
          reason: "override_missing",
          detail: `No OMP executable exists at the configured binary path ${expanded}.`,
        });
      }
      return { path: expanded, source: "override", verified: false } satisfies OmpSidecar;
    }

    const platform = ompSidecarPlatform(
      yield* HostProcess.Platform,
      yield* HostProcess.Architecture,
      yield* OmpHostLinuxLibc,
    );
    const pinned = platform === undefined ? undefined : lock.sidecars[platform];
    if (platform === undefined || pinned === undefined) {
      return yield* new OmpSidecarError({
        reason: "unsupported_platform",
        detail: `OMP ${lock.tag} has no sidecar for this platform${platform ? ` (${platform})` : ""}. Set the OMP binary path to an omp executable.`,
      });
    }

    const candidates: ReadonlyArray<{ readonly source: OmpSidecarSource; readonly path: string }> =
      [
        ...(input.bundledPath ? [{ source: "bundled" as const, path: input.bundledPath }] : []),
        {
          source: "cache",
          path: ompSidecarCachePath(path, input.cacheDir, lock, pinned.asset),
        },
      ];
    const refused: Array<string> = [];
    for (const candidate of candidates) {
      const info = yield* regularFile(candidate.path);
      if (Option.isNone(info)) continue;
      const digest = yield* sha256Of(candidate.path, info.value).pipe(Effect.option);
      if (Option.isSome(digest) && digest.value === pinned.sha256.toLowerCase()) {
        return {
          path: candidate.path,
          source: candidate.source,
          verified: true,
        } satisfies OmpSidecar;
      }
      refused.push(candidate.path);
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
