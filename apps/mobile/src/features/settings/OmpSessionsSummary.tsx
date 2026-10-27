// Settings → OMP sessions on mobile: the sessions OMP saved for a project, read-only, as the web
// import list shows them (apps/web/src/components/settings/OmpSessionImportSection.tsx, same
// `server.listOmpSessions` RPC). Importing creates a thread, so it stays on web and desktop.
import type {
  EnvironmentId,
  OmpListSessionsResult,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useProjects } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { OmpSummaryNote, OmpSummaryRow } from "./OmpSummaryParts";
import { OMP_READ_LOADING, settleOmpRead, type OmpRead } from "./useOmpInstanceRead";

const FAILED_TEXT = "Could not list OMP sessions.";

export interface OmpSessionsProject {
  readonly id: ProjectId;
  readonly title: string;
}

function formatUpdatedAt(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime()) ? updatedAt : date.toLocaleString();
}

/** The sessions OMP saved for the picked project; the project chips only choose what is listed. */
export function OmpSessionsSummaryView(props: {
  readonly projects: ReadonlyArray<OmpSessionsProject>;
  readonly projectId: ProjectId | null;
  readonly onSelectProject: (projectId: ProjectId) => void;
  readonly read: OmpRead<OmpListSessionsResult>;
}) {
  const { read } = props;
  return (
    <SettingsSection
      title="OMP sessions"
      footer="Sessions OMP saved for a project, newest first. Import one as a thread on web or desktop."
    >
      {props.projects.length === 0 ? (
        <OmpSummaryNote>Add a project to see its OMP sessions.</OmpSummaryNote>
      ) : (
        <>
          <View
            accessibilityLabel="Project for OMP sessions"
            className="flex-row flex-wrap gap-2 px-4 py-3"
          >
            {props.projects.map((project) => {
              const selected = project.id === props.projectId;
              return (
                <Pressable
                  key={project.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => props.onSelectProject(project.id)}
                  className={
                    selected
                      ? "rounded-full bg-subtle-strong px-3 py-1.5"
                      : "rounded-full border border-border-subtle px-3 py-1.5"
                  }
                >
                  <Text className="text-sm text-foreground">{project.title}</Text>
                </Pressable>
              );
            })}
          </View>
          {read.status === "loading" ? (
            <OmpSummaryNote>Reading OMP sessions…</OmpSummaryNote>
          ) : read.status === "error" ? (
            <OmpSummaryNote tone="error">{read.message}</OmpSummaryNote>
          ) : read.value.sessions.length === 0 ? (
            <OmpSummaryNote>No OMP sessions for this project.</OmpSummaryNote>
          ) : (
            read.value.sessions.map((session) => (
              <OmpSummaryRow
                key={session.sessionId}
                title={session.title ?? session.firstMessage ?? session.sessionId}
                meta={`Updated ${formatUpdatedAt(session.updatedAt)}${
                  session.importedThreadId === null ? "" : " · Already a thread"
                }`}
                code={session.sessionId}
              />
            ))
          )}
        </>
      )}
    </SettingsSection>
  );
}

/** Lists one project's OMP sessions at a time for one instance, re-reading on project change. */
export function OmpSessionsSummary(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const { environmentId, instanceId } = props;
  const listSessions = useAtomCommand(serverEnvironment.listOmpSessions, { reportFailure: false });
  const allProjects = useProjects();
  const projects: OmpSessionsProject[] = [];
  for (const project of allProjects) {
    if (project.environmentId === environmentId && project.isScratch !== true) {
      projects.push({ id: project.id, title: project.title });
    }
  }
  const [picked, setPicked] = useState<ProjectId | null>(null);
  const projectId =
    projects.find((project) => project.id === picked)?.id ?? projects[0]?.id ?? null;
  // Keyed by project, so a switch shows loading until that project's list settles.
  const [settled, setSettled] = useState<{
    readonly projectId: ProjectId;
    readonly read: OmpRead<OmpListSessionsResult>;
  } | null>(null);

  useEffect(() => {
    if (projectId === null) return;
    let cancelled = false;
    void listSessions({ environmentId, input: { instanceId, projectId } }).then((result) => {
      const read = settleOmpRead(result, FAILED_TEXT);
      if (!cancelled && read !== null) setSettled({ projectId, read });
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, projectId, listSessions]);

  return (
    <OmpSessionsSummaryView
      projects={projects}
      projectId={projectId}
      onSelectProject={setPicked}
      read={settled !== null && settled.projectId === projectId ? settled.read : OMP_READ_LOADING}
    />
  );
}
