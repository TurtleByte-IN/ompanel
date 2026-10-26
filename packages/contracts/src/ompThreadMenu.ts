import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * The OMP section of a thread's menu (PRD FR-21): Export HTML, Share gist, Share live and the
 * branch tree of the thread's OMP session.
 */
export const OmpThreadMenuInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
});
export type OmpThreadMenuInput = typeof OmpThreadMenuInput.Type;

/** The session as one self-contained HTML page (`export_html`, or `omp --export` when idle). */
export const OmpExportHtmlResult = Schema.Struct({
  /** Suggested download name, `omp-session-<file id>.html`. */
  fileName: Schema.String,
  html: Schema.String,
});
export type OmpExportHtmlResult = typeof OmpExportHtmlResult.Type;

/** `omp share <session file> --gist`: the encrypted viewer link and the secret gist behind it. */
export const OmpShareGistResult = Schema.Struct({
  /** The viewer link; the decryption key is in its fragment. */
  url: Schema.String,
  /**
   * The secret gist holding the sealed session. Null when OMP could not create it and uploaded
   * to its share server instead.
   */
  gistUrl: Schema.NullOr(Schema.String),
  /** Large content was trimmed to fit the share size limit. */
  truncated: Schema.Boolean,
});
export type OmpShareGistResult = typeof OmpShareGistResult.Type;

export const OmpCollabAccess = Schema.Literals(["view", "control"]);
export type OmpCollabAccess = typeof OmpCollabAccess.Type;

export const OmpCollabStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  threadId: ThreadId,
  /** `view` guests watch; `control` guests can also prompt, interrupt and answer dialogs. */
  access: OmpCollabAccess,
});
export type OmpCollabStartInput = typeof OmpCollabStartInput.Type;

export const OmpCollabParticipant = Schema.Struct({
  name: Schema.String,
  role: Schema.Literals(["host", "guest"]),
  readOnly: Schema.optional(Schema.Boolean),
});
export type OmpCollabParticipant = typeof OmpCollabParticipant.Type;

/**
 * The thread's collab room (OMP `/collab`). The links are capabilities: anyone holding one
 * reaches the session through OMP's relay, outside T3's pairing.
 */
export const OmpCollabStatus = Schema.Struct({
  active: Schema.Boolean,
  access: Schema.optional(OmpCollabAccess),
  /** `omp join` link. */
  link: Schema.optional(Schema.String),
  /** Browser link; the QR code encodes it. */
  webLink: Schema.optional(Schema.String),
  relayConnected: Schema.optional(Schema.Boolean),
  /** Host first; empty when no room is active. */
  participants: Schema.Array(OmpCollabParticipant),
});
export type OmpCollabStatus = typeof OmpCollabStatus.Type;

export const OmpCollabStopResult = Schema.Struct({
  /** False when no room was active. */
  stopped: Schema.Boolean,
});
export type OmpCollabStopResult = typeof OmpCollabStopResult.Type;

/** One node of the branch view: a user or assistant message, a branch summary or a compaction. */
export const OmpBranchNode = Schema.Struct({
  entryId: Schema.String,
  /** The nearest kept ancestor; null for a root. */
  parentId: Schema.NullOr(Schema.String),
  kind: Schema.Literals(["user", "assistant", "branch_summary", "compaction"]),
  /** The first characters of a user message or summary; empty for an assistant message. */
  preview: Schema.String,
  timestamp: Schema.NullOr(Schema.String),
  label: Schema.NullOr(Schema.String),
});
export type OmpBranchNode = typeof OmpBranchNode.Type;

/** The session's branch tree (`get_tree`): nodes parents first, and the path to the leaf. */
export const OmpBranchTree = Schema.Struct({
  nodes: Schema.Array(OmpBranchNode),
  leafId: Schema.NullOr(Schema.String),
  /** From the root to the leaf the session continues from. */
  activePath: Schema.Array(Schema.String),
});
export type OmpBranchTree = typeof OmpBranchTree.Type;

export const OmpThreadMenuOperationErrorReason = Schema.Literals([
  "instance_not_found",
  "unsupported",
  "thread_not_found",
  /** The action needs the thread's OMP session running, and it is not. */
  "not_running",
  /** The thread has no OMP session file yet (nothing was sent). */
  "no_session",
  /** The pinned OMP sidecar predates the RPC the action needs. */
  "needs_newer_omp",
  /** `gh` is missing or not signed in; nothing was uploaded. */
  "gh_unavailable",
  "timeout",
  "omp_failed",
]);
export type OmpThreadMenuOperationErrorReason = typeof OmpThreadMenuOperationErrorReason.Type;

export class OmpThreadMenuOperationError extends Schema.TaggedError<OmpThreadMenuOperationError>()(
  "OmpThreadMenuOperationError",
  {
    reason: OmpThreadMenuOperationErrorReason,
    message: Schema.String,
  },
) {}
