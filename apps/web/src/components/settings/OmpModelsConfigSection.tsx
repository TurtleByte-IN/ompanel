import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import {
  editOmpModelsConfig,
  OMP_CUSTOM_PROVIDER_ID_PATTERN,
  OMP_MODELS_APIS,
  OMP_PROVIDER_AUTH_MODES,
  readOmpModelsConfig,
  type OmpCustomModel,
  type OmpCustomProvider,
  type OmpModelsConfigEdit,
} from "@t3tools/provider-omp/modelsConfig";
import { useEffect, useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { useOmpAgentFilesList, useOmpFileEditor } from "./OmpAgentFileEditor";

const API_UNSET = "(not set)";

type Apply = (edit: OmpModelsConfigEdit) => void;

/** A whole number from a text field, or undefined to remove the key. */
const wholeNumber = (text: string) => {
  const trimmed = text.trim();
  if (trimmed === "") return undefined;
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? value : null;
};

function ModelRow({
  provider,
  model,
  index,
  apply,
}: {
  readonly provider: string;
  readonly model: OmpCustomModel;
  readonly index: number;
  readonly apply: Apply;
}) {
  const label = `${provider}/${model.id}`;
  const set = (
    field: "id" | "name" | "contextWindow" | "maxTokens" | "reasoning" | "images",
    value: string | number | boolean | undefined,
  ) => apply({ type: "setModel", provider, index, field, value });
  const setNumber = (field: "contextWindow" | "maxTokens", text: string) => {
    const value = wholeNumber(text);
    if (value === null) {
      toastManager.add({ type: "error", title: `${field} must be a whole number of tokens` });
      return;
    }
    set(field, value);
  };
  return (
    <div
      className="grid min-w-0 grid-cols-1 gap-2 rounded-md border border-border/60 p-2 sm:grid-cols-2"
      data-custom-model={label}
    >
      <DraftInput
        aria-label={`${label} id`}
        placeholder="model id"
        value={model.id}
        onCommit={(next) => {
          if (next.trim() !== "") set("id", next.trim());
        }}
      />
      <DraftInput
        aria-label={`${label} name`}
        placeholder="Display name"
        value={model.name ?? ""}
        onCommit={(next) => set("name", next.trim() === "" ? undefined : next.trim())}
      />
      <DraftInput
        aria-label={`${label} contextWindow`}
        placeholder="Context window (tokens)"
        inputMode="numeric"
        value={model.contextWindow === undefined ? "" : String(model.contextWindow)}
        onCommit={(next) => setNumber("contextWindow", next)}
      />
      <DraftInput
        aria-label={`${label} maxTokens`}
        placeholder="Max output tokens"
        inputMode="numeric"
        value={model.maxTokens === undefined ? "" : String(model.maxTokens)}
        onCommit={(next) => setNumber("maxTokens", next)}
      />
      <div className="flex flex-wrap items-center gap-4 sm:col-span-2">
        {/* Not a <label>: Base UI would name the switch after its text instead of the model. */}
        <span className="flex items-center gap-2 text-xs">
          <Switch
            size="sm"
            aria-label={`${label} reasoning`}
            checked={model.reasoning === true}
            onCheckedChange={(checked) => set("reasoning", checked ? true : undefined)}
          />
          Reasoning
        </span>
        <span className="flex items-center gap-2 text-xs">
          <Switch
            size="sm"
            aria-label={`${label} images`}
            checked={model.images}
            onCheckedChange={(checked) => set("images", Boolean(checked))}
          />
          Images
        </span>
        <Button
          variant="ghost-destructive"
          size="xs"
          aria-label={`Remove ${label}`}
          onClick={() => apply({ type: "removeModel", provider, index })}
        >
          Remove model
        </Button>
      </div>
    </div>
  );
}

function ProviderCard({
  provider,
  apply,
}: {
  readonly provider: OmpCustomProvider;
  readonly apply: Apply;
}) {
  const [newModel, setNewModel] = useState("");
  const id = provider.id;
  const setField = (field: "baseUrl" | "api" | "apiKey" | "auth", value: string) =>
    apply({
      type: "setProvider",
      provider: id,
      field,
      value: value.trim() === "" ? undefined : value.trim(),
    });
  return (
    <div
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
      data-custom-provider={id}
    >
      <div className="flex flex-wrap items-center gap-2">
        <code className="font-medium text-sm">{id}</code>
        <Button
          variant="ghost-destructive"
          size="xs"
          onClick={() => apply({ type: "removeProvider", provider: id })}
        >
          Remove provider
        </Button>
      </div>
      <div className="grid min-w-0 grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-center gap-x-3 gap-y-1.5">
        <label className="text-xs" htmlFor={`omp-provider-${id}-baseUrl`}>
          Base URL
        </label>
        <DraftInput
          id={`omp-provider-${id}-baseUrl`}
          aria-label={`${id} baseUrl`}
          placeholder="https://api.example.com/v1"
          value={provider.baseUrl ?? ""}
          onCommit={(next) => setField("baseUrl", next)}
        />
        <span className="text-xs">API</span>
        <Select
          value={provider.api ?? API_UNSET}
          onValueChange={(next) => setField("api", next === API_UNSET ? "" : String(next))}
        >
          <SelectTrigger size="sm" aria-label={`${id} api`}>
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value={API_UNSET}>{API_UNSET}</SelectItem>
            {OMP_MODELS_APIS.map((api) => (
              <SelectItem key={api} value={api}>
                {api}
              </SelectItem>
            ))}
            {provider.api !== undefined &&
            !(OMP_MODELS_APIS as ReadonlyArray<string>).includes(provider.api) ? (
              <SelectItem value={provider.api}>{provider.api}</SelectItem>
            ) : null}
          </SelectPopup>
        </Select>
        <label className="text-xs" htmlFor={`omp-provider-${id}-apiKey`}>
          API key
        </label>
        <DraftInput
          id={`omp-provider-${id}-apiKey`}
          aria-label={`${id} apiKey`}
          placeholder="MY_PROVIDER_API_KEY"
          autoComplete="off"
          value={provider.apiKey ?? ""}
          onCommit={(next) => setField("apiKey", next)}
        />
        <span className="text-xs">Auth</span>
        <ToggleGroup
          aria-label={`${id} auth`}
          variant="segmented"
          className="max-w-full flex-wrap"
          value={provider.auth === undefined ? [] : [provider.auth]}
          onValueChange={(next) => setField("auth", typeof next[0] === "string" ? next[0] : "")}
        >
          {OMP_PROVIDER_AUTH_MODES.map((mode) => (
            <Toggle key={mode} value={mode}>
              {mode}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>
      <p className="text-muted-foreground text-xs">
        The API key is the name of an environment variable OMP reads (preferred), a literal key, or{" "}
        <code>!command</code> whose output is the key. OMP needs one for models of a provider whose
        auth is <code>apiKey</code>, the default.
      </p>
      {provider.otherKeys.length === 0 ? null : (
        <p className="text-muted-foreground text-xs">
          Also set in YAML, kept as written: {provider.otherKeys.join(", ")}.
        </p>
      )}
      <div className="flex flex-col gap-2">
        <span className="text-xs">Models</span>
        {provider.models.length === 0 ? (
          <p className="text-muted-foreground text-xs">No models listed here.</p>
        ) : (
          provider.models.map((model, index) => (
            <ModelRow
              key={`${index}:${model.id}`}
              provider={id}
              model={model}
              index={index}
              apply={apply}
            />
          ))
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-56"
            aria-label={`New model id for ${id}`}
            placeholder="model id"
            value={newModel}
            onChange={(event) => setNewModel(event.target.value)}
          />
          <Button
            variant="outline"
            size="xs"
            disabled={newModel.trim() === ""}
            onClick={() => {
              apply({ type: "addModel", provider: id, model: newModel.trim() });
              setNewModel("");
            }}
          >
            Add model
          </Button>
        </div>
      </div>
    </div>
  );
}

/**
 * Settings → OMP → Custom providers: `models.yml` in the agent directory of this instance's OMP
 * profile, as a form and as YAML. Both edit the same unsaved text; a save is checked by OMP
 * first, so a file OMP would drop never replaces the one on disk.
 */
export function OmpModelsConfigSection({
  environmentId,
  instanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const { list, loadFailed, refresh } = useOmpAgentFilesList({ environmentId, instanceId });
  const editor = useOmpFileEditor({
    environmentId,
    instanceId,
    onSaved: (file, created) => {
      if (created) refresh();
      const models = file.checkedModels ?? [];
      toastManager.add({
        type: "info",
        title:
          models.length === 0
            ? "OMP loaded the file; it lists no models from its own providers"
            : `OMP loaded ${models.length} model(s) from this file`,
        ...(models.length === 0
          ? {}
          : {
              description: models
                .slice(0, 8)
                .map((model) => `${model.provider}/${model.id}`)
                .join(", "),
            }),
      });
    },
  });
  const [view, setView] = useState<"form" | "yaml">("form");
  const [newProvider, setNewProvider] = useState("");
  const { open, openFile } = editor;

  // The file opens with the page; the parent keys this section by environment and instance.
  useEffect(() => {
    openFile({ kind: "models" });
  }, [openFile]);

  if (list === null || open === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {loadFailed ? "OMP's agent directory is unavailable." : "Reading models.yml…"}
      </p>
    );
  }

  const read = readOmpModelsConfig(open.draft);
  const apply: Apply = (edit) => {
    const result = editOmpModelsConfig(open.draft, edit);
    if (result.ok) editor.setDraft(result.text);
    else toastManager.add({ type: "error", title: result.error });
  };
  const dirty = open.draft !== open.saved;
  const newProviderId = newProvider.trim();
  const newProviderValid = OMP_CUSTOM_PROVIDER_ID_PATTERN.test(newProviderId);
  const newProviderTaken = read.ok && read.providers.some((entry) => entry.id === newProviderId);

  return (
    <section
      aria-label="Custom providers"
      className="flex min-w-0 flex-col gap-3"
      data-omp-files="models"
    >
      <p className="text-muted-foreground text-xs">
        <code>{open.relativePath}</code> in <code className="break-all">{list.agentDir}</code>, the
        agent directory of this OMP profile. Before a save replaces it, OMP loads the new text in a
        scratch directory; if OMP would drop the file's providers, nothing is saved.
      </p>
      {list.modelsLegacyJson ? (
        <p className="text-warning-foreground text-xs" data-models-legacy="">
          Only a legacy <code>models.json</code> exists. OMP turns it into <code>models.yml</code>{" "}
          the next time it starts; edit it here after that.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          aria-label="models.yml view"
          variant="segmented"
          value={[view]}
          onValueChange={(next) => {
            if (next[0] === "form" || next[0] === "yaml") setView(next[0]);
          }}
        >
          <Toggle value="form">Form</Toggle>
          <Toggle value="yaml">YAML</Toggle>
        </ToggleGroup>
        {open.version === undefined ? (
          <Badge variant="outline" size="sm">
            New
          </Badge>
        ) : null}
        {dirty ? (
          <Badge variant="outline" size="sm">
            Unsaved
          </Badge>
        ) : null}
      </div>
      {view === "yaml" ? (
        <Textarea
          aria-label={`Contents of ${open.relativePath}`}
          rows={20}
          value={open.draft}
          onChange={(event) => editor.setDraft(event.target.value)}
        />
      ) : !read.ok ? (
        <p className="text-destructive-foreground text-xs" data-models-error="">
          {read.error} Fix it in the YAML view.
        </p>
      ) : (
        <div className="flex min-w-0 flex-col gap-3">
          {read.providers.length === 0 ? (
            <p className="text-muted-foreground text-xs">No custom providers.</p>
          ) : (
            read.providers.map((provider) => (
              <ProviderCard key={provider.id} provider={provider} apply={apply} />
            ))
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="max-w-56"
              aria-label="New provider id"
              placeholder="my-provider"
              value={newProvider}
              onChange={(event) => setNewProvider(event.target.value)}
            />
            <Button
              variant="outline"
              size="xs"
              disabled={!newProviderValid || newProviderTaken}
              onClick={() => {
                apply({ type: "addProvider", provider: newProviderId });
                setNewProvider("");
              }}
            >
              Add provider
            </Button>
            {newProviderId !== "" && !newProviderValid ? (
              <span className="text-destructive-foreground text-xs">
                Letters, digits, <code>. _ -</code>.
              </span>
            ) : newProviderTaken ? (
              <span className="text-muted-foreground text-xs">{newProviderId} exists.</span>
            ) : null}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          disabled={editor.saving || list.modelsLegacyJson || !dirty}
          onClick={() => editor.save(open)}
        >
          {editor.saving ? "Checking with OMP…" : "Save"}
        </Button>
        <Button variant="ghost" size="xs" onClick={() => openFile({ kind: "models" })}>
          Reload
        </Button>
      </div>
    </section>
  );
}
