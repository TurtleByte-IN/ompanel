// Settings → OMP on mobile: read-only summaries of the OMP settings pages web and desktop edit
// (apps/web/src/components/settings/OmpSettingsPage.tsx), plus plugins, skills, the agent
// directory's files and saved sessions. Accounts stay editable under Provider accounts;
// everything here is shown, never written (FR-19).
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OmpConfigSource,
  OmpSettingsField,
  OmpSettingsForm,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { OMP_SETTINGS_PAGES, ompSettingsPageForm } from "@t3tools/provider-omp/settingsPages";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { OmpAgentDirectorySummary } from "./OmpAgentDirectorySummary";
import { OmpPluginsSummary, OmpSkillsSummary } from "./OmpPluginsSummary";
import { OmpSessionsSummary } from "./OmpSessionsSummary";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";

const SOURCE_LABEL: Record<OmpConfigSource, string> = {
  default: "Default",
  global: "Global",
  project: "Project",
  overlay: "Overlay",
  runtime: "Runtime",
  env: "Environment",
};

/** Long lists and records are cut so a row stays a summary; web shows them whole. */
const MAX_VALUE_LENGTH = 160;

/** What a setting is set to, as one line; credentials never show their value. */
export function ompSettingValueText(field: OmpSettingsField): string {
  if (field.credential) return field.redacted ? "Stored (hidden)" : "Not set";
  const value = field.value;
  if (value === undefined || value === null) return "Not set";
  if (typeof value === "boolean") return value ? "On" : "Off";
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === "" || text === "[]" || text === "{}") return "Empty";
  return text.length > MAX_VALUE_LENGTH ? `${text.slice(0, MAX_VALUE_LENGTH - 1)}…` : text;
}

function fieldMeta(field: OmpSettingsField): string {
  return [
    SOURCE_LABEL[field.source],
    field.launchScoped ? "Restarts threads" : null,
    field.source === "env" ? "Set by an environment variable" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** Every OMP settings page that has fields in `form`, as read-only rows. */
export function OmpSettingsSummaryView(props: { readonly form: OmpSettingsForm }) {
  return (
    <View className="gap-6">
      {Object.values(OMP_SETTINGS_PAGES).map((page) => {
        const { fields } = ompSettingsPageForm(props.form, page);
        if (fields.length === 0) return null;
        return (
          <SettingsSection key={page.id} title={page.title} footer={page.description}>
            {fields.map((field) => {
              const value = ompSettingValueText(field);
              const meta = fieldMeta(field);
              return (
                <View
                  key={field.key}
                  accessible
                  accessibilityLabel={`${field.key}: ${value}. ${meta}`}
                  className="gap-1 border-b border-border-subtle px-4 py-3"
                >
                  <Text className="font-mono text-xs text-foreground-muted">{field.key}</Text>
                  <Text selectable className="text-base text-foreground">
                    {value}
                  </Text>
                  <Text className="text-xs text-foreground-muted">{meta}</Text>
                </View>
              );
            })}
          </SettingsSection>
        );
      })}
    </View>
  );
}

function OmpSettingsSummary(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const { environmentId, instanceId } = props;
  const readSettings = useAtomCommand(serverEnvironment.readOmpSettings, { reportFailure: false });
  const [state, setState] = useState<
    { readonly form: OmpSettingsForm } | { readonly error: string } | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    void readSettings({ environmentId, input: { instanceId } }).then((result) => {
      if (cancelled || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Success") {
        setState({ form: result.value });
        return;
      }
      const failure = squashAtomCommandFailure(result);
      setState({
        error: failure instanceof Error ? failure.message : "OMP settings are unavailable.",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, readSettings]);

  if (state === null) {
    return <Text className="px-1 text-foreground-muted">Reading OMP settings…</Text>;
  }
  if ("error" in state) {
    return (
      <Text accessibilityRole="alert" className="px-1 text-danger-foreground">
        {state.error}
      </Text>
    );
  }
  return <OmpSettingsSummaryView form={state.form} />;
}

export function SettingsOmpRouteScreen() {
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  const insets = useSafeAreaInsets();
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="OMP" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScreenScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="text-sm text-foreground-muted">
            Read-only. Change OMP settings, plugins and agent files, and import sessions, in web or
            desktop Settings; sign in under Provider accounts.
          </Text>
          {selectedTargets.length === 0 ? (
            <Text className="text-foreground-muted">Select a connected environment.</Text>
          ) : (
            selectedTargets.flatMap((environment) => {
              const instances = (
                providersByEnvironment.get(environment.environmentId) ?? []
              ).filter((provider) => provider.driver === "omp");
              if (instances.length === 0) {
                return [
                  <Text key={environment.environmentId} className="text-foreground-muted">
                    {`${environment.label} has no OMP provider.`}
                  </Text>,
                ];
              }
              return instances.map((provider) => (
                <View key={`${environment.environmentId}:${provider.instanceId}`} className="gap-6">
                  <Text className="text-lg font-semibold text-foreground">
                    {`${environment.label} · ${provider.displayName ?? provider.instanceId}`}
                  </Text>
                  <OmpSettingsSummary
                    environmentId={environment.environmentId}
                    instanceId={provider.instanceId}
                  />
                  <OmpPluginsSummary
                    environmentId={environment.environmentId}
                    instanceId={provider.instanceId}
                  />
                  <OmpSkillsSummary
                    environmentId={environment.environmentId}
                    instanceId={provider.instanceId}
                  />
                  <OmpAgentDirectorySummary
                    environmentId={environment.environmentId}
                    instanceId={provider.instanceId}
                  />
                  <OmpSessionsSummary
                    environmentId={environment.environmentId}
                    instanceId={provider.instanceId}
                  />
                </View>
              ));
            })
          )}
        </ScreenScrollView>
      </SettingsScreen>
    </>
  );
}
