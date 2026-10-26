import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import type { OmpSettings } from "../settings.ts";
import { OmpDriver } from "./driver.ts";

const layerTest = TestProviderHost.layer({
  cwd: "/machine",
  settings: DEFAULT_SERVER_SETTINGS,
  runBackgroundWork: false,
}).pipe(Layer.provideMerge(NodeServices.layer));

const encoder = new TextEncoder();

const fakeOmp = (contractVersion: string | undefined) => {
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    launches.push(command);
    const stdout = command.args.includes("--version")
      ? "omp/18.12.6\n"
      : `${JSON.stringify({ type: "ready", protocolVersion: 1, ...(contractVersion ? { contractVersion } : {}) })}\n`;
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        // Outside the valid PID range, so cleanup cannot signal a real process.
        pid: ChildProcessSpawner.ProcessId(999_999_997),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.succeed(encoder.encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    );
  });
  return { spawner, launches };
};

/** An existing file to use as the explicit binary path. */
const overrideBinary = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "omp-driver-" });
  const binary = path.join(dir, "omp");
  yield* fileSystem.writeFileString(binary, "");
  return binary;
}).pipe(Effect.orDie);

const create = (config: Partial<OmpSettings>, enabled = true) =>
  OmpDriver.create({
    instanceId: ProviderInstanceId.make("omp"),
    displayName: undefined,
    environment: [],
    enabled,
    config: { ...OmpDriver.defaultConfig(), ...config },
  });

it.layer(layerTest)("OmpDriver", (it) => {
  it.effect("reports a ready sidecar that speaks the pinned contract", () =>
    Effect.gen(function* () {
      const omp = fakeOmp("1.0.0");
      const binaryPath = yield* overrideBinary;
      const instance = yield* create({ binaryPath, profile: "work" }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
      );
      yield* instance.snapshot.refresh;
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.strictEqual(snapshot.driver, "omp");
      assert.strictEqual(snapshot.status, "ready");
      assert.strictEqual(snapshot.version, "18.12.6");
      assert.isTrue(snapshot.supportsTextGeneration);
      assert.isTrue(snapshot.supportsConversationRollback);
      assert.deepStrictEqual(snapshot.supportedRuntimeModes, [
        "approval-required",
        "auto-accept-edits",
        "full-access",
      ]);
      assert.isTrue(omp.launches.every((launch) => launch.command === binaryPath));
      assert.includeMembers([...(omp.launches.at(-1)?.args ?? [])], ["--profile", "work"]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a sidecar that reports a different contract version", () =>
    Effect.gen(function* () {
      const binaryPath = yield* overrideBinary;
      const instance = yield* create({ binaryPath }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeOmp("2.0.0").spawner),
      );
      yield* instance.snapshot.refresh;
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.strictEqual(snapshot.status, "error");
      assert.include(snapshot.message, "RPC contract 2.0.0");
      assert.include(snapshot.message, "contract 1.0.0");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a sidecar that reports no contract version", () =>
    Effect.gen(function* () {
      const binaryPath = yield* overrideBinary;
      const instance = yield* create({ binaryPath }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, fakeOmp(undefined).spawner),
      );
      yield* instance.snapshot.refresh;
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.strictEqual(snapshot.status, "error");
      assert.include(snapshot.message, "does not report an RPC contract version");
    }).pipe(Effect.scoped),
  );

  it.effect("reports a missing sidecar without running anything", () =>
    Effect.gen(function* () {
      const instance = yield* create({}).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("No sidecar must not spawn")),
        ),
      );
      yield* instance.snapshot.refresh;
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.strictEqual(snapshot.status, "error");
      assert.isFalse(snapshot.installed);
    }).pipe(Effect.scoped),
  );

  it.effect("does not probe a disabled instance", () =>
    Effect.gen(function* () {
      const instance = yield* create({}, false).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Disabled OMP must not spawn")),
        ),
      );
      yield* instance.snapshot.refresh;
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.strictEqual(snapshot.status, "disabled");
      assert.isTrue(snapshot.supportsTextGeneration);
    }).pipe(Effect.scoped),
  );

  it.effect("declares rollback, fork and subagent capabilities", () =>
    Effect.gen(function* () {
      const instance = yield* create({}, false).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Unexpected spawn")),
        ),
      );
      const capabilities = yield* instance.orchestrationAdapter.getCapabilities();
      assert.isTrue(capabilities.threads.canRollbackThread);
      assert.isTrue(capabilities.threads.canForkThread);
      assert.isTrue(capabilities.checkpointing.providerCanRollbackConversation);
      assert.deepStrictEqual(Object.values(capabilities.subagents), [
        true,
        true,
        true,
        true,
        true,
        true,
      ]);

      const error = yield* instance.orchestrationAdapter
        .openSession({
          threadId: ThreadId.make("thread-1"),
          providerSessionId: ProviderSessionId.make("session-1"),
          modelSelection: { instanceId: instance.instanceId, model: "default" },
          runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: null,
          }),
        })
        .pipe(Effect.scoped, Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterOpenSessionError");
    }).pipe(Effect.scoped),
  );
});
