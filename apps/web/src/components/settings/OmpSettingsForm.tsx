import type {
  OmpConfigScope,
  OmpConfigSource,
  OmpSettingsField,
  OmpSettingsForm as OmpSettingsFormModel,
} from "@t3tools/contracts";
import { ompConfigValueFits } from "@t3tools/provider-omp/configForm";
import { useState, type ReactNode } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { Input } from "../ui/input";

const SOURCE_LABEL: Record<OmpConfigSource, string> = {
  default: "Default",
  global: "Global",
  project: "Project",
  overlay: "Overlay",
  runtime: "Runtime",
  env: "Environment",
};

export interface OmpSettingsFormProps {
  readonly form: OmpSettingsFormModel;
  /** The config file edits go to; a field set by this layer can be reset. */
  readonly scope: OmpConfigScope;
  readonly onWrite: (key: string, value: unknown) => void;
  readonly onReset: (key: string) => void;
  /** Replaces the generic control for a key; credential and env rules still apply. */
  readonly controls?: Readonly<
    Record<string, (field: OmpSettingsField, onWrite: (value: unknown) => void) => ReactNode>
  >;
  /** Why a non-env read-only field is read-only; defaults to the path-scoped explanation. */
  readonly readOnlyNote?: string;
}

function JsonField({
  field,
  onWrite,
}: {
  readonly field: OmpSettingsField;
  readonly onWrite: (value: unknown) => void;
}) {
  const [invalid, setInvalid] = useState(false);
  const text = field.value === undefined ? "" : JSON.stringify(field.value, null, 2);
  const lines = text.split("\n").length;
  return (
    <div>
      <Textarea
        key={text}
        aria-label={field.key}
        aria-invalid={invalid}
        disabled={field.readOnly}
        rows={lines < 8 ? lines + 1 : 8}
        defaultValue={text}
        onBlur={(event) => {
          const next = event.target.value.trim();
          if (next === text) return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(next);
          } catch {
            setInvalid(true);
            return;
          }
          const fits = ompConfigValueFits(field.type, parsed);
          setInvalid(!fits);
          if (fits) onWrite(parsed);
        }}
      />
      {invalid ? (
        <p className="mt-1 text-destructive-foreground text-xs">
          Enter a JSON {field.type === "array" ? "array" : "object"}.
        </p>
      ) : null}
    </div>
  );
}

function FieldControl({
  field,
  onWrite,
}: {
  readonly field: OmpSettingsField;
  readonly onWrite: (value: unknown) => void;
}) {
  // Ompanel never takes a credential: `omp config set` would carry it in argv.
  if (field.credential) {
    return (
      <Input
        aria-label={field.key}
        type="password"
        disabled
        placeholder={field.redacted ? "Stored" : "Not set"}
      />
    );
  }
  switch (field.type) {
    case "boolean":
      return (
        <Switch
          checked={field.value === true}
          disabled={field.readOnly}
          onCheckedChange={(checked) => onWrite(Boolean(checked))}
          aria-label={field.key}
        />
      );
    case "number":
      return (
        <DraftInput
          aria-label={field.key}
          inputMode="decimal"
          disabled={field.readOnly}
          value={typeof field.value === "number" ? String(field.value) : ""}
          onCommit={(next) => {
            const parsed = Number(next.trim());
            if (next.trim() !== "" && Number.isFinite(parsed)) onWrite(parsed);
          }}
        />
      );
    case "string":
    case "enum":
      return (
        <DraftInput
          aria-label={field.key}
          disabled={field.readOnly}
          value={typeof field.value === "string" ? field.value : ""}
          onCommit={onWrite}
        />
      );
    case "array":
    case "record":
      return <JsonField field={field} onWrite={onWrite} />;
  }
}

/** Renders the settings engine's form: one row per OMP setting, grouped by key prefix. */
export function OmpSettingsForm({
  form,
  scope,
  onWrite,
  onReset,
  controls,
  readOnlyNote = "Can hold entries scoped to other folders, which this view cannot show; edit it in OMP's config file.",
}: OmpSettingsFormProps) {
  const groups = new Map<string, OmpSettingsField[]>();
  for (const field of form.fields) {
    const fields = groups.get(field.group);
    if (fields === undefined) groups.set(field.group, [field]);
    else fields.push(field);
  }
  return (
    <div className="flex flex-col gap-6">
      {[...groups].map(([group, fields]) => (
        <section key={group} aria-label={group} className="flex flex-col gap-3">
          <h3 className="font-medium text-sm">{group}</h3>
          {fields.map((field) => (
            <div key={field.key} className="flex flex-col gap-1.5" data-setting={field.key}>
              <div className="flex flex-wrap items-center gap-2">
                <code className="text-xs">{field.key}</code>
                <Badge variant="outline" size="sm">
                  {SOURCE_LABEL[field.source]}
                </Badge>
                {field.launchScoped ? (
                  <Badge variant="warning" size="sm">
                    Restarts threads
                  </Badge>
                ) : null}
                {field.source === scope && !field.readOnly ? (
                  <Button variant="ghost" size="compact" onClick={() => onReset(field.key)}>
                    Reset
                  </Button>
                ) : null}
              </div>
              {field.description === "" ? null : (
                <p className="text-muted-foreground text-xs">{field.description}</p>
              )}
              <div className="max-w-xl">
                {(field.credential ? undefined : controls?.[field.key])?.(field, (value) =>
                  onWrite(field.key, value),
                ) ?? <FieldControl field={field} onWrite={(value) => onWrite(field.key, value)} />}
              </div>
              {field.readOnly ? (
                <p className="text-muted-foreground text-xs">
                  {field.source === "env"
                    ? "Set by an environment variable; change it where OMP is launched."
                    : readOnlyNote}
                </p>
              ) : field.credential ? (
                <p className="text-muted-foreground text-xs">
                  Credential. Set it with OMP sign-in or an environment variable; Reset clears a
                  stored one.
                </p>
              ) : null}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
