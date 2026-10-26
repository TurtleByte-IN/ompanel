import { assert, describe, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OMP_LOCK } from "../ompLock.ts";
import { OmpSettings } from "../settings.ts";
import { OmpSidecarError } from "./sidecar.ts";
import { OMP_NEEDS_SETUP_MESSAGE, ompProviderSnapshot } from "./status.ts";

const settings = { ...Schema.decodeSync(OmpSettings)({}), enabled: true };
const checkedAt = "2026-10-26T00:00:00.000Z";

describe("ompProviderSnapshot", () => {
  it("is ready only when the sidecar speaks the pinned contract", () => {
    const snapshot = ompProviderSnapshot({
      settings,
      checkedAt,
      resolution: {
        kind: "probed",
        probe: {
          status: "ready",
          version: "18.12.6",
          ready: { contractVersion: OMP_LOCK.contract.version },
          loginProviders: null,
          models: null,
        },
      },
    });
    assert.strictEqual(snapshot.status, "ready");
    assert.deepStrictEqual(snapshot.auth, { status: "unknown" });
    assert.isTrue(snapshot.installed);
    assert.isTrue(snapshot.supportsTextGeneration);
    assert.isTrue(snapshot.supportsConversationRollback);
    assert.deepStrictEqual(
      snapshot.models.map((model) => model.slug),
      ["default"],
    );
  });

  it("lists OMP's default, the probed catalog and custom models with thinking options", () => {
    const snapshot = ompProviderSnapshot({
      settings: { ...settings, customModels: ["local/my-model"] },
      checkedAt,
      resolution: {
        kind: "probed",
        probe: {
          status: "ready",
          version: "18.12.6",
          ready: { contractVersion: OMP_LOCK.contract.version },
          loginProviders: null,
          models: [{ id: "o3", name: "o3", provider: "openai", reasoning: true }],
        },
      },
    });
    assert.deepStrictEqual(
      snapshot.models.map((model) => model.slug),
      ["default", "openai/o3", "local/my-model"],
    );
    const custom = snapshot.models.find((model) => model.slug === "local/my-model");
    assert.isTrue(
      custom?.capabilities?.optionDescriptors?.some((descriptor) => descriptor.id === "thinking"),
    );
  });

  it("names an unverified binary path while it runs", () => {
    const probe = {
      status: "ready",
      version: "18.12.6",
      ready: { contractVersion: OMP_LOCK.contract.version },
      loginProviders: null,
      models: null,
    } as const;
    const override = ompProviderSnapshot({
      settings,
      checkedAt,
      resolution: {
        kind: "probed",
        probe,
        sidecar: { path: "/opt/omp", verified: false, source: "override" },
      },
    });
    assert.strictEqual(override.status, "ready");
    assert.include(override.message, "/opt/omp");
    assert.include(override.message, "does not check");
    const verified = ompProviderSnapshot({
      settings,
      checkedAt,
      resolution: {
        kind: "probed",
        probe,
        sidecar: { path: "/cache/omp", verified: true, source: "cache" },
      },
    });
    assert.isUndefined(verified.message);
    assert.deepStrictEqual(override.executable, { source: "custom", path: "/opt/omp" });
    assert.deepStrictEqual(verified.executable, { source: "downloaded", path: "/cache/omp" });
  });

  it("reports an OMP without a model as needing setup, not as unavailable (ompanel#144)", () => {
    const snapshot = ompProviderSnapshot({
      settings,
      checkedAt,
      resolution: {
        kind: "probed",
        probe: { status: "failed", version: "18.12.6", stage: "ready", reason: "unconfigured" },
        sidecar: { path: "/Applications/Ompanel.app/omp", verified: true, source: "bundled" },
      },
    });
    assert.strictEqual(snapshot.status, "warning");
    assert.isTrue(snapshot.installed);
    assert.strictEqual(snapshot.version, "18.12.6");
    assert.deepStrictEqual(snapshot.auth, { status: "unauthenticated" });
    assert.strictEqual(snapshot.message, OMP_NEEDS_SETUP_MESSAGE);
    assert.deepStrictEqual(snapshot.executable, {
      source: "bundled",
      path: "/Applications/Ompanel.app/omp",
    });
  });

  it("reports signed-in OAuth providers and leaves API-key-only auth unknown", () => {
    const probed = (authenticated: boolean) =>
      ompProviderSnapshot({
        settings,
        checkedAt,
        resolution: {
          kind: "probed",
          probe: {
            status: "ready",
            version: "18.12.6",
            ready: { contractVersion: OMP_LOCK.contract.version },
            loginProviders: [
              { id: "anthropic", name: "Anthropic", available: true, authenticated },
              { id: "openai-codex", name: "OpenAI Codex", available: true, authenticated },
              {
                id: "github-copilot",
                name: "GitHub Copilot",
                available: true,
                authenticated: false,
              },
            ],
            models: null,
          },
        },
      });
    assert.deepStrictEqual(probed(true).auth, {
      status: "authenticated",
      type: "oauth",
      label: "Anthropic, OpenAI Codex",
    });
    assert.deepStrictEqual(probed(false).auth, { status: "unknown" });
  });

  it("refuses a different contract version", () => {
    const snapshot = ompProviderSnapshot({
      settings,
      checkedAt,
      lock: { ...OMP_LOCK, contract: { ...OMP_LOCK.contract, version: "1.1.0" } },
      resolution: {
        kind: "probed",
        probe: {
          status: "ready",
          version: "18.12.6",
          ready: { contractVersion: "1.0.0" },
          loginProviders: null,
          models: null,
        },
      },
    });
    assert.strictEqual(snapshot.status, "error");
    assert.strictEqual(
      snapshot.message,
      `This OMP speaks RPC contract 1.0.0. Ompanel needs contract 1.1.0 (OMP ${OMP_LOCK.tag}).`,
    );
  });

  it("reports an unresolved sidecar as not installed", () => {
    const snapshot = ompProviderSnapshot({
      settings,
      checkedAt,
      resolution: {
        kind: "unresolved",
        error: new OmpSidecarError({
          reason: "not_found",
          detail: "The sidecar is not installed.",
        }),
      },
    });
    assert.strictEqual(snapshot.status, "error");
    assert.isFalse(snapshot.installed);
    assert.strictEqual(snapshot.message, "The sidecar is not installed.");
  });

  it("explains a probe timeout", () => {
    const snapshot = ompProviderSnapshot({
      settings,
      checkedAt,
      resolution: {
        kind: "probed",
        probe: { status: "failed", version: null, stage: "version", reason: "timeout" },
      },
    });
    assert.strictEqual(snapshot.status, "error");
    assert.strictEqual(snapshot.message, "OMP timed out while running `omp --version`.");
  });
});
