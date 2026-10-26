// A scripted stand-in for `omp --mode rpc-ui`, driven by FAKE_OMP_* environment variables and,
// optionally, a FAKE_OMP_SCRIPT JSON file (see `FakeOmpScript` in fakeOmp.ts).
// It records what happened to it in FAKE_OMP_STATE (argv.json, events.log, commands.jsonl, tree.json).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTimersPromises from "node:timers/promises";

const env = process.env;
const stateDir = env.FAKE_OMP_STATE;
const MiB = 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

function record(event) {
  if (stateDir) NodeFS.appendFileSync(NodePath.join(stateDir, "events.log"), `${event}\n`);
}

/** Like OMP, a `session_info_update` changes the id `get_state` reports from then on. */
let sessionId = "fake-session";

function write(frame) {
  if (frame.type === "session_info_update") sessionId = frame.sessionId;
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

const script = env.FAKE_OMP_SCRIPT
  ? JSON.parse(NodeFS.readFileSync(env.FAKE_OMP_SCRIPT, "utf8"))
  : {};

/** Exits once everything already written has reached the pipe. */
function exitAfterFlush(code) {
  process.stdout.write("", () => process.exit(code));
}

/** Replaces every `"$id"` string in `value` with the triggering command's id. */
function bindId(value, id) {
  if (value === "$id") return id;
  if (Array.isArray(value)) return value.map((item) => bindId(item, id));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, bindId(item, id)]));
  }
  return value;
}

/** Runs scripted steps in order; a chain per process keeps frames in step order. */
let chain = Promise.resolve();
function runSteps(steps, command) {
  chain = chain.then(async () => {
    for (const step of steps) {
      if ("sleepMs" in step) await NodeTimersPromises.setTimeout(step.sleepMs);
      else if ("emit" in step) write(bindId(step.emit, command?.id));
      else if ("emitChunked" in step) writeChunked(bindId(step.emitChunked, command?.id));
      else if ("writeRaw" in step) process.stdout.write(step.writeRaw);
      else if ("respond" in step) {
        write({
          id: command.id,
          type: "response",
          command: command.type,
          success: true,
          ...(step.respond === undefined ? {} : { data: bindId(step.respond, command.id) }),
        });
      } else if ("fail" in step) {
        write({
          id: command.id,
          type: "response",
          command: command.type,
          success: false,
          error: step.fail,
          ...(step.code === undefined ? {} : { code: step.code }),
        });
      } else if ("exit" in step) {
        record(`exit:${step.exit}`);
        exitAfterFlush(step.exit);
        // Never resolves: nothing after `exit` may run.
        await Promise.withResolvers().promise;
      }
    }
  });
}

let chunkSequence = 0;
function writeChunked(frame) {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const count = Math.ceil(bytes.byteLength / CHUNK_BYTES);
  const chunkId = `fake-${++chunkSequence}`;
  for (let index = 0; index < count; index++) {
    write({
      type: "rpc_chunk",
      chunkId,
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
if (script.afterReady !== undefined) runSteps(script.afterReady, undefined);

function afterNegotiate() {
  runSteps(
    script.afterNegotiate ?? [{ emit: { type: "notice", message: "negotiated" } }],
    undefined,
  );
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
    if (stateDir) {
      NodeFS.appendFileSync(NodePath.join(stateDir, "commands.jsonl"), `${line}\n`);
    }
    const scripted = script.commands?.[command.type];
    if (scripted !== undefined && command.type !== "negotiate_protocol") {
      runSteps(scripted, command);
      continue;
    }
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
          data: { sessionId, sessionFile: `/fake/sessions/${sessionId}.jsonl` },
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
  // OMP drains accepted work before exiting; so does the fake with scripted steps.
  void chain.then(() => exitAfterFlush(0));
});
