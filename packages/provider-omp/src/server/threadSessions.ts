/**
 * The running OMP thread sessions of one instance, and the settings engine's way into them:
 * RPC overrides go to the live process, overlay overrides to the thread's `--config` file, and
 * the "restart required" marker to the session's provider state.
 */
import type { ProviderSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";

import { OMP_GUARDED_KEYS, type OmpThreadRpcCommand } from "../configForm.ts";
import { OMP_EMPTY_OVERLAY, ompThreadOverlayPath } from "./launch.ts";
import type { OmpRpcProcess } from "./rpcProcess.ts";
import {
  type OmpThreadSettingsHost,
  OmpThreadHostError,
  ompOverlayValue,
  ompOverlayWith,
} from "./settingsEngine.ts";

/** How long a session-only settings command may take before the override is reported failed. */
const THREAD_COMMAND_TIMEOUT_MS = 10_000;

export interface OmpThreadSession {
  readonly threadId: string;
  readonly providerSessionId: ProviderSessionId;
  readonly cwd: string;
  readonly process: Pick<OmpRpcProcess, "request">;
  /** Publishes every key the session must restart for, each time the set grows. */
  readonly onRestartRequired: (keys: ReadonlyArray<string>) => Effect.Effect<void>;
  /** A T3 turn is running in the session; a fork of it must wait (sessionBranches.ts). */
  readonly isBusy: () => boolean;
}

export interface OmpThreadSessions {
  /** Tracks the session until the current scope closes. */
  readonly register: (session: OmpThreadSession) => Effect.Effect<void, never, Scope.Scope>;
  readonly list: Effect.Effect<ReadonlyArray<OmpThreadSession>>;
  readonly get: (threadId: string) => OmpThreadSession | undefined;
  /** Keys changed since the session started that it reads only at startup. */
  readonly restartRequired: (providerSessionId: ProviderSessionId) => ReadonlyArray<string>;
  readonly markRestartRequired: (
    threadId: string,
    keys: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
}

export const makeOmpThreadSessions = (): OmpThreadSessions => {
  const sessions = new Map<string, OmpThreadSession>();
  // Cleared with the session: its replacement starts with the current settings.
  const pending = new Map<string, ReadonlyArray<string>>();

  return {
    register: (session) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          sessions.set(session.threadId, session);
          pending.delete(session.threadId);
        }),
        () =>
          Effect.sync(() => {
            if (sessions.get(session.threadId) !== session) return;
            sessions.delete(session.threadId);
            pending.delete(session.threadId);
          }),
      ),
    list: Effect.sync(() => [...sessions.values()]),
    get: (threadId) => sessions.get(threadId),
    restartRequired: (providerSessionId) => {
      for (const session of sessions.values()) {
        if (session.providerSessionId === providerSessionId) {
          return pending.get(session.threadId) ?? [];
        }
      }
      return [];
    },
    markRestartRequired: (threadId, keys) =>
      Effect.suspend(() => {
        const session = sessions.get(threadId);
        if (session === undefined) return Effect.void;
        const current = pending.get(threadId) ?? [];
        const next = [...new Set([...current, ...keys])];
        if (next.length === current.length) return Effect.void;
        pending.set(threadId, next);
        return session.onRestartRequired(next);
      }),
  };
};

const requestCommand = <C extends OmpThreadRpcCommand>(
  process: OmpThreadSession["process"],
  command: C,
) => process.request(command.type, command.params, { timeoutMs: THREAD_COMMAND_TIMEOUT_MS });

/** The thread's `--config` overlay; an absent one reads as the empty overlay. */
export const readOmpThreadOverlay = Effect.fn("readOmpThreadOverlay")(function* (
  threadsDir: string,
  threadId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  return yield* fileSystem.readFileString(ompThreadOverlayPath(path, threadsDir, threadId)).pipe(
    Effect.catchIf(
      (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
      () => Effect.succeed(OMP_EMPTY_OVERLAY),
    ),
    Effect.mapError(() => new OmpThreadHostError({ threadId, reason: "io" })),
  );
});

/** One writer per overlay file at a time, across the adapter and the settings engine. */
const overlayLocks = new Map<string, Semaphore.Semaphore>();
const overlayLock = (target: string) => {
  let lock = overlayLocks.get(target);
  if (lock === undefined) {
    lock = Semaphore.makeUnsafe(1);
    overlayLocks.set(target, lock);
  }
  return lock;
};

/**
 * Replaces the thread's overlay whole, owner-only, under the overlay's lock. Only the adapter
 * (`ownsGuardKeys`) changes the browser and computer-use keys (toolGuards.ts): any other writer's
 * content gets them from the file on disk, so a write based on an older read cannot drop a guard.
 */
export const writeOmpThreadOverlay = Effect.fn("writeOmpThreadOverlay")(function* (
  threadsDir: string,
  threadId: string,
  content: string,
  options: { readonly ownsGuardKeys?: boolean } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const target = ompThreadOverlayPath(path, threadsDir, threadId);
  const staging = `${target}.tmp`;
  const write = Effect.gen(function* () {
    let next = content;
    if (options.ownsGuardKeys !== true) {
      // Only an absent file reads as empty; any other read error fails the write rather than
      // dropping both guards.
      const current = yield* fileSystem.readFileString(target).pipe(
        Effect.catchIf(
          (error) => error._tag === "PlatformError" && error.reason._tag === "NotFound",
          () => Effect.succeed(OMP_EMPTY_OVERLAY),
        ),
      );
      for (const key of OMP_GUARDED_KEYS) {
        const kept = ompOverlayValue(current, key);
        if (ompOverlayValue(next, key) !== kept) next = yield* ompOverlayWith(next, key, kept);
      }
    }
    // A rename swaps the file whole, so OMP's live reload never reads half an overlay.
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true, mode: 0o700 });
    yield* fileSystem.writeFileString(staging, next, { mode: 0o600 });
    yield* fileSystem.rename(staging, target);
  });
  yield* overlayLock(target)
    .withPermits(1)(write)
    .pipe(Effect.mapError(() => new OmpThreadHostError({ threadId, reason: "io" })));
});

/** The settings engine's view of this instance's threads; overlays live under `threadsDir`. */
export const makeOmpThreadSettingsHost = Effect.fn("makeOmpThreadSettingsHost")(function* (input: {
  readonly sessions: OmpThreadSessions;
  readonly threadsDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const withFiles = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
  ): Effect.Effect<A, E> =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

  return {
    openThreads: input.sessions.list.pipe(
      Effect.map((sessions) =>
        sessions.map((session) => ({ threadId: session.threadId, cwd: session.cwd })),
      ),
    ),
    sendCommand: (threadId, command) => {
      const session = input.sessions.get(threadId);
      if (session === undefined) {
        return Effect.fail(new OmpThreadHostError({ threadId, reason: "not_open" }));
      }
      return requestCommand(session.process, command).pipe(
        Effect.asVoid,
        Effect.mapError(
          (error) =>
            new OmpThreadHostError({ threadId, reason: "rejected", detail: error.message }),
        ),
      );
    },
    readOverlay: (threadId) => withFiles(readOmpThreadOverlay(input.threadsDir, threadId)),
    writeOverlay: (threadId, content) =>
      withFiles(writeOmpThreadOverlay(input.threadsDir, threadId, content)),
    markRestartRequired: input.sessions.markRestartRequired,
  } satisfies OmpThreadSettingsHost;
});
