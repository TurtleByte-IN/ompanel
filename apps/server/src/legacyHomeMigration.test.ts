import * as NodeSqlite from "node:sqlite";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  LEGACY_HOME_MIGRATION_LOCK,
  LEGACY_HOME_MIGRATION_MARKER,
  migrateLegacyHome,
  migrateLegacyHomeOnStartup,
} from "./legacyHomeMigration.ts";

const UPSTREAM_PAIRING_CREDENTIAL = "upstream-pairing-credential-7d1f";

/** A database shaped like the server's: events, plus the credentials upstream issued. */
function writeDatabase(file: string, input: { readonly events: ReadonlyArray<string> }) {
  const db = new NodeSqlite.DatabaseSync(file);
  try {
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE orchestration_v2_events (id TEXT PRIMARY KEY);
      CREATE TABLE auth_sessions (session_id TEXT PRIMARY KEY);
      CREATE TABLE auth_pairing_links (id TEXT PRIMARY KEY, credential TEXT);
      CREATE TABLE scheduled_tasks (task_id TEXT PRIMARY KEY, webhook_token TEXT, webhook_secret TEXT);
      CREATE TABLE scheduled_task_webhook_pending (delivery_id TEXT PRIMARY KEY, task_id TEXT, task_json TEXT, request_json TEXT);
    `);
    for (const id of input.events) {
      db.prepare("INSERT INTO orchestration_v2_events (id) VALUES (?)").run(id);
    }
    return db;
  } catch (cause) {
    db.close();
    throw cause;
  }
}

function seedDatabase(file: string, events: ReadonlyArray<string>) {
  const db = writeDatabase(file, { events });
  db.exec(`
    INSERT INTO auth_sessions (session_id) VALUES ('upstream-device');
    INSERT INTO auth_pairing_links (id, credential) VALUES ('upstream-link', '${UPSTREAM_PAIRING_CREDENTIAL}');
    INSERT INTO scheduled_tasks VALUES ('nightly', 'upstream-webhook-token', 'upstream-webhook-secret');
    INSERT INTO scheduled_task_webhook_pending VALUES ('delivery', 'nightly',
      '{"webhook":{"path":"/api/hooks/nightly/upstream-webhook-token","url":"https://relay/nightly/upstream-webhook-token"}}',
      '{"path":"/api/hooks/nightly/upstream-webhook-token","headers":{}}');
  `);
  db.close();
}

function readDatabase(file: string) {
  const db = new NodeSqlite.DatabaseSync(file, { readOnly: true });
  try {
    const ids = (table: string) =>
      db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => String(Object.values(row)[0]));
    return {
      events: ids("orchestration_v2_events"),
      sessions: ids("auth_sessions"),
      pairingLinks: ids("auth_pairing_links"),
      webhooks: db
        .prepare("SELECT webhook_token, webhook_secret FROM scheduled_tasks")
        .all()
        .map((row) => [row.webhook_token, row.webhook_secret]),
      pending: db
        .prepare("SELECT task_json, request_json FROM scheduled_task_webhook_pending")
        .all()
        .map((row) => ({
          task: JSON.parse(String(row.task_json)),
          request: JSON.parse(String(row.request_json)),
        })),
    };
  } finally {
    db.close();
  }
}

const seedLegacyHome = Effect.fn("test.seedLegacyHome")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "ompanel-legacy-home-" });
  const legacy = path.join(home, ".t3", "userdata");
  const write = (relative: string, contents: string) =>
    fs
      .makeDirectory(path.dirname(path.join(legacy, relative)), { recursive: true })
      .pipe(Effect.andThen(fs.writeFileString(path.join(legacy, relative), contents)));
  yield* fs.makeDirectory(legacy, { recursive: true });
  seedDatabase(path.join(legacy, "statev2.sqlite"), ["upstream-event"]);
  yield* write("settings.json", '{"theme":"dark"}');
  yield* write("secrets/server-signing-key", "signing");
  yield* write("secrets/cloud-link-ed25519-key-pair", "relay-key");
  yield* write("device/hosts/abc.json", '{"daemonAuthToken":"upstream-daemon"}');
  yield* write("keybindings.json", '[{"key":"mod+j","command":"terminal.toggle"}]');
  yield* write("attachments/thread/image.png", "png");
  yield* write("logs/server.trace.ndjson", "trace");
  yield* write("environment-id", "upstream-environment");
  yield* write("anonymous-id", "upstream-anonymous");
  yield* write("server-owner.sqlite", "");
  yield* write(
    "server-runtime.json",
    JSON.stringify({ version: 1, pid: 0, port: 1, origin: "x", startedAt: "x" }),
  );
  return { home, legacy, target: path.join(home, ".ompanel", "userdata") };
});

/** What an Ompanel start that copied nothing leaves: a migrated schema with no user rows. */
const createEmptyOmpanelDatabase = Effect.fn("test.createEmptyOmpanelDatabase")(function* (
  target: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(path.join(target, "attachments"), { recursive: true });
  const db = writeDatabase(path.join(target, "statev2.sqlite"), { events: [] });
  db.exec("INSERT INTO auth_sessions (session_id) VALUES ('ompanel-desktop')");
  db.close();
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
      assert.deepStrictEqual(readDatabase(path.join(target, "statev2.sqlite")).events, [
        "upstream-event",
      ]);
      assert.equal(yield* read(path.join(target, "settings.json")), '{"theme":"dark"}');
      assert.equal(yield* read(path.join(target, "attachments", "thread", "image.png")), "png");
      for (const skipped of [
        "logs",
        "secrets",
        "environment-id",
        "anonymous-id",
        "server-runtime.json",
        "server-owner.sqlite",
        "statev2.sqlite-wal",
      ]) {
        assert.isFalse(yield* exists(path.join(target, skipped)), skipped);
      }
      assert.isFalse(yield* exists(path.join(home, ".ompanel", ".legacy-home-migration")));
      assert.isTrue(yield* exists(path.join(home, ".ompanel", LEGACY_HOME_MIGRATION_MARKER)));
      assert.deepStrictEqual(readDatabase(path.join(legacy, "statev2.sqlite")).sessions, [
        "upstream-device",
      ]);
      assert.isTrue(yield* exists(path.join(legacy, "logs", "server.trace.ndjson")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves no upstream-issued key, session, device or pairing link valid", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { home, target } = yield* seedLegacyHome();

      yield* migrateLegacyHome(home);

      assert.isFalse(yield* exists(path.join(target, "secrets", "server-signing-key")));
      assert.isFalse(yield* exists(path.join(target, "secrets", "cloud-link-ed25519-key-pair")));
      assert.isFalse(yield* exists(path.join(target, "device")));
      const copied = readDatabase(path.join(target, "statev2.sqlite"));
      assert.deepStrictEqual(copied.sessions, []);
      assert.deepStrictEqual(copied.pairingLinks, []);
      assert.deepStrictEqual(copied.webhooks, [[null, null]]);
      // Deleted rows must not survive in free pages of the copied file.
      const bytes = yield* (yield* FileSystem.FileSystem).readFile(
        path.join(target, "statev2.sqlite"),
      );
      const text = Buffer.from(bytes).toString("latin1");
      assert.notInclude(text, UPSTREAM_PAIRING_CREDENTIAL);
      // Queued deliveries snapshot the webhook path, so the token must not survive there either.
      assert.notInclude(text, "upstream-webhook-token");
      assert.notInclude(text, "upstream-webhook-secret");
      assert.isFalse(yield* exists(path.join(target, "statev2.sqlite-wal")));
      const [queued] = copied.pending;
      assert.match(queued!.task.webhook.path, /\/\[redacted\]$/);
      assert.match(queued!.task.webhook.url, /\/\[redacted\]$/);
      assert.match(queued!.request.path, /\/\[redacted\]$/);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("copies rows that are still only in upstream's write-ahead log", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, legacy, target } = yield* seedLegacyHome();
      const writer = new NodeSqlite.DatabaseSync(path.join(legacy, "statev2.sqlite"));
      try {
        writer.exec("PRAGMA wal_autocheckpoint = 0");
        writer.prepare("INSERT INTO orchestration_v2_events (id) VALUES (?)").run("wal-only-event");
        assert.isTrue(yield* fs.exists(path.join(legacy, "statev2.sqlite-wal")));

        assert.equal((yield* migrateLegacyHome(home)).status, "migrated");
      } finally {
        writer.close();
      }
      assert.deepStrictEqual(readDatabase(path.join(target, "statev2.sqlite")).events, [
        "upstream-event",
        "wal-only-event",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["home", "userdata", "database"] as const)(
    "refuses a symlinked upstream %s instead of following it",
    (linked) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { home, legacy, target } = yield* seedLegacyHome();
        const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "ompanel-relocated-" });
        const link =
          linked === "home"
            ? path.join(home, ".t3")
            : linked === "userdata"
              ? legacy
              : path.join(legacy, "statev2.sqlite");
        const moved = path.join(elsewhere, path.basename(link));
        yield* fs.rename(link, moved);
        yield* fs.symlink(moved, link);

        assert.deepStrictEqual(yield* migrateLegacyHome(home), {
          status: "legacy-home-symlinked",
          path: link,
        });
        assert.isFalse(yield* exists(target));
        assert.isFalse(yield* exists(path.join(home, ".ompanel", LEGACY_HOME_MIGRATION_MARKER)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("copies a v1-only home and its rows reach the v2 import", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, legacy, target } = yield* seedLegacyHome();
      yield* fs.rename(path.join(legacy, "statev2.sqlite"), path.join(legacy, "state.sqlite"));
      yield* createEmptyOmpanelDatabase(target);

      assert.equal((yield* migrateLegacyHome(home)).status, "migrated");
      assert.deepStrictEqual(readDatabase(path.join(target, "state.sqlite")).events, [
        "upstream-event",
      ]);
      // An empty v2 database would make the server skip importing the v1 one.
      assert.isFalse(yield* exists(path.join(target, "statev2.sqlite")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("skips symlinks instead of following them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, legacy, target } = yield* seedLegacyHome();
      const outside = yield* fs.makeTempDirectoryScoped({ prefix: "ompanel-outside-" });
      yield* fs.writeFileString(path.join(outside, "private.txt"), "private");
      yield* fs.symlink(path.join(outside, "private.txt"), path.join(legacy, "linked.txt"));
      yield* fs.symlink(outside, path.join(legacy, "attachments", "linked-dir"));
      yield* fs.symlink(legacy, path.join(legacy, "attachments", "loop"));

      assert.equal((yield* migrateLegacyHome(home)).status, "migrated");
      assert.isFalse(yield* exists(path.join(target, "linked.txt")));
      assert.isFalse(yield* exists(path.join(target, "attachments", "linked-dir")));
      assert.isFalse(yield* exists(path.join(target, "attachments", "loop")));
      assert.equal(yield* read(path.join(target, "attachments", "thread", "image.png")), "png");
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

  it.effect("never replaces an Ompanel database that holds user data", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, target } = yield* seedLegacyHome();
      yield* fs.makeDirectory(target, { recursive: true });
      seedDatabase(path.join(target, "statev2.sqlite"), ["ompanel-event"]);

      assert.deepStrictEqual(yield* migrateLegacyHome(home), { status: "target-has-state" });
      assert.deepStrictEqual(readDatabase(path.join(target, "statev2.sqlite")).events, [
        "ompanel-event",
      ]);
      assert.isFalse(yield* exists(path.join(target, "settings.json")));
      assert.deepStrictEqual(yield* migrateLegacyHome(home), { status: "already-migrated" });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("treats an unreadable Ompanel database as existing state", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, target } = yield* seedLegacyHome();
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.writeFileString(path.join(target, "statev2.sqlite"), "not a database");

      assert.deepStrictEqual(yield* migrateLegacyHome(home), { status: "target-has-state" });
      assert.equal(yield* read(path.join(target, "statev2.sqlite")), "not a database");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps files Ompanel already wrote and fills directories it only created", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, target } = yield* seedLegacyHome();
      const staging = path.join(home, ".ompanel", ".legacy-home-migration");
      yield* fs.makeDirectory(staging, { recursive: true });
      yield* fs.writeFileString(path.join(staging, "stale.json"), "interrupted");
      yield* fs.makeDirectory(path.join(target, "attachments"), { recursive: true });
      yield* fs.writeFileString(path.join(target, "settings.json"), '{"theme":"ours"}');

      assert.equal((yield* migrateLegacyHome(home)).status, "migrated");
      assert.equal(yield* read(path.join(target, "settings.json")), '{"theme":"ours"}');
      assert.equal(yield* read(path.join(target, "attachments", "thread", "image.png")), "png");
      assert.deepStrictEqual(readDatabase(path.join(target, "statev2.sqlite")).events, [
        "upstream-event",
      ]);
      // A staging copy that never completed is discarded, not published.
      assert.isFalse(yield* exists(path.join(target, "stale.json")));
      assert.isFalse(yield* exists(staging));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("finishes a complete staging copy left by a crash during publish", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, target } = yield* seedLegacyHome();
      const staging = path.join(home, ".ompanel", ".legacy-home-migration");
      yield* fs.makeDirectory(target, { recursive: true });
      yield* fs.makeDirectory(staging, { recursive: true });
      // The crashed run had moved state.sqlite in; statev2.sqlite and a file were still staged.
      seedDatabase(path.join(target, "state.sqlite"), ["published-v1"]);
      seedDatabase(path.join(staging, "statev2.sqlite"), ["staged-v2"]);
      yield* fs.writeFileString(path.join(staging, "keybindings.json"), "[]");
      yield* fs.writeFileString(
        path.join(staging, ".complete"),
        JSON.stringify(["state.sqlite", "statev2.sqlite"]),
      );

      assert.equal((yield* migrateLegacyHome(home)).status, "migrated");
      assert.deepStrictEqual(readDatabase(path.join(target, "state.sqlite")).events, [
        "published-v1",
      ]);
      assert.deepStrictEqual(readDatabase(path.join(target, "statev2.sqlite")).events, [
        "staged-v2",
      ]);
      assert.equal(yield* read(path.join(target, "keybindings.json")), "[]");
      assert.isFalse(yield* exists(staging));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("waits while an upstream server is running, then copies on the next start", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, legacy, target } = yield* seedLegacyHome();
      const runtime = path.join(legacy, "server-runtime.json");
      yield* fs.writeFileString(
        runtime,
        JSON.stringify({ version: 1, pid: process.pid, port: 1, origin: "x", startedAt: "x" }),
      );

      assert.deepStrictEqual(yield* migrateLegacyHome(home), {
        status: "legacy-server-running",
        pid: process.pid,
      });
      assert.isFalse(yield* exists(target));
      assert.isFalse(yield* exists(path.join(home, ".ompanel", LEGACY_HOME_MIGRATION_MARKER)));

      // That start went on to create Ompanel's own empty database and default keybindings;
      // then T3 Code quit.
      yield* createEmptyOmpanelDatabase(target);
      yield* fs.writeFileString(path.join(target, "keybindings.json"), "[]");
      yield* fs.writeFileString(path.join(target, "keybindings-migrations"), "late-default\n");
      yield* fs.remove(runtime);

      assert.equal((yield* migrateLegacyHome(home)).status, "migrated");
      const copied = readDatabase(path.join(target, "statev2.sqlite"));
      assert.deepStrictEqual(copied.events, ["upstream-event"]);
      assert.deepStrictEqual(copied.sessions, []);
      assert.equal(yield* read(path.join(target, "attachments", "thread", "image.png")), "png");
      const replaced = (yield* fs.readDirectory(path.join(home, ".ompanel"))).filter((name) =>
        name.startsWith(".legacy-home-migration-replaced-"),
      );
      assert.equal(replaced.length, 1);
      const replacedDir = path.join(home, ".ompanel", replaced[0]!);
      assert.deepStrictEqual(readDatabase(path.join(replacedDir, "statev2.sqlite")).sessions, [
        "ompanel-desktop",
      ]);
      // Upstream's customised keybindings win over the defaults the deferred start wrote.
      assert.equal(
        yield* read(path.join(target, "keybindings.json")),
        '[{"key":"mod+j","command":"terminal.toggle"}]',
      );
      assert.isFalse(yield* exists(path.join(target, "keybindings-migrations")));
      assert.equal(yield* read(path.join(replacedDir, "keybindings.json")), "[]");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("detects a running upstream server by its ownership lock", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { home, legacy } = yield* seedLegacyHome();
      const owner = new NodeSqlite.DatabaseSync(path.join(legacy, "server-owner.sqlite"));
      owner.exec("BEGIN EXCLUSIVE");
      try {
        assert.deepStrictEqual(yield* migrateLegacyHome(home), {
          status: "legacy-server-running",
          pid: null,
        });
      } finally {
        owner.close();
      }
      assert.equal((yield* migrateLegacyHome(home)).status, "migrated");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("retries on the next start after a failed copy", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, legacy, target } = yield* seedLegacyHome();
      const database = path.join(legacy, "statev2.sqlite");
      yield* fs.rename(database, `${database}.good`);
      yield* fs.writeFileString(database, "corrupt");

      const failed = yield* migrateLegacyHome(home).pipe(Effect.flip);
      assert.equal(failed._tag, "LegacyHomeMigrationError");
      assert.isFalse(yield* exists(path.join(home, ".ompanel", LEGACY_HOME_MIGRATION_MARKER)));

      yield* createEmptyOmpanelDatabase(target);
      yield* fs.remove(database);
      yield* fs.rename(`${database}.good`, database);

      assert.equal((yield* migrateLegacyHome(home)).status, "migrated");
      assert.deepStrictEqual(readDatabase(path.join(target, "statev2.sqlite")).events, [
        "upstream-event",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("defers while an Ompanel server owns the target", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, target } = yield* seedLegacyHome();
      yield* fs.makeDirectory(target, { recursive: true });
      const owner = new NodeSqlite.DatabaseSync(path.join(target, "server-owner.sqlite"));
      owner.exec("BEGIN EXCLUSIVE");
      try {
        assert.deepStrictEqual(yield* migrateLegacyHome(home), {
          status: "target-server-running",
        });
      } finally {
        owner.close();
      }
      assert.isFalse(yield* exists(path.join(target, "statev2.sqlite")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("lets a concurrent Ompanel server wait for the migration lock", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { home, target } = yield* seedLegacyHome();
      yield* fs.makeDirectory(path.join(home, ".ompanel"), { recursive: true });
      const holder = new NodeSqlite.DatabaseSync(
        path.join(home, ".ompanel", LEGACY_HOME_MIGRATION_LOCK),
      );
      holder.exec("BEGIN EXCLUSIVE");
      const lockBusy = yield* Deferred.make<void>();

      const timingOut = yield* Effect.forkChild(
        migrateLegacyHome(home, {
          lockWaitMs: 200,
          onLockBusy: Deferred.succeed(lockBusy, undefined).pipe(Effect.asVoid),
        }),
      );
      yield* Deferred.await(lockBusy);
      yield* TestClock.adjust("300 millis");
      assert.deepStrictEqual(yield* Fiber.join(timingOut), { status: "migration-locked" });
      assert.isFalse(yield* exists(target));

      const nextBusy = yield* Deferred.make<void>();
      const waiting = yield* Effect.forkChild(
        migrateLegacyHome(home, {
          lockWaitMs: 10_000,
          onLockBusy: Deferred.succeed(nextBusy, undefined).pipe(Effect.asVoid),
        }),
      );
      yield* Deferred.await(nextBusy);
      holder.close();
      yield* TestClock.adjust("100 millis");
      assert.equal((yield* Fiber.join(waiting)).status, "migrated");
      assert.deepStrictEqual(yield* migrateLegacyHome(home), { status: "already-migrated" });
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
      assert.deepStrictEqual(readDatabase(path.join(target, "statev2.sqlite")).events, [
        "upstream-event",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
