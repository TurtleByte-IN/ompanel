import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@t3tools/contracts";
import type {
  EnvironmentId,
  OmpSessionSummary,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";

interface OmpSessionProject {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "The OMP request failed.",
  });
}

function formatUpdatedAt(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime()) ? updatedAt : date.toLocaleString();
}

/** Lists the OMP sessions saved for a project and imports one as an Ompanel thread. */
export function OmpSessionImportSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly projects: ReadonlyArray<OmpSessionProject>;
}) {
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const canRead = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const [projectId, setProjectId] = useState<ProjectId | null>(props.projects[0]?.id ?? null);
  const [sessions, setSessions] = useState<ReadonlyArray<OmpSessionSummary> | null>(null);
  const [loading, setLoading] = useState(false);
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);
  const listSessions = useAtomCommand(serverEnvironment.listOmpSessions, {
    reportFailure: false,
  });
  const importSession = useAtomCommand(serverEnvironment.importOmpSession, {
    reportFailure: false,
  });
  const pending = loading || importingSessionId !== null;

  const loadSessions = async () => {
    if (projectId === null || loading) return;
    setLoading(true);
    const result = await listSessions({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, projectId },
    });
    setLoading(false);
    if (result._tag === "Success") {
      setSessions(result.value.sessions);
      return;
    }
    reportFailure("Could not list OMP sessions", result);
  };

  const importOmpSession = async (session: OmpSessionSummary) => {
    if (
      !readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope) ||
      projectId === null ||
      importingSessionId !== null
    )
      return;
    setImportingSessionId(session.sessionId);
    const result = await importSession({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, projectId, sessionId: session.sessionId },
    });
    setImportingSessionId(null);
    if (result._tag === "Success") {
      setSessions(
        (current) =>
          current?.map((candidate) =>
            candidate.sessionId === session.sessionId
              ? { ...candidate, importedThreadId: result.value.threadId }
              : candidate,
          ) ?? null,
      );
      toastManager.add({
        type: "success",
        title: result.value.imported ? "OMP session imported" : "OMP session already imported",
      });
      return;
    }
    reportFailure("Could not import OMP session", result);
  };

  return (
    <SettingsRow
      title="OMP sessions"
      description="Continue a session OMP saved for a project as an Ompanel thread."
      status={props.projects.length === 0 ? "Add a project before importing sessions." : undefined}
      control={
        props.projects.length > 0 ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={projectId ?? ""}
              disabled={!canRead || pending}
              onValueChange={(value) => {
                if (value === null) return;
                setProjectId(value as ProjectId);
                setSessions(null);
              }}
            >
              <SelectTrigger aria-label="Project for OMP sessions" className="w-40" size="sm">
                <SelectValue>
                  {props.projects.find((project) => project.id === projectId)?.title}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup>
                {props.projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!canRead || loading || projectId === null}
              onClick={() => void loadSessions()}
            >
              {loading ? "Loading" : sessions === null ? "List sessions" : "Refresh"}
            </Button>
          </div>
        ) : null
      }
    >
      {sessions !== null && sessions.length === 0 ? (
        <p className="text-xs text-muted-foreground">No OMP sessions for this project.</p>
      ) : null}
      {sessions !== null && sessions.length > 0 ? (
        <div className="divide-y divide-border/60 border-y border-border/60">
          {sessions.map((session) => (
            <div
              key={session.sessionId}
              className="flex min-w-0 items-center justify-between gap-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate text-xs text-foreground">
                  {session.title ?? session.firstMessage ?? session.sessionId}
                </p>
                <p className="truncate text-3xs text-muted-foreground">
                  Updated {formatUpdatedAt(session.updatedAt)} · <code>{session.sessionId}</code>
                </p>
              </div>
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                className="shrink-0"
                disabled={
                  !canOperate || session.importedThreadId !== null || importingSessionId !== null
                }
                onClick={() => void importOmpSession(session)}
              >
                {session.importedThreadId !== null
                  ? "Imported"
                  : importingSessionId === session.sessionId
                    ? "Importing"
                    : "Import"}
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </SettingsRow>
  );
}
