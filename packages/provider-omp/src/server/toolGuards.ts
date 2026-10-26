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
 * Every builtin the pinned OMP runs when a `prompt` starts with `/<name>` (commands with an RPC
 * `handle` in `slash-commands/builtin-*.ts` at acf0d23139). TUI-only builtins reach the model as text.
 */
const OMP_RPC_BUILTINS: Readonly<Record<string, true>> = Object.fromEntries(
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
  ].map((name) => [name, true] as const),
);

/**
 * Builtins safe in every permission mode: they change only this session's model knobs, context
 * or view, never run commands, write files, reach the network or change configuration. `/wt`
 * goes to Ompanel's host (hostTools.ts). Everything else in {@link OMP_RPC_BUILTINS} is refused.
 */
const OMP_SAFE_BUILTINS: Readonly<Record<string, true>> = Object.fromEntries(
  [
    "advisor",
    "changelog",
    "compact",
    "context",
    "effort",
    "fast",
    "force",
    "forget-approvals",
    "fresh",
    "jobs",
    "prewalk",
    "rename",
    "retry",
    "slow",
    "stats",
    "todo",
    "usage",
    "wt",
  ].map((name) => [name, true] as const),
);

/** Whether the composer may send `/<name>` to OMP (also what its `/` menu offers). */
export const ompBuiltinAllowed = (name: string): boolean =>
  !Object.hasOwn(OMP_RPC_BUILTINS, name) || Object.hasOwn(OMP_SAFE_BUILTINS, name);

/**
 * Why `text` must not reach OMP as a prompt (OMP would run it as a builtin), or `undefined`.
 * Builtins outside {@link OMP_SAFE_BUILTINS} can run commands (`/mcp add` + `/mcp test`), install
 * code, move the workspace or upload; `/computer status` is the one other form sent.
 */
export const ompRefusedSlashCommand = (text: string): OmpRefusedCommand | undefined => {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) return undefined;
  const body = trimmed.slice(1);
  const end = body.search(/[\s:]/);
  const name = end === -1 ? body : body.slice(0, end);
  const args =
    end === -1
      ? ""
      : body
          .slice(end + 1)
          .trim()
          .toLowerCase();
  if (name === "computer") {
    return args === "status"
      ? undefined
      : {
          reason: "computer_command_refused",
          detail:
            "Computer use follows the composer's Computer Use trait, which applies only in Full access; Ompanel sends only /computer status to OMP.",
        };
  }
  if (name === "share") {
    return {
      reason: "share_command_refused",
      detail:
        "Share the session with Share as gist… in the thread's OMP menu; Ompanel does not send /share to OMP.",
    };
  }
  if (ompBuiltinAllowed(name)) return undefined;
  return {
    reason: "builtin_command_refused",
    detail: `Ompanel does not send OMP's /${name} command: it can run commands, change configuration or files, or reach the network outside the thread's approvals. Use Ompanel's settings instead.`,
  };
};
