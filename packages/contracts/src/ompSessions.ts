import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const OmpSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

/**
 * One conversation OMP keeps on disk (`<sessions dir>/<project bucket>/<time>_<id>.jsonl`), as
 * the import list shows it. Threads map 1:1 to these files, so a session OMP started in a
 * terminal can continue as an Ompanel thread.
 */
export const OmpSessionSummary = Schema.Struct({
  sessionId: OmpSessionId,
  /** The directory the session works in (its header `cwd`). */
  cwd: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
  /** The session's title, when OMP or the user named it. */
  title: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  /** The first user message, shortened, for sessions without a title. */
  firstMessage: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** The Ompanel thread already bound to this session, if it was imported or started here. */
  importedThreadId: Schema.NullOr(ThreadId),
  /**
   * The project the session continues in: the one whose root or git worktree holds `cwd` (the
   * innermost when several do). Null when no project does.
   */
  projectId: Schema.NullOr(ProjectId),
  /** The project's git worktree holding `cwd`; null when it is the project root itself. */
  worktreePath: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(4_096))),
  /** The branch checked out in `worktreePath`. */
  branch: Schema.NullOr(TrimmedNonEmptyString.check(Schema.isMaxLength(512))),
});
export type OmpSessionSummary = typeof OmpSessionSummary.Type;

export const OmpListSessionsScope = Schema.Literals(["project", "all"]);
export type OmpListSessionsScope = typeof OmpListSessionsScope.Type;

export const OmpListSessionsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /**
   * With scope `project` (the default), sessions working in this project's root, its git
   * worktrees or below are listed. Required for that scope.
   */
  projectId: Schema.optionalKey(ProjectId),
  /** `all` lists sessions from every folder. */
  scope: Schema.optionalKey(OmpListSessionsScope),
});
export type OmpListSessionsInput = typeof OmpListSessionsInput.Type;

export const OmpListSessionsResult = Schema.Struct({
  /** Newest first. */
  sessions: Schema.Array(OmpSessionSummary).check(Schema.isMaxLength(500)),
  /** The folders sessions were listed for; empty with scope `all`. */
  searchedDirectories: Schema.Array(Schema.String),
  /** The OMP sessions directory that was scanned. */
  sessionsDirectory: Schema.String,
});
export type OmpListSessionsResult = typeof OmpListSessionsResult.Type;

export const OmpImportSessionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** The project and worktree come from the session's `cwd`. */
  sessionId: OmpSessionId,
});
export type OmpImportSessionInput = typeof OmpImportSessionInput.Type;

export const OmpImportSessionResult = Schema.Struct({
  threadId: ThreadId,
  /** False when the session already had a thread. */
  imported: Schema.Boolean,
});
export type OmpImportSessionResult = typeof OmpImportSessionResult.Type;

export const OmpSessionsOperationErrorReason = Schema.Literals([
  "instance_not_found",
  "unsupported",
  "project_not_found",
  "session_not_found",
  "read_failed",
  "import_failed",
]);
export type OmpSessionsOperationErrorReason = typeof OmpSessionsOperationErrorReason.Type;

export class OmpSessionsOperationError extends Schema.TaggedError<OmpSessionsOperationError>()(
  "OmpSessionsOperationError",
  {
    reason: OmpSessionsOperationErrorReason,
    message: Schema.String,
  },
) {}
