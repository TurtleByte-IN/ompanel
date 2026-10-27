import { assert, describe, it } from "@effect/vitest";
import {
  formatOmpCommandLine,
  ompPluginCommandArgs,
  ompPluginTargetAllowed,
  ProviderSessionId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import {
  makeOmpControlService,
  OMP_CONTROL_TIMEOUTS_MS,
  parseOmpMarketplaceDiscover,
  parseOmpMarketplaceList,
  parseOmpUpdateCheck,
  type OmpControlTarget,
} from "./control.ts";
import { OmpRpcTimeoutError } from "./rpcProcess.ts";
import {
  makeOmpPluginsController,
  OMP_RELOAD_PLUGINS_COMMAND,
  OMP_RELOAD_PLUGINS_TIMEOUT_MS,
} from "./pluginsController.ts";
import type { OmpThreadSession } from "./threadSessions.ts";

const encoder = new TextEncoder();
type Behaviour = { readonly stdout: string; readonly exitCode: number } | "hang";

// What the pinned omp prints, captured from the real v18.12.6-ompanel.3 binary (`plugin list` is
// unchanged at v18.12.6-ompanel.4).
const PLUGIN_LIST_JSON = JSON.stringify(
  {
    npm: [
      {
        name: "@oh-my-pi/exa",
        version: "1.2.0",
        path: "/home/tester/.omp/plugins/node_modules/@oh-my-pi/exa",
        manifest: { version: "1.2.0", description: "Exa search tools" },
        enabledFeatures: null,
        enabled: false,
      },
    ],
    marketplace: [
      {
        id: "differential-review@trailofbits",
        scope: "user",
        entries: [
          {
            scope: "user",
            installPath:
              "/home/tester/.omp/plugins/cache/plugins/trailofbits___differential-review___1.1.4",
            version: "1.1.4",
            installedAt: "2026-10-06T14:32:54.471Z",
            lastUpdated: "2026-10-06T14:32:54.471Z",
          },
        ],
      },
      {
        id: "docker-skills@docker",
        scope: "user",
        entries: [
          {
            scope: "user",
            installPath: "/home/tester/.omp/plugins/cache/plugins/docker___docker-skills___0.3.1",
            version: "0.3.1",
            installedAt: "2026-10-06T14:32:54.628Z",
            lastUpdated: "2026-10-06T14:32:54.628Z",
            enabled: false,
          },
        ],
        shadowedBy: "project",
      },
    ],
  },
  null,
  2,
);
const MARKETPLACE_LIST = `Configured Marketplaces:

  trailofbits  trailofbits/skills
  docker  docker/skills
`;
const DISCOVER = `Available Plugins (trailofbits):

  audit-context-building@2.0.2
    Understand a codebase before looking for bugs in it.
  mattpocock-skills
    Matt Pocock's agent skills.
  no-description@0.1.0
`;
const SKILL_LIST_JSON = JSON.stringify({
  skills: [
    {
      name: "grilling",
      description: "Stress-test a plan",
      filePath: "/home/tester/.omp/plugins/cache/mattpocock/skills/grilling/SKILL.md",
      baseDir: "/home/tester/.omp/plugins/cache/mattpocock/skills/grilling",
      source: "claude-plugins:user",
      hide: true,
    },
  ],
  warnings: [{ skillPath: "/home/tester/.omp/agent/skills/bad", message: "missing description" }],
});

interface FakeOmp {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly launches: Array<ReadonlyArray<string>>;
}

/** A fake `omp` answering by the arguments after any `--profile`. */
function fakeOmp(answer: (args: ReadonlyArray<string>) => Behaviour | undefined): FakeOmp {
  const launches: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    launches.push(command.args);
    const args = command.args[0] === "--profile" ? command.args.slice(2) : command.args;
    const behaviour = answer(args);
    if (behaviour === undefined) return Effect.die(`Unexpected omp ${command.args.join(" ")}`);
    const base = {
      pid: ChildProcessSpawner.ProcessId(999_999_998),
      kill: () => Effect.void,
      unref: Effect.succeed(Effect.void),
      stdin: Sink.drain,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
    };
    return Effect.succeed(
      behaviour === "hang"
        ? ChildProcessSpawner.makeHandle({
            ...base,
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            stdout: Stream.never,
            stderr: Stream.never,
          })
        : ChildProcessSpawner.makeHandle({
            ...base,
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(behaviour.exitCode)),
            isRunning: Effect.succeed(false),
            stdout: Stream.succeed(encoder.encode(behaviour.stdout)),
            stderr: Stream.empty,
          }),
    );
  });
  return { spawner, launches };
}

const ok = (stdout: string): Behaviour => ({ stdout, exitCode: 0 });

/** The pinned omp's read commands, as captured. */
const reads = (args: ReadonlyArray<string>): Behaviour | undefined => {
  const line = args.join(" ");
  if (line === "plugin list --json") return ok(PLUGIN_LIST_JSON);
  if (line === "plugin marketplace list") return ok(MARKETPLACE_LIST);
  if (line === "plugin discover trailofbits") return ok(DISCOVER);
  if (line === "update --check") return ok("Current version: 18.12.6\n✔ Already up to date\n");
  if (args[0] === "skill") return ok(SKILL_LIST_JSON);
  return undefined;
};

const target = (cwd: string): Effect.Effect<OmpControlTarget> =>
  Effect.succeed({ binaryPath: "/opt/ompanel/omp", profile: "work", environment: {}, cwd });

const session = (
  threadId: string,
  request: OmpThreadSession["process"]["request"],
  busy = false,
): OmpThreadSession => ({
  threadId,
  providerSessionId: ProviderSessionId.make(`provider-${threadId}`),
  cwd: `/work/${threadId}`,
  process: { request },
  onRestartRequired: () => Effect.void,
  isBusy: () => busy,
  resolveProposal: () => Effect.die("not used"),
});

const controllerWith = (
  omp: FakeOmp,
  options: {
    readonly sessions?: ReadonlyArray<OmpThreadSession>;
    readonly onInvalidate?: () => void;
  } = {},
) =>
  makeOmpControlService().pipe(
    Effect.map((control) =>
      makeOmpPluginsController({
        control,
        target,
        globalCwd: "/state/launcher",
        sessions: { list: Effect.succeed(options.sessions ?? []) },
        invalidateCatalog: Effect.sync(() => options.onInvalidate?.()),
      }),
    ),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
  );

describe("OMP plugin commands", () => {
  it("maps each page action to exactly one omp plugin command", () => {
    assert.deepStrictEqual(ompPluginCommandArgs({ action: "install", spec: "x@trailofbits" }), [
      "plugin",
      "install",
      "x@trailofbits",
    ]);
    assert.deepStrictEqual(ompPluginCommandArgs({ action: "uninstall", name: "@oh-my-pi/exa" }), [
      "plugin",
      "uninstall",
      "@oh-my-pi/exa",
    ]);
    assert.deepStrictEqual(ompPluginCommandArgs({ action: "disable", name: "a@b" }), [
      "plugin",
      "disable",
      "a@b",
    ]);
    assert.deepStrictEqual(
      ompPluginCommandArgs({ action: "marketplace_add", source: "trailofbits/skills" }),
      ["plugin", "marketplace", "add", "trailofbits/skills"],
    );
    assert.deepStrictEqual(ompPluginCommandArgs({ action: "marketplace_remove", name: "docker" }), [
      "plugin",
      "marketplace",
      "remove",
      "docker",
    ]);
  });

  it("refuses targets that could read as flags or carry control characters", () => {
    assert.isTrue(ompPluginTargetAllowed("@oh-my-pi/exa[search]"));
    assert.isTrue(ompPluginTargetAllowed("https://github.com/user/repo#v1.0"));
    assert.isFalse(ompPluginTargetAllowed("--force"));
    assert.isFalse(ompPluginTargetAllowed(" exa"));
    assert.isFalse(ompPluginTargetAllowed("exa\n--force"));
    assert.isFalse(ompPluginTargetAllowed(""));
    assert.isFalse(ompPluginTargetAllowed("~/my-plugin"));
  });

  it("shows the command line the way a shell would take it", () => {
    assert.strictEqual(
      formatOmpCommandLine(["omp", "--profile", "work"], ["plugin", "install", "./my plugin"]),
      "omp --profile work plugin install './my plugin'",
    );
    assert.strictEqual(
      formatOmpCommandLine(["omp"], ["plugin", "install", "@oh-my-pi/exa[search]"]),
      "omp plugin install '@oh-my-pi/exa[search]'",
    );
    // Shell expansions (globs, zsh's `=`) are quoted, so the shown line runs what Ompanel runs.
    assert.strictEqual(
      formatOmpCommandLine(["omp"], ["plugin", "install", "=ls", "a*b", "it's"]),
      "omp plugin install '=ls' 'a*b' 'it'\\''s'",
    );
  });
});

describe("OMP text output parsers", () => {
  it("reads marketplaces, with or without terminal colours", () => {
    assert.deepStrictEqual(parseOmpMarketplaceList(MARKETPLACE_LIST), [
      { name: "trailofbits", source: "trailofbits/skills" },
      { name: "docker", source: "docker/skills" },
    ]);
    assert.deepStrictEqual(
      parseOmpMarketplaceList(
        "\u001b[1mConfigured Marketplaces:\u001b[22m\n\n  \u001b[36mx\u001b[39m  \u001b[2mo/r\u001b[22m\n",
      ),
      [{ name: "x", source: "o/r" }],
    );
    assert.deepStrictEqual(
      parseOmpMarketplaceList(
        "No marketplaces configured\n\nAdd one with: omp plugin marketplace add <source>\n",
      ),
      [],
    );
  });

  it("reads a marketplace's plugins with their versions and descriptions", () => {
    assert.deepStrictEqual(parseOmpMarketplaceDiscover(DISCOVER), [
      {
        name: "audit-context-building",
        version: "2.0.2",
        description: "Understand a codebase before looking for bugs in it.",
      },
      { name: "mattpocock-skills", description: "Matt Pocock's agent skills." },
      { name: "no-description", version: "0.1.0" },
    ]);
  });

  it("reads omp update --check without installing anything", () => {
    assert.deepStrictEqual(
      parseOmpUpdateCheck("Current version: 18.12.6\n✔ Already up to date\n"),
      {
        status: "current",
        currentVersion: "18.12.6",
        latestVersion: "18.12.6",
      },
    );
    assert.deepStrictEqual(
      parseOmpUpdateCheck("Current version: 18.12.6\nNew version available: 18.13.0\n"),
      { status: "available", currentVersion: "18.12.6", latestVersion: "18.13.0" },
    );
    assert.deepStrictEqual(
      parseOmpUpdateCheck(
        "/usr/local/bin/omp is installed and kept up to date by brew; update it from brew.\n",
      ),
      { status: "managed", currentVersion: null, latestVersion: null },
    );
  });
});

describe("OMP plugins controller", () => {
  it.effect("lists npm and marketplace plugins and marketplaces for the profile", () =>
    Effect.gen(function* () {
      const omp = fakeOmp(reads);
      const plugins = yield* controllerWith(omp);
      const list = yield* plugins.list;
      assert.deepStrictEqual(list, {
        command: ["omp", "--profile", "work"],
        plugins: [
          {
            id: "@oh-my-pi/exa",
            source: "npm",
            version: "1.2.0",
            enabled: false,
            description: "Exa search tools",
            shadowed: false,
          },
          {
            id: "differential-review@trailofbits",
            source: "marketplace",
            version: "1.1.4",
            enabled: true,
            scope: "user",
            shadowed: false,
          },
          {
            id: "docker-skills@docker",
            source: "marketplace",
            version: "0.3.1",
            enabled: false,
            scope: "user",
            shadowed: true,
          },
        ],
        marketplaces: [
          { name: "trailofbits", source: "trailofbits/skills" },
          { name: "docker", source: "docker/skills" },
        ],
      });
      assert.sameDeepMembers(omp.launches, [
        ["--profile", "work", "plugin", "list", "--json"],
        ["--profile", "work", "plugin", "marketplace", "list"],
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("runs the confirmed command, drops the skill catalog and lists again", () =>
    Effect.gen(function* () {
      let invalidated = 0;
      const omp = fakeOmp((args) =>
        args[1] === "install" ? ok("✔ Installed audit-context-building\n") : reads(args),
      );
      const plugins = yield* controllerWith(omp, { onInvalidate: () => void invalidated++ });
      const list = yield* plugins.run({
        action: "install",
        spec: "audit-context-building@trailofbits",
      });
      assert.deepStrictEqual(omp.launches[0], [
        "--profile",
        "work",
        "plugin",
        "install",
        "audit-context-building@trailofbits",
      ]);
      assert.strictEqual(invalidated, 1);
      assert.strictEqual(list.plugins.length, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("reports a failed command without OMP's output and lists nothing", () =>
    Effect.gen(function* () {
      let invalidated = 0;
      const omp = fakeOmp((args) =>
        args[1] === "uninstall" ? { stdout: "secret-ish output", exitCode: 1 } : reads(args),
      );
      const plugins = yield* controllerWith(omp, { onInvalidate: () => void invalidated++ });
      const error = yield* plugins.run({ action: "uninstall", name: "nope" }).pipe(Effect.flip);
      assert.strictEqual(error.reason, "omp_failed");
      assert.notInclude(error.message, "secret-ish");
      assert.strictEqual(invalidated, 0);
      assert.strictEqual(omp.launches.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("stops an install that outlives its deadline", () =>
    Effect.gen(function* () {
      const omp = fakeOmp((args) => (args[1] === "install" ? "hang" : reads(args)));
      const plugins = yield* controllerWith(omp);
      const running = yield* plugins
        .run({ action: "install", spec: "slow" })
        .pipe(Effect.flip, Effect.forkChild);
      yield* TestClock.adjust(OMP_CONTROL_TIMEOUTS_MS.pluginCommand);
      const error = yield* Fiber.join(running);
      assert.strictEqual(error.reason, "timeout");
    }).pipe(Effect.scoped),
  );

  it.effect("browses one marketplace, checks for updates and lists skills", () =>
    Effect.gen(function* () {
      const omp = fakeOmp(reads);
      const plugins = yield* controllerWith(omp);
      const browsed = yield* plugins.discover("trailofbits");
      assert.strictEqual(browsed.marketplace, "trailofbits");
      assert.strictEqual(browsed.plugins.length, 3);
      assert.deepStrictEqual(yield* plugins.checkUpdate, {
        status: "current",
        currentVersion: "18.12.6",
        latestVersion: "18.12.6",
      });
      const skills = yield* plugins.skills;
      assert.deepStrictEqual(skills.skills, [
        {
          name: "grilling",
          description: "Stress-test a plan",
          filePath: "/home/tester/.omp/plugins/cache/mattpocock/skills/grilling/SKILL.md",
          source: "claude-plugins:user",
          hidden: true,
        },
      ]);
      assert.strictEqual(skills.warnings.length, 1);
      assert.deepStrictEqual(omp.launches.at(-1), [
        "--profile",
        "work",
        "skill",
        "list",
        "/state/launcher",
        "--json",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("sends /reload-plugins to idle threads and leaves busy ones alone", () =>
    Effect.gen(function* () {
      let invalidated = 0;
      const sent: Array<{ command: string; params: unknown; timeoutMs: number | undefined }> = [];
      const answering = session("a", ((
        command: string,
        params: unknown,
        options?: { timeoutMs?: number },
      ) => {
        sent.push({ command, params, timeoutMs: options?.timeoutMs });
        return Effect.succeed({ agentInvoked: false });
      }) as never);
      const busy = session("b", (() => Effect.die("must not be asked")) as never, true);
      const hung = session("c", (() =>
        Effect.fail(
          new OmpRpcTimeoutError({ command: "prompt", timeoutMs: OMP_RELOAD_PLUGINS_TIMEOUT_MS }),
        )) as never);
      const plugins = yield* controllerWith(fakeOmp(reads), {
        sessions: [answering, busy, hung],
        onInvalidate: () => void invalidated++,
      });
      assert.deepStrictEqual(yield* plugins.reload, { reloaded: 1, busy: 1, failed: 1 });
      assert.deepStrictEqual(sent, [
        {
          command: "prompt",
          params: { message: OMP_RELOAD_PLUGINS_COMMAND },
          timeoutMs: OMP_RELOAD_PLUGINS_TIMEOUT_MS,
        },
      ]);
      assert.strictEqual(invalidated, 1);
    }).pipe(Effect.scoped),
  );
});
