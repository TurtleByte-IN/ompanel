import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OmpSessionSummary,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { act, render } from "../../../test/render";

const state = vi.hoisted(() => ({
  list: vi.fn(),
  import: vi.fn(),
  createProject: vi.fn(),
  navigate: vi.fn(),
  waitForProject: vi.fn(),
  scopes: new Set<string>(),
  projects: [] as unknown[],
  providers: [] as unknown[],
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_id: unknown, scope: string) => state.scopes.has(scope)) as never,
  readEnvironmentScope: ((_id: unknown, scope: string) => state.scopes.has(scope)) as never,
}));
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => state.projects) as never,
  waitForProject: state.waitForProject as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() => new Map([[environmentId, state.providers]])) as never,
}));
vi.mock(import("~/state/use-atom-command"), async (original) => {
  const { serverEnvironment } = await import("~/state/server");
  const { projectEnvironment } = await import("~/state/projects");
  const byAtom = new Map<unknown, unknown>([
    [serverEnvironment.listOmpSessions, state.list],
    [serverEnvironment.importOmpSession, state.import],
    [projectEnvironment.create, state.createProject],
  ]);
  return {
    ...(await original()),
    useAtomCommand: ((atom: unknown) => byAtom.get(atom)) as never,
  };
});

import { ContinueOmpSessionDialog } from "./ContinueOmpSessionDialog";

const environmentId = EnvironmentId.make("remote-device");
const instanceId = ProviderInstanceId.make("omp");
const projectId = ProjectId.make("project-omp");
const workspaceRoot = "/workspace/omp";
const worktree = "/worktrees/omp-feature";
const sessionsDirectory = "/home/.omp/agent/sessions";
const existingThread = ThreadId.make("thread-existing");
const importedThread = ThreadId.make("thread-imported");

function session(overrides: Partial<OmpSessionSummary>): OmpSessionSummary {
  return {
    sessionId: "omp-session",
    cwd: workspaceRoot,
    title: null,
    firstMessage: null,
    createdAt: "2026-10-25T00:00:00.000Z",
    updatedAt: "2026-10-26T00:00:00.000Z",
    importedThreadId: null,
    projectId,
    worktreePath: null,
    branch: null,
    ...overrides,
  };
}

const projectSessions = [
  session({
    sessionId: "done",
    firstMessage: "Already a thread",
    importedThreadId: existingThread,
  }),
  session({ sessionId: "fresh", firstMessage: "Fix the flaky test" }),
  session({
    sessionId: "feature",
    title: "Feature work",
    cwd: `${worktree}/src`,
    worktreePath: worktree,
    branch: "feature",
  }),
];

function listed(sessions: ReadonlyArray<OmpSessionSummary>) {
  return {
    _tag: "Success",
    value: { sessions, searchedDirectories: [workspaceRoot, worktree], sessionsDirectory },
  };
}

function setup() {
  state.scopes = new Set(["orchestration:read", "orchestration:operate"]);
  state.projects = [{ environmentId, id: projectId, title: "OMP", workspaceRoot }];
  state.providers = [{ instanceId, driver: ProviderDriverKind.make("omp"), enabled: true }];
  state.list.mockReset().mockResolvedValue(listed(projectSessions));
  state.import.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { threadId: importedThread, imported: true },
  });
  state.createProject.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.waitForProject.mockReset().mockResolvedValue(undefined);
  state.navigate.mockReset().mockResolvedValue(undefined);
}

async function renderDialog() {
  const onClose = vi.fn();
  const screen = await render(
    <ContinueOmpSessionDialog request={{ environmentId, projectId }} onClose={onClose} />,
  );
  return Object.assign(screen, { onClose });
}

/** The action button on the row showing `text`. */
async function rowButton(text: string) {
  await expect.element(page.getByText(text)).toBeInTheDocument();
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.parentElement?.textContent?.includes(text),
  );
  expect(button, `button for ${text}`).toBeDefined();
  return button!;
}

const click = (element: HTMLElement) => act(async () => element.click());

function expectOpened(threadId: ThreadId) {
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/$environmentId/$threadId",
    params: { environmentId, threadId },
  });
}

it("lists the project's sessions, worktrees included, and continues one in its thread", async () => {
  setup();
  await using screen = await renderDialog();
  await expect.element(page.getByText(`${worktree}/src (feature)`)).toBeInTheDocument();
  expect(state.list).toHaveBeenCalledWith({
    environmentId,
    input: { instanceId, scope: "project", projectId },
  });
  const button = await rowButton("Fix the flaky test");
  expect(button.textContent).toBe("Continue");
  await click(button);
  expect(state.import).toHaveBeenCalledWith({
    environmentId,
    input: { instanceId, sessionId: "fresh" },
  });
  expectOpened(importedThread);
  expect(screen.onClose).toHaveBeenCalled();
});

it("opens an already-imported session's thread without importing it again", async () => {
  setup();
  await using _screen = await renderDialog();
  const button = await rowButton("Already a thread");
  expect(button.textContent).toBe("Open");
  await click(button);
  expect(state.import).not.toHaveBeenCalled();
  expectOpened(existingThread);
});

it("names the folders and sessions directory it searched when it finds nothing", async () => {
  setup();
  state.list.mockResolvedValue(listed([]));
  await using _screen = await renderDialog();
  await expect.element(page.getByText("No OMP sessions were found.")).toBeInTheDocument();
  await expect.element(page.getByText(workspaceRoot, { exact: true })).toBeInTheDocument();
  await expect.element(page.getByText(worktree, { exact: true })).toBeInTheDocument();
  await expect.element(page.getByText(sessionsDirectory, { exact: true })).toBeInTheDocument();
});

it("shows every folder's sessions and adds a missing project before continuing", async () => {
  setup();
  const elsewhere = "/elsewhere/tool";
  await using _screen = await renderDialog();
  await rowButton("Fix the flaky test");
  state.list.mockResolvedValue(
    listed([
      session({
        sessionId: "orphan",
        cwd: elsewhere,
        firstMessage: "Loose session",
        projectId: null,
      }),
    ]),
  );
  await click(page.getByRole("switch").element() as HTMLElement);
  const button = await rowButton("Loose session");
  expect(state.list).toHaveBeenLastCalledWith({
    environmentId,
    input: { instanceId, scope: "all", projectId },
  });
  expect(button.parentElement?.textContent).toContain("No project");
  expect(button.textContent).toBe("Add project and continue");
  await click(button);
  expect(state.createProject).toHaveBeenCalledWith({
    environmentId,
    input: expect.objectContaining({
      workspaceRoot: elsewhere,
      createWorkspaceRootIfMissing: false,
    }),
  });
  expect(state.import).toHaveBeenCalledWith({
    environmentId,
    input: { instanceId, sessionId: "orphan" },
  });
  expectOpened(importedThread);
});

it("does not import without task access", async () => {
  setup();
  state.scopes.delete("orchestration:operate");
  await using _screen = await renderDialog();
  const button = await rowButton("Fix the flaky test");
  expect(button.disabled).toBe(true);
  await click(button);
  expect(state.import).not.toHaveBeenCalled();
  expect((await rowButton("Already a thread")).disabled).toBe(false);
});
