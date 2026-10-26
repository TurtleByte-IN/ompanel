import type {
  EnvironmentId,
  OmpSettingsField,
  OmpSettingsForm as OmpSettingsFormModel,
  OmpSettingsWriteResult,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  OMP_MODEL_ROLES,
  OMP_SETTINGS_PAGES,
  OMP_WEB_SEARCH_ROLE,
  ompSettingsPageForm,
  type OmpSettingsPageId,
} from "@t3tools/provider-omp/settingsPages";
import { useEffect, useState } from "react";

import {
  useEnvironmentHasConnected,
  useEnvironmentProviders,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { OmpAgentFilesSection } from "./OmpAgentFilesSection";
import { OmpCustomizationSection } from "./OmpCustomizationSection";
import { OmpMcpSection } from "./OmpMcpSection";
import { OmpPluginsSection } from "./OmpPluginsSection";
import { OmpSkillsSection } from "./OmpSkillsSection";
import { OmpModelsConfigSection } from "./OmpModelsConfigSection";
import { OmpSettingsForm, type OmpSettingsFormProps } from "./OmpSettingsForm";
import {
  AgentAdvisorRulesEditor,
  ApprovalModeEditor,
  BashPatternsEditor,
  ToolApprovalRulesEditor,
} from "./OmpSettingsRuleEditors";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";

// Ompanel writes the user's global OMP config from these pages; project layers stay per project.
const SCOPE = "global";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "OMP could not apply the setting.",
  });
}

/** `modelRoles` as one model per OMP role; an empty role is removed from the record. */
function ModelRolesEditor({
  field,
  onWrite,
}: {
  readonly field: OmpSettingsField;
  readonly onWrite: (value: unknown) => void;
}) {
  const roles =
    typeof field.value === "object" && field.value !== null
      ? (field.value as Readonly<Record<string, unknown>>)
      : {};
  return (
    <div className="grid grid-cols-[8rem_1fr] items-center gap-x-3 gap-y-1.5">
      {OMP_MODEL_ROLES.map(({ role, label }) => (
        <div key={role} className="contents" data-model-role={role}>
          <label className="text-xs" htmlFor={`omp-model-role-${role}`}>
            {label} <code className="text-muted-foreground">{role}</code>
          </label>
          <DraftInput
            id={`omp-model-role-${role}`}
            aria-label={`modelRoles.${role}`}
            placeholder="provider/model"
            disabled={field.readOnly}
            value={typeof roles[role] === "string" ? roles[role] : ""}
            onCommit={(next) => {
              const model = next.trim();
              onWrite(
                Object.fromEntries([
                  ...Object.entries(roles).filter(([name]) => name !== role),
                  ...(model === "" ? [] : [[role, model]]),
                ]),
              );
            }}
          />
        </div>
      ))}
    </div>
  );
}

const CONTROLS: NonNullable<OmpSettingsFormProps["controls"]> = {
  modelRoles: (field, onWrite) => <ModelRolesEditor field={field} onWrite={onWrite} />,
  "tools.approvalMode": (field, onWrite) => <ApprovalModeEditor field={field} onWrite={onWrite} />,
  "tools.approval": (field, onWrite) => <ToolApprovalRulesEditor field={field} onWrite={onWrite} />,
  "bash.patterns": (field, onWrite) => <BashPatternsEditor field={field} onWrite={onWrite} />,
  "task.agentAdvisor": (field, onWrite) => (
    <AgentAdvisorRulesEditor field={field} onWrite={onWrite} />
  ),
};

function recordOf(field: OmpSettingsField): Readonly<Record<string, unknown>> {
  return typeof field.value === "object" && field.value !== null && !Array.isArray(field.value)
    ? (field.value as Readonly<Record<string, unknown>>)
    : {};
}

/** `record` with `key` set to `value`, or without `key` when `value` is undefined. */
function withEntry(record: Readonly<Record<string, unknown>>, key: string, value: unknown) {
  return Object.fromEntries([
    ...Object.entries(record).filter(([name]) => name !== key),
    ...(value === undefined ? [] : [[key, value]]),
  ]);
}

/** The `web` role of `modelRoles`: the first search provider; other roles are kept as they are. */
function WebSearchRoleEditor({
  field,
  onWrite,
}: {
  readonly field: OmpSettingsField;
  readonly onWrite: (value: unknown) => void;
}) {
  const roles = recordOf(field);
  const current = roles[OMP_WEB_SEARCH_ROLE];
  return (
    <DraftInput
      aria-label={`modelRoles.${OMP_WEB_SEARCH_ROLE}`}
      placeholder="web/exa"
      disabled={field.readOnly}
      value={typeof current === "string" ? current : ""}
      onCommit={(next) => {
        const provider = next.trim();
        onWrite(withEntry(roles, OMP_WEB_SEARCH_ROLE, provider === "" ? undefined : provider));
      }}
    />
  );
}

/** The `web` chain of `retry.fallbackChains`: providers tried after the role's, comma-separated. */
function WebSearchChainEditor({
  field,
  onWrite,
}: {
  readonly field: OmpSettingsField;
  readonly onWrite: (value: unknown) => void;
}) {
  const chains = recordOf(field);
  const current = chains[OMP_WEB_SEARCH_ROLE];
  return (
    <DraftInput
      aria-label={`retry.fallbackChains.${OMP_WEB_SEARCH_ROLE}`}
      placeholder="web/searxng, web/duckduckgo"
      disabled={field.readOnly}
      value={Array.isArray(current) ? current.join(", ") : ""}
      onCommit={(next) => {
        const chain = next
          .split(",")
          .map((provider) => provider.trim())
          .filter((provider) => provider !== "");
        onWrite(withEntry(chains, OMP_WEB_SEARCH_ROLE, chain.length === 0 ? undefined : chain));
      }}
    />
  );
}

/** Search shows only the `web` entries of the shared role and chain records. */
const SEARCH_CONTROLS: NonNullable<OmpSettingsFormProps["controls"]> = {
  ...CONTROLS,
  modelRoles: (field, onWrite) => <WebSearchRoleEditor field={field} onWrite={onWrite} />,
  "retry.fallbackChains": (field, onWrite) => (
    <WebSearchChainEditor field={field} onWrite={onWrite} />
  ),
};

/** Search edits only the `web` entry of these; clearing its field removes that entry. */
const SEARCH_PARTIAL_KEYS: ReadonlyArray<string> = ["modelRoles", "retry.fallbackChains"];

const TERMINAL_ONLY_NOTE = "Terminal-only: OMP's terminal UI reads it; Ompanel does not use it.";

/** OMP has no PTY setting: `--no-pty` / `PI_NO_PTY` turn it off, and `rpc-ui` always does. */
function PtyNote() {
  return (
    <div className="flex flex-col gap-1.5" data-setting-static="pty">
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-xs">PTY</code>
        <span className="text-muted-foreground text-xs">Off · read-only</span>
      </div>
      <p className="text-muted-foreground text-xs">
        OMP has no setting for it. Bash runs without a pseudo-terminal in Ompanel threads because
        OMP's rpc-ui mode forces it off; in the terminal app, <code>--no-pty</code> or{" "}
        <code>PI_NO_PTY=1</code> turn it off.
      </p>
    </div>
  );
}

function KeybindingsNote() {
  return (
    <div className="flex flex-col gap-1.5" data-setting-static="keybindings.yml">
      <div className="flex flex-wrap items-center gap-2">
        <code className="text-xs">keybindings.yml</code>
        <span className="text-muted-foreground text-xs">Terminal-only · read-only</span>
      </div>
      <p className="text-muted-foreground text-xs">
        Key bindings for OMP's terminal UI, in <code>keybindings.yml</code> in OMP's agent
        directory. Ompanel's own shortcuts are under Keybindings.
      </p>
    </div>
  );
}

/** One OMP settings page for one OMP instance: reads through the engine, writes globally. */
export function OmpSettingsPageBody({
  environmentId,
  instanceId,
  pageId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly pageId: OmpSettingsPageId;
}) {
  const page = OMP_SETTINGS_PAGES[pageId];
  // Custom providers live in models.yml only; that page has no settings to read.
  const hasSettings = page.keys.length > 0;
  const readSettings = useAtomCommand(serverEnvironment.readOmpSettings, { reportFailure: false });
  const writeSetting = useAtomCommand(serverEnvironment.writeOmpSetting, { reportFailure: false });
  const resetSetting = useAtomCommand(serverEnvironment.resetOmpSetting, { reportFailure: false });
  const [form, setForm] = useState<OmpSettingsFormModel | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // The parent keys this body by environment and instance, so state starts fresh for each.
  useEffect(() => {
    if (!hasSettings) return;
    let cancelled = false;
    void readSettings({ environmentId, input: { instanceId } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") setForm(result.value);
      else {
        setLoadFailed(true);
        reportFailure("Could not read OMP settings", result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, readSettings, hasSettings]);

  const applied = (
    key: string,
    result: AtomCommandResult<OmpSettingsWriteResult, unknown>,
    failureTitle: string,
  ) => {
    if (result._tag !== "Success") {
      reportFailure(failureTitle, result);
      return;
    }
    setForm(result.value.form);
    const { overriddenBy, restartRequired } = result.value;
    if (overriddenBy !== undefined) {
      toastManager.add({
        type: "warning",
        title: `${key} saved, but ${overriddenBy} still overrides it`,
      });
    }
    if (restartRequired.length > 0) {
      toastManager.add({
        type: "info",
        title: `${restartRequired.length} open thread(s) pick up ${key} after a restart`,
      });
    }
  };

  return (
    <div className="flex flex-col gap-3 px-3 py-3 sm:px-4" data-omp-settings-page={pageId}>
      <p className="text-muted-foreground text-xs">{page.description}</p>
      {pageId === "providers" ? (
        <OmpModelsConfigSection environmentId={environmentId} instanceId={instanceId} />
      ) : null}
      {pageId === "mcp" ? (
        <OmpMcpSection environmentId={environmentId} instanceId={instanceId} />
      ) : null}
      {pageId === "customization" ? (
        <OmpCustomizationSection environmentId={environmentId} instanceId={instanceId} />
      ) : null}
      {pageId === "plugins" ? (
        <OmpPluginsSection environmentId={environmentId} instanceId={instanceId} />
      ) : null}
      {pageId === "skills" ? (
        <OmpSkillsSection environmentId={environmentId} instanceId={instanceId} />
      ) : null}
      {!hasSettings ? null : form === null ? (
        <p className="text-muted-foreground text-xs">
          {loadFailed ? "OMP settings are unavailable." : "Reading OMP settings…"}
        </p>
      ) : (
        <OmpSettingsForm
          form={ompSettingsPageForm(form, page)}
          scope={SCOPE}
          controls={pageId === "search" ? SEARCH_CONTROLS : CONTROLS}
          {...(page.terminalOnly ? { readOnlyNote: TERMINAL_ONLY_NOTE } : {})}
          {...(pageId === "search" ? { noReset: SEARCH_PARTIAL_KEYS } : {})}
          onWrite={(key, value) =>
            void writeSetting({
              environmentId,
              input: { instanceId, scope: SCOPE, key, value },
            }).then((result) => applied(key, result, `Could not save ${key}`))
          }
          onReset={(key) =>
            void resetSetting({
              environmentId,
              input: { instanceId, scope: SCOPE, key },
            }).then((result) => applied(key, result, `Could not reset ${key}`))
          }
        />
      )}
      {pageId === "runtime" ? <PtyNote /> : null}
      {pageId === "terminal" ? <KeybindingsNote /> : null}
      {pageId === "advisor" ? (
        <OmpAgentFilesSection environmentId={environmentId} instanceId={instanceId} />
      ) : null}
    </div>
  );
}

/** Settings → OMP page on the primary environment, with a picker when it runs several OMPs. */
export function OmpSettingsPanel({ pageId }: { readonly pageId: OmpSettingsPageId }) {
  const environmentId = usePrimaryEnvironmentId();
  const hasConnected = useEnvironmentHasConnected(environmentId);
  const providersByEnvironment = useEnvironmentProviders();
  const instances = (
    environmentId === null ? [] : (providersByEnvironment.get(environmentId) ?? [])
  ).filter((provider) => provider.driver === "omp");
  const [picked, setPicked] = useState<ProviderInstanceId | null>(null);
  const instanceId =
    instances.find((provider) => provider.instanceId === picked)?.instanceId ??
    instances[0]?.instanceId;
  const page = OMP_SETTINGS_PAGES[pageId];
  return (
    <SettingsPageContainer>
      <SettingsSection
        id={`omp-${pageId}`}
        title={`OMP · ${page.title}`}
        headerAction={
          instances.length > 1 && instanceId !== undefined ? (
            <Select
              value={instanceId}
              onValueChange={(next) => setPicked(next as ProviderInstanceId)}
            >
              <SelectTrigger size="sm" aria-label="OMP instance">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {instances.map((provider) => (
                  <SelectItem key={provider.instanceId} value={provider.instanceId}>
                    {provider.displayName ?? provider.instanceId}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          ) : null
        }
      >
        {environmentId === null || instanceId === undefined ? (
          <p className="px-3 py-3 text-muted-foreground text-xs sm:px-4">
            Add an OMP provider under Providers to edit its settings here.
          </p>
        ) : !hasConnected ? (
          // A full page load shows the cached providers before the connection is up; the body
          // reads OMP on mount, so it waits for the connection.
          <p className="px-3 py-3 text-muted-foreground text-xs sm:px-4">Connecting…</p>
        ) : (
          <OmpSettingsPageBody
            key={`${environmentId}:${instanceId}`}
            environmentId={environmentId}
            instanceId={instanceId}
            pageId={pageId}
          />
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
