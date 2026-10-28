// Launches the built app, or the release app in OMPANEL_DESKTOP_SMOKE_EXECUTABLE, in a throwaway
// home with NO settings (nothing enables OMP: Z-09, ompanel#199). Passes only when the setup screen
// lists OMP first and enabled, and OMP turns ready on this platform's omp.lock sidecar, downloaded
// and sha256-verified or bundled (docs/omp/release.md).
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

import { _electron } from "playwright-core";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const READINESS_PATH = "/.well-known/t3/environment";
// Covers the first-run sidecar download (~100 MB) and its probe on a cold runner.
const OMP_READY_TIMEOUT_MS = 5 * 60_000;
const WINDOW_TIMEOUT_MS = 2 * 60_000;
// Same flags as the status check's RPC control process (OMP_CONTROL_RPC_ARGS in control.ts).
const OMP_CONTROL_RPC_ARGS = [
  "--mode",
  "rpc",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--no-skills",
  "--no-rules",
  "--no-lsp",
  "--no-title",
];
// oxlint-disable-next-line t3code/no-global-process-runtime -- The smoke test checks the host it runs on; this script has no Effect runtime.
const hostPlatform = process.platform;
// oxlint-disable-next-line t3code/no-global-process-runtime -- The omp.lock key is the host's architecture.
const hostArch = process.arch;

const lock = JSON.parse(
  NodeFS.readFileSync(NodePath.join(desktopDir, "../../packages/provider-omp/omp.lock"), "utf8"),
);
const sidecar = lock.sidecars[`${hostPlatform}-${hostArch}`];

const artifactsDir = NodePath.resolve(
  process.env.OMPANEL_DESKTOP_SMOKE_ARTIFACTS ?? NodePath.join(desktopDir, ".smoke-omp"),
);
NodeFS.mkdirSync(artifactsDir, { recursive: true });

const root = NodeFS.realpathSync(
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ompanel-desktop-smoke-")),
);
const home = NodePath.join(root, "home");
const ompanelHome = NodePath.join(root, "ompanel");
const userdata = NodePath.join(ompanelHome, "userdata");
const cachedSidecar =
  sidecar === undefined
    ? undefined
    : NodePath.join(ompanelHome, "tools", "omp", lock.tag, sidecar.asset);
// Every per-user path the app, its backend and omp derive: nothing touches the runner's profile.
const profile = {
  HOME: home,
  USERPROFILE: home,
  APPDATA: NodePath.join(home, "AppData", "Roaming"),
  LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: NodePath.join(home, ".config"),
  XDG_DATA_HOME: NodePath.join(home, ".local", "share"),
  XDG_STATE_HOME: NodePath.join(home, ".local", "state"),
  XDG_CACHE_HOME: NodePath.join(home, ".cache"),
};
for (const dir of [userdata, ...Object.values(profile)]) NodeFS.mkdirSync(dir, { recursive: true });
// No settings.json at all: OMP is on only by the product default, and the backend has to find the
// pinned sidecar itself. Never write an `enabled` flag here.
const settingsPath = NodePath.join(userdata, "settings.json");

// `omp --mode rpc` exits unless a default model resolves, so the throwaway OMP home gets one: a
// loopback OpenAI-compatible provider that only lists its model (the probe never prompts).
const modelServer = NodeHttp.createServer((request, response) => {
  if ((request.url ?? "").endsWith("/models")) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ object: "list", data: [{ id: "smoke-model", object: "model" }] }),
    );
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => modelServer.listen(0, "127.0.0.1", resolve));
modelServer.unref();
const agentDir = NodePath.join(home, ".omp", "agent");
NodeFS.mkdirSync(agentDir, { recursive: true });
NodeFS.writeFileSync(
  NodePath.join(agentDir, "models.yml"),
  [
    "providers:",
    "  smoke:",
    `    baseUrl: http://127.0.0.1:${String(modelServer.address().port)}/v1`,
    "    auth: none",
    "    api: openai-completions",
    "    models:",
    "      - id: smoke-model",
    "        name: Smoke Model",
    "        reasoning: false",
    "",
  ].join("\n"),
);
NodeFS.writeFileSync(
  NodePath.join(agentDir, "config.yml"),
  "modelRoles:\n  default: smoke/smoke-model\n",
);

// The app and the downloaded sidecar get no runner credentials (ACTIONS_* tokens, GITHUB_TOKEN).
const RUNNER_SECRET = /^(?:ACTIONS_|GITHUB_TOKEN$|GH_TOKEN$|RUNNER_TOKEN$)/u;
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !RUNNER_SECRET.test(key.toUpperCase())),
);
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, profile, {
  OMPANEL_HOME: ompanelHome,
  OMPANEL_TELEMETRY_ENABLED: "false",
  VITE_DEV_SERVER_URL: "",
  ELECTRON_ENABLE_LOGGING: "1",
});

const log = [];
const record = (line) => {
  log.push(line);
  console.log(line);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** `promise`, or `fallback` once `ms` pass: a hung window must not hang the job. */
const within = (promise, ms, fallback) =>
  Promise.race([promise.catch(() => fallback), sleep(ms).then(() => fallback)]);

/** Runs the cached sidecar as the status check does, for 15 s, so a failing probe shows why. */
const runSidecarDirectly = async () => {
  if (cachedSidecar === undefined || !NodeFS.existsSync(cachedSidecar)) return;
  const child = NodeChildProcess.spawn(cachedSidecar, OMP_CONTROL_RPC_ARGS, {
    cwd: home,
    env: { ...env, PI_NO_PTY: "1" },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += `[stdout] ${String(chunk)}`));
  child.stderr.on("data", (chunk) => (output += `[stderr] ${String(chunk)}`));
  const exited = new Promise((resolve) =>
    child.on("exit", (code, signal) => resolve(`exit ${String(code)} ${String(signal)}`)),
  );
  child.on("error", (error) => (output += `[spawn error] ${String(error)}\n`));
  child.stdin.write(`${JSON.stringify({ id: "1", type: "get_login_providers" })}\n`);
  const outcome = await within(exited, 15_000, "still running after 15 s");
  child.kill();
  NodeFS.writeFileSync(
    NodePath.join(artifactsDir, "sidecar-rpc.log"),
    `${cachedSidecar} ${OMP_CONTROL_RPC_ARGS.join(" ")}\n${outcome}\n${output}\n`,
  );
};

const stopApp = async (app) => {
  if (app === undefined) return;
  // Playwright's handle is gone once the app closes; take the process before closing.
  const child = app.process();
  await within(app.close(), 15_000, undefined);
  if (child.exitCode === null && child.signalCode === null) child.kill();
};

const fail = async (message, app, page) => {
  console.error(`\nDesktop OMP smoke test failed: ${message}`);
  if (page !== undefined) {
    await within(
      page.screenshot({ path: NodePath.join(artifactsDir, "failure.png"), timeout: 10_000 }),
      15_000,
      undefined,
    );
  }
  NodeFS.writeFileSync(NodePath.join(artifactsDir, "output.log"), `${log.join("\n")}\n`);
  const logs = NodePath.join(userdata, "logs");
  if (NodeFS.existsSync(logs)) {
    NodeFS.cpSync(logs, NodePath.join(artifactsDir, "logs"), { recursive: true });
  }
  await runSidecarDirectly().catch((error) => console.error(String(error)));
  await stopApp(app);
  process.exit(1);
};

if (sidecar === undefined) await fail(`omp.lock has no sidecar for ${hostPlatform}-${hostArch}`);

// A release build under test, or the workspace's Electron running the built entry.
const packagedExecutable = process.env.OMPANEL_DESKTOP_SMOKE_EXECUTABLE?.trim() || undefined;
const launch =
  packagedExecutable === undefined
    ? resolveElectronLaunchCommand([NodePath.join(desktopDir, "dist-electron/boot.cjs")])
    : {
        electronPath: NodePath.resolve(packagedExecutable),
        // An AppImage cannot carry a setuid chrome-sandbox, and Ubuntu 24.04 blocks the
        // unprivileged user namespaces the fallback sandbox needs.
        args: hostPlatform === "linux" ? ["--no-sandbox"] : [],
      };
record(`[smoke-omp] ${hostPlatform}-${hostArch}: launching ${launch.electronPath}`);
const app = await _electron
  .launch({
    executablePath: launch.electronPath,
    // A runner's login keychain may be locked; a keychain prompt would block the main process.
    args: hostPlatform === "darwin" ? ["--use-mock-keychain", ...launch.args] : launch.args,
    cwd: packagedExecutable === undefined ? desktopDir : root,
    env,
    timeout: WINDOW_TIMEOUT_MS,
  })
  .catch((error) => fail(`Electron did not start: ${String(error)}`));
let appOutput = "";
const onAppOutput = (chunk) => {
  appOutput += String(chunk);
  record(`[app] ${String(chunk).trimEnd()}`);
};
app.process().stdout?.on("data", onAppOutput);
app.process().stderr?.on("data", onAppOutput);

const waitFor = async (find, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = await find();
    if (found !== undefined) return found;
    await sleep(500);
  }
  return undefined;
};

// The main process logs the backend it started once it answers (DesktopBackendManager).
const backendUrl = await waitFor(
  () => /backend ready[\s\S]*?url: (http:\/\/\S+)/.exec(appOutput)?.[1],
  WINDOW_TIMEOUT_MS,
);
if (backendUrl === undefined) await fail("the backend never became ready", app);
const health = await fetch(new URL(READINESS_PATH, backendUrl)).catch((error) => error);
if (!(health instanceof Response) || !health.ok) {
  await fail(`backend ${backendUrl} is not healthy: ${String(health)}`, app);
}
record(`[smoke-omp] backend healthy at ${backendUrl}`);

const descriptor = await health.json().catch(() => null);
if (typeof descriptor?.environmentId !== "string") {
  await fail(`the environment descriptor has no environmentId: ${JSON.stringify(descriptor)}`, app);
}

// The main window serves the web app over the app's own protocol, with hash routes.
const page = await waitFor(
  () => app.windows().find((candidate) => candidate.url().includes("://app/")),
  WINDOW_TIMEOUT_MS,
);
if (page === undefined) {
  const urls = app.windows().map((candidate) => candidate.url());
  await fail(`the main window never opened (windows: ${JSON.stringify(urls)})`, app);
}
// A runner's window may start hidden or behind others; Chromium then stops painting it.
await within(
  app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.show();
      window.focus();
    }
  }),
  10_000,
  undefined,
);

// First launch: the setup screen's "Connect your agents" step lists OMP first, recommended and
// not disabled, with the version it probed. The hash route resumes at that step, as the app does
// after pairing; the DOM answers whether or not the window paints.
await within(
  page.evaluate((environmentId) => {
    window.location.hash = `#/welcome#agents:${environmentId}`;
  }, descriptor.environmentId),
  10_000,
  undefined,
);
const readAgents = () =>
  within(
    page.evaluate(() =>
      [...document.querySelectorAll("[data-onboarding-agent]")].map((card) => ({
        driver: card.getAttribute("data-onboarding-agent"),
        state: card.getAttribute("data-onboarding-state"),
        text: (card instanceof HTMLElement ? card.innerText : (card.textContent ?? ""))
          .replace(/\s+/g, " ")
          .trim(),
      })),
    ),
    10_000,
    [],
  );
// `checking` covers the first probe (and the sidecar download on a cold runner).
const agents = await waitFor(async () => {
  const cards = await readAgents();
  const omp = cards.find((card) => card.driver === "omp");
  return omp !== undefined && omp.state !== "checking" ? cards : undefined;
}, OMP_READY_TIMEOUT_MS);
await within(
  page.screenshot({
    path: NodePath.join(artifactsDir, `setup-agents-${hostPlatform}-${hostArch}.png`),
    timeout: 10_000,
  }),
  15_000,
  undefined,
);
const setupOmp = agents?.find((card) => card.driver === "omp");
if (agents === undefined || setupOmp === undefined) {
  await fail(
    `the setup screen never listed a probed OMP: ${JSON.stringify(await readAgents())}`,
    app,
    page,
  );
}
// Ready, or reachable but still needing a model (`signIn`: "Set up"); never disabled, unchecked
// or missing. OMP must also lead the list and show the version of the sidecar it ran.
if (!["ready", "signIn"].includes(setupOmp.state) || /Disabled/.test(setupOmp.text)) {
  await fail(`the setup screen shows OMP as ${setupOmp.state}: ${setupOmp.text}`, app, page);
}
if (agents[0].driver !== "omp") {
  await fail(
    `OMP is not the first agent on the setup screen: ${JSON.stringify(agents)}`,
    app,
    page,
  );
}
if (!/Recommended/.test(setupOmp.text) || /Preview/.test(setupOmp.text)) {
  await fail(`OMP is not shown as recommended, or still as a preview: ${setupOmp.text}`, app, page);
}
if (!/\bv\d+\.\d+\.\d+/.test(setupOmp.text)) {
  await fail(`the setup screen shows no OMP version: ${setupOmp.text}`, app, page);
}
record(`[smoke-omp] setup screen: ${setupOmp.text}`);

// The providers page lists each instance; its row carries the status key (providerStatus.ts).
// Polled through the DOM, which answers whether or not the window paints.
await within(
  page.evaluate(() => {
    window.location.hash = "#/settings/providers";
  }),
  10_000,
  undefined,
);
const readRow = () =>
  within(
    page.evaluate(() => {
      const row = document.querySelector("[data-provider-instance='omp']");
      return row === null
        ? null
        : {
            status: row.getAttribute("data-provider-status"),
            text: (row instanceof HTMLElement ? row.innerText : (row.textContent ?? ""))
              .replace(/\s+/g, " ")
              .trim(),
          };
    }),
    10_000,
    null,
  );
// `warning` covers "Checking the OMP sidecar..." while the probe runs; ready and error are final.
const settled = () =>
  waitFor(async () => {
    const current = await readRow();
    return current?.status === "ready" || current?.status === "error" ? current : undefined;
  }, OMP_READY_TIMEOUT_MS);
let row = await settled();
// The very first `omp` start on a cold runner can miss the control process's 20 s ready budget
// (ompanel#147). One re-check after the 30 s probe cache expires; any other error is final.
if (row?.status === "error" && row.text.includes("did not answer within")) {
  record(`[smoke-omp] first check timed out (${row.text}); refreshing once`);
  await sleep(31_000);
  await within(
    page.evaluate(() => {
      for (const button of document.querySelectorAll("button")) {
        if (button.textContent?.includes("Refresh provider status")) button.click();
      }
    }),
    10_000,
    undefined,
  );
  await waitFor(async () => ((await readRow())?.status === "error" ? undefined : true), 60_000);
  row = await settled();
}
await within(
  page.screenshot({
    path: NodePath.join(artifactsDir, `providers-${hostPlatform}-${hostArch}.png`),
    timeout: 10_000,
  }),
  15_000,
  undefined,
);
if (row?.status !== "ready") {
  const last = row ?? (await readRow());
  await fail(`OMP provider is ${String(last?.status)}, not ready: ${last?.text ?? ""}`, app, page);
}
if (/Preview/.test(row.text)) {
  await fail(`OMP still carries a Preview badge: ${row.text}`, app, page);
}
record(`[smoke-omp] OMP provider ready: ${row.text}`);
// Nothing the app wrote may have switched OMP off (the smoke itself never wrote a setting).
if (NodeFS.existsSync(settingsPath)) {
  const saved = JSON.parse(NodeFS.readFileSync(settingsPath, "utf8"));
  if (saved.providerInstances?.omp?.enabled === false) {
    await fail(
      `the app saved OMP as disabled: ${JSON.stringify(saved.providerInstances.omp)}`,
      app,
      page,
    );
  }
}

if (packagedExecutable !== undefined) {
  // The server checks a bundled sidecar against the omp.lock it was built with before it runs
  // it, and downloads only when none is bundled; a cached copy means the bundle was missing.
  if (NodeFS.existsSync(cachedSidecar)) {
    await fail(
      `the packaged app downloaded ${cachedSidecar} instead of running its own`,
      app,
      page,
    );
  }
  record(`[smoke-omp] ran the bundled ${lock.tag} ${sidecar.asset}`);
} else {
  // The sidecar it ran is this platform's omp.lock asset, downloaded into the cache and verified.
  const digest = NodeFS.existsSync(cachedSidecar)
    ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(cachedSidecar)).digest("hex")
    : null;
  if (digest !== sidecar.sha256) {
    await fail(
      `${cachedSidecar} is ${digest === null ? "missing" : `sha256 ${digest}`}`,
      app,
      page,
    );
  }
  record(`[smoke-omp] ran ${lock.tag} ${sidecar.asset} (sha256 ${digest})`);
}

NodeFS.writeFileSync(NodePath.join(artifactsDir, "output.log"), `${log.join("\n")}\n`);
await stopApp(app);
// Windows can hold a just-exited process's files open for a moment; a leftover temp dir is harmless.
try {
  NodeFS.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
} catch (error) {
  console.warn(`[smoke-omp] could not remove ${root}: ${String(error)}`);
}
console.log("Desktop OMP smoke test passed.");
