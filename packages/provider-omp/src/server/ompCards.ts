/**
 * Structured cards for OMP tool calls and session notices, built from the tools' `details` at the
 * pinned contract. Tool cards travel in a `dynamic_tool` item's output beside the result's content
 * blocks; notices become notification items.
 */
import {
  OMP_CARD_OUTPUT_KEY,
  type OmpAskAnswer,
  type OmpDebugFrame,
  type OmpDebugVariable,
  type OmpEvalCell,
  type OmpMemoryOp,
  type OmpProposalState,
  type OmpToolCard,
} from "@t3tools/shared/ompToolCard";

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const str = (value: unknown, key: string): string | undefined => {
  const field = record(value)?.[key];
  return typeof field === "string" ? field : undefined;
};

const num = (value: unknown, key: string): number | undefined => {
  const field = record(value)?.[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
};

const list = (value: unknown, key: string): ReadonlyArray<unknown> => {
  const field = record(value)?.[key];
  return Array.isArray(field) ? field : [];
};

const strings = (value: unknown, key: string): Array<string> =>
  list(value, key).filter((entry): entry is string => typeof entry === "string");

/** Fields that may be undefined become optional, as `exactOptionalPropertyTypes` wants them. */
type Defined<T> = { [K in keyof T as undefined extends T[K] ? never : K]: T[K] } & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<T[K], undefined>;
};

/** `{a: undefined}` → `{}`, so cards carry only the fields OMP reported. */
function defined<T extends Record<string, unknown>>(value: T): Defined<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Defined<T>;
}

/** Content blocks of a tool result: text and inline images, as OMP sent them. */
function resultBlocks(result: unknown): Array<Record<string, unknown>> {
  return list(result, "content").flatMap((block): Array<Record<string, unknown>> => {
    const entry = record(block);
    if (entry?.["type"] === "text" && typeof entry["text"] === "string") {
      return [{ type: "text", text: entry["text"] }];
    }
    if (
      entry?.["type"] === "image" &&
      typeof entry["data"] === "string" &&
      typeof entry["mimeType"] === "string"
    ) {
      return [{ type: "image", data: entry["data"], mimeType: entry["mimeType"] }];
    }
    return [];
  });
}

/** The output of a carded tool: OMP's content blocks plus the card. */
export function cardOutput(
  blocks: ReadonlyArray<Record<string, unknown>>,
  card: OmpToolCard,
): Record<string, unknown> {
  return { content: blocks, [OMP_CARD_OUTPUT_KEY]: card };
}

const blocksText = (blocks: ReadonlyArray<Record<string, unknown>>): string =>
  blocks.flatMap((block) => (typeof block["text"] === "string" ? [block["text"]] : [])).join("\n");

function askAnswer(entry: unknown): OmpAskAnswer | null {
  const question = str(entry, "question");
  if (question === undefined) return null;
  return defined({
    question,
    multi: record(entry)?.["multi"] === true,
    selected: strings(entry, "selectedOptions"),
    custom: str(entry, "customInput"),
    note: str(entry, "note"),
    timedOut: record(entry)?.["timedOut"] === true ? true : undefined,
  });
}

function askCard(details: unknown): OmpToolCard | null {
  if (record(details)?.["chatRedirect"] === true) {
    return {
      kind: "ask",
      chatRedirect: true,
      answers: strings(details, "questions").map((question) => ({
        question,
        multi: false,
        selected: [],
      })),
    };
  }
  const results = list(details, "results");
  const answers = (results.length > 0 ? results : [details]).flatMap(
    (entry) => askAnswer(entry) ?? [],
  );
  return answers.length === 0 ? null : { kind: "ask", answers };
}

function astEditFiles(details: unknown): Array<{ path: string; count: number }> {
  return list(details, "fileReplacements").flatMap((entry) => {
    const path = str(entry, "path");
    return path === undefined ? [] : [{ path, count: num(entry, "count") ?? 0 }];
  });
}

function proposalCard(
  details: unknown,
  state: OmpProposalState,
  diff: string,
  reason?: string,
): OmpToolCard {
  return defined({
    kind: "proposed_edit" as const,
    source: "ast_edit" as const,
    state,
    files: astEditFiles(details),
    replacements: num(details, "totalReplacements") ?? 0,
    diff,
    reason,
  });
}

/** OMP's preview notice heads a staged `ast_edit`; the card says it, so the diff drops it. */
const PREVIEW_NOTICE = /^Staged as a proposal[^\n]*\n*/;

function debugCard(action: string, details: unknown): OmpToolCard {
  const snapshot = record(details)?.["snapshot"];
  const frames = list(details, "stackFrames").flatMap((frame): Array<OmpDebugFrame> => {
    const id = num(frame, "id");
    const name = str(frame, "name");
    if (id === undefined || name === undefined) return [];
    return [
      defined({
        id,
        name,
        path: str(record(frame)?.["source"], "path") ?? str(record(frame)?.["source"], "name"),
        line: num(frame, "line") ?? 0,
        column: num(frame, "column") ?? 0,
      }),
    ];
  });
  const scopes = list(details, "scopes").flatMap((scope) => {
    const name = str(scope, "name");
    const reference = num(scope, "variablesReference");
    return name === undefined || reference === undefined ? [] : [{ name, reference }];
  });
  const variables = list(details, "variables").flatMap((variable): Array<OmpDebugVariable> => {
    const name = str(variable, "name");
    const value = str(variable, "value");
    return name === undefined || value === undefined
      ? []
      : [defined({ name, value, type: str(variable, "type") })];
  });
  const evaluation = record(details)?.["evaluation"];
  const evalResult = str(evaluation, "result");
  const frameName = str(snapshot, "frameName");
  const sourcePath = str(snapshot, "source");
  const line = num(snapshot, "line");
  return defined({
    kind: "debug" as const,
    action,
    state: str(details, "state") ?? str(snapshot, "status"),
    stopReason: str(snapshot, "stopReason"),
    location:
      frameName === undefined && sourcePath === undefined && line === undefined
        ? undefined
        : defined({ name: frameName, path: sourcePath, line }),
    frames: frames.length > 0 ? frames : undefined,
    scopes: scopes.length > 0 ? scopes : undefined,
    variables: variables.length > 0 ? variables : undefined,
    evaluation:
      evalResult === undefined
        ? undefined
        : defined({ result: evalResult, type: str(evaluation, "type") }),
  });
}

function evalCard(args: unknown, details: unknown): OmpToolCard | null {
  const cells = list(details, "cells").flatMap((cell): Array<OmpEvalCell> => {
    const code = str(cell, "code");
    if (code === undefined) return [];
    return [
      defined({
        index: num(cell, "index") ?? 0,
        title: str(cell, "title"),
        code,
        output: str(cell, "output") ?? "",
        status: str(cell, "status") ?? "complete",
        durationMs: num(cell, "durationMs"),
      }),
    ];
  });
  if (cells.length === 0) {
    const code = str(args, "code");
    if (code === undefined) return null;
    cells.push(
      defined({ index: 0, title: str(args, "title"), code, output: "", status: "running" }),
    );
  }
  return defined({
    kind: "eval" as const,
    language: str(details, "language") ?? str(args, "language"),
    cells,
  });
}

const MEMORY_TOOLS: Record<string, OmpMemoryOp> = {
  recall: "recall",
  retain: "retain",
  reflect: "reflect",
  memory_edit: "edit",
};

function memoryCard(op: OmpMemoryOp, args: unknown, details: unknown, text: string): OmpToolCard {
  const items = list(args, "items").flatMap((item) => {
    const content = str(item, "content");
    return content === undefined ? [] : [defined({ content, scope: str(item, "scope") })];
  });
  return defined({
    kind: "memory" as const,
    op,
    query: str(args, "query"),
    items: items.length > 0 ? items : undefined,
    status: str(details, "status"),
    memoryId: str(args, "id"),
    text,
  });
}

/**
 * The card and output blocks for one OMP tool call, or null when the tool has no card. `args` are
 * the call's arguments; `result` is the (partial) tool result.
 */
export function ompCardFor(input: {
  readonly toolName: string;
  readonly args: unknown;
  readonly result: unknown;
  readonly isError: boolean;
}): { readonly card: OmpToolCard; readonly blocks: Array<Record<string, unknown>> } | null {
  const { toolName, args, result, isError } = input;
  const details = record(result)?.["details"];
  const blocks = resultBlocks(result);
  const text = blocksText(blocks);
  const withBlocks = (card: OmpToolCard | null) => (card === null ? null : { card, blocks });

  switch (toolName) {
    case "ask":
      return isError ? null : withBlocks(askCard(details));
    case "ast_edit": {
      if (details === undefined || isError) return null;
      const applied = record(details)?.["applied"] === true;
      if (!applied && (num(details, "totalReplacements") ?? 0) === 0) return null;
      return withBlocks(
        proposalCard(details, applied ? "applied" : "proposed", text.replace(PREVIEW_NOTICE, "")),
      );
    }
    case "resolve":
    case "reject": {
      const action = str(details, "action");
      if (isError || (action !== "apply" && action !== "discard")) return null;
      if (str(details, "sourceToolName") !== "ast_edit") return null;
      const source = record(details)?.["sourceResultDetails"];
      return withBlocks(
        proposalCard(
          source,
          action === "apply" ? "applied" : "discarded",
          str(source, "displayContent") ?? "",
          str(details, "reason"),
        ),
      );
    }
    case "debug": {
      const action = str(args, "action") ?? str(details, "action");
      return action === undefined || details === undefined
        ? null
        : withBlocks(debugCard(action, details));
    }
    case "lsp": {
      const action = str(args, "action") ?? str(details, "action");
      if (action === undefined) return null;
      const target = [str(args, "file"), str(args, "symbol") ?? str(args, "query")]
        .filter((part) => part !== undefined && part.length > 0)
        .join(" · ");
      return withBlocks(
        defined({
          kind: "lsp" as const,
          action,
          success: !isError && record(details)?.["success"] !== false,
          server: str(details, "serverName"),
          target: target.length > 0 ? target : undefined,
          text,
        }),
      );
    }
    case "eval":
      return withBlocks(evalCard(args, details));
    case "generate_image": {
      const images = list(details, "images").flatMap((image) => {
        const data = str(image, "data");
        const mimeType = str(image, "mimeType");
        return data === undefined || mimeType === undefined
          ? []
          : [{ type: "image", data, mimeType }];
      });
      if (details === undefined) return null;
      return {
        card: defined({
          kind: "generated_image" as const,
          provider: str(details, "provider"),
          model: str(details, "model"),
          paths: strings(details, "imagePaths"),
          responseText: str(details, "responseText"),
        }),
        // OMP returns the pictures only in details; T serves them from the item, not a URL.
        blocks: [...blocks.filter((block) => block["type"] === "text"), ...images],
      };
    }
    case "tts": {
      const path = str(args, "output_path");
      const codec = str(details, "codec");
      if (isError || path === undefined || codec === undefined) return null;
      return withBlocks(
        defined({
          kind: "speech" as const,
          path: codec === "wav" ? path.replace(/\.mp3$/i, ".wav") : path,
          mimeType: codec === "wav" ? ("audio/wav" as const) : ("audio/mpeg" as const),
          bytes: num(details, "bytes"),
          voice: str(details, "voiceId"),
          text: str(args, "text") ?? "",
        }),
      );
    }
  }

  const memoryOp = Object.hasOwn(MEMORY_TOOLS, toolName) ? MEMORY_TOOLS[toolName] : undefined;
  if (memoryOp !== undefined) return withBlocks(memoryCard(memoryOp, args, details, text));
  return null;
}

/** `write conflict://N` resolves merge conflicts in place. */
export function conflictCard(
  target: string,
  result: unknown,
  isError: boolean,
): { readonly card: OmpToolCard; readonly blocks: Array<Record<string, unknown>> } | null {
  if (isError) return null;
  const blocks = resultBlocks(result);
  const summary = blocksText(blocks).split("\n")[0]?.trim() ?? "";
  if (summary.length === 0) return null;
  return {
    card: defined({
      kind: "conflict_resolution" as const,
      target: `conflict://${target}`,
      resolvedPath: str(record(result)?.["details"], "resolvedPath"),
      summary,
    }),
    blocks,
  };
}

/** One notification line per injected TTSR rule. */
export function ttsrNotice(
  rules: ReadonlyArray<unknown>,
): { summary: string; detail: string } | null {
  const named = rules.flatMap((rule) => {
    const name = str(rule, "name");
    return name === undefined
      ? []
      : [{ name, path: str(rule, "path"), content: str(rule, "content") }];
  });
  if (named.length === 0) return null;
  return {
    summary: `Rule injected: ${named.map((rule) => rule.name).join(", ")}`.slice(0, 200),
    detail: named
      .map((rule) =>
        [rule.path === undefined ? rule.name : `${rule.name} (${rule.path})`, rule.content]
          .filter((part) => part !== undefined && part.length > 0)
          .join("\n"),
      )
      .join("\n\n"),
  };
}

/** The model OMP fell back to after its role's model failed. */
export function fallbackNotice(
  frame: Record<string, unknown>,
): { summary: string; detail?: string } | null {
  const from = str(frame, "from");
  const to = str(frame, "to");
  if (from === undefined || to === undefined) return null;
  const role = str(frame, "role");
  const reason = str(frame, "reason");
  return defined({
    summary: `Fallback applied: ${from} → ${to}${role === undefined ? "" : ` (${role})`}`.slice(
      0,
      200,
    ),
    detail: reason,
  });
}

/** Advisor notes from a `custom` message of type `advisor`. */
export function advisorNotice(message: unknown): {
  summary: string;
  detail: string;
  blocker: boolean;
} | null {
  const notes = list(record(message)?.["details"], "notes").flatMap((note) => {
    const text = str(note, "note")?.trim();
    return text === undefined || text.length === 0
      ? []
      : [{ text, severity: str(note, "severity"), advisor: str(note, "advisor") }];
  });
  const content = record(message)?.["content"];
  const fallback =
    typeof content === "string"
      ? content
      : blocksText(resultBlocks({ content: Array.isArray(content) ? content : [] }));
  if (notes.length === 0 && fallback.trim().length === 0) return null;
  const lines =
    notes.length > 0
      ? notes.map((note) => {
          const label = [note.severity, note.advisor].filter(Boolean).join(" · ");
          return label.length > 0 ? `[${label}] ${note.text}` : note.text;
        })
      : [fallback.trim()];
  return {
    summary: `Advisor: ${notes[0]?.text ?? fallback.trim()}`.split("\n")[0]!.slice(0, 200),
    detail: lines.join("\n"),
    blocker: notes.some((note) => note.severity === "blocker"),
  };
}
