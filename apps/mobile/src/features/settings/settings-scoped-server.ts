import {
  isNullableProjectSettingsOverride,
  PROJECT_SCOPED_SERVER_SETTING_KEYS,
  type EnvironmentId,
  type ProjectId,
  type ProjectScopedServerSettingKey,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  clearProjectSettingsOverrides,
  resolveProjectSettings,
} from "@t3tools/shared/projectSettings";

import type { SettingsTarget } from "./settings-environment-filter";

export interface ScopedMobileSettingsTarget {
  readonly environment: SettingsTarget;
  readonly projectId: ProjectId | null;
  readonly settings: ServerSettings;
  readonly sources: ReturnType<typeof resolveProjectSettings>["sources"];
}

export function resolveMobileSettingsTargets(
  environments: readonly SettingsTarget[],
  members: readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[] | null,
): readonly ScopedMobileSettingsTarget[] {
  if (members === null) {
    return environments.map((environment) => ({
      environment,
      projectId: null,
      ...resolveProjectSettings(environment.serverConfig.settings, null),
    }));
  }
  const byId = new Map(environments.map((environment) => [environment.environmentId, environment]));
  return members.flatMap((member) => {
    const environment = byId.get(member.environmentId);
    if (!environment) return [];
    return [
      {
        environment,
        projectId: member.id,
        ...resolveProjectSettings(environment.serverConfig.settings, member.id),
      },
    ];
  });
}

export function planMobileScopedSettingsPatch(
  targets: readonly ScopedMobileSettingsTarget[],
  projectSelected: boolean,
  patch: ServerSettingsPatch,
) {
  if (!projectSelected) {
    return targets.map((target) => ({ environmentId: target.environment.environmentId, patch }));
  }
  const keys = Object.keys(patch);
  if (
    keys.some(
      (key) => !PROJECT_SCOPED_SERVER_SETTING_KEYS.includes(key as ProjectScopedServerSettingKey),
    )
  )
    return [];
  const writes = new Map<EnvironmentId, ServerSettingsPatch>();
  for (const target of targets) {
    if (
      target.projectId === null ||
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides !== true
    )
      continue;
    // A server that advertises it keeps the stored trust on whole-entry writes and takes trust
    // only through its own field; an older one reads trust from the entry.
    const dedicatedTrust =
      target.environment.serverConfig.environment.capabilities.projectAgentConfigTrust === true;
    const { trustProjectAgentConfig, ...patchWithoutTrust } = patch;
    const entryValues = dedicatedTrust ? patchWithoutTrust : patch;
    const previous = writes.get(target.environment.environmentId);
    const entries: Record<string, unknown> = { ...previous?.projectSettingsOverrides };
    if (Object.keys(entryValues).length > 0) {
      const current =
        target.environment.serverConfig.settings.projectSettingsOverrides[target.projectId] ?? {};
      const next: Record<string, unknown> = { ...current };
      for (const [key, value] of Object.entries(entryValues)) {
        if (
          value === null &&
          !isNullableProjectSettingsOverride(key as ProjectScopedServerSettingKey)
        ) {
          delete next[key];
        } else {
          next[key] = value;
        }
      }
      entries[target.projectId] = next;
    }
    const trust =
      !dedicatedTrust || trustProjectAgentConfig === undefined
        ? previous?.projectAgentConfigTrust
        : { ...previous?.projectAgentConfigTrust, [target.projectId]: trustProjectAgentConfig };
    writes.set(target.environment.environmentId, {
      ...(Object.keys(entries).length > 0
        ? { projectSettingsOverrides: entries as ServerSettingsPatch["projectSettingsOverrides"] }
        : {}),
      ...(trust === undefined ? {} : { projectAgentConfigTrust: trust }),
    });
  }
  return [...writes].map(([environmentId, writePatch]) => ({ environmentId, patch: writePatch }));
}

export function uniformMobileSetting<K extends keyof ServerSettings>(
  targets: readonly Pick<ScopedMobileSettingsTarget, "settings">[],
  key: K,
): ServerSettings[K] | null {
  const reference = targets[0];
  if (!reference) return null;
  const value = reference.settings[key];
  return targets.every((target) => target.settings[key] === value) ? value : null;
}

export function planMobileScopedSettingsClear(
  targets: readonly ScopedMobileSettingsTarget[],
  keys: readonly ProjectScopedServerSettingKey[],
) {
  const writes = new Map<EnvironmentId, ServerSettingsPatch>();
  for (const target of targets) {
    if (
      target.projectId === null ||
      target.environment.serverConfig.environment.capabilities.projectSettingsOverrides !== true
    )
      continue;
    const previous = writes.get(target.environment.environmentId);
    const entries: Record<string, unknown> = {
      ...previous?.projectSettingsOverrides,
      [target.projectId]: clearProjectSettingsOverrides(
        target.environment.serverConfig.settings,
        target.projectId,
        keys,
      ),
    };
    writes.set(target.environment.environmentId, {
      projectSettingsOverrides: entries as ServerSettingsPatch["projectSettingsOverrides"],
      ...(keys.includes("trustProjectAgentConfig") &&
      target.environment.serverConfig.environment.capabilities.projectAgentConfigTrust === true
        ? {
            projectAgentConfigTrust: {
              ...previous?.projectAgentConfigTrust,
              [target.projectId]: false,
            },
          }
        : previous?.projectAgentConfigTrust === undefined
          ? {}
          : { projectAgentConfigTrust: previous.projectAgentConfigTrust }),
    });
  }
  return [...writes].map(([environmentId, writePatch]) => ({ environmentId, patch: writePatch }));
}
