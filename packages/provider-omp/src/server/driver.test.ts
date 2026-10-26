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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { OMP_LOCK } from "../ompLock.ts";
import type { OmpSettings } from "../settings.ts";
import { OMP_CONTROL_TIMEOUTS_MS } from "./control.ts";
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
    const ready = {
      type: "ready",
      protocolVersion: 1,
      ...(contractVersion ? { contractVersion } : {}),
    };
    const stdin = command.options.stdin;
    // The RPC server answers each command: here only `get_login_providers`, with no providers.
    const responses = (Stream.isStream(stdin) ? stdin : Stream.empty).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => {
        const { id, type } = JSON.parse(line) as { id: string; type: string };
        return { type: "response", id, command: type, success: true, data: { providers: [] } };
      }),
    );
    const stdout = command.args.includes("--version")
      ? Stream.succeed("omp/18.12.6\n")
      : Stream.concat(Stream.succeed(ready), responses).pipe(
          Stream.map((frame) => `${JSON.stringify(frame)}\n`),
        );
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        // Outside the valid PID range, so cleanup cannot signal a real process.
        pid: ChildProcessSpawner.ProcessId(999_999_997),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: stdout.pipe(Stream.map((text) => encoder.encode(text))),
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
      const omp = fakeOmp(OMP_LOCK.contract.version);
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

  it.effect("answers the provider list while the probe hangs", () =>
    Effect.gen(function* () {
      const binaryPath = yield* overrideBinary;
      // Sidecar resolution reads the file for real, so advance the clock only once omp started.
      const spawned = yield* Deferred.make<void>();
      const hung = ChildProcessSpawner.make(() =>
        Deferred.succeed(spawned, undefined).pipe(
          Effect.as(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(999_999_996),
              exitCode: Effect.never,
              isRunning: Effect.succeed(true),
              kill: () => Effect.void,
              unref: Effect.succeed(Effect.void),
              stdin: Sink.drain,
              stdout: Stream.never,
              stderr: Stream.never,
              all: Stream.never,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.never,
            }),
          ),
        ),
      );
      const instance = yield* create({ binaryPath }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, hung),
      );
      const refreshing = yield* instance.snapshot.refresh.pipe(Effect.forkChild);
      const checking = yield* instance.snapshot.getSnapshot;
      assert.strictEqual(checking.status, "warning");
      assert.strictEqual(checking.message, "Checking the OMP sidecar...");
      yield* Deferred.await(spawned);
      assert.isUndefined(refreshing.pollUnsafe());
      assert.strictEqual((yield* instance.snapshot.getSnapshot).status, "warning");

      yield* TestClock.adjust(OMP_CONTROL_TIMEOUTS_MS.version);
      const checked = yield* Fiber.join(refreshing);
      assert.strictEqual(checked.status, "error");
      assert.strictEqual(checked.message, "OMP timed out while running `omp --version`.");
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
      assert.include(snapshot.message, `contract ${OMP_LOCK.contract.version}`);
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
