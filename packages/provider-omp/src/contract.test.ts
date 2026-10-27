// @effect-diagnostics nodeBuiltinImport:off
/**
 * Every OMP frame Ompanel's tests rely on conforms to the vendored wire schema
 * (`contract/rpc-wire.schema.json`): the recorded replay fixtures from the pinned OMP, and what the
 * fake omp writes. A re-pin whose frames drift from its own schema fails here.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { afterAll, describe, expect, it } from "vite-plus/test";

import { FAKE_OMP_FIXTURE, type FakeOmpScript, fakeOmpFrames } from "./server/testing/fakeOmp.ts";

type Frame = Record<string, unknown>;

/** One frame of a conversation: written by the host (commands, replies) or by OMP. */
interface WireEntry {
  readonly direction: "host" | "omp";
  readonly frame: Frame;
}

interface RpcCommandSpec {
  readonly name: string;
  readonly params: string | null;
  readonly result: string | null;
  readonly nullable: boolean;
}

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const schema = JSON.parse(
  NodeFS.readFileSync(NodePath.join(here, "../contract/rpc-wire.schema.json"), "utf8"),
) as {
  readonly $id: string;
  readonly $defs: Record<string, unknown>;
  readonly "x-rpc": {
    readonly serverFrame: string;
    readonly inbound: string;
    readonly commands: ReadonlyArray<RpcCommandSpec>;
  };
};
const rpc = schema["x-rpc"];

const ajv = new Ajv2020({ allErrors: true, strict: true });
// Generator annotations, not validation keywords: `x-rpc` is the command table; `x-open`,
// `x-unknown-fallback` and `x-scalar-or-array` tell decoders how leniently to read a value. This
// check holds frames to the declared shape itself, so it is stricter than any decoder.
for (const keyword of ["x-rpc", "x-open", "x-unknown-fallback", "x-scalar-or-array"]) {
  ajv.addKeyword(keyword);
}
ajv.addSchema(schema);

const validators = new Map<string, ValidateFunction>();
const validator = (def: string): ValidateFunction => {
  let validate = validators.get(def);
  if (validate === undefined) {
    if (!(def in schema.$defs)) throw new Error(`the wire schema has no $defs/${def}`);
    validate = ajv.getSchema(`${schema.$id}#/$defs/${def}`);
    if (validate === undefined) throw new Error(`could not compile $defs/${def}`);
    validators.set(def, validate);
  }
  return validate;
};
const commands = new Map(rpc.commands.map((command) => [command.name, command]));

/** Schema violations of `value` against `$defs/def`, as readable lines; empty when it conforms. */
function violations(def: string, value: unknown): ReadonlyArray<string> {
  const validate = validator(def);
  if (validate(value)) return [];
  return (validate.errors ?? []).map(
    (error) => `${def}${error.instancePath} ${error.message ?? error.keyword}`,
  );
}

/** A frame OMP writes to stdout, after `rpc_chunk` reassembly. */
const serverFrameViolations = (frame: unknown) => violations(rpc.serverFrame, frame);

/**
 * A frame the host writes: a command (`type` is a command name, the rest its params) or a
 * non-command host reply such as `extension_ui_response`.
 */
function hostFrameViolations(frame: Frame): ReadonlyArray<string> {
  const command = typeof frame.type === "string" ? commands.get(frame.type) : undefined;
  if (command === undefined) return violations(rpc.inbound, frame);
  const { type: _type, id: _id, ...params } = frame;
  if (command.params !== null) return violations(command.params, params);
  return Object.keys(params).length === 0
    ? []
    : [`${command.name} takes no params, got ${Object.keys(params).join(", ")}`];
}

/**
 * A successful response's `data` against its command's `result`. Absent `data` is allowed, as
 * `RpcResponse` declares it optional: the pinned OMP acks an agent-invoking `prompt` without data.
 */
function responseDataViolations(frame: Frame, commandName: string): ReadonlyArray<string> {
  if (frame.type !== "response" || frame.success !== true || !("data" in frame)) return [];
  const command = commands.get(commandName);
  if (command === undefined || command.result === null) return [];
  if (command.nullable && frame.data === null) return [];
  return violations(command.result, frame.data).map((line) => `${commandName} data: ${line}`);
}

/** Checks a conversation in order; responses are matched to the host command with their `id`. */
function conversationViolations(frames: ReadonlyArray<WireEntry>): ReadonlyArray<string> {
  const sent = new Map<unknown, string>();
  const found: Array<string> = [];
  frames.forEach(({ direction, frame }, index) => {
    const at = `#${index} ${direction} ${String(frame.type)}`;
    if (direction === "host") {
      if (typeof frame.type === "string" && commands.has(frame.type))
        sent.set(frame.id, frame.type);
      for (const line of hostFrameViolations(frame)) found.push(`${at}: ${line}`);
      return;
    }
    for (const line of serverFrameViolations(frame)) found.push(`${at}: ${line}`);
    const commandName = frame.type === "response" ? sent.get(frame.id) : undefined;
    if (commandName !== undefined) {
      for (const line of responseDataViolations(frame, commandName)) found.push(`${at}: ${line}`);
    }
  });
  return found;
}

const FIXTURES_DIR = NodePath.join(
  here,
  "../../../apps/server/src/orchestration-v2/testkit/fixtures",
);
/** Steps the replay recorder adds around the wire; not OMP frames. */
const isTestkitStep = (type: unknown) => type === "process_start" || type === "stdin_close";

const recordedTranscripts = NodeFS.readdirSync(FIXTURES_DIR)
  .filter((name) => name.startsWith("omp_"))
  .map((name) => NodePath.join(FIXTURES_DIR, name, "omp_transcript.ndjson"))
  .filter((file) => NodeFS.existsSync(file))
  .toSorted();

function readTranscript(file: string): ReadonlyArray<WireEntry> {
  return NodeFS.readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as { type: string; frame?: Frame })
    .flatMap((entry): ReadonlyArray<WireEntry> => {
      if (entry.frame === undefined) return [];
      if (entry.type === "emit_inbound") return [{ direction: "omp", frame: entry.frame }];
      if (entry.type === "expect_outbound" && !isTestkitStep(entry.frame.type)) {
        return [{ direction: "host", frame: entry.frame }];
      }
      return [];
    });
}

describe("recorded OMP replay fixtures", () => {
  it("covers every recorded OMP scenario", () => {
    expect(recordedTranscripts.length).toBeGreaterThanOrEqual(11);
  });

  it.each(recordedTranscripts.map((file) => [NodePath.basename(NodePath.dirname(file)), file]))(
    "%s: every frame conforms to the wire schema",
    (_name, file) => {
      const frames = readTranscript(file);
      expect(frames.length).toBeGreaterThan(0);
      expect(conversationViolations(frames)).toEqual([]);
    },
  );
});

const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-contract-"));
afterAll(() => NodeFS.rmSync(scratch, { recursive: true, force: true }));

/** Reassembles v2 `rpc_chunk` sequences, as the host's reader does, into the frames they carry. */
function reassemble(lines: ReadonlyArray<Frame>): ReadonlyArray<Frame> {
  const frames: Array<Frame> = [];
  const pending = new Map<unknown, Array<string>>();
  for (const line of lines) {
    if (line.type !== "rpc_chunk") {
      frames.push(line);
      continue;
    }
    const parts = pending.get(line.chunkId) ?? [];
    parts[Number(line.index)] = String(line.data);
    pending.set(line.chunkId, parts);
    if (parts.filter((part) => part !== undefined).length === Number(line.count)) {
      pending.delete(line.chunkId);
      const bytes = Buffer.concat(parts.map((part) => Buffer.from(part, "base64")));
      frames.push(JSON.parse(bytes.toString("utf8")) as Frame);
    }
  }
  expect(pending.size, "every rpc_chunk sequence completes").toBe(0);
  return frames;
}

/** Runs the fake omp over `hostFrames`, then closes stdin; returns the conversation in order. */
function runFakeOmp(
  hostFrames: ReadonlyArray<Frame>,
  options: { readonly script?: FakeOmpScript; readonly env?: Record<string, string> } = {},
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(scratch, "fake-"));
  const env: NodeJS.ProcessEnv = { ...process.env, FAKE_OMP_STATE: dir, ...options.env };
  if (options.script !== undefined) {
    const file = NodePath.join(dir, "script.json");
    NodeFS.writeFileSync(file, JSON.stringify(options.script));
    env.FAKE_OMP_SCRIPT = file;
  }
  const workspace = NodePath.join(dir, "workspace");
  NodeFS.mkdirSync(workspace);
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [FAKE_OMP_FIXTURE, "--mode", "rpc-ui", "--cwd", workspace],
    {
      env,
      input: hostFrames.map((frame) => `${JSON.stringify(frame)}\n`).join(""),
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  const written = reassemble(
    result.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Frame),
  );
  // Host frames first, then everything the fake wrote; responses still pair by `id`.
  return [
    ...hostFrames.map((frame) => ({ direction: "host" as const, frame })),
    ...written.map((frame) => ({ direction: "omp" as const, frame })),
  ];
}

const host = (type: string, id: number, params: Frame = {}): Frame => ({
  id: `contract-${id}`,
  type,
  ...params,
});

describe("fake omp frames", () => {
  it("fakeOmpFrames builders produce conforming frames", () => {
    const tool = {
      toolCallId: "call-1",
      toolName: "read",
      args: { path: "README.md" },
      result: { content: [{ type: "text", text: "hi" }] },
      updates: [{ content: [{ type: "text", text: "h" }] }],
    };
    const emitted: Array<unknown> = [
      fakeOmpFrames.notice("Heads up"),
      fakeOmpFrames.sessionInfoUpdate("fake-session-2"),
      fakeOmpFrames.sessionInfoUpdate("fake-session-2", "Renamed"),
      fakeOmpFrames.subagentLifecycle({ id: "sub-1", status: "started" }),
      fakeOmpFrames.subagentLifecycle({ id: "sub-1", status: "completed" }),
      fakeOmpFrames.subagentEvent("sub-1", { type: "agent_start" }),
      fakeOmpFrames.commandOutput("output"),
    ];
    const acks: Array<unknown> = [];
    for (const turn of [
      { text: ["Hel", "lo"] },
      { text: ["Done"], thinking: ["Let me ", "think"], tool, messageId: "m-2" },
      { text: ["Failed"], tool: { ...tool, isError: true } },
    ]) {
      for (const step of fakeOmpFrames.promptTurn(turn)) {
        if ("emit" in step)
          emitted.push(JSON.parse(JSON.stringify(step.emit).replace("$id", "p-1")));
        if ("respond" in step) acks.push(step.respond);
      }
    }
    expect(
      emitted.flatMap((frame, index) =>
        serverFrameViolations(frame).map((line) => `#${index}: ${line}`),
      ),
    ).toEqual([]);
    expect(acks.flatMap((ack) => violations("PromptAck", ack))).toEqual([]);
  });

  it("the fake's own answers conform: handshake, state, collab, unsupported and a scripted turn", () => {
    const frames = runFakeOmp(
      [
        host("negotiate_protocol", 0, { protocolVersion: 2 }),
        host("get_state", 1),
        host("prompt", 2, { message: "Say hello" }),
        host("collab_start", 3, { access: "view" }),
        host("collab_status", 4),
        host("collab_stop", 5),
        host("abort", 6),
      ],
      {
        env: { FAKE_OMP_CONTRACT: "1.9.0" },
        script: {
          afterNegotiate: [
            { emit: fakeOmpFrames.notice("negotiated") },
            { emitChunked: fakeOmpFrames.commandOutput("x".repeat(300 * 1024)) },
          ],
          commands: {
            prompt: fakeOmpFrames.promptTurn({ text: ["Hel", "lo"], thinking: ["Hmm"] }),
          },
        },
      },
    );
    expect(frames.filter((entry) => entry.direction === "omp").length).toBeGreaterThan(10);
    expect(conversationViolations(frames)).toEqual([]);
  });

  it("the fake's defaults conform: ready, the negotiated notice and get_state", () => {
    const frames = runFakeOmp(
      [host("negotiate_protocol", 0, { protocolVersion: 2 }), host("get_state", 1)],
      {
        env: { FAKE_OMP_FIRST_FRAME: "notice" },
      },
    );
    expect(frames.map((entry) => entry.frame.type)).toEqual([
      "negotiate_protocol",
      "get_state",
      "notice",
      "ready",
      "response",
      "response",
      "notice",
    ]);
    expect(conversationViolations(frames)).toEqual([]);
  });

  it("the fake's session store answers conform", () => {
    const frames = runFakeOmp(
      [
        host("negotiate_protocol", 0, { protocolVersion: 2 }),
        host("prompt", 1, { message: "/fresh" }),
        host("prompt", 2, { message: "First question" }),
        host("set_session_name", 3, { name: "Contract" }),
        host("get_state", 4),
        host("get_messages_page", 5, { limit: 10 }),
        host("get_entries", 6),
        host("get_tree", 7),
        host("get_branch_messages", 8),
        host("branch", 9, { entryId: "missing-entry" }),
        host("fork", 10, { entryId: "missing-entry" }),
        host("export_html", 11),
        host("new_session", 12),
      ],
      {
        env: {
          FAKE_OMP_SESSIONS_DIR: NodePath.join(scratch, "sessions"),
          FAKE_OMP_CONTRACT: "1.9.0",
        },
        script: { commands: { prompt: fakeOmpFrames.promptTurn({ text: ["Answer"] }) } },
      },
    );
    // The store, not the "unsupported" fallback, answered every command.
    expect(frames.filter((entry) => entry.frame.code === "unsupported")).toEqual([]);
    expect(conversationViolations(frames)).toEqual([]);
  });
});

describe("the contract check itself", () => {
  it("rejects a frame whose type the schema does not declare", () => {
    expect(serverFrameViolations({ type: "frame_from_a_newer_omp", payload: {} })).not.toEqual([]);
    expect(hostFrameViolations({ type: "not_a_command", id: "x" })).not.toEqual([]);
  });

  it("rejects malformed frames: a missing required field, a wrong type, a bad enum", () => {
    expect(serverFrameViolations({ type: "notice", message: "no level" })).not.toEqual([]);
    expect(serverFrameViolations({ type: "ready", protocolVersion: "1" })).not.toEqual([]);
    expect(serverFrameViolations({ type: "notice", level: "shout", message: "x" })).not.toEqual([]);
    expect(hostFrameViolations({ type: "prompt", id: "1" })).not.toEqual([]);
    expect(hostFrameViolations({ type: "abort", id: "1", force: true })).not.toEqual([]);
  });

  it("rejects response data that does not match the command's result", () => {
    const frames = [
      { direction: "host" as const, frame: host("negotiate_protocol", 0, { protocolVersion: 2 }) },
      {
        direction: "omp" as const,
        frame: {
          id: "contract-0",
          type: "response",
          command: "negotiate_protocol",
          success: true,
          data: { protocolVersion: "two" },
        },
      },
    ];
    expect(conversationViolations(frames)).not.toEqual([]);
  });
});
