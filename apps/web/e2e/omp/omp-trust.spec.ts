// @effect-diagnostics nodeBuiltinImport:off - an end-to-end test writing the workspace's agent config.
// Workspace trust (P-09, docs/omp/security.md): the workspace carries its own agent config, an
// `.omp/config.yml` approval rule that allows every command and a project MCP server in
// `.mcp.json`. Untrusted (the default), a real `omp` from the omp.lock tag ignores both: the
// command still asks, the server never starts. Trusted in Settings → Threads for the project, a
// new thread's `omp` uses both. Steps run in order on one page.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, test } from "@playwright/test";

import { useOmpSuite } from "./ompSuite.ts";
import { TOOL_REPLY_PREFIX } from "./scriptedModel.ts";

const ARTIFACTS =
  process.env.OMPANEL_E2E_ARTIFACTS_DIR === undefined
    ? NodePath.join(import.meta.dirname, "..", "..", ".playwright", "omp-trust-artifacts")
    : NodePath.join(process.env.OMPANEL_E2E_ARTIFACTS_DIR, "trust");

test.describe.configure({ mode: "serial" });

const suite = useOmpSuite({ artifacts: ARTIFACTS });

/**
 * A stdio MCP server that records each start, with the command line of the process that started
 * it, and answers `initialize` and `tools/list` (one tool), so OMP connects to it when it loads
 * the project's servers.
 */
const MCP_SERVER = `
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as readline from "node:readline";
const parent = execFileSync("ps", ["-o", "command=", "-p", String(process.ppid)]).toString().trim();
fs.appendFileSync(process.argv[2], "started by " + parent + "\\n");
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "trust-probe", version: "1.0.0" } } });
  } else if (request.method === "tools/list") {
    send({ id: request.id, result: { tools: [{ name: "trust_probe", description: "Probe.", inputSchema: { type: "object", properties: {} } }] } });
  } else {
    send({ id: request.id, result: {} });
  }
});
`;

/** Where the project MCP server records its starts (outside the workspace). */
const mcpStarts = () => NodePath.join(suite.current().stack.home, "trust-mcp-starts.txt");
/** Each start the project's MCP server recorded, with the command that started it. */
const mcpStartLog = () =>
  NodeFS.existsSync(mcpStarts()) ? NodeFS.readFileSync(mcpStarts(), "utf8") : "";

/**
 * A project custom tool (`.omp/tools/<name>/index.ts`) that records each time OMP imports it. A
 * background control `omp` (model and command lists) starts in the project folder before the
 * project is trusted, and `--no-tools` does not stop custom tools: the control overlay's
 * `workspace.trusted: false` does.
 */
const toolLoads = () => NodePath.join(suite.current().stack.home, "trust-tool-loads.txt");
const toolLoadLog = () =>
  NodeFS.existsSync(toolLoads()) ? NodeFS.readFileSync(toolLoads(), "utf8") : "";
const writeProbeTool = (workspace: string) => {
  const dir = NodePath.join(workspace, ".omp", "tools", "trust-tool-probe");
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "index.ts"),
    [
      'import * as fs from "node:fs";',
      `fs.appendFileSync(${JSON.stringify(toolLoads())}, "loaded by pid " + process.pid + "\\n");`,
      "export default () => [];",
      "",
    ].join("\n"),
  );
};

test("an untrusted project's approval rule and MCP server are ignored", async () => {
  const { approvalCard, assistantSays, createOmpThread, page, screenshot, send, stack } =
    suite.current();
  const server = NodePath.join(stack.home, "trust-mcp.mjs");
  NodeFS.writeFileSync(server, MCP_SERVER);
  NodeFS.mkdirSync(NodePath.join(stack.workspace, ".omp"), { recursive: true });
  // Rules that would let every command run without asking, and the project's own MCP server.
  NodeFS.writeFileSync(
    NodePath.join(stack.workspace, ".omp", "config.yml"),
    [
      "tools:",
      "  approval:",
      "    terminal: allow",
      "    bash: allow",
      "bash:",
      "  patterns:",
      "    - { match: '*', approval: allow }",
      "mcp:",
      "  enableProjectConfig: true",
      "",
    ].join("\n"),
  );
  NodeFS.writeFileSync(
    NodePath.join(stack.workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: { "trust-probe": { command: process.execPath, args: [server, mcpStarts()] } },
    }),
  );

  writeProbeTool(stack.workspace);

  await createOmpThread("Supervised");
  await send("run: echo trust-untrusted");
  // The project's `allow` is ignored: Supervised still asks.
  await expect(approvalCard()).toBeVisible();
  await screenshot("01-untrusted-asks");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(assistantSays(`${TOOL_REPLY_PREFIX}trust-untrusted`)).toBeVisible();
  // `omp` is up and served a turn, and never started the project's MCP server.
  expect(mcpStartLog()).toBe("");
  // Neither the thread's `omp` nor a control `omp` imported the project's custom tool.
  expect(toolLoadLog()).toBe("");
  // The thread's `--config` overlay is what told `omp` the project is untrusted.
  const [args = ""] = suite
    .current()
    .threadProcesses(suite.current().threadId())
    .map((entry) => entry.args);
  const overlay = /--config (\S+)/.exec(args)?.[1];
  expect(overlay).toBeDefined();
  // Ompanel writes it as one JSON line under a comment.
  const overlayText = NodeFS.readFileSync(overlay!, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n");
  expect(JSON.parse(overlayText)).toMatchObject({ workspace: { trusted: false } });
});

test("a trusted project's approval rule and MCP server apply in a new thread", async () => {
  const { approvalCard, assistantSays, createOmpThread, page, screenshot, send, stack, watchFor } =
    suite.current();
  await page.goto(new URL("/settings/threads", page.url()).href);
  await page.getByRole("button", { name: /^Project scope: / }).click();
  await page
    .getByRole("menuitemradio", { name: NodePath.basename(stack.workspace), exact: true })
    .click();
  const trust = page.getByRole("switch", { name: "Trust project agent config" });
  await expect(trust).toBeVisible();
  await expect(trust).not.toBeChecked();
  // This server's OMP enforces it: the setting does not say otherwise.
  await expect(page.getByText(/Not enforced by this server's OMP version/)).toHaveCount(0);
  await trust.click();
  await expect(trust).toBeChecked();
  await screenshot("02a-trusted");

  await page.goto(new URL("/", page.url()).href);
  await createOmpThread("Supervised");
  const sawApproval = await watchFor("trustApproval", { include: "Command approval" });
  await send("run: echo trust-trusted");
  await expect(assistantSays(`${TOOL_REPLY_PREFIX}trust-trusted`)).toBeVisible();
  // The project's rule approved the command, and `omp` started the project's MCP server.
  expect(await sawApproval()).toBe(false);
  await expect(approvalCard()).toHaveCount(0);
  await expect.poll(mcpStartLog).toContain("started");
  // The probe tool does load once trusted, so the untrusted step above proves something.
  await expect.poll(toolLoadLog).toContain("loaded by pid");
  await screenshot("02b-trusted-runs");
});
