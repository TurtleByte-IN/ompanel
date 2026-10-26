/**
 * A session's conversation, read from the live process with `get_messages_page` (C-10;
 * docs/omp/sessions.md). OMP pages one in-memory snapshot oldest first: a page holds at most 256
 * messages and 768 KiB, `nextCursor` is absent on the last page, and a cursor goes stale
 * (`code: "stale_cursor"`) when the session changes between pages (`modes/rpc/rpc-messages.ts`).
 */
import type { OrchestrationV2ConversationMessage, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import type { AgentMessage, MessagesPage } from "../../contract/src/wire.generated.ts";
import { OMP_PROVIDER } from "./mapper.ts";
import { ompMessageText } from "./ompSessions.ts";
import type { OmpRpcProcess } from "./rpcProcess.ts";

/** OMP's largest page. */
const OMP_HISTORY_PAGE_LIMIT = 256;
const PAGE_TIMEOUT_MS = 10_000;
/** A session that keeps changing under the reader is read again at most this often. */
const STALE_RETRIES = 2;

/**
 * Every page of the session's messages, oldest first. A cursor that went stale (the session
 * changed between pages) restarts the read from the first page.
 */
export const readOmpHistoryPages = Effect.fn("readOmpHistoryPages")(function* (
  process: Pick<OmpRpcProcess, "request">,
  options: { readonly limit?: number } = {},
) {
  const limit = options.limit ?? OMP_HISTORY_PAGE_LIMIT;
  let attempt = 0;
  while (true) {
    const pages: Array<MessagesPage> = [];
    let cursor: string | undefined;
    const read = Effect.gen(function* () {
      do {
        const page = yield* process.request(
          "get_messages_page",
          { limit, ...(cursor === undefined ? {} : { cursor }) },
          { timeoutMs: PAGE_TIMEOUT_MS },
        );
        pages.push(page);
        cursor = page.nextCursor;
      } while (cursor !== undefined);
      return pages;
    });
    const result = yield* read.pipe(
      Effect.catchTags({
        OmpRpcCommandError: (error) =>
          error.code === "stale_cursor" && attempt < STALE_RETRIES
            ? Effect.succeed(null)
            : Effect.fail(error),
      }),
    );
    if (result !== null) return result;
    attempt += 1;
  }
});

const assistantText = (message: Extract<AgentMessage, { role: "assistant" }>): string =>
  message.content
    .flatMap((block) =>
      block.type === "text"
        ? [block.text]
        : block.type === "thinking" && block.narration === true
          ? [block.thinking]
          : [],
    )
    .join("");

/**
 * The user and assistant messages of a session as thread messages, outside any run: what an
 * imported session shows. Tool results, bash runs, summaries and synthetic or empty messages
 * are left out. Ids follow the message's place in the session, so reading again updates the
 * same messages.
 */
export const ompHistoryMessages = (input: {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly messages: ReadonlyArray<AgentMessage>;
  readonly now: DateTime.Utc;
}): Array<OrchestrationV2ConversationMessage> =>
  input.messages.flatMap((message, index) => {
    let role: "user" | "assistant";
    let text: string;
    if (message.role === "user") {
      if (message.synthetic === true) return [];
      role = "user";
      text = ompMessageText(message.content);
    } else if (message.role === "assistant") {
      role = "assistant";
      text = assistantText(message);
    } else {
      return [];
    }
    if (text.trim() === "") return [];
    const createdAt =
      Number.isFinite(message.timestamp) && message.timestamp > 0
        ? DateTime.makeUnsafe(message.timestamp)
        : input.now;
    return [
      {
        id: IdAllocator.derive.messageFromProviderItem({
          driver: OMP_PROVIDER,
          nativeItemId: `${input.sessionId}:history:${index}`,
        }),
        threadId: input.threadId,
        runId: null,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdBy: role === "user" ? "user" : "agent",
        creationSource: "provider",
        createdAt,
        updatedAt: createdAt,
      } satisfies OrchestrationV2ConversationMessage,
    ];
  });
