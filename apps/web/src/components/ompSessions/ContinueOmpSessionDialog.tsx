import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type OmpListSessionsResult,
  type OmpSessionSummary,
  type ProjectId,
  type ProviderInstanceId,
  type ScopedProjectRef,
  type ServerProvider,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useId, useState } from "react";

import { inferProjectTitleFromPath } from "~/lib/projectPaths";
import { newProjectId } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProjects, waitForProject } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { projectEnvironment } from "~/state/projects";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { buildThreadRouteParams } from "~/threadRoutes";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";

export const CONTINUE_OMP_SESSION_LABEL = "Continue an OMP session…";

export interface ContinueOmpSessionRequest {
  readonly environmentId: EnvironmentId;
  /** The project listed first; the environment's first project when null. */
  readonly projectId: ProjectId | null;
  /** The OMP instance listed first; the first enabled one when absent. */
  readonly instanceId?: ProviderInstanceId;
}

// Hosted at the root so the sidebar, command palette and settings all open the same dialog.
const continueOmpSessionRequestAtom = Atom.make<ContinueOmpSessionRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("omp-sessions:continue-dialog"),
);

export function openContinueOmpSessionDialog(request: ContinueOmpSessionRequest): void {
  appAtomRegistry.set(continueOmpSessionRequestAtom, request);
}

/** The environment's OMP provider instances, enabled ones first. */
export function ompProviderInstances(
  providers: ReadonlyArray<ServerProvider> | undefined,
): ReadonlyArray<ServerProvider> {
  const omp = (providers ?? []).filter((provider) => provider.driver === "omp");
  return [...omp.filter((provider) => provider.enabled), ...omp.filter((p) => !p.enabled)];
}

/**
 * The dialog request for the first of `projectRefs` whose environment runs OMP, or for
 * `fallbackEnvironmentId` with no project. Null when none of them runs OMP, which hides the entry.
 */
export function resolveContinueOmpSessionRequest(
  providersByEnvironment: ReadonlyMap<EnvironmentId, ReadonlyArray<ServerProvider>>,
  projectRefs: ReadonlyArray<ScopedProjectRef | null>,
  fallbackEnvironmentId: EnvironmentId | null,
): ContinueOmpSessionRequest | null {
  const runsOmp = (environmentId: EnvironmentId) =>
    ompProviderInstances(providersByEnvironment.get(environmentId)).length > 0;
  for (const projectRef of projectRefs) {
    if (projectRef !== null && runsOmp(projectRef.environmentId)) {
      return { environmentId: projectRef.environmentId, projectId: projectRef.projectId };
    }
  }
  return fallbackEnvironmentId !== null && runsOmp(fallbackEnvironmentId)
    ? { environmentId: fallbackEnvironmentId, projectId: null }
    : null;
}

export function useContinueOmpSessionRequest(
  projectRefs: ReadonlyArray<ScopedProjectRef | null>,
  fallbackEnvironmentId: EnvironmentId | null,
): ContinueOmpSessionRequest | null {
  return resolveContinueOmpSessionRequest(
    useEnvironmentProviders(),
    projectRefs,
    fallbackEnvironmentId,
  );
}

/** `useContinueOmpSessionRequest` for event handlers, such as a context menu being built. */
export function readContinueOmpSessionRequest(
  projectRefs: ReadonlyArray<ScopedProjectRef | null>,
): ContinueOmpSessionRequest | null {
  return resolveContinueOmpSessionRequest(
    appAtomRegistry.get(environmentPresentations.providersByEnvironmentAtom),
    projectRefs,
    null,
  );
}

export function ContinueOmpSessionDialogHost() {
  const request = useAtomValue(continueOmpSessionRequestAtom);
  if (request === null) return null;
  return (
    <ContinueOmpSessionDialog
      request={request}
      onClose={() => appAtomRegistry.set(continueOmpSessionRequestAtom, null)}
    />
  );
}

type SessionsRead =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly value: OmpListSessionsResult }
  | { readonly status: "error"; readonly message: string };

function failureMessage(
  failure: Parameters<typeof squashAtomCommandFailure>[0],
  fallback: string,
): string {
  const error = squashAtomCommandFailure(failure);
  return error instanceof Error ? error.message : fallback;
}

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  toastManager.add({
    type: "error",
    title,
    description: failureMessage(result, "The OMP request failed."),
  });
}

function formatUpdatedAt(updatedAt: string): string {
  const date = new Date(updatedAt);
  return Number.isNaN(date.getTime()) ? updatedAt : date.toLocaleString();
}

/** Lists the OMP sessions saved for a project (or every folder) and continues one as a thread. */
export function ContinueOmpSessionDialog(props: {
  readonly request: ContinueOmpSessionRequest;
  readonly onClose: () => void;
}) {
  const { environmentId } = props.request;
  const id = useId();
  const navigate = useNavigate();
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const instances = ompProviderInstances(useEnvironmentProviders().get(environmentId));
  const allProjects = useProjects();
  const projects = allProjects.filter((project) => project.environmentId === environmentId);
  const [pickedInstanceId, setPickedInstanceId] = useState(props.request.instanceId ?? null);
  const instanceId =
    instances.find((instance) => instance.instanceId === pickedInstanceId)?.instanceId ??
    instances[0]?.instanceId ??
    null;
  const [pickedProjectId, setPickedProjectId] = useState(props.request.projectId);
  const project =
    projects.find((candidate) => candidate.id === pickedProjectId) ?? projects[0] ?? null;
  const [showAll, setShowAll] = useState(false);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const listSessions = useAtomCommand(serverEnvironment.listOmpSessions, { reportFailure: false });
  const importSession = useAtomCommand(serverEnvironment.importOmpSession, {
    reportFailure: false,
  });
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });

  const projectId = project?.id ?? null;
  const canList = canRead && instanceId !== null && (showAll || projectId !== null);
  const listKey = `${instanceId}:${showAll ? "all" : projectId}`;
  // Keyed by what was listed, so a switch shows loading until that list settles.
  const [settled, setSettled] = useState<{ key: string; read: SessionsRead } | null>(null);
  const read: SessionsRead =
    settled !== null && settled.key === listKey ? settled.read : { status: "loading" };

  // oxlint-disable-next-line t3code/react-effect-budget -- reads the session list from the server whenever what is listed changes
  useEffect(() => {
    if (!canList || instanceId === null) return;
    let cancelled = false;
    void listSessions({
      environmentId,
      input: {
        instanceId,
        scope: showAll ? "all" : "project",
        ...(projectId === null ? {} : { projectId }),
      },
    }).then((result) => {
      if (cancelled || isAtomCommandInterrupted(result)) return;
      setSettled({
        key: listKey,
        read:
          result._tag === "Success"
            ? { status: "ok", value: result.value }
            : { status: "error", message: failureMessage(result, "Could not list OMP sessions.") },
      });
    });
    return () => {
      cancelled = true;
    };
  }, [canList, environmentId, instanceId, listKey, listSessions, projectId, showAll]);

  const openThread = async (threadId: ThreadId) => {
    props.onClose();
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(environmentId, threadId)),
    });
  };

  const continueSession = async (session: OmpSessionSummary) => {
    if (busySessionId !== null) return;
    if (session.importedThreadId !== null) {
      await openThread(session.importedThreadId);
      return;
    }
    if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) || instanceId === null)
      return;
    setBusySessionId(session.sessionId);
    if (session.projectId === null) {
      // The session's folder belongs to no project: add it the way "Add project" does.
      const createdProjectId = newProjectId();
      const created = await createProject({
        environmentId,
        input: {
          projectId: createdProjectId,
          title: inferProjectTitleFromPath(session.cwd),
          workspaceRoot: session.cwd,
          createWorkspaceRootIfMissing: false,
          defaultModelSelection: null,
        },
      });
      if (created._tag === "Failure") {
        setBusySessionId(null);
        reportFailure("Could not add the session's folder as a project", created);
        return;
      }
      await waitForProject(scopeProjectRef(environmentId, createdProjectId)).catch(() => null);
    }
    const result = await importSession({
      environmentId,
      input: { instanceId, sessionId: session.sessionId },
    });
    setBusySessionId(null);
    if (result._tag === "Failure") {
      reportFailure("Could not continue the OMP session", result);
      return;
    }
    await openThread(result.value.threadId);
  };

  const projectTitle = (sessionProjectId: ProjectId | null) =>
    allProjects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === sessionProjectId,
    )?.title ?? null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && busySessionId === null) props.onClose();
      }}
    >
      <DialogPopup className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Continue an OMP session</DialogTitle>
          <DialogDescription>
            Pick a session OMP saved, in a terminal or elsewhere, to continue it as a thread.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <Label htmlFor={`${id}-project`}>Project</Label>
              <Select
                value={projectId ?? ""}
                disabled={showAll || projects.length === 0}
                onValueChange={(value) => {
                  if (value !== null && value !== "") setPickedProjectId(value as ProjectId);
                }}
              >
                <SelectTrigger id={`${id}-project`} aria-label="Project" className="w-44" size="sm">
                  <SelectValue>{project?.title ?? "No projects"}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {projects.map((candidate) => (
                    <SelectItem key={candidate.id} value={candidate.id}>
                      {candidate.title}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {instances.length > 1 ? (
              <div className="flex items-center gap-2">
                <Label htmlFor={`${id}-instance`}>OMP</Label>
                <Select
                  value={instanceId ?? ""}
                  onValueChange={(value) => {
                    if (value !== null && value !== "") {
                      setPickedInstanceId(value as ProviderInstanceId);
                    }
                  }}
                >
                  <SelectTrigger
                    id={`${id}-instance`}
                    aria-label="OMP instance"
                    className="w-40"
                    size="sm"
                  >
                    <SelectValue>
                      {instances.find((instance) => instance.instanceId === instanceId)
                        ?.displayName ?? instanceId}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup>
                    {instances.map((instance) => (
                      <SelectItem key={instance.instanceId} value={instance.instanceId}>
                        {instance.displayName ?? instance.instanceId}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            <div className="ml-auto flex items-center gap-2">
              <Switch
                id={`${id}-all`}
                size="sm"
                checked={showAll}
                onCheckedChange={(checked) => setShowAll(Boolean(checked))}
              />
              <Label htmlFor={`${id}-all`}>Show all sessions</Label>
            </div>
          </div>
          <SessionList
            read={
              instanceId === null
                ? { status: "error", message: "This environment has no OMP provider." }
                : !canRead
                  ? { status: "error", message: "This connection cannot read sessions." }
                  : !canList
                    ? { status: "error", message: "Add a project, or show all sessions." }
                    : read
            }
            showAll={showAll}
            projectRoot={project?.workspaceRoot ?? null}
            canOperate={canOperate}
            busySessionId={busySessionId}
            projectTitle={projectTitle}
            onContinue={(session) => void continueSession(session)}
          />
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function SessionList(props: {
  readonly read: SessionsRead;
  readonly showAll: boolean;
  readonly projectRoot: string | null;
  readonly canOperate: boolean;
  readonly busySessionId: string | null;
  readonly projectTitle: (projectId: ProjectId | null) => string | null;
  readonly onContinue: (session: OmpSessionSummary) => void;
}) {
  const { read } = props;
  if (read.status === "loading") {
    return <p className="text-muted-foreground text-xs">Reading OMP sessions…</p>;
  }
  if (read.status === "error") {
    return (
      <p role="alert" className="text-muted-foreground text-xs">
        {read.message}
      </p>
    );
  }
  const { sessions, searchedDirectories, sessionsDirectory } = read.value;
  if (sessions.length === 0) {
    return (
      <div className="flex flex-col gap-1 text-muted-foreground text-xs">
        <p>No OMP sessions were found.</p>
        {searchedDirectories.length > 0 ? (
          <>
            <p>Folders searched:</p>
            <ul className="flex flex-col gap-0.5 pl-3">
              {searchedDirectories.map((directory) => (
                <li key={directory}>
                  <code className="break-all">{directory}</code>
                </li>
              ))}
            </ul>
          </>
        ) : null}
        <p>
          OMP sessions directory: <code className="break-all">{sessionsDirectory}</code>
        </p>
      </div>
    );
  }
  return (
    <div className="-mx-1 max-h-[55vh] divide-y divide-border/60 overflow-y-auto border-border/60 border-y">
      {sessions.map((session) => {
        const projectTitle = props.projectTitle(session.projectId);
        const folder =
          session.worktreePath !== null
            ? `${session.cwd}${session.branch === null ? "" : ` (${session.branch})`}`
            : session.cwd !== props.projectRoot
              ? session.cwd
              : null;
        const imported = session.importedThreadId !== null;
        const busy = props.busySessionId === session.sessionId;
        return (
          <div
            key={session.sessionId}
            className="flex min-w-0 items-center justify-between gap-3 px-1 py-2"
          >
            <div className="min-w-0">
              <p className="truncate text-foreground text-xs">
                {session.title ?? session.firstMessage ?? session.sessionId}
              </p>
              <p className="truncate text-3xs text-muted-foreground">
                Updated {formatUpdatedAt(session.updatedAt)}
                {props.showAll ? ` · ${projectTitle ?? "No project"}` : ""}
                {folder === null ? null : (
                  <>
                    {" · "}
                    <code title={folder}>{folder}</code>
                  </>
                )}
              </p>
            </div>
            <Button
              type="button"
              size="xs"
              variant={imported ? "ghost-muted" : "outline"}
              className="shrink-0"
              disabled={props.busySessionId !== null || (!imported && !props.canOperate)}
              onClick={() => props.onContinue(session)}
            >
              {imported
                ? "Open"
                : busy
                  ? "Continuing…"
                  : session.projectId === null
                    ? "Add project and continue"
                    : "Continue"}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
