import { describe, expect, it } from "vite-plus/test";

import {
  buildOmpSettingsForm,
  isOmpCredentialKey,
  ompScopedEntrySummary,
  ompUnscopedEntries,
  ompWithUnscopedEntries,
} from "./configForm.ts";

describe("isOmpCredentialKey", () => {
  it("marks every credential the pinned OMP registers, set or not", () => {
    for (const key of [
      "auth.broker.token",
      "hindsight.apiToken",
      "images.urls.credentials",
      "mnemopi.llmApiKey",
      "searxng.basicPassword",
    ]) {
      expect(isOmpCredentialKey(key, "string")).toBe(true);
    }
  });

  it("clears only keys the pinned OMP registers without a credential marker", () => {
    expect(isOmpCredentialKey("searxng.basicUsername", "string")).toBe(false);
    // "Token" here is a count, not a secret.
    expect(isOmpCredentialKey("commit.mapBatchTokenBudget", "number")).toBe(false);
    expect(isOmpCredentialKey("modelRoles", "record")).toBe(false);
  });

  it("fails closed on keys the pinned OMP does not register", () => {
    expect(isOmpCredentialKey("newfeature.endpoint", "string")).toBe(true);
    expect(isOmpCredentialKey("exa.apiKey", "string")).toBe(true);
    expect(isOmpCredentialKey("newfeature.enabled", "boolean")).toBe(true);
  });

  it("never carries a credential's value into the form, even an unredacted one", () => {
    const form = buildOmpSettingsForm({
      "searxng.basicPassword": { type: "string", description: "", source: "global", value: "" },
      "searxng.basicUsername": { type: "string", description: "", source: "global", value: "me" },
    });
    expect(form.fields.map((field) => [field.key, field.credential, "value" in field])).toEqual([
      ["searxng.basicPassword", true, false],
      ["searxng.basicUsername", false, true],
    ]);
  });
});

describe("path-scoped arrays", () => {
  const SCOPED = { pathPrefixes: ["/srv", "/opt"], providers: ["ollama"] };
  const entries = ["anthropic", SCOPED, "openai"];

  it("replaces the plain entries and keeps the scoped ones after them", () => {
    expect(ompUnscopedEntries(entries)).toEqual(["anthropic", "openai"]);
    expect(ompWithUnscopedEntries(entries, ["groq"])).toEqual(["groq", SCOPED]);
    expect(ompWithUnscopedEntries(entries, [])).toEqual([SCOPED]);
  });

  it("summarizes a scoped entry as OMP reads it", () => {
    expect(ompScopedEntrySummary(SCOPED)).toEqual({ paths: ["/srv", "/opt"], values: ["ollama"] });
    expect(ompScopedEntrySummary({ path: "/a", models: ["x/y"], values: "x/z" })).toEqual({
      paths: ["/a"],
      values: ["x/z", "x/y"],
    });
    expect(ompScopedEntrySummary(["not", "an", "entry"])).toEqual({ paths: [], values: [] });
  });

  it("gives path-scoped fields the global layer's entries only when OMP listed that layer", () => {
    const list = {
      disabledProviders: { type: "array", description: "", source: "global", value: [] },
      enabledModels: { type: "array", description: "", source: "default", value: [] },
      cycleOrder: { type: "array", description: "", source: "global", value: ["a"] },
    } as const;
    const layer = {
      disabledProviders: { type: "array", description: "", value: [SCOPED] },
      cycleOrder: { type: "array", description: "", value: ["a"] },
    } as const;
    const withLayer = buildOmpSettingsForm(list, layer).fields;
    expect(withLayer.map((field) => field.globalEntries)).toEqual([[SCOPED], [], undefined]);
    expect(
      buildOmpSettingsForm(list).fields.some((field) => field.globalEntries !== undefined),
    ).toBe(false);
  });
});
