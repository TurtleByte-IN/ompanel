/**
 * Composer extras an OMP thread understands, shared by the server adapter and the web composer:
 * OMP's magic keywords and the `/goal` command Ompanel runs over RPC. docs/omp/composer.md.
 */

/** Tools a keyword's notice is about; OMP drops the notice when the session lacks one. */
export type OmpMagicKeywordTool = "task" | "eval";

/** One OMP magic keyword (`MAGIC_KEYWORDS` in oh-my-pi `modes/magic-keywords.ts`). */
export interface OmpMagicKeyword {
  /** The `magicKeywords.<id>` setting that turns it off. */
  readonly id: string;
  /** The exact lowercase word OMP looks for as standalone prose. */
  readonly word: string;
  readonly label: string;
  readonly description: string;
  readonly requires: ReadonlyArray<OmpMagicKeywordTool>;
  /** OMP's gradient hue sweep `[from, to]` in degrees; `to` may pass 360. */
  readonly hue: readonly [number, number];
}

/**
 * OMP's magic keywords at the pinned tag. Typed in a prompt, each adds a hidden notice to that
 * turn (and `ultrathink` asks for the model's highest thinking level); OMP does the work, so a
 * keyword needs nothing from the adapter.
 */
export const OMP_MAGIC_KEYWORDS: ReadonlyArray<OmpMagicKeyword> = [
  {
    id: "ultrathink",
    word: "ultrathink",
    label: "Ultrathink",
    description: "Maximum thinking for this turn, with a careful-reasoning notice",
    requires: [],
    hue: [0, 330],
  },
  {
    id: "orchestrate",
    word: "orchestrate",
    label: "Orchestrate",
    description: "Run this request as an orchestrator that splits the work across subagents",
    requires: ["task"],
    hue: [150, 280],
  },
  {
    id: "workflow",
    word: "workflowz",
    label: "Workflow",
    description: "Run this request as a scripted multi-subagent workflow in the eval kernel",
    requires: ["task", "eval"],
    hue: [30, 150],
  },
  {
    id: "jevify",
    word: "jevify",
    label: "Jevify",
    description: "Classify bulk items with the eval kernel's judge instead of reading them",
    requires: ["eval"],
    hue: [300, 420],
  },
];

/** Shortest typed prefix that offers keyword completions; shorter ones match too much prose. */
const OMP_MAGIC_KEYWORD_MIN_PREFIX = 5;

// OMP's boundaries (pi-tui `prompt/magic-keywords.ts`): letters, digits, `_`, `.`, `/`, `\`, `-`
// and `::` bind the word into an identifier or path; a trailing `(` makes it a call.
const LEFT_BOUNDARY = String.raw`(?<![\p{L}\p{N}_./\\-])(?<!::)`;
const RIGHT_BOUNDARY = String.raw`(?![\p{L}\p{N}_/\\-])(?!\.[\p{L}\p{N}_-])(?!\()`;
const KEYWORD_PATTERNS = new Map(
  OMP_MAGIC_KEYWORDS.map((keyword) => [
    keyword.word,
    new RegExp(`${LEFT_BOUNDARY}${keyword.word}${RIGHT_BOUNDARY}`, "u"),
  ]),
);

/** `text` with fenced code, inline code and XML/HTML sections blanked: OMP reads only prose. */
function proseOnly(text: string): string {
  const blank = (match: string) => match.replace(/[^\n]/g, " ");
  return text
    .replace(/(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\2[^\n]*(?=\n|$)|$)/g, blank)
    .replace(/`+[^`\n]*`+/g, blank)
    .replace(/<([A-Za-z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1\s*>/g, blank);
}

/** The keywords `text` contains as standalone prose, in table order. */
export function ompMagicKeywordsIn(text: string): ReadonlyArray<OmpMagicKeyword> {
  if (!OMP_MAGIC_KEYWORDS.some((keyword) => text.includes(keyword.word))) return [];
  const prose = proseOnly(text);
  return OMP_MAGIC_KEYWORDS.filter((keyword) => KEYWORD_PATTERNS.get(keyword.word)!.test(prose));
}

/** Keywords that complete `token`, a word being typed; an already complete word offers none. */
export function ompMagicKeywordCompletions(token: string): ReadonlyArray<OmpMagicKeyword> {
  if (token.length < OMP_MAGIC_KEYWORD_MIN_PREFIX || !/^[a-z]+$/.test(token)) return [];
  return OMP_MAGIC_KEYWORDS.filter(
    (keyword) => keyword.word.startsWith(token) && keyword.word !== token,
  );
}

/**
 * A `/goal` command. OMP's `/goal` runs only in its TUI, so the adapter maps these onto the RPC
 * `goal` command; `budget` (changing a running goal's budget) has no RPC form.
 */
export type OmpGoalCommand =
  | { readonly op: "get" }
  | { readonly op: "create"; readonly objective: string; readonly tokenBudget?: number }
  | { readonly op: "pause" }
  | { readonly op: "resume" }
  | { readonly op: "drop" }
  | { readonly op: "budget" }
  | { readonly op: "invalid"; readonly reason: string };

const GOAL_COMMAND = /^\/goal(?:\s+([\s\S]*))?$/;
const BUDGET_FLAG = /^--budget(?:=|\s+)(\S+)\s*/;

/**
 * Reads a `/goal` prompt: `/goal` and `/goal show` report the goal; `/goal pause`, `/goal resume`
 * and `/goal drop` (or `clear`) act on it; `/goal [set] [--budget <tokens>] <objective>` sets one.
 * Anything else is not a goal command.
 */
export function parseOmpGoalCommand(text: string): OmpGoalCommand | null {
  const match = GOAL_COMMAND.exec(text.trim());
  if (match === null) return null;
  const rest = (match[1] ?? "").trim();
  if (rest === "") return { op: "get" };
  const [first = ""] = rest.split(/\s+/, 1);
  const tail = rest.slice(first.length).trim();
  switch (first.toLowerCase()) {
    case "show":
    case "status":
      return tail === "" ? { op: "get" } : goalObjective(rest);
    case "pause":
      return tail === "" ? { op: "pause" } : goalObjective(rest);
    case "resume":
      return tail === "" ? { op: "resume" } : goalObjective(rest);
    case "drop":
    case "clear":
      return tail === "" ? { op: "drop" } : goalObjective(rest);
    case "budget":
      return { op: "budget" };
    case "set":
      return tail === ""
        ? { op: "invalid", reason: "Give the goal an objective: /goal set <objective>" }
        : goalObjective(tail);
    default:
      return goalObjective(rest);
  }
}

function goalObjective(text: string): OmpGoalCommand {
  const flag = BUDGET_FLAG.exec(text);
  if (flag === null) return { op: "create", objective: text };
  const budget = Number(flag[1]);
  if (!Number.isInteger(budget) || budget <= 0) {
    return { op: "invalid", reason: "A goal's token budget must be a positive whole number" };
  }
  const objective = text.slice(flag[0].length).trim();
  return objective === ""
    ? { op: "invalid", reason: "Give the goal an objective: /goal set <objective>" }
    : { op: "create", objective, tokenBudget: budget };
}

/** The prompt text of a goal command, as the composer and the goal panel send it. */
export function ompGoalCommandText(
  command: Exclude<OmpGoalCommand, { op: "invalid" } | { op: "budget" }>,
): string {
  switch (command.op) {
    case "get":
      return "/goal show";
    case "pause":
    case "resume":
    case "drop":
      return `/goal ${command.op}`;
    case "create": {
      const objective = command.objective.replace(/\s+/g, " ").trim();
      return command.tokenBudget === undefined
        ? `/goal set ${objective}`
        : `/goal set --budget ${command.tokenBudget} ${objective}`;
    }
  }
}
