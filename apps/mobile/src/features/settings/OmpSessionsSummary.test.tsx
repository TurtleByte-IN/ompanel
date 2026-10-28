import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OmpSessionSummary,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  listSessions: vi.fn(),
  projects: [] as Array<{
    environmentId: string;
    id: string;
    title: string;
    isScratch?: true;
  }>,
}));

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
  Pressable: ({
    children,
    accessibilityRole,
    accessibilityState,
    onPress,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
    accessibilityState?: { selected?: boolean };
    onPress?: () => void;
  }) => (
    <button role={accessibilityRole} aria-checked={accessibilityState?.selected} onClick={onPress}>
      {children}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({
    children,
    accessibilityRole,
  }: {
    children?: ReactNode;
    accessibilityRole?: string;
  }) => <span role={accessibilityRole}>{children}</span>,
}));
vi.mock("../../state/entities", () => ({ useProjects: () => mocks.projects }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => mocks.listSessions }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: (props: { title: string; footer?: string; children?: ReactNode }) => (
    <section aria-label={props.title}>
      {props.children}
      <footer>{props.footer}</footer>
    </section>
  ),
}));

import { OmpSessionsSummary, OmpSessionsSummaryView } from "./OmpSessionsSummary";

const environmentId = EnvironmentId.make("env-1");
const instanceId = ProviderInstanceId.make("omp");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

function session(overrides: Partial<OmpSessionSummary> = {}): OmpSessionSummary {
  return {
    sessionId: "s-1",
    cwd: "/work/a",
    title: null,
    firstMessage: null,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "not a date",
    importedThreadId: null,
    projectId: null,
    worktreePath: null,
    branch: null,
    ...overrides,
  };
}

const listed = { searchedDirectories: ["/work/a"], sessionsDirectory: "/home/.omp/agent/sessions" };

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.listSessions.mockReset();
  mocks.projects = [];
});

afterEach(() => {
  act(() => root.unmount());
});

const rows = () =>
  Array.from(container.querySelectorAll("section div[aria-label]"), (row) =>
    row.getAttribute("aria-label"),
  ).filter((label) => label !== "Project for OMP sessions");

const projects = [
  { id: projectA, title: "Alpha" },
  { id: projectB, title: "Beta" },
];

describe("OmpSessionsSummaryView", () => {
  it("lists a project's sessions with no import action", () => {
    act(() =>
      root.render(
        <OmpSessionsSummaryView
          projects={projects}
          projectId={projectA}
          onSelectProject={() => {}}
          read={{
            status: "ok",
            value: {
              sessions: [
                session({ sessionId: "s-1", title: "Fix the build" }),
                session({
                  sessionId: "s-2",
                  firstMessage: "hello there",
                  importedThreadId: ThreadId.make("thread-1"),
                }),
                session({ sessionId: "s-3" }),
              ],
              ...listed,
            },
          }}
        />,
      ),
    );
    expect(rows()).toEqual([
      "Fix the build. Updated not a date. s-1",
      "hello there. Updated not a date · Already a thread. s-2",
      "s-3. Updated not a date. s-3",
    ]);
    // The only buttons pick which project is listed.
    expect(
      Array.from(container.querySelectorAll("button"), (button) => [
        button.getAttribute("role"),
        button.textContent,
        button.getAttribute("aria-checked"),
      ]),
    ).toEqual([
      ["radio", "Alpha", "true"],
      ["radio", "Beta", "false"],
    ]);
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector("footer")?.textContent).toContain("on web or desktop");
  });

  it("shows no-project, empty, loading and failed states", () => {
    const render = (props: Partial<Parameters<typeof OmpSessionsSummaryView>[0]>) =>
      act(() =>
        root.render(
          <OmpSessionsSummaryView
            projects={projects}
            projectId={projectA}
            onSelectProject={() => {}}
            read={{ status: "loading" }}
            {...props}
          />,
        ),
      );
    render({ projects: [], projectId: null });
    expect(container.textContent).toContain("Add a project to see its OMP sessions.");
    render({ read: { status: "ok", value: { ...listed, sessions: [] } } });
    expect(container.textContent).toContain("No OMP sessions for this project.");
    render({});
    expect(container.textContent).toContain("Reading OMP sessions…");
    render({ read: { status: "error", message: "OMP is unavailable." } });
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("OMP is unavailable.");
  });
});

describe("OmpSessionsSummary", () => {
  it("lists the first project of this environment, then the one picked", async () => {
    mocks.projects = [
      { environmentId: "other", id: "project-z", title: "Elsewhere" },
      { environmentId, id: "scratch", title: "Scratch", isScratch: true },
      { environmentId, id: projectA, title: "Alpha" },
      { environmentId, id: projectB, title: "Beta" },
    ];
    mocks.listSessions.mockImplementation(async (target: { input: { projectId: string } }) => ({
      _tag: "Success",
      value: {
        ...listed,
        sessions: [session({ sessionId: `in-${target.input.projectId}`, title: "Saved" })],
      },
    }));
    await act(async () =>
      root.render(<OmpSessionsSummary environmentId={environmentId} instanceId={instanceId} />),
    );
    expect(Array.from(container.querySelectorAll("button"), (b) => b.textContent)).toEqual([
      "Alpha",
      "Beta",
    ]);
    expect(mocks.listSessions).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, projectId: projectA },
    });
    expect(rows()).toEqual(["Saved. Updated not a date. in-project-a"]);

    await act(async () => container.querySelectorAll("button")[1]!.click());
    expect(mocks.listSessions).toHaveBeenLastCalledWith({
      environmentId,
      input: { instanceId, projectId: projectB },
    });
    expect(rows()).toEqual(["Saved. Updated not a date. in-project-b"]);
  });
});
