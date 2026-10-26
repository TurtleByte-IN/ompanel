import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import type { ExtensionUiRequest } from "../../contract/src/wire.generated.ts";
import {
  makeOmpControlService,
  OMP_CONTROL_CACHE_TTL_MS,
  OMP_CONTROL_KILL_GRACE_MS,
  OMP_CONTROL_RPC_ARGS,
  OMP_CONTROL_TIMEOUTS_MS,
  type OmpControlBudget,
  type OmpControlError,
  type OmpControlService,
  type OmpControlTarget,
} from "./control.ts";

const encoder = new TextEncoder();
const READY = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  contractVersion: "1.0.0",
};
const LOGIN_PROVIDERS = [
  { id: "anthropic", name: "Anthropic", available: true, authenticated: true },
  { id: "openai-codex", name: "OpenAI Codex", available: true, authenticated: false },
];
const USAGE_JSON = JSON.stringify(
  {
    generatedAt: 1_790_000_000_000,
    reports: [
      {
        provider: "anthropic",
        fetchedAt: 1_790_000_000_000,
        limits: [{ id: "5h", label: "5 hours", scope: {}, amount: { usedFraction: 0.25 } }],
      },
    ],
    accountsWithoutUsage: [],
    disabledCredentials: [],
    capacity: {},
  },
  null,
  2,
);

/** Answers one inbound RPC frame with the frames OMP would write. */
type RpcServer = (frame: Record<string, unknown>) => ReadonlyArray<unknown>;
type Behaviour =
  | { readonly stdout: string; readonly exitCode: number }
  | { readonly rpc: RpcServer }
  | "hang";

const answerLoginProviders: RpcServer = (frame) =>
  frame["type"] === "get_login_providers"
    ? [
        { type: "available_commands_update", commands: [] },
        {
          type: "response",
          id: frame["id"],
          command: "get_login_providers",
          success: true,
          data: { providers: LOGIN_PROVIDERS },
        },
      ]
    : [];

function handle(command: ChildProcess.StandardCommand, behaviour: Behaviour) {
  const base = {
    // Outside the valid PID range, so cleanup cannot signal a real process.
    pid: ChildProcessSpawner.ProcessId(999_999_998),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  };
  if (behaviour === "hang") {
    return ChildProcessSpawner.makeHandle({
      ...base,
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      stdout: Stream.never,
      stderr: Stream.never,
    });
  }
  if ("rpc" in behaviour) {
    const stdin = command.options.stdin;
    const inbound = Stream.isStream(stdin) ? stdin : Stream.empty;
    const frames = inbound.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.flatMap((line) =>
        Stream.fromIterable(behaviour.rpc(JSON.parse(line) as Record<string, unknown>)),
      ),
    );
    return ChildProcessSpawner.makeHandle({
      ...base,
      exitCode: Effect.never,
      isRunning: Effect.succeed(true),
      stdout: Stream.concat(Stream.succeed(READY), frames).pipe(
        Stream.map((frame) => encoder.encode(`${JSON.stringify(frame)}\n`)),
      ),
      stderr: Stream.empty,
    });
  }
  return ChildProcessSpawner.makeHandle({
    ...base,
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(behaviour.exitCode)),
    isRunning: Effect.succeed(false),
    stdout: Stream.succeed(encoder.encode(behaviour.stdout)),
    stderr: Stream.empty,
  });
}

interface FakeOmp {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly launches: Array<ChildProcess.StandardCommand>;
  /** Spawn scopes closed so far; the real spawner stops the process group there. */
  readonly stopped: number;
}

function fakeOmp(
  input: {
    readonly version?: Behaviour;
    readonly usage?: Behaviour;
    readonly rpc?: Behaviour;
  } = {},
): FakeOmp {
  const launches: Array<ChildProcess.StandardCommand> = [];
  let stopped = 0;
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    launches.push(command);
    const behaviour = command.args.includes("--version")
      ? (input.version ?? { stdout: "omp/18.12.6\n", exitCode: 0 })
      : command.args.includes("usage")
        ? (input.usage ?? { stdout: USAGE_JSON, exitCode: 0 })
        : (input.rpc ?? { rpc: answerLoginProviders });
    // The real spawner stops the process group when this scope closes.
    return Effect.addFinalizer(() => Effect.sync(() => void stopped++)).pipe(
      Effect.as(handle(command, behaviour)),
    );
  });
  return {
    spawner,
    launches,
    get stopped() {
      return stopped;
    },
  };
}

const TARGET: OmpControlTarget = {
  binaryPath: "/opt/ompanel/omp",
  profile: "",
  environment: { HOME: "/home/tester" },
  cwd: "/workspace",
};

const withControl = <A, E>(
  omp: FakeOmp,
  use: (control: OmpControlService) => Effect.Effect<A, E>,
) =>
  makeOmpControlService().pipe(
    Effect.flatMap(use),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
    Effect.scoped,
  );

describe("OmpControlService.probe", () => {
  it.effect("reads the version, the ready frame and the login providers", () =>
    Effect.gen(function* () {
      const omp = fakeOmp();
      const result = yield* withControl(omp, (control) =>
        control.probe({ ...TARGET, profile: "work" }),
      );
      assert.deepStrictEqual(result, {
        status: "ready",
        version: "18.12.6",
        ready: { protocolVersion: 1, contractVersion: "1.0.0" },
        loginProviders: LOGIN_PROVIDERS,
      });
      const [version, rpc] = omp.launches;
      assert.strictEqual(version?.command, "/opt/ompanel/omp");
      assert.deepStrictEqual(version?.args, ["--version"]);
      assert.deepStrictEqual(rpc?.args, ["--profile", "work", ...OMP_CONTROL_RPC_ARGS]);
      assert.strictEqual(rpc?.options.cwd, "/workspace");
      assert.strictEqual(rpc?.options.extendEnv, false);
      for (const launch of omp.launches) {
        assert.strictEqual(
          Duration.toMillis(Duration.fromInputUnsafe(launch.options.forceKillAfter!)),
          OMP_CONTROL_KILL_GRACE_MS,
        );
      }
      assert.strictEqual(omp.stopped, 2);
    }),
  );

  it.effect("keeps a ready server whose login-provider request fails", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({
        rpc: {
          rpc: (frame) => [
            {
              type: "response",
              id: frame["id"],
              command: frame["type"],
              success: false,
              error: "no",
            },
          ],
        },
      });
      const result = yield* withControl(omp, (control) => control.probe(TARGET));
      assert.strictEqual(result.status, "ready");
      assert.isTrue(result.status === "ready" && result.loginProviders === null);
    }),
  );

  it.effect("rejects an RPC server whose first frame is not ready", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ rpc: { stdout: '{"type":"response"}\n', exitCode: 0 } });
      const result = yield* withControl(omp, (control) => control.probe(TARGET));
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
      const result = yield* withControl(omp, (control) => control.probe(TARGET));
      assert.deepStrictEqual(result, {
        status: "failed",
        version: "18.12.6",
        stage: "ready",
        reason: "exit",
      });
    }),
  );

  it.effect("reports a failing `omp --version` without starting the RPC server", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ version: { stdout: "", exitCode: 2 } });
      const result = yield* withControl(omp, (control) => control.probe(TARGET));
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

describe("OmpControlService deadlines", () => {
  const cases: ReadonlyArray<{
    readonly budget: OmpControlBudget;
    readonly behaviour: Parameters<typeof fakeOmp>[0];
    readonly run: (control: OmpControlService) => Effect.Effect<unknown, OmpControlError>;
  }> = [
    { budget: "version", behaviour: { version: "hang" }, run: (c) => c.version(TARGET) },
    { budget: "usage", behaviour: { usage: "hang" }, run: (c) => c.usage(TARGET) },
    { budget: "ready", behaviour: { rpc: "hang" }, run: (c) => c.loginProviders(TARGET) },
    {
      budget: "login",
      behaviour: { rpc: { rpc: () => [] } },
      run: (c) => c.login(TARGET, "anthropic", () => Effect.succeed(undefined)),
    },
  ];

  it.effect.each(cases)("stops a hung $budget at its deadline", ({ budget, behaviour, run }) =>
    Effect.gen(function* () {
      const omp = fakeOmp(behaviour);
      yield* withControl(omp, (control) =>
        Effect.gen(function* () {
          const running = yield* run(control).pipe(Effect.result, Effect.forkChild);
          yield* TestClock.adjust(OMP_CONTROL_TIMEOUTS_MS[budget] - 1);
          assert.isUndefined(running.pollUnsafe());
          assert.strictEqual(omp.stopped, 0);
          yield* TestClock.adjust("1 millis");
          const result = yield* Fiber.join(running);
          assert.isTrue(Result.isFailure(result));
          if (Result.isFailure(result)) {
            assert.strictEqual(result.failure.reason, "timeout");
            assert.strictEqual(result.failure.timeoutMs, OMP_CONTROL_TIMEOUTS_MS[budget]);
          }
          assert.strictEqual(omp.stopped, 1);
        }),
      );
    }),
  );

  it.effect("stops the probe's RPC server when it never reports ready", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ rpc: "hang" });
      yield* withControl(omp, (control) =>
        Effect.gen(function* () {
          const probing = yield* control.probe(TARGET).pipe(Effect.forkChild);
          yield* TestClock.adjust(OMP_CONTROL_TIMEOUTS_MS.ready);
          assert.deepStrictEqual(yield* Fiber.join(probing), {
            status: "failed",
            version: "18.12.6",
            stage: "ready",
            reason: "timeout",
          });
          assert.strictEqual(omp.stopped, 2);
        }),
      );
    }),
  );
});

describe("OmpControlService cache", () => {
  it.effect("reuses a probe for 30 seconds within one instance only", () =>
    Effect.gen(function* () {
      const omp = fakeOmp();
      const probes = () => omp.launches.filter((launch) => launch.args.includes("--version"));
      yield* withControl(omp, (control) =>
        Effect.gen(function* () {
          yield* control.probe(TARGET);
          yield* control.probe(TARGET);
          assert.lengthOf(probes(), 1);

          yield* TestClock.adjust(OMP_CONTROL_CACHE_TTL_MS - 1);
          yield* control.probe(TARGET);
          assert.lengthOf(probes(), 1);

          yield* TestClock.adjust("1 millis");
          yield* control.probe(TARGET);
          assert.lengthOf(probes(), 2);

          yield* control.probe({ ...TARGET, profile: "work" });
          assert.lengthOf(probes(), 3);
          yield* control.probe({ ...TARGET, binaryIdentity: "swapped" });
          assert.lengthOf(probes(), 4);
        }),
      );
      // A second instance has its own cache.
      yield* withControl(omp, (control) => control.probe(TARGET));
      assert.lengthOf(probes(), 5);
    }),
  );

  it.effect("shares one probe between concurrent callers", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ version: "hang" });
      yield* withControl(omp, (control) =>
        Effect.gen(function* () {
          const callers = yield* Effect.all([control.probe(TARGET), control.probe(TARGET)], {
            concurrency: "unbounded",
          }).pipe(Effect.forkChild);
          yield* TestClock.adjust(OMP_CONTROL_TIMEOUTS_MS.version);
          yield* Fiber.join(callers);
          assert.lengthOf(omp.launches, 1);
        }),
      );
    }),
  );

  it.effect("caches usage, but not a failed usage run", () =>
    Effect.gen(function* () {
      const omp = fakeOmp();
      const usage = () => omp.launches.filter((launch) => launch.args.includes("usage"));
      const failing = fakeOmp({ usage: { stdout: "", exitCode: 1 } });
      yield* withControl(failing, (control) =>
        Effect.gen(function* () {
          const error = yield* control.usage(TARGET).pipe(Effect.flip);
          assert.strictEqual(error.reason, "exit");
          assert.strictEqual(error.exitCode, 1);
          yield* control.usage(TARGET).pipe(Effect.flip);
          assert.lengthOf(failing.launches, 2);
        }),
      );
      yield* withControl(omp, (control) =>
        Effect.gen(function* () {
          const report = yield* control.usage({ ...TARGET, profile: "work" });
          assert.strictEqual(report.reports[0]?.provider, "anthropic");
          yield* control.usage({ ...TARGET, profile: "work" });
          assert.lengthOf(usage(), 1);
          assert.deepStrictEqual(usage()[0]?.args, ["--profile", "work", "usage", "--json"]);
          yield* control.usage({ ...TARGET, profile: "work" }, { provider: "anthropic" });
          assert.deepStrictEqual(usage()[1]?.args, [
            "--profile",
            "work",
            "usage",
            "--json",
            "--provider",
            "anthropic",
          ]);
        }),
      );
    }),
  );

  it.effect("reports unreadable usage output", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ usage: { stdout: "No credentials found.\n", exitCode: 0 } });
      const error = yield* withControl(omp, (control) => control.usage(TARGET).pipe(Effect.flip));
      assert.strictEqual(error.reason, "invalid");
      assert.notInclude(error.message, "No credentials");
    }),
  );
});

describe("OmpControlService.login", () => {
  it.effect("forwards the URL and the pasted code, then drops the cache", () =>
    Effect.gen(function* () {
      let loginId: unknown;
      const received: Array<unknown> = [];
      const omp = fakeOmp({
        rpc: {
          rpc: (frame) => {
            if (frame["type"] === "get_login_providers") return answerLoginProviders(frame);
            if (frame["type"] === "login") {
              loginId = frame["id"];
              return [
                {
                  type: "extension_ui_request",
                  id: "ui-1",
                  method: "open_url",
                  url: "https://auth.example/authorize",
                },
                { type: "extension_ui_request", id: "ui-2", method: "input", title: "Code" },
              ];
            }
            received.push(frame);
            return frame["type"] === "extension_ui_response" && frame["id"] === "ui-2"
              ? [{ type: "response", id: loginId, command: "login", success: true, data: {} }]
              : [];
          },
        },
      });
      const requests: Array<ExtensionUiRequest> = [];
      yield* withControl(omp, (control) =>
        Effect.gen(function* () {
          yield* control.probe(TARGET);
          yield* control.login(TARGET, "anthropic", (request) =>
            Effect.sync(() => {
              requests.push(request);
              return request.method === "input"
                ? { type: "extension_ui_response" as const, id: request.id, value: "code-123" }
                : undefined;
            }),
          );
          yield* control.probe(TARGET);
        }),
      );
      assert.deepStrictEqual(
        requests.map((request) => request.method),
        ["open_url", "input"],
      );
      assert.deepStrictEqual(received, [
        { type: "extension_ui_response", id: "ui-2", value: "code-123" },
      ]);
      assert.lengthOf(
        omp.launches.filter((launch) => launch.args.includes("--version")),
        2,
      );
    }),
  );

  it.effect("reports a refused login", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({
        rpc: {
          rpc: (frame) => [
            {
              type: "response",
              id: frame["id"],
              command: "login",
              success: false,
              error: "Unknown OAuth provider: nope",
            },
          ],
        },
      });
      const error = yield* withControl(omp, (control) =>
        control.login(TARGET, "nope", () => Effect.succeed(undefined)).pipe(Effect.flip),
      );
      assert.strictEqual(error.reason, "rejected");
      assert.strictEqual(error.detail, "Unknown OAuth provider: nope");
    }),
  );
});

// A real binary that ignores SIGTERM and leaves a grandchild: the deadline must SIGKILL the group.
describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "OmpControlService with a hung executable",
  () => {
    const TIMEOUT_MS = 300;
    const GRACE_MS = 300;

    const isAlive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };

    const hungOmp = Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "omp-hung-" });
      const binaryPath = path.join(dir, "omp");
      const pidFile = path.join(dir, "pids");
      yield* fileSystem.writeFileString(
        binaryPath,
        `#!/bin/sh\ntrap '' TERM\nsleep 300 &\necho "$$ $!" >> "${pidFile}"\nwhile :; do wait; done\n`,
      );
      yield* fileSystem.chmod(binaryPath, 0o755);
      const target: OmpControlTarget = {
        binaryPath,
        profile: "",
        environment: { PATH: "/usr/bin:/bin" },
        cwd: dir,
      };
      const pids = fileSystem.readFileString(pidFile).pipe(
        Effect.map((text) => text.split(/\s+/).filter(Boolean).map(Number)),
        Effect.orElseSucceed(() => [] as Array<number>),
      );
      return { target, pids };
    });

    const cases: ReadonlyArray<{
      readonly budget: OmpControlBudget;
      readonly run: (
        control: OmpControlService,
        target: OmpControlTarget,
      ) => Effect.Effect<unknown, OmpControlError>;
    }> = [
      { budget: "version", run: (c, t) => c.version(t) },
      { budget: "usage", run: (c, t) => c.usage(t) },
      { budget: "ready", run: (c, t) => c.loginProviders(t) },
      { budget: "login", run: (c, t) => c.login(t, "anthropic", () => Effect.succeed(undefined)) },
    ];

    it.live.each(cases)("kills a hung $budget process group with no orphan", ({ budget, run }) =>
      Effect.gen(function* () {
        const { target, pids } = yield* hungOmp;
        const control = yield* makeOmpControlService({
          timeoutsMs: { [budget]: TIMEOUT_MS },
          killGraceMs: GRACE_MS,
        });
        const [elapsed, error] = yield* run(control, target).pipe(
          Effect.asVoid,
          Effect.flip,
          Effect.timed,
          Effect.map(([duration, failure]) => [Duration.toMillis(duration), failure] as const),
        );
        assert.strictEqual(error.reason, "timeout");
        // SIGTERM is ignored, so only SIGKILL after the grace ends the call.
        assert.isAtLeast(elapsed, TIMEOUT_MS + GRACE_MS - 50);
        const launched = yield* pids;
        assert.lengthOf(launched, 2, "the fake omp and its grandchild started");
        assert.deepStrictEqual(
          launched.filter(isAlive),
          [],
          `still running after the ${budget} deadline`,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
