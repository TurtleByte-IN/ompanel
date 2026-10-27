import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ProviderInstanceEnvironment,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
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
import { ompThreadOverlayPath } from "./launch.ts";
import { ompStateDirs } from "./session.ts";

// Offline: with no bundled or cached sidecar the driver would download the pinned release.
const offlineFetch: typeof globalThis.fetch = () => Promise.reject(new Error("offline in tests"));

const layerTest = TestProviderHost.layer({
  cwd: "/machine",
  settings: DEFAULT_SERVER_SETTINGS,
  runBackgroundWork: false,
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Layer.succeed(FetchHttpClient.Fetch, offlineFetch)),
);

const encoder = new TextEncoder();
const SKILL_LIST = {
  skills: [
    {
      name: "tdd",
      description: "Test first",
      filePath: "/repo/.omp/skills/tdd/SKILL.md",
      baseDir: "/repo/.omp/skills/tdd",
      source: "native:project",
      hide: false,
    },
  ],
  warnings: [],
};

const UP_TO_DATE = "Current version: 18.12.6\n✔ Already up to date\n";

const fakeOmp = (contractVersion: string | undefined, update = UP_TO_DATE) => {
  const launches: Array<ChildProcess.StandardCommand> = [];
  /** Completed by the first thread (`--mode rpc-ui`) launch. */
  const threadSpawned = Deferred.makeUnsafe<void>();
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    launches.push(command);
    const ready = {
      type: "ready",
      protocolVersion: 1,
      ...(contractVersion ? { contractVersion } : {}),
    };
    const stdin = command.options.stdin;
    // The RPC server answers each command: `get_available_commands` with two commands, anything
    // else (`get_login_providers`) with no providers.
    const responses = (Stream.isStream(stdin) ? stdin : Stream.empty).pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => {
        const { id, type } = JSON.parse(line) as { id: string; type: string };
        const data =
          type === "get_available_commands"
            ? {
                commands: [
                  { name: "compact", source: "builtin", description: "Compact the context" },
                  { name: "skill:tdd", source: "skill" },
                ],
              }
            : { providers: [] };
        return { type: "response", id, command: type, success: true, data };
      }),
    );
    const stdout = command.args.includes("--version")
      ? Stream.succeed("omp/18.12.6\n")
      : command.args.includes("update")
        ? Stream.succeed(update)
        : command.args.includes("skill")
          ? Stream.succeed(`${JSON.stringify(SKILL_LIST)}\n`)
          : Stream.concat(Stream.succeed(ready), responses).pipe(
              Stream.map((frame) => `${JSON.stringify(frame)}\n`),
            );
    return Effect.as(
      command.args.includes("rpc-ui") ? Deferred.succeed(threadSpawned, undefined) : Effect.void,
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
  return { spawner, launches, threadSpawned };
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

const create = (
  config: Partial<OmpSettings>,
  enabled = true,
  environment: ProviderInstanceEnvironment = [],
) =>
  OmpDriver.create({
    instanceId: ProviderInstanceId.make("omp"),
    displayName: undefined,
    environment,
    enabled,
    config: { ...OmpDriver.defaultConfig(), ...config },
  });

type OmpInstance = Effect.Success<ReturnType<typeof create>>;

const THREAD_ID = ThreadId.make("thread-1");

/**
 * Starts every kind of omp an instance runs: the probe (`--version`, `--mode rpc`), a workspace
 * catalog (`skill list` and `--mode rpc`), text generation (`-p`) and a thread (`--mode rpc-ui`).
 */
const runEveryOmp = (instance: OmpInstance, threadSpawned: Deferred.Deferred<void>) =>
  Effect.gen(function* () {
    yield* instance.snapshot.refresh;
    yield* instance.snapshotForCwd!("/repo").pipe(Effect.exit);
    // The fake's `-p` output is no title; only the launch matters here.
    yield* instance.textGeneration
      .generateThreadTitle({
        cwd: "/repo",
        message: "Fix the login form",
        modelSelection: { instanceId: instance.instanceId, model: "default" },
      })
      .pipe(Effect.exit);
    const opening = yield* instance.orchestrationAdapter
      .openSession({
        threadId: THREAD_ID,
        providerSessionId: ProviderSessionId.make("session-1"),
        modelSelection: { instanceId: instance.instanceId, model: "default" },
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "approval-required",
          interactionMode: "default",
          cwd: null,
        }),
      })
      .pipe(Effect.scoped, Effect.exit, Effect.forkChild);
    // The fake never completes the thread handshake; the spawn is all this needs.
    yield* Deferred.await(threadSpawned);
    yield* Fiber.interrupt(opening);
  });

/** The launches that run omp itself (a wrapper keeps omp's path in its argv), not `ps` and the like. */
const ompLaunches = (launches: ReadonlyArray<ChildProcess.StandardCommand>, binaryPath: string) =>
  launches.filter((launch) => launch.command === binaryPath || launch.args.includes(binaryPath));

const launchKind = (launch: ChildProcess.StandardCommand) =>
  launch.args.includes("--version")
    ? "version"
    : launch.args.includes("skill")
      ? "skill"
      : launch.args.includes("rpc-ui")
        ? "thread"
        : launch.args.includes("-p")
          ? "text"
          : launch.args.includes("rpc")
            ? "rpc"
            : "other";

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
      // T3 never imitates Auto by answering approvals itself, and OMP has no automatic review.
      assert.notInclude(snapshot.supportedRuntimeModes ?? [], "auto");
      assert.isTrue(omp.launches.every((launch) => launch.command === binaryPath));
      assert.includeMembers([...(omp.launches.at(-1)?.args ?? [])], ["--profile", "work"]);
    }).pipe(Effect.scoped),
  );

  it.effect("shows an available OMP update on the snapshot without anyone asking", () =>
    Effect.gen(function* () {
      const omp = fakeOmp(
        OMP_LOCK.contract.version,
        "Current version: 18.12.6\nNew version available: 18.13.0\n",
      );
      const binaryPath = yield* overrideBinary;
      const instance = yield* create({ binaryPath }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
      );
      const noticing = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.versionAdvisory !== undefined),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      const noticed = yield* Fiber.join(noticing);
      const advisory = noticed._tag === "Some" ? noticed.value.versionAdvisory : undefined;
      assert.deepStrictEqual(advisory, {
        status: "behind_latest",
        currentVersion: "18.12.6",
        latestVersion: "18.13.0",
        updateCommand: null,
        canUpdate: false,
        canInstallVersion: false,
        checkedAt: advisory?.checkedAt ?? null,
        message: `OMP 18.13.0 is out. Ompanel runs ${binaryPath}; update it with the app or tool that installed it.`,
      });
      // The check only reports; nothing ever runs `omp update` without `--check`.
      const updates = omp.launches.filter((launch) => launch.args.includes("update"));
      assert.isAbove(updates.length, 0);
      assert.isTrue(updates.every((launch) => launch.args.includes("--check")));
    }).pipe(Effect.scoped),
  );

  it.effect("lists a workspace's commands and skills once and puts them on the snapshot", () =>
    Effect.gen(function* () {
      const omp = fakeOmp(OMP_LOCK.contract.version);
      const binaryPath = yield* overrideBinary;
      const instance = yield* create({ binaryPath }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
      );
      yield* instance.snapshot.refresh;
      const catalogOnly = () => omp.launches.filter((launch) => !launch.args.includes("update"));
      const before = catalogOnly().length;
      const publishedSnapshot = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.workspaceSnapshots !== undefined),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      const workspace = yield* instance.snapshotForCwd!("/repo");
      assert.deepStrictEqual(
        workspace.slashCommands.map((command) => command.name),
        ["compact", "goal"],
      );
      assert.deepStrictEqual(workspace.slashCommands[0], {
        name: "compact",
        description: "Compact the context",
      });
      assert.deepStrictEqual(workspace.skills, [
        {
          name: "tdd",
          path: "/repo/.omp/skills/tdd/SKILL.md",
          enabled: true,
          description: "Test first",
          scope: "project",
        },
      ]);
      assert.strictEqual(workspace.slashCommandsPending, false);
      const catalogLaunches = catalogOnly().slice(before);
      // Both run at once, each behind its own sidecar check, so their order is not fixed.
      assert.sameDeepMembers(
        catalogLaunches.map((launch) => [launch.args.includes("skill"), launch.options.cwd]),
        [
          [false, "/repo"],
          [true, "/repo"],
        ],
      );
      yield* instance.snapshotForCwd!("/repo");
      assert.strictEqual(catalogOnly().length, before + 2, "the same workspace reuses its lists");

      const published = yield* Fiber.join(publishedSnapshot);
      assert.deepStrictEqual(
        published._tag === "Some"
          ? published.value.workspaceSnapshots?.map((entry) => entry.cwd)
          : null,
        ["/repo"],
      );
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
  it.effect("runs every omp with the agent dir; launch args reach rpc, rpc-ui and -p only", () =>
    Effect.gen(function* () {
      const omp = fakeOmp(OMP_LOCK.contract.version);
      const binaryPath = yield* overrideBinary;
      const instance = yield* create({
        binaryPath,
        agentDir: "/srv/omp-work/agent",
        launchArgs: "--thinking high --no-lsp",
      }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner));
      yield* runEveryOmp(instance, omp.threadSpawned);

      const launches = ompLaunches(omp.launches, binaryPath);
      const kinds = new Set(launches.map(launchKind));
      for (const kind of ["version", "rpc", "skill", "text", "thread"] as const) {
        assert.isTrue(kinds.has(kind), `no ${kind} launch`);
      }
      for (const launch of launches) {
        const kind = launchKind(launch);
        assert.strictEqual(
          launch.options.env?.["PI_CODING_AGENT_DIR"],
          "/srv/omp-work/agent",
          kind,
        );
        if (kind === "rpc" || kind === "text" || kind === "thread") {
          assert.deepStrictEqual(launch.args.slice(-3), ["--thinking", "high", "--no-lsp"], kind);
        } else {
          // `--version` and subcommands take their own flags only.
          assert.notInclude([...launch.args], "--thinking", kind);
        }
      }
    }).pipe(Effect.scoped),
  );

  it.effect("refuses launch args that set a flag Ompanel owns, on the status and every spawn", () =>
    Effect.gen(function* () {
      const binaryPath = yield* overrideBinary;
      const instance = yield* create({ binaryPath, launchArgs: "--cwd /elsewhere" }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Refused launch args must not spawn")),
        ),
      );
      yield* instance.snapshot.refresh;
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.strictEqual(snapshot.status, "error");
      assert.include(snapshot.message, "'--cwd' is set by Ompanel");
      const error = yield* instance.textGeneration
        .generateThreadTitle({
          cwd: "/repo",
          message: "Fix the login form",
          modelSelection: { instanceId: instance.instanceId, model: "default" },
        })
        .pipe(Effect.flip);
      assert.include(error.message, "'--cwd' is set by Ompanel");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses an agent dir beside a profile on the status", () =>
    Effect.gen(function* () {
      const binaryPath = yield* overrideBinary;
      const instance = yield* create({ binaryPath, profile: "work", agentDir: "/srv/agent" }).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die("Refused settings must not spawn")),
        ),
      );
      yield* instance.snapshot.refresh;
      const snapshot = yield* instance.snapshot.getSnapshot;
      assert.strictEqual(snapshot.status, "error");
      assert.include(snapshot.message, "not both");
    }).pipe(Effect.scoped),
  );

  // 9.7b: OMP's OTLP export stays governed by OMP's own `telemetry.*` settings and the user's
  // `OTEL_*` environment; Ompanel adds neither.
  it.effect("never sets OMP telemetry or OTEL_* beyond the user's environment", () =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const path = yield* Path.Path;
      const fileSystem = yield* FileSystem.FileSystem;
      const otelOf = (env: NodeJS.ProcessEnv | undefined) =>
        Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => key.startsWith("OTEL_")));
      const userOtel = otelOf(process.env);
      const exported = {
        name: "OTEL_EXPORTER_OTLP_ENDPOINT",
        value: "http://collector:4318",
        sensitive: false,
      };

      for (const environment of [
        [],
        [exported],
      ] satisfies ReadonlyArray<ProviderInstanceEnvironment>) {
        const omp = fakeOmp(OMP_LOCK.contract.version);
        const binaryPath = yield* overrideBinary;
        const instance = yield* create({ binaryPath }, true, environment).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
        );
        yield* runEveryOmp(instance, omp.threadSpawned);
        const expected =
          environment.length === 0 ? userOtel : { ...userOtel, [exported.name]: exported.value };
        const launches = ompLaunches(omp.launches, binaryPath);
        assert.isTrue(launches.some((launch) => launchKind(launch) === "thread"));
        for (const launch of launches) {
          assert.deepStrictEqual(otelOf(launch.options.env), expected, launchKind(launch));
          assert.isFalse(
            launch.args.some((arg) => /telemetry/i.test(arg)),
            `${launchKind(launch)} argv sets telemetry`,
          );
        }
        // The thread's `--config` overlay carries no `telemetry` key either.
        const overlay = yield* fileSystem.readFileString(
          ompThreadOverlayPath(path, ompStateDirs(path, host.paths.stateDir).threads, THREAD_ID),
        );
        assert.notMatch(overlay, /telemetry/i);
      }
    }).pipe(Effect.scoped),
  );
});
