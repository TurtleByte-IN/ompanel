import type {
  CustomModelSetting,
  ServerProviderAuth,
  ServerProviderModel,
} from "@t3tools/contracts";
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
import { OMP_CONTROL_TIMEOUTS_MS, type OmpProbeResult } from "./control.ts";
import {
  OMP_CUSTOM_MODEL_CAPABILITIES,
  OMP_DEFAULT_MODEL_CAPABILITIES,
  OMP_DEFAULT_MODEL_SLUG,
  ompCatalogModels,
  type OmpCatalogModel,
} from "./modelTraits.ts";
import type { OmpSidecar, OmpSidecarError } from "./sidecar.ts";

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
  slug: OMP_DEFAULT_MODEL_SLUG,
  name: "OMP default",
  isCustom: false,
  capabilities: OMP_DEFAULT_MODEL_CAPABILITIES,
};

const ompModels = (
  customModels: ReadonlyArray<CustomModelSetting>,
  catalog: ReadonlyArray<OmpCatalogModel>,
) =>
  providerModelsFromSettings(
    [OMP_DEFAULT_MODEL, ...ompCatalogModels(catalog)],
    customModels,
    OMP_CUSTOM_MODEL_CAPABILITIES,
  );

const ompSnapshot = (
  settings: OmpSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  catalog: ReadonlyArray<OmpCatalogModel> = [],
): ServerProviderDraft => ({
  ...buildServerProvider({
    presentation: OMP_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: ompModels(settings.customModels, catalog),
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
      return "OMP exited before its RPC server answered.";
    case "timeout":
      return `OMP's RPC server did not answer within ${OMP_CONTROL_TIMEOUTS_MS.ready / 1000} s.`;
    case "invalid":
      return "OMP's RPC server did not start with a ready frame.";
  }
}

/**
 * Before RPC contract 1.6.0 `get_login_providers` lists OAuth providers only, and no version lists
 * every credential source (ambient cloud credentials, extension providers), so no signed-in
 * provider means "unknown", never "unauthenticated".
 */
function ompAuthFromLoginProviders(
  providers: Extract<OmpProbeResult, { status: "ready" }>["loginProviders"],
): ServerProviderAuth {
  const signedIn = (providers ?? []).filter((provider) => provider.authenticated);
  if (signedIn.length === 0) return UNKNOWN_AUTH;
  return {
    status: "authenticated",
    type: "oauth",
    label: signedIn.map((provider) => provider.name || provider.id).join(", "),
  };
}

/** The snapshot of an enabled instance after sidecar resolution and probing. */
export function ompProviderSnapshot(input: {
  readonly settings: OmpSettings;
  readonly checkedAt: string;
  readonly resolution:
    | { readonly kind: "unresolved"; readonly error: OmpSidecarError }
    | {
        readonly kind: "probed";
        readonly probe: OmpProbeResult;
        /** The binary that was probed; an unverified override is named in the status. */
        readonly sidecar?: Pick<OmpSidecar, "path" | "verified">;
      };
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
  const sidecar = resolution.sidecar;
  return ompSnapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version: probe.version,
      status: "ready",
      auth: ompAuthFromLoginProviders(probe.loginProviders),
      ...(sidecar && !sidecar.verified
        ? {
            message: `Running the OMP binary at ${sidecar.path}, which Ompanel does not check against OMP ${lock.tag}.`,
          }
        : {}),
    },
    probe.models ?? [],
  );
}
