// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Effect from "effect/Effect";

import type {
  CliConfigList,
  CliConfigResetResult,
  CliConfigSetResult,
  CliPluginList,
  CliSkillList,
} from "../../../contract/src/cli.generated.ts";
import type {
  GetLoginProvidersResult,
  InputUiRequest,
  NotifyUiRequest,
  OpenUrlUiRequest,
  ReadyEvent,
  SetWidgetUiRequest,
} from "../../../contract/src/wire.generated.ts";
import type { OmpControlTarget } from "../control.ts";

/**
 * What a one-shot CLI command does: print and exit, or hang until a signal stops it. `html` is
 * the page `--export <session> <out>` writes to `<out>`.
 */
export type FakeOmpCliOutput =
  | {
      readonly stdout?: string;
      readonly stderr?: string;
      readonly exitCode?: number;
      readonly html?: string;
    }
  | { readonly hang: true };

/**
 * One reaction of the fake RPC server, in order. `respond`/`fail` answer the triggering command
 * with its id (`null` sends no `data`); `"$id"` inside `emit` becomes that id. `await` waits for
 * the host's `extension_ui_response` to that UI request; a cancelled one runs `onCancel` instead
 * of the remaining steps.
 */
export type FakeOmpControlStep =
  | { readonly emit: unknown }
  | { readonly respond: unknown }
  | { readonly fail: string }
  /** Written to stdout verbatim. */
  | { readonly raw: string }
  | { readonly stderr: string }
  | { readonly await: string; readonly onCancel?: ReadonlyArray<FakeOmpControlStep> }
  /** Exits once stdout is flushed; later steps never run. */
  | { readonly exit: number }
  /** Stops answering and stays alive until a signal stops it. */
  | { readonly hang: true };

export interface FakeOmpControlRpc {
  /** Run before `ready`; an `exit` or `hang` here means `ready` never comes. */
  readonly beforeReady?: ReadonlyArray<FakeOmpControlStep>;
  readonly ready?: ReadyEvent | Record<string, unknown>;
  /** Unprompted frames OMP writes right after `ready`. */
  readonly afterReady?: ReadonlyArray<FakeOmpControlStep>;
  /** Steps per command `type`; an unscripted command fails as unknown. */
  readonly commands?: Readonly<Record<string, ReadonlyArray<FakeOmpControlStep>>>;
}

/** CLI commands by their words without flags: `--version`, `config list`, `usage`, ... */
export type FakeOmpCliCommand =
  | "--version"
  | "config list"
  | "config set"
  | "config reset"
  | "config path"
  | "usage"
  | "stats"
  | "skill list"
  | "plugin list"
  | "agents unpack"
  | "--export"
  | "share";

export interface FakeOmpControlScript {
  readonly cli?: Partial<Record<FakeOmpCliCommand, FakeOmpCliOutput>>;
  readonly rpc?: FakeOmpControlRpc;
}

const FAKE_OMP_CONTROL_FIXTURE = NodeURL.fileURLToPath(
  new URL("./fakeOmpControl.fixture.mjs", import.meta.url),
);

// Captured in a scratch HOME: CLI output from v18.12.6-ompanel.3 (unchanged at .6, whose CLI contract 1.1.0 only adds
// `config list --scope`), RPC
// frames from v18.12.6-ompanel.6. Shapes are checked against the vendored contracts; long values
// (URLs, provider and setting lists) are cut down, never reshaped.

const pretty = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;

/** `omp config list --json --cwd <ws>` after a global `theme.dark`, a project `compaction.enabled` and a credential. */
export const PINNED_CONFIG_LIST = {
  "auth.broker.url": { type: "string", description: "", source: "default" },
  "auth.broker.token": { redacted: true, type: "string", description: "", source: "global" },
  enabledModels: { value: [], type: "array", description: "", source: "default" },
  "theme.dark": {
    value: "dark-plus",
    type: "string",
    description: "Theme used when the terminal has a dark background",
    source: "global",
  },
  "compaction.enabled": {
    value: false,
    type: "boolean",
    description: "Automatically compact context when it gets too large",
    source: "project",
  },
  modelRoleStorage: {
    value: "global",
    type: "enum",
    description: "Where model selector role assignments are saved",
    source: "default",
  },
  modelRoles: { value: {}, type: "record", description: "", source: "default" },
} satisfies CliConfigList;

/** `omp config set --scope global --json -- theme.dark '"dark-plus"'`. */
export const PINNED_CONFIG_SET = {
  key: "theme.dark",
  scope: "global",
  value: "dark-plus",
} satisfies CliConfigSetResult;

/** `omp config reset --scope project --json -- compaction.enabled`: the default is back. */
export const PINNED_CONFIG_RESET = {
  key: "compaction.enabled",
  scope: "project",
  value: true,
} satisfies CliConfigResetResult;

/**
 * `omp usage --json`. The scratch HOME has no account, so the report is OMP's `UsageReport`
 * (`packages/ai/src/usage.ts`) for one Anthropic window; the envelope is the captured one.
 */
export const PINNED_USAGE = {
  generatedAt: 1_793_032_214_578,
  reports: [
    {
      provider: "anthropic",
      fetchedAt: 1_793_032_214_000,
      limits: [
        {
          id: "anthropic:5h",
          label: "5 Hour",
          scope: { provider: "anthropic", windowId: "5h" },
          window: {
            id: "5h",
            label: "5 Hour",
            durationMs: 18_000_000,
            resetsAt: 1_793_040_000_000,
          },
          amount: { used: 25, limit: 100, usedFraction: 0.25, unit: "percent" },
          status: "ok",
        },
      ],
    },
  ],
  accountsWithoutUsage: [],
  disabledCredentials: [],
  capacity: {},
};

/** `omp skill list <ws> --json` with one project skill. */
export const pinnedSkillList = (workspace: string) =>
  ({
    skills: [
      {
        name: "tdd",
        description: "Test first",
        filePath: `${workspace}/.omp/skills/tdd/SKILL.md`,
        baseDir: `${workspace}/.omp/skills/tdd`,
        source: "native:project",
        hide: false,
      },
    ],
    warnings: [],
  }) satisfies CliSkillList;

/** `omp plugin list --json` with one npm and one marketplace plugin, as the pinned omp prints. */
export const PINNED_PLUGIN_LIST = {
  npm: [
    {
      name: "@oh-my-pi/exa",
      version: "1.2.0",
      path: "/home/tester/.omp/plugins/node_modules/@oh-my-pi/exa",
      manifest: { version: "1.2.0", description: "Exa search tools" },
      enabledFeatures: null,
      enabled: true,
    },
  ],
  marketplace: [
    {
      id: "docker-skills@docker",
      scope: "user",
      entries: [
        {
          scope: "user",
          installPath: "/home/tester/.omp/plugins/cache/plugins/docker___docker-skills___0.3.1",
          version: "0.3.1",
          installedAt: "2026-10-26T16:50:12.000Z",
          lastUpdated: "2026-10-26T16:50:12.000Z",
        },
      ],
    },
  ],
} satisfies CliPluginList;

/** The `ready` frame of `omp --mode rpc`. */
export const PINNED_READY = {
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1_048_576,
  maxReassembledFrameBytes: 67_108_864,
  contractVersion: "1.10.0",
} satisfies ReadyEvent;

/** Frames OMP writes unprompted right after `ready` (the command list is cut to one entry). */
const PINNED_AFTER_READY: ReadonlyArray<FakeOmpControlStep> = [
  {
    emit: {
      type: "extension_ui_request",
      id: "15b5909fd3d9d7c0",
      method: "setWidget",
      widgetKey: "autoresearch",
    } satisfies SetWidgetUiRequest,
  },
  {
    emit: {
      type: "available_commands_update",
      commands: [{ name: "compact", source: "builtin", description: "Compact the context" }],
    },
  },
];

/** `get_login_providers` with `ANTHROPIC_API_KEY` set (four of the 92 providers). */
export const PINNED_LOGIN_PROVIDERS = {
  providers: [
    {
      id: "openai-codex",
      name: "ChatGPT Plus/Pro (Codex Subscription)",
      available: true,
      authenticated: false,
      apiKey: false,
    },
    {
      id: "anthropic",
      name: "Anthropic (Claude Pro/Max)",
      available: true,
      authenticated: true,
      apiKey: false,
      source: "env",
    },
    {
      id: "zai",
      name: "Z.AI (GLM Coding Plan)",
      available: true,
      authenticated: false,
      apiKey: true,
    },
    { id: "xai", name: "xAI API", available: true, authenticated: false, apiKey: true },
  ],
} satisfies GetLoginProvidersResult;

/** The UI requests of an Anthropic OAuth `login`, in order. */
export const PINNED_OAUTH_LOGIN_REQUESTS = {
  openUrl: {
    type: "extension_ui_request",
    id: "15b5909fe7d9d7c1",
    method: "open_url",
    url: "https://claude.ai/oauth/authorize?client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback",
    launchUrl: "http://localhost:54545/launch",
    instructions:
      "Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
  },
  notify: {
    type: "extension_ui_request",
    id: "15b5909fe7d9d7c2",
    method: "notify",
    message: "Waiting for browser authentication...",
    notifyType: "info",
  },
  input: {
    type: "extension_ui_request",
    id: "15b5909fe7d9d7c3",
    method: "input",
    title: "Paste the authorization code (or full redirect URL):",
    timeout: 600_000,
  },
} as const satisfies {
  readonly openUrl: OpenUrlUiRequest;
  readonly notify: NotifyUiRequest;
  readonly input: InputUiRequest;
};

/** The UI requests of an xAI API-key `login` with `secretInput: true` and no `input`. */
export const PINNED_API_KEY_LOGIN_REQUESTS = {
  openUrl: {
    type: "extension_ui_request",
    id: "15b59124a6502bbe",
    method: "open_url",
    url: "https://console.x.ai/team/default/api-keys",
    instructions: "Create or copy your API key from the xAI Console",
  },
  input: {
    type: "extension_ui_request",
    id: "15b59124a6502bbf",
    method: "input",
    title: "Paste your xAI API key",
    placeholder: "xai-...",
    timeout: 600_000,
    secret: true,
  },
} as const satisfies { readonly openUrl: OpenUrlUiRequest; readonly input: InputUiRequest };

/** OMP's answer when the API-key prompt is dismissed. */
export const PINNED_API_KEY_CANCELLED = "API key is required";

/** `omp --version`, the CLI commands with their pinned output, and a control server. */
const defaultScript = (workspace: string): Required<FakeOmpControlScript> => ({
  cli: {
    "--version": { stdout: "omp/18.12.6\n" },
    "config list": { stdout: pretty(PINNED_CONFIG_LIST) },
    "config set": { stdout: line(PINNED_CONFIG_SET) },
    "config reset": { stdout: line(PINNED_CONFIG_RESET) },
    usage: { stdout: pretty(PINNED_USAGE) },
    "skill list": { stdout: line(pinnedSkillList(workspace)) },
    "plugin list": { stdout: pretty(PINNED_PLUGIN_LIST) },
  },
  rpc: {
    ready: PINNED_READY,
    afterReady: PINNED_AFTER_READY,
    commands: { get_login_providers: [{ respond: PINNED_LOGIN_PROVIDERS }] },
  },
});

interface FakeOmpControlLogEntry {
  readonly event: "start" | "frame" | "hang";
  readonly pid?: number;
  readonly argv?: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly frame?: Record<string, unknown>;
  /** The `PI_CONFIG_FILES` overlay the process ran with. */
  readonly overlay?: string;
  /** The text of each `--config` file the process ran with, in argv order. */
  readonly configs?: ReadonlyArray<string>;
}

/**
 * A real `omp` executable for `OmpControlService` tests: a `#!/bin/sh` wrapper that execs the
 * fake, so the spawned pid is the fake's. Everything lives in a scratch directory removed with
 * the scope.
 */
export const makeFakeOmpControl = Effect.acquireRelease(
  Effect.sync(() =>
    NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-omp-control-"))),
  ),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
).pipe(
  Effect.map((dir) => {
    const binaryPath = NodePath.join(dir, "omp");
    NodeFS.writeFileSync(
      binaryPath,
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_OMP_CONTROL_FIXTURE)} "$@"\n`,
      { mode: 0o755 },
    );
    const workspace = NodePath.join(dir, "workspace");
    NodeFS.mkdirSync(workspace);
    const logFile = NodePath.join(dir, "log.jsonl");
    let scripts = 0;
    const entries = (): ReadonlyArray<FakeOmpControlLogEntry> =>
      NodeFS.existsSync(logFile)
        ? NodeFS.readFileSync(logFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((text) => JSON.parse(text) as FakeOmpControlLogEntry)
        : [];
    return {
      workspace,
      /**
       * A target whose omp follows `script`: each `cli` command and `rpc` part given replaces
       * the pinned default for it. `gh` puts a fake GitHub CLI on the PATH whose
       * `gh auth status` succeeds (`ready`) or fails (`signed_out`), or leaves none (`missing`);
       * either way the PATH then holds nothing else, so a real `gh` is never reached.
       */
      target: (
        script: FakeOmpControlScript = {},
        options: {
          readonly profile?: string;
          readonly gh?: "ready" | "signed_out" | "missing";
        } = {},
      ): OmpControlTarget => {
        const defaults = defaultScript(workspace);
        const file = NodePath.join(dir, `script-${scripts++}.json`);
        NodeFS.writeFileSync(
          file,
          JSON.stringify({
            cli: { ...defaults.cli, ...script.cli },
            rpc: { ...defaults.rpc, ...script.rpc },
          }),
        );
        let path = "/usr/bin:/bin";
        if (options.gh !== undefined) {
          path = NodePath.join(dir, `gh-${options.gh}`);
          NodeFS.mkdirSync(path, { recursive: true });
          if (options.gh !== "missing") {
            NodeFS.writeFileSync(
              NodePath.join(path, "gh"),
              `#!/bin/sh\nexit ${options.gh === "ready" ? 0 : 1}\n`,
              { mode: 0o755 },
            );
          }
        }
        return {
          binaryPath,
          profile: options.profile ?? "",
          environment: {
            PATH: path,
            FAKE_OMP_CONTROL_SCRIPT: file,
            FAKE_OMP_CONTROL_LOG: logFile,
          },
          cwd: workspace,
        };
      },
      /** Every start of the fake: its pid, argv, working directory and config overlays. */
      starts: () =>
        entries().flatMap((entry) =>
          entry.event === "start" && entry.pid !== undefined
            ? [
                {
                  pid: entry.pid,
                  argv: entry.argv ?? [],
                  cwd: entry.cwd ?? "",
                  overlay: entry.overlay ?? null,
                  configs: entry.configs ?? [],
                },
              ]
            : [],
        ),
      /** Every frame the fake's RPC servers read from stdin, in order. */
      frames: () =>
        entries().flatMap((entry) =>
          entry.event === "frame" && entry.frame !== undefined ? [entry.frame] : [],
        ),
    };
  }),
);

export type FakeOmpControl = Effect.Success<typeof makeFakeOmpControl>;
