// @effect-diagnostics nodeBuiltinImport:off - replay checks are plain assertions.
/**
 * Replay testkit for OMP's `omp --mode rpc-ui` transport. The real process layer drives a
 * scenario against recorded stdout (chunks included) and must write exactly the recorded stdin;
 * `scripts/record-omp-rpc-replay-fixture.ts` records the transcripts from the pinned fork.
 */
import * as NodeAssert from "node:assert/strict";

import {
  ProviderReplayEntry,
  type ProviderReplayEntry as ProviderReplayEntryType,
} from "@t3tools/contracts";
import {
  OMP_LOCK,
  type OmpRpcCommand,
  type OmpRpcParams,
  type OmpRpcProcess,
  type OmpRpcRequestError,
  type OmpRpcResult,
  type RpcServerFrame,
  makeOmpPidfiles,
  startOmpRpcProcess,
} from "@t3tools/provider-omp/rpc";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as PlatformError from "effect/PlatformError";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const OMP_PROVIDER = "omp";
export const OMP_RPC_REPLAY_PROTOCOL = "omp.rpc-ui-jsonl";
/** Outbound pseudo-frames: the spawn itself, and the host closing stdin. */
const PROCESS_START = "process_start";
const STDIN_CLOSE = "stdin_close";
const CHUNK_PAYLOAD_BYTES = 256 * 1024;

export const OmpRpcReplayTranscript = Schema.Struct({
  provider: Schema.Literal(OMP_PROVIDER),
  protocol: Schema.Literal(OMP_RPC_REPLAY_PROTOCOL),
  version: Schema.String,
  scenario: Schema.String,
  metadata: Schema.Struct({
    generatedBy: Schema.String,
    ompTag: Schema.String,
    contractVersion: Schema.String,
    command: Schema.String,
    launchArgs: Schema.Array(Schema.String),
  }),
  entries: Schema.Array(ProviderReplayEntry),
});
export type OmpRpcReplayTranscript = typeof OmpRpcReplayTranscript.Type;
export const decodeOmpRpcReplayTranscript = Schema.decodeUnknownEffect(OmpRpcReplayTranscript);

export class OmpReplayMismatchError extends Schema.TaggedError<OmpReplayMismatchError>()(
  "OmpReplayMismatchError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    label: Schema.optional(Schema.String),
    expected: Schema.Unknown,
    actual: Schema.Unknown,
  },
) {
  override get message(): string {
    return `OMP replay: the host wrote an unexpected frame at cursor ${this.cursor} (expected ${this.label ?? "<none>"}) in scenario ${this.scenario}.`;
  }
}

export class OmpReplayIncompleteError extends Schema.TaggedError<OmpReplayIncompleteError>()(
  "OmpReplayIncompleteError",
  {
    scenario: Schema.String,
    cursor: Schema.Number,
    remaining: Schema.Number,
    nextLabel: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `OMP replay ended with ${this.remaining} unconsumed entries at cursor ${this.cursor} (next ${this.nextLabel ?? "<none>"}) in scenario ${this.scenario}.`;
  }
}

export class OmpScenarioTimeoutError extends Schema.TaggedError<OmpScenarioTimeoutError>()(
  "OmpScenarioTimeoutError",
  { scenario: Schema.String, waitingFor: Schema.String },
) {
  override get message(): string {
    return `OMP scenario ${this.scenario} timed out waiting for ${this.waitingFor}.`;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep equality; request ids are deterministic (`ompanel-<n>`), so frames match exactly. */
function replayValueMatches(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((entry, index) => replayValueMatches(entry, actual[index]))
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    return [...keys].every((key) => replayValueMatches(expected[key], actual[key]));
  }
  return Object.is(expected, actual);
}

function entryLabel(entry: ProviderReplayEntryType | undefined): string | undefined {
  if (entry === undefined) return undefined;
  return entry.type === "runtime_exit" ? "runtime_exit" : (entry.label ?? entry.type);
}

function frameLabel(frame: unknown): string | undefined {
  if (!isRecord(frame)) return undefined;
  if (frame.type === "response" && typeof frame.command === "string") {
    return `response:${frame.command}`;
  }
  return typeof frame.type === "string" ? frame.type : undefined;
}

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encoder = new TextEncoder();

function makeLineSplitter() {
  let buffer = "";
  const decoder = new TextDecoder();
  return (chunk: Uint8Array): ReadonlyArray<string> => {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    return lines.filter((line) => line.length > 0);
  };
}

/** The command's stdin stream; the process layer always passes one. */
function commandStdin(
  command: ChildProcess.Command,
): Stream.Stream<Uint8Array, PlatformError.PlatformError> {
  if (!ChildProcess.isStandardCommand(command)) return Stream.empty;
  const stdin = command.options.stdin;
  const input = typeof stdin === "object" && "stream" in stdin ? stdin.stream : stdin;
  return typeof input === "object" ? input : Stream.empty;
}

/** Plays one transcript back: strict outbound order, every inbound frame up to the next write. */
class OmpReplayController {
  private cursor = 0;
  private failure: unknown = null;
  private readonly transcript: OmpRpcReplayTranscript;
  private stdout: Queue.Queue<Uint8Array, Cause.Done> | undefined;
  private exit: Deferred.Deferred<number> | undefined;

  constructor(transcript: OmpRpcReplayTranscript) {
    this.transcript = transcript;
  }

  start(stdout: Queue.Queue<Uint8Array, Cause.Done>, exit: Deferred.Deferred<number>) {
    this.stdout = stdout;
    this.exit = exit;
  }

  receive(actual: unknown): void {
    if (this.failure !== null) return;
    const expected = this.transcript.entries[this.cursor];
    if (expected?.type !== "expect_outbound" || !replayValueMatches(expected.frame, actual)) {
      const label = entryLabel(expected);
      this.fail(
        new OmpReplayMismatchError({
          scenario: this.transcript.scenario,
          cursor: this.cursor,
          ...(label === undefined ? {} : { label }),
          expected: expected ?? null,
          actual,
        }),
      );
      return;
    }
    this.cursor += 1;
    this.drainInbound();
  }

  /** The host killed the process: stdout ends, and the exit is a signal's. */
  kill(): void {
    this.endStdout();
    if (this.exit !== undefined) Deferred.doneUnsafe(this.exit, Effect.succeed(143));
  }

  assertComplete(): void {
    if (this.failure !== null) throw this.failure;
    const remaining = this.transcript.entries.length - this.cursor;
    if (remaining > 0) {
      const nextLabel = entryLabel(this.transcript.entries[this.cursor]);
      throw new OmpReplayIncompleteError({
        scenario: this.transcript.scenario,
        cursor: this.cursor,
        remaining,
        ...(nextLabel === undefined ? {} : { nextLabel }),
      });
    }
  }

  private drainInbound(): void {
    while (this.failure === null) {
      const entry = this.transcript.entries[this.cursor];
      if (entry?.type === "emit_inbound") {
        this.cursor += 1;
        if (this.stdout !== undefined) {
          Queue.offerUnsafe(this.stdout, encoder.encode(`${encodeJsonLine(entry.frame)}\n`));
        }
        continue;
      }
      if (entry?.type === "runtime_exit") {
        this.cursor += 1;
        this.endStdout();
        if (this.exit !== undefined) {
          Deferred.doneUnsafe(this.exit, Effect.succeed(entry.status === "success" ? 0 : 1));
        }
      }
      return;
    }
  }

  private endStdout(): void {
    if (this.stdout !== undefined) Queue.endUnsafe(this.stdout);
  }

  private fail(cause: unknown): void {
    if (this.failure !== null) return;
    this.failure = cause;
    this.endStdout();
  }
}

/** Deliberately outside the valid pid range, so a process-group kill never lands anywhere. */
const REPLAY_PID = 999_999_999;

function makeOmpReplaySpawner(
  controller: OmpReplayController,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exit = yield* Deferred.make<number>();
      controller.start(stdout, exit);
      controller.receive({
        type: PROCESS_START,
        args: ChildProcess.isStandardCommand(command) ? [...command.args] : [],
      });
      const split = makeLineSplitter();
      yield* commandStdin(command).pipe(
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            for (const line of split(chunk)) controller.receive(decodeJsonLine(line));
          }),
        ),
        Effect.andThen(Effect.sync(() => controller.receive({ type: STDIN_CLOSE }))),
        Effect.forkScoped,
      );
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(REPLAY_PID),
        exitCode: Deferred.await(exit).pipe(Effect.map(ChildProcessSpawner.ExitCode)),
        isRunning: Deferred.isDone(exit).pipe(Effect.map((done) => !done)),
        kill: () => Effect.sync(() => controller.kill()),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
}

/**
 * Wraps a live spawner and records the process: its arguments, every stdin line, every stdout
 * line (raw, so `rpc_chunk` sequences stay chunked), the stdin close and the exit.
 */
export function makeOmpRecordingSpawner(
  live: ChildProcessSpawner.ChildProcessSpawner["Service"],
  entries: Array<ProviderReplayEntryType>,
): ChildProcessSpawner.ChildProcessSpawner["Service"] {
  const record = (type: "expect_outbound" | "emit_inbound", frame: unknown) => {
    const label = frameLabel(frame);
    entries.push({ type, ...(label === undefined ? {} : { label }), frame });
  };
  return ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* live.spawn(command);
      }
      record("expect_outbound", { type: PROCESS_START, args: [...command.args] });
      const splitIn = makeLineSplitter();
      const stdin = command.options.stdin;
      const stdinConfig = typeof stdin === "object" && "stream" in stdin ? stdin : {};
      const tapped = commandStdin(command).pipe(
        Stream.tap((chunk) =>
          Effect.sync(() => {
            for (const line of splitIn(chunk)) record("expect_outbound", decodeJsonLine(line));
          }),
        ),
        Stream.onEnd(Effect.sync(() => record("expect_outbound", { type: STDIN_CLOSE }))),
      );
      const handle = yield* live.spawn(
        ChildProcess.make(command.command, [...command.args], {
          ...command.options,
          stdin: { ...stdinConfig, stream: tapped },
        }),
      );
      const splitOut = makeLineSplitter();
      return ChildProcessSpawner.makeHandle({
        ...handle,
        exitCode: handle.exitCode.pipe(
          Effect.tap((code) =>
            Effect.sync(() =>
              entries.push({ type: "runtime_exit", status: code === 0 ? "success" : "error" }),
            ),
          ),
        ),
        stdout: handle.stdout.pipe(
          Stream.tap((chunk) =>
            Effect.sync(() => {
              for (const line of splitOut(chunk)) {
                // Non-JSON stdout breaks OMP's framing; record it verbatim so replay fails too.
                try {
                  record("emit_inbound", decodeJsonLine(line));
                } catch {
                  record("emit_inbound", line);
                }
              }
            }),
          ),
        ),
      });
    }),
  );
}

function replaceAll(
  value: unknown,
  replacements: ReadonlyArray<readonly [string, string]>,
): unknown {
  if (typeof value === "string") {
    return replacements.reduce((text, [from, to]) => text.split(from).join(to), value);
  }
  if (Array.isArray(value)) return value.map((item) => replaceAll(item, replacements));
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceAll(item, replacements)]),
    );
  }
  return value;
}

/**
 * Replaces machine-specific strings (temp dirs, home) in every frame. `rpc_chunk` sequences are
 * decoded, normalized as one frame and chunked again, so chunking stays under test. The exit goes
 * last: OMP exits after its final write, but the exit can be observed before stdout is drained.
 */
export function normalizeOmpEntries(
  entries: ReadonlyArray<ProviderReplayEntryType>,
  replacements: ReadonlyArray<readonly [string, string]>,
): ReadonlyArray<ProviderReplayEntryType> {
  const out: Array<ProviderReplayEntryType> = [];
  const pending = new Map<string, Array<string>>();
  const exits: Array<ProviderReplayEntryType> = [];
  for (const entry of entries) {
    if (entry.type === "runtime_exit") {
      exits.push(entry);
      continue;
    }
    if (
      entry.type !== "emit_inbound" ||
      !isRecord(entry.frame) ||
      entry.frame.type !== "rpc_chunk"
    ) {
      out.push({ ...entry, frame: replaceAll(entry.frame, replacements) });
      continue;
    }
    const { chunkId, index, count, data } = entry.frame;
    if (typeof chunkId !== "string" || typeof data !== "string") continue;
    const parts = pending.get(chunkId) ?? [];
    parts.push(data);
    pending.set(chunkId, parts);
    if (index !== Number(count) - 1) continue;
    pending.delete(chunkId);
    const json = Buffer.concat(parts.map((part) => Buffer.from(part, "base64"))).toString("utf8");
    const bytes = Buffer.from(encodeJsonLine(replaceAll(decodeJsonLine(json), replacements)));
    const chunks = Math.ceil(bytes.byteLength / CHUNK_PAYLOAD_BYTES);
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      out.push({
        type: "emit_inbound",
        label: "rpc_chunk",
        frame: {
          type: "rpc_chunk",
          chunkId,
          index: chunk,
          count: chunks,
          byteLength: bytes.byteLength,
          data: bytes
            .subarray(chunk * CHUNK_PAYLOAD_BYTES, (chunk + 1) * CHUNK_PAYLOAD_BYTES)
            .toString("base64"),
        },
      });
    }
  }
  return [...out, ...exits];
}

export function encodeOmpTranscriptNdjson(transcript: OmpRpcReplayTranscript): string {
  const { entries, ...header } = transcript;
  return [
    encodeJsonLine({ type: "transcript_start", ...header }),
    ...entries.map((entry) => encodeJsonLine(entry)),
    "",
  ].join("\n");
}

/** A running thread process plus every frame it has produced so far. */
export interface OmpScenarioSession {
  readonly frames: ReadonlyArray<RpcServerFrame>;
  readonly request: <K extends OmpRpcCommand>(
    command: K,
    params: OmpRpcParams<K>,
  ) => Effect.Effect<OmpRpcResult<K>, OmpRpcRequestError>;
  /** Waits for the first frame from index `from` on that satisfies `match`. */
  readonly waitFor: (
    waitingFor: string,
    match: (frame: RpcServerFrame) => boolean,
    from?: number,
  ) => Effect.Effect<RpcServerFrame, OmpScenarioTimeoutError>;
  /**
   * Sends `prompt` and waits for its completion: the ack for synchronous builtins, else its
   * `prompt_result`. Returns the frame index it started from; frames of a builtin can still be in
   * flight when the ack lands, so read them with `waitFor(…, from)`.
   */
  readonly prompt: (
    message: string,
  ) => Effect.Effect<{ readonly agentInvoked: boolean; readonly from: number }, OmpScenarioError>;
}

export type OmpScenarioError = OmpRpcRequestError | OmpScenarioTimeoutError;
export interface OmpReplayScenario {
  readonly name: string;
  readonly description: string;
  /** Drives the session and asserts what it saw; runs live when recording and on every replay. */
  readonly run: (session: OmpScenarioSession) => Effect.Effect<void, OmpScenarioError>;
}

const WAIT_TIMEOUT_MS = 60_000;

const makeScenarioSession = (scenario: string, omp: OmpRpcProcess) =>
  Effect.gen(function* () {
    const frames: Array<RpcServerFrame> = [];
    yield* omp.frames.pipe(
      Stream.runForEach((frame) => Effect.sync(() => frames.push(frame))),
      Effect.ignore,
      Effect.forkScoped,
    );
    const waitFor: OmpScenarioSession["waitFor"] = (waitingFor, match, from = 0) =>
      Effect.gen(function* () {
        for (let waited = 0; waited < WAIT_TIMEOUT_MS; waited += 10) {
          const found = frames.slice(from).find(match);
          if (found !== undefined) return found;
          yield* Effect.sleep("10 millis");
        }
        return yield* new OmpScenarioTimeoutError({ scenario, waitingFor });
      });
    const request: OmpScenarioSession["request"] = (command, params) =>
      omp.request(command, params, { timeoutMs: WAIT_TIMEOUT_MS });
    return {
      frames,
      request,
      waitFor,
      prompt: (message) =>
        Effect.gen(function* () {
          const from = frames.length;
          const ack = yield* request("prompt", { message });
          // OMP omits `data` on the ack of a prompt that starts a turn.
          const agentInvoked = ack?.agentInvoked !== false;
          if (agentInvoked) {
            yield* waitFor(
              `prompt_result of ${message}`,
              (frame) => frame.type === "prompt_result",
              from,
            );
          }
          return { agentInvoked, from };
        }),
    } satisfies OmpScenarioSession;
  });

export interface OmpScenarioLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly pidfilesDir: string;
}

/**
 * Starts the thread process through `spawner`, runs the scenario, then closes stdin and waits
 * for OMP to exit on its own, as stopping a thread does.
 */
export const runOmpScenario = Effect.fn("OmpReplay.runScenario")(function* (
  scenario: OmpReplayScenario,
  launch: OmpScenarioLaunch,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) {
  const pidfiles = yield* makeOmpPidfiles({ dir: launch.pidfilesDir, platform: launch.platform });
  const omp = yield* startOmpRpcProcess({
    command: launch.command,
    args: launch.args,
    cwd: launch.cwd,
    env: launch.env,
    platform: launch.platform,
    expectedContractVersion: OMP_LOCK.contract.version,
    pidfiles,
    threadId: `replay-${scenario.name}`,
    readyTimeoutMs: WAIT_TIMEOUT_MS,
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  const session = yield* makeScenarioSession(scenario.name, omp);
  yield* scenario.run(session);
  const exit = yield* omp.close();
  return { frames: [...session.frames], exit };
});

/** Replays a recorded transcript through the real process layer, running the scenario on it. */
export const replayOmpScenario = Effect.fn("OmpReplay.replayScenario")(function* (
  scenario: OmpReplayScenario,
  transcript: OmpRpcReplayTranscript,
  launch: Pick<OmpScenarioLaunch, "platform" | "pidfilesDir">,
) {
  const controller = new OmpReplayController(transcript);
  const run = yield* runOmpScenario(
    scenario,
    {
      ...launch,
      command: transcript.metadata.command,
      args: transcript.metadata.launchArgs,
      cwd: "/",
      env: {},
    },
    makeOmpReplaySpawner(controller),
  ).pipe(Effect.scoped, Effect.exit);
  // A mismatch ends the replayed stdout, so the scenario then fails on a closed transport;
  // report the mismatch, which names the frame.
  controller.assertComplete();
  const result = yield* run;
  NodeAssert.ok(result.exit.graceful, "omp did not exit on its own after stdin closed");
  return result;
});
