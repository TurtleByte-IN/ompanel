// Settings → OMP agent directory on mobile: read-only summaries of the web sections that list
// OMP's agent directory (apps/web/src/components/settings/OmpAgentFilesSection.tsx,
// OmpMcpSection.tsx, OmpCustomizationSection.tsx), from one `server.listOmpAgentFiles` read.
// Opening, creating and editing the files stays on web and desktop.
import type {
  EnvironmentId,
  OmpAgentFilesList,
  OmpCustomizationCategory,
  OmpMcpFileState,
  ProviderInstanceId,
} from "@t3tools/contracts";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { joinMeta, OmpSummaryNote, OmpSummaryRow } from "./OmpSummaryParts";
import { useOmpInstanceRead, type OmpRead } from "./useOmpInstanceRead";

const LOADING_TEXT = "Reading OMP's agent directory…";
const FAILED_TEXT = "OMP's agent directory is unavailable.";
const NOT_EDITABLE = "Not editable in Ompanel";

/** Loading and failed states every agent-directory section shares; null once the list is in. */
function readStatus(read: OmpRead<OmpAgentFilesList>) {
  if (read.status === "loading") return <OmpSummaryNote>{LOADING_TEXT}</OmpSummaryNote>;
  if (read.status === "error") return <OmpSummaryNote tone="error">{FAILED_TEXT}</OmpSummaryNote>;
  return null;
}

/** The advisor roster and custom agents in the agent directory (web: Advisor & Agents files). */
export function OmpAgentFilesSummaryView(props: { readonly read: OmpRead<OmpAgentFilesList> }) {
  const { read } = props;
  return (
    <SettingsSection
      title="Advisor & Agents files"
      footer="OMP reads the advisor roster when a thread starts. Open, create and edit these files on web or desktop."
    >
      {read.status !== "ok" ? (
        readStatus(read)
      ) : (
        <>
          <OmpSummaryNote>{`In ${read.value.agentDir}, the agent directory of this OMP profile.`}</OmpSummaryNote>
          <OmpSummaryRow
            title={read.value.watchdogFileName}
            meta={read.value.watchdogExists ? "Advisor roster" : "Advisor roster · not created yet"}
          />
          {read.value.agents.length === 0 ? (
            <OmpSummaryNote>No agents in agents/.</OmpSummaryNote>
          ) : (
            read.value.agents.map((entry) => (
              <OmpSummaryRow
                key={entry.name}
                title={entry.name}
                meta={joinMeta(["Custom agent", !entry.editable && NOT_EDITABLE])}
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

function mcpFileMeta(file: OmpMcpFileState): string {
  if (!file.exists) return "not created yet";
  if (file.problem === "invalid_json") return "Not valid JSON: OMP loads no servers from it";
  if (file.problem === "not_editable") return "Outside what Ompanel edits";
  return "MCP config file";
}

/** The MCP servers OMP starts from the agent directory's `mcp.json` and `.mcp.json`. */
export function OmpMcpSummaryView(props: { readonly read: OmpRead<OmpAgentFilesList> }) {
  const { read } = props;
  return (
    <SettingsSection
      title="MCP servers"
      footer="Ompanel's own MCP server is separate: copy its URL from the environment's menu in web or desktop Settings → Environments. Edit mcp.json on web or desktop."
    >
      {read.status !== "ok" ? (
        readStatus(read)
      ) : (
        <>
          <OmpSummaryNote>{`From mcp.json and .mcp.json in ${read.value.agentDir}. OMP starts them in every thread; arguments, headers and environment are not shown.`}</OmpSummaryNote>
          <OmpSummaryNote tone="warning">
            Each server is third-party code that runs with your permissions. Add only servers you
            trust.
          </OmpSummaryNote>
          {read.value.mcpServers.length === 0 ? (
            <OmpSummaryNote>No servers.</OmpSummaryNote>
          ) : (
            read.value.mcpServers.map((server) => (
              <OmpSummaryRow
                key={`${server.file}:${server.name}`}
                title={server.name}
                meta={joinMeta([server.transport, server.disabled && "Disabled", server.file])}
                code={server.target}
              />
            ))
          )}
          {read.value.mcpFiles.map((file) => (
            <OmpSummaryRow key={file.name} title={file.name} meta={mcpFileMeta(file)} />
          ))}
        </>
      )}
    </SettingsSection>
  );
}

/** Each kind the web Customization page lists, in its order, with where OMP loads it from. */
const CUSTOMIZATION_KINDS: ReadonlyArray<{
  readonly category: OmpCustomizationCategory;
  readonly title: string;
  readonly where: string;
}> = [
  {
    category: "skill",
    title: "Skills",
    where: "skills/<name>/SKILL.md, and managed-skills/ for skills OMP learned",
  },
  { category: "rule", title: "Rules", where: "rules/*.md and *.mdc, plus RULES.md" },
  { category: "prompt", title: "Prompt templates", where: "prompts/*.md" },
  { category: "hook", title: "Hooks", where: "hooks/pre/* and hooks/post/*" },
  {
    category: "tool",
    title: "Custom tools",
    where: "tools/*.{json,md,ts,js,sh,bash,py} and tools/<name>/index.ts",
  },
];

/** Skills, rules, prompt templates, hooks and custom tools in the agent directory. */
export function OmpCustomizationSummaryView(props: { readonly read: OmpRead<OmpAgentFilesList> }) {
  const { read } = props;
  if (read.status !== "ok") {
    return <SettingsSection title="Customization">{readStatus(read)}</SettingsSection>;
  }
  return (
    <>
      {CUSTOMIZATION_KINDS.map((kind) => {
        const entries = read.value.customization.filter(
          (entry) => entry.category === kind.category,
        );
        return (
          <SettingsSection
            key={kind.category}
            title={`Customization · ${kind.title}`}
            footer={kind.where}
          >
            {entries.length === 0 ? (
              <OmpSummaryNote>None yet.</OmpSummaryNote>
            ) : (
              entries.map((entry) => (
                <OmpSummaryRow
                  key={entry.path}
                  title={entry.path}
                  meta={entry.editable ? null : NOT_EDITABLE}
                />
              ))
            )}
          </SettingsSection>
        );
      })}
      <OmpSummaryNote>
        OMP discovers these when a thread starts. Project files in .omp/ of a repository are not
        shown. Create and edit them on web or desktop.
      </OmpSummaryNote>
    </>
  );
}

/** Reads the agent directory once and shows its three summaries. */
export function OmpAgentDirectorySummary(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const listFiles = useAtomCommand(serverEnvironment.listOmpAgentFiles, { reportFailure: false });
  const read = useOmpInstanceRead(listFiles, props.environmentId, props.instanceId, FAILED_TEXT);
  return (
    <>
      <OmpAgentFilesSummaryView read={read} />
      <OmpMcpSummaryView read={read} />
      <OmpCustomizationSummaryView read={read} />
    </>
  );
}
