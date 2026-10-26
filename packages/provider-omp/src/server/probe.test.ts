import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import {
  makeOmpProbeCache,
  OMP_PROBE_CACHE_TTL_MS,
  OMP_PROBE_RPC_ARGS,
  OMP_READY_TIMEOUT_MS,
  OMP_VERSION_TIMEOUT_MS,
  probeOmp,
  type OmpProbeInput,
  type OmpProbeResult,
} from "./probe.ts";

const encoder = new TextEncoder();
const READY_FRAME = `${JSON.stringify({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  contractVersion: "1.0.0",
})}\n`;

type Behaviour = { readonly stdout: string; readonly exitCode: number } | "hang";

function handle(behaviour: Behaviour) {
  const hang = behaviour === "hang";
  return ChildProcessSpawner.makeHandle({
    // Outside the valid PID range, so cleanup cannot signal a real process.
    pid: ChildProcessSpawner.ProcessId(999_999_998),
    exitCode: hang
      ? Effect.never
      : Effect.succeed(ChildProcessSpawner.ExitCode(behaviour.exitCode)),
    isRunning: Effect.succeed(hang),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: hang ? Stream.never : Stream.succeed(encoder.encode(behaviour.stdout)),
    stderr: hang ? Stream.never : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function fakeOmp(input: { readonly version?: Behaviour; readonly rpc?: Behaviour }) {
  const launches: Array<ChildProcess.StandardCommand> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    launches.push(command);
    return Effect.succeed(
      handle(
        command.args.includes("--version")
          ? (input.version ?? { stdout: "omp/18.12.6\n", exitCode: 0 })
          : (input.rpc ?? { stdout: READY_FRAME, exitCode: 0 }),
      ),
    );
  });
  return { spawner, launches };
}

const INPUT: OmpProbeInput = {
  binaryPath: "/opt/ompanel/omp",
  profile: "",
  environment: { HOME: "/home/tester" },
  cwd: "/workspace",
};

describe("probeOmp", () => {
  it.effect("reads the version and the contract version from the ready frame", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({});
      const result = yield* probeOmp({ ...INPUT, profile: "work" }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
      );
      assert.deepStrictEqual(result, {
        status: "ready",
        version: "18.12.6",
        ready: { protocolVersion: 1, contractVersion: "1.0.0" },
      });
      const [version, rpc] = omp.launches;
      assert.strictEqual(version?.command, "/opt/ompanel/omp");
      assert.deepStrictEqual(version?.args, ["--version"]);
      assert.deepStrictEqual(rpc?.args, ["--profile", "work", ...OMP_PROBE_RPC_ARGS]);
      assert.strictEqual(rpc?.options.cwd, "/workspace");
      assert.strictEqual(rpc?.options.extendEnv, false);
    }),
  );

  it.effect("gives up on `omp --version` after 4 seconds", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ version: "hang" });
      const probing = yield* probeOmp(INPUT).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
        Effect.forkChild,
      );
      yield* TestClock.adjust(OMP_VERSION_TIMEOUT_MS - 1);
      assert.isUndefined(probing.pollUnsafe());
      yield* TestClock.adjust("1 millis");
      assert.deepStrictEqual(yield* Fiber.join(probing), {
        status: "failed",
        version: null,
        stage: "version",
        reason: "timeout",
      });
      assert.lengthOf(omp.launches, 1);
    }),
  );

  it.effect("gives up when the RPC server never reports ready", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ rpc: "hang" });
      const probing = yield* probeOmp(INPUT).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
        Effect.forkChild,
      );
      yield* TestClock.adjust(OMP_READY_TIMEOUT_MS);
      assert.deepStrictEqual(yield* Fiber.join(probing), {
        status: "failed",
        version: "18.12.6",
        stage: "ready",
        reason: "timeout",
      });
    }),
  );

  it.effect("rejects an RPC server whose first frame is not ready", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ rpc: { stdout: '{"type":"response"}\n', exitCode: 0 } });
      const result = yield* probeOmp(INPUT).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
      );
      assert.deepStrictEqual(result, {
        status: "failed",
        version: "18.12.6",
        stage: "ready",
        reason: "invalid",
      });
    }),
  );

  it.effect("reports an RPC server that exits before any frame", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ rpc: { stdout: "", exitCode: 1 } });
      const result = yield* probeOmp(INPUT).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
      );
      assert.deepStrictEqual(result, {
        status: "failed",
        version: "18.12.6",
        stage: "ready",
        reason: "exit",
      });
    }),
  );

  it.effect("reports a failing `omp --version`", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ version: { stdout: "", exitCode: 2 } });
      const result = yield* probeOmp(INPUT).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
      );
      assert.deepStrictEqual(result, {
        status: "failed",
        version: null,
        stage: "version",
        reason: "exit",
      });
      assert.lengthOf(omp.launches, 1);
    }),
  );
});

describe("makeOmpProbeCache", () => {
  it.effect("reuses a probe result for 30 seconds per binary, profile and cwd", () =>
    Effect.gen(function* () {
      const cache = yield* makeOmpProbeCache();
      let probes = 0;
      const probe = Effect.sync((): OmpProbeResult => {
        probes += 1;
        return { status: "ready", version: "18.12.6", ready: { contractVersion: "1.0.0" } };
      });

      yield* cache.get(INPUT, probe);
      yield* cache.get(INPUT, probe);
      assert.strictEqual(probes, 1);

      yield* TestClock.adjust(OMP_PROBE_CACHE_TTL_MS - 1);
      yield* cache.get(INPUT, probe);
      assert.strictEqual(probes, 1);

      yield* TestClock.adjust("1 millis");
      yield* cache.get(INPUT, probe);
      assert.strictEqual(probes, 2);

      yield* cache.get({ ...INPUT, profile: "work" }, probe);
      assert.strictEqual(probes, 3);
    }),
  );

  it.effect("probes again when the binary at the same path was replaced", () =>
    Effect.gen(function* () {
      const cache = yield* makeOmpProbeCache();
      let probes = 0;
      const probe = Effect.sync((): OmpProbeResult => {
        probes += 1;
        return { status: "ready", version: "18.12.6", ready: { contractVersion: "1.0.0" } };
      });
      yield* cache.get({ ...INPUT, binaryIdentity: "1:100:5:1:1" }, probe);
      yield* cache.get({ ...INPUT, binaryIdentity: "1:100:5:1:1" }, probe);
      assert.strictEqual(probes, 1);
      yield* cache.get({ ...INPUT, binaryIdentity: "1:101:5:1:2" }, probe);
      assert.strictEqual(probes, 2);
    }),
  );

  it.effect("shares one probe between concurrent callers", () =>
    Effect.gen(function* () {
      const cache = yield* makeOmpProbeCache();
      let probes = 0;
      const probe = Effect.sleep("1 second").pipe(
        Effect.andThen(
          Effect.sync((): OmpProbeResult => {
            probes += 1;
            return { status: "ready", version: null, ready: {} };
          }),
        ),
      );
      const callers = yield* Effect.all([cache.get(INPUT, probe), cache.get(INPUT, probe)], {
        concurrency: "unbounded",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(callers);
      assert.strictEqual(probes, 1);
    }),
  );
});
