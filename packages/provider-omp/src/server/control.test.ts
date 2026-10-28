import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
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

import type { CliSkillList } from "../../contract/src/cli.generated.ts";
import type { ExtensionUiRequest } from "../../contract/src/wire.generated.ts";
import {
  makeOmpControlService,
  OMP_CONTROL_CACHE_TTL_MS,
  OMP_CONTROL_KILL_GRACE_MS,
  OMP_CONTROL_RPC_ARGS,
  OMP_CONTROL_TIMEOUTS_MS,
  OMP_SETUP_PLACEHOLDER_MODEL,
  type OmpControlBudget,
  type OmpControlError,
  type OmpControlService,
  type OmpControlTarget,
  type OmpSkillList,
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
const statsTotals = (requests: number, cost: number) => ({
  totalRequests: requests,
  successfulRequests: requests - 1,
  failedRequests: 1,
  errorRate: 1 / requests,
  totalInputTokens: 1_000 * requests,
  totalOutputTokens: 100 * requests,
  totalCacheReadTokens: 5_000 * requests,
  totalCacheWriteTokens: 0,
  cacheRate: 0.8,
  cacheSavings: 0.5,
  totalCost: cost,
  unpricedRequests: 0,
  totalPremiumRequests: 0,
  avgDuration: 1_200,
  avgTtft: 300,
  avgTokensPerSecond: 80,
  firstTimestamp: 1_789_000_000_000,
  lastTimestamp: 1_790_000_000_000,
});
/** `omp stats --json` as the pinned omp prints it: `DashboardStats`, pretty-printed. */
const STATS_JSON = JSON.stringify(
  {
    overall: statsTotals(12, 1.5),
    byModel: [{ ...statsTotals(12, 1.5), model: "claude-sonnet-4-5", provider: "anthropic" }],
    byFolder: [],
    byAgentType: [],
    timeSeries: [],
    modelSeries: [],
    modelPerformanceSeries: [],
    costSeries: [],
  },
  null,
  2,
);

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
const SKILL_LIST = {
  skills: [
    {
      name: "tdd",
      description: "Test first",
      filePath: "/workspace/.omp/skills/tdd/SKILL.md",
      baseDir: "/workspace/.omp/skills/tdd",
      source: "native:project",
      hide: false,
    },
  ],
  warnings: [{ skillPath: "/workspace/.omp/skills/bad", message: "missing description" }],
} satisfies CliSkillList & OmpSkillList;
const SKILL_LIST_JSON = `${JSON.stringify(SKILL_LIST)}\n`;

/** Answers one inbound RPC frame with the frames OMP would write. */
type RpcServer = (frame: Record<string, unknown>) => ReadonlyArray<unknown>;
type Behaviour =
  | { readonly stdout: string; readonly exitCode: number; readonly stderr?: string }
  | { readonly rpc: RpcServer }
  | "hang";

/** What `omp --mode rpc` prints at the pinned tag before exiting 1 on a fresh install. */
const NO_MODEL_STDERR = [
  "No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.",
  "",
  "Set an API key environment variable:",
  "  ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, etc.",
  "",
].join("\n");

const CATALOG = [
  {
    id: "claude-sonnet-4-5",
    name: "Claude Sonnet 4.5",
    provider: "anthropic",
    reasoning: true,
    thinking: { efforts: ["low", "medium", "high"] },
  },
];

const answerLoginProviders: RpcServer = (frame) =>
  frame["type"] === "get_available_models"
    ? [
        {
          type: "response",
          id: frame["id"],
          command: "get_available_models",
          success: true,
          data: { models: CATALOG.map((model) => ({ ...model, api: "anthropic-messages" })) },
        },
      ]
    : frame["type"] === "get_login_providers"
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
    stderr:
      behaviour.stderr === undefined
        ? Stream.empty
        : Stream.succeed(encoder.encode(behaviour.stderr)),
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
    readonly stats?: Behaviour;
    readonly rpc?: Behaviour;
    readonly config?: Behaviour;
    readonly skills?: Behaviour;
    readonly plugins?: Behaviour;
    readonly update?: Behaviour;
    readonly gh?: Behaviour;
    /** RPC servers started without `--model` exit as a fresh install does; with it they run. */
    readonly unconfigured?: boolean;
  } = {},
): FakeOmp {
  const launches: Array<ChildProcess.StandardCommand> = [];
  let stopped = 0;
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    launches.push(command);
    const behaviour =
      command.args[0] === "auth"
        ? (input.gh ?? { stdout: "", exitCode: 0 })
        : command.args.includes("--version")
          ? (input.version ?? { stdout: "omp/18.12.6\n", exitCode: 0 })
          : command.args.includes("stats")
            ? (input.stats ?? { stdout: `${STATS_JSON}\n`, exitCode: 0 })
            : command.args.includes("usage")
              ? (input.usage ?? { stdout: USAGE_JSON, exitCode: 0 })
              : command.args.includes("config")
                ? (input.config ?? { stdout: "{}\n", exitCode: 0 })
                : command.args.includes("skill")
                  ? (input.skills ?? { stdout: SKILL_LIST_JSON, exitCode: 0 })
                  : command.args.includes("plugin")
                    ? (input.plugins ?? { stdout: '{"npm":[],"marketplace":[]}\n', exitCode: 0 })
                    : command.args.includes("update")
                      ? (input.update ?? { stdout: "Current version: 18.12.6\n", exitCode: 0 })
                      : input.unconfigured === true && !command.args.includes("--model")
                        ? { stdout: "", exitCode: 1, stderr: NO_MODEL_STDERR }
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
  it.effect("reads the version, the ready frame, the login providers and the models", () =>
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
        models: CATALOG,
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
      assert.isTrue(result.status === "ready" && result.models === null);
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

  it.effect("tells a fresh install's no-model refusal apart from a crash (ompanel#144)", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ unconfigured: true });
      const [result, again] = yield* withControl(omp, (control) =>
        Effect.all([control.probe(TARGET), control.probe(TARGET)]),
      );
      // Not cached: `omp setup` in a terminal ends this state, and the next check must see it.
      assert.deepStrictEqual(again, result);
      assert.lengthOf(
        omp.launches.filter((launch) => launch.args.includes("--version")),
        2,
      );
      assert.deepStrictEqual(result, {
        status: "failed",
        version: "18.12.6",
        stage: "ready",
        reason: "unconfigured",
      });
      // The probe never papers over the refusal with a placeholder model.
      assert.isFalse(omp.launches.some((launch) => launch.args.includes("--model")));
      const crashed = yield* withControl(
        fakeOmp({ rpc: { stdout: "", exitCode: 1, stderr: "Segmentation fault\n" } }),
        (control) => control.probe(TARGET),
      );
      assert.deepStrictEqual(crashed, {
        status: "failed",
        version: "18.12.6",
        stage: "ready",
        reason: "exit",
      });
    }),
  );

  it.effect("lists login providers on a fresh install through a placeholder model", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ unconfigured: true });
      const list = yield* withControl(omp, (control) => control.loginProviders(TARGET));
      assert.deepStrictEqual(list.providers, LOGIN_PROVIDERS);
      const rpcLaunches = omp.launches.filter((launch) => launch.args.includes("rpc"));
      assert.lengthOf(rpcLaunches, 2);
      assert.isFalse(rpcLaunches[0]!.args.includes("--model"));
      assert.deepStrictEqual(rpcLaunches[1]!.args.slice(-2), [
        "--model",
        OMP_SETUP_PLACEHOLDER_MODEL,
      ]);
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
    { budget: "stats", behaviour: { stats: "hang" }, run: (c) => c.stats(TARGET) },
    { budget: "ready", behaviour: { rpc: "hang" }, run: (c) => c.loginProviders(TARGET) },
    {
      budget: "login",
      behaviour: { rpc: { rpc: () => [] } },
      // @effect-diagnostics-next-line effectSucceedWithVoid:off - A UI response is undefined, not void.
      run: (c) => c.login(TARGET, "anthropic", () => Effect.succeed(undefined)),
    },
    { budget: "config", behaviour: { config: "hang" }, run: (c) => c.configList(TARGET) },
    { budget: "catalog", behaviour: { skills: "hang" }, run: (c) => c.skillList(TARGET) },
    { budget: "plugins", behaviour: { plugins: "hang" }, run: (c) => c.pluginList(TARGET) },
    {
      budget: "plugins",
      behaviour: { plugins: "hang" },
      run: (c) => c.marketplaceDiscover(TARGET, "trailofbits"),
    },
    {
      budget: "pluginCommand",
      behaviour: { plugins: "hang" },
      run: (c) => c.pluginCommand(TARGET, ["plugin", "install", "exa"]),
    },
    { budget: "update", behaviour: { update: "hang" }, run: (c) => c.updateCheck(TARGET) },
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

describe("OmpControlService.stats", () => {
  it.effect("reads `omp stats --json` for the profile and caches it", () =>
    Effect.gen(function* () {
      const omp = fakeOmp();
      const stats = () => omp.launches.filter((launch) => launch.args.includes("stats"));
      yield* withControl(omp, (control) =>
        Effect.gen(function* () {
          const report = yield* control.stats({ ...TARGET, profile: "work" });
          assert.strictEqual(report.overall.totalRequests, 12);
          assert.strictEqual(report.overall.totalCost, 1.5);
          assert.strictEqual(report.byModel[0]?.model, "claude-sonnet-4-5");
          yield* control.stats({ ...TARGET, profile: "work" });
          assert.lengthOf(stats(), 1);
          assert.deepStrictEqual(stats()[0]?.args, ["--profile", "work", "stats", "--json"]);
        }),
      );
    }),
  );

  it.effect("reports a failing or unreadable stats run without its output, uncached", () =>
    Effect.gen(function* () {
      const failing = fakeOmp({ stats: { stdout: "", exitCode: 2 } });
      yield* withControl(failing, (control) =>
        Effect.gen(function* () {
          const error = yield* control.stats(TARGET).pipe(Effect.flip);
          assert.strictEqual(error.operation, "stats");
          assert.strictEqual(error.reason, "exit");
          assert.strictEqual(error.exitCode, 2);
          yield* control.stats(TARGET).pipe(Effect.flip);
          assert.lengthOf(failing.launches, 2);
        }),
      );
      const garbled = fakeOmp({ stats: { stdout: "Dashboard secret-token\n", exitCode: 0 } });
      const error = yield* withControl(garbled, (control) =>
        control.stats(TARGET).pipe(Effect.flip),
      );
      assert.strictEqual(error.reason, "invalid");
      assert.notInclude(error.message, "secret-token");
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
            if (
              frame["type"] === "get_login_providers" ||
              frame["type"] === "get_available_models"
            ) {
              return answerLoginProviders(frame);
            }
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
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - A UI response is undefined, not void.
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
      { budget: "stats", run: (c, t) => c.stats(t) },
      { budget: "ready", run: (c, t) => c.loginProviders(t) },
      // @effect-diagnostics-next-line effectSucceedWithVoid:off - A UI response is undefined, not void.
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

describe("OmpControlService catalogs", () => {
  it.effect("lists the target directory's skills with `omp skill list <dir> --json`", () =>
    Effect.gen(function* () {
      const omp = fakeOmp();
      const list = yield* withControl(omp, (control) =>
        control.skillList({ ...TARGET, profile: "work" }),
      );
      assert.deepStrictEqual(list, SKILL_LIST);
      assert.deepStrictEqual(omp.launches[0]?.args, [
        "--profile",
        "work",
        "skill",
        "list",
        "/workspace",
        "--json",
      ]);
      assert.strictEqual(omp.stopped, 1);
    }),
  );

  it.effect("reports a failing or unreadable skill list", () =>
    Effect.gen(function* () {
      const failed = yield* withControl(fakeOmp({ skills: { stdout: "", exitCode: 2 } }), (c) =>
        c.skillList(TARGET).pipe(Effect.flip),
      );
      assert.deepStrictEqual(
        [failed.operation, failed.reason, failed.exitCode],
        ["skill_list", "exit", 2],
      );
      const invalid = yield* withControl(
        fakeOmp({ skills: { stdout: '{"skills":[{"name":1}]}', exitCode: 0 } }),
        (c) => c.skillList(TARGET).pipe(Effect.flip),
      );
      assert.strictEqual(invalid.reason, "invalid");
    }),
  );

  it.effect("reads `omp plugin list --json` and reports unreadable or failing runs", () =>
    Effect.gen(function* () {
      const omp = fakeOmp();
      const list = yield* withControl(omp, (control) =>
        control.pluginList({ ...TARGET, profile: "work" }),
      );
      assert.deepStrictEqual(list, { npm: [], marketplace: [] });
      assert.deepStrictEqual(omp.launches[0]?.args, [
        "--profile",
        "work",
        "plugin",
        "list",
        "--json",
      ]);
      const invalid = yield* withControl(
        fakeOmp({ plugins: { stdout: '{"npm":[{"name":1}]}', exitCode: 0 } }),
        (c) => c.pluginList(TARGET).pipe(Effect.flip),
      );
      assert.deepStrictEqual([invalid.operation, invalid.reason], ["plugin_list", "invalid"]);
      const failed = yield* withControl(fakeOmp({ plugins: { stdout: "", exitCode: 1 } }), (c) =>
        c.pluginCommand(TARGET, ["plugin", "uninstall", "x"]).pipe(Effect.flip),
      );
      assert.deepStrictEqual(
        [failed.operation, failed.reason, failed.exitCode],
        ["plugin_command", "exit", 1],
      );
    }),
  );

  it.effect("reads `get_available_commands` from a control server in the directory", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({
        rpc: {
          rpc: (frame) =>
            frame["type"] === "get_available_commands"
              ? [
                  { type: "available_commands_update", commands: [] },
                  {
                    type: "response",
                    id: frame["id"],
                    command: "get_available_commands",
                    success: true,
                    data: {
                      commands: [
                        {
                          name: "compact",
                          source: "builtin",
                          aliases: ["c"],
                          description: "Compact the context",
                          input: { hint: "focus" },
                          subcommands: [{ name: "now" }],
                        },
                        { name: "deploy", source: "file" },
                      ],
                    },
                  },
                ]
              : [],
        },
      });
      const commands = yield* withControl(omp, (control) => control.availableCommands(TARGET));
      assert.deepStrictEqual(commands, [
        {
          name: "compact",
          source: "builtin",
          aliases: ["c"],
          description: "Compact the context",
          input: { hint: "focus" },
        },
        { name: "deploy", source: "file" },
      ]);
      assert.deepStrictEqual(omp.launches[0]?.args, [...OMP_CONTROL_RPC_ARGS]);
      assert.strictEqual(omp.launches[0]?.options.cwd, "/workspace");
      assert.strictEqual(omp.stopped, 1);
    }),
  );

  it.effect("stops a control server that never lists its commands", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ rpc: { rpc: () => [] } });
      yield* withControl(omp, (control) =>
        Effect.gen(function* () {
          const running = yield* control
            .availableCommands(TARGET)
            .pipe(Effect.flip, Effect.forkChild);
          yield* TestClock.adjust(OMP_CONTROL_TIMEOUTS_MS.catalog);
          const error = yield* Fiber.join(running);
          assert.deepStrictEqual(
            [error.operation, error.reason],
            ["available_commands", "timeout"],
          );
          assert.strictEqual(omp.stopped, 1);
        }),
      );
    }),
  );
});

describe("OmpControlService.gistReady", () => {
  const WINDOWS_TARGET: OmpControlTarget = {
    ...TARGET,
    environment: { PATH: "C:\\Program Files\\GitHub CLI", PATHEXT: ".EXE" },
    cwd: "C:\\repo",
  };
  const asWindows = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
    resolve: (command: string) => string | undefined,
  ) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, resolve),
    );

  it.effect("runs gh by the absolute PATH location, not by name from the repository", () =>
    Effect.gen(function* () {
      const omp = fakeOmp();
      const ghPath = "C:\\Program Files\\GitHub CLI\\gh.exe";
      const state = yield* asWindows(
        withControl(omp, (control) => control.gistReady(WINDOWS_TARGET)),
        (command) => (command === "gh" ? ghPath : undefined),
      );
      assert.strictEqual(state, "ready");
      assert.strictEqual(omp.launches[0]?.command, ghPath);
      assert.deepStrictEqual(omp.launches[0]?.args, ["auth", "status"]);
      assert.strictEqual(omp.launches[0]?.options.cwd, "C:\\repo");
    }),
  );

  it.effect("reports a missing gh without starting anything", () =>
    Effect.gen(function* () {
      const omp = fakeOmp();
      const state = yield* asWindows(
        withControl(omp, (control) => control.gistReady(WINDOWS_TARGET)),
        () => undefined,
      );
      assert.strictEqual(state, "missing");
      assert.lengthOf(omp.launches, 0);
    }),
  );

  it.effect("reports a signed-out gh", () =>
    Effect.gen(function* () {
      const omp = fakeOmp({ gh: { stdout: "", exitCode: 1 } });
      const state = yield* asWindows(
        withControl(omp, (control) => control.gistReady(WINDOWS_TARGET)),
        () => "C:\\gh\\gh.exe",
      );
      assert.strictEqual(state, "signed_out");
    }),
  );
});
