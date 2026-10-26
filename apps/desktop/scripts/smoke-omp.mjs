// Launches the built desktop app (`dist-electron/boot.cjs`, the packaged entry) in a throwaway
// home with OMP enabled and no binary path, and passes only when the backend is healthy and OMP
// turns ready on the omp.lock sidecar for this platform, downloaded and sha256-verified. CI runs
// it on macOS, Windows and Linux (docs/omp/ci.md).
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { _electron } from "playwright-core";

import { desktopDir, resolveElectronLaunchCommand } from "./electron-launcher.mjs";

const READINESS_PATH = "/.well-known/t3/environment";
// Covers the first-run sidecar download (~100 MB) and its probe on a cold runner.
const OMP_READY_TIMEOUT_MS = 5 * 60_000;
const WINDOW_TIMEOUT_MS = 2 * 60_000;
// oxlint-disable-next-line t3code/no-global-process-runtime -- The smoke test checks the host it runs on; this script has no Effect runtime.
const hostPlatform = process.platform;
// oxlint-disable-next-line t3code/no-global-process-runtime -- The omp.lock key is the host's architecture.
const hostArch = process.arch;

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
NodeFS.mkdirSync(userdata, { recursive: true });
NodeFS.mkdirSync(home, { recursive: true });
// OMP enabled with no binary path: the backend has to find the pinned sidecar itself.
NodeFS.writeFileSync(
  NodePath.join(userdata, "settings.json"),
  `${JSON.stringify({ providerInstances: { omp: { driver: "omp", enabled: true } } }, null, 2)}\n`,
);

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
Object.assign(env, {
  // Every per-user path the app, its backend and omp derive: nothing touches the runner's profile.
  HOME: home,
  USERPROFILE: home,
  APPDATA: NodePath.join(home, "AppData", "Roaming"),
  LOCALAPPDATA: NodePath.join(home, "AppData", "Local"),
  XDG_CONFIG_HOME: NodePath.join(home, ".config"),
  XDG_DATA_HOME: NodePath.join(home, ".local", "share"),
  XDG_STATE_HOME: NodePath.join(home, ".local", "state"),
  XDG_CACHE_HOME: NodePath.join(home, ".cache"),
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

const fail = async (message, app, page) => {
  console.error(`\nDesktop OMP smoke test failed: ${message}`);
  if (page !== undefined) {
    await page
      .screenshot({ path: NodePath.join(artifactsDir, "failure.png") })
      .catch(() => undefined);
  }
  NodeFS.writeFileSync(NodePath.join(artifactsDir, "output.log"), `${log.join("\n")}\n`);
  await app?.close().catch(() => undefined);
  process.exit(1);
};

const launch = resolveElectronLaunchCommand([NodePath.join(desktopDir, "dist-electron/boot.cjs")]);
record(`[smoke-omp] ${hostPlatform}-${hostArch}: launching ${launch.electronPath}`);
const app = await _electron
  .launch({
    executablePath: launch.electronPath,
    args: launch.args,
    cwd: desktopDir,
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
    const found = find();
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
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

// The main window serves the web app over the app's own protocol, with hash routes.
const page = await waitFor(
  () => app.windows().find((candidate) => candidate.url().includes("://app/")),
  WINDOW_TIMEOUT_MS,
);
if (page === undefined) {
  const urls = app.windows().map((candidate) => candidate.url());
  await fail(`the main window never opened (windows: ${JSON.stringify(urls)})`, app);
}
page.on("console", (message) => record(`[renderer:${message.type()}] ${message.text()}`));
page.on("pageerror", (error) => record(`[renderer:pageerror] ${String(error)}`));

// The providers page lists each instance; its row carries the status key (providerStatus.ts).
await page.goto(new URL("#/settings/providers", page.url()).href);
const omp = page.locator("[data-provider-instance='omp']");
const ready = await omp
  .and(page.locator("[data-provider-status='ready']"))
  .waitFor({ timeout: OMP_READY_TIMEOUT_MS })
  .then(() => true)
  .catch(() => false);
const summary = (await omp.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
await page
  .screenshot({ path: NodePath.join(artifactsDir, `providers-${hostPlatform}-${hostArch}.png`) })
  .catch(() => undefined);
if (!ready) {
  const status = await omp.getAttribute("data-provider-status").catch(() => null);
  await fail(`OMP provider is ${String(status)}, not ready: ${summary}`, app, page);
}
record(`[smoke-omp] OMP provider ready: ${summary}`);

// The sidecar it ran is this platform's omp.lock asset, downloaded into the cache and verified.
const lock = JSON.parse(
  NodeFS.readFileSync(NodePath.join(desktopDir, "../../packages/provider-omp/omp.lock"), "utf8"),
);
const sidecar = lock.sidecars[`${hostPlatform}-${hostArch}`];
if (sidecar === undefined) await fail(`omp.lock has no sidecar for this platform`, app, page);
const cached = NodePath.join(ompanelHome, "tools", "omp", lock.tag, sidecar.asset);
const digest = NodeFS.existsSync(cached)
  ? NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(cached)).digest("hex")
  : null;
if (digest !== sidecar.sha256) {
  await fail(`${cached} is ${digest === null ? "missing" : `sha256 ${digest}`}`, app, page);
}
record(`[smoke-omp] ran ${lock.tag} ${sidecar.asset} (sha256 ${digest})`);

NodeFS.writeFileSync(NodePath.join(artifactsDir, "output.log"), `${log.join("\n")}\n`);
await app.close();
// Windows can hold a just-exited process's files open for a moment; a leftover temp dir is harmless.
try {
  NodeFS.rmSync(root, { recursive: true, force: true, maxRetries: 5 });
} catch (error) {
  console.warn(`[smoke-omp] could not remove ${root}: ${String(error)}`);
}
console.log("Desktop OMP smoke test passed.");
