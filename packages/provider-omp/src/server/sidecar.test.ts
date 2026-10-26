// @effect-diagnostics nodeBuiltinImport:off - fixtures need a sha256 of known bytes.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { OMP_LOCK, type OmpLock } from "../ompLock.ts";
import {
  isSafeOmpAssetName,
  makeOmpSidecarResolver,
  OmpHostLinuxLibc,
  OmpHostUserId,
  ompSidecarCachePath,
  ompSidecarPlatform,
  type OmpSidecarResolveInput,
} from "./sidecar.ts";

const PINNED_BYTES = "pinned omp sidecar";
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

const LOCK: OmpLock = {
  ...OMP_LOCK,
  sidecars: { "darwin-arm64": { asset: "omp-darwin-arm64", sha256: sha256(PINNED_BYTES) } },
};

interface Fixture {
  readonly dir: string;
  readonly cacheDir: string;
  readonly write: (relative: string, contents: string) => Effect.Effect<string>;
}

const withFixture = <A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "omp-sidecar-" });
    const write = (relative: string, contents: string) =>
      Effect.gen(function* () {
        const target = path.join(dir, relative);
        yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
        // Independent of the umask: folders and files are writable only by their owner.
        for (let current = path.dirname(target); current !== dir; current = path.dirname(current)) {
          yield* fileSystem.chmod(current, 0o755);
        }
        yield* fileSystem.writeFileString(target, contents);
        yield* fileSystem.chmod(target, 0o755);
        return target;
      }).pipe(Effect.orDie);
    return yield* body({ dir, cacheDir: path.join(dir, "cache"), write });
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Architecture, "arm64"),
    Effect.provideService(HostProcess.HomeDirectory, "/home/tester"),
    Effect.provide(NodeServices.layer),
  );

const resolveWith = (input: OmpSidecarResolveInput, lock: OmpLock = LOCK) =>
  makeOmpSidecarResolver(lock).pipe(Effect.flatMap((resolver) => resolver.resolve(input)));

const cacheFile = (fixture: Fixture) =>
  Effect.map(Path.Path, (path) =>
    path.relative(
      fixture.dir,
      ompSidecarCachePath(path, fixture.cacheDir, LOCK, "omp-darwin-arm64"),
    ),
  );

describe("ompSidecarPlatform", () => {
  it("maps hosts to the fork's release targets", () => {
    assert.strictEqual(ompSidecarPlatform("darwin", "arm64", "gnu"), "darwin-arm64");
    assert.strictEqual(ompSidecarPlatform("linux", "x64", "gnu"), "linux-x64");
    assert.strictEqual(ompSidecarPlatform("linux", "arm64", "musl"), "linux-musl-arm64");
    assert.strictEqual(ompSidecarPlatform("win32", "x64", "gnu"), "win32-x64");
    assert.strictEqual(ompSidecarPlatform("freebsd", "x64", "gnu"), undefined);
    assert.strictEqual(ompSidecarPlatform("linux", "ia32", "gnu"), undefined);
  });
});

describe("makeOmpSidecarResolver", () => {
  it.effect("prefers an explicit override path over bundled and cached sidecars", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const override = yield* fixture.write("custom/omp", "developer build");
        const bundled = yield* fixture.write("bundled/omp", PINNED_BYTES);
        yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
        const sidecar = yield* resolveWith({
          overridePath: override,
          bundledPath: bundled,
          cacheDir: fixture.cacheDir,
        });
        assert.deepInclude(sidecar, { path: override, source: "override", verified: false });
      }),
    ),
  );

  it.effect("uses the bundled sidecar before the download cache when its sha256 matches", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const bundled = yield* fixture.write("bundled/omp", PINNED_BYTES);
        yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
        const sidecar = yield* resolveWith({
          overridePath: "",
          bundledPath: bundled,
          cacheDir: fixture.cacheDir,
        });
        assert.deepInclude(sidecar, { path: bundled, source: "bundled", verified: true });
      }),
    ),
  );

  it.effect("falls back to the verified download cache when nothing is bundled", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const cached = yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
        const sidecar = yield* resolveWith({
          overridePath: "",
          bundledPath: undefined,
          cacheDir: fixture.cacheDir,
        });
        assert.deepInclude(sidecar, { path: cached, source: "cache", verified: true });
      }),
    ),
  );

  it.effect("skips a bundled sidecar whose sha256 differs and uses the verified cache", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const bundled = yield* fixture.write("bundled/omp", "tampered");
        const cached = yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
        const sidecar = yield* resolveWith({
          overridePath: "",
          bundledPath: bundled,
          cacheDir: fixture.cacheDir,
        });
        assert.deepInclude(sidecar, { path: cached, source: "cache", verified: true });
      }),
    ),
  );

  it.effect("refuses sidecars whose sha256 does not match omp.lock", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const bundled = yield* fixture.write("bundled/omp", "tampered");
        const cached = yield* fixture.write(yield* cacheFile(fixture), "also tampered");
        const error = yield* resolveWith({
          overridePath: "",
          bundledPath: bundled,
          cacheDir: fixture.cacheDir,
        }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "sha256_mismatch");
        assert.include(error.message, bundled);
        assert.include(error.message, cached);
      }),
    ),
  );

  it.effect("re-hashes a cached sidecar after it is replaced", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const resolver = yield* makeOmpSidecarResolver(LOCK);
        const input = { overridePath: "", bundledPath: undefined, cacheDir: fixture.cacheDir };
        yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
        assert.strictEqual((yield* resolver.resolve(input)).source, "cache");
        yield* fixture.write(yield* cacheFile(fixture), "replaced with different bytes");
        const error = yield* resolver.resolve(input).pipe(Effect.flip);
        assert.strictEqual(error.reason, "sha256_mismatch");
      }),
    ),
  );

  it.effect("reports a missing sidecar without searching PATH", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const error = yield* resolveWith({
          overridePath: "",
          bundledPath: undefined,
          cacheDir: fixture.cacheDir,
        }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "not_found");
      }),
    ),
  );

  it.effect("rejects a bare command name as the override instead of looking it up on PATH", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const error = yield* resolveWith({
          overridePath: "omp",
          bundledPath: undefined,
          cacheDir: fixture.cacheDir,
        }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "override_not_absolute");
      }),
    ),
  );

  it.effect(
    "rejects a relative or bare bundled sidecar path instead of looking it up on PATH",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
          for (const bundledPath of ["omp", "bin/omp"]) {
            const error = yield* resolveWith({
              overridePath: "",
              bundledPath,
              cacheDir: fixture.cacheDir,
            }).pipe(Effect.flip);
            assert.strictEqual(error.reason, "bundled_not_absolute");
            assert.include(error.message, bundledPath);
          }
        }),
      ),
  );

  it.effect("fails when the override path does not exist, without falling back", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const bundled = yield* fixture.write("bundled/omp", PINNED_BYTES);
        const error = yield* resolveWith({
          overridePath: "~/missing/omp",
          bundledPath: bundled,
          cacheDir: fixture.cacheDir,
        }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "override_missing");
        assert.include(error.message, "/home/tester/missing/omp");
      }),
    ),
  );

  it.effect("reports platforms without a pinned asset", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const bundled = yield* fixture.write("bundled/omp", PINNED_BYTES);
        const error = yield* resolveWith({
          overridePath: "",
          bundledPath: bundled,
          cacheDir: fixture.cacheDir,
        }).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(OmpHostLinuxLibc, "musl"),
          Effect.flip,
        );
        assert.strictEqual(error.reason, "unsupported_platform");
        assert.include(error.message, "linux-musl-arm64");
      }),
    ),
  );

  it.effect("re-hashes a same-size replacement whose mtime was restored", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const resolver = yield* makeOmpSidecarResolver(LOCK);
        const input = { overridePath: "", bundledPath: undefined, cacheDir: fixture.cacheDir };
        const cached = yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
        const first = yield* resolver.resolve(input);
        const mtime = 1_700_000_000;
        yield* fileSystem.utimes(cached, mtime, mtime);
        const swapped = "X".repeat(PINNED_BYTES.length);
        yield* fileSystem.writeFileString(cached, swapped);
        yield* fileSystem.utimes(cached, mtime, mtime);
        const error = yield* resolver.resolve(input).pipe(Effect.flip);
        assert.strictEqual(error.reason, "sha256_mismatch");
        assert.isString(first.identity);
      }),
    ),
  );

  it.effect("gives a rewritten file a new identity so cached probe results are dropped", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const override = yield* fixture.write("custom/omp", "developer build");
        const input = {
          overridePath: override,
          bundledPath: undefined,
          cacheDir: fixture.cacheDir,
        };
        const before = yield* resolveWith(input);
        yield* fileSystem.remove(override);
        yield* fixture.write("custom/omp", "another build");
        const after = yield* resolveWith(input);
        assert.notStrictEqual(after.identity, before.identity);
      }),
    ),
  );

  it.effect("refuses a cache folder other users can write to", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
        yield* fileSystem.chmod(fixture.cacheDir, 0o777);
        const error = yield* resolveWith({
          overridePath: "",
          bundledPath: undefined,
          cacheDir: fixture.cacheDir,
        }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "insecure_permissions");
        assert.include(error.message, "writable by other users");
      }),
    ),
  );

  it.effect("refuses a cached file other users can write to", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const cached = yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
        yield* fileSystem.chmod(cached, 0o775);
        const error = yield* resolveWith({
          overridePath: "",
          bundledPath: undefined,
          cacheDir: fixture.cacheDir,
        }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "insecure_permissions");
        assert.include(error.message, cached);
      }),
    ),
  );

  it.effect("refuses a cache owned by another user", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
        const error = yield* resolveWith({
          overridePath: "",
          bundledPath: undefined,
          cacheDir: fixture.cacheDir,
        }).pipe(Effect.provideService(OmpHostUserId, (process.getuid?.() ?? 0) + 1), Effect.flip);
        assert.strictEqual(error.reason, "insecure_permissions");
        assert.include(error.message, "not owned by the current user");
      }),
    ),
  );

  it.effect("refuses a cached sidecar that is a symlink", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const real = yield* fixture.write("elsewhere/omp", PINNED_BYTES);
        const cached = yield* fixture.write(yield* cacheFile(fixture), "placeholder");
        yield* fileSystem.remove(cached);
        yield* fileSystem.symlink(real, cached);
        const error = yield* resolveWith({
          overridePath: "",
          bundledPath: undefined,
          cacheDir: fixture.cacheDir,
        }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "insecure_permissions");
        assert.include(error.message, "not a regular file");
      }),
    ),
  );

  it.effect("skips a bundled sidecar other users can write to", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const bundled = yield* fixture.write("bundled/omp", PINNED_BYTES);
        yield* fileSystem.chmod(bundled, 0o777);
        const error = yield* resolveWith({
          overridePath: "",
          bundledPath: bundled,
          cacheDir: fixture.cacheDir,
        }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "insecure_permissions");
      }),
    ),
  );

  it.effect.skipIf(process.getuid?.() === 0)(
    "reports an unreadable sidecar as unreadable, not as a sha256 mismatch",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const cached = yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
          yield* fileSystem.chmod(cached, 0o000);
          const error = yield* resolveWith({
            overridePath: "",
            bundledPath: undefined,
            cacheDir: fixture.cacheDir,
          }).pipe(Effect.flip);
          assert.strictEqual(error.reason, "unreadable");
        }),
      ),
  );

  it.effect("refuses a lock entry without a sha256 or with a path as its asset name", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* fixture.write(yield* cacheFile(fixture), PINNED_BYTES);
        const input = { overridePath: "", bundledPath: undefined, cacheDir: fixture.cacheDir };
        const noHash = yield* resolveWith(input, {
          ...LOCK,
          sidecars: { "darwin-arm64": { asset: "omp-darwin-arm64", sha256: "" } },
        }).pipe(Effect.flip);
        assert.strictEqual(noHash.reason, "missing_sha256");
        for (const asset of ["../omp", "bin/omp", "bin\\omp", ".."]) {
          const error = yield* resolveWith(input, {
            ...LOCK,
            sidecars: { "darwin-arm64": { asset, sha256: sha256(PINNED_BYTES) } },
          }).pipe(Effect.flip);
          assert.strictEqual(error.reason, "invalid_asset_name", asset);
        }
      }),
    ),
  );
});

describe("isSafeOmpAssetName", () => {
  it("accepts plain release asset names only", () => {
    assert.isTrue(isSafeOmpAssetName("omp-darwin-arm64"));
    assert.isTrue(isSafeOmpAssetName("omp-windows-x64.exe"));
    for (const asset of ["", ".", "..", "../omp", "a/b", "a\\b", ".hidden", "C:omp"]) {
      assert.isFalse(isSafeOmpAssetName(asset), asset);
    }
  });
});
