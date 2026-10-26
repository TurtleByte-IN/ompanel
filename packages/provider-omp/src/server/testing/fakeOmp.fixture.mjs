// A scripted stand-in for `omp --mode rpc-ui`, driven by FAKE_OMP_* environment variables and,
// optionally, a FAKE_OMP_SCRIPT JSON file (see `FakeOmpScript` in fakeOmp.ts).
// It records what happened to it in FAKE_OMP_STATE (argv.json, events.log, commands.jsonl, tree.json).
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
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
  if (frame.type === "session_info_update") {
    sessionId = frame.sessionId;
    // Like `/fresh`: the reported id changes, the file and its header keep theirs.
    if (store !== null) store.current.reportedId = frame.sessionId;
  }
  if (frame.type === "agent_end" && store !== null) store.appendMessages(frame.messages ?? []);
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

/**
 * FAKE_OMP_SESSIONS_DIR keeps sessions on disk like OMP (one bucket per cwd); unscripted session
 * commands use it, and an accepted `host_cwd_change_result` moves the file (docs/omp/testing.md).
 * FAKE_OMP_AUTO_RESUME=1 starts on the bucket's newest session, like OMP's `autoResume`. As in
 * the pinned fork, `/fresh` changes only the id `get_state` reports, not the file or its header.
 */
function makeStore(root) {
  const argv = process.argv.slice(2);
  const cwdFlag = argv.indexOf("--cwd");
  const startCwd = cwdFlag >= 0 ? argv[cwdFlag + 1] : process.cwd();
  const bucket = (cwd) => NodePath.join(root, cwd.replace(/[\\/:]/g, "-"));
  const fresh = (cwd) => {
    const id = `fake-${NodeCrypto.randomUUID()}`;
    const timestamp = new Date().toISOString();
    return {
      id,
      reportedId: null,
      cwd,
      title: null,
      timestamp,
      file: NodePath.join(bucket(cwd), `${timestamp.replace(/[:.]/g, "-")}_${id}.jsonl`),
      messages: [],
      // Parallel to `messages`: each one's entry id and timestamp, kept by branch and fork.
      entryIds: [],
      entryTimes: [],
    };
  };
  const load = (file) => {
    let title = null;
    let header = null;
    const messages = [];
    const entryIds = [];
    const entryTimes = [];
    for (const line of NodeFS.readFileSync(file, "utf8").split("\n")) {
      if (line.trim() === "") continue;
      const entry = JSON.parse(line);
      if (entry.type === "title") title = entry.title;
      else if (entry.type === "session") header = entry;
      else if (entry.type === "message") {
        messages.push(entry.message);
        entryIds.push(entry.id);
        entryTimes.push(entry.timestamp);
      }
    }
    return {
      id: header.id,
      reportedId: null,
      cwd: header.cwd,
      title,
      timestamp: header.timestamp,
      file,
      messages,
      entryIds,
      entryTimes,
    };
  };
  /** Like OMP's branch and fork: a new file holding the first `count` entries, ids kept. */
  const copyPrefix = (count) => {
    const source = store.current;
    const copy = fresh(source.cwd);
    copy.title = source.title;
    copy.messages = source.messages.slice(0, count);
    copy.entryIds = source.entryIds.slice(0, count);
    copy.entryTimes = source.entryTimes.slice(0, count);
    store.current = copy;
    store.persist();
  };
  const store = {
    current: fresh(startCwd),
    persist() {
      const session = store.current;
      if (session.messages.length === 0 && session.title === null) return;
      NodeFS.mkdirSync(NodePath.dirname(session.file), { recursive: true });
      const lines = [];
      if (session.title !== null) {
        lines.push(JSON.stringify({ type: "title", v: 1, title: session.title, source: "user" }));
      }
      lines.push(
        JSON.stringify({
          type: "session",
          version: 3,
          id: session.id,
          timestamp: session.timestamp,
          cwd: session.cwd,
        }),
      );
      let parentId = null;
      session.messages.forEach((message, index) => {
        const id = session.entryIds[index];
        const timestamp = session.entryTimes[index];
        lines.push(JSON.stringify({ type: "message", id, parentId, timestamp, message }));
        parentId = id;
      });
      NodeFS.writeFileSync(session.file, `${lines.join("\n")}\n`);
    },
    appendMessages(messages) {
      const session = store.current;
      for (const message of messages) {
        session.messages.push(message);
        session.entryIds.push(NodeCrypto.randomUUID().slice(0, 8));
        session.entryTimes.push(new Date().toISOString());
      }
      store.persist();
    },
    /** Raw `get_entries` entries: `message` entries chained by `parentId`. */
    entries() {
      const session = store.current;
      return session.messages.map((message, index) => ({
        type: "message",
        id: session.entryIds[index],
        parentId: index === 0 ? null : session.entryIds[index - 1],
        timestamp: session.entryTimes[index],
        message,
      }));
    },
    /** `branch {entryId}` at a user message: a new file holding what came before it. */
    branch(entryId) {
      const index = store.current.entryIds.indexOf(entryId);
      const message = store.current.messages[index];
      if (message?.role !== "user") return null;
      copyPrefix(index);
      return userText(message);
    },
    /** `fork {entryId?}`: a new file holding everything through the entry. */
    fork(entryId) {
      const index =
        entryId === undefined
          ? store.current.messages.length - 1
          : store.current.entryIds.indexOf(entryId);
      if (entryId !== undefined && index < 0) return false;
      copyPrefix(index + 1);
      return true;
    },
    newSession() {
      store.current = fresh(store.current.cwd);
    },
    switchSession(file) {
      store.current = load(file);
    },
    moveTo(cwd) {
      const session = store.current;
      const target = NodePath.join(bucket(cwd), NodePath.basename(session.file));
      const existed = NodeFS.existsSync(session.file);
      session.cwd = cwd;
      const source = session.file;
      session.file = target;
      store.persist();
      if (existed && source !== target) NodeFS.rmSync(source);
    },
    page(cursor, limit) {
      const session = store.current;
      let offset = 0;
      if (cursor !== undefined) {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
        if (decoded.sessionId !== session.id || decoded.count !== session.messages.length) {
          return null;
        }
        offset = decoded.offset;
      }
      const messages = session.messages.slice(offset, offset + (limit ?? 100));
      const next = offset + messages.length;
      const nextCursor =
        next < session.messages.length
          ? Buffer.from(
              JSON.stringify({
                sessionId: session.id,
                count: session.messages.length,
                offset: next,
              }),
            ).toString("base64url")
          : undefined;
      return {
        messages,
        totalMessages: session.messages.length,
        ...(nextCursor === undefined ? {} : { nextCursor }),
      };
    },
  };
  if (env.FAKE_OMP_AUTO_RESUME === "1" && NodeFS.existsSync(bucket(startCwd))) {
    const newest = NodeFS.readdirSync(bucket(startCwd))
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => NodePath.join(bucket(startCwd), name))
      .sort((a, b) => NodeFS.statSync(b).mtimeMs - NodeFS.statSync(a).mtimeMs)[0];
    if (newest !== undefined) store.current = load(newest);
  }
  return store;
}

const store = env.FAKE_OMP_SESSIONS_DIR ? makeStore(env.FAKE_OMP_SESSIONS_DIR) : null;

function userText(message) {
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
}

/** The store's answer to an unscripted command, or `undefined` when it does not handle it. */
function storeResponse(command) {
  const ok = (data) => ({ success: true, ...(data === undefined ? {} : { data }) });
  switch (command.type) {
    case "get_state":
      return ok({
        sessionId: store.current.reportedId ?? store.current.id,
        sessionFile: store.current.file,
        messageCount: store.current.messages.length,
        ...(store.current.title === null ? {} : { sessionName: store.current.title }),
      });
    case "new_session":
      store.newSession();
      return ok({ cancelled: false });
    case "switch_session":
      if (!NodeFS.existsSync(command.sessionPath)) {
        return { success: false, error: `Session file not found: ${command.sessionPath}` };
      }
      store.switchSession(command.sessionPath);
      return ok({ cancelled: false });
    case "get_messages_page": {
      const page = store.page(command.cursor, command.limit);
      return page === null
        ? { success: false, error: "RPC message cursor is stale", code: "stale_cursor" }
        : ok(page);
    }
    case "set_session_name":
      store.current.title = command.name;
      store.persist();
      return ok(undefined);
    case "get_entries": {
      const entries = store.entries();
      const leafId = entries.at(-1)?.id ?? null;
      if (command.since === undefined) return ok({ entries, leafId });
      const index = entries.findIndex((entry) => entry.id === command.since);
      return index < 0
        ? {
            success: false,
            error: `Unknown entries cursor: ${command.since}`,
            code: "unknown_since",
          }
        : ok({ entries: entries.slice(index + 1), leafId });
    }
    case "get_tree": {
      // A linear session: each entry the only child of the one before.
      const entries = store.entries();
      let tree = [];
      for (const entry of entries.toReversed()) tree = [{ entry, children: tree }];
      return ok({ tree, leafId: entries.at(-1)?.id ?? null });
    }
    case "get_branch_messages":
      return ok({
        messages: store
          .entries()
          .filter((entry) => entry.message.role === "user")
          .map((entry) => ({ entryId: entry.id, text: userText(entry.message) })),
      });
    case "branch": {
      const text = store.branch(command.entryId);
      return text === null
        ? { success: false, error: "Invalid entry ID for branching" }
        : ok({ text, cancelled: false });
    }
    case "fork":
      return store.fork(command.entryId)
        ? ok({ cancelled: false })
        : { success: false, error: `Invalid entry ID for forking: ${command.entryId}` };
    default:
      return undefined;
  }
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
    if (store !== null && command.type === "prompt" && command.message === "/fresh") {
      // As recorded (omp_fresh): an ack without data, then an aborted prompt_result, no turn.
      store.current.reportedId = `fresh-${NodeCrypto.randomUUID()}`;
      write({ id: command.id, type: "response", command: "prompt", success: true });
      write({
        type: "prompt_result",
        id: command.id,
        agentInvoked: true,
        status: "aborted",
        sessionSettled: true,
      });
      continue;
    }
    if (store !== null && command.type === "prompt" && typeof command.message === "string") {
      store.appendMessages([
        {
          role: "user",
          content: [{ type: "text", text: command.message }],
          timestamp: Date.now(),
        },
      ]);
    }
    if (store !== null && command.type === "host_cwd_change_result") {
      // A host reply, not a command: OMP moves the session when the host accepted.
      if (command.accepted === true && typeof command.cwd === "string") store.moveTo(command.cwd);
      continue;
    }
    const scripted = script.commands?.[command.type];
    if (scripted !== undefined && command.type !== "negotiate_protocol") {
      runSteps(scripted, command);
      continue;
    }
    const stored = store === null ? undefined : storeResponse(command);
    if (stored !== undefined) {
      write({ id: command.id, type: "response", command: command.type, ...stored });
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
