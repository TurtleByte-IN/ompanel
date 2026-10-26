import type { ServerProvider } from "@t3tools/contracts";

/**
 * Where an OMP instance is in onboarding: find the sidecar, run `omp setup`, sign in under
 * Accounts. `setup` is an OMP that runs but has no model; `missing`/`error` failed before that.
 */
export type OmpOnboardingStep =
  | "disabled"
  | "checking"
  | "missing"
  | "setup"
  | "accounts"
  | "error";

export function getOmpOnboardingStep(provider: ServerProvider | undefined): OmpOnboardingStep {
  if (provider === undefined) return "checking";
  if (!provider.enabled || provider.status === "disabled") return "disabled";
  // The server's snapshots: the initial one is warning without a sign-in verdict; an OMP without
  // a model is warning and unauthenticated (`status.ts`).
  if (provider.status === "warning" && provider.auth.status === "unknown") return "checking";
  if (!provider.installed) return "missing";
  if (provider.status === "warning" && provider.auth.status === "unauthenticated") return "setup";
  if (provider.status === "error") return "error";
  return "accounts";
}

export const OMP_EXECUTABLE_SOURCE_LABEL = {
  bundled: "Bundled with Ompanel",
  downloaded: "Downloaded by Ompanel",
  custom: "Custom path",
} as const satisfies Record<NonNullable<ServerProvider["executable"]>["source"], string>;
