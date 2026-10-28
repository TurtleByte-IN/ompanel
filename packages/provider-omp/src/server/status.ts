import type {
  CustomModelSetting,
  OmpUpdateCheck,
  ServerProvider,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderVersionAdvisory,
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

/** The picker's models: OMP default, each model OMP listed once, then the instance's custom ones. */
export const ompProviderModels = (
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
    models: ompProviderModels(settings.customModels, catalog),
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

/** The status line when OMP has no model: the onboarding flow's entry point. */
export const OMP_NEEDS_SETUP_MESSAGE =
  "OMP has no model or sign-in yet. Run `omp setup`, then sign in under Accounts.";

const OMP_EXECUTABLE_SOURCE = {
  bundled: "bundled",
  cache: "downloaded",
  override: "custom",
} as const satisfies Record<OmpSidecar["source"], string>;

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
    case "unconfigured":
      return OMP_NEEDS_SETUP_MESSAGE;
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
        /**
         * The binary that was probed: named in the snapshot with its source, and an unverified
         * override in the status.
         */
        readonly sidecar?: Pick<OmpSidecar, "path" | "verified" | "source">;
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
  const { probe, sidecar } = resolution;
  const withExecutable = (draft: ServerProviderDraft): ServerProviderDraft =>
    sidecar === undefined
      ? draft
      : {
          ...draft,
          executable: { source: OMP_EXECUTABLE_SOURCE[sidecar.source], path: sidecar.path },
        };
  if (probe.status === "failed" && probe.reason === "unconfigured") {
    // OMP runs but refuses RPC until it has a model (a fresh install): not a failure, the start
    // of onboarding. Signing in or `omp setup` gives it one.
    return withExecutable(
      ompSnapshot(settings, checkedAt, {
        installed: true,
        version: probe.version,
        status: "warning",
        auth: { status: "unauthenticated" },
        message: OMP_NEEDS_SETUP_MESSAGE,
      }),
    );
  }
  if (probe.status === "failed") {
    return withExecutable(
      ompSnapshot(settings, checkedAt, {
        installed: !(probe.stage === "version" && probe.reason === "missing"),
        version: probe.version,
        status: "error",
        auth: UNKNOWN_AUTH,
        message: probeFailureMessage(probe),
      }),
    );
  }
  const reported = probe.ready.contractVersion;
  if (reported !== lock.contract.version) {
    return withExecutable(
      ompSnapshot(settings, checkedAt, {
        installed: true,
        version: probe.version,
        status: "error",
        auth: UNKNOWN_AUTH,
        message:
          reported === undefined
            ? `This OMP does not report an RPC contract version. Ompanel needs contract ${lock.contract.version} (OMP ${lock.tag}).`
            : `This OMP speaks RPC contract ${reported}. Ompanel needs contract ${lock.contract.version} (OMP ${lock.tag}).`,
      }),
    );
  }
  return withExecutable(
    ompSnapshot(
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
    ),
  );
}

/**
 * The provider-card notice for an `omp update --check` answer. Ompanel never updates OMP itself:
 * the shipped sidecar changes only with an app update, and a custom binary with its own installer.
 */
export function ompVersionAdvisory(input: {
  readonly check: OmpUpdateCheck;
  /** The version the probe saw, when OMP's answer names none. */
  readonly probedVersion: string | null;
  readonly executable: ServerProvider["executable"];
  readonly checkedAt: string;
}): ServerProviderVersionAdvisory {
  const { check, executable } = input;
  const currentVersion = check.currentVersion ?? input.probedVersion;
  const base = {
    currentVersion,
    updateCommand: null,
    canUpdate: false,
    canInstallVersion: false,
    checkedAt: input.checkedAt,
  };
  if (check.status === "available" && check.latestVersion !== null) {
    const latestVersion = check.latestVersion;
    return {
      ...base,
      status: "behind_latest",
      latestVersion,
      message:
        executable?.source === "custom"
          ? `OMP ${latestVersion} is out. Ompanel runs ${executable.path}; update it with the app or tool that installed it.`
          : `OMP ${latestVersion} is out${currentVersion ? `; Ompanel ships ${currentVersion}` : ""}. Sidecar updates only arrive with app updates, so update Ompanel to get it.`,
    };
  }
  if (check.status === "current") {
    return {
      ...base,
      status: "current",
      latestVersion: check.latestVersion ?? currentVersion,
      message: null,
    };
  }
  // `managed` (a package manager owns an omp on PATH) or no answer: newer or not is unknown.
  return { ...base, status: "unknown", latestVersion: null, message: null };
}
