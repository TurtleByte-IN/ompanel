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
  readonly reason: "computer_command_refused" | "share_command_refused";
  readonly detail: string;
}

/**
 * Why `text` must not reach OMP as a prompt (OMP would run it as a builtin), or `undefined`.
 * `/computer on|off` sets a runtime override above the overlay; `/share` uploads past the Share
 * as gist checks (docs/omp/security.md). Only `/computer status` goes through.
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
  if (name === "computer" && args !== "status") {
    return {
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
  return undefined;
};
