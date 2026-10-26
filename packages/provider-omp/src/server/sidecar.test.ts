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
  makeOmpSidecarResolver,
  OmpHostLinuxLibc,
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
        yield* fileSystem.writeFileString(target, contents);
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
        assert.deepStrictEqual(sidecar, { path: override, source: "override", verified: false });
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
        assert.deepStrictEqual(sidecar, { path: bundled, source: "bundled", verified: true });
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
        assert.deepStrictEqual(sidecar, { path: cached, source: "cache", verified: true });
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
        assert.deepStrictEqual(sidecar, { path: cached, source: "cache", verified: true });
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
});
