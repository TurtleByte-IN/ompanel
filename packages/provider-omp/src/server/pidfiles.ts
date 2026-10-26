/**
 * Pidfiles for live `omp` session processes. Each spawn writes `<pid>.json`; a clean stop removes
 * it. A server that crashed or was killed leaves its pidfiles behind, and the next server boot
 * kills those trees (`sweep`). A pidfile is never trusted alone: the process must still have the
 * start time recorded at spawn, so a recycled pid is left alone.
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { isProcessAlive, killOmpProcessTree, readProcessStartTime } from "./processTree.ts";

/** Distinguishes this server process from an earlier one that had the same pid. */
const OMP_SERVER_BOOT_ID = `${process.pid}@${performance.timeOrigin}`;

export const OmpPidRecord = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  /** `readProcessStartTime` at spawn; `null` when the platform gave none. */
  startTime: Schema.NullOr(Schema.String),
  ownerPid: Schema.Int,
  ownerBootId: Schema.String,
  threadId: Schema.String,
  startedAt: Schema.String,
});
export type OmpPidRecord = typeof OmpPidRecord.Type;

const OmpPidRecordJson = Schema.fromJsonString(OmpPidRecord);
const decodeRecord = Schema.decodeUnknownEffect(OmpPidRecordJson);
const encodeRecord = Schema.encodeEffect(OmpPidRecordJson);

export class OmpPidfileError extends Schema.TaggedError<OmpPidfileError>()("OmpPidfileError", {
  pid: Schema.Int,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Could not record OMP process ${this.pid} for cleanup.`;
  }
}

export type OmpSweepOutcome =
  /** The tree was alive and has been killed. */
  | "killed"
  /** Nothing of it was left running. */
  | "gone"
  /** A live Ompanel server (this one or another) owns it. */
  | "owned"
  /** The pid now belongs to an unrelated process. */
  | "recycled"
  /** It is alive but could not be identified or killed; the pidfile stays for the next boot. */
  | "kept";

export interface OmpSweepEntry {
  readonly file: string;
  readonly pid: number | null;
  readonly outcome: OmpSweepOutcome;
}

export interface OmpPidfilesOptions {
  readonly dir: string;
  readonly platform: NodeJS.Platform;
  /** Overridable so tests can stand in for an earlier boot. */
  readonly bootId?: string;
  readonly ownerPid?: number;
}

export interface OmpPidfiles {
  readonly dir: string;
  /** Records a freshly spawned tree; its start time is read now, while the pid is surely ours. */
  readonly register: (input: {
    readonly pid: number;
    readonly threadId: string;
  }) => Effect.Effect<OmpPidRecord, OmpPidfileError>;
  readonly release: (pid: number) => Effect.Effect<void>;
  /** Kills every tree an earlier server left and removes its pidfile. */
  readonly sweep: Effect.Effect<ReadonlyArray<OmpSweepEntry>>;
}

export const makeOmpPidfiles = Effect.fn("makeOmpPidfiles")(function* (
  options: OmpPidfilesOptions,
): Effect.fn.Return<
  OmpPidfiles,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const bootId = options.bootId ?? OMP_SERVER_BOOT_ID;
  const ownerPid = options.ownerPid ?? process.pid;
  const { platform } = options;
  const startTimeOf = (pid: number) =>
    readProcessStartTime(pid, platform).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
  const killTree = (pid: number) =>
    killOmpProcessTree(pid, platform).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

  const register: OmpPidfiles["register"] = Effect.fn("OmpPidfiles.register")(function* (input) {
    const record: OmpPidRecord = {
      version: 1,
      pid: input.pid,
      startTime: yield* startTimeOf(input.pid),
      ownerPid,
      ownerBootId: bootId,
      threadId: input.threadId,
      startedAt: DateTime.formatIso(yield* DateTime.now),
    };
    yield* fileSystem.makeDirectory(options.dir, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(encodeRecord(record)),
      Effect.flatMap((json) =>
        fileSystem.writeFileString(path.join(options.dir, `${input.pid}.json`), json, {
          mode: 0o600,
        }),
      ),
      Effect.mapError((cause) => new OmpPidfileError({ pid: input.pid, cause })),
    );
    return record;
  });

  const release: OmpPidfiles["release"] = (pid) =>
    fileSystem.remove(path.join(options.dir, `${pid}.json`), { force: true }).pipe(Effect.ignore);

  const classify = Effect.fn("OmpPidfiles.classify")(function* (record: OmpPidRecord) {
    if (record.ownerBootId === bootId) return "owned" as const;
    if (record.ownerPid !== ownerPid && isProcessAlive(record.ownerPid)) return "owned" as const;
    // Only a live `omp` with the recorded start time is ours. Once it is gone its pid, and with
    // it the process-group id, may belong to an unrelated program, so leftovers are not signalled.
    if (!isProcessAlive(record.pid)) return "gone" as const;
    const startTime = yield* startTimeOf(record.pid);
    if (record.startTime === null || startTime === null) return "kept" as const;
    if (startTime !== record.startTime) return "recycled" as const;
    return (yield* killTree(record.pid)) ? ("killed" as const) : ("kept" as const);
  });

  const sweepOne = Effect.fn("OmpPidfiles.sweepOne")(function* (file: string) {
    const record = yield* fileSystem.readFileString(file).pipe(
      Effect.flatMap((text) => decodeRecord(text)),
      Effect.option,
    );
    // Unreadable pidfiles name no process that could be checked.
    const outcome = Option.isSome(record) ? yield* classify(record.value) : "gone";
    if (outcome !== "kept" && outcome !== "owned") {
      yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
    }
    return {
      file,
      pid: Option.isSome(record) ? record.value.pid : null,
      outcome,
    } satisfies OmpSweepEntry;
  });

  const sweep: OmpPidfiles["sweep"] = Effect.gen(function* () {
    const names = yield* fileSystem
      .readDirectory(options.dir)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const entries: Array<OmpSweepEntry> = [];
    for (const name of names) {
      if (!/^\d+\.json$/.test(name)) continue;
      entries.push(yield* sweepOne(path.join(options.dir, name)));
    }
    return entries;
  }).pipe(Effect.withSpan("OmpPidfiles.sweep"));

  return { dir: options.dir, register, release, sweep };
});
