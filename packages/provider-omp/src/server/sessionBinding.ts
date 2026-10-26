/**
 * Binds a thread's `omp` process to the thread's OMP session (C-10; docs/omp/sessions.md): a new
 * thread gets a fresh session in its working directory's bucket, a known thread reopens the
 * session it last ran, and the thread directory remembers which file that is.
 */
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { SessionState } from "../../contract/src/wire.generated.ts";
import {
  findOmpSessionFile,
  type OmpSessionsLocation,
  ompSessionFileId,
  readOmpThreadSessionRecord,
  writeOmpThreadSessionRecord,
} from "./ompSessions.ts";
import type { OmpRpcProcess, OmpRpcRequestError } from "./rpcProcess.ts";

/** Session switches load and index the whole transcript. */
const SESSION_SWITCH_TIMEOUT_MS = 60_000;
const STATE_TIMEOUT_MS = 10_000;

/** The thread's session could not be found or opened. */
export class OmpSessionBindingError extends Schema.TaggedError<OmpSessionBindingError>()(
  "OmpSessionBindingError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export interface OmpSessionBindingInput {
  readonly process: Pick<OmpRpcProcess, "request">;
  readonly location: OmpSessionsLocation;
  /** `<state>/omp/threads`; the record sits in the thread's directory. */
  readonly threadsDir: string;
  readonly threadId: string;
}

const bindingError = (detail: string) => Effect.fail(new OmpSessionBindingError({ detail }));

const readState = (process: OmpSessionBindingInput["process"]) =>
  process.request("get_state", undefined, { timeoutMs: STATE_TIMEOUT_MS });

/** The id of the file the process runs; what `get_state` reports when it has no file. */
const fileIdOf = (state: Pick<SessionState, "sessionId" | "sessionFile">) =>
  state.sessionFile === undefined ? state.sessionId : ompSessionFileId(state.sessionFile);

/** Remembers the session the thread now runs; a failed write only costs the next lookup a scan. */
export const recordOmpThreadSession = (
  input: Pick<OmpSessionBindingInput, "threadsDir" | "threadId">,
  state: Pick<SessionState, "sessionId" | "sessionFile">,
) =>
  writeOmpThreadSessionRecord(input.threadsDir, {
    threadId: input.threadId,
    sessionId: fileIdOf(state),
    reportedSessionId: state.sessionId,
    sessionFile: state.sessionFile ?? null,
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("could not record the thread's OMP session", { detail: error.message }),
    ),
  );

/**
 * Switches the process to the thread's session, given the thread's native id: the id OMP
 * reported, which after `/fresh` is not the id the file carries. The thread's record maps it to
 * the file; the recorded path is tried first, else wherever `/wt` moved the file. A saved model
 * OMP can no longer restore fails a plain switch, so it is retried with the model the process runs.
 */
export const switchOmpSession = Effect.fn("switchOmpSession")(function* (
  input: OmpSessionBindingInput & { readonly sessionId: string },
): Effect.fn.Return<
  SessionState,
  OmpSessionBindingError | OmpRpcRequestError,
  FileSystem.FileSystem | Path.Path
> {
  const current = yield* readState(input.process);
  const record = yield* readOmpThreadSessionRecord(input.threadsDir, input.threadId);
  const recorded =
    record !== null &&
    (record.sessionId === input.sessionId || record.reportedSessionId === input.sessionId);
  const fileId = recorded ? record.sessionId : input.sessionId;
  if (fileIdOf(current) === fileId) return current;
  const hint = recorded ? (record.sessionFile ?? undefined) : undefined;
  const sessionPath = yield* findOmpSessionFile(input.location, fileId, hint);
  if (sessionPath === null) {
    return yield* bindingError(
      `OMP session ${fileId} was not found in ${input.location.root}; it may have been deleted`,
    );
  }
  const plain = input.process.request(
    "switch_session",
    { sessionPath },
    { timeoutMs: SESSION_SWITCH_TIMEOUT_MS },
  );
  const model = current.model;
  const { cancelled } = yield* model === undefined
    ? plain
    : plain.pipe(
        Effect.catchTags({
          OmpRpcCommandError: () =>
            input.process.request(
              "switch_session",
              { sessionPath, provider: model.provider, modelId: model.id },
              { timeoutMs: SESSION_SWITCH_TIMEOUT_MS },
            ),
        }),
      );
  if (cancelled) return yield* bindingError(`OMP declined to open session ${fileId}`);
  const state = yield* readState(input.process);
  if (fileIdOf(state) !== fileId) {
    return yield* bindingError(
      `OMP opened ${state.sessionFile ?? state.sessionId} from ${sessionPath}, not session ${fileId}`,
    );
  }
  return state;
});

/**
 * Makes sure the process runs an empty session of its own: a fresh process does, unless OMP's
 * `autoResume` setting continued the directory's latest conversation, which a new thread must
 * not take over.
 */
export const ensureFreshOmpSession = Effect.fn("ensureFreshOmpSession")(function* (
  process: OmpSessionBindingInput["process"],
): Effect.fn.Return<SessionState, OmpSessionBindingError | OmpRpcRequestError> {
  const state = yield* readState(process);
  if ((state.messageCount ?? 0) === 0) return state;
  const { cancelled } = yield* process.request(
    "new_session",
    {},
    { timeoutMs: SESSION_SWITCH_TIMEOUT_MS },
  );
  if (cancelled) return yield* bindingError("OMP declined to start a new session");
  return yield* readState(process);
});
