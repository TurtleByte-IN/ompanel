import { describe, expect, it } from "vite-plus/test";

import { buildOmpSettingsForm, isOmpCredentialKey } from "./configForm.ts";

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
