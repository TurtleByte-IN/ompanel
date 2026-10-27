import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type OmpUpdateCheck,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";

import { OmpControlError, type OmpControlTarget } from "./control.ts";
import { makeOmpUpdateNotice } from "./updateNotice.ts";

const target: OmpControlTarget = {
  binaryPath: "/app/omp",
  binaryIdentity: "sha256:pinned",
  profile: "",
  environment: {},
  cwd: "/machine",
};

const probed: ServerProvider = {
  instanceId: ProviderInstanceId.make("omp"),
  driver: ProviderDriverKind.make("omp"),
  enabled: true,
  installed: true,
  version: "18.12.6",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-10-27T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  executable: { source: "bundled", path: "/app/omp" },
};

/** Runs the notice once against `snapshot` and returns what it published. */
const harness = (answer: Effect.Effect<OmpUpdateCheck, OmpControlError>) =>
  Effect.gen(function* () {
    const checks = yield* Ref.make(0);
    const published = yield* Ref.make<ReadonlyArray<ServerProvider>>([]);
    const publish = yield* makeOmpUpdateNotice({
      target: Effect.succeed(target),
      updateCheck: () => Ref.update(checks, (count) => count + 1).pipe(Effect.andThen(answer)),
    });
    const run = (snapshot: ServerProvider) =>
      publish({
        snapshot,
        getSnapshot: Effect.succeed(snapshot),
        publishSnapshot: (next) => Ref.update(published, (all) => [...all, next]),
      });
    return { run, checks: Ref.get(checks), published: Ref.get(published) };
  });

describe("makeOmpUpdateNotice", () => {
  it.effect("puts an available OMP update on the snapshot", () =>
    Effect.gen(function* () {
      const notice = yield* harness(
        Effect.succeed({
          status: "available",
          currentVersion: "18.12.6",
          latestVersion: "18.13.0",
        }),
      );
      yield* notice.run(probed);
      const [snapshot] = yield* notice.published;
      assert.strictEqual(snapshot?.versionAdvisory?.status, "behind_latest");
      assert.strictEqual(snapshot?.versionAdvisory?.latestVersion, "18.13.0");
      assert.isFalse(snapshot?.versionAdvisory?.canUpdate);
      assert.isNull(snapshot?.versionAdvisory?.updateCommand);
      assert.include(
        snapshot?.versionAdvisory?.message ?? "",
        "Sidecar updates only arrive with app updates",
      );
    }),
  );

  it.effect("publishes nothing when the check fails", () =>
    Effect.gen(function* () {
      const notice = yield* harness(
        Effect.fail(
          new OmpControlError({ operation: "update_check", reason: "timeout", timeoutMs: 20_000 }),
        ),
      );
      yield* notice.run(probed);
      assert.strictEqual(yield* notice.checks, 1);
      assert.deepStrictEqual(yield* notice.published, []);
    }),
  );

  it.effect("asks OMP once per binary while the answer is fresh", () =>
    Effect.gen(function* () {
      const notice = yield* harness(
        Effect.succeed({ status: "current", currentVersion: "18.12.6", latestVersion: "18.12.6" }),
      );
      yield* notice.run(probed);
      yield* notice.run({ ...probed, checkedAt: "2026-10-27T00:05:00.000Z" });
      assert.strictEqual(yield* notice.checks, 1);
      assert.deepStrictEqual(
        (yield* notice.published).map((snapshot) => snapshot.versionAdvisory?.status),
        ["current", "current"],
      );
    }),
  );

  it.effect("does not run when the probe found no usable omp", () =>
    Effect.gen(function* () {
      const notice = yield* harness(
        Effect.succeed({
          status: "available",
          currentVersion: "18.12.6",
          latestVersion: "18.13.0",
        }),
      );
      yield* notice.run({ ...probed, status: "error" });
      yield* notice.run({ ...probed, installed: false, version: null });
      assert.strictEqual(yield* notice.checks, 0);
      assert.deepStrictEqual(yield* notice.published, []);
    }),
  );
});
