import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  LEGACY_HOME_MIGRATION_MARKER,
  migrateLegacyHome,
  migrateLegacyHomeOnStartup,
} from "./legacyHomeMigration.ts";

const seedLegacyHome = Effect.fn("test.seedLegacyHome")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "ompanel-legacy-home-" });
  const legacy = path.join(home, ".t3", "userdata");
  const write = (relative: string, contents: string) =>
    fs
      .makeDirectory(path.dirname(path.join(legacy, relative)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(legacy, relative), contents)));
  yield* write("statev2.sqlite", "db");
  yield* write("statev2.sqlite-wal", "wal");
  yield* write("settings.json", '{"theme":"dark"}');
  yield* write("secrets/provider.bin", "secret");
  yield* write("attachments/thread/image.png", "png");
  yield* write("logs/server.trace.ndjson", "trace");
  yield* write("environment-id", "upstream-environment");
  yield* write("anonymous-id", "upstream-anonymous");
  yield* write(
    "server-runtime.json",
    JSON.stringify({ version: 1, pid: 0, port: 1, origin: "x", startedAt: "x" }),
  );
  return { home, legacy, target: path.join(home, ".ompanel", "userdata") };
});

const read = (file: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).readFileString(file);
  });
const exists = (file: string) =>
  Effect.gen(function* () {
    return yield* (yield* FileSystem.FileSystem).exists(file);
  });

describe("migrateLegacyHome", () => {
  it.effect("copies upstream userdata once and leaves the upstream home untouched", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { home, legacy, target } = yield* seedLegacyHome();

      const result = yield* migrateLegacyHome(home);

      assert.deepStrictEqual(result, { status: "migrated", from: legacy, to: target });
      assert.equal(yield* read(path.join(target, "statev2.sqlite")), "db");
      assert.equal(yield* read(path.join(target, "statev2.sqlite-wal")), "wal");
      assert.equal(yield* read(path.join(target, "settings.json")), '{"theme":"dark"}');
      assert.equal(yield* read(path.join(target, "secrets", "provider.bin")), "secret");
      assert.equal(yield* read(path.join(target, "attachments", "thread", "image.png")), "png");
      for (const skipped of ["logs", "environment-id", "anonymous-id", "server-runtime.json"]) {
        assert.isFalse(yield* exists(path.join(target, skipped)), skipped);
      }
      assert.isFalse(yield* exists(path.join(home, ".ompanel", ".legacy-home-migration")));
      assert.isTrue(yield* exists(path.join(home, ".ompanel", LEGACY_HOME_MIGRATION_MARKER)));
      assert.equal(yield* read(path.join(legacy, "statev2.sqlite")), "db");
      assert.isTrue(yield* exists(path.join(legacy, "logs", "server.trace.ndjson")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("is a no-op on every later run", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, legacy, target } = yield* seedLegacyHome();
      yield* migrateLegacyHome(home);
      yield* fs.writeFileString(path.join(legacy, "settings.json"), '{"theme":"light"}');
      yield* fs.remove(path.join(target, "statev2.sqlite"));

      assert.deepStrictEqual(yield* migrateLegacyHome(home), { status: "already-migrated" });
      assert.equal(yield* read(path.join(target, "settings.json")), '{"theme":"dark"}');
      assert.isFalse(yield* exists(path.join(target, "statev2.sqlite")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never replaces an existing Ompanel database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, target } = yield* seedLegacyHome();
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.writeFileString(path.join(target, "statev2.sqlite"), "ours");

      assert.deepStrictEqual(yield* migrateLegacyHome(home), { status: "target-has-state" });
      assert.equal(yield* read(path.join(target, "statev2.sqlite")), "ours");
      assert.isFalse(yield* exists(path.join(target, "settings.json")));
      assert.deepStrictEqual(yield* migrateLegacyHome(home), { status: "already-migrated" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps files Ompanel already wrote and replaces a stale staging copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, target } = yield* seedLegacyHome();
      const staging = path.join(home, ".ompanel", ".legacy-home-migration");
      yield* fs.makeDirectory(staging, { recursive: true });
      yield* fs.writeFileString(path.join(staging, "stale.json"), "interrupted");
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.writeFileString(path.join(target, "settings.json"), '{"theme":"ours"}');

      assert.equal((yield* migrateLegacyHome(home)).status, "migrated");
      assert.equal(yield* read(path.join(target, "settings.json")), '{"theme":"ours"}');
      assert.equal(yield* read(path.join(target, "statev2.sqlite")), "db");
      assert.isFalse(yield* exists(path.join(target, "stale.json")));
      assert.isFalse(yield* exists(staging));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("waits while an upstream server is running", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, legacy, target } = yield* seedLegacyHome();
      yield* fs.writeFileString(
        path.join(legacy, "server-runtime.json"),
        JSON.stringify({ version: 1, pid: process.pid, port: 1, origin: "x", startedAt: "x" }),
      );

      assert.deepStrictEqual(yield* migrateLegacyHome(home), {
        status: "legacy-server-running",
        pid: process.pid,
      });
      assert.isFalse(yield* exists(target));
      assert.isFalse(yield* exists(path.join(home, ".ompanel", LEGACY_HOME_MIGRATION_MARKER)));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("does nothing without an upstream home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "ompanel-no-legacy-home-" });

      assert.deepStrictEqual(yield* migrateLegacyHome(home), { status: "no-legacy-home" });
      assert.isFalse(yield* exists(path.join(home, ".ompanel")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("migrateLegacyHomeOnStartup", () => {
  it.effect("migrates only for the default production state directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { home, target } = yield* seedLegacyHome();
      const withHome = Effect.provideService(HostProcess.HomeDirectory, home);

      yield* migrateLegacyHomeOnStartup(path.join(home, ".ompanel", "dev")).pipe(withHome);
      yield* migrateLegacyHomeOnStartup(path.join(home, "elsewhere", "userdata")).pipe(withHome);
      assert.isFalse(yield* exists(target));

      yield* migrateLegacyHomeOnStartup(target).pipe(withHome);
      assert.equal(yield* read(path.join(target, "statev2.sqlite")), "db");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
