// @effect-diagnostics nodeBuiltinImport:off - fixtures need a sha256 of known bytes.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { OMP_LOCK, type OmpLock } from "@t3tools/provider-omp/sidecar";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import {
  createBuildConfig,
  DESKTOP_FILE_EXCLUSIONS,
  MAC_OMP_SIDECAR_SIGN_IGNORE,
  MAC_UNIVERSAL_OMP_SIDECAR_X64_ARCH_FILES,
  OMP_SIDECAR_EXTRA_RESOURCES,
  ompSidecarExecutableName,
  OmpSidecarBundleError,
  resolveOmpSidecarPlatforms,
  stageOmpSidecar,
  WINDOWS_OMP_SIDECAR_SIGN_EXCLUSION,
} from "./build-desktop-artifact.ts";

const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");

const lockFor = (sidecars: OmpLock["sidecars"]): OmpLock => ({ ...OMP_LOCK, sidecars });

it.layer(NodeServices.layer)("OMP sidecar packaging", (it) => {
  it("maps each app build to the OMP release targets it ships", () => {
    assert.deepStrictEqual(resolveOmpSidecarPlatforms("mac", "arm64"), ["darwin-arm64"]);
    assert.deepStrictEqual(resolveOmpSidecarPlatforms("mac", "x64"), ["darwin-x64"]);
    assert.deepStrictEqual(resolveOmpSidecarPlatforms("mac", "universal"), [
      "darwin-arm64",
      "darwin-x64",
    ]);
    assert.deepStrictEqual(resolveOmpSidecarPlatforms("linux", "x64"), ["linux-x64"]);
    assert.deepStrictEqual(resolveOmpSidecarPlatforms("linux", "arm64"), ["linux-arm64"]);
    assert.deepStrictEqual(resolveOmpSidecarPlatforms("win", "x64"), ["win32-x64"]);
    assert.strictEqual(ompSidecarExecutableName("win"), "omp.exe");
    assert.strictEqual(ompSidecarExecutableName("mac"), "omp");
  });

  it.effect("ships the staged sidecar as an extra resource, never inside app.asar", () =>
    Effect.gen(function* () {
      for (const platform of ["mac", "linux", "win"] as const) {
        const bundled = yield* createBuildConfig(
          platform,
          platform === "mac" ? "dmg" : platform === "linux" ? "AppImage" : "nsis",
          "1.2.3",
          false,
          false,
          undefined,
          undefined,
          false,
          "arm64",
          true,
        );
        const unbundled = yield* createBuildConfig(
          platform,
          platform === "mac" ? "dmg" : platform === "linux" ? "AppImage" : "nsis",
          "1.2.3",
          false,
          false,
          undefined,
          undefined,
          false,
          "arm64",
        );
        assert.includeDeepMembers(
          bundled.extraResources as Array<unknown>,
          [...OMP_SIDECAR_EXTRA_RESOURCES],
          platform,
        );
        assert.notDeepInclude(
          unbundled.extraResources as Array<unknown>,
          OMP_SIDECAR_EXTRA_RESOURCES[0],
          platform,
        );
      }
      assert.include(DESKTOP_FILE_EXCLUSIONS, "!apps/desktop/prod-resources/omp/**/*");
    }),
  );

  it.effect("keeps app signing from rewriting the verified sidecar", () =>
    Effect.gen(function* () {
      const mac = (yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        false,
        "arm64",
        true,
      )).mac as Record<string, unknown>;
      assert.deepStrictEqual(mac.signIgnore, [MAC_OMP_SIDECAR_SIGN_IGNORE]);
      assert.isUndefined(mac.x64ArchFiles);
      const pattern = new RegExp(MAC_OMP_SIDECAR_SIGN_IGNORE);
      assert.isTrue(pattern.test("/out/Ompanel.app/Contents/Resources/omp/darwin-arm64/omp"));
      assert.isFalse(
        pattern.test("/out/Ompanel.app/Contents/Resources/resource-monitor/t3-resource-monitor"),
      );

      const universal = (yield* createBuildConfig(
        "mac",
        "dmg",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        false,
        "universal",
        true,
      )).mac as Record<string, unknown>;
      assert.strictEqual(universal.x64ArchFiles, MAC_UNIVERSAL_OMP_SIDECAR_X64_ARCH_FILES);

      const win = (yield* createBuildConfig(
        "win",
        "nsis",
        "1.2.3",
        false,
        false,
        undefined,
        undefined,
        false,
        "x64",
        true,
      )).win as Record<string, unknown>;
      assert.include(win.signExts as Array<string>, WINDOWS_OMP_SIDECAR_SIGN_EXCLUSION);
    }),
  );

  it.effect("stages the verified sidecar for the host target from a local asset folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "omp-stage-" });
      const sourceDir = path.join(root, "assets");
      yield* fs.makeDirectory(sourceDir);
      yield* fs.writeFileString(path.join(sourceDir, "omp-darwin-arm64"), "arm64 sidecar");
      yield* fs.writeFileString(path.join(sourceDir, "omp-darwin-x64"), "x64 sidecar");
      const lock = lockFor({
        "darwin-arm64": { asset: "omp-darwin-arm64", sha256: sha256("arm64 sidecar") },
        "darwin-x64": { asset: "omp-darwin-x64", sha256: sha256("x64 sidecar") },
      });
      const stageProdResourcesDir = path.join(root, "prod-resources");

      const staged = yield* stageOmpSidecar({
        stageProdResourcesDir,
        downloadDir: path.join(root, "download"),
        platform: "mac",
        arch: "universal",
        lock,
        sourceDir: Option.some(sourceDir),
      });
      assert.isTrue(staged);
      const arm64 = path.join(stageProdResourcesDir, "omp", "darwin-arm64", "omp");
      assert.strictEqual(yield* fs.readFileString(arm64), "arm64 sidecar");
      assert.strictEqual(
        yield* fs.readFileString(path.join(stageProdResourcesDir, "omp", "darwin-x64", "omp")),
        "x64 sidecar",
      );
      assert.strictEqual(((yield* fs.stat(arm64)).mode & 0o777).toString(8), "755");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an asset whose sha256 differs from the lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "omp-stage-" });
      yield* fs.writeFileString(path.join(root, "omp-linux-x64"), "tampered");
      const error = yield* stageOmpSidecar({
        stageProdResourcesDir: path.join(root, "prod-resources"),
        downloadDir: path.join(root, "download"),
        platform: "linux",
        arch: "x64",
        lock: lockFor({ "linux-x64": { asset: "omp-linux-x64", sha256: sha256("pinned") } }),
        sourceDir: Option.some(root),
      }).pipe(Effect.flip);
      assert.instanceOf(error, OmpSidecarBundleError);
      assert.include(error.message, "linux-x64");
    }).pipe(Effect.scoped),
  );

  it.effect("ships no sidecar when the lock pins none for the target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "omp-stage-" });
      const stageProdResourcesDir = path.join(root, "prod-resources");
      const staged = yield* stageOmpSidecar({
        stageProdResourcesDir,
        downloadDir: path.join(root, "download"),
        platform: "win",
        arch: "x64",
        lock: lockFor({}),
        sourceDir: Option.none(),
      });
      assert.isFalse(staged);
      assert.isFalse(yield* fs.exists(path.join(stageProdResourcesDir, "omp")));
    }).pipe(Effect.scoped),
  );
});
