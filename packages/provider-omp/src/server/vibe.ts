/**
 * OMP vibe mode over RPC: the agent becomes a director of persistent `fast` and `good` worker
 * sessions (`vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill`, `vibe_list`) and only reads
 * files itself. docs/omp/composer.md#vibe-mode.
 */
import { contractAtLeast } from "./subagents.ts";

/**
 * The first RPC contract with `set_vibe_mode {enabled}` and with `parentToolCallId` on vibe
 * worker frames. Earlier sidecars run vibe mode only in OMP's TUI (`/vibe`), so the composer
 * offers the trait only from this contract on.
 */
export const OMP_VIBE_CONTRACT = "1.8.0";

/** Whether a sidecar speaking `contractVersion` takes `set_vibe_mode`. */
export const ompVibeModeAvailable = (contractVersion: string): boolean =>
  contractAtLeast(contractVersion, OMP_VIBE_CONTRACT);
