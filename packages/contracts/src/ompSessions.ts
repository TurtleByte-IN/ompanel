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
});
export type OmpSessionSummary = typeof OmpSessionSummary.Type;

export const OmpListSessionsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Sessions working in this project's root are listed. */
  projectId: ProjectId,
});
export type OmpListSessionsInput = typeof OmpListSessionsInput.Type;

export const OmpListSessionsResult = Schema.Struct({
  /** Newest first. */
  sessions: Schema.Array(OmpSessionSummary).check(Schema.isMaxLength(500)),
});
export type OmpListSessionsResult = typeof OmpListSessionsResult.Type;

export const OmpImportSessionInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  projectId: ProjectId,
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
