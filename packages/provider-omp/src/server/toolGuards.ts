/**
 * Browser and computer-use preludes exist only in Full access (PRD §9, §6; docs/omp/security.md).
 * The thread overlay outranks project and global config; only OMP's runtime layer outranks it,
 * and `/computer`, its one client-reachable writer, is refused.
 */
import type { RuntimeMode } from "@t3tools/contracts";

import { OMP_GUARDED_TOOL_KEYS } from "../configForm.ts";

type OmpGuardedToolKey = (typeof OMP_GUARDED_TOOL_KEYS)[number];

/**
 * The guarded keys' overlay values for a thread in `runtimeMode` with the Computer Use trait at
 * `computer`. Outside Full access both are `false`. In Full access the browser follows OMP's
 * own config (`undefined` removes the key) and computer use follows the trait, or OMP's config
 * when the selection leaves it unset.
 */
export const ompGuardedToolOverlay = (
  runtimeMode: RuntimeMode,
  computer: boolean | undefined,
): Readonly<Record<OmpGuardedToolKey, boolean | undefined>> =>
  runtimeMode === "full-access"
    ? { "browser.enabled": undefined, "computer.enabled": computer }
    : { "browser.enabled": false, "computer.enabled": false };

/** A composer prompt Ompanel keeps from OMP: the failure reason the client sees, and why. */
export interface OmpRefusedCommand {
  readonly reason: "computer_command_refused" | "share_command_refused" | "builtin_command_refused";
  readonly detail: string;
}

/**
 * Builtin name or alias to canonical name: commands with an RPC `handle` in OMP's builtin registry
 * at acf0d23139. Re-derive on every re-pin; the adapter adds builtins OMP reports, so one a
 * re-pin adds is refused. TUI-only builtins reach the model as text.
 */
const OMP_RPC_BUILTINS: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      "add-dir",
      "advisor",
      "browser",
      "changelog",
      "compact",
      "computer",
      "context",
      "dirs",
      "dump",
      "effort",
      "export",
      "extended-context",
      "fast",
      "force",
      "forget-approvals",
      "fresh",
      "handoff",
      "jobs",
      "marketplace",
      "mcp",
      "memory",
      "model",
      "modelpreset",
      "move",
      "pin",
      "plugins",
      "prewalk",
      "ratchet",
      "reload-plugins",
      "remove-dir",
      "rename",
      "retry",
      "security",
      "session",
      "shake",
      "share",
      "skillful",
      "slow",
      "ssh",
      "stats",
      "switch",
      "todo",
      "tools",
      "trace",
      "usage",
      "wt",
    ].map((name) => [name, name] as const),
  ),
  // Aliases (`force:` too, which the `:` separator never yields as a name).
  models: "model",
  plugin: "plugins",
  worktree: "wt",
};

/**
 * Safe builtins by canonical name, with their allowed subcommands (first word, lowercased, as OMP
 * parses it) where only some are safe: no commands, file reads or writes, network, host
 * clipboard or config changes (docs/omp/security.md lists what is left out and why).
 */
const OMP_SAFE_BUILTINS: Readonly<Record<string, true | Readonly<Record<string, true>>>> = {
  advisor: true,
  changelog: true,
  compact: true,
  context: true,
  effort: true,
  fast: true,
  force: true,
  "forget-approvals": true,
  fresh: true,
  jobs: true,
  prewalk: true,
  rename: true,
  retry: true,
  slow: true,
  todo: {
    "": true,
    append: true,
    start: true,
    done: true,
    drop: true,
    rm: true,
    help: true,
    "?": true,
  },
  usage: { "": true, show: true },
  wt: true,
};

/** Name or alias to canonical name for the builtins OMP reported, merged over the pinned table. */
export type OmpReportedBuiltins = Readonly<Record<string, string>>;

/** The builtins in an `available_commands_update` list (`source: "builtin"`), aliases included. */
export const ompReportedBuiltins = (
  commands: ReadonlyArray<{
    readonly name: string;
    readonly source?: string;
    readonly aliases?: ReadonlyArray<string>;
  }>,
): OmpReportedBuiltins =>
  Object.fromEntries(
    commands
      .filter((command) => command.source === "builtin")
      .flatMap((command) =>
        [command.name, ...(command.aliases ?? [])].map((name) => [name, command.name] as const),
      ),
  );

/** The canonical builtin `/<name>` runs in OMP, or `undefined` when it is not a builtin. */
const builtinFor = (name: string, reported: OmpReportedBuiltins): string | undefined =>
  Object.hasOwn(reported, name)
    ? reported[name]
    : Object.hasOwn(OMP_RPC_BUILTINS, name)
      ? OMP_RPC_BUILTINS[name]
      : undefined;

/**
 * `/<name> <args>` as OMP splits it (`parseSlashCommand`: the first whitespace or `:`), after
 * leading whitespace, which OMP does not strip; `undefined` when `text` is not a slash command.
 */
const parseSlash = (text: string) => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return undefined;
  const body = trimmed.slice(1);
  const end = body.search(/[\s:]/);
  return end === -1
    ? { name: body, args: "" }
    : { name: body.slice(0, end), args: body.slice(end + 1).trim() };
};

/**
 * Whether `/<name> <args>` may reach OMP: not a builtin (by name or alias), or a safe builtin
 * with an allowed subcommand. With no `args`, whether the composer's `/` menu offers `name`.
 */
export const ompBuiltinAllowed = (
  name: string,
  args = "",
  reported: OmpReportedBuiltins = {},
): boolean => {
  const canonical = builtinFor(name, reported);
  if (canonical === undefined) return true;
  if (!Object.hasOwn(OMP_SAFE_BUILTINS, canonical)) return false;
  const verbs = OMP_SAFE_BUILTINS[canonical]!;
  if (verbs === true) return true;
  const verb = args.trim().split(/\s/, 1)[0]!.toLowerCase();
  return Object.hasOwn(verbs, verb);
};

/**
 * Why `text` must not reach OMP as a prompt (OMP would run it as a builtin), or `undefined`.
 * Builtins outside {@link OMP_SAFE_BUILTINS} can run commands (`/mcp add` + `/mcp test`), install
 * or enable code (`/plugin enable`), move the workspace, write files or upload; `/computer status`
 * is the one other form sent. `reported` is what OMP lists as builtins for this session.
 */
export const ompRefusedSlashCommand = (
  text: string,
  reported: OmpReportedBuiltins = {},
): OmpRefusedCommand | undefined => {
  const parsed = parseSlash(text);
  if (parsed === undefined) return undefined;
  const { name, args } = parsed;
  const canonical = builtinFor(name, reported);
  if (canonical === "computer") {
    return args.toLowerCase() === "status"
      ? undefined
      : {
          reason: "computer_command_refused",
          detail:
            "Computer use follows the composer's Computer Use trait, which applies only in Full access; Ompanel sends only /computer status to OMP.",
        };
  }
  if (canonical === "share") {
    return {
      reason: "share_command_refused",
      detail:
        "Share the session with Share as gist… in the thread's OMP menu; Ompanel does not send /share to OMP.",
    };
  }
  if (ompBuiltinAllowed(name, args, reported)) return undefined;
  return {
    reason: "builtin_command_refused",
    detail: `Ompanel does not send OMP's /${name}${args === "" ? "" : ` ${args.split(/\s/, 1)[0]}`} command: it can run commands, change configuration or files, or reach the network outside the thread's approvals. Use Ompanel's settings instead.`,
  };
};
