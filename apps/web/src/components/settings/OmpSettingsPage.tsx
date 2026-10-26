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
  ompSettingsPageForm,
  type OmpSettingsPageId,
} from "@t3tools/provider-omp/settingsPages";
import { useEffect, useState } from "react";

import { useEnvironmentProviders, usePrimaryEnvironmentId } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { DraftInput } from "../ui/draft-input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { OmpAgentFilesSection } from "./OmpAgentFilesSection";
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
  const readSettings = useAtomCommand(serverEnvironment.readOmpSettings, { reportFailure: false });
  const writeSetting = useAtomCommand(serverEnvironment.writeOmpSetting, { reportFailure: false });
  const resetSetting = useAtomCommand(serverEnvironment.resetOmpSetting, { reportFailure: false });
  const [form, setForm] = useState<OmpSettingsFormModel | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // The parent keys this body by environment and instance, so state starts fresh for each.
  useEffect(() => {
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
  }, [environmentId, instanceId, readSettings]);

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
      {form === null ? (
        <p className="text-muted-foreground text-xs">
          {loadFailed ? "OMP settings are unavailable." : "Reading OMP settings…"}
        </p>
      ) : (
        <OmpSettingsForm
          form={ompSettingsPageForm(form, page)}
          scope={SCOPE}
          controls={CONTROLS}
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
      {pageId === "advisor" ? (
        <OmpAgentFilesSection environmentId={environmentId} instanceId={instanceId} />
      ) : null}
    </div>
  );
}

/** Settings → OMP page on the primary environment, with a picker when it runs several OMPs. */
export function OmpSettingsPanel({ pageId }: { readonly pageId: OmpSettingsPageId }) {
  const environmentId = usePrimaryEnvironmentId();
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
