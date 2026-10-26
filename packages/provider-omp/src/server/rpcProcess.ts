/**
 * One `omp --mode rpc-ui` child: spawn, `ready` → contract check → `negotiate_protocol` v2,
 * then a typed frame stream and command API. Frame meaning (thread events) is not decided here.
 */
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type {
  ReadyEvent,
  RpcInbound,
  RpcResponse,
  RpcServerFrame,
  RpcWireCommands,
} from "../../contract/src/wire.generated.ts";
import type { OmpPidfiles } from "./pidfiles.ts";
import { OMP_TREE_KILL_GRACE } from "./processTree.ts";
import {
  makeOmpLineSplitter,
  OMP_MAX_FRAME_BYTES,
  OMP_MAX_REASSEMBLED_BYTES,
  OmpChunkReassembler,
  OmpFramingError,
  parseOmpFrameLine,
} from "./rpcFrames.ts";

/** OMP loads extensions, MCP servers and the session before `ready`. */
const OMP_READY_TIMEOUT_MS = 30_000;
const OMP_REQUEST_TIMEOUT_MS = 30_000;
/** How long a stdin close may take to drain accepted work before the tree is killed. */
const OMP_GRACEFUL_EXIT_TIMEOUT_MS = 10_000;
/** Protocol version Ompanel speaks: 1 MiB frames plus `rpc_chunk` reassembly. */
const OMP_PROTOCOL_VERSION = 2;
/** After `omp` exits, how long its stdout may stay open (held by a descendant) before giving up. */
const STDOUT_DRAIN_AFTER_EXIT = Duration.millis(500);

export type OmpRpcFailureReason =
  /** The process could not be started. */
  | "spawn"
  /** No `ready` frame arrived in time, or the first frame was something else. */
  | "ready"
  /** The sidecar cannot speak protocol v2 or refused the negotiation. */
  | "negotiate"
  /** Stdout broke the framing rules (oversized line, bad JSON, bad `rpc_chunk`). */
  | "protocol"
  /** Stdin could not be written. */
  | "write"
  /** The process exited or was stopped. */
  | "closed";

export class OmpRpcError extends Schema.TaggedError<OmpRpcError>()("OmpRpcError", {
  reason: Schema.Literals(["spawn", "ready", "negotiate", "protocol", "write", "closed"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `OMP RPC ${this.reason} failed: ${this.detail}.`;
  }
}

/** The sidecar speaks a different RPC contract than `omp.lock` pins; Ompanel refuses to drive it. */
export class OmpContractMismatchError extends Schema.TaggedError<OmpContractMismatchError>()(
  "OmpContractMismatchError",
  {
    expected: Schema.String,
    actual: Schema.NullOr(Schema.String),
    stage: Schema.Literals(["ready", "negotiate_protocol"]),
  },
) {
  override get message(): string {
    return this.actual === null
      ? `This OMP does not report an RPC contract version; Ompanel needs contract ${this.expected}.`
      : `This OMP speaks RPC contract ${this.actual}; Ompanel needs contract ${this.expected}.`;
  }
}

/** OMP answered a command with `success: false`. */
export class OmpRpcCommandError extends Schema.TaggedError<OmpRpcCommandError>()(
  "OmpRpcCommandError",
  {
    command: Schema.String,
    detail: Schema.String,
    code: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `OMP command ${this.command} failed: ${this.detail}`;
  }
}

export class OmpRpcTimeoutError extends Schema.TaggedError<OmpRpcTimeoutError>()(
  "OmpRpcTimeoutError",
  {
    command: Schema.String,
    timeoutMs: Schema.Int,
  },
) {
  override get message(): string {
    return `OMP command ${this.command} got no response within ${this.timeoutMs} ms.`;
  }
}

export type OmpRpcStartError = OmpRpcError | OmpContractMismatchError;
export type OmpRpcRequestError = OmpRpcError | OmpRpcCommandError | OmpRpcTimeoutError;

export type OmpRpcCommand = keyof RpcWireCommands;
export type OmpRpcParams<K extends OmpRpcCommand> = RpcWireCommands[K]["params"];
export type OmpRpcResult<K extends OmpRpcCommand> = RpcWireCommands[K]["result"];

export interface OmpRpcRequestOptions {
  /** `null` waits for as long as the process lives (e.g. `compact`). */
  readonly timeoutMs?: number | null;
}

export interface OmpRpcExit {
  /** `null` when the process ended by signal. */
  readonly code: number | null;
  /** True when it exited on its own after stdin closed, without being killed. */
  readonly graceful: boolean;
}

export interface OmpRpcProcess {
  readonly pid: number;
  /** The `ready` frame the sidecar opened with. */
  readonly ready: ReadyEvent;
  readonly contractVersion: string;
  /**
   * Every frame except responses to `request`, in order, with `rpc_chunk` sequences already
   * reassembled. Typed as the pinned contract's union; consumers must tolerate unknown `type`s.
   * Single consumer. Ends when the process stops; fails when it breaks the protocol or exits
   * unexpectedly.
   */
  readonly frames: Stream.Stream<RpcServerFrame, OmpRpcError>;
  /** Sends a command and waits for its correlated `response`. */
  readonly request: <K extends OmpRpcCommand>(
    command: K,
    params: OmpRpcParams<K>,
    options?: OmpRpcRequestOptions,
  ) => Effect.Effect<OmpRpcResult<K>, OmpRpcRequestError>;
  /** Writes an inbound frame that has no response: UI answers, host tool and URI results. */
  readonly send: (frame: RpcInbound) => Effect.Effect<void, OmpRpcError>;
  /**
   * Closes stdin so OMP drains accepted work and exits 0; kills the tree if it has not exited
   * within `timeoutMs`. Descendants still running after a graceful exit are killed too.
   */
  readonly close: (timeoutMs?: number) => Effect.Effect<OmpRpcExit>;
  /** Kills the whole process tree now. */
  readonly kill: Effect.Effect<void>;
  /** Exit code once the process has exited (`null` on signal). */
  readonly exited: Effect.Effect<number | null>;
}

export interface OmpRpcSpawnOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  /** `contract.version` from `omp.lock`. */
  readonly expectedContractVersion: string;
  readonly pidfiles: OmpPidfiles;
  /** Recorded in the pidfile. */
  readonly threadId: string;
  readonly readyTimeoutMs?: number;
}

interface PendingRequest {
  readonly command: string;
  readonly deferred: Deferred.Deferred<unknown, OmpRpcError | OmpRpcCommandError>;
}

const encoder = new TextEncoder();
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const isOmpRpcError = Schema.is(OmpRpcError);

const describeExit = (code: number | null) =>
  code === null ? "omp was stopped by a signal" : `omp exited with code ${code}`;

/**
 * Starts `omp` in the current scope and completes the handshake. Closing the scope kills the
 * process tree. Fails, with the tree already killed, when the handshake does not complete.
 */
export const startOmpRpcProcess = Effect.fn("startOmpRpcProcess")(function* (
  options: OmpRpcSpawnOptions,
): Effect.fn.Return<
  OmpRpcProcess,
  OmpRpcStartError,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const outgoing = yield* Queue.unbounded<Uint8Array, Cause.Done>();
  const child = yield* spawner
    .spawn(
      ChildProcess.make(options.command, [...options.args], {
        cwd: options.cwd,
        env: options.env,
        extendEnv: false,
        // POSIX: own process group, so the tree can be signalled as one.
        detached: options.platform !== "win32",
        killSignal: "SIGTERM",
        forceKillAfter: OMP_TREE_KILL_GRACE,
        stdin: { stream: Stream.fromQueue(outgoing), endOnDone: true },
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => new OmpRpcError({ reason: "spawn", detail: "omp could not be started", cause }),
      ),
    );
  const pid = Number(child.pid);

  const exitDeferred = yield* Deferred.make<number | null>();
  let killed = false;
  const killTree = Effect.suspend(() => {
    killed = true;
    return child.kill({ killSignal: "SIGTERM", forceKillAfter: OMP_TREE_KILL_GRACE });
  }).pipe(Effect.ignore, Effect.uninterruptible);

  // The spawner's own release would also signal the group; this one runs first, and the pidfile
  // goes only once the tree is gone.
  yield* Scope.addFinalizer(scope, killTree.pipe(Effect.andThen(options.pidfiles.release(pid))));
  yield* options.pidfiles.register({ pid, threadId: options.threadId }).pipe(
    Effect.mapError(
      (cause) =>
        new OmpRpcError({
          reason: "spawn",
          detail: "omp could not be recorded for cleanup",
          cause,
        }),
    ),
  );

  const frames = yield* Queue.unbounded<RpcServerFrame, OmpRpcError | Cause.Done>();
  const pending = new Map<string, PendingRequest>();
  const ready = yield* Deferred.make<ReadyEvent, OmpRpcError>();
  const transportDown = yield* Deferred.make<never, OmpRpcError>();
  let protocolV2 = false;
  let sawFirstFrame = false;
  let closing = false;
  let nextRequestId = 0;

  /** Ends the frame stream (cleanly, or with `error`) and fails everything still waiting. */
  const shutdownTransport = Effect.fnUntraced(function* (error: OmpRpcError, clean: boolean) {
    if (!(yield* Deferred.fail(transportDown, error))) return;
    yield* Deferred.fail(ready, error);
    for (const [id, request] of pending) {
      pending.delete(id);
      yield* Deferred.fail(request.deferred, error);
    }
    yield* Queue.end(outgoing);
    if (clean) yield* Queue.end(frames);
    else yield* Queue.fail(frames, error);
  });

  const route = Effect.fnUntraced(function* (frame: Record<string, unknown>) {
    if (!sawFirstFrame) {
      sawFirstFrame = true;
      if (frame["type"] !== "ready") {
        return yield* new OmpRpcError({
          reason: "ready",
          detail: `the first frame was \`${String(frame["type"])}\`, not \`ready\``,
        });
      }
      yield* Deferred.succeed(ready, frame as unknown as ReadyEvent);
      return;
    }
    if (frame["type"] === "response" && typeof frame["id"] === "string") {
      const response = frame as unknown as RpcResponse;
      const request = pending.get(response.id ?? "");
      if (request !== undefined) {
        pending.delete(response.id ?? "");
        if (response.success) {
          // OMP switches its encoder to v2 right after writing this response.
          if (response.command === "negotiate_protocol") protocolV2 = true;
          yield* Deferred.succeed(request.deferred, response.data);
        } else {
          yield* Deferred.fail(
            request.deferred,
            new OmpRpcCommandError({
              command: request.command,
              detail: response.error ?? "no error message",
              ...(response.code === undefined ? {} : { code: response.code }),
            }),
          );
        }
        return;
      }
    }
    yield* Queue.offer(frames, frame as unknown as RpcServerFrame);
  });

  const reassembler = new OmpChunkReassembler();
  const splitter = makeOmpLineSplitter(OMP_MAX_FRAME_BYTES);
  const handleLine = Effect.fnUntraced(function* (line: Uint8Array) {
    const frame = yield* Effect.try({
      try: () => {
        const parsed = parseOmpFrameLine(line);
        if (parsed["type"] === "rpc_chunk" && !protocolV2) {
          throw new OmpFramingError("chunk", "rpc_chunk arrived before protocol v2 was negotiated");
        }
        return reassembler.push(parsed);
      },
      catch: (cause) =>
        new OmpRpcError({
          reason: "protocol",
          detail: cause instanceof Error ? cause.message : "unreadable frame",
          cause,
        }),
    });
    if (frame !== undefined) yield* route(frame);
  });

  // Exit first, so a crash during startup is reported with its exit code.
  yield* child.exitCode.pipe(
    Effect.map((code): number | null => Number(code)),
    Effect.orElseSucceed((): number | null => null),
    Effect.flatMap((code) => Deferred.succeed(exitDeferred, code)),
    Effect.andThen(Effect.sleep(STDOUT_DRAIN_AFTER_EXIT)),
    Effect.andThen(
      Effect.suspend(() =>
        Deferred.await(exitDeferred).pipe(
          Effect.flatMap((code) =>
            shutdownTransport(
              new OmpRpcError({ reason: "closed", detail: describeExit(code) }),
              closing || killed,
            ),
          ),
        ),
      ),
    ),
    Effect.forkIn(scope),
  );

  yield* child.stdout.pipe(
    Stream.runForEach((chunk) =>
      Effect.try({
        try: () => splitter.push(chunk),
        catch: (cause) =>
          new OmpRpcError({
            reason: "protocol",
            detail: cause instanceof Error ? cause.message : "unreadable output",
            cause,
          }),
      }).pipe(Effect.flatMap((lines) => Effect.forEach(lines, handleLine, { discard: true }))),
    ),
    Effect.andThen(
      Effect.suspend(() => {
        const tail = splitter.flush();
        return tail === undefined ? Effect.void : handleLine(tail);
      }),
    ),
    Effect.matchCauseEffect({
      onFailure: (cause) => {
        const error = Cause.squash(cause);
        return shutdownTransport(
          isOmpRpcError(error)
            ? error
            : new OmpRpcError({ reason: "closed", detail: "omp stdout failed", cause: error }),
          false,
        ).pipe(Effect.andThen(killTree));
      },
      onSuccess: () =>
        Deferred.await(exitDeferred).pipe(
          Effect.timeoutOption(STDOUT_DRAIN_AFTER_EXIT),
          Effect.flatMap((code) =>
            shutdownTransport(
              new OmpRpcError({
                reason: "closed",
                detail: Option.match(code, {
                  onNone: () => "omp closed stdout",
                  onSome: describeExit,
                }),
              }),
              closing || killed,
            ),
          ),
        ),
    }),
    Effect.forkIn(scope),
  );

  // Stderr can hold prompts or credentials: count it, never log it.
  yield* child.stderr.pipe(
    Stream.runForEach((chunk) => Effect.logDebug("omp stderr", { bytes: chunk.byteLength })),
    Effect.ignore,
    Effect.forkIn(scope),
  );

  const write = Effect.fnUntraced(function* (record: object) {
    const accepted = yield* Queue.offer(outgoing, encoder.encode(`${encodeJsonLine(record)}\n`));
    // Stdin is closed once the process is stopping or gone.
    if (!accepted) {
      return yield* new OmpRpcError({ reason: "write", detail: "omp stdin is closed" });
    }
  });

  const request = Effect.fn("OmpRpcProcess.request")(function* <K extends OmpRpcCommand>(
    command: K,
    params: OmpRpcParams<K>,
    requestOptions?: OmpRpcRequestOptions,
  ): Effect.fn.Return<OmpRpcResult<K>, OmpRpcRequestError> {
    yield* Effect.annotateCurrentSpan({ command });
    const id = `ompanel-${nextRequestId++}`;
    const deferred = yield* Deferred.make<unknown, OmpRpcError | OmpRpcCommandError>();
    pending.set(id, { command, deferred });
    const forget = Effect.sync(() => pending.delete(id));
    yield* write({ ...params, id, type: command }).pipe(Effect.tapError(() => forget));
    const timeoutMs =
      requestOptions?.timeoutMs === undefined ? OMP_REQUEST_TIMEOUT_MS : requestOptions.timeoutMs;
    const response = Effect.raceFirst(Deferred.await(deferred), Deferred.await(transportDown));
    const data = yield* (
      timeoutMs === null
        ? response
        : response.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(timeoutMs),
              orElse: () => Effect.fail(new OmpRpcTimeoutError({ command, timeoutMs })),
            }),
          )
    ).pipe(Effect.ensuring(forget));
    return data as OmpRpcResult<K>;
  });

  const exited = Deferred.await(exitDeferred);

  const close = Effect.fn("OmpRpcProcess.close")(function* (
    timeoutMs: number = OMP_GRACEFUL_EXIT_TIMEOUT_MS,
  ) {
    closing = true;
    yield* Queue.end(outgoing);
    const code = yield* exited.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)));
    const graceful = Option.isSome(code) && !killed;
    // After a graceful exit this only reaches descendants still holding the group.
    yield* killTree;
    return {
      code: Option.isSome(code) ? code.value : yield* exited,
      graceful,
    } satisfies OmpRpcExit;
  });

  const handshake = Effect.gen(function* () {
    const readyTimeoutMs = options.readyTimeoutMs ?? OMP_READY_TIMEOUT_MS;
    const readyFrame = yield* Effect.raceFirst(
      Deferred.await(ready),
      Deferred.await(transportDown),
    ).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(readyTimeoutMs),
        orElse: () =>
          Effect.fail(
            new OmpRpcError({
              reason: "ready",
              detail: `no \`ready\` frame within ${readyTimeoutMs} ms`,
            }),
          ),
      }),
    );
    if (
      !readyFrame.supportedProtocolVersions?.includes(OMP_PROTOCOL_VERSION) ||
      readyFrame.maxFrameBytes !== OMP_MAX_FRAME_BYTES ||
      readyFrame.maxReassembledFrameBytes !== OMP_MAX_REASSEMBLED_BYTES
    ) {
      return yield* new OmpRpcError({
        reason: "negotiate",
        detail: "this OMP does not offer protocol v2 with 1 MiB frames and 64 MiB reassembly",
      });
    }
    const expected = options.expectedContractVersion;
    if (readyFrame.contractVersion !== expected) {
      return yield* new OmpContractMismatchError({
        expected,
        actual: readyFrame.contractVersion ?? null,
        stage: "ready",
      });
    }
    const negotiated = yield* request("negotiate_protocol", {
      protocolVersion: OMP_PROTOCOL_VERSION,
    }).pipe(
      Effect.catchTags({
        OmpRpcCommandError: (error) =>
          Effect.fail(new OmpRpcError({ reason: "negotiate", detail: error.detail })),
        OmpRpcTimeoutError: (error) =>
          Effect.fail(new OmpRpcError({ reason: "negotiate", detail: error.message })),
      }),
    );
    if (negotiated.protocolVersion !== OMP_PROTOCOL_VERSION) {
      return yield* new OmpRpcError({
        reason: "negotiate",
        detail: `OMP negotiated protocol ${negotiated.protocolVersion}`,
      });
    }
    if (negotiated.contractVersion !== expected) {
      return yield* new OmpContractMismatchError({
        expected,
        actual: negotiated.contractVersion ?? null,
        stage: "negotiate_protocol",
      });
    }
    return readyFrame;
  });

  // A sidecar that fails the handshake never runs on: kill it before reporting.
  const readyFrame = yield* handshake.pipe(Effect.tapError(() => killTree));

  return {
    pid,
    ready: readyFrame,
    contractVersion: options.expectedContractVersion,
    frames: Stream.fromQueue(frames),
    request,
    send: (frame) => write(frame),
    close,
    kill: killTree,
    exited,
  } satisfies OmpRpcProcess;
});
