import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";

import type { ExtensionUiRequest } from "../../contract/src/wire.generated.ts";
import {
  makeOmpControlService,
  OMP_CONTROL_RPC_ARGS,
  type OmpControlBudget,
  type OmpControlError,
  type OmpControlService,
  type OmpControlServiceOptions,
  type OmpControlTarget,
} from "./control.ts";
import { allDead, waitUntil } from "./testing/fakeOmp.ts";
import {
  type FakeOmpCliCommand,
  type FakeOmpControl,
  type FakeOmpControlStep,
  makeFakeOmpControl,
  PINNED_API_KEY_CANCELLED,
  PINNED_API_KEY_LOGIN_REQUESTS,
  PINNED_CONFIG_LIST,
  PINNED_CONFIG_RESET,
  PINNED_CONFIG_SET,
  PINNED_LOGIN_PROVIDERS,
  PINNED_OAUTH_LOGIN_REQUESTS,
  PINNED_PLUGIN_LIST,
  PINNED_READY,
  PINNED_USAGE,
  pinnedSkillList,
} from "./testing/fakeOmpControl.ts";

/** Short enough to keep a hung case quick, long enough for node to start under CI load. */
const DEADLINE_MS = 750;
const KILL_GRACE_MS = 250;

/** Runs `use` with a control service over the real spawner and a fresh fake omp. */
const withFakeOmp = <A, E>(
  use: (omp: FakeOmpControl, control: OmpControlService) => Effect.Effect<A, E>,
  options: OmpControlServiceOptions = {},
) =>
  Effect.gen(function* () {
    const omp = yield* makeFakeOmpControl;
    const control = yield* makeOmpControlService(options);
    return yield* use(omp, control);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer));

/** Every fake omp started so far has exited or been killed. */
const expectAllStopped = (omp: FakeOmpControl) =>
  Effect.gen(function* () {
    const pids = omp.starts().map((start) => start.pid);
    assert.isNotEmpty(pids, "the fake omp started");
    assert.isTrue(yield* waitUntil(() => allDead(pids), 5_000), `still running: ${pids.join(" ")}`);
  });

interface CliCase {
  readonly name: string;
  readonly command: FakeOmpCliCommand;
  readonly operation: OmpControlError["operation"];
  readonly budget: OmpControlBudget;
  readonly run: (
    control: OmpControlService,
    target: OmpControlTarget,
  ) => Effect.Effect<unknown, OmpControlError>;
  readonly argv: (workspace: string) => ReadonlyArray<string>;
  /** What the service returns for the pinned output. */
  readonly expected: (workspace: string) => unknown;
  /** Output that parses as JSON but not as this command's shape. */
  readonly wrongShape: string;
}

const { capacity: _capacity, ...USAGE_AS_READ } = PINNED_USAGE;

const CLI_CASES: ReadonlyArray<CliCase> = [
  {
    name: "config list",
    command: "config list",
    operation: "config_list",
    budget: "config",
    run: (control, target) => control.configList(target),
    argv: (workspace) => ["config", "list", "--json", "--cwd", workspace],
    expected: () => PINNED_CONFIG_LIST,
    wrongShape: '{"theme.dark":{"type":"colour","description":"","source":"default"}}\n',
  },
  {
    name: "config set",
    command: "config set",
    operation: "config_set",
    budget: "config",
    run: (control, target) =>
      control.configSet(target, { key: "theme.dark", value: "dark-plus", scope: "global" }),
    argv: (workspace) => [
      "config",
      "set",
      "--scope",
      "global",
      "--cwd",
      workspace,
      "--json",
      "--",
      "theme.dark",
      '"dark-plus"',
    ],
    expected: () => PINNED_CONFIG_SET,
    wrongShape: '{"key":"theme.dark","scope":"session"}\n',
  },
  {
    name: "config reset",
    command: "config reset",
    operation: "config_reset",
    budget: "config",
    run: (control, target) =>
      control.configReset(target, { key: "compaction.enabled", scope: "project" }),
    argv: (workspace) => [
      "config",
      "reset",
      "--scope",
      "project",
      "--cwd",
      workspace,
      "--json",
      "--",
      "compaction.enabled",
    ],
    expected: () => PINNED_CONFIG_RESET,
    wrongShape: '{"scope":"project"}\n',
  },
  {
    name: "usage",
    command: "usage",
    operation: "usage",
    budget: "usage",
    run: (control, target) => control.usage(target),
    argv: () => ["usage", "--json"],
    // Only the envelope is read; OMP's extra top-level keys are dropped.
    expected: () => USAGE_AS_READ,
    wrongShape: '{"generatedAt":"now","reports":[]}\n',
  },
  {
    name: "skill list",
    command: "skill list",
    operation: "skill_list",
    budget: "catalog",
    run: (control, target) => control.skillList(target),
    argv: (workspace) => ["skill", "list", workspace, "--json"],
    expected: pinnedSkillList,
    wrongShape: '{"skills":[{"name":"tdd"}],"warnings":[]}\n',
  },
  {
    name: "plugin list",
    command: "plugin list",
    operation: "plugin_list",
    budget: "plugins",
    run: (control, target) => control.pluginList(target),
    argv: () => ["plugin", "list", "--json"],
    // Only the fields the Plugins page shows are read.
    expected: () => ({
      npm: PINNED_PLUGIN_LIST.npm.map(({ name, version, enabled, manifest }) => ({
        name,
        version,
        enabled,
        manifest: { description: manifest.description },
      })),
      marketplace: PINNED_PLUGIN_LIST.marketplace.map(({ id, scope, entries }) => ({
        id,
        scope,
        entries: entries.map(({ version }) => ({ version })),
      })),
    }),
    wrongShape: '{"npm":[{"name":"@oh-my-pi/exa"}],"marketplace":[]}\n',
  },
];

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "OmpControlService CLI commands against a fake omp executable",
  () => {
    it.live.each(CLI_CASES)("$name: reads the pinned omp's JSON", (testCase) =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          const result = yield* testCase.run(control, omp.target());
          assert.deepStrictEqual(result, testCase.expected(omp.workspace));
          const [start] = omp.starts();
          assert.deepStrictEqual(start?.argv, testCase.argv(omp.workspace));
          assert.strictEqual(start?.cwd, omp.workspace);
          yield* expectAllStopped(omp);
        }),
      ),
    );

    it.live.each(CLI_CASES)("$name: passes the profile before the command", (testCase) =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          yield* testCase.run(control, omp.target({}, { profile: "work" }));
          assert.deepStrictEqual(omp.starts()[0]?.argv, [
            "--profile",
            "work",
            ...testCase.argv(omp.workspace),
          ]);
        }),
      ),
    );

    it.live.each(CLI_CASES)("$name: rejects malformed JSON as invalid", (testCase) =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          const outputs = [
            // Cut off mid-object, as a crashed write would leave it.
            '{\n  "generatedAt": 17930322',
            "not json at all\n",
            testCase.wrongShape,
          ];
          for (const stdout of outputs) {
            const error = yield* testCase
              .run(control, omp.target({ cli: { [testCase.command]: { stdout } } }))
              .pipe(Effect.asVoid, Effect.flip);
            assert.deepStrictEqual(
              [error.operation, error.reason],
              [testCase.operation, "invalid"],
              stdout,
            );
          }
        }),
      ),
    );

    it.live.each(CLI_CASES)("$name: reports a non-zero exit without its output", (testCase) =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          const stdout = `${JSON.stringify(testCase.expected(omp.workspace))}\n`;
          const error = yield* testCase
            .run(
              control,
              omp.target({
                cli: {
                  [testCase.command]: {
                    stdout,
                    stderr: "Error: token sk-secret-123 rejected\n",
                    exitCode: 3,
                  },
                },
              }),
            )
            .pipe(Effect.asVoid, Effect.flip);
          assert.deepStrictEqual(
            [error.operation, error.reason, error.exitCode],
            [testCase.operation, "exit", 3],
          );
          assert.notInclude(error.message, "sk-secret-123");
        }),
      ),
    );

    it.live.each(CLI_CASES)("$name: stops a hung omp at the deadline", (testCase) =>
      withFakeOmp(
        (omp, control) =>
          Effect.gen(function* () {
            const error = yield* testCase
              .run(control, omp.target({ cli: { [testCase.command]: { hang: true } } }))
              .pipe(Effect.asVoid, Effect.flip);
            assert.deepStrictEqual(
              [error.operation, error.reason, error.timeoutMs],
              [testCase.operation, "timeout", DEADLINE_MS],
            );
            yield* expectAllStopped(omp);
          }),
        { timeoutsMs: { [testCase.budget]: DEADLINE_MS }, killGraceMs: KILL_GRACE_MS },
      ),
    );
  },
);

const {
  openUrl: OAUTH_OPEN_URL,
  notify: OAUTH_NOTIFY,
  input: OAUTH_INPUT,
} = PINNED_OAUTH_LOGIN_REQUESTS;
const { openUrl: KEY_OPEN_URL, input: KEY_INPUT } = PINNED_API_KEY_LOGIN_REQUESTS;

/** The pinned OAuth flow: URL, progress, then the pasted code; `after` runs once it is answered. */
const oauthLogin = (
  after: ReadonlyArray<FakeOmpControlStep>,
): ReadonlyArray<FakeOmpControlStep> => [
  { emit: OAUTH_OPEN_URL },
  { emit: OAUTH_NOTIFY },
  { emit: OAUTH_INPUT },
  { await: OAUTH_INPUT.id },
  ...after,
];

/** A UI handler that records every request and answers `input` with `answer`. */
const recordingHandler = (
  answer: (request: ExtensionUiRequest) => Effect.Effect<string | undefined>,
) => {
  const requests: Array<ExtensionUiRequest> = [];
  const handler = (request: ExtensionUiRequest) =>
    Effect.gen(function* () {
      requests.push(request);
      if (request.method !== "input") return undefined;
      const value = yield* answer(request);
      return value === undefined
        ? { type: "extension_ui_response" as const, id: request.id, cancelled: true as const }
        : { type: "extension_ui_response" as const, id: request.id, value };
    });
  return { requests, handler };
};

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "OmpControlService RPC control servers against a fake omp executable",
  () => {
    it.live("lists login providers from a fresh control server", () =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          const list = yield* control.loginProviders(omp.target());
          assert.deepStrictEqual(list, {
            contractVersion: PINNED_READY.contractVersion,
            providers: PINNED_LOGIN_PROVIDERS.providers,
          });
          const [start] = omp.starts();
          assert.deepStrictEqual(start?.argv.slice(0, -1), [...OMP_CONTROL_RPC_ARGS, "--config"]);
          // The overlay keeps the project's own MCP servers (`.mcp.json`) from starting.
          assert.deepStrictEqual(start?.configs, ["mcp:\n  enableProjectConfig: false\n"]);
          assert.isNull(start?.overlay);
          assert.deepStrictEqual(omp.frames(), [
            { type: "get_login_providers", id: "ompanel-control-0" },
          ]);
          yield* expectAllStopped(omp);
        }),
      ),
    );

    it.live("rejects a malformed provider list or ready frame as invalid", () =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          const badList = yield* control
            .loginProviders(
              omp.target({
                rpc: {
                  commands: {
                    get_login_providers: [{ respond: { providers: [{ id: "anthropic" }] } }],
                  },
                },
              }),
            )
            .pipe(Effect.flip);
          assert.deepStrictEqual(
            [badList.operation, badList.reason],
            ["login_providers", "invalid"],
          );
          // Stray text is dropped; the first JSON frame must still be `ready`.
          const badReady = yield* control
            .loginProviders(
              omp.target({
                rpc: { beforeReady: [{ raw: "Loading models...\n" }], ready: { type: "hello" } },
              }),
            )
            .pipe(Effect.flip);
          assert.deepStrictEqual(
            [badReady.operation, badReady.reason],
            ["login_providers", "invalid"],
          );
          yield* expectAllStopped(omp);
        }),
      ),
    );

    it.live("reports an omp that refuses to start without a model, even on the placeholder", () =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          const error = yield* control
            .loginProviders(
              omp.target({
                rpc: {
                  beforeReady: [
                    {
                      stderr:
                        "No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.\n",
                    },
                    { exit: 1 },
                  ],
                },
              }),
            )
            .pipe(Effect.flip);
          // Real stderr is read: the refusal is `unconfigured`, retried once on the placeholder
          // model, which this fake refuses too.
          assert.deepStrictEqual(
            [error.operation, error.reason, error.exitCode],
            ["login_providers", "unconfigured", 1],
          );
        }),
      ),
    );

    it.live("stops a control server that never becomes ready", () =>
      withFakeOmp(
        (omp, control) =>
          Effect.gen(function* () {
            const error = yield* control
              .loginProviders(omp.target({ rpc: { beforeReady: [{ hang: true }] } }))
              .pipe(Effect.flip);
            assert.deepStrictEqual(
              [error.operation, error.reason, error.timeoutMs],
              ["login_providers", "timeout", DEADLINE_MS],
            );
            yield* expectAllStopped(omp);
          }),
        { timeoutsMs: { ready: DEADLINE_MS }, killGraceMs: KILL_GRACE_MS },
      ),
    );
  },
);

describe.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "OmpControlService login sessions against a fake omp executable",
  () => {
    it.live("completes an OAuth login with the pasted code", () =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          const { requests, handler } = recordingHandler(() => Effect.succeed("auth-code-123"));
          yield* control.login(
            omp.target({
              rpc: { commands: { login: oauthLogin([{ respond: { providerId: "anthropic" } }]) } },
            }),
            "anthropic",
            handler,
          );
          // The unprompted widget frame after `ready` reaches the handler too, as with OMP.
          assert.deepStrictEqual(
            requests.map((request) => request.method),
            ["setWidget", "open_url", "notify", "input"],
          );
          assert.deepStrictEqual(requests[1], OAUTH_OPEN_URL);
          assert.deepStrictEqual(omp.frames(), [
            { type: "login", providerId: "anthropic", id: "ompanel-control-0" },
            { type: "extension_ui_response", id: OAUTH_INPUT.id, value: "auth-code-123" },
          ]);
          yield* expectAllStopped(omp);
        }),
      ),
    );

    it.live("sends an API key inside the login command, never as a prompt", () =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          // @effect-diagnostics-next-line effectSucceedWithVoid:off - A UI response is undefined, not void.
          const { requests, handler } = recordingHandler(() => Effect.succeed(undefined));
          yield* control.login(
            omp.target({ rpc: { commands: { login: [{ respond: { providerId: "xai" } }] } } }),
            "xai",
            handler,
            { input: Redacted.make("xai-test-key"), secretInput: true },
          );
          assert.deepStrictEqual(
            requests.map((request) => request.method),
            ["setWidget"],
          );
          assert.deepStrictEqual(omp.frames(), [
            {
              type: "login",
              providerId: "xai",
              input: "xai-test-key",
              secretInput: true,
              id: "ompanel-control-0",
            },
          ]);
        }),
      ),
    );

    it.live("refuses to send a key to an omp older than the input contract", () =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          const error = yield* control
            .login(
              omp.target({ rpc: { ready: { ...PINNED_READY, contractVersion: "1.5.0" } } }),
              "xai",
              // @effect-diagnostics-next-line effectSucceedWithVoid:off - A UI response is undefined, not void.
              () => Effect.succeed(undefined),
              { input: Redacted.make("xai-test-key") },
            )
            .pipe(Effect.flip);
          assert.deepStrictEqual([error.operation, error.reason], ["login", "unsupported"]);
          assert.deepStrictEqual(omp.frames(), []);
          yield* expectAllStopped(omp);
        }),
      ),
    );

    it.live("reports a login the user cancels at the key prompt", () =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          // @effect-diagnostics-next-line effectSucceedWithVoid:off - A UI response is undefined, not void.
          const { handler } = recordingHandler(() => Effect.succeed(undefined));
          const error = yield* control
            .login(
              omp.target({
                rpc: {
                  commands: {
                    login: [
                      { emit: KEY_OPEN_URL },
                      { emit: KEY_INPUT },
                      { await: KEY_INPUT.id, onCancel: [{ fail: PINNED_API_KEY_CANCELLED }] },
                      { respond: { providerId: "xai" } },
                    ],
                  },
                },
              }),
              "xai",
              handler,
              { secretInput: true },
            )
            .pipe(Effect.flip);
          assert.deepStrictEqual(
            [error.operation, error.reason, error.detail],
            ["login", "rejected", PINNED_API_KEY_CANCELLED],
          );
          assert.deepStrictEqual(omp.frames(), [
            { type: "login", providerId: "xai", secretInput: true, id: "ompanel-control-0" },
            { type: "extension_ui_response", id: KEY_INPUT.id, cancelled: true },
          ]);
          yield* expectAllStopped(omp);
        }),
      ),
    );

    it.live("stops the login process when the caller cancels mid-prompt", () =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          const prompted = yield* Deferred.make<void>();
          // Like the Accounts page: the prompt waits on the user, who gives up instead.
          const { handler } = recordingHandler(() =>
            Deferred.succeed(prompted, undefined).pipe(Effect.andThen(Effect.never)),
          );
          const running = yield* control
            .login(
              omp.target({
                rpc: {
                  commands: { login: oauthLogin([{ respond: { providerId: "anthropic" } }]) },
                },
              }),
              "anthropic",
              handler,
            )
            .pipe(Effect.forkChild);
          yield* Deferred.await(prompted);
          const pids = omp.starts().map((start) => start.pid);
          assert.isFalse(allDead(pids), "the login session is running while it prompts");
          yield* Fiber.interrupt(running);
          yield* expectAllStopped(omp);
          // The cancelled session never answered the prompt.
          assert.deepStrictEqual(
            omp.frames().map((frame) => frame["type"]),
            ["login"],
          );
        }),
      ),
    );

    it.live("stops a login session that outlives its deadline", () =>
      withFakeOmp(
        (omp, control) =>
          Effect.gen(function* () {
            const { handler } = recordingHandler(() => Effect.never);
            const error = yield* control
              .login(
                omp.target({ rpc: { commands: { login: oauthLogin([]) } } }),
                "anthropic",
                handler,
              )
              .pipe(Effect.flip);
            assert.deepStrictEqual(
              [error.operation, error.reason, error.timeoutMs],
              ["login", "timeout", DEADLINE_MS],
            );
            yield* expectAllStopped(omp);
          }),
        { timeoutsMs: { login: DEADLINE_MS }, killGraceMs: KILL_GRACE_MS },
      ),
    );

    it.live("reports a refused login and keeps a typed key out of the detail", () =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          const unknown = yield* control
            .login(
              omp.target({
                rpc: { commands: { login: [{ fail: "Unknown login provider: nope" }] } },
              }),
              "nope",
              // @effect-diagnostics-next-line effectSucceedWithVoid:off - A UI response is undefined, not void.
              () => Effect.succeed(undefined),
            )
            .pipe(Effect.flip);
          assert.deepStrictEqual(
            [unknown.reason, unknown.detail],
            ["rejected", "Unknown login provider: nope"],
          );
          const quoted = yield* control
            .login(
              omp.target({
                rpc: { commands: { login: [{ fail: "xAI rejected key xai-test-key (401)" }] } },
              }),
              "xai",
              // @effect-diagnostics-next-line effectSucceedWithVoid:off - A UI response is undefined, not void.
              () => Effect.succeed(undefined),
              { input: Redacted.make("xai-test-key"), secretInput: true },
            )
            .pipe(Effect.flip);
          assert.deepStrictEqual(
            [quoted.reason, quoted.detail],
            ["rejected", "xAI rejected key [redacted] (401)"],
          );
        }),
      ),
    );

    it.live("reports an omp that dies mid-login", () =>
      withFakeOmp((omp, control) =>
        Effect.gen(function* () {
          const error = yield* control
            .login(
              omp.target({ rpc: { commands: { login: [{ emit: OAUTH_OPEN_URL }, { exit: 1 }] } } }),
              "anthropic",
              // @effect-diagnostics-next-line effectSucceedWithVoid:off - A UI response is undefined, not void.
              () => Effect.succeed(undefined),
            )
            .pipe(Effect.flip);
          assert.deepStrictEqual(
            [error.operation, error.reason, error.exitCode],
            ["login", "exit", 1],
          );
        }),
      ),
    );
  },
);
