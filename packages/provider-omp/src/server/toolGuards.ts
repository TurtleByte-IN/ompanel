/**
 * The OMP capabilities that act outside the thread's workspace exist only in Full access (PRD §9,
 * §6): the browser eval prelude (`browser.enabled`, on by default in OMP) and the host-desktop
 * eval prelude (`computer.enabled`). See docs/omp/security.md.
 *
 * The thread's `--config` overlay outranks project and global config, so pinning both keys off
 * there holds whatever a settings write puts in config.yml. Only OMP's runtime layer outranks the
 * overlay, and its one writer a client reaches is the `/computer` slash command, which Ompanel
 * refuses ({@link ompRefusedSlashCommand}).
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
 * Why Ompanel will not send `text` to OMP as a prompt, or `undefined` when it may. OMP runs a
 * prompt starting with one of its built-in commands as that command (`parseSlashCommand`: the
 * name ends at the first whitespace or `:`), outside every Ompanel control:
 *
 * - `/computer on|off` sets a runtime override that outranks the overlay: `on` would outlive a
 *   later switch out of Full access, `off` would silently beat the trait. Computer use is the
 *   composer's Computer Use trait; only `/computer status` goes through.
 * - `/share` uploads the session to `share.serverUrl` (OMP's share server, or a host a cloned
 *   repo's config names) without the Share as gist dialog, its `gh` check or its blocked-host
 *   overlay (docs/omp/thread-menu.md).
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
