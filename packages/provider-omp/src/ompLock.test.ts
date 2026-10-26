import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  RPC_CONTRACT_SCHEMA_HASH,
  RPC_CONTRACT_VERSION,
} from "../contract/src/contract.generated.ts";
import { ContractManifest, OmpLockFile } from "../scripts/contractMatch.ts";
import { OMP_LOCK } from "./ompLock.ts";

const readPackageJson = <S extends Schema.Top & { readonly DecodingServices: never }>(
  relativePath: string,
  schema: S,
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const packageDir = path.dirname(
      path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))),
    );
    const text = yield* fileSystem.readFileString(path.join(packageDir, relativePath));
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text);
  }).pipe(Effect.provide(NodeServices.layer));

describe("omp.lock", () => {
  it.effect("matches the OMP_LOCK mirror the server bundles", () =>
    Effect.gen(function* () {
      const lock = yield* readPackageJson("omp.lock", OmpLockFile);
      assert.deepStrictEqual(lock, OMP_LOCK);
    }),
  );

  it.effect("pins the contract version and schema hash of the vendored contract", () =>
    Effect.gen(function* () {
      const manifest = yield* readPackageJson("contract/contract.json", ContractManifest);
      assert.strictEqual(manifest.contractVersion, OMP_LOCK.contract.version);
      assert.strictEqual(manifest.schemaHash, OMP_LOCK.contract.schemaHash);
      assert.strictEqual(RPC_CONTRACT_VERSION, OMP_LOCK.contract.version);
      assert.strictEqual(RPC_CONTRACT_SCHEMA_HASH, OMP_LOCK.contract.schemaHash);
    }),
  );

  it("records a lowercase sha256 for every pinned sidecar", () => {
    for (const [platform, sidecar] of Object.entries(OMP_LOCK.sidecars)) {
      assert.match(sidecar.sha256, /^[0-9a-f]{64}$/, platform);
      assert.isTrue(sidecar.asset.startsWith("omp-"), platform);
    }
  });
});
