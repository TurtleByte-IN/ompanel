import * as NodeSqlite from "node:sqlite";
import { HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, UPSTREAM_PRODUCT_NAME } from "@t3tools/shared/brand";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { isProcessAlive, readPersistedServerRuntimeState } from "./serverRuntimeState.ts";

/** Written once the migration has decided; its presence makes every later run a no-op. */
export const LEGACY_HOME_MIGRATION_MARKER = "legacy-home-migration.json";
/** Held by the migrating server; never unlinked, so a crashed holder releases it with its process. */
export const LEGACY_HOME_MIGRATION_LOCK = "legacy-home-migration.lock";
const STAGING_DIRECTORY = ".legacy-home-migration";
/**
 * Written into staging once the copy is whole, listing the staged databases; from then on a
 * restart finishes moving it in.
 */
const STAGING_COMPLETE = ".complete";
const REPLACED_DIRECTORY = ".legacy-home-migration-replaced";
/**
 * Top-level entries that stay behind: logs; one install's identity and keys (`secrets/` holds the
 * signing keys, T3 Connect link and provider sign-ins; `device/hosts` holds device daemon auth
 * tokens); and live-process state. Databases are copied separately through SQLite.
 */
const SKIPPED_ENTRIES: Record<string, true> = {
  logs: true,
  secrets: true,
  device: true,
  "server-runtime.json": true,
  "server-owner.sqlite": true,
  "environment-id": true,
  "anonymous-id": true,
};
/**
 * Written with defaults by every server start. After a deferred start Ompanel's defaults would
 * otherwise shadow upstream's customised copies, so they are set aside with the empty database.
 */
const STARTUP_DEFAULT_FILES = ["keybindings.json", "keybindings-migrations"] as const;
const DATABASES = ["state.sqlite", "statev2.sqlite"] as const;
const DATABASE_FILE = /\.sqlite(?:-wal|-shm|-journal)?$/u;
/** Credentials issued by upstream: sessions are paired devices and clients, links are unredeemed pairings. */
const UPSTREAM_CREDENTIAL_TABLES = ["auth_sessions", "auth_pairing_links"] as const;
/** Any row here means someone used this database; an Ompanel start alone writes none. */
const USER_DATA_TABLES = [
  "orchestration_v2_events",
  "orchestration_events",
  "projection_projects",
  "projection_threads",
] as const;
const LOCK_POLL_INTERVAL = Duration.millis(100);
const DEFAULT_LOCK_WAIT_MS = 60_000;

const MigrationMarker = Schema.Struct({
  status: Schema.Literals(["migrated", "target-has-state"]),
  from: Schema.String,
  at: Schema.String,
});
const encodeMigrationMarker = Schema.encodeEffect(Schema.fromJsonString(MigrationMarker));
const StagedDatabases = Schema.fromJsonString(Schema.Array(Schema.String));
const encodeStagedDatabases = Schema.encodeEffect(StagedDatabases);
const decodeStagedDatabases = Schema.decodeEffect(StagedDatabases);

export type LegacyHomeMigrationResult =
  | { readonly status: "migrated"; readonly from: string; readonly to: string }
  | { readonly status: "already-migrated" }
  | { readonly status: "no-legacy-home" }
  | { readonly status: "legacy-home-symlinked"; readonly path: string }
  | { readonly status: "target-has-state" }
  | { readonly status: "legacy-server-running"; readonly pid: number | null }
  | { readonly status: "target-server-running" }
  | { readonly status: "migration-locked" };

export class LegacyHomeMigrationError extends Schema.TaggedError<LegacyHomeMigrationError>()(
  "LegacyHomeMigrationError",
  {
    from: Schema.String,
    to: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not copy upstream data from ${this.from} to ${this.to}; starting with empty state and retrying on the next start.`;
  }
}

const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) ||
    ("code" in cause && cause.code === "SQLITE_BUSY"));

/**
 * True while a server holds its `server-owner.sqlite` lock: that lock is an exclusive
 * transaction, so even a read-only read is refused. Read-only, so the probed home is not written.
 */
function serverOwnsStateDirectory(ownerLockPath: string): boolean {
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(ownerLockPath, { readOnly: true, timeout: 0 });
    db.prepare("SELECT COUNT(*) FROM sqlite_schema").get();
    return false;
  } catch (cause) {
    if (isSqliteBusy(cause)) return true;
    throw cause;
  } finally {
    db?.close();
  }
}

function existingTables(db: NodeSqlite.DatabaseSync, names: ReadonlyArray<string>): string[] {
  const present = new Set(
    db
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );
  return names.filter((name) => present.has(name));
}

/** A database the server created on a start that found nothing to copy holds no user rows. */
function databaseHasUserData(databasePath: string): boolean {
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    const database = db;
    return existingTables(database, USER_DATA_TABLES).some(
      (table) => database.prepare(`SELECT 1 FROM "${table}" LIMIT 1`).get() !== undefined,
    );
  } catch {
    // Unreadable is not proof of empty; never replace it.
    return true;
  } finally {
    db?.close();
  }
}

/** A consistent snapshot even if upstream writes meanwhile, without its upstream credentials. */
async function snapshotDatabase(sourcePath: string, destinationPath: string): Promise<void> {
  const source = new NodeSqlite.DatabaseSync(sourcePath, { readOnly: true });
  try {
    await NodeSqlite.backup(source, destinationPath);
  } finally {
    source.close();
  }
  const copy = new NodeSqlite.DatabaseSync(destinationPath);
  try {
    for (const table of existingTables(copy, UPSTREAM_CREDENTIAL_TABLES)) {
      copy.exec(`DELETE FROM "${table}"`);
    }
    // Webhook URLs and signing secrets issued by upstream; a task's owner rotates a new one.
    const webhookColumns =
      existingTables(copy, ["scheduled_tasks"]).length > 0
        ? copy
            .prepare("SELECT name FROM pragma_table_info('scheduled_tasks')")
            .all()
            .map((row) => String(row.name))
            .filter((name) => name === "webhook_token" || name === "webhook_secret")
        : [];
    // Queued webhook deliveries snapshot the task and request, whose path and URL carry the token.
    if (existingTables(copy, ["scheduled_task_webhook_pending"]).length > 0) {
      for (const column of webhookColumns) {
        copy.exec(
          `UPDATE scheduled_task_webhook_pending AS pending SET
            task_json = replace(pending.task_json, tasks.${column}, '[redacted]'),
            request_json = replace(pending.request_json, tasks.${column}, '[redacted]')
          FROM scheduled_tasks AS tasks
          WHERE tasks.task_id = pending.task_id AND tasks.${column} <> ''`,
        );
      }
    }
    if (webhookColumns.length > 0) {
      copy.exec(
        `UPDATE scheduled_tasks SET ${webhookColumns.map((name) => `${name} = NULL`).join(", ")}`,
      );
    }
    // One self-contained file, so publishing it is a single rename; VACUUM rewrites it so the
    // deleted credentials do not survive in free pages.
    copy.exec("PRAGMA journal_mode = DELETE");
    copy.exec("VACUUM");
  } finally {
    copy.close();
  }
}

/**
 * Copies an upstream T3 Code `~/.t3/userdata` into `~/.ompanel/userdata` once, reading upstream
 * only. Deferrals and failures write no marker, so a later start retries; what is and is not
 * copied, and crash recovery, are in docs/omp/branding.md.
 */
export const migrateLegacyHome = Effect.fn("legacyHomeMigration.migrate")(function* (
  homeDirectory: string,
  options?: {
    readonly lockWaitMs?: number;
    /** Runs each time the lock is found held, before waiting for the next poll. */
    readonly onLockBusy?: Effect.Effect<void>;
  },
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = path.join(homeDirectory, HOME_DIR_NAME);
  const userdata = path.join(baseDir, "userdata");
  const legacyUserdata = path.join(homeDirectory, LEGACY_HOME_DIR_NAME, "userdata");
  const marker = path.join(baseDir, LEGACY_HOME_MIGRATION_MARKER);
  const staging = path.join(baseDir, STAGING_DIRECTORY);
  const fail = (cause: unknown) =>
    new LegacyHomeMigrationError({ from: legacyUserdata, to: userdata, cause });
  const attempt = <A>(evaluate: () => A) => Effect.try({ try: evaluate, catch: fail });
  const serverOwns = Effect.fn("legacyHomeMigration.serverOwns")(function* (stateDir: string) {
    const ownerLock = path.join(stateDir, "server-owner.sqlite");
    if (!(yield* fs.exists(ownerLock))) return false;
    return yield* attempt(() => serverOwnsStateDirectory(ownerLock));
  });

  const writeMarker = Effect.fn("legacyHomeMigration.writeMarker")(function* (
    status: "migrated" | "target-has-state",
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    const contents = yield* encodeMigrationMarker({ status, from: legacyUserdata, at });
    yield* fs.writeFileString(marker, `${contents}\n`);
    yield* fs.remove(staging, { recursive: true, force: true });
  });

  const copyTree: (
    from: string,
    to: string,
    topLevel: boolean,
  ) => Effect.Effect<void, PlatformError.PlatformError> = Effect.fn("legacyHomeMigration.copyTree")(
    function* (from, to, topLevel) {
      yield* fs.makeDirectory(to, { recursive: true });
      for (const name of yield* fs.readDirectory(from)) {
        if (topLevel && (Object.hasOwn(SKIPPED_ENTRIES, name) || DATABASE_FILE.test(name)))
          continue;
        const source = path.join(from, name);
        // Only a symlink has a link target: skip it rather than follow it out of the tree.
        if (Option.isSome(yield* fs.readLink(source).pipe(Effect.option))) continue;
        const info = yield* fs.stat(source);
        // Sockets and pipes belong to a running T3 Code; they cannot be copied.
        if (info.type === "Directory") yield* copyTree(source, path.join(to, name), false);
        else if (info.type === "File") yield* fs.copyFile(source, path.join(to, name));
      }
    },
  );

  // Anything Ompanel already wrote wins; directories it merely created are filled in.
  const moveInto: (from: string, to: string) => Effect.Effect<void, PlatformError.PlatformError> =
    Effect.fn("legacyHomeMigration.moveInto")(function* (from, to) {
      if (!(yield* fs.exists(to))) return yield* fs.rename(from, to);
      const [source, destination] = yield* Effect.all([fs.stat(from), fs.stat(to)]);
      if (source.type !== "Directory" || destination.type !== "Directory") return;
      for (const name of yield* fs.readDirectory(from)) {
        yield* moveInto(path.join(from, name), path.join(to, name));
      }
    });

  const stage = Effect.fn("legacyHomeMigration.stage")(function* () {
    yield* fs.remove(staging, { recursive: true, force: true });
    yield* copyTree(legacyUserdata, staging, true);
    const staged: string[] = [];
    for (const name of DATABASES) {
      const source = path.join(legacyUserdata, name);
      if (!(yield* fs.exists(source))) continue;
      yield* Effect.tryPromise({
        try: () => snapshotDatabase(source, path.join(staging, name)),
        catch: fail,
      });
      staged.push(name);
    }
    yield* fs.writeFileString(
      path.join(staging, STAGING_COMPLETE),
      yield* encodeStagedDatabases(staged),
    );
  });

  /** Returns false, moving nothing, when Ompanel has since gained real data of its own. */
  const publish = Effect.fn("legacyHomeMigration.publish")(function* () {
    const staged = yield* decodeStagedDatabases(
      yield* fs.readFileString(path.join(staging, STAGING_COMPLETE)),
    );
    const pending: string[] = [];
    for (const name of staged) {
      if (yield* fs.exists(path.join(staging, name))) pending.push(name);
    }
    // Databases already moved in by an interrupted run are upstream's; every other one must be
    // empty, and is set aside so a staged v1 database is not hidden behind an empty v2 one.
    const replaceable = DATABASES.filter(
      (name) => pending.includes(name) || !staged.includes(name),
    );
    for (const name of replaceable) {
      const existing = path.join(userdata, name);
      if ((yield* fs.exists(existing)) && databaseHasUserData(existing)) return false;
    }
    yield* fs.makeDirectory(userdata, { recursive: true });
    if (pending.length > 0) {
      const replaced = path.join(
        baseDir,
        `${REPLACED_DIRECTORY}-${DateTime.formatIso(yield* DateTime.now).replaceAll(":", "-")}`,
      );
      const setAside = Effect.fn("legacyHomeMigration.setAside")(function* (file: string) {
        const existing = path.join(userdata, file);
        if (!(yield* fs.exists(existing))) return;
        yield* fs.makeDirectory(replaced, { recursive: true });
        yield* fs.rename(existing, path.join(replaced, file));
      });
      for (const name of replaceable) {
        for (const file of [name, `${name}-wal`, `${name}-shm`, `${name}-journal`]) {
          yield* setAside(file);
        }
      }
      // Still staged means not yet moved in, so the target's copy is the start's defaults.
      if (yield* fs.exists(path.join(staging, STARTUP_DEFAULT_FILES[0]))) {
        for (const file of STARTUP_DEFAULT_FILES) yield* setAside(file);
      }
    }
    for (const name of yield* fs.readDirectory(staging)) {
      if (name === STAGING_COMPLETE || DATABASE_FILE.test(name)) continue;
      yield* moveInto(path.join(staging, name), path.join(userdata, name));
    }
    // statev2.sqlite last: once it is in place, only the marker remains to write.
    for (const name of pending) {
      yield* fs.rename(path.join(staging, name), path.join(userdata, name));
    }
    return true;
  });

  const migrateLocked = Effect.gen(function* () {
    if (yield* fs.exists(marker)) return { status: "already-migrated" } as const;
    if (yield* serverOwns(userdata)) return { status: "target-server-running" } as const;
    const migrated = { status: "migrated", from: legacyUserdata, to: userdata } as const;

    // A crash after the copy was whole: finish moving it in rather than copying again.
    if (yield* fs.exists(path.join(staging, STAGING_COMPLETE))) {
      if (!(yield* publish())) {
        yield* writeMarker("target-has-state");
        return { status: "target-has-state" } as const;
      }
      yield* writeMarker("migrated");
      return migrated;
    }

    for (const name of DATABASES) {
      const existing = path.join(userdata, name);
      if ((yield* fs.exists(existing)) && databaseHasUserData(existing)) {
        yield* writeMarker("target-has-state");
        return { status: "target-has-state" } as const;
      }
    }

    const legacyRuntime = yield* readPersistedServerRuntimeState(
      path.join(legacyUserdata, "server-runtime.json"),
    );
    const legacyPid =
      Option.isSome(legacyRuntime) && isProcessAlive(legacyRuntime.value.pid)
        ? legacyRuntime.value.pid
        : null;
    if (legacyPid !== null || (yield* serverOwns(legacyUserdata))) {
      return { status: "legacy-server-running", pid: legacyPid } as const;
    }

    yield* stage();
    if (!(yield* publish())) {
      yield* writeMarker("target-has-state");
      return { status: "target-has-state" } as const;
    }
    yield* writeMarker("migrated");
    return migrated;
  });

  // Two Ompanel servers starting together (desktop backend and the OS service) take turns.
  const lockPath = path.join(baseDir, LEGACY_HOME_MIGRATION_LOCK);
  const tryLock = attempt(() => {
    const db = new NodeSqlite.DatabaseSync(lockPath, { timeout: 0 });
    try {
      db.exec("BEGIN EXCLUSIVE");
      return Option.some(db);
    } catch (cause) {
      db.close();
      if (isSqliteBusy(cause)) return Option.none<NodeSqlite.DatabaseSync>();
      throw cause;
    }
  });
  const acquireLock = Effect.gen(function* () {
    const deadline =
      (yield* Clock.currentTimeMillis) + (options?.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS);
    while (true) {
      const lock = yield* tryLock;
      if (Option.isSome(lock) || (yield* Clock.currentTimeMillis) >= deadline) return lock;
      if (options?.onLockBusy) yield* options.onLockBusy;
      yield* Effect.sleep(LOCK_POLL_INTERVAL);
    }
  });

  return yield* Effect.gen(function* () {
    if (yield* fs.exists(marker)) return { status: "already-migrated" } as const;
    if (!(yield* fs.exists(legacyUserdata))) return { status: "no-legacy-home" } as const;
    // A relocated upstream home or database is not followed: the copy reads only what it can see.
    const isSymlink = (file: string) =>
      fs.readLink(file).pipe(Effect.option, Effect.map(Option.isSome));
    const legacyDatabases = (yield* fs.readDirectory(legacyUserdata)).filter((name) =>
      DATABASE_FILE.test(name),
    );
    for (const file of [
      path.join(homeDirectory, LEGACY_HOME_DIR_NAME),
      legacyUserdata,
      ...legacyDatabases.map((name) => path.join(legacyUserdata, name)),
    ]) {
      if (yield* isSymlink(file)) return { status: "legacy-home-symlinked", path: file } as const;
    }
    yield* fs.makeDirectory(baseDir, { recursive: true });
    return yield* Effect.acquireUseRelease(
      acquireLock,
      (lock) =>
        Option.isNone(lock)
          ? Effect.succeed<LegacyHomeMigrationResult>({ status: "migration-locked" })
          : migrateLocked,
      (lock) => Effect.sync(() => Option.map(lock, (db) => db.close())),
    );
  }).pipe(
    Effect.mapError((cause) => (cause._tag === "LegacyHomeMigrationError" ? cause : fail(cause))),
  );
});

/**
 * Migrates only for the default production home, and never blocks server startup. Returns true
 * when the copy is still to come (deferred or failed), so this start must not create user data
 * that would make the next start skip it.
 */
export const migrateLegacyHomeOnStartup = Effect.fn("legacyHomeMigration.onStartup")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  if (stateDir !== path.join(homeDirectory, HOME_DIR_NAME, "userdata")) return false;
  const result = yield* migrateLegacyHome(homeDirectory).pipe(
    Effect.catchTags({
      LegacyHomeMigrationError: (error) =>
        Effect.logWarning(error.message, { cause: error.cause }).pipe(Effect.as(undefined)),
    }),
  );
  switch (result?.status) {
    case undefined:
      return true;
    case "migrated":
      yield* Effect.logInfo(
        `Copied ${UPSTREAM_PRODUCT_NAME} data from ${result.from} to ${result.to}.`,
      );
      return false;
    case "legacy-home-symlinked":
      yield* Effect.logWarning(
        `${result.path} is a symlink; ${UPSTREAM_PRODUCT_NAME} data is not copied from a relocated home.`,
      );
      return false;
    case "legacy-server-running":
      yield* Effect.logWarning(
        `${UPSTREAM_PRODUCT_NAME} is running${result.pid === null ? "" : ` (pid ${result.pid})`}; its data will be copied on the next start after it quits.`,
      );
      return true;
    case "target-server-running":
    case "migration-locked":
      yield* Effect.logWarning(
        `Another Ompanel server is using ${path.join(homeDirectory, HOME_DIR_NAME)}; ${UPSTREAM_PRODUCT_NAME} data will be copied on a later start.`,
      );
      return true;
    default:
      return false;
  }
});
