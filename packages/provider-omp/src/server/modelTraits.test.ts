import { assert, describe, it } from "@effect/vitest";
import { type ModelCapabilities, ProviderInstanceId } from "@t3tools/contracts";

import {
  OMP_CUSTOM_MODEL_CAPABILITIES,
  OMP_DEFAULT_MODEL_CAPABILITIES,
  ompCatalogModels,
  parseOmpModelSlug,
  readOmpTraitSelection,
} from "./modelTraits.ts";

const instanceId = ProviderInstanceId.make("omp");
const optionIds = (caps: ModelCapabilities) =>
  (caps.optionDescriptors ?? []).map((descriptor) => descriptor.id);
const thinkingOptions = (caps: ModelCapabilities) => {
  const descriptor = caps.optionDescriptors?.find((entry) => entry.id === "thinking");
  return descriptor?.type === "select" ? descriptor.options.map((option) => option.id) : [];
};

describe("OMP model catalog", () => {
  it("lists each get_available_models entry as provider/id with its own thinking efforts", () => {
    const models = ompCatalogModels([
      {
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
        provider: "anthropic",
        reasoning: true,
        thinking: { efforts: ["low", "medium", "high", "max"] },
      },
      { id: "gpt-4o", name: "GPT-4o", provider: "openai", reasoning: false },
      { id: "o3", name: "o3", provider: "openai", reasoning: true },
      { id: "gpt-4o", name: "dup", provider: "openai", reasoning: false },
    ]);
    assert.deepStrictEqual(
      models.map((model) => [model.slug, model.subProvider]),
      [
        ["anthropic/claude-sonnet-4-5", "anthropic"],
        ["openai/gpt-4o", "openai"],
        ["openai/o3", "openai"],
      ],
    );
    assert.deepStrictEqual(thinkingOptions(models[0]!.capabilities!), [
      "inherit",
      "off",
      "low",
      "medium",
      "high",
      "max",
    ]);
    // No reasoning: no thinking selector, but the boolean traits stay.
    assert.deepStrictEqual(optionIds(models[1]!.capabilities!), [
      "fastMode",
      "advisor",
      "prewalk",
      "computer",
      "vibe",
    ]);
    assert.deepStrictEqual(thinkingOptions(models[2]!.capabilities!), [
      "inherit",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
    ]);
  });

  it("offers the role chip on OMP's default model only, and every level to custom models", () => {
    assert.deepStrictEqual(optionIds(OMP_DEFAULT_MODEL_CAPABILITIES), [
      "thinking",
      "role",
      "fastMode",
      "advisor",
      "prewalk",
      "computer",
      "vibe",
    ]);
    assert.notInclude(optionIds(OMP_CUSTOM_MODEL_CAPABILITIES), "role");
    assert.deepStrictEqual(thinkingOptions(OMP_CUSTOM_MODEL_CAPABILITIES), [
      "inherit",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  it("splits a slug at the provider, keeping slashes in the model id", () => {
    assert.deepStrictEqual(parseOmpModelSlug("openrouter/anthropic/claude"), {
      provider: "openrouter",
      modelId: "anthropic/claude",
    });
    assert.isUndefined(parseOmpModelSlug("default"));
    assert.isUndefined(parseOmpModelSlug("/x"));
  });

  it("reads traits from a selection; the role applies only on the default model", () => {
    const options = [
      { id: "thinking", value: "inherit" },
      { id: "role", value: "smol" },
      { id: "fastMode", value: true },
      { id: "computer", value: false },
    ];
    assert.deepStrictEqual(readOmpTraitSelection({ instanceId, model: "default", options }), {
      model: "default",
      role: "smol",
      thinking: "inherit",
      fastMode: true,
      computer: false,
    });
    assert.strictEqual(
      readOmpTraitSelection({ instanceId, model: "openai/o3", options }).role,
      "default",
    );
  });
});
