/**
 * The OMP settings engine (PRD §7): reads every setting through `omp config list --json`, writes
 * global and project keys only through `omp config set|reset` and re-reads afterwards, and applies
 * per-thread overrides through a session RPC command where one exists, else the thread's
 * `--config` overlay. It never runs `omp config get`, which prints credentials unmasked.
 */
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

import type {
  OmpConfigScope,
  OmpSettingsField,
  OmpSettingsForm,
  OmpThreadOverrideResult,
} from "@t3tools/contracts";

import {
  buildOmpSettingsForm,
  ompConfigValueFits,
  ompThreadRpcCommand,
  type OmpThreadRpcCommand,
} from "../configForm.ts";
import type { OmpControlError, OmpControlService, OmpControlTarget } from "./control.ts";

export class OmpSettingsError extends Schema.TaggedError<OmpSettingsError>()("OmpSettingsError", {
  key: Schema.String,
  reason: Schema.Literals([
    "unknown_key",
    "read_only",
    "invalid_value",
    "thread_not_open",
    "no_value",
    "invalid_overlay",
    "not_thread_overridable",
    "credential",
  ]),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unknown_key":
        return `OMP has no setting ${this.key}.`;
      case "read_only":
        return `${this.key} is set by an environment variable and cannot be changed here.`;
      case "invalid_value":
        return `The value does not fit ${this.key}.`;
      case "thread_not_open":
        return `${this.key} can only be overridden while the thread's OMP session is running.`;
      case "no_value":
        return `${this.key} has no configured value to restore.`;
      case "not_thread_overridable":
        return `${this.key} follows the thread's launch flags and cannot be overridden per thread.`;
      case "credential":
        return `${this.key} is a stored credential; change it with OMP sign-in or an environment variable, or reset it.`;
      case "invalid_overlay":
        return `The thread's OMP overlay is not one Ompanel wrote, so ${this.key} was not changed.`;
    }
  }
}

export class OmpThreadHostError extends Schema.TaggedError<OmpThreadHostError>()(
  "OmpThreadHostError",
  {
    threadId: Schema.String,
    reason: Schema.Literals(["not_open", "rejected", "io"]),
    detail: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const detail = this.detail === undefined ? "" : `: ${this.detail}`;
    switch (this.reason) {
      case "not_open":
        return `Thread ${this.threadId} has no running OMP session.`;
      case "rejected":
        return `OMP rejected the thread setting${detail}.`;
      case "io":
        return `The thread's OMP overlay could not be written${detail}.`;
    }
  }
}

export interface OmpOpenThread {
  readonly threadId: string;
  /** The thread's OMP working directory (`--cwd`). */
  readonly cwd: string;
}

/** What the engine needs from the instance's running thread sessions. */
export interface OmpThreadSettingsHost {
  readonly openThreads: Effect.Effect<ReadonlyArray<OmpOpenThread>>;
  /** Sends one RPC command to the thread's omp and waits for its successful response. */
  readonly sendCommand: (
    threadId: string,
    command: OmpThreadRpcCommand,
  ) => Effect.Effect<void, OmpThreadHostError>;
  /** The thread's `--config` overlay file content; works whether or not the session runs. */
  readonly readOverlay: (threadId: string) => Effect.Effect<string, OmpThreadHostError>;
  readonly writeOverlay: (
    threadId: string,
    content: string,
  ) => Effect.Effect<void, OmpThreadHostError>;
  /** The thread keeps running stale values of `keys` until its session restarts. */
  readonly markRestartRequired: (
    threadId: string,
    keys: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
}

export interface OmpSettingsWriteResult {
  /** Every setting, re-read after the write. */
  readonly form: OmpSettingsForm;
  /** A higher layer or environment variable that still supplies the effective value. */
  readonly overriddenBy?: string;
  /** Open threads now marked restart required. */
  readonly restartRequired: ReadonlyArray<string>;
}

export interface OmpSettingsEngine {
  /** Every setting with its effective value and source layer for `target.cwd`. */
  readonly read: (target: OmpControlTarget) => Effect.Effect<OmpSettingsForm, OmpControlError>;
  readonly write: (
    target: OmpControlTarget,
    input: { readonly key: string; readonly value: unknown; readonly scope: OmpConfigScope },
  ) => Effect.Effect<OmpSettingsWriteResult, OmpControlError | OmpSettingsError>;
  /** Removes the key from the scope's config file so the next layer down applies. */
  readonly reset: (
    target: OmpControlTarget,
    input: { readonly key: string; readonly scope: OmpConfigScope },
  ) => Effect.Effect<OmpSettingsWriteResult, OmpControlError | OmpSettingsError>;
  /** Overrides one key for one thread; `target.cwd` is the thread's working directory. */
  readonly setThreadOverride: (
    target: OmpControlTarget,
    threadId: string,
    input: { readonly key: string; readonly value: unknown },
  ) => Effect.Effect<
    OmpThreadOverrideResult,
    OmpControlError | OmpSettingsError | OmpThreadHostError
  >;
  /** Drops the thread's override so the configured value applies again. */
  readonly clearThreadOverride: (
    target: OmpControlTarget,
    threadId: string,
    key: string,
  ) => Effect.Effect<
    OmpThreadOverrideResult,
    OmpControlError | OmpSettingsError | OmpThreadHostError
  >;
}

const OVERLAY_HEADER = "# Per-thread OMP settings written by Ompanel.\n";
const OverlayDocument = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeOverlay = Schema.decodeEffect(OverlayDocument);
const encodeOverlay = Schema.encodeEffect(OverlayDocument);

type OverlayDocument = Readonly<Record<string, unknown>>;

/** `doc` with `segments` set to `value`, or removed (with emptied parents) when `value` is undefined. */
const withPath = (
  doc: OverlayDocument,
  segments: ReadonlyArray<string>,
  value: unknown,
): OverlayDocument => {
  const [head, ...rest] = segments;
  if (head === undefined) return doc;
  const { [head]: current, ...others } = doc;
  if (rest.length === 0) return value === undefined ? others : { ...others, [head]: value };
  const child = withPath(Predicate.isObject(current) ? current : {}, rest, value);
  return Object.keys(child).length === 0 ? others : { ...others, [head]: child };
};

/** `cwd` is `dir` or inside it. */
const isWithin = (dir: string, cwd: string): boolean => {
  const base = dir.replace(/[\\/]+$/, "");
  return cwd === base || cwd.startsWith(`${base}/`) || cwd.startsWith(`${base}\\`);
};

export const makeOmpSettingsEngine = (deps: {
  readonly control: OmpControlService;
  readonly threads: OmpThreadSettingsHost;
}): OmpSettingsEngine => {
  const { control, threads } = deps;

  const read = Effect.fn("OmpSettingsEngine.read")(function* (target: OmpControlTarget) {
    return buildOmpSettingsForm(yield* control.configList(target));
  });

  const writableField = Effect.fn("OmpSettingsEngine.writableField")(function* (
    target: OmpControlTarget,
    key: string,
  ) {
    const field = (yield* read(target)).fields.find((candidate) => candidate.key === key);
    if (field === undefined) return yield* new OmpSettingsError({ key, reason: "unknown_key" });
    if (field.readOnly) return yield* new OmpSettingsError({ key, reason: "read_only" });
    return field;
  });

  /** Global writes reach every open thread; project writes reach threads in that project. */
  const markLaunchScopedChange = Effect.fn("OmpSettingsEngine.markLaunchScopedChange")(function* (
    target: OmpControlTarget,
    field: OmpSettingsField,
    scope: OmpConfigScope,
  ) {
    if (!field.launchScoped) return [];
    const affected = (yield* threads.openThreads).filter(
      (thread) => scope === "global" || isWithin(target.cwd, thread.cwd),
    );
    yield* Effect.forEach(
      affected,
      (thread) => threads.markRestartRequired(thread.threadId, [field.key]),
      { discard: true },
    );
    return affected.map((thread) => thread.threadId);
  });

  /**
   * A credential, stored or not, is never set from here: `config set` would carry it in argv,
   * which other local users can read, and an overlay would copy it to disk. Reset still clears it.
   */
  const checkAssignable = (field: OmpSettingsField, value: unknown) =>
    field.credential
      ? Effect.fail(new OmpSettingsError({ key: field.key, reason: "credential" }))
      : ompConfigValueFits(field.type, value)
        ? Effect.void
        : Effect.fail(new OmpSettingsError({ key: field.key, reason: "invalid_value" }));

  const write = Effect.fn("OmpSettingsEngine.write")(function* (
    target: OmpControlTarget,
    input: { readonly key: string; readonly value: unknown; readonly scope: OmpConfigScope },
  ) {
    const field = yield* writableField(target, input.key);
    yield* checkAssignable(field, input.value);
    const result = yield* control.configSet(target, input);
    // `config set` reports the scope's file, not what the next load resolves (oh-my-pi#23).
    const form = yield* read(target);
    const restartRequired = yield* markLaunchScopedChange(target, field, input.scope);
    return {
      form,
      ...(result.overriddenBy === undefined ? {} : { overriddenBy: result.overriddenBy }),
      restartRequired,
    } satisfies OmpSettingsWriteResult;
  });

  const reset = Effect.fn("OmpSettingsEngine.reset")(function* (
    target: OmpControlTarget,
    input: { readonly key: string; readonly scope: OmpConfigScope },
  ) {
    const field = yield* writableField(target, input.key);
    yield* control.configReset(target, input);
    const form = yield* read(target);
    const restartRequired = yield* markLaunchScopedChange(target, field, input.scope);
    return { form, restartRequired } satisfies OmpSettingsWriteResult;
  });

  const sendToThread = Effect.fn("OmpSettingsEngine.sendToThread")(function* (
    threadId: string,
    key: string,
    command: OmpThreadRpcCommand | undefined,
  ) {
    if (command === undefined) return yield* new OmpSettingsError({ key, reason: "invalid_value" });
    const open = yield* threads.openThreads;
    if (!open.some((thread) => thread.threadId === threadId)) {
      return yield* new OmpSettingsError({ key, reason: "thread_not_open" });
    }
    yield* threads.sendCommand(threadId, command);
    return { route: "rpc", restartRequired: false } satisfies OmpThreadOverrideResult;
  });

  /** Rewrites the thread's overlay with `key` set to `value` (removed when undefined). */
  const updateOverlay = Effect.fn("OmpSettingsEngine.updateOverlay")(function* (
    threadId: string,
    field: OmpSettingsField,
    value: unknown,
  ) {
    const current = yield* threads.readOverlay(threadId);
    const body = current
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("#"))
      .join("\n")
      .trim();
    const doc = yield* decodeOverlay(body === "" ? "{}" : body).pipe(
      Effect.mapError(() => new OmpSettingsError({ key: field.key, reason: "invalid_overlay" })),
    );
    // JSON is YAML, so OMP's overlay loader reads it as is.
    const text = yield* encodeOverlay(withPath(doc, field.key.split("."), value)).pipe(
      Effect.orDie,
    );
    yield* threads.writeOverlay(threadId, `${OVERLAY_HEADER}${text}\n`);
    // OMP reloads overlays live; launch-scoped keys still need a new session.
    if (field.launchScoped) yield* threads.markRestartRequired(threadId, [field.key]);
    return {
      route: "overlay",
      restartRequired: field.launchScoped,
    } satisfies OmpThreadOverrideResult;
  });

  const threadOverridableField = Effect.fn("OmpSettingsEngine.threadOverridableField")(function* (
    target: OmpControlTarget,
    key: string,
  ) {
    const field = yield* writableField(target, key);
    if (field.threadOverride === "none") {
      return yield* new OmpSettingsError({ key, reason: "not_thread_overridable" });
    }
    return field;
  });

  const setThreadOverride = Effect.fn("OmpSettingsEngine.setThreadOverride")(function* (
    target: OmpControlTarget,
    threadId: string,
    input: { readonly key: string; readonly value: unknown },
  ) {
    const field = yield* threadOverridableField(target, input.key);
    yield* checkAssignable(field, input.value);
    return field.threadOverride === "rpc"
      ? yield* sendToThread(threadId, field.key, ompThreadRpcCommand(field.key, input.value))
      : yield* updateOverlay(threadId, field, input.value);
  });

  const clearThreadOverride = Effect.fn("OmpSettingsEngine.clearThreadOverride")(function* (
    target: OmpControlTarget,
    threadId: string,
    key: string,
  ) {
    const field = yield* threadOverridableField(target, key);
    if (field.threadOverride === "overlay") return yield* updateOverlay(threadId, field, undefined);
    // A session RPC override has no "unset": send the value the config layers resolve to.
    if (!("value" in field)) return yield* new OmpSettingsError({ key, reason: "no_value" });
    return yield* sendToThread(threadId, key, ompThreadRpcCommand(key, field.value));
  });

  return { read, write, reset, setThreadOverride, clearThreadOverride };
};
