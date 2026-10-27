// Settings → OMP Plugins and Skills on mobile: read-only summaries of the web sections
// (apps/web/src/components/settings/OmpPluginsSection.tsx, OmpSkillsSection.tsx), over the same
// server RPCs. Installing, enabling, reloading and opening files stay on web and desktop.
import type {
  EnvironmentId,
  OmpPluginList,
  OmpSkillsList,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { joinMeta, OmpSummaryNote, OmpSummaryRow } from "./OmpSummaryParts";
import { useOmpInstanceRead, type OmpRead } from "./useOmpInstanceRead";

const PLUGINS_THIRD_PARTY =
  "Plugins are third-party code. Once installed and enabled, a plugin runs on this machine with your permissions in every OMP thread: its tools (which the agent calls as xd:// devices), hooks, commands, skills and MCP servers. Ompanel does not review them.";

/** Installed plugins and marketplaces of one OMP instance, read-only. */
export function OmpPluginsSummaryView(props: { readonly read: OmpRead<OmpPluginList> }) {
  const { read } = props;
  return (
    <SettingsSection
      title="Plugins"
      footer="Install, enable, uninstall, reload plugins and check for updates on web or desktop."
    >
      {read.status === "loading" ? (
        <OmpSummaryNote>Reading OMP's plugins…</OmpSummaryNote>
      ) : read.status === "error" ? (
        <OmpSummaryNote tone="error">OMP's plugins are unavailable.</OmpSummaryNote>
      ) : (
        <>
          <OmpSummaryNote tone="warning">{PLUGINS_THIRD_PARTY}</OmpSummaryNote>
          {read.value.plugins.length === 0 ? (
            <OmpSummaryNote>No plugins installed.</OmpSummaryNote>
          ) : (
            read.value.plugins.map((plugin) => (
              <OmpSummaryRow
                key={`${plugin.source}:${plugin.id}`}
                title={plugin.id}
                meta={joinMeta([
                  plugin.version,
                  plugin.source,
                  plugin.enabled ? "enabled" : "disabled",
                  plugin.shadowed && "overridden by a project install",
                ])}
                detail={plugin.description}
              />
            ))
          )}
          {read.value.marketplaces.length === 0 ? (
            <OmpSummaryNote>No marketplaces configured.</OmpSummaryNote>
          ) : (
            read.value.marketplaces.map((marketplace) => (
              <OmpSummaryRow
                key={marketplace.name}
                title={marketplace.name}
                meta="Marketplace"
                code={marketplace.source}
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

/** The skills a new thread of one OMP instance loads, read-only. */
export function OmpSkillsSummaryView(props: { readonly read: OmpRead<OmpSkillsList> }) {
  const { read } = props;
  return (
    <SettingsSection
      title="Skills"
      footer="Skills from plugins are third-party content, like the plugins themselves. A repository's own skills in .omp/skills load in its threads. Create and edit your own on web or desktop."
    >
      {read.status === "loading" ? (
        <OmpSummaryNote>Reading OMP's skills…</OmpSummaryNote>
      ) : read.status === "error" ? (
        <OmpSummaryNote tone="error">OMP's skills are unavailable.</OmpSummaryNote>
      ) : (
        <>
          {read.value.skills.length === 0 ? (
            <OmpSummaryNote>OMP found no skills.</OmpSummaryNote>
          ) : (
            read.value.skills.map((skill) => (
              <OmpSummaryRow
                key={skill.filePath}
                title={skill.name}
                meta={joinMeta([skill.source, skill.hidden && "hidden from the model"])}
                detail={skill.description}
                code={skill.filePath}
              />
            ))
          )}
          {read.value.warnings.map((warning) => (
            <OmpSummaryNote key={`${warning.skillPath}:${warning.message}`} tone="warning">
              {`${warning.skillPath}: ${warning.message}`}
            </OmpSummaryNote>
          ))}
        </>
      )}
    </SettingsSection>
  );
}

interface OmpInstanceTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

export function OmpPluginsSummary(props: OmpInstanceTarget) {
  const listPlugins = useAtomCommand(serverEnvironment.listOmpPlugins, { reportFailure: false });
  const read = useOmpInstanceRead(
    listPlugins,
    props.environmentId,
    props.instanceId,
    "OMP's plugins are unavailable.",
  );
  return <OmpPluginsSummaryView read={read} />;
}

export function OmpSkillsSummary(props: OmpInstanceTarget) {
  const listSkills = useAtomCommand(serverEnvironment.listOmpSkills, { reportFailure: false });
  const read = useOmpInstanceRead(
    listSkills,
    props.environmentId,
    props.instanceId,
    "OMP's skills are unavailable.",
  );
  return <OmpSkillsSummaryView read={read} />;
}
