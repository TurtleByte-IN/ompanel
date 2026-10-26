// A scripted stand-in for `omp --mode rpc-ui`, driven by FAKE_OMP_* environment variables.
// It records what happened to it in FAKE_OMP_STATE (argv.json, events.log, tree.json).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const env = process.env;
const stateDir = env.FAKE_OMP_STATE;
const MiB = 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

function record(event) {
  if (stateDir) NodeFS.appendFileSync(NodePath.join(stateDir, "events.log"), `${event}\n`);
}

function write(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function writeChunked(frame) {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const count = Math.ceil(bytes.byteLength / CHUNK_BYTES);
  for (let index = 0; index < count; index++) {
    write({
      type: "rpc_chunk",
      chunkId: "fake-1",
      index,
      count,
      byteLength: bytes.byteLength,
      data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64"),
    });
  }
}

/** omp → child → grandchild, all in omp's process group; pids go to tree.json. */
function spawnTree() {
  const grandchildCode = "setInterval(() => {}, 1000)";
  const childCode = [
    "const cp = require('node:child_process');",
    `const g = cp.spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' });`,
    "process.stdout.write(String(g.pid));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  const child = NodeChildProcess.spawn(process.execPath, ["-e", childCode], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.stdout.once("data", (data) => {
    const tree = { omp: process.pid, child: child.pid, grandchild: Number(String(data)) };
    if (stateDir) NodeFS.writeFileSync(NodePath.join(stateDir, "tree.json"), JSON.stringify(tree));
    write({ type: "notice", message: "tree", tree });
  });
}

if (stateDir) {
  NodeFS.writeFileSync(
    NodePath.join(stateDir, "argv.json"),
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() }),
  );
}

process.on("SIGTERM", () => {
  record("sigterm");
  if (env.FAKE_OMP_IGNORE_SIGTERM !== "1") process.exit(143);
});

const contract = env.FAKE_OMP_CONTRACT ?? "1.0.0";
const negotiateContract = env.FAKE_OMP_NEGOTIATE_CONTRACT ?? contract;
if (env.FAKE_OMP_FIRST_FRAME === "notice") write({ type: "notice", message: "too early" });
write({
  type: "ready",
  protocolVersion: 1,
  supportedProtocolVersions: env.FAKE_OMP_V1_ONLY === "1" ? [1] : [1, 2],
  maxFrameBytes: MiB,
  maxReassembledFrameBytes: 64 * MiB,
  ...(contract === "none" ? {} : { contractVersion: contract }),
});
if (env.FAKE_OMP_SPAWN_TREE === "1") spawnTree();
if (env.FAKE_OMP_AFTER_READY === "chunk-early") {
  writeChunked({ type: "notice", message: "x".repeat(2 * MiB) });
}

function afterNegotiate() {
  switch (env.FAKE_OMP_AFTER_NEGOTIATE) {
    case "chunked":
      writeChunked({ type: "notice", message: "y".repeat(3 * MiB) });
      write({ type: "notice", message: "after-chunked" });
      break;
    case "oversized": {
      const byteLength = 64 * MiB + 1;
      write({
        type: "rpc_chunk",
        chunkId: "fake-big",
        index: 0,
        count: Math.ceil(byteLength / CHUNK_BYTES),
        byteLength,
        data: Buffer.alloc(CHUNK_BYTES, 0x61).toString("base64"),
      });
      break;
    }
    case "long-line":
      process.stdout.write(`${"z".repeat(MiB + 16)}\n`);
      break;
    default:
      write({ type: "notice", message: "negotiated" });
  }
}

let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (text) => {
  buffered += text;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim() === "") continue;
    const command = JSON.parse(line);
    record(`command:${command.type}`);
    switch (command.type) {
      case "negotiate_protocol":
        write({
          id: command.id,
          type: "response",
          command: "negotiate_protocol",
          success: true,
          data: {
            protocolVersion: command.protocolVersion,
            ...(negotiateContract === "none" ? {} : { contractVersion: negotiateContract }),
          },
        });
        afterNegotiate();
        break;
      case "get_state":
        write({
          id: command.id,
          type: "response",
          command: "get_state",
          success: true,
          data: { sessionId: "fake-session" },
        });
        break;
      default:
        write({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: `fake omp does not handle ${command.type}`,
          code: "unsupported",
        });
    }
  }
});
process.stdin.on("end", () => {
  record("stdin-end");
  if (env.FAKE_OMP_IGNORE_STDIN_END === "1") {
    setInterval(() => {}, 1000);
    return;
  }
  process.exit(0);
});
