import { HOME_DIR_NAME, LEGACY_HOME_DIR_NAME, UPSTREAM_PRODUCT_NAME } from "@t3tools/shared/brand";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { isProcessAlive, readPersistedServerRuntimeState } from "./serverRuntimeState.ts";

/** Written once the migration has decided; its presence makes every later run a no-op. */
export const LEGACY_HOME_MIGRATION_MARKER = "legacy-home-migration.json";
const STAGING_DIRECTORY = ".legacy-home-migration";
// Logs stay behind; the rest is one install's identity or live-process state, which must not be shared.
const SKIPPED_ENTRIES: Record<string, true> = {
  logs: true,
  "server-runtime.json": true,
  "environment-id": true,
  "anonymous-id": true,
};
const DATABASE_FILE = /\.sqlite(?:-wal|-shm|-journal)?$/u;

const MigrationMarker = Schema.Struct({
  status: Schema.Literals(["migrated", "target-has-state"]),
  from: Schema.String,
  at: Schema.String,
});
const encodeMigrationMarker = Schema.encodeEffect(Schema.fromJsonString(MigrationMarker));

export type LegacyHomeMigrationResult =
  | { readonly status: "migrated"; readonly from: string; readonly to: string }
  | { readonly status: "already-migrated" }
  | { readonly status: "no-legacy-home" }
  | { readonly status: "target-has-state" }
  | { readonly status: "legacy-server-running"; readonly pid: number };

export class LegacyHomeMigrationError extends Schema.TaggedError<LegacyHomeMigrationError>()(
  "LegacyHomeMigrationError",
  {
    from: Schema.String,
    to: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not copy upstream data from ${this.from} to ${this.to}; starting with empty state.`;
  }
}

/**
 * Copies an upstream T3 Code `~/.t3/userdata` into `~/.ompanel/userdata` once. The upstream home
 * is only read, so T3 Code keeps working and its worktrees stay where existing threads expect them.
 * Database files move into place last, so an interrupted run is redone rather than half-applied.
 */
export const migrateLegacyHome = Effect.fn("legacyHomeMigration.migrate")(function* (
  homeDirectory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = path.join(homeDirectory, HOME_DIR_NAME);
  const userdata = path.join(baseDir, "userdata");
  const legacyUserdata = path.join(homeDirectory, LEGACY_HOME_DIR_NAME, "userdata");
  const marker = path.join(baseDir, LEGACY_HOME_MIGRATION_MARKER);
  const staging = path.join(baseDir, STAGING_DIRECTORY);

  const writeMarker = Effect.fn("legacyHomeMigration.writeMarker")(function* (
    status: "migrated" | "target-has-state",
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    const contents = yield* encodeMigrationMarker({ status, from: legacyUserdata, at });
    yield* fs.makeDirectory(baseDir, { recursive: true });
    yield* fs.writeFileString(marker, `${contents}\n`);
  });

  const copyTree: (
    from: string,
    to: string,
    topLevel: boolean,
  ) => Effect.Effect<void, PlatformError.PlatformError> = Effect.fn("legacyHomeMigration.copyTree")(
    function* (from, to, topLevel) {
      yield* fs.makeDirectory(to, { recursive: true });
      for (const name of yield* fs.readDirectory(from)) {
        if (topLevel && Object.hasOwn(SKIPPED_ENTRIES, name)) continue;
        const source = path.join(from, name);
        const info = yield* fs.stat(source);
        // Sockets and pipes belong to a running T3 Code; they cannot be copied.
        if (info.type === "Directory") yield* copyTree(source, path.join(to, name), false);
        else if (info.type === "File") yield* fs.copyFile(source, path.join(to, name));
      }
    },
  );

  return yield* Effect.gen(function* () {
    if (yield* fs.exists(marker)) return { status: "already-migrated" } as const;
    if (!(yield* fs.exists(legacyUserdata))) return { status: "no-legacy-home" } as const;

    const hasState =
      (yield* fs.exists(path.join(userdata, "statev2.sqlite"))) ||
      (yield* fs.exists(path.join(userdata, "state.sqlite")));
    if (hasState) {
      yield* writeMarker("target-has-state");
      return { status: "target-has-state" } as const;
    }

    // A copy taken while T3 Code writes its database could be torn; retry on a later start.
    const legacyRuntime = yield* readPersistedServerRuntimeState(
      path.join(legacyUserdata, "server-runtime.json"),
    );
    if (Option.isSome(legacyRuntime) && isProcessAlive(legacyRuntime.value.pid)) {
      return { status: "legacy-server-running", pid: legacyRuntime.value.pid } as const;
    }

    yield* fs.remove(staging, { recursive: true, force: true });
    yield* copyTree(legacyUserdata, staging, true);
    yield* fs.makeDirectory(userdata, { recursive: true });
    const entries = yield* fs.readDirectory(staging);
    const ordered = [
      ...entries.filter((name) => !DATABASE_FILE.test(name)),
      ...entries.filter((name) => DATABASE_FILE.test(name)),
    ];
    for (const name of ordered) {
      const destination = path.join(userdata, name);
      // Anything the desktop app already wrote for this install wins over the copy.
      if (yield* fs.exists(destination)) continue;
      yield* fs.rename(path.join(staging, name), destination);
    }
    yield* fs.remove(staging, { recursive: true, force: true });
    yield* writeMarker("migrated");
    return { status: "migrated", from: legacyUserdata, to: userdata } as const;
  }).pipe(
    Effect.mapError(
      (cause) => new LegacyHomeMigrationError({ from: legacyUserdata, to: userdata, cause }),
    ),
  );
});

/** Migrates only for the default production home, and never blocks server startup. */
export const migrateLegacyHomeOnStartup = Effect.fn("legacyHomeMigration.onStartup")(function* (
  stateDir: string,
) {
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  if (stateDir !== path.join(homeDirectory, HOME_DIR_NAME, "userdata")) return;
  const result = yield* migrateLegacyHome(homeDirectory).pipe(
    Effect.catchTags({
      LegacyHomeMigrationError: (error) =>
        Effect.logWarning(error.message, { cause: error.cause }).pipe(Effect.as(undefined)),
    }),
  );
  if (result?.status === "migrated") {
    yield* Effect.logInfo(
      `Copied ${UPSTREAM_PRODUCT_NAME} data from ${result.from} to ${result.to}.`,
    );
  } else if (result?.status === "legacy-server-running") {
    yield* Effect.logWarning(
      `${UPSTREAM_PRODUCT_NAME} is running (pid ${result.pid}); its data will be copied on the next start after it quits.`,
    );
  }
});
