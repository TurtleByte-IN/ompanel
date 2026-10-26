import type { CustomModelSetting, ServerProviderModel } from "@t3tools/contracts";
import {
  buildServerProvider,
  providerModelsFromSettings,
  type ProviderProbeResult,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { OMP_LOCK, type OmpLock } from "../ompLock.ts";
import type { OmpSettings } from "../settings.ts";
import { OMP_READY_TIMEOUT_MS, type OmpProbeResult } from "./probe.ts";
import type { OmpSidecarError } from "./sidecar.ts";

const OMP_PRESENTATION = {
  displayName: "OMP",
  badgeLabel: "Preview",
  showInteractionModeToggle: false,
  // OMP enforces these natively through `--approval-mode`; T3 never imitates Auto.
  supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
  reportsContextWindow: true,
  requiresNewThreadForModelChange: false,
  supportsConversationRollback: true,
} as const;

const OMP_DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "OMP default",
  isCustom: false,
  capabilities: null,
};

const ompModels = (customModels: ReadonlyArray<CustomModelSetting>) =>
  providerModelsFromSettings([OMP_DEFAULT_MODEL], customModels, null);

const ompSnapshot = (
  settings: OmpSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
): ServerProviderDraft => ({
  ...buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: ompModels(settings.customModels),
    probe,
  }),
  supportsTextGeneration: true,
});

const UNKNOWN_AUTH = { status: "unknown" } as const;

export const buildInitialOmpProviderSnapshot = Effect.fn("buildInitialOmpProviderSnapshot")(
  function* (settings: OmpSettings): Effect.fn.Return<ServerProviderDraft> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return ompSnapshot(settings, checkedAt, {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: UNKNOWN_AUTH,
      message: settings.enabled
        ? "Checking the OMP sidecar..."
        : "OMP is disabled in Ompanel settings.",
    });
  },
);

function probeFailureMessage(failure: Extract<OmpProbeResult, { status: "failed" }>): string {
  if (failure.stage === "version") {
    switch (failure.reason) {
      case "missing":
      case "spawn":
        return "Ompanel could not start the OMP executable.";
      case "timeout":
        return "OMP timed out while running `omp --version`.";
      case "exit":
        return "OMP failed to run `omp --version`.";
    }
  }
  switch (failure.reason) {
    case "spawn":
    case "exit":
      return "OMP exited before its RPC server reported ready.";
    case "timeout":
      return `OMP's RPC server did not report ready within ${OMP_READY_TIMEOUT_MS / 1000} s.`;
    case "invalid":
      return "OMP's RPC server did not start with a ready frame.";
  }
}

/** The snapshot of an enabled instance after sidecar resolution and probing. */
export function ompProviderSnapshot(input: {
  readonly settings: OmpSettings;
  readonly checkedAt: string;
  readonly resolution:
    | { readonly kind: "unresolved"; readonly error: OmpSidecarError }
    | { readonly kind: "probed"; readonly probe: OmpProbeResult };
  /** Pins the RPC contract the sidecar must speak. */
  readonly lock?: OmpLock;
}): ServerProviderDraft {
  const { settings, checkedAt, resolution } = input;
  const lock = input.lock ?? OMP_LOCK;
  if (resolution.kind === "unresolved") {
    return ompSnapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "error",
      auth: UNKNOWN_AUTH,
      message: resolution.error.message,
    });
  }
  const { probe } = resolution;
  if (probe.status === "failed") {
    return ompSnapshot(settings, checkedAt, {
      installed: !(probe.stage === "version" && probe.reason === "missing"),
      version: probe.version,
      status: "error",
      auth: UNKNOWN_AUTH,
      message: probeFailureMessage(probe),
    });
  }
  const reported = probe.ready.contractVersion;
  if (reported !== lock.contract.version) {
    return ompSnapshot(settings, checkedAt, {
      installed: true,
      version: probe.version,
      status: "error",
      auth: UNKNOWN_AUTH,
      message:
        reported === undefined
          ? `This OMP does not report an RPC contract version. Ompanel needs contract ${lock.contract.version} (OMP ${lock.tag}).`
          : `This OMP speaks RPC contract ${reported}. Ompanel needs contract ${lock.contract.version} (OMP ${lock.tag}).`,
    });
  }
  return ompSnapshot(settings, checkedAt, {
    installed: true,
    version: probe.version,
    status: "ready",
    auth: UNKNOWN_AUTH,
  });
}
