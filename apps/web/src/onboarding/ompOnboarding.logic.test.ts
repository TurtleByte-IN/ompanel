import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getProviderSummary } from "../components/settings/providerStatus";
import { getOmpOnboardingStep } from "./ompOnboarding.logic";

const ready: ServerProvider = {
  instanceId: ProviderInstanceId.make("omp"),
  driver: ProviderDriverKind.make("omp"),
  enabled: true,
  installed: true,
  version: "18.12.6",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-10-27T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  executable: { source: "bundled", path: "/opt/ompanel/omp" },
};

const needsSetup: ServerProvider = {
  ...ready,
  status: "warning",
  auth: { status: "unauthenticated" },
  message: "OMP has no model or sign-in yet. Run `omp setup`, then sign in under Accounts.",
};

describe("getOmpOnboardingStep", () => {
  it("walks detect → setup → accounts", () => {
    expect(getOmpOnboardingStep(undefined)).toBe("checking");
    expect(
      getOmpOnboardingStep({
        ...ready,
        status: "warning",
        version: null,
        message: "Checking the OMP sidecar...",
      }),
    ).toBe("checking");
    expect(getOmpOnboardingStep(needsSetup)).toBe("setup");
    expect(getOmpOnboardingStep(ready)).toBe("accounts");
    expect(getOmpOnboardingStep({ ...ready, auth: { status: "authenticated" } })).toBe("accounts");
  });

  it("tells a missing sidecar and a failing one apart from setup", () => {
    expect(
      getOmpOnboardingStep({
        ...ready,
        installed: false,
        status: "error",
        message: "The OMP v18.12.6-ompanel.3 sidecar is not installed.",
      }),
    ).toBe("missing");
    expect(getOmpOnboardingStep({ ...ready, status: "error" })).toBe("error");
    expect(getOmpOnboardingStep({ ...needsSetup, enabled: false })).toBe("disabled");
  });
});

describe("getProviderSummary for OMP", () => {
  it("shows a fresh install as needing setup, not unavailable (ompanel#144)", () => {
    expect(getProviderSummary(needsSetup)).toEqual({
      headline: "Needs setup",
      detail: needsSetup.message,
    });
  });
});
