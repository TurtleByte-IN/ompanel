/**
 * Browser and computer-use preludes exist only in Full access, and an untrusted project's own
 * agent config is ignored (PRD §9; docs/omp/security.md). The thread overlay outranks project and
 * global config; only OMP's runtime layer outranks it, and `/computer`, its one client-reachable
 * writer, is refused.
 */
import type { RuntimeMode } from "@t3tools/contracts";

import { OMP_GUARDED_KEYS } from "../configForm.ts";
import { contractAtLeast } from "./hostTools.ts";

type OmpGuardedKey = (typeof OMP_GUARDED_KEYS)[number];

/** The contract whose OMP honours `workspace.trusted` and reports the guard in `get_state`. */
const OMP_WORKSPACE_TRUST_CONTRACT = "1.9.0";

export const ompWorkspaceTrustAvailable = (contractVersion: string): boolean =>
  contractAtLeast(contractVersion, OMP_WORKSPACE_TRUST_CONTRACT);

/**
 * Overlay values: preludes off outside Full access (in Full access the browser follows OMP's
 * config, computer use the trait); `trusted: false` writes `workspace.trusted: false`, while
 * trusted, or `undefined` on an OMP before 1.9.0, leaves the key to the user's config.
 */
export const ompGuardedToolOverlay = (
  runtimeMode: RuntimeMode,
  computer: boolean | undefined,
  trusted?: boolean,
): Readonly<Record<OmpGuardedKey, boolean | undefined>> => ({
  ...(runtimeMode === "full-access"
    ? { "browser.enabled": undefined, "computer.enabled": computer }
    : { "browser.enabled": false, "computer.enabled": false }),
  "workspace.trusted": trusted === false ? false : undefined,
});

/** The `get_state` field (contract 1.9.0) that reports each guarded key as OMP resolved it. */
const GUARD_STATE_FIELD: Readonly<Record<OmpGuardedKey, string>> = {
  "browser.enabled": "browserEnabled",
  "computer.enabled": "computerEnabled",
  "workspace.trusted": "workspaceTrusted",
};

/**
 * The guarded keys whose pinned value a `get_state` answer does not report yet; keys left to
 * OMP's own config are skipped, and a missing field counts as not applied.
 */
export const ompGuardMismatches = (
  wanted: Readonly<Record<OmpGuardedKey, boolean | undefined>>,
  state: unknown,
): ReadonlyArray<OmpGuardedKey> =>
  OMP_GUARDED_KEYS.filter((key) => {
    if (wanted[key] === undefined) return false;
    const field = GUARD_STATE_FIELD[key];
    const reported =
      typeof state === "object" && state !== null && field in state
        ? (state as Readonly<Record<string, unknown>>)[field]
        : undefined;
    return reported !== wanted[key];
  });

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
 * clipboard or config changes (docs/omp/security.md lists what is left out and why). `/security`
 * keeps only the forms that read OMP's stored scans or become a normal prompt.
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
  handoff: true,
  jobs: true,
  // Sent only while Ompanel owns the session's directory changes; see `ompRefusedSlashCommand`.
  move: true,
  prewalk: true,
  rename: true,
  retry: true,
  security: { "": true, scans: true, show: true, compare: true, validate: true },
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
 * The subcommands Ompanel sends for a builtin it sends only in part (`/todo`, `/usage`,
 * `/security`), for the `/` menu's hint; `undefined` for any other command.
 */
export const ompAllowedSubcommands = (
  name: string,
  reported: OmpReportedBuiltins = {},
): ReadonlyArray<string> | undefined => {
  const canonical = builtinFor(name, reported);
  if (canonical === undefined || !Object.hasOwn(OMP_SAFE_BUILTINS, canonical)) return undefined;
  const verbs = OMP_SAFE_BUILTINS[canonical]!;
  return verbs === true ? undefined : Object.keys(verbs).filter((verb) => /^[a-z]/.test(verb));
};

/**
 * Why `text` must not reach OMP as a prompt (OMP would run it as a builtin), or `undefined`.
 * Unsafe builtins are refused, `/computer` except `status`, and `/move` unless
 * `hostOwnsCwdChange` (otherwise OMP moves the session anywhere without asking T3).
 */
export const ompRefusedSlashCommand = (
  text: string,
  reported: OmpReportedBuiltins = {},
  options: { readonly hostOwnsCwdChange?: boolean } = {},
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
  if (canonical === "move" && options.hostOwnsCwdChange !== true) {
    return {
      reason: "builtin_command_refused",
      detail:
        "Ompanel sends /move only when it approves the target directory, and this thread's OMP does not ask it (it needs RPC contract 1.5.0). Start a thread in the other checkout instead.",
    };
  }
  if (ompBuiltinAllowed(name, args, reported)) return undefined;
  return {
    reason: "builtin_command_refused",
    detail: `Ompanel does not send OMP's /${name}${args === "" ? "" : ` ${args.split(/\s/, 1)[0]}`} command: it can run commands, change configuration or files, or reach the network outside the thread's approvals. Use Ompanel's settings instead.`,
  };
};
