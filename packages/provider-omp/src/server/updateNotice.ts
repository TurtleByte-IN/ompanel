import type { OmpUpdateCheck, ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";

import type { OmpControlTarget } from "./control.ts";
import { ompVersionAdvisory } from "./status.ts";

/** An answer holds for an hour; a failed check is retried a few probes later. */
const ANSWER_TTL = Duration.hours(1);
const FAILURE_TTL = Duration.minutes(5);

interface CachedCheck {
  /** The binary that answered: a swapped binary checks again. */
  readonly key: string;
  readonly expiresAt: number;
  readonly checkedAt: string;
  /** Null when the check failed: no notice. */
  readonly check: OmpUpdateCheck | null;
}

/**
 * `omp update --check` after each provider probe, so the provider card shows an update notice
 * without a click. It only reports: Ompanel never installs an OMP update. Runs beside the probe's
 * snapshot, never in front of it, and a failed check publishes nothing.
 */
export const makeOmpUpdateNotice = Effect.fn("makeOmpUpdateNotice")(function* <E1, E2>(input: {
  readonly target: Effect.Effect<OmpControlTarget, E1>;
  readonly updateCheck: (target: OmpControlTarget) => Effect.Effect<OmpUpdateCheck, E2>;
}) {
  const cache = yield* Ref.make<CachedCheck | null>(null);

  const cachedCheck = Effect.fn("OmpUpdateNotice.check")(function* () {
    const target = yield* Effect.result(input.target);
    if (Result.isFailure(target)) return null;
    const key = target.success.binaryIdentity ?? target.success.binaryPath;
    const now = yield* DateTime.now;
    const cached = yield* Ref.get(cache);
    if (cached?.key === key && cached.expiresAt > DateTime.toEpochMillis(now)) return cached;
    const answer = yield* Effect.result(input.updateCheck(target.success));
    const check = Result.isSuccess(answer) ? answer.success : null;
    const entry: CachedCheck = {
      key,
      check,
      checkedAt: DateTime.formatIso(now),
      expiresAt: DateTime.toEpochMillis(now) + Duration.toMillis(check ? ANSWER_TTL : FAILURE_TTL),
    };
    yield* Ref.set(cache, entry);
    return entry;
  });

  /** Adds the advisory to the current snapshot; skips instances whose probe found no usable omp. */
  return Effect.fn("OmpUpdateNotice.publish")(function* (options: {
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) {
    const { snapshot } = options;
    if (
      !snapshot.enabled ||
      !snapshot.installed ||
      snapshot.version === null ||
      snapshot.status === "error"
    ) {
      return;
    }
    const entry = yield* cachedCheck();
    if (entry === null || entry.check === null) return;
    const versionAdvisory = ompVersionAdvisory({
      check: entry.check,
      probedVersion: snapshot.version,
      executable: snapshot.executable,
      checkedAt: entry.checkedAt,
    });
    const current = yield* options.getSnapshot;
    yield* options.publishSnapshot({ ...current, versionAdvisory });
  });
});
