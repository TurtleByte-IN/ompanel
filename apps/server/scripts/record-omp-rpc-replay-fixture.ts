// @effect-diagnostics nodeBuiltinImport:off - a recording script: a local HTTP model and temp dirs.
// Records OMP replay fixtures from a checkout of the `omp.lock` tag with a scripted local model
// (no account, no API key): `node scripts/record-omp-rpc-replay-fixture.ts --omp-source <dir>
// [--scenario <name>]`. See docs/omp/testing.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type { ProviderReplayEntry } from "@t3tools/contracts";
import { OMP_LOCK } from "@t3tools/provider-omp/rpc";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { ChildProcessSpawner } from "effect/process";

import {
  encodeOmpTranscriptNdjson,
  makeOmpRecordingSpawner,
  normalizeOmpEntries,
  OMP_PROVIDER,
  OMP_RPC_REPLAY_PROTOCOL,
  type OmpReplayScenario,
  type OmpRpcReplayTranscript,
  replayOmpScenario,
  runOmpScenario,
} from "../src/orchestration-v2/Adapters/OmpAdapterV2.testkit.ts";
import {
  OMP_REPLAY_SCENARIOS,
  ompTranscriptUrl,
} from "../src/orchestration-v2/testkit/fixtures/ompScenarios.ts";

function readArgValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const ompSource = readArgValue("--omp-source");
const only = readArgValue("--scenario");
if (ompSource === undefined) {
  throw new Error("usage: record-omp-rpc-replay-fixture.ts --omp-source <dir> [--scenario <name>]");
}
const scenarios = OMP_REPLAY_SCENARIOS.filter(
  (scenario) => only === undefined || scenario.name === only,
);
if (scenarios.length === 0) throw new Error(`no OMP replay scenario named ${only}`);

const git = (...args: ReadonlyArray<string>) =>
  NodeChildProcess.execFileSync("git", ["-C", ompSource, ...args], { encoding: "utf8" }).trim();
const head = git("rev-parse", "HEAD");
if (head !== OMP_LOCK.commit) {
  throw new Error(
    `${ompSource} is at ${head}; omp.lock pins ${OMP_LOCK.tag} (${OMP_LOCK.commit}). Check out the pinned tag.`,
  );
}
const bun = process.env.T3_BUN_BIN ?? "bun";
const platform = HostProcess.Platform.defaultValue();
const cli = NodePath.join(ompSource, "packages", "coding-agent", "src", "cli.ts");

// The fake model answers every request with "pong". A user turn containing "slow" streams one
// delta and then stalls until the client disconnects, so the host can cancel it mid-stream.
// Adapted from the fork's `packages/coding-agent/test/rpc-wire/fake-openai-server.ts`.
interface ChatRequest {
  readonly stream?: boolean;
  readonly messages?: ReadonlyArray<{ readonly role?: string; readonly content?: unknown }>;
}

const lastUserText = (request: ChatRequest) => {
  const last = request.messages?.at(-1);
  if (last?.role !== "user") return "";
  return typeof last.content === "string" ? last.content : JSON.stringify(last.content ?? "");
};

const chunk = (delta: object, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    created: 0,
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`;

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

function startFakeModel(agentDir: string): Promise<NodeHttp.Server> {
  const server = NodeHttp.createServer((request, response) => {
    const body: Array<Buffer> = [];
    request.on("data", (data: Buffer) => body.push(data));
    request.on("end", () => {
      const url = request.url ?? "";
      if (url.endsWith("/models")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }),
        );
        return;
      }
      if (!url.endsWith("/chat/completions")) {
        response.writeHead(404).end();
        return;
      }
      const chat = JSON.parse(Buffer.concat(body).toString("utf8")) as ChatRequest;
      const slow = lastUserText(chat).includes("slow");
      if (chat.stream !== true) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            id: "chatcmpl-fake",
            object: "chat.completion",
            created: 0,
            model: "fake-model",
            choices: [
              { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
            ],
            usage: USAGE,
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      if (slow) {
        response.write(chunk({ role: "assistant", content: "po" }, null));
        return;
      }
      response.end(
        [
          chunk({ role: "assistant", content: "pong" }, null),
          chunk({}, "stop"),
          `data: ${JSON.stringify({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model", choices: [], usage: USAGE })}\n\n`,
          "data: [DONE]\n\n",
        ].join(""),
      );
    });
  });
  const { promise, resolve } = Promise.withResolvers<NodeHttp.Server>();
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "models.yml"),
      [
        "providers:",
        "  fake:",
        `    baseUrl: http://127.0.0.1:${port}/v1`,
        "    auth: none",
        "    api: openai-completions",
        "    models:",
        "      - id: fake-model",
        "        name: Fake Model",
        "        reasoning: false",
        "",
      ].join("\n"),
    );
    resolve(server);
  });
  return promise;
}

const recordScenario = Effect.fn("recordOmpScenario")(function* (scenario: OmpReplayScenario) {
  const root = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-record-")),
  );
  const home = NodePath.join(root, "home");
  const agentDir = NodePath.join(root, "agent");
  const workspace = NodePath.join(root, "workspace");
  const overlay = NodePath.join(root, "overlay.yml");
  for (const dir of [home, agentDir, workspace, NodePath.join(root, "tmp")])
    NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(overlay, "{}\n");
  // OMP keeps the last 20k tokens out of compaction; these sessions are a few hundred long.
  NodeFS.writeFileSync(
    NodePath.join(agentDir, "config.yml"),
    "compaction:\n  keepRecentTokens: 10\n",
  );
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
  );
  const model = yield* Effect.acquireRelease(
    Effect.promise(() => startFakeModel(agentDir)),
    (server) =>
      Effect.sync(() => {
        server.closeAllConnections();
        server.close();
      }),
  );

  // Flags as the adapter passes them (`launch.ts`), plus the fake model and no user context.
  const args = [
    cli,
    "--mode",
    "rpc-ui",
    "--approval-mode",
    "yolo",
    "--config",
    overlay,
    "--cwd",
    workspace,
    "--model",
    "fake/fake-model",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--no-lsp",
    "--no-title",
  ];
  const entries: Array<ProviderReplayEntry> = [];
  const address = model.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  // Longest first, so a path inside another is replaced whole.
  const replacements: ReadonlyArray<readonly [string, string]> = [
    [cli, "<omp-cli>"],
    [root, "<root>"],
    [NodeOS.homedir(), "<home>"],
    [`http://127.0.0.1:${port}`, "<fake-model>"],
  ];
  const live = yield* ChildProcessSpawner.ChildProcessSpawner;
  yield* runOmpScenario(
    scenario,
    {
      command: bun,
      args,
      cwd: workspace,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
        PI_NO_TITLE: "1",
        PI_NO_PTY: "1",
        TMPDIR: NodePath.join(root, "tmp"),
      },
      platform,
      pidfilesDir: NodePath.join(root, "pidfiles"),
    },
    makeOmpRecordingSpawner(live, entries),
  ).pipe(
    Effect.scoped,
    // Keep what was seen, for adjusting the scenario to what OMP actually does.
    Effect.tapCause(() => {
      const dump = NodePath.join(NodeOS.tmpdir(), `omp-record-${scenario.name}.failed.ndjson`);
      const lines = normalizeOmpEntries(entries, replacements).map((entry) =>
        JSON.stringify(entry),
      );
      NodeFS.writeFileSync(dump, `${lines.join("\n")}\n`);
      return Console.error(`Recording ${scenario.name} failed; entries so far: ${dump}`);
    }),
  );

  const normalized = normalizeOmpEntries(entries, replacements);
  const launchArgs = normalized[0]?.type === "expect_outbound" ? normalized[0].frame : undefined;
  const transcript: OmpRpcReplayTranscript = {
    provider: OMP_PROVIDER,
    protocol: OMP_RPC_REPLAY_PROTOCOL,
    version: OMP_LOCK.version,
    scenario: scenario.name,
    metadata: {
      generatedBy: "record-omp-rpc-replay-fixture",
      ompTag: OMP_LOCK.tag,
      contractVersion: OMP_LOCK.contract.version,
      command: "bun",
      launchArgs:
        typeof launchArgs === "object" &&
        launchArgs !== null &&
        "args" in launchArgs &&
        Array.isArray(launchArgs.args)
          ? launchArgs.args.map(String)
          : [],
    },
    entries: normalized,
  };

  // The normalized transcript must replay before it is written.
  yield* replayOmpScenario(scenario, transcript, {
    platform,
    pidfilesDir: NodePath.join(root, "replay-pidfiles"),
  });

  const output = NodeURL.fileURLToPath(ompTranscriptUrl(scenario.name));
  NodeFS.mkdirSync(NodePath.dirname(output), { recursive: true });
  NodeFS.writeFileSync(output, encodeOmpTranscriptNdjson(transcript));
  yield* Console.log(`Wrote ${transcript.entries.length} OMP replay entries to ${output}`);
});

await Effect.runPromise(
  Effect.forEach(scenarios, (scenario) => recordScenario(scenario).pipe(Effect.scoped), {
    discard: true,
  }).pipe(Effect.provide(NodeServices.layer)),
);
