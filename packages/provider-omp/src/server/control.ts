/**
 * OmpControlService: every short-lived `omp` process Ompanel starts outside a thread — the
 * status probe, `omp usage`, the login-provider list and RPC sign-in — runs here, each under a
 * hard deadline. On a deadline the process group gets SIGTERM, then SIGKILL after
 * {@link OMP_CONTROL_KILL_GRACE_MS}, so a hung omp never outlives the call.
 */
import {
  isCommandMissingCause,
  parseGenericCliVersion,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type {
  ExtensionUiRequest,
  ExtensionUiResponse,
  LoginProvider,
  ReadyEvent,
} from "../../contract/src/wire.generated.ts";
import type { OmpConfigScope } from "@t3tools/contracts";

import { OmpConfigList, OmpConfigResetResult, OmpConfigSetResult } from "../configForm.ts";

/** Hard deadline per operation, from spawn to exit. */
export const OMP_CONTROL_TIMEOUTS_MS = {
  /** `omp --version`. */
  version: 4_000,
  /** The probe's RPC server: `ready` frame plus `get_login_providers`. */
  ready: 10_000,
  /** `omp usage --json`. */
  usage: 10_000,
  /** An RPC `login` session, from spawn until the provider stores the credential. */
  login: 60_000,
  /** `omp config list|set|reset --json`. */
  config: 10_000,
} as const;
export type OmpControlBudget = keyof typeof OMP_CONTROL_TIMEOUTS_MS;

/** SIGTERM grace before SIGKILL when a deadline stops a process group. */
export const OMP_CONTROL_KILL_GRACE_MS = 1_000;
/** How long one instance reuses a probe or usage result. */
export const OMP_CONTROL_CACHE_TTL_MS = 30_000;

/**
 * A control process must not open a session, start MCP servers, run hooks or extensions: no
 * session file, no tools (which also disables MCP), no extensions, skills, rules, LSP or title
 * model. Login providers that extensions contribute are therefore not listed.
 */
export const OMP_CONTROL_RPC_ARGS = [
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

/** One instance's omp: the resolved binary and how to run it. */
export interface OmpControlTarget {
  readonly binaryPath: string;
  /** Identity of the verified binary file; a swapped binary misses the cache. */
  readonly binaryIdentity?: string;
  readonly profile: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly cwd: string;
}

export type OmpControlOperation =
  | "version"
  | "usage"
  | "rpc"
  | "login_providers"
  | "login"
  | "config_list"
  | "config_set"
  | "config_reset";

/** Carries no process output: stderr and stdout may contain credentials. */
export class OmpControlError extends Schema.TaggedError<OmpControlError>()("OmpControlError", {
  operation: Schema.Literals([
    "version",
    "usage",
    "rpc",
    "login_providers",
    "login",
    "config_list",
    "config_set",
    "config_reset",
  ]),
  reason: Schema.Literals(["missing", "spawn", "timeout", "exit", "invalid", "rejected"]),
  timeoutMs: Schema.optional(Schema.Number),
  exitCode: Schema.optional(Schema.Number),
  /** The RPC failure message for `rejected`. */
  detail: Schema.optional(Schema.String),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.reason) {
      case "missing":
        return `OMP ${this.operation} failed: the executable was not found.`;
      case "spawn":
        return `OMP ${this.operation} failed: the executable could not be started.`;
      case "timeout":
        return `OMP ${this.operation} timed out after ${this.timeoutMs ?? 0} ms and was stopped.`;
      case "exit":
        return `OMP ${this.operation} exited with code ${this.exitCode ?? "unknown"}.`;
      case "invalid":
        return `OMP ${this.operation} returned output Ompanel could not read.`;
      case "rejected":
        return `OMP ${this.operation} failed${this.detail === undefined ? "" : `: ${this.detail}`}.`;
    }
  }
}

const ReadyFrame = Schema.Struct({
  type: Schema.Literal("ready"),
  protocolVersion: Schema.optional(Schema.Number),
  contractVersion: Schema.optional(Schema.String),
});
const decodeReadyFrame = Schema.decodeUnknownEffect(ReadyFrame);

const LoginProviderSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  available: Schema.Boolean,
  authenticated: Schema.Boolean,
});
const decodeLoginProviders = Schema.decodeUnknownEffect(
  Schema.Struct({ providers: Schema.Array(LoginProviderSchema) }),
);

const ResponseFrame = Schema.Struct({
  type: Schema.Literal("response"),
  id: Schema.optional(Schema.String),
  success: Schema.Boolean,
  data: Schema.optional(Schema.Unknown),
  error: Schema.optional(Schema.String),
});
const decodeResponseFrame = Schema.decodeUnknownOption(ResponseFrame);

const UiRequestFrame = Schema.Struct({
  type: Schema.Literal("extension_ui_request"),
  id: Schema.String,
  method: Schema.String,
});
const isUiRequestFrame = Schema.is(UiRequestFrame);

/**
 * `omp usage --json` (`cli/usage-cli.ts`). Not part of OMP's versioned CLI JSON contract, so
 * only the envelope is checked; reports keep OMP's `UsageReport` shape minus `raw`.
 */
export const OmpUsageReport = Schema.Struct({
  generatedAt: Schema.Number,
  reports: Schema.Array(
    Schema.Struct({
      provider: Schema.String,
      fetchedAt: Schema.Number,
      limits: Schema.Array(Schema.Unknown),
    }),
  ),
  accountsWithoutUsage: Schema.optional(Schema.Array(Schema.Unknown)),
  disabledCredentials: Schema.optional(Schema.Array(Schema.Unknown)),
});
export type OmpUsageReport = typeof OmpUsageReport.Type;
const decodeUsageReport = Schema.decodeEffect(Schema.fromJsonString(OmpUsageReport));
const decodeConfigList = Schema.decodeEffect(Schema.fromJsonString(OmpConfigList));
const decodeConfigSetResult = Schema.decodeEffect(Schema.fromJsonString(OmpConfigSetResult));
const decodeConfigResetResult = Schema.decodeEffect(Schema.fromJsonString(OmpConfigResetResult));
const encodeJsonValue = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export type OmpProbeFailure =
  | { readonly stage: "version"; readonly reason: "missing" | "spawn" | "timeout" | "exit" }
  | { readonly stage: "ready"; readonly reason: "spawn" | "timeout" | "exit" | "invalid" };

export type OmpProbeResult =
  | {
      readonly status: "ready";
      readonly version: string | null;
      readonly ready: Pick<ReadyEvent, "protocolVersion" | "contractVersion">;
      /** OAuth providers and whether each is signed in; `null` when OMP refused the request. */
      readonly loginProviders: ReadonlyArray<LoginProvider> | null;
    }
  | ({ readonly status: "failed"; readonly version: string | null } & OmpProbeFailure);

/** Answers one extension UI request of a login session; `undefined` sends nothing. */
export type OmpLoginUiHandler = (
  request: ExtensionUiRequest,
) => Effect.Effect<ExtensionUiResponse | undefined>;

export interface OmpControlService {
  /** `omp --version` (4 s). The version string, or `null` when it prints none. */
  readonly version: (target: OmpControlTarget) => Effect.Effect<string | null, OmpControlError>;
  /** `omp usage --json` (10 s), cached 30 s. */
  readonly usage: (
    target: OmpControlTarget,
    options?: { readonly provider?: string },
  ) => Effect.Effect<OmpUsageReport, OmpControlError>;
  /** RPC `get_login_providers` in a fresh server (10 s), uncached. */
  readonly loginProviders: (
    target: OmpControlTarget,
  ) => Effect.Effect<ReadonlyArray<LoginProvider>, OmpControlError>;
  /**
   * RPC `login` (60 s). The server asks the host to open the authorization URL and may ask for
   * a pasted code; `onUiRequest` answers those. Success drops this instance's cache.
   */
  readonly login: (
    target: OmpControlTarget,
    providerId: string,
    onUiRequest: OmpLoginUiHandler,
  ) => Effect.Effect<void, OmpControlError>;
  /** Status probe: `--version`, then `ready` and `get_login_providers`. Cached 30 s. */
  readonly probe: (target: OmpControlTarget) => Effect.Effect<OmpProbeResult>;
  /** Drops every cached result of this instance. */
  readonly invalidate: Effect.Effect<void>;
  /** `omp config list --json --cwd <target.cwd>` (10 s), uncached: every field with its source layer. */
  readonly configList: (target: OmpControlTarget) => Effect.Effect<OmpConfigList, OmpControlError>;
  /**
   * `omp config set --scope <scope> --cwd <target.cwd> --json -- <key> <JSON value>` (10 s).
   * There is deliberately no `config get`: it prints credentials unmasked.
   */
  readonly configSet: (
    target: OmpControlTarget,
    input: { readonly key: string; readonly value: unknown; readonly scope: OmpConfigScope },
  ) => Effect.Effect<OmpConfigSetResult, OmpControlError>;
  /** `omp config reset --scope <scope> --cwd <target.cwd> --json -- <key>` (10 s). */
  readonly configReset: (
    target: OmpControlTarget,
    input: { readonly key: string; readonly scope: OmpConfigScope },
  ) => Effect.Effect<OmpConfigResetResult, OmpControlError>;
}

export interface OmpControlServiceOptions {
  readonly timeoutsMs?: Partial<Record<OmpControlBudget, number>>;
  readonly killGraceMs?: number;
  readonly cacheTtlMs?: number;
}

const profileArgs = (profile: string): ReadonlyArray<string> =>
  profile === "" ? [] : ["--profile", profile];

interface RpcSession {
  readonly ready: typeof ReadyFrame.Type;
  /** Sends one command and returns its response data; other frames go to `onFrame`. */
  readonly request: (
    command: { readonly type: string } & Record<string, unknown>,
    onFrame?: (frame: unknown) => Effect.Effect<void, OmpControlError>,
  ) => Effect.Effect<unknown, OmpControlError>;
  readonly send: (frame: unknown) => Effect.Effect<void>;
}

const encoder = new TextEncoder();

/**
 * Builds one instance's control service. Results are cached per service, so each provider
 * instance gets its own cache; cached work runs in the service scope, so a caller that gives up
 * never strands the callers sharing that result.
 */
export const makeOmpControlService = Effect.fn("makeOmpControlService")(function* (
  options: OmpControlServiceOptions = {},
): Effect.fn.Return<
  OmpControlService,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const timeouts = { ...OMP_CONTROL_TIMEOUTS_MS, ...options.timeoutsMs };
  const killGraceMs = options.killGraceMs ?? OMP_CONTROL_KILL_GRACE_MS;
  const cacheTtlMs = options.cacheTtlMs ?? OMP_CONTROL_CACHE_TTL_MS;

  const command = (
    target: OmpControlTarget,
    args: ReadonlyArray<string>,
    stdin: ChildProcess.CommandInput,
  ) =>
    ChildProcess.make(target.binaryPath, [...args], {
      cwd: target.cwd,
      env: target.environment,
      extendEnv: false,
      stdin,
      forceKillAfter: killGraceMs,
    });

  /** Runs `use` under the budget's deadline; the deadline closes the scope, which stops the process group. */
  const withDeadline = <A, E, R>(
    operation: OmpControlOperation,
    budget: OmpControlBudget,
    use: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | OmpControlError, Exclude<R, Scope.Scope>> =>
    Effect.scoped(use).pipe(
      Effect.timeoutOption(timeouts[budget]),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new OmpControlError({ operation, reason: "timeout", timeoutMs: timeouts[budget] }),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );

  const collect = (
    operation: OmpControlOperation,
    budget: OmpControlBudget,
    target: OmpControlTarget,
    args: ReadonlyArray<string>,
  ) =>
    withDeadline(
      operation,
      budget,
      spawnAndCollect(target.binaryPath, command(target, args, "ignore")).pipe(
        Effect.mapError(
          (cause) =>
            new OmpControlError({
              operation,
              reason: isCommandMissingCause(cause) ? "missing" : "spawn",
              cause,
            }),
        ),
      ),
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

  const version = Effect.fn("OmpControl.version")(function* (target: OmpControlTarget) {
    // The version belongs to the binary, not the profile.
    const output = yield* collect("version", "version", target, ["--version"]);
    if (output.code !== 0) {
      return yield* new OmpControlError({
        operation: "version",
        reason: "exit",
        exitCode: output.code,
      });
    }
    return parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  });

  const usageUncached = Effect.fn("OmpControl.usage")(function* (
    target: OmpControlTarget,
    provider: string | undefined,
  ) {
    const output = yield* collect("usage", "usage", target, [
      ...profileArgs(target.profile),
      "usage",
      "--json",
      ...(provider === undefined ? [] : ["--provider", provider]),
    ]);
    if (output.code !== 0) {
      return yield* new OmpControlError({
        operation: "usage",
        reason: "exit",
        exitCode: output.code,
      });
    }
    return yield* decodeUsageReport(output.stdout.trim()).pipe(
      Effect.mapError(
        (cause) => new OmpControlError({ operation: "usage", reason: "invalid", cause }),
      ),
    );
  });

  /** Runs `omp [--profile p] config <args>` and decodes its JSON stdout. */
  const runConfig = <A>(
    operation: "config_list" | "config_set" | "config_reset",
    target: OmpControlTarget,
    args: ReadonlyArray<string>,
    decode: (stdout: string) => Effect.Effect<A, Schema.SchemaError>,
  ) =>
    collect(operation, "config", target, [...profileArgs(target.profile), "config", ...args]).pipe(
      Effect.flatMap((output) =>
        output.code === 0
          ? decode(output.stdout.trim()).pipe(
              Effect.mapError(
                (cause) => new OmpControlError({ operation, reason: "invalid", cause }),
              ),
            )
          : Effect.fail(new OmpControlError({ operation, reason: "exit", exitCode: output.code })),
      ),
    );

  const configList = Effect.fn("OmpControl.configList")(function* (target: OmpControlTarget) {
    return yield* runConfig(
      "config_list",
      target,
      ["list", "--json", "--cwd", target.cwd],
      decodeConfigList,
    );
  });

  const configSet = Effect.fn("OmpControl.configSet")(function* (
    target: OmpControlTarget,
    input: { readonly key: string; readonly value: unknown; readonly scope: OmpConfigScope },
  ) {
    // OMP parses the text by the key's type and accepts JSON for every type; `--` keeps a negative
    // number from reading as a flag. Values arrive decoded from JSON, so they always encode.
    const valueText = yield* encodeJsonValue(input.value).pipe(Effect.orDie);
    return yield* runConfig(
      "config_set",
      target,
      ["set", "--scope", input.scope, "--cwd", target.cwd, "--json", "--", input.key, valueText],
      decodeConfigSetResult,
    );
  });

  const configReset = Effect.fn("OmpControl.configReset")(function* (
    target: OmpControlTarget,
    input: { readonly key: string; readonly scope: OmpConfigScope },
  ) {
    return yield* runConfig(
      "config_reset",
      target,
      ["reset", "--scope", input.scope, "--cwd", target.cwd, "--json", "--", input.key],
      decodeConfigResetResult,
    );
  });

  /** Starts `omp --mode rpc`, waits for `ready`, and hands the session to `use`. */
  const openRpcSession = Effect.fn("OmpControl.openRpcSession")(function* (
    operation: OmpControlOperation,
    target: OmpControlTarget,
  ): Effect.fn.Return<RpcSession, OmpControlError, Scope.Scope> {
    const sessionScope = yield* Effect.scope;
    const outgoing = yield* Queue.unbounded<Uint8Array>();
    const child = yield* spawner
      .spawn(
        command(
          target,
          [...profileArgs(target.profile), ...OMP_CONTROL_RPC_ARGS],
          Stream.fromQueue(outgoing),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new OmpControlError({
              operation,
              reason: isCommandMissingCause(cause) ? "missing" : "spawn",
              cause,
            }),
        ),
      );

    const frames = yield* Queue.unbounded<unknown, OmpControlError>();
    yield* child.stdout.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.runForEach((line) => {
        if (line.trim().length === 0) return Effect.void;
        try {
          return Queue.offer(frames, JSON.parse(line) as unknown);
        } catch {
          // OMP writes only JSON frames; drop stray text rather than guess.
          return Effect.void;
        }
      }),
      Effect.matchEffect({
        onFailure: (cause) =>
          Queue.fail(frames, new OmpControlError({ operation, reason: "exit", cause })),
        onSuccess: () =>
          child.exitCode.pipe(
            Effect.map(Number),
            Effect.option,
            Effect.flatMap((code) =>
              Queue.fail(
                frames,
                new OmpControlError({
                  operation,
                  reason: "exit",
                  ...(Option.isSome(code) ? { exitCode: code.value } : {}),
                }),
              ),
            ),
          ),
      }),
      Effect.forkIn(sessionScope),
    );
    // Drain stderr so a chatty omp cannot block on a full pipe; its text is never kept.
    yield* child.stderr.pipe(Stream.runDrain, Effect.ignore, Effect.forkIn(sessionScope));

    const first = yield* Queue.take(frames);
    const ready = yield* decodeReadyFrame(first).pipe(
      Effect.mapError((cause) => new OmpControlError({ operation, reason: "invalid", cause })),
    );

    const send = (frame: unknown) =>
      Queue.offer(outgoing, encoder.encode(`${JSON.stringify(frame)}\n`)).pipe(Effect.asVoid);

    let nextId = 0;
    const request: RpcSession["request"] = Effect.fnUntraced(function* (body, onFrame) {
      const id = `ompanel-control-${nextId++}`;
      yield* send({ ...body, id });
      while (true) {
        const frame = yield* Queue.take(frames);
        const response = decodeResponseFrame(frame);
        if (Option.isSome(response) && response.value.id === id) {
          if (response.value.success) return response.value.data;
          return yield* new OmpControlError({
            operation,
            reason: "rejected",
            ...(response.value.error === undefined ? {} : { detail: response.value.error }),
          });
        }
        if (onFrame !== undefined) yield* onFrame(frame);
      }
    });

    return { ready, request, send };
  });

  const readLoginProviders = (operation: OmpControlOperation, session: RpcSession) =>
    session.request({ type: "get_login_providers" }).pipe(
      Effect.flatMap(decodeLoginProviders),
      Effect.map((data) => data.providers),
      Effect.catchTags({
        SchemaError: (cause) =>
          Effect.fail(new OmpControlError({ operation, reason: "invalid", cause })),
      }),
    );

  const loginProviders = Effect.fn("OmpControl.loginProviders")(function* (
    target: OmpControlTarget,
  ) {
    return yield* withDeadline(
      "login_providers",
      "ready",
      openRpcSession("login_providers", target).pipe(
        Effect.flatMap((session) => readLoginProviders("login_providers", session)),
      ),
    );
  });

  const probeUncached = Effect.fn("OmpControl.probe")(function* (
    target: OmpControlTarget,
  ): Effect.fn.Return<OmpProbeResult> {
    const versionResult = yield* version(target).pipe(Effect.result);
    if (versionResult._tag === "Failure") {
      const failure = versionResult.failure;
      return {
        status: "failed",
        version: null,
        stage: "version",
        reason:
          failure.reason === "missing" || failure.reason === "timeout" || failure.reason === "exit"
            ? failure.reason
            : "spawn",
      };
    }
    const parsedVersion = versionResult.success;
    const rpcResult = yield* withDeadline(
      "rpc",
      "ready",
      Effect.gen(function* () {
        const session = yield* openRpcSession("rpc", target);
        const providers = yield* readLoginProviders("rpc", session).pipe(
          Effect.map((list): ReadonlyArray<LoginProvider> | null => list),
          // A refused or unreadable list leaves auth unknown; the server itself is fine.
          Effect.catchIf(
            (error) => error.reason === "rejected" || error.reason === "invalid",
            () => Effect.succeed(null),
          ),
        );
        return { ready: session.ready, providers };
      }),
    ).pipe(Effect.result);
    if (rpcResult._tag === "Failure") {
      const { reason } = rpcResult.failure;
      return {
        status: "failed",
        version: parsedVersion,
        stage: "ready",
        reason:
          reason === "timeout" || reason === "exit" || reason === "invalid" ? reason : "spawn",
      };
    }
    const { protocolVersion, contractVersion } = rpcResult.success.ready;
    return {
      status: "ready",
      version: parsedVersion,
      ready: {
        ...(protocolVersion === undefined ? {} : { protocolVersion }),
        ...(contractVersion === undefined ? {} : { contractVersion }),
      },
      loginProviders: rpcResult.success.providers,
    };
  });

  const login = Effect.fn("OmpControl.login")(function* (
    target: OmpControlTarget,
    providerId: string,
    onUiRequest: OmpLoginUiHandler,
  ) {
    yield* withDeadline(
      "login",
      "login",
      Effect.gen(function* () {
        const session = yield* openRpcSession("login", target);
        yield* session.request({ type: "login", providerId }, (frame) => {
          if (!isUiRequestFrame(frame)) return Effect.void;
          return onUiRequest(frame as ExtensionUiRequest).pipe(
            Effect.flatMap((response) =>
              response === undefined ? Effect.void : session.send(response),
            ),
          );
        });
      }),
    );
    yield* invalidate;
  });

  interface CacheEntry {
    readonly deferred: Deferred.Deferred<unknown, unknown>;
    settledAt: number | null;
  }
  const entries = new Map<string, CacheEntry>();

  /** Shares one run per key while it is in flight and for `cacheTtlMs` after it succeeds. */
  const cached = <A, E>(key: string, run: Effect.Effect<A, E>): Effect.Effect<A, E> =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      const existing = entries.get(key);
      if (
        existing !== undefined &&
        (existing.settledAt === null || now - existing.settledAt < cacheTtlMs)
      ) {
        return Deferred.await(existing.deferred as Deferred.Deferred<A, E>);
      }
      const deferred = Deferred.makeUnsafe<A, E>();
      const entry: CacheEntry = {
        deferred: deferred as Deferred.Deferred<unknown, unknown>,
        settledAt: null,
      };
      entries.set(key, entry);
      return run.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.flatMap(Clock.currentTimeMillis, (settledAt) => {
            if (Exit.isSuccess(exit)) entry.settledAt = settledAt;
            // Failures are not kept: the next caller retries.
            else if (entries.get(key) === entry) entries.delete(key);
            return Deferred.done(deferred, exit);
          }),
        ),
        Effect.forkIn(scope),
        Effect.andThen(Deferred.await(deferred)),
      );
    });

  const targetKey = (target: OmpControlTarget) =>
    [target.binaryPath, target.binaryIdentity ?? "", target.profile, target.cwd].join("\0");

  const invalidate = Effect.sync(() => entries.clear());

  return {
    version,
    usage: (target, usageOptions) =>
      cached(
        ["usage", targetKey(target), usageOptions?.provider ?? ""].join("\0"),
        usageUncached(target, usageOptions?.provider),
      ),
    loginProviders,
    login,
    probe: (target) => cached(["probe", targetKey(target)].join("\0"), probeUncached(target)),
    invalidate,
    configList,
    configSet,
    configReset,
  } satisfies OmpControlService;
});
