// @effect-diagnostics nodeBuiltinImport:off - fixtures need a sha256 of known bytes and synchronous checks inside a web stream.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { OMP_LOCK, type OmpLock } from "../ompLock.ts";
import { OmpHostUserId } from "./sidecar.ts";
import {
  installOmpSidecar,
  makeOmpSidecarProvisioner,
  ompSidecarDownloadUrl,
} from "./sidecarInstall.ts";

const PINNED_BYTES = "pinned omp sidecar bytes";
const sha256 = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const ASSET = "omp-darwin-arm64";

const LOCK: OmpLock = {
  ...OMP_LOCK,
  sidecars: { "darwin-arm64": { asset: ASSET, sha256: sha256(PINNED_BYTES) } },
};

interface Served {
  readonly requests: Array<string>;
  readonly client: HttpClient.HttpClient;
}

/** Serves `chunks` with `status`; `beforeChunk` runs before each chunk is handed out. */
const serve = (
  chunks: ReadonlyArray<string>,
  options: { readonly status?: number; readonly beforeChunk?: (index: number) => void } = {},
): Served => {
  const requests: Array<string> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      let index = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (index >= chunks.length) {
            controller.close();
            return;
          }
          options.beforeChunk?.(index);
          controller.enqueue(new TextEncoder().encode(chunks[index]));
          index += 1;
        },
      });
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, { status: options.status ?? 200 }),
      );
    }),
  );
  return { requests, client };
};

interface Fixture {
  readonly cacheDir: string;
  readonly tagDir: string;
  readonly target: string;
}

const withFixture = <A, E>(
  body: (fixture: Fixture) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "omp-install-" });
    const cacheDir = path.join(dir, "tools", "omp");
    const tagDir = path.join(cacheDir, LOCK.tag);
    return yield* body({ cacheDir, tagDir, target: path.join(tagDir, ASSET) });
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(HostProcess.Architecture, "arm64"),
    Effect.provide(NodeServices.layer),
  );

const install = (served: Served, cacheDir: string, lock: OmpLock = LOCK) =>
  installOmpSidecar({ cacheDir }, lock).pipe(
    Effect.provideService(HttpClient.HttpClient, served.client),
  );

const modeOf = (filePath: string) => NodeFS.statSync(filePath).mode & 0o777;
// Owner and mode checks apply where POSIX user ids exist.
const POSIX = process.getuid !== undefined;

describe("installOmpSidecar", () => {
  it.effect("downloads, verifies and atomically installs the pinned asset", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const halfway: Array<{ readonly targetExists: boolean; readonly entries: number }> = [];
        const served = serve(["pinned omp ", "sidecar bytes"], {
          beforeChunk: (index) => {
            if (index === 1) {
              halfway.push({
                targetExists: NodeFS.existsSync(fixture.target),
                entries: NodeFS.readdirSync(fixture.tagDir).length,
              });
            }
          },
        });
        const installed = yield* install(served, fixture.cacheDir);

        assert.strictEqual(installed, fixture.target);
        assert.deepStrictEqual(served.requests, [
          `https://github.com/TurtleByte-IN/oh-my-pi/releases/download/${LOCK.tag}/${ASSET}`,
        ]);
        assert.strictEqual(served.requests[0], ompSidecarDownloadUrl(LOCK, ASSET));
        // Mid-download only the temp file exists; the target appears whole, by rename.
        assert.deepStrictEqual(halfway, [{ targetExists: false, entries: 1 }]);
        assert.strictEqual(yield* fileSystem.readFileString(fixture.target), PINNED_BYTES);
        assert.deepStrictEqual(yield* fileSystem.readDirectory(fixture.tagDir), [ASSET]);
        if (POSIX) {
          assert.strictEqual(modeOf(fixture.cacheDir), 0o700);
          assert.strictEqual(modeOf(fixture.tagDir), 0o700);
          assert.strictEqual(modeOf(fixture.target), 0o700);
        }
      }),
    ),
  );

  it.effect("deletes the temp file and refuses when the sha256 does not match", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const error = yield* install(serve(["tampered bytes"]), fixture.cacheDir).pipe(Effect.flip);
        assert.strictEqual(error.reason, "sha256_mismatch");
        assert.deepStrictEqual(yield* fileSystem.readDirectory(fixture.tagDir), []);
      }),
    ),
  );

  it.effect("deletes the temp file when the download fails", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const error = yield* install(serve(["Not Found"], { status: 404 }), fixture.cacheDir).pipe(
          Effect.flip,
        );
        assert.strictEqual(error.reason, "download_failed");
        assert.deepStrictEqual(yield* fileSystem.readDirectory(fixture.tagDir), []);
      }),
    ),
  );

  it.effect("refuses without downloading when the lock has no sha256 for the platform", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const served = serve([PINNED_BYTES]);
        const noHash = yield* install(served, fixture.cacheDir, {
          ...LOCK,
          sidecars: { "darwin-arm64": { asset: ASSET, sha256: "" } },
        }).pipe(Effect.flip);
        assert.strictEqual(noHash.reason, "missing_sha256");
        const noEntry = yield* install(served, fixture.cacheDir, { ...LOCK, sidecars: {} }).pipe(
          Effect.flip,
        );
        assert.strictEqual(noEntry.reason, "unsupported_platform");
        assert.deepStrictEqual(served.requests, []);
        assert.isFalse(NodeFS.existsSync(fixture.cacheDir));
      }),
    ),
  );

  it.effect.skipIf(!POSIX)(
    "refuses a cache folder other users can write to, before downloading",
    () =>
      withFixture((fixture) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.makeDirectory(fixture.cacheDir, { recursive: true });
          yield* fileSystem.chmod(fixture.cacheDir, 0o777);
          const served = serve([PINNED_BYTES]);
          const error = yield* install(served, fixture.cacheDir).pipe(Effect.flip);
          assert.strictEqual(error.reason, "insecure_permissions");
          assert.deepStrictEqual(served.requests, []);
        }),
      ),
  );

  it.effect.skipIf(!POSIX)("refuses a cache folder owned by another user, before downloading", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const served = serve([PINNED_BYTES]);
        const error = yield* install(served, fixture.cacheDir).pipe(
          Effect.provideService(OmpHostUserId, (process.getuid?.() ?? 0) + 1),
          Effect.flip,
        );
        assert.strictEqual(error.reason, "insecure_permissions");
        assert.include(error.message, "not owned by the current user");
        assert.deepStrictEqual(served.requests, []);
      }),
    ),
  );
});

describe("makeOmpSidecarProvisioner", () => {
  it.effect("downloads on first use, then resolves from the verified cache", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const served = serve([PINNED_BYTES]);
        const provisioner = yield* makeOmpSidecarProvisioner(LOCK);
        const input = { overridePath: "", bundledPath: undefined, cacheDir: fixture.cacheDir };
        const resolve = provisioner
          .resolve(input)
          .pipe(Effect.provideService(HttpClient.HttpClient, served.client));
        const first = yield* resolve;
        const second = yield* resolve;
        assert.deepInclude(first, { path: fixture.target, source: "cache", verified: true });
        assert.strictEqual(second.identity, first.identity);
        assert.strictEqual(served.requests.length, 1);
      }),
    ),
  );

  it.effect("does not download over a bundled sidecar that fails verification", () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const bundled = path.join(path.dirname(fixture.cacheDir), "bundled-omp");
        yield* fileSystem.makeDirectory(path.dirname(bundled), { recursive: true });
        yield* fileSystem.writeFileString(bundled, "tampered");
        yield* fileSystem.chmod(bundled, 0o755);
        const served = serve([PINNED_BYTES]);
        const provisioner = yield* makeOmpSidecarProvisioner(LOCK);
        const error = yield* provisioner
          .resolve({ overridePath: "", bundledPath: bundled, cacheDir: fixture.cacheDir })
          .pipe(Effect.provideService(HttpClient.HttpClient, served.client), Effect.flip);
        assert.strictEqual(error.reason, "sha256_mismatch");
        assert.deepStrictEqual(served.requests, []);
      }),
    ),
  );
});
