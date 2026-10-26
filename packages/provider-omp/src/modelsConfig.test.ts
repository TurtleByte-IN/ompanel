import { assert, describe, it } from "@effect/vitest";
import { parse } from "yaml";

import {
  editOmpModelsConfig,
  OMP_MODELS_CHECK_MODEL,
  readOmpModelsConfig,
  withOmpModelsCheckProvider,
} from "./modelsConfig.ts";

const FILE = `# Local models
providers:
  ollama-box:
    baseUrl: http://10.0.0.5:11434/v1 # the GPU box
    api: openai-completions
    auth: none
    headers:
      X-Team: platform
    models:
      - id: qwen3:32b
        name: Qwen 3
        contextWindow: 32768
        input: [text, image]
        compat:
          supportsStore: false
  anthropic:
    baseUrl: https://proxy.example.com
`;

const edited = (text: string, ...edits: Parameters<typeof editOmpModelsConfig>[1][]) =>
  edits.reduce((current, edit) => {
    const result = editOmpModelsConfig(current, edit);
    if (!result.ok) throw new Error(result.error);
    return result.text;
  }, text);

describe("readOmpModelsConfig", () => {
  it("reads the fields the form shows and names the keys it keeps as written", () => {
    assert.deepStrictEqual(readOmpModelsConfig(FILE), {
      ok: true,
      providers: [
        {
          id: "ollama-box",
          baseUrl: "http://10.0.0.5:11434/v1",
          api: "openai-completions",
          auth: "none",
          models: [{ id: "qwen3:32b", name: "Qwen 3", contextWindow: 32768, images: true }],
          otherKeys: ["headers"],
        },
        { id: "anthropic", baseUrl: "https://proxy.example.com", models: [], otherKeys: [] },
      ],
    });
    assert.deepStrictEqual(readOmpModelsConfig(""), { ok: true, providers: [] });
    assert.deepStrictEqual(readOmpModelsConfig("# nothing yet\n"), { ok: true, providers: [] });
  });

  it("reports where the YAML breaks, and a shape OMP cannot read", () => {
    const broken = readOmpModelsConfig("providers:\n  a: [\n");
    assert.isFalse(broken.ok);
    if (!broken.ok) assert.match(broken.error, /not valid YAML at line \d+, column \d+/);
    assert.deepStrictEqual(readOmpModelsConfig("- a\n"), {
      ok: false,
      error: "models.yml must be a mapping with a providers key.",
    });
    assert.deepStrictEqual(readOmpModelsConfig("providers: [a]\n"), {
      ok: false,
      error: "providers in models.yml must be a mapping.",
    });
  });
});

describe("editOmpModelsConfig", () => {
  it("changes only the edited keys and keeps comments and other keys", () => {
    const text = edited(
      FILE,
      { type: "setProvider", provider: "ollama-box", field: "apiKey", value: "OLLAMA_KEY" },
      { type: "setProvider", provider: "ollama-box", field: "auth", value: undefined },
      { type: "setModel", provider: "ollama-box", index: 0, field: "maxTokens", value: 8192 },
      { type: "setModel", provider: "ollama-box", index: 0, field: "images", value: false },
      { type: "addModel", provider: "ollama-box", model: "llama3.3" },
      { type: "setModel", provider: "ollama-box", index: 1, field: "reasoning", value: true },
    );
    assert.include(text, "# Local models");
    assert.include(text, "# the GPU box");
    const value = parse(text) as { providers: Record<string, Record<string, unknown>> };
    const provider = value.providers["ollama-box"]!;
    assert.strictEqual(provider["apiKey"], "OLLAMA_KEY");
    assert.notProperty(provider, "auth");
    assert.deepStrictEqual(provider["headers"], { "X-Team": "platform" });
    assert.deepStrictEqual(provider["models"], [
      {
        id: "qwen3:32b",
        name: "Qwen 3",
        contextWindow: 32768,
        compat: { supportsStore: false },
        maxTokens: 8192,
      },
      { id: "llama3.3", reasoning: true },
    ]);
    assert.deepStrictEqual(value.providers["anthropic"], { baseUrl: "https://proxy.example.com" });
  });

  it("adds providers to an empty file and removes providers and models", () => {
    const text = edited(
      "",
      { type: "addProvider", provider: "lab" },
      { type: "setProvider", provider: "lab", field: "baseUrl", value: "http://lab:8000/v1" },
      { type: "addModel", provider: "lab", model: "a" },
      { type: "addModel", provider: "lab", model: "b" },
      { type: "removeModel", provider: "lab", index: 0 },
      { type: "addProvider", provider: "gone" },
      { type: "removeProvider", provider: "gone" },
    );
    assert.deepStrictEqual(parse(text), {
      providers: {
        lab: { api: "openai-completions", models: [{ id: "b" }], baseUrl: "http://lab:8000/v1" },
      },
    });
  });

  it("refuses edits that do not fit the file", () => {
    assert.deepStrictEqual(
      editOmpModelsConfig(FILE, { type: "addProvider", provider: "anthropic" }),
      {
        ok: false,
        error: "anthropic is already in models.yml.",
      },
    );
    assert.deepStrictEqual(editOmpModelsConfig(FILE, { type: "addProvider", provider: "a b" }), {
      ok: false,
      error: "a b is not a provider id OMP accepts.",
    });
    assert.deepStrictEqual(
      editOmpModelsConfig(FILE, { type: "removeModel", provider: "anthropic", index: 0 }),
      { ok: false, error: "providers.anthropic has no model 1." },
    );
    assert.isFalse(editOmpModelsConfig("a: [", { type: "addProvider", provider: "x" }).ok);
  });
});

describe("withOmpModelsCheckProvider", () => {
  it("adds one marker provider with a static model and keeps the file's providers", () => {
    const result = withOmpModelsCheckProvider(FILE, "ompanel-check-1");
    assert.isTrue(result.ok);
    if (!result.ok) return;
    const value = parse(result.text) as { providers: Record<string, Record<string, unknown>> };
    assert.deepStrictEqual(Object.keys(value.providers), [
      "ollama-box",
      "anthropic",
      "ompanel-check-1",
    ]);
    assert.deepStrictEqual(value.providers["ompanel-check-1"]!["models"], [
      { id: OMP_MODELS_CHECK_MODEL },
    ]);
    const empty = withOmpModelsCheckProvider("", "m");
    assert.isTrue(empty.ok && Object.keys(parse(empty.text).providers).length === 1);
  });
});
