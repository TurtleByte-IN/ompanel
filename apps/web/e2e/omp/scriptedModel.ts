// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - a loopback HTTP fixture.
// A scripted OpenAI-compatible chat model for the OMP end-to-end tests: no account, no API key.
// Adapted from the fork's `packages/coding-agent/test/rpc-wire/fake-openai-server.ts`, like the
// replay recorder's model (`apps/server/scripts/record-omp-rpc-replay-fixture.ts`). The live
// suite's prompts are written so that this model and a real one both answer them.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

/** A user message containing `stall:` gets a reply that streams its first words, then hangs. */
const STALL_PREFIX = "stall:";
const STALLED_REPLY = "Working on it, slowly.";
/** A user message containing `run: <command>` makes the model call the shell tool with it. */
const RUN_PREFIX = "run: ";
/**
 * A user message with a line `tool: <name> <json-args>` makes the model call the offered tool
 * `<name>` with those arguments (`{}` when none): a T3 MCP tool OMP was given as a host tool.
 * Only a whole line counts (after the `<system-reminder>` OMP puts before a session's first
 * message), so other text that mentions a tool never triggers it.
 */
const TOOL_LINE = /^tool: (.*)$/m;
const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g;
/** The reply when `tool:` names a tool OMP did not offer, or its arguments are not a JSON object. */
export const TOOL_REFUSED_PREFIX = "scripted model cannot call ";
/** `fanout: a, b` makes the model start one subagent per name with OMP's `task` tool. */
const FANOUT_PREFIX = "fanout: ";
/** A subagent (offered OMP's `yield` tool) yields this as its result. */
const SUBAGENT_RESULT = "subagent done";
/** A user message containing this, while OMP offers its `goal` tool, marks the goal complete. */
export const GOAL_DONE_MARKER = "goal done:";
/** The text after this marker comes back verbatim. */
export const VERBATIM_MARKER = "Reply with exactly these two paragraphs and nothing else:";
/** This question is answered with every `code word: <word>` the conversation holds. */
export const CODE_WORD_QUESTION = "List every code word I asked you to remember";
const CODE_WORD = /code word: (\S+?)\.?(?:\s|$)/g;
/**
 * The streamed reply to any other user message, one delta per word. Two paragraphs: Ompanel's
 * default `responseStreamingMode` ("paragraph") shows streamed text a finished paragraph at a time.
 */
export const STREAMED_PARAGRAPHS = [
  "Streaming hello from the scripted OMP model.",
  "This second paragraph arrives a moment later.",
] as const;
/** The reply after a tool result: `ran: <first line of the tool output>`. */
export const TOOL_REPLY_PREFIX = "ran: ";
export const COMMIT_SUBJECT = "Add the G1 end-to-end marker";
const THREAD_TITLE = "G1 end-to-end thread";

interface ChatMessage {
  readonly role?: string;
  readonly content?: unknown;
}

interface ChatRequest {
  readonly stream?: boolean;
  readonly messages?: ReadonlyArray<ChatMessage>;
  readonly tools?: ReadonlyArray<{
    readonly function?: {
      readonly name?: string;
      readonly parameters?: { readonly properties?: Record<string, unknown> };
    };
  }>;
}

interface ToolCall {
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

type Reply = { readonly text: string } | { readonly calls: ReadonlyArray<ToolCall> };

/** One served chat request, for assertions. */
export interface ScriptedModelCall {
  readonly lastRole: string;
  readonly lastText: string;
  readonly tools: ReadonlyArray<string>;
  /**
   * Tools OMP mounted as `xd://<name>` devices, from the system prompt: a host tool without a
   * `loadMode` is "discoverable", and OMP mounts those rather than listing them in `tools`.
   */
  readonly devices: ReadonlyArray<string>;
  /** The text of every user message the model was sent, oldest first: the conversation OMP kept. */
  readonly userTexts: ReadonlyArray<string>;
  readonly reply: Reply;
}

const messageText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part ? String(part.text) : "",
    )
    .join("");
};

/**
 * Ompanel's text generation prompts name the JSON keys they want: "Return a JSON object with
 * keys: a, b." (commit message, pull request, branch) or "Return JSON with keys title and
 * needsRefinement." (thread title).
 */
const jsonReply = (prompt: string): string | undefined => {
  if (prompt.includes("Return JSON with keys title and needsRefinement")) {
    return JSON.stringify({ title: THREAD_TITLE, needsRefinement: false });
  }
  const keys = /Return a JSON object with keys?: ([a-z, ]+)\./.exec(prompt)?.[1];
  if (keys === undefined) return undefined;
  const values: Record<string, string> = {
    subject: COMMIT_SUBJECT,
    body: "",
    branch: "g1-e2e-marker",
    title: THREAD_TITLE,
  };
  return JSON.stringify(
    Object.fromEntries(keys.split(",").map((key) => [key.trim(), values[key.trim()] ?? "g1"])),
  );
};

/**
 * One `task` call per subagent, or one batch call when OMP's `task.batch` shape is offered
 * (`{ context, tasks[] }`).
 */
const fanoutCalls = (request: ChatRequest, names: ReadonlyArray<string>): Array<ToolCall> => {
  const task = (request.tools ?? []).find((tool) => tool.function?.name === "task");
  const item = (name: string) => ({
    name,
    task: `Reply with ${name}-done.`,
    solutionSpace: "one fixed answer",
  });
  if (task?.function?.parameters?.properties?.tasks !== undefined) {
    return [{ tool: "task", args: { context: "Scripted fan-out.", tasks: names.map(item) } }];
  }
  return names.map((name) => ({ tool: "task", args: { agent: "task", ...item(name) } }));
};

/** The `xd://<name>` devices a request's system prompt lists. */
const mountedDevices = (messages: ReadonlyArray<ChatMessage>): Array<string> => [
  ...new Set(
    messages
      .filter((message) => message.role === "system" || message.role === "developer")
      .flatMap((message) => [...messageText(message.content).matchAll(XD_DEVICE)])
      .map((match) => match[1] ?? ""),
  ),
];

/**
 * The call a `tool: <name> <json-args>` line asks for, or why the model cannot make it. A tool
 * in `tools` is called directly; a mounted device is called as OMP documents it, with
 * `write { path: "xd://<name>", content: "<json-args>" }`.
 */
const namedToolReply = (
  line: string,
  offered: ReadonlySet<string | undefined>,
  devices: ReadonlyArray<string>,
): Reply => {
  const name = line.trim().split(/\s+/)[0] ?? "";
  const json = line.trim().slice(name.length).trim() || "{}";
  const mounted = !offered.has(name) && offered.has("write") && devices.includes(name);
  if (!offered.has(name) && !mounted) {
    const names = [...offered].filter((tool) => tool !== undefined).sort();
    return {
      text: `${TOOL_REFUSED_PREFIX}${name}: not offered (tools: ${names.join(", ")}; devices: ${devices.length})`,
    };
  }
  let args: unknown;
  try {
    args = JSON.parse(json);
  } catch {
    return { text: `${TOOL_REFUSED_PREFIX}${name}: its arguments are not JSON` };
  }
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return { text: `${TOOL_REFUSED_PREFIX}${name}: its arguments are not a JSON object` };
  }
  return mounted
    ? { calls: [{ tool: "write", args: { path: `xd://${name}`, content: JSON.stringify(args) } }] }
    : { calls: [{ tool: name, args: args as Record<string, unknown> }] };
};

const scriptedReply = (request: ChatRequest): Reply => {
  const messages = request.messages ?? [];
  const last = messages.at(-1);
  const offered = new Set((request.tools ?? []).map((tool) => tool.function?.name));
  if (last?.role === "tool") {
    const firstLine = messageText(last.content).trim().split("\n")[0] ?? "";
    return { text: `${TOOL_REPLY_PREFIX}${firstLine}` };
  }
  // Only a subagent is offered `yield`; it finishes its task by yielding.
  if (last?.role === "user" && offered.has("yield")) {
    return { calls: [{ tool: "yield", args: { data: SUBAGENT_RESULT } }] };
  }
  const prompt = messages.map((message) => messageText(message.content)).join("\n");
  const json = jsonReply(prompt);
  if (json !== undefined) return { text: json };
  const userText = last?.role === "user" ? messageText(last.content) : "";
  const toolLine = TOOL_LINE.exec(userText.replace(SYSTEM_REMINDER, ""))?.[1];
  if (toolLine !== undefined) return namedToolReply(toolLine, offered);
  const runAt = userText.indexOf(RUN_PREFIX);
  if (runAt !== -1) {
    const command =
      userText
        .slice(runAt + RUN_PREFIX.length)
        .split("\n")[0]
        ?.trim() ?? "";
    // T3 replaces OMP's `bash` with its `terminal` host tool (docs/omp/host-tools.md).
    const tool = offered.has("terminal") ? "terminal" : "bash";
    return { calls: [{ tool, args: { command } }] };
  }
  if (userText.includes(GOAL_DONE_MARKER) && offered.has("goal")) {
    return { calls: [{ tool: "goal", args: { op: "complete" } }] };
  }
  const fanoutAt = userText.indexOf(FANOUT_PREFIX);
  if (fanoutAt !== -1 && offered.has("task")) {
    const names = (userText.slice(fanoutAt + FANOUT_PREFIX.length).split("\n")[0] ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter((name) => name !== "");
    return { calls: fanoutCalls(request, names) };
  }
  const verbatimAt = userText.indexOf(VERBATIM_MARKER);
  if (verbatimAt !== -1)
    return { text: userText.slice(verbatimAt + VERBATIM_MARKER.length).trim() };
  if (userText.includes(CODE_WORD_QUESTION)) {
    const words = messages
      .slice(0, -1)
      .filter((message) => message.role === "user")
      .flatMap((message) =>
        [...messageText(message.content).matchAll(CODE_WORD)].map((match) => match[1]),
      );
    return { text: words.length === 0 ? "NONE" : words.join(" ") };
  }
  if (userText.includes(STALL_PREFIX)) return { text: STALLED_REPLY };
  return { text: STREAMED_PARAGRAPHS.join("\n\n") };
};

const USAGE = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
const BASE = {
  id: "chatcmpl-g1",
  object: "chat.completion.chunk",
  created: 0,
  model: "fake-model",
};

const sse = (chunk: object) => `data: ${JSON.stringify(chunk)}\n\n`;

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

/** Text streams one word per chunk, 120 ms apart, so the UI renders it in pieces. */
const streamReply = async (response: NodeHttp.ServerResponse, reply: Reply) => {
  response.writeHead(200, { "content-type": "text/event-stream" });
  if ("text" in reply && reply.text === STALLED_REPLY) {
    // The first words, then nothing until the client hangs up (OMP's abort) or a minute passes.
    response.write(
      sse({
        ...BASE,
        choices: [
          { index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null },
        ],
      }),
    );
    const deadline = Date.now() + 60_000;
    while (!response.destroyed && !response.socket?.destroyed && Date.now() < deadline) {
      await sleep(100);
    }
    if (!response.writableEnded && !response.destroyed) response.end("data: [DONE]\n\n");
    return;
  }
  if ("text" in reply) {
    const words = reply.text.startsWith("{") ? [reply.text] : reply.text.split(/(?<=\s)/);
    for (const [index, word] of words.entries()) {
      const delta = index === 0 ? { role: "assistant", content: word } : { content: word };
      response.write(sse({ ...BASE, choices: [{ index: 0, delta, finish_reason: null }] }));
      await sleep(120);
    }
  } else {
    const delta = {
      role: "assistant",
      tool_calls: reply.calls.map((call, index) => ({
        index,
        id: `call_${Date.now()}_${index}`,
        type: "function",
        function: { name: call.tool, arguments: JSON.stringify(call.args) },
      })),
    };
    response.write(sse({ ...BASE, choices: [{ index: 0, delta, finish_reason: null }] }));
  }
  const finish = "text" in reply ? "stop" : "tool_calls";
  response.write(sse({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: finish }] }));
  response.write(sse({ ...BASE, choices: [], usage: USAGE }));
  response.end("data: [DONE]\n\n");
};

const completionBody = (reply: Reply) => ({
  id: "chatcmpl-g1",
  object: "chat.completion",
  created: 0,
  model: "fake-model",
  choices: [
    {
      index: 0,
      message:
        "text" in reply
          ? { role: "assistant", content: reply.text }
          : {
              role: "assistant",
              content: null,
              tool_calls: reply.calls.map((call, index) => ({
                id: `call_g1_${index}`,
                type: "function",
                function: { name: call.tool, arguments: JSON.stringify(call.args) },
              })),
            },
      finish_reason: "text" in reply ? "stop" : "tool_calls",
    },
  ],
  usage: USAGE,
});

export interface ScriptedModel {
  readonly calls: ReadonlyArray<ScriptedModelCall>;
  readonly close: () => Promise<void>;
}

/**
 * Listens on a loopback port and writes `<agentDir>/models.yml` declaring provider `fake`
 * (model `fake-model`, no auth) at it.
 */
export const startScriptedModel = async (agentDir: string): Promise<ScriptedModel> => {
  const calls: Array<ScriptedModelCall> = [];
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
      const reply = scriptedReply(chat);
      const last = chat.messages?.at(-1);
      calls.push({
        lastRole: last?.role ?? "",
        lastText: messageText(last?.content),
        tools: (chat.tools ?? []).flatMap((tool) =>
          tool.function?.name === undefined ? [] : [tool.function.name],
        ),
        userTexts: (chat.messages ?? []).flatMap((message) =>
          message.role === "user" ? [messageText(message.content)] : [],
        ),
        reply,
      });
      if (chat.stream === true) {
        void streamReply(response, reply);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completionBody(reply)));
    });
  });
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    resolve(typeof address === "object" && address !== null ? address.port : 0);
  });
  const port = await promise;
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
  return {
    calls,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close(() => closed.resolve());
      return closed.promise;
    },
  };
};
