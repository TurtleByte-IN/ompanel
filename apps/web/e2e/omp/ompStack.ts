// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - a host-side end-to-end fixture.
// One isolated Ompanel for the OMP end-to-end tests: a throwaway HOME and Ompanel home, a git
// workspace the server bootstraps as a project, the scripted model, and the server from source
// serving the built web app (`apps/web/dist`) with OMP pointed at a real `omp` binary. The live
// suite points OMP's default model at a real provider instead (`OmpStackOptions`).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import JSZip from "jszip";

import { type CollabRelay, startCollabRelay } from "./collabRelay.ts";
import { type FakeSignInVendor, startFakeSignInVendor, writeFakeSignInOmp } from "./fakeSignIn.ts";
import { type OtlpMetricsReceiver, startOtlpMetricsReceiver } from "./otlpMetrics.ts";
import { linkToRelayStub, type RelayStub, startRelayStub } from "./relayStub.ts";
import { type ScriptedModel, startScriptedModel } from "./scriptedModel.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "..", "..", "..", "..");
const SERVER_ENTRY = NodePath.join(REPO_ROOT, "apps", "server", "src", "bin.ts");
const WEB_DIST = NodePath.join(REPO_ROOT, "apps", "web", "dist", "index.html");

/** The `omp` the test runs; build it from the pinned tag with `e2e/omp/build-omp.ts`. */
const OMP_BINARY_ENV = "OMPANEL_E2E_OMP_BINARY";

export interface OmpStackOptions {
  /** OMP's `modelRoles.default`; the scripted model (`fake/fake-model`) unless given. */
  readonly defaultModel?: string;
  /**
   * Extra server environment, inherited by every `omp` it starts: a provider's API key for the
   * live suite. Never on a command line; every value is redacted from `serverLog()`.
   */
  readonly secretEnvironment?: Readonly<Record<string, string>>;
  /** Give OMP's control servers a fake login provider (`fakeSignIn.ts`); the G2 suite's sign-in. */
  readonly fakeSignIn?: boolean;
  /** Link the environment to a loopback relay that records agent-activity publishes (P-15). */
  readonly relayStub?: boolean;
  /**
   * Start OMP as a fresh install: no default model and no `models.yml`, so `omp --mode rpc`
   * refuses to start until {@link OmpStack.completeOmpSetup}.
   */
  readonly freshOmpHome?: boolean;
}

export interface OmpProcess {
  readonly pid: number;
  readonly threadId: string;
  /** The live process's command line, from `ps`. */
  readonly args: string;
}

export interface OmpStack {
  readonly pairingUrl: string;
  readonly workspace: string;
  /** The throwaway `HOME`: OMP's agent directory is `<home>/.omp/agent`. */
  readonly home: string;
  readonly model: ScriptedModel;
  /** The server's OTLP metric exports, as a collector would receive them. */
  readonly metrics: OtlpMetricsReceiver;
  /** OMP's collab relay (`collab.relayUrl`): Share live rooms open here, never on the internet. */
  readonly collabRelay: CollabRelay;
  /** Live `omp` session processes, from the server's pidfiles. */
  readonly ompProcesses: () => ReadonlyArray<OmpProcess>;
  readonly git: (...args: ReadonlyArray<string>) => string;
  /** Runs the real `omp` as the server's OMP instance would, in the workspace; returns stdout. */
  readonly omp: (...args: ReadonlyArray<string>) => string;
  /** The fake vendor and where the wrapper keeps its account, with `fakeSignIn`. */
  readonly signIn: { readonly vendor: FakeSignInVendor; readonly accountFile: string } | null;
  /** The loopback relay, with `relayStub`. */
  readonly relay: RelayStub | null;
  /**
   * Leaves the OMP home as `omp setup` would: the scripted model's provider and a default model.
   * A no-op unless the stack started with `freshOmpHome`.
   */
  readonly completeOmpSetup: () => void;
  /** The server's output, pairing token redacted. */
  readonly serverLog: () => string;
  /**
   * Stops the server and its `omp` processes, then lists each handled secret found in the run's
   * records, state, workspace, metric exports and `uploaded` (zips entry by entry) as
   * `"<label> in <file>"` (PRD §9; docs/omp/security.md).
   */
  readonly stop: (options?: {
    /** Directories CI uploads as artifacts. */
    readonly uploaded?: ReadonlyArray<string>;
  }) => Promise<{ readonly leakedSecrets: ReadonlyArray<string> }>;
}

const freePort = async () => {
  const server = NodeNet.createServer();
  const listening = Promise.withResolvers<number>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    listening.resolve(typeof address === "object" && address !== null ? address.port : 0);
  });
  const port = await listening.promise;
  const closed = Promise.withResolvers<void>();
  server.close(() => closed.resolve());
  await closed.promise;
  return port;
};

const commandLine = (pid: number) => {
  try {
    return NodeChildProcess.execFileSync("ps", ["-o", "args=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
  } catch {
    return undefined;
  }
};

/** The server's start-up line that hands the operator the pairing link (`announceStartupPairingUrl`). */
const PAIRING_ANNOUNCEMENT = /^\s*pairingUrl: \S+$/;

/** Every file under `dir`, recursively; none when it does not exist. */
const filesUnder = (dir: string): ReadonlyArray<string> =>
  NodeFS.existsSync(dir)
    ? NodeFS.readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => NodePath.join(entry.parentPath, entry.name))
    : [];

/**
 * Where each secret appears: the server log (except its pairing announcement), every file under
 * the `recorded` and `uploaded` directories (zip archives entry by entry, as `<zip>:<entry>`),
 * the single `files` and each metric export. Reports name the secret's label and the source,
 * never the value.
 */
const scanForSecrets = async (input: {
  readonly secrets: ReadonlyArray<{
    readonly label: string;
    readonly value: string;
    /** Files that store this secret by design (credential storage, not a record of the run). */
    readonly storedIn?: ReadonlyArray<string>;
  }>;
  readonly serverLog: string;
  readonly recorded: ReadonlyArray<string>;
  /** Artifact directories; zip archives in them (Playwright traces) are opened. */
  readonly uploaded: ReadonlyArray<string>;
  /** Single files, e.g. the database and its write-ahead log. */
  readonly files: ReadonlyArray<string>;
  readonly metricExports: ReadonlyArray<string>;
}): Promise<ReadonlyArray<string>> => {
  const sources: Array<{ readonly file: string; readonly text: string }> = [
    {
      file: "server log",
      text: NodeFS.readFileSync(input.serverLog, "utf8")
        .split("\n")
        .filter((line) => !PAIRING_ANNOUNCEMENT.test(line))
        .join("\n"),
    },
    ...input.metricExports.map((text, index) => ({ file: `metric export ${index}`, text })),
  ];
  const read = (file: string) => ({ file, text: NodeFS.readFileSync(file, "latin1") });
  sources.push(...input.recorded.flatMap(filesUnder).map(read));
  sources.push(...input.files.filter((file) => NodeFS.existsSync(file)).map(read));
  for (const file of input.uploaded.flatMap(filesUnder)) {
    if (!file.endsWith(".zip")) {
      sources.push(read(file));
      continue;
    }
    const zip = await JSZip.loadAsync(NodeFS.readFileSync(file));
    for (const entry of Object.values(zip.files)) {
      if (entry.dir) continue;
      const bytes = await entry.async("nodebuffer");
      sources.push({ file: `${file}:${entry.name}`, text: bytes.toString("latin1") });
    }
  }
  // Raw, URL-encoded and JSON-escaped forms.
  const forms = (value: string) => [
    ...new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]),
  ];
  return input.secrets
    .filter((secret) => secret.value.length >= 8)
    .flatMap((secret) =>
      sources
        .filter((source) => !(secret.storedIn ?? []).includes(source.file))
        .filter((source) => forms(secret.value).some((form) => source.text.includes(form)))
        .map((source) => `${secret.label} in ${source.file}`),
    );
};

export const startOmpStack = async (options: OmpStackOptions = {}): Promise<OmpStack> => {
  const secretEnvironment = options.secretEnvironment ?? {};
  const secrets = Object.values(secretEnvironment).filter((value) => value !== "");
  const binary = process.env[OMP_BINARY_ENV];
  if (binary === undefined || !NodeFS.existsSync(binary)) {
    throw new Error(
      `${OMP_BINARY_ENV} must name an omp built from the omp.lock tag ` +
        "(node apps/web/e2e/omp/build-omp.ts <checkout-dir> prints one).",
    );
  }
  if (!NodeFS.existsSync(WEB_DIST)) {
    throw new Error(`${WEB_DIST} is missing; build the web app first (vp build in apps/web).`);
  }

  const root = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-e2e-")));
  const home = NodePath.join(root, "home");
  const agentDir = NodePath.join(home, ".omp", "agent");
  const ompanelHome = NodePath.join(root, "ompanel");
  const userdata = NodePath.join(ompanelHome, "userdata");
  const workspace = NodePath.join(root, "workspace");
  for (const dir of [agentDir, userdata, workspace]) NodeFS.mkdirSync(dir, { recursive: true });

  // OMP's default model is the scripted one unless the live suite names a real one; nothing
  // reads the developer's ~/.omp. A fresh OMP home gets both only from `completeOmpSetup`. Share
  // live rooms go to a loopback relay.
  const collabRelay = await startCollabRelay();
  const ompConfig =
    `modelRoles:\n  default: ${options.defaultModel ?? "fake/fake-model"}\n` +
    `collab:\n  relayUrl: ${collabRelay.url}\n`;
  const modelDir = options.freshOmpHome === true ? NodePath.join(root, "omp-setup") : agentDir;
  NodeFS.mkdirSync(modelDir, { recursive: true });
  if (options.freshOmpHome !== true) {
    NodeFS.writeFileSync(NodePath.join(agentDir, "config.yml"), ompConfig);
  }
  const completeOmpSetup = () => {
    if (modelDir === agentDir) return;
    NodeFS.copyFileSync(
      NodePath.join(modelDir, "models.yml"),
      NodePath.join(agentDir, "models.yml"),
    );
    NodeFS.writeFileSync(NodePath.join(agentDir, "config.yml"), ompConfig);
  };
  const vendor = options.fakeSignIn === true ? await startFakeSignInVendor() : null;
  const signIn =
    vendor === null
      ? null
      : {
          vendor,
          ...writeFakeSignInOmp(
            NodeFS.mkdtempSync(NodePath.join(root, "sign-in-")),
            binary,
            vendor,
          ),
        };
  // OMP enabled at the given binary (or the fake sign-in wrapper around it); commit messages are
  // generated through it.
  NodeFS.writeFileSync(
    NodePath.join(userdata, "settings.json"),
    `${JSON.stringify(
      {
        providerInstances: {
          omp: {
            driver: "omp",
            enabled: true,
            config: { binaryPath: signIn?.binary ?? binary },
          },
        },
        textGenerationModelSelection: { instanceId: "omp", model: "default" },
      },
      null,
      2,
    )}\n`,
  );

  const omp = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync(binary, args, {
      cwd: workspace,
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: NodeOS.tmpdir(), PI_NO_PTY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });

  const git = (...args: ReadonlyArray<string>) =>
    NodeChildProcess.execFileSync("git", ["-C", workspace, ...args], {
      encoding: "utf8",
      env: { ...process.env, HOME: home },
    }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.email", "g1@example.com");
  git("config", "user.name", "G1 E2E");
  NodeFS.writeFileSync(NodePath.join(workspace, "README.md"), "# G1 end-to-end workspace\n");
  git("add", "README.md");
  git("commit", "-q", "-m", "Initial commit");

  const model = await startScriptedModel(modelDir);
  const metrics = await startOtlpMetricsReceiver();
  const relay = options.relayStub === true ? await startRelayStub() : null;
  if (relay !== null) linkToRelayStub(NodePath.join(userdata, "secrets"), relay.url);
  const port = await freePort();
  const logPath = NodePath.join(root, "server.log");
  const log = NodeFS.openSync(logPath, "a");
  const server = NodeChildProcess.spawn(process.execPath, [SERVER_ENTRY, workspace], {
    cwd: workspace,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: home,
      TMPDIR: NodeOS.tmpdir(),
      OMPANEL_HOME: ompanelHome,
      OMPANEL_PORT: String(port),
      OMPANEL_MODE: "web",
      OMPANEL_NO_BROWSER: "1",
      OMPANEL_TELEMETRY_ENABLED: "false",
      OMPANEL_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "1",
      OMPANEL_OTLP_METRICS_URL: metrics.url,
      OMPANEL_OTLP_PROTOCOL: "http/json",
      OMPANEL_OTLP_EXPORT_INTERVAL_MS: "1000",
      PI_NO_PTY: "1",
      ...secretEnvironment,
    },
    stdio: ["ignore", "pipe", log],
  });
  const exited = Promise.withResolvers<void>();
  server.once("exit", () => exited.resolve());

  const paired = Promise.withResolvers<string>();
  let stdout = "";
  server.stdout?.on("data", (data: Buffer) => {
    NodeFS.appendFileSync(logPath, data);
    stdout += data.toString("utf8");
    const url = /pairingUrl: (\S+)/.exec(stdout)?.[1];
    if (url !== undefined) paired.resolve(url);
  });
  server.once("exit", (code) =>
    paired.reject(new Error(`Ompanel exited (${code}) before pairing; see ${logPath}`)),
  );
  const timeout = setTimeout(
    () => paired.reject(new Error(`No pairing URL within 120 s; see ${logPath}`)),
    120_000,
  );
  const pairingUrl = await paired.promise.finally(() => clearTimeout(timeout));

  const pidfiles = NodePath.join(userdata, "omp", "processes");
  const ompProcesses = () =>
    (NodeFS.existsSync(pidfiles) ? NodeFS.readdirSync(pidfiles) : []).flatMap((name) => {
      const entry = JSON.parse(NodeFS.readFileSync(NodePath.join(pidfiles, name), "utf8")) as {
        readonly pid: number;
        readonly threadId: string;
      };
      const args = commandLine(entry.pid);
      return args === undefined ? [] : [{ pid: entry.pid, threadId: entry.threadId, args }];
    });

  return {
    pairingUrl,
    workspace,
    home,
    model,
    metrics,
    collabRelay,
    ompProcesses,
    git,
    omp,
    signIn,
    relay,
    completeOmpSetup,
    serverLog: () =>
      secrets.reduce(
        (text, secret) => text.replaceAll(secret, "<redacted>"),
        NodeFS.readFileSync(logPath, "utf8").replaceAll(/#token=\S+/g, "#token=<redacted>"),
      ),
    stop: async (stopOptions) => {
      const leftover = ompProcesses();
      server.kill("SIGTERM");
      const killTimer = setTimeout(() => server.kill("SIGKILL"), 15_000);
      await exited.promise;
      clearTimeout(killTimer);
      // The server stops its sessions on shutdown; kill any it left so no omp outlives the run.
      for (const leaked of leftover) {
        if (commandLine(leaked.pid)?.startsWith(binary) === true)
          process.kill(leaked.pid, "SIGKILL");
      }
      NodeFS.closeSync(log);
      const leakedSecrets = await scanForSecrets({
        secrets: [
          {
            label: "pairing token",
            value: new URL(pairingUrl).hash.replace(/^#token=/, ""),
            // The pairing grant row keeps it until it is spent (TurtleByte-IN/ompanel#164).
            storedIn: [NodePath.join(userdata, "statev2.sqlite")],
          },
          ...secrets.map((value, index) => ({ label: `secretEnvironment[${index}]`, value })),
          ...(vendor?.exchanged() ?? []).map((value) => ({ label: "OAuth code", value })),
        ],
        serverLog: logPath,
        // Logs and traces, OMP's thread state, OMP's own sessions and logs, and the workspace
        // the agent worked in (its files, `.git` and any `.omp/` the run left).
        recorded: [
          NodePath.join(userdata, "logs"),
          NodePath.join(userdata, "omp"),
          NodePath.join(agentDir, "sessions"),
          NodePath.join(agentDir, "logs"),
          workspace,
        ],
        uploaded: stopOptions?.uploaded ?? [],
        files: ["statev2.sqlite", "statev2.sqlite-wal"].map((name) =>
          NodePath.join(userdata, name),
        ),
        metricExports: metrics.exports(),
      });
      await model.close();
      await metrics.close();
      await relay?.close();
      await collabRelay.close();
      await vendor?.close();
      NodeFS.rmSync(root, { recursive: true, force: true });
      return { leakedSecrets };
    },
  };
};
