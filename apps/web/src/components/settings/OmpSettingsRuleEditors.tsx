import type { OmpSettingsField } from "@t3tools/contracts";
import {
  OMP_APPROVAL_MODES,
  OMP_APPROVAL_POLICIES,
  type OmpApprovalPolicy,
} from "@t3tools/provider-omp/settingsPages";
import { ArrowDownIcon, ArrowUpIcon, XIcon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

interface EditorProps {
  readonly field: OmpSettingsField;
  readonly onWrite: (value: unknown) => void;
}

/** OMP reads policies case-insensitively and ignores anything else (`normalizePolicy`). */
const policyOf = (value: unknown): OmpApprovalPolicy | undefined => {
  const lowered = typeof value === "string" ? value.trim().toLowerCase() : undefined;
  return OMP_APPROVAL_POLICIES.find((policy) => policy === lowered);
};

const recordOf = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};

/** allow / prompt / deny; a value OMP would ignore shows as no choice, with a note. */
function PolicyToggle({
  label,
  value,
  disabled,
  onChange,
}: {
  readonly label: string;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly onChange: (policy: OmpApprovalPolicy) => void;
}) {
  const policy = policyOf(value);
  return (
    <div className="flex items-center gap-2">
      <ToggleGroup
        aria-label={label}
        variant="segmented"
        disabled={disabled}
        value={policy === undefined ? [] : [policy]}
        onValueChange={(next) => {
          const picked = policyOf(next[0]);
          if (picked !== undefined && picked !== policy) onChange(picked);
        }}
      >
        {OMP_APPROVAL_POLICIES.map((option) => (
          <Toggle key={option} value={option}>
            {option}
          </Toggle>
        ))}
      </ToggleGroup>
      {policy === undefined && value !== undefined ? (
        <span className="text-destructive-foreground text-xs">
          OMP ignores <code>{JSON.stringify(value)}</code>
        </span>
      ) : null}
    </div>
  );
}

/**
 * A record of rules keyed by name: `tools.approval` (tool → policy) or `task.agentAdvisor`
 * (agent → `on`, `off` or a model). Rows keep their order; a change rewrites only its own entry.
 */
function RecordRulesEditor({
  field,
  onWrite,
  keyLabel,
  value,
}: EditorProps & {
  readonly keyLabel: string;
  readonly value:
    | { readonly kind: "policy" }
    | { readonly kind: "text"; readonly placeholder: string };
}) {
  const rules = recordOf(field.value);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState<string>(value.kind === "policy" ? "prompt" : "");
  const write = (entries: ReadonlyArray<readonly [string, unknown]>) =>
    onWrite(Object.fromEntries(entries));
  const set = (key: string, next: unknown) =>
    write(Object.entries(rules).map(([name, current]) => [name, name === key ? next : current]));
  const trimmedKey = newKey.trim();
  const duplicate = Object.hasOwn(rules, trimmedKey);
  const canAdd = !field.readOnly && trimmedKey !== "" && !duplicate && newValue.trim() !== "";

  return (
    <div className="flex flex-col gap-2">
      {Object.keys(rules).length === 0 ? (
        <p className="text-muted-foreground text-xs">No rules.</p>
      ) : null}
      {Object.entries(rules).map(([key, current]) => (
        <div key={key} className="flex flex-wrap items-center gap-2" data-rule={key}>
          <code className="min-w-24 text-xs">{key}</code>
          {value.kind === "policy" ? (
            <PolicyToggle
              label={`${field.key}.${key}`}
              value={current}
              disabled={field.readOnly}
              onChange={(policy) => set(key, policy)}
            />
          ) : (
            <DraftInput
              className="max-w-64"
              aria-label={`${field.key}.${key}`}
              placeholder={value.placeholder}
              disabled={field.readOnly}
              value={typeof current === "string" ? current : JSON.stringify(current)}
              onCommit={(next) => {
                const text = next.trim();
                if (text !== "") set(key, text);
              }}
            />
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={`Remove ${key}`}
            disabled={field.readOnly}
            onClick={() => write(Object.entries(rules).filter(([name]) => name !== key))}
          >
            <XIcon />
          </Button>
        </div>
      ))}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-48"
          aria-label={`New ${field.key} ${keyLabel}`}
          placeholder={keyLabel}
          disabled={field.readOnly}
          value={newKey}
          onChange={(event) => setNewKey(event.target.value)}
        />
        {value.kind === "policy" ? (
          <PolicyToggle
            label={`New ${field.key} policy`}
            value={newValue}
            disabled={field.readOnly}
            onChange={setNewValue}
          />
        ) : (
          <Input
            className="max-w-48"
            aria-label={`New ${field.key} value`}
            placeholder={value.placeholder}
            disabled={field.readOnly}
            value={newValue}
            onChange={(event) => setNewValue(event.target.value)}
          />
        )}
        <Button
          variant="outline"
          size="xs"
          aria-label={`Add ${field.key} rule`}
          disabled={!canAdd}
          onClick={() => {
            write([...Object.entries(rules), [trimmedKey, newValue.trim()]]);
            setNewKey("");
            setNewValue(value.kind === "policy" ? "prompt" : "");
          }}
        >
          Add
        </Button>
        {duplicate ? (
          <span className="text-muted-foreground text-xs">{trimmedKey} already has a rule.</span>
        ) : null}
      </div>
    </div>
  );
}

/** `tools.approval`: per-tool policy, honoured in every approval mode. */
export function ToolApprovalRulesEditor(props: EditorProps) {
  return <RecordRulesEditor {...props} keyLabel="tool" value={{ kind: "policy" }} />;
}

/** `task.agentAdvisor`: per-subagent advisor, `on`, `off` or a model. */
export function AgentAdvisorRulesEditor(props: EditorProps) {
  return (
    <RecordRulesEditor
      {...props}
      keyLabel="agent"
      value={{ kind: "text", placeholder: "on, off or provider/model" }}
    />
  );
}

interface BashRule {
  readonly match: string;
  readonly approval: unknown;
}

const bashRuleOf = (item: unknown): BashRule | undefined => {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
  return "match" in item && typeof item.match === "string"
    ? { match: item.match, approval: "approval" in item ? item.approval : undefined }
    : undefined;
};

/**
 * `bash.patterns`: ordered `{match, approval}` rules, `*` the only wildcard. Entries OMP would
 * ignore stay in place and can only be removed.
 */
export function BashPatternsEditor({ field, onWrite }: EditorProps) {
  const items: ReadonlyArray<unknown> = Array.isArray(field.value) ? field.value : [];
  const [newMatch, setNewMatch] = useState("");
  const [newApproval, setNewApproval] = useState<OmpApprovalPolicy>("prompt");
  const replace = (index: number, next: unknown) =>
    onWrite(items.map((item, at) => (at === index ? next : item)));
  const move = (index: number, offset: -1 | 1) => {
    const next = [...items];
    const [item] = next.splice(index, 1);
    next.splice(index + offset, 0, item);
    onWrite(next);
  };

  return (
    <div className="flex flex-col gap-2">
      {items.length === 0 ? <p className="text-muted-foreground text-xs">No rules.</p> : null}
      {items.map((item, index) => {
        const rule = bashRuleOf(item);
        const position = index + 1;
        return (
          // Rules have no identity besides their place in the list.
          // oxlint-disable-next-line react/no-array-index-key
          <div key={index} className="flex flex-wrap items-center gap-2" data-rule={position}>
            <span className="w-5 text-muted-foreground text-xs">{position}</span>
            {rule === undefined ? (
              <code className="text-destructive-foreground text-xs">
                {JSON.stringify(item)} (ignored by OMP)
              </code>
            ) : (
              <>
                <DraftInput
                  className="max-w-64"
                  aria-label={`bash.patterns ${position} match`}
                  placeholder="git status*"
                  disabled={field.readOnly}
                  value={rule.match}
                  onCommit={(next) => {
                    if (next.trim() !== "")
                      replace(index, { ...recordOf(item), match: next.trim() });
                  }}
                />
                <PolicyToggle
                  label={`bash.patterns ${position} approval`}
                  value={rule.approval}
                  disabled={field.readOnly}
                  onChange={(approval) => replace(index, { ...recordOf(item), approval })}
                />
              </>
            )}
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Move rule ${position} up`}
              disabled={field.readOnly || index === 0}
              onClick={() => move(index, -1)}
            >
              <ArrowUpIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Move rule ${position} down`}
              disabled={field.readOnly || index === items.length - 1}
              onClick={() => move(index, 1)}
            >
              <ArrowDownIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove rule ${position}`}
              disabled={field.readOnly}
              onClick={() => onWrite(items.filter((_, at) => at !== index))}
            >
              <XIcon />
            </Button>
          </div>
        );
      })}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="max-w-64"
          aria-label="New bash.patterns match"
          placeholder="git status*"
          disabled={field.readOnly}
          value={newMatch}
          onChange={(event) => setNewMatch(event.target.value)}
        />
        <PolicyToggle
          label="New bash.patterns approval"
          value={newApproval}
          disabled={field.readOnly}
          onChange={setNewApproval}
        />
        <Button
          variant="outline"
          size="xs"
          aria-label="Add bash.patterns rule"
          disabled={field.readOnly || newMatch.trim() === ""}
          onClick={() => {
            onWrite([...items, { match: newMatch.trim(), approval: newApproval }]);
            setNewMatch("");
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}

/**
 * `tools.approvalMode`: the default for omp run outside Ompanel. Ompanel threads launch with
 * `--approval-mode` from their permission mode, which outranks this value.
 */
export function ApprovalModeEditor({ field, onWrite }: EditorProps) {
  const current = typeof field.value === "string" ? field.value : undefined;
  return (
    <div className="flex flex-col gap-2">
      <ToggleGroup
        aria-label={field.key}
        variant="segmented"
        disabled={field.readOnly}
        value={current === undefined ? [] : [current]}
        onValueChange={(next) => {
          const mode = next[0];
          if (typeof mode === "string" && mode !== current) onWrite(mode);
        }}
      >
        {OMP_APPROVAL_MODES.map(({ mode, label }) => (
          <Toggle key={mode} value={mode}>
            {label}
          </Toggle>
        ))}
      </ToggleGroup>
      <p className="text-muted-foreground text-xs">
        Applies to omp outside Ompanel. Ompanel threads launch with the mode of their permission
        setting, whatever this says:{" "}
        {OMP_APPROVAL_MODES.filter(({ ompanelMode }) => ompanelMode !== undefined)
          .map(({ mode, ompanelMode }) => `${ompanelMode} → ${mode}`)
          .join(", ")}
        . Rules in <code>tools.approval</code> and <code>bash.patterns</code> apply in every mode.
      </p>
    </div>
  );
}
