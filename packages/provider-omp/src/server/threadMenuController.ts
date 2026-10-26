/**
 * A thread's OMP menu (PRD FR-21, docs/omp/thread-menu.md). Export and Share gist also work on
 * an idle thread's session file. Collab links are capabilities: returned to the caller only,
 * never logged, put on a span, or journaled.
 */
import {
  OmpThreadMenuOperationError,
  type OmpCollabAccess,
  type OmpCollabStatus,
  type OmpThreadMenuOperationErrorReason,
  type ThreadId,
} from "@t3tools/contracts";
import type { ProviderOmpThreadMenuController } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { OmpControlError, OmpControlService, OmpControlTarget } from "./control.ts";
import { contractAtLeast } from "./hostTools.ts";
import {
  findOmpSessionFile,
  ompSessionFileId,
  readOmpThreadSessionRecord,
  type OmpSessionsLocation,
} from "./ompSessions.ts";
import type { OmpRpcRequestError, OmpRpcRequestOptions } from "./rpcProcess.ts";
import { readOmpBranchTree } from "./sessionBranches.ts";
import type { OmpSidecarError } from "./sidecar.ts";
import type { OmpThreadSession, OmpThreadSessions } from "./threadSessions.ts";

/** The first RPC contract with `collab_start`, `collab_stop` and `collab_status`. */
export const OMP_COLLAB_CONTRACT = "1.7.0";

type OmpThreadMenuTimeouts = Record<keyof typeof OMP_THREAD_MENU_TIMEOUTS_MS, number>;

const OMP_THREAD_MENU_TIMEOUTS_MS = {
  /** `export_html` renders the whole session into one page. */
  export: 60_000,
  /** `collab_start` answers once the relay opened the room; OMP gives the relay 15 seconds. */
  collabStart: 30_000,
  collab: 10_000,
  tree: 15_000,
  state: 10_000,
} as const;

/**
 * OMP's share viewer at the pinned release (`DEFAULT_SHARE_URL` in the fork's `packages/wire`):
 * the only host a gist link from Ompanel points at, whatever `share.serverUrl` a repo sets.
 */
const OMP_SHARE_VIEWER_URL = "https://my.omp.sh/s";

/**
 * `share.serverUrl` for `omp share`: a `.invalid` host never resolves (RFC 6761), so when OMP
 * cannot make the gist its fallback upload to the share server fails instead of uploading.
 */
const OMP_SHARE_SERVER_BLOCKED = "https://share-server-disabled.invalid";

/** The overlay (`PI_CONFIG_FILES`, above project settings) `omp share` runs with. */
const SHARE_OVERLAY = `share:\n  serverUrl: "${OMP_SHARE_SERVER_BLOCKED}"\n  store: gist\n`;

/** OMP's `CollabStatus` (docs/rpc.md, Collab Hosting Sub-Protocol). */
const CollabStatus = Schema.Struct({
  active: Schema.Boolean,
  access: Schema.optional(Schema.Literals(["view", "control"])),
  link: Schema.optional(Schema.String),
  webLink: Schema.optional(Schema.String),
  relayConnected: Schema.optional(Schema.Boolean),
  participants: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      role: Schema.Literals(["host", "guest"]),
      readOnly: Schema.optional(Schema.Boolean),
    }),
  ),
});
const decodeCollabStatus = Schema.decodeUnknownEffect(CollabStatus);
const decodeCollabStop = Schema.decodeUnknownEffect(Schema.Struct({ stopped: Schema.Boolean }));

/**
 * The collab commands, which the pinned contract's typed `request` does not list until the
 * sidecar is repinned to a contract with them; every response is decoded before use.
 */
type OmpCollabRequest = (
  command: "collab_start" | "collab_stop" | "collab_status",
  params: { readonly access: OmpCollabAccess } | undefined,
  options: OmpRpcRequestOptions,
) => Effect.Effect<unknown, OmpRpcRequestError>;

const NO_ROOM: OmpCollabStatus = { active: false, participants: [] };

const fail = (reason: OmpThreadMenuOperationErrorReason, message: string) =>
  new OmpThreadMenuOperationError({ reason, message });

const controlFailed = (error: OmpControlError | OmpSidecarError) =>
  fail(
    error._tag === "OmpControlError" && error.reason === "timeout" ? "timeout" : "omp_failed",
    error.message,
  );

const rpcFailed = (error: OmpRpcRequestError) =>
  fail(error._tag === "OmpRpcTimeoutError" ? "timeout" : "omp_failed", error.message);

export interface OmpThreadMenuControllerInput {
  readonly control: OmpControlService;
  readonly target: (cwd: string) => Effect.Effect<OmpControlTarget, OmpSidecarError>;
  /** A directory with no project config, where the CLI commands run. */
  readonly globalCwd: string;
  /** Owner-only scratch space for rendered pages; each export removes its own file. */
  readonly exportsDir: string;
  readonly threadsDir: string;
  readonly sessionsLocation: OmpSessionsLocation;
  readonly sessions: Pick<OmpThreadSessions, "get">;
  /** The RPC contract every session process speaks (`omp.lock`; the handshake enforces it). */
  readonly contractVersion: string;
  /** The pinned OMP release, for the "needs a newer OMP" message. */
  readonly ompVersion: string;
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  /** Test seam: shorter deadlines. */
  readonly timeoutsMs?: Partial<OmpThreadMenuTimeouts>;
}

export const makeOmpThreadMenuController = (
  input: OmpThreadMenuControllerInput,
): ProviderOmpThreadMenuController => {
  const { control, sessions, fileSystem, path } = input;
  const collabSupported = contractAtLeast(input.contractVersion, OMP_COLLAB_CONTRACT);
  const target = input.target(input.globalCwd).pipe(Effect.mapError(controlFailed));
  const timeouts: OmpThreadMenuTimeouts = { ...OMP_THREAD_MENU_TIMEOUTS_MS, ...input.timeoutsMs };

  const running = (threadId: ThreadId) =>
    Effect.suspend(() => {
      const session = sessions.get(threadId);
      return session === undefined
        ? Effect.fail(
            fail(
              "not_running",
              "This thread's OMP session is not running. Send a message in the thread, then try again.",
            ),
          )
        : Effect.succeed(session);
    });

  /** The file the thread's session lives in: the running one's, else the one it last ran. */
  const sessionFile = Effect.fn("OmpThreadMenu.sessionFile")(
    function* (threadId: ThreadId) {
      const live = sessions.get(threadId);
      if (live !== undefined) {
        const state = yield* live.process
          .request("get_state", undefined, { timeoutMs: timeouts.state })
          .pipe(Effect.mapError(rpcFailed));
        if (state.sessionFile !== undefined) return state.sessionFile;
      }
      const record = yield* readOmpThreadSessionRecord(input.threadsDir, threadId);
      const file =
        record === null
          ? null
          : yield* findOmpSessionFile(
              input.sessionsLocation,
              record.sessionId,
              record.sessionFile ?? undefined,
            );
      if (file === null) {
        return yield* fail(
          "no_session",
          "This thread has no OMP session file yet; send a message in it first.",
        );
      }
      return file;
    },
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const exportHtml = Effect.fn("OmpThreadMenu.exportHtml")(
    function* (threadId: ThreadId) {
      const file = yield* sessionFile(threadId);
      yield* fileSystem.makeDirectory(input.exportsDir, { recursive: true, mode: 0o700 });
      const scratch = yield* fileSystem.makeTempDirectoryScoped({ directory: input.exportsDir });
      const outputPath = path.join(scratch, "session.html");
      const live = sessions.get(threadId);
      if (live === undefined) {
        yield* control
          .exportHtml(yield* target, { sessionFile: file, outputPath })
          .pipe(Effect.mapError(controlFailed));
      } else {
        yield* live.process
          .request(
            "export_html",
            { outputPath },
            {
              timeoutMs: timeouts.export,
            },
          )
          .pipe(Effect.mapError(rpcFailed));
      }
      const html = yield* fileSystem.readFileString(outputPath);
      return { fileName: `omp-session-${ompSessionFileId(file)}.html`, html };
    },
    Effect.scoped,
    Effect.catchTags({
      PlatformError: (error) => Effect.fail(fail("omp_failed", error.message)),
    }),
  );

  /**
   * `omp share <file> --gist` under an overlay that forces `share.serverUrl` to a host that never
   * resolves: a repo's own setting cannot pick the host, and when the gist fails OMP's fallback
   * upload to its share server fails too. The link is rebuilt on OMP's viewer.
   */
  const shareGist = Effect.fn("OmpThreadMenu.shareGist")(
    function* (threadId: ThreadId) {
      const resolved = yield* target;
      // Refusing here explains why; the overlay is what guarantees nothing else is uploaded.
      const gh = yield* control.gistReady(resolved);
      if (gh !== "ready") {
        return yield* fail(
          "gh_unavailable",
          gh === "missing"
            ? "Sharing as a gist needs the GitHub CLI (gh). Install it, run `gh auth login`, then try again. Nothing was uploaded."
            : "The GitHub CLI (gh) is not signed in. Run `gh auth login`, then try again. Nothing was uploaded.",
        );
      }
      const file = yield* sessionFile(threadId);
      yield* fileSystem.makeDirectory(input.exportsDir, { recursive: true, mode: 0o700 });
      const scratch = yield* fileSystem.makeTempDirectoryScoped({ directory: input.exportsDir });
      const overlay = path.join(scratch, "share-overlay.yml");
      yield* fileSystem.writeFileString(overlay, SHARE_OVERLAY, { mode: 0o600 });
      const report = yield* control
        .shareGist(
          { ...resolved, environment: { ...resolved.environment, PI_CONFIG_FILES: overlay } },
          file,
        )
        .pipe(
          Effect.mapError((error) =>
            error._tag === "OmpControlError" && error.reason === "exit"
              ? fail(
                  "omp_failed",
                  "OMP could not create the gist. Nothing was uploaded: Ompanel never lets OMP fall back to its share server.",
                )
              : controlFailed(error),
          ),
        );
      const prefix = `${OMP_SHARE_SERVER_BLOCKED}/`;
      const [gistId = "", key = ""] = report.url.startsWith(prefix)
        ? report.url.slice(prefix.length).split("#")
        : [];
      if (
        report.gistUrl === null ||
        gistId === "" ||
        key === "" ||
        !report.gistUrl.endsWith(`/${gistId}`)
      ) {
        return yield* fail("omp_failed", "OMP did not report the gist it created.");
      }
      return {
        url: `${OMP_SHARE_VIEWER_URL}/${gistId}#${key}`,
        gistUrl: report.gistUrl,
        truncated: report.truncated,
      };
    },
    Effect.scoped,
    Effect.catchTags({
      PlatformError: (error) => Effect.fail(fail("omp_failed", error.message)),
    }),
  );

  const needsNewerOmp = fail(
    "needs_newer_omp",
    `Share live needs OMP RPC contract ${OMP_COLLAB_CONTRACT} or later; this Ompanel runs OMP ${input.ompVersion} (contract ${input.contractVersion}). Update Ompanel to a build with a newer OMP.`,
  );

  /** The narrow cast `OmpCollabRequest` documents; the process accepts any command name. */
  const collabRequest = (session: OmpThreadSession): OmpCollabRequest =>
    session.process.request as unknown as OmpCollabRequest;

  const startCollab = Effect.fn("OmpThreadMenu.startCollab")(function* (request: {
    readonly threadId: ThreadId;
    readonly access: OmpCollabAccess;
  }) {
    if (!collabSupported) return yield* needsNewerOmp;
    const session = yield* running(request.threadId);
    const collab = collabRequest(session);
    // The links leave here in the result and nowhere else. A start that does not come back with
    // a room (timeout, a caller gone, a bad answer) is stopped, so no room stays open unseen.
    return yield* collab(
      "collab_start",
      { access: request.access },
      { timeoutMs: timeouts.collabStart, dropLateResponse: true },
    ).pipe(
      Effect.mapError(rpcFailed),
      Effect.flatMap((answer) =>
        decodeCollabStatus(answer).pipe(
          Effect.mapError(() =>
            fail("omp_failed", "OMP answered collab_start with an unknown shape."),
          ),
        ),
      ),
      Effect.onExit((exit) =>
        Exit.isSuccess(exit)
          ? Effect.void
          : collab("collab_stop", undefined, {
              timeoutMs: timeouts.collab,
              dropLateResponse: true,
            }).pipe(Effect.ignore),
      ),
    );
  });

  const stopCollab = Effect.fn("OmpThreadMenu.stopCollab")(function* (threadId: ThreadId) {
    const session = sessions.get(threadId);
    if (!collabSupported || session === undefined) return { stopped: false };
    const raw = yield* collabRequest(session)("collab_stop", undefined, {
      timeoutMs: timeouts.collab,
      dropLateResponse: true,
    }).pipe(Effect.mapError(rpcFailed));
    return yield* decodeCollabStop(raw).pipe(
      Effect.mapError(() => fail("omp_failed", "OMP answered collab_stop with an unknown shape.")),
    );
  });

  /** An older sidecar fails here too, so the Share live dialog says why before anyone clicks. */
  const collabStatus = Effect.fn("OmpThreadMenu.collabStatus")(function* (threadId: ThreadId) {
    if (!collabSupported) return yield* needsNewerOmp;
    const session = sessions.get(threadId);
    if (session === undefined) return NO_ROOM;
    const raw = yield* collabRequest(session)("collab_status", undefined, {
      timeoutMs: timeouts.collab,
      dropLateResponse: true,
    }).pipe(Effect.mapError(rpcFailed));
    return yield* decodeCollabStatus(raw).pipe(
      Effect.mapError(() =>
        fail("omp_failed", "OMP answered collab_status with an unknown shape."),
      ),
    );
  });

  const branchTree = Effect.fn("OmpThreadMenu.branchTree")(function* (threadId: ThreadId) {
    const session = yield* running(threadId);
    return yield* readOmpBranchTree(session.process, timeouts.tree).pipe(
      Effect.mapError(rpcFailed),
    );
  });

  return { exportHtml, shareGist, startCollab, stopCollab, collabStatus, branchTree };
};
