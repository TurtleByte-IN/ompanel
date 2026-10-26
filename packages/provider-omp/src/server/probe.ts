import {
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { ReadyEvent } from "../../contract/src/wire.generated.ts";

export const OMP_VERSION_TIMEOUT_MS = 4_000;
export const OMP_READY_TIMEOUT_MS = 10_000;
export const OMP_PROBE_CACHE_TTL_MS = 30_000;

/**
 * A status check must not open a session, start MCP servers, run hooks or log in: no session
 * file, no tools (which also disables MCP), no extensions, skills, rules, LSP or title model.
 */
export const OMP_PROBE_RPC_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-lsp",
  "--no-title",
] as const;

export interface OmpProbeInput {
  readonly binaryPath: string;
  readonly profile: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export type OmpProbeFailure =
  | { readonly stage: "version"; readonly reason: "missing" | "spawn" | "timeout" | "exit" }
  | { readonly stage: "ready"; readonly reason: "spawn" | "timeout" | "exit" | "invalid" };

export type OmpProbeResult =
  | {
      readonly status: "ready";
      readonly version: string | null;
      readonly ready: Pick<ReadyEvent, "protocolVersion" | "contractVersion">;
    }
  | ({ readonly status: "failed"; readonly version: string | null } & OmpProbeFailure);

const ReadyFrame = Schema.Struct({
  type: Schema.Literal("ready"),
  protocolVersion: Schema.optional(Schema.Number),
  contractVersion: Schema.optional(Schema.String),
});
const decodeReadyFrame = Schema.decodeEffect(Schema.fromJsonString(ReadyFrame));

const profileArgs = (profile: string): ReadonlyArray<string> =>
  profile === "" ? [] : ["--profile", profile];

const runVersion = Effect.fn("OmpProbe.runVersion")(function* (input: OmpProbeInput) {
  return yield* spawnAndCollect(
    input.binaryPath,
    ChildProcess.make(input.binaryPath, ["--version"], {
      env: input.environment,
      extendEnv: false,
    }),
  );
});

/** Starts `omp --mode rpc` and reads its first frame, which must be `ready`. */
const readReadyFrame = Effect.fn("OmpProbe.readReadyFrame")(
  function* (input: OmpProbeInput) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner
      .spawn(
        ChildProcess.make(
          input.binaryPath,
          [...profileArgs(input.profile), ...OMP_PROBE_RPC_ARGS],
          { cwd: input.cwd, env: input.environment, extendEnv: false },
        ),
      )
      .pipe(Effect.mapError(() => "spawn" as const));
    const firstLine = yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.filter((line) => line.trim().length > 0),
      Stream.runHead,
      Effect.mapError(() => "exit" as const),
    );
    if (Option.isNone(firstLine)) return yield* Effect.fail("exit" as const);
    return yield* decodeReadyFrame(firstLine.value).pipe(Effect.mapError(() => "invalid" as const));
  },
  // Closing the scope stops the probe process.
  Effect.scoped,
);

/** `omp --version` (4 s), then the `ready` frame of an RPC server that is stopped right after. */
export const probeOmp = Effect.fn("probeOmp")(function* (
  input: OmpProbeInput,
): Effect.fn.Return<OmpProbeResult, never, ChildProcessSpawner.ChildProcessSpawner> {
  const versionResult = yield* runVersion(input).pipe(
    Effect.timeoutOption(OMP_VERSION_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    return {
      status: "failed",
      version: null,
      stage: "version",
      reason: isCommandMissingCause(versionResult.failure) ? "missing" : "spawn",
    };
  }
  if (Option.isNone(versionResult.success)) {
    return { status: "failed", version: null, stage: "version", reason: "timeout" };
  }
  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  if (output.code !== 0) {
    return { status: "failed", version, stage: "version", reason: "exit" };
  }

  const readyResult = yield* readReadyFrame(input).pipe(
    Effect.timeoutOption(OMP_READY_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(readyResult)) {
    return { status: "failed", version, stage: "ready", reason: readyResult.failure };
  }
  if (Option.isNone(readyResult.success)) {
    return { status: "failed", version, stage: "ready", reason: "timeout" };
  }
  const { protocolVersion, contractVersion } = readyResult.success.value;
  return {
    status: "ready",
    version,
    ready: {
      ...(protocolVersion === undefined ? {} : { protocolVersion }),
      ...(contractVersion === undefined ? {} : { contractVersion }),
    },
  };
});

/**
 * Reuses a probe result for 30 s per instance, so status refreshes do not start a new omp
 * process each time. Concurrent callers share one probe.
 */
export const makeOmpProbeCache = Effect.fn("makeOmpProbeCache")(function* (
  ttlMs: number = OMP_PROBE_CACHE_TTL_MS,
) {
  const entry = yield* Ref.make<
    Option.Option<{ readonly key: string; readonly at: number; readonly result: OmpProbeResult }>
  >(Option.none());
  const semaphore = yield* Semaphore.make(1);

  const get = <R>(input: OmpProbeInput, probe: Effect.Effect<OmpProbeResult, never, R>) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const key = [input.binaryPath, input.profile, input.cwd].join("\0");
        const now = yield* Clock.currentTimeMillis;
        const cached = yield* Ref.get(entry);
        if (Option.isSome(cached) && cached.value.key === key && now - cached.value.at < ttlMs) {
          return cached.value.result;
        }
        const result = yield* probe;
        yield* Ref.set(entry, Option.some({ key, at: yield* Clock.currentTimeMillis, result }));
        return result;
      }),
    );

  return { get };
});
