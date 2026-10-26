/**
 * `models.yml` (OMP's custom providers, `config/models-config-schema-bundle.ts`) as the custom
 * providers form shows it, and edits that change only the keys the form owns. Edits go through
 * the YAML document, so comments, key order and every key the form does not show are kept.
 */
import { isMap, isScalar, isSeq, parseDocument, type Document, type YAMLMap } from "yaml";

/** `ApiSchema` of the pinned OMP: the transports a provider or model may name. */
export const OMP_MODELS_APIS = [
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "azure-openai-responses",
  "anthropic-messages",
  "bedrock-converse-stream",
  "google-generative-ai",
  "google-gemini-cli",
  "google-vertex",
  "openrouter-decisions",
  "openai-decisions",
  "workers-ai-systemone",
  "typesafe",
] as const;

/** `ProviderAuthSchema`: `apiKey` (the default) needs `apiKey` for custom models. */
export const OMP_PROVIDER_AUTH_MODES = ["apiKey", "none", "oauth"] as const;

/** Provider keys the form edits; the rest are kept as written. */
const OMP_PROVIDER_FORM_KEYS = ["baseUrl", "api", "apiKey", "auth", "models"] as const;
export type OmpProviderField = "baseUrl" | "api" | "apiKey" | "auth";

/** Model keys the form edits; the rest are kept as written. */
export type OmpModelField = "id" | "name" | "contextWindow" | "maxTokens" | "reasoning" | "images";

export interface OmpCustomModel {
  readonly id: string;
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  /** `input` lists `image`. */
  readonly images: boolean;
}

export interface OmpCustomProvider {
  readonly id: string;
  readonly baseUrl?: string;
  readonly api?: string;
  /** An environment variable name, a literal key, or `!command` (OMP resolves it). */
  readonly apiKey?: string;
  readonly auth?: string;
  readonly models: ReadonlyArray<OmpCustomModel>;
  /** Other keys of the provider (`headers`, `discovery`, `modelOverrides`, ...), kept as written. */
  readonly otherKeys: ReadonlyArray<string>;
}

export type OmpModelsConfigRead =
  | { readonly ok: true; readonly providers: ReadonlyArray<OmpCustomProvider> }
  | { readonly ok: false; readonly error: string };

/** No folding: a long URL or key stays on one line. */
const STRINGIFY_OPTIONS = { lineWidth: 0 } as const;

/** The document, or a message naming the first syntax error's position. */
const parse = (text: string): { doc: Document } | { error: string } => {
  const doc = parseDocument(text);
  const first = doc.errors[0];
  if (first === undefined) return { doc };
  const position = first.linePos?.[0];
  return {
    error:
      position === undefined
        ? `models.yml is not valid YAML (${first.code}).`
        : `models.yml is not valid YAML at line ${position.line}, column ${position.col} (${first.code}).`,
  };
};

/** The `providers` map, or the reason the document has none OMP could read. */
const providersOf = (doc: Document): { map: YAMLMap | undefined } | { error: string } => {
  if (doc.contents === null) return { map: undefined };
  if (!isMap(doc.contents)) return { error: "models.yml must be a mapping with a providers key." };
  const providers = doc.contents.get("providers", true);
  if (providers === undefined || (isScalar(providers) && providers.value === null)) {
    return { map: undefined };
  }
  if (!isMap(providers)) return { error: "providers in models.yml must be a mapping." };
  return { map: providers };
};

const scalarString = (map: YAMLMap, key: string) => {
  const value: unknown = map.get(key);
  return typeof value === "string" ? value : undefined;
};

const scalarNumber = (map: YAMLMap, key: string) => {
  const value: unknown = map.get(key);
  return typeof value === "number" ? value : undefined;
};

const readModel = (node: unknown): OmpCustomModel | undefined => {
  if (!isMap(node)) return undefined;
  const id = scalarString(node, "id");
  if (id === undefined) return undefined;
  const name = scalarString(node, "name");
  const contextWindow = scalarNumber(node, "contextWindow");
  const maxTokens = scalarNumber(node, "maxTokens");
  const reasoning: unknown = node.get("reasoning");
  const input = node.get("input", true);
  return {
    id,
    ...(name === undefined ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(typeof reasoning === "boolean" ? { reasoning } : {}),
    images: isSeq(input) && input.items.some((item) => isScalar(item) && item.value === "image"),
  };
};

/** The providers the form shows; `ok: false` when the text is not YAML OMP could read. */
export function readOmpModelsConfig(text: string): OmpModelsConfigRead {
  const parsed = parse(text);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const providers = providersOf(parsed.doc);
  if ("error" in providers) return { ok: false, error: providers.error };
  const result: OmpCustomProvider[] = [];
  for (const pair of providers.map?.items ?? []) {
    const id = isScalar(pair.key) ? String(pair.key.value) : undefined;
    if (id === undefined) continue;
    if (!isMap(pair.value)) {
      return { ok: false, error: `providers.${id} in models.yml must be a mapping.` };
    }
    const provider = pair.value;
    const models = provider.get("models", true);
    const baseUrl = scalarString(provider, "baseUrl");
    const api = scalarString(provider, "api");
    const apiKey = scalarString(provider, "apiKey");
    const auth = scalarString(provider, "auth");
    result.push({
      id,
      ...(baseUrl === undefined ? {} : { baseUrl }),
      ...(api === undefined ? {} : { api }),
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(auth === undefined ? {} : { auth }),
      models: isSeq(models)
        ? models.items.flatMap((item) => {
            const model = readModel(item);
            return model === undefined ? [] : [model];
          })
        : [],
      otherKeys: provider.items.flatMap((item) => {
        const key = isScalar(item.key) ? String(item.key.value) : undefined;
        return key === undefined || (OMP_PROVIDER_FORM_KEYS as ReadonlyArray<string>).includes(key)
          ? []
          : [key];
      }),
    });
  }
  return { ok: true, providers: result };
}

export type OmpModelsConfigEdit =
  | { readonly type: "addProvider"; readonly provider: string }
  | { readonly type: "removeProvider"; readonly provider: string }
  | {
      readonly type: "setProvider";
      readonly provider: string;
      readonly field: OmpProviderField;
      /** Undefined removes the key. */
      readonly value: string | undefined;
    }
  | { readonly type: "addModel"; readonly provider: string; readonly model: string }
  | { readonly type: "removeModel"; readonly provider: string; readonly index: number }
  | {
      readonly type: "setModel";
      readonly provider: string;
      readonly index: number;
      readonly field: OmpModelField;
      /** Undefined removes the key; `images` takes a boolean. */
      readonly value: string | number | boolean | undefined;
    };

/** A provider id OMP accepts as a YAML key and as the `provider` part of `provider/model`. */
export const OMP_CUSTOM_PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `text` with one form edit applied, or `ok: false` when the text cannot be read or the edit names
 * a provider or model that is not there.
 */
export function editOmpModelsConfig(
  text: string,
  edit: OmpModelsConfigEdit,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } {
  const parsed = parse(text);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const { doc } = parsed;
  const providers = providersOf(doc);
  if ("error" in providers) return { ok: false, error: providers.error };
  const exists = providers.map?.has(edit.provider) === true;
  if (edit.type === "addProvider") {
    if (!OMP_CUSTOM_PROVIDER_ID_PATTERN.test(edit.provider)) {
      return { ok: false, error: `${edit.provider} is not a provider id OMP accepts.` };
    }
    if (exists) return { ok: false, error: `${edit.provider} is already in models.yml.` };
    const entry = doc.createNode({ api: OMP_MODELS_APIS[0], models: [] });
    if (doc.contents === null) doc.contents = doc.createNode({ providers: {} });
    if (providers.map === undefined) doc.setIn(["providers"], doc.createNode({}));
    doc.setIn(["providers", edit.provider], entry);
    return { ok: true, text: doc.toString(STRINGIFY_OPTIONS) };
  }
  if (!exists) return { ok: false, error: `${edit.provider} is not in models.yml.` };
  const path = ["providers", edit.provider];
  switch (edit.type) {
    case "removeProvider":
      doc.deleteIn(path);
      break;
    case "setProvider":
      if (edit.value === undefined) doc.deleteIn([...path, edit.field]);
      else doc.setIn([...path, edit.field], edit.value);
      break;
    case "addModel": {
      const models = doc.getIn([...path, "models"], true);
      if (models !== undefined && !isSeq(models)) {
        return { ok: false, error: `providers.${edit.provider}.models must be a list.` };
      }
      if (models === undefined) doc.setIn([...path, "models"], doc.createNode([]));
      doc.addIn([...path, "models"], doc.createNode({ id: edit.model }));
      break;
    }
    case "removeModel":
    case "setModel": {
      const model = doc.getIn([...path, "models", edit.index], true);
      if (!isMap(model)) {
        return { ok: false, error: `providers.${edit.provider} has no model ${edit.index + 1}.` };
      }
      if (edit.type === "removeModel") {
        doc.deleteIn([...path, "models", edit.index]);
        break;
      }
      if (edit.field === "images") {
        if (edit.value === true) model.set("input", doc.createNode(["text", "image"]));
        else model.delete("input");
      } else if (edit.value === undefined) model.delete(edit.field);
      else model.set(edit.field, edit.value);
      break;
    }
  }
  return { ok: true, text: doc.toString(STRINGIFY_OPTIONS) };
}

/** A model the `models.yml` check adds so OMP has one to start with and to list back. */
export const OMP_MODELS_CHECK_MODEL = "ompanel-models-check";

/**
 * `text` with one extra provider, `providerId`, that has a static model and a placeholder key:
 * when OMP lists that model back, it loaded the file's custom providers; when OMP rejects the
 * file it drops them all, this one included. Nothing is ever sent to its address.
 */
export function withOmpModelsCheckProvider(
  text: string,
  providerId: string,
): { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string } {
  const parsed = parse(text);
  if ("error" in parsed) return { ok: false, error: parsed.error };
  const { doc } = parsed;
  const providers = providersOf(doc);
  if ("error" in providers) return { ok: false, error: providers.error };
  if (doc.contents === null) doc.contents = doc.createNode({ providers: {} });
  if (providers.map === undefined) doc.setIn(["providers"], doc.createNode({}));
  doc.setIn(
    ["providers", providerId],
    doc.createNode({
      baseUrl: "http://127.0.0.1:9/v1",
      api: "openai-completions",
      apiKey: OMP_MODELS_CHECK_MODEL,
      models: [{ id: OMP_MODELS_CHECK_MODEL }],
    }),
  );
  return { ok: true, text: doc.toString(STRINGIFY_OPTIONS) };
}
