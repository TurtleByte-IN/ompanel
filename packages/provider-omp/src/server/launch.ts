/**
 * The command line of a thread's `omp` process. Every flag here exists on the pinned fork:
 * `--mode rpc-ui` and `--approval-mode` (`cli/flag-tables.ts`), `--profile`
 * (`cli/profile-bootstrap.ts`), repeatable `--config` overlays (`cli/flag-tables.ts`, loaded
 * strictly by `config/settings.ts`), `--cwd` (`cli/flag-tables.ts`).
 */
import type { RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** OMP's `ApprovalMode` (`tools/approval.ts`). */
export type OmpApprovalMode = "always-ask" | "always-ask-cached" | "write" | "yolo";

/**
 * T3 runtime mode → OMP approval mode. "Auto" is not offered for OMP (D-014) and runs as
 * Supervised, so a stored "auto" never widens what OMP may do unasked.
 */
export const ompApprovalModeFor = (runtimeMode: RuntimeMode): OmpApprovalMode => {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "write";
    case "approval-required":
    case "auto":
      return "always-ask";
  }
};

export interface OmpSessionLaunch {
  readonly approvalMode: OmpApprovalMode;
  /** Empty for OMP's default profile. */
  readonly profile: string;
  readonly overlayPath: string;
  readonly cwd: string;
}

/** `omp --mode rpc-ui --approval-mode <m> [--profile <p>] --config <overlay> --cwd <path>`. */
export const ompSessionArgs = (launch: OmpSessionLaunch): ReadonlyArray<string> => [
  "--mode",
  "rpc-ui",
  "--approval-mode",
  launch.approvalMode,
  ...(launch.profile === "" ? [] : ["--profile", launch.profile]),
  "--config",
  launch.overlayPath,
  "--cwd",
  launch.cwd,
];

/** OMP rejects a missing or non-mapping overlay, so an empty one is an explicit empty mapping. */
export const OMP_EMPTY_OVERLAY = "# Per-thread OMP settings written by Ompanel.\n{}\n";

/**
 * Writes the thread's `--config` overlay (the highest config layer below flags and env) under
 * `dir`, owner-only, and returns its path.
 */
export const writeOmpThreadOverlay = Effect.fn("writeOmpThreadOverlay")(function* (input: {
  readonly dir: string;
  readonly content?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(input.dir, { recursive: true, mode: 0o700 });
  const overlayPath = path.join(input.dir, "overlay.yml");
  yield* fileSystem.writeFileString(overlayPath, input.content ?? OMP_EMPTY_OVERLAY, {
    mode: 0o600,
  });
  return overlayPath;
});
