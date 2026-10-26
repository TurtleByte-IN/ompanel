// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - a loopback HTTP fixture.
// A scripted OpenAI-compatible chat model for the OMP end-to-end test: no account, no API key.
// Adapted from the fork's `packages/coding-agent/test/rpc-wire/fake-openai-server.ts`, like the
// replay recorder's model (`apps/server/scripts/record-omp-rpc-replay-fixture.ts`).
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";

/** A user message containing `stall:` gets a reply that streams its first words, then hangs. */
const STALL_PREFIX = "stall:";
const STALLED_REPLY = "Working on it, slowly.";
/** A user message containing `run: <command>` makes the model call the shell tool with it. */
const RUN_PREFIX = "run: ";
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
  readonly tools?: ReadonlyArray<{ readonly function?: { readonly name?: string } }>;
}

type Reply =
  | { readonly text: string }
  | { readonly tool: string; readonly args: Record<string, unknown> };

/** One served chat request, for assertions. */
export interface ScriptedModelCall {
  readonly lastRole: string;
  readonly lastText: string;
  readonly tools: ReadonlyArray<string>;
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

const scriptedReply = (request: ChatRequest): Reply => {
  const messages = request.messages ?? [];
  const last = messages.at(-1);
  if (last?.role === "tool") {
    const firstLine = messageText(last.content).trim().split("\n")[0] ?? "";
    return { text: `${TOOL_REPLY_PREFIX}${firstLine}` };
  }
  const prompt = messages.map((message) => messageText(message.content)).join("\n");
  const json = jsonReply(prompt);
  if (json !== undefined) return { text: json };
  const userText = last?.role === "user" ? messageText(last.content) : "";
  const runAt = userText.indexOf(RUN_PREFIX);
  if (runAt !== -1) {
    const command =
      userText
        .slice(runAt + RUN_PREFIX.length)
        .split("\n")[0]
        ?.trim() ?? "";
    const offered = new Set((request.tools ?? []).map((tool) => tool.function?.name));
    // T3 replaces OMP's `bash` with its `terminal` host tool (docs/omp/host-tools.md).
    const tool = offered.has("terminal") ? "terminal" : "bash";
    return { tool, args: { command } };
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
      tool_calls: [
        {
          index: 0,
          id: `call_${Date.now()}`,
          type: "function",
          function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
        },
      ],
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
              tool_calls: [
                {
                  id: "call_g1",
                  type: "function",
                  function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
                },
              ],
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
