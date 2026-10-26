/**
 * OMP's session files on disk, as Ompanel finds, lists and remembers them (C-10;
 * docs/omp/sessions.md). Every path rule here follows the pinned fork:
 *
 * - Sessions live in `<agent dir>/sessions/<bucket>/<timestamp>_<sessionId>.jsonl`, one bucket per
 *   working directory (`session/session-paths.ts`, `session/session-manager.ts`); `/wt` moves a
 *   file into its worktree's bucket but keeps its name.
 * - The agent dir is `PI_CODING_AGENT_DIR`, else `~/.omp[/profiles/<p>]/agent`; a named profile
 *   ignores `PI_CODING_AGENT_DIR`. On Linux and macOS a default agent dir moves its data under
 *   `$XDG_DATA_HOME/omp[/profiles/<p>]` once that directory exists (`utils/src/dirs.ts`).
 * - `PI_CODING_AGENT_SESSION_DIR` puts every session in one directory, without buckets
 *   (`cli/args.ts`).
 * - A file opens with an optional fixed-width `{"type":"title"}` slot, then the
 *   `{"type":"session"}` header, then entries (docs/session.md).
 */
import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/** Bytes read from the start of a file: the title slot, the header and the first entries. */
const HEAD_BYTES = 64 * 1024;
/** Longest title or first message the import list carries. */
const PREVIEW_CHARS = 200;
/** Most sessions one listing returns. */
export const OMP_SESSION_LIST_LIMIT = 500;

const OMP_PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface OmpSessionsLocation {
  /** Directory holding one bucket per working directory, or the single directory when `flat`. */
  readonly root: string;
  /** `PI_CODING_AGENT_SESSION_DIR`: every session sits directly in `root`. */
  readonly flat: boolean;
}

/** OMP's own profile resolution: `--profile`, else `OMP_PROFILE`, else `PI_PROFILE`. */
const effectiveProfile = (profile: string, environment: NodeJS.ProcessEnv): string | undefined => {
  const raw = profile.trim() !== "" ? profile : (environment.OMP_PROFILE ?? environment.PI_PROFILE);
  const name = raw?.trim();
  if (name === undefined || name === "" || name === "default") return undefined;
  // OMP refuses an invalid name before it touches any directory; so does the listing.
  return OMP_PROFILE_NAME.test(name) && !name.endsWith(".") ? name : undefined;
};

/** Where the instance's `omp` keeps its sessions, given the environment it runs with. */
export const resolveOmpSessionsLocation = Effect.fn("resolveOmpSessionsLocation")(
  function* (input: {
    readonly environment: NodeJS.ProcessEnv;
    /** The instance's `--profile`; empty for OMP's default. */
    readonly profile: string;
    readonly platform: NodeJS.Platform;
    /** The server's home directory, used when the environment names none. */
    readonly homeDir: string;
  }) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { environment } = input;
    const explicit = environment.PI_CODING_AGENT_SESSION_DIR;
    if (explicit !== undefined && explicit !== "") {
      return { root: path.resolve(explicit), flat: true } satisfies OmpSessionsLocation;
    }
    const home =
      (input.platform === "win32" ? environment.USERPROFILE : environment.HOME) || input.homeDir;
    const profile = effectiveProfile(input.profile, environment);
    const configRoot = path.join(
      home,
      environment.PI_CONFIG_DIR || ".omp",
      ...(profile === undefined ? [] : ["profiles", profile]),
    );
    const defaultAgentDir = path.join(configRoot, "agent");
    const override = environment.PI_CODING_AGENT_DIR;
    const agentDir =
      profile === undefined && override !== undefined && override !== ""
        ? path.resolve(override)
        : defaultAgentDir;
    const xdgData = environment.XDG_DATA_HOME;
    if (
      (input.platform === "linux" || input.platform === "darwin") &&
      agentDir === defaultAgentDir &&
      xdgData !== undefined &&
      xdgData !== ""
    ) {
      const appRoot = path.join(
        xdgData,
        "omp",
        ...(profile === undefined ? [] : ["profiles", profile]),
      );
      if (yield* fileSystem.exists(appRoot).pipe(Effect.orElseSucceed(() => false))) {
        return { root: path.join(appRoot, "sessions"), flat: false } satisfies OmpSessionsLocation;
      }
    }
    return { root: path.join(agentDir, "sessions"), flat: false } satisfies OmpSessionsLocation;
  },
);

/** What the start of a session file says about it. */
export interface OmpSessionHead {
  readonly sessionId: string;
  readonly sessionFile: string;
  readonly cwd: string;
  readonly title: string | null;
  readonly firstMessage: string | null;
  /** The header `timestamp`. */
  readonly createdAt: string;
  /** A `message` entry appears in the bytes read. */
  readonly hasMessages: boolean;
}

export interface OmpStoredSession extends OmpSessionHead {
  /** File modification time, ISO. */
  readonly updatedAt: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const nonEmpty = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** One line of display text: first line, controls stripped, shortened. */
const preview = (text: string | null): string | null => {
  if (text === null) return null;
  const line = text
    .split("\n")
    .map((part) => part.trim())
    .find((part) => part !== "");
  if (line === undefined) return null;
  // oxlint-disable-next-line no-control-regex
  const clean = line.replace(/[\u0000-\u001F\u007F-\u009F]/g, "");
  return clean.length > PREVIEW_CHARS ? `${clean.slice(0, PREVIEW_CHARS - 1)}…` : clean;
};

/** Text of a user message's `content` (a string or text/image blocks). */
export const ompMessageText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const record = asRecord(block);
      return record?.["type"] === "text" && typeof record["text"] === "string"
        ? [record["text"]]
        : [];
    })
    .join("");
};

/**
 * Parses the start of a session file. Null when it holds no session header (an empty stub, a
 * subagent breadcrumb or another file).
 */
export const parseOmpSessionHead = (sessionFile: string, text: string): OmpSessionHead | null => {
  // The last line may be cut off by the read window.
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();
  let title: string | null = null;
  let header: Record<string, unknown> | undefined;
  let firstMessage: string | null = null;
  let hasMessages = false;
  for (const line of lines) {
    if (line.trim() === "") continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    if (entry === undefined) continue;
    if (header === undefined) {
      if (entry["type"] === "title") {
        title = nonEmpty(entry["title"]);
        continue;
      }
      // The header is the first logical entry; anything else first is not a session file.
      if (entry["type"] !== "session" || typeof entry["id"] !== "string") return null;
      header = entry;
      continue;
    }
    if (entry["type"] !== "message") continue;
    hasMessages = true;
    const message = asRecord(entry["message"]);
    if (firstMessage === null && message?.["role"] === "user" && message["synthetic"] !== true) {
      firstMessage = nonEmpty(ompMessageText(message["content"]));
    }
    if (firstMessage !== null) break;
  }
  if (header === undefined) return null;
  const sessionId = header["id"] as string;
  const cwd = nonEmpty(header["cwd"]);
  if (sessionId.trim() === "" || cwd === null) return null;
  return {
    sessionId,
    sessionFile,
    cwd,
    title: preview(title ?? nonEmpty(header["title"])),
    firstMessage: preview(firstMessage),
    createdAt: typeof header["timestamp"] === "string" ? header["timestamp"] : "",
    hasMessages,
  };
};

/** Reads and parses the start of `sessionFile`; null when unreadable or not a session. */
export const readOmpSessionHead = Effect.fn("readOmpSessionHead")(function* (sessionFile: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const bytes = yield* Effect.scoped(
    fileSystem
      .open(sessionFile, { flag: "r" })
      .pipe(Effect.flatMap((file) => file.readAlloc(HEAD_BYTES))),
  ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
  if (Option.isNone(bytes)) return null;
  return parseOmpSessionHead(sessionFile, new TextDecoder().decode(bytes.value));
});

/** `<timestamp>_<sessionId>.jsonl`; subagent transcripts (`<agentId>.jsonl`) have no `_`. */
const SESSION_FILE_NAME = /^[^_/\\]+_[^/\\]+\.jsonl$/;

/** Every directory sessions sit in: the buckets under the root, or the root itself. */
const sessionDirectories = Effect.fn("ompSessionDirectories")(function* (
  location: OmpSessionsLocation,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (location.flat) return [location.root];
  const entries = yield* fileSystem
    .readDirectory(location.root)
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  const dirs: Array<string> = [];
  for (const entry of entries) {
    const dir = path.join(location.root, entry);
    const info = yield* fileSystem.stat(dir).pipe(Effect.option);
    if (Option.isSome(info) && info.value.type === "Directory") dirs.push(dir);
  }
  return dirs;
});

interface SessionFile {
  readonly file: string;
  /** Modification time, epoch milliseconds. */
  readonly modifiedMs: number;
}

/** Session files in `dir` (optionally only those named for `sessionId`), with their mtimes. */
const sessionFilesIn = Effect.fn("ompSessionFilesIn")(function* (dir: string, sessionId?: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const names = yield* fileSystem
    .readDirectory(dir)
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  const files: Array<SessionFile> = [];
  for (const name of names) {
    if (!SESSION_FILE_NAME.test(name)) continue;
    if (sessionId !== undefined && !name.endsWith(`_${sessionId}.jsonl`)) continue;
    const file = path.join(dir, name);
    const info = yield* fileSystem.stat(file).pipe(Effect.option);
    if (Option.isNone(info) || info.value.type !== "File") continue;
    const modifiedMs = Option.match(info.value.mtime, {
      onNone: () => 0,
      onSome: (mtime) => mtime.getTime(),
    });
    files.push({ file, modifiedMs });
  }
  return files;
});

/** The directory's canonical spellings: as given and with symlinks resolved. */
const directorySpellings = Effect.fn("ompDirectorySpellings")(function* (dir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolved = path.resolve(dir);
  const real = yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
  return new Set([resolved, real]);
});

/**
 * Sessions working in `cwd` (header `cwd`, symlinks resolved), newest first. Empty stubs (no
 * message and no title) are left out, as OMP's own pickers do.
 */
export const listOmpSessions = Effect.fn("listOmpSessions")(function* (
  location: OmpSessionsLocation,
  cwd: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const wanted = yield* directorySpellings(cwd);
  const files: Array<SessionFile> = [];
  for (const dir of yield* sessionDirectories(location)) {
    files.push(...(yield* sessionFilesIn(dir)));
  }
  files.sort((a, b) => b.modifiedMs - a.modifiedMs);
  const sessions: Array<OmpStoredSession> = [];
  for (const { file, modifiedMs } of files) {
    if (sessions.length >= OMP_SESSION_LIST_LIMIT) break;
    const head = yield* readOmpSessionHead(file);
    if (head === null || (!head.hasMessages && head.title === null)) continue;
    const resolved = path.resolve(head.cwd);
    const matches =
      wanted.has(resolved) ||
      wanted.has(yield* fileSystem.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved)));
    if (!matches) continue;
    sessions.push({ ...head, updatedAt: DateTime.formatIso(DateTime.makeUnsafe(modifiedMs)) });
  }
  return sessions;
});

/**
 * The file holding session `sessionId`: `hint` when it still does (the path last recorded for
 * the thread), else the newest file named for the id in any bucket (`/wt` moves a session into
 * its worktree's bucket under the same name). Null when no file holds it.
 */
export const findOmpSessionFile = Effect.fn("findOmpSessionFile")(function* (
  location: OmpSessionsLocation,
  sessionId: string,
  hint?: string,
) {
  if (hint !== undefined) {
    const head = yield* readOmpSessionHead(hint);
    if (head?.sessionId === sessionId) return hint;
  }
  const candidates: Array<SessionFile> = [];
  for (const dir of yield* sessionDirectories(location)) {
    candidates.push(...(yield* sessionFilesIn(dir, sessionId)));
  }
  candidates.sort((a, b) => b.modifiedMs - a.modifiedMs);
  for (const { file } of candidates) {
    const head = yield* readOmpSessionHead(file);
    if (head?.sessionId === sessionId) return file;
  }
  return null;
});

/** The session a thread last ran, kept next to its overlay so a restart can reopen it. */
export const OmpThreadSessionRecord = Schema.Struct({
  version: Schema.Literal(1),
  threadId: Schema.String,
  sessionId: Schema.String,
  /** Where the file was then; `/wt` may have moved it since. */
  sessionFile: Schema.NullOr(Schema.String),
});
export type OmpThreadSessionRecord = typeof OmpThreadSessionRecord.Type;

const OmpThreadSessionRecordJson = Schema.fromJsonString(OmpThreadSessionRecord);
const decodeRecord = Schema.decodeUnknownEffect(OmpThreadSessionRecordJson);
const encodeRecord = Schema.encodeEffect(OmpThreadSessionRecordJson);

const RECORD_FILE = "session.json";

export const ompThreadSessionRecordPath = (
  path: Path.Path,
  threadsDir: string,
  threadId: string,
): string => path.join(threadsDir, encodeURIComponent(threadId), RECORD_FILE);

/** The record in `file`; null when missing or unreadable. */
const readRecordFile = (fileSystem: FileSystem.FileSystem, file: string) =>
  fileSystem.readFileString(file).pipe(
    Effect.flatMap(decodeRecord),
    Effect.orElseSucceed(() => null),
  );

export const readOmpThreadSessionRecord = Effect.fn("readOmpThreadSessionRecord")(function* (
  threadsDir: string,
  threadId: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const record = yield* readRecordFile(
    fileSystem,
    ompThreadSessionRecordPath(path, threadsDir, threadId),
  );
  return record?.threadId === threadId ? record : null;
});

/** Replaces the thread's record atomically, owner-only. */
export const writeOmpThreadSessionRecord = Effect.fn("writeOmpThreadSessionRecord")(function* (
  threadsDir: string,
  record: Omit<OmpThreadSessionRecord, "version">,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = ompThreadSessionRecordPath(path, threadsDir, record.threadId);
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true, mode: 0o700 });
  const text = yield* encodeRecord({ version: 1, ...record });
  const temporary = `${file}.${process.pid}.tmp`;
  yield* fileSystem.writeFileString(temporary, `${text}\n`, { mode: 0o600 });
  yield* fileSystem.rename(temporary, file);
});

/** Session id → the thread whose record names it, across every thread directory. */
export const readOmpThreadSessionRecords = Effect.fn("readOmpThreadSessionRecords")(function* (
  threadsDir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const owners = new Map<string, ThreadId>();
  const entries = yield* fileSystem
    .readDirectory(threadsDir)
    .pipe(Effect.orElseSucceed(() => [] as Array<string>));
  for (const entry of entries) {
    const record = yield* readRecordFile(fileSystem, path.join(threadsDir, entry, RECORD_FILE));
    if (record !== null) owners.set(record.sessionId, record.threadId as ThreadId);
  }
  return owners;
});
