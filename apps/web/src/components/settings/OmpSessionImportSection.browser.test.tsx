import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const commands = vi.hoisted(() => ({ list: vi.fn(), import: vi.fn() }));
const grants = vi.hoisted(() => ({ scopes: new Set<string>() }));

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: ((_id: unknown, scope: string) => grants.scopes.has(scope)) as never,
  readEnvironmentScope: ((_id: unknown, scope: string) => grants.scopes.has(scope)) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => {
  const { serverEnvironment } = await import("../../state/server");
  const byAtom = new Map<unknown, unknown>([
    [serverEnvironment.listOmpSessions, commands.list],
    [serverEnvironment.importOmpSession, commands.import],
  ]);
  return {
    ...(await original()),
    useAtomCommand: ((atom: unknown) => byAtom.get(atom)) as never,
  };
});

import { OmpSessionImportSection } from "./OmpSessionImportSection";

const environmentId = EnvironmentId.make("remote-device");
const instanceId = ProviderInstanceId.make("omp");
const projectId = ProjectId.make("project-omp");
const session = {
  sessionId: "omp-session-1",
  cwd: "/workspace/omp",
  title: null,
  firstMessage: "Fix the flaky test",
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
  importedThreadId: null,
} as const;

async function renderSection() {
  const screen = await render(
    <OmpSessionImportSection
      environmentId={environmentId}
      instanceId={instanceId}
      projects={[{ id: projectId, title: "OMP", workspaceRoot: session.cwd }]}
    />,
  );
  const button = (label: string) => {
    const found = [...screen.container.querySelectorAll("button")].find(
      (element) => element.textContent === label,
    );
    expect(found, `button ${label}`).toBeDefined();
    return found!;
  };
  return Object.assign(screen, {
    button,
    click: (label: string) => act(async () => button(label).click()),
  });
}

function setup() {
  grants.scopes = new Set(["orchestration:read", "orchestration:operate"]);
  commands.list.mockReset().mockResolvedValue({ _tag: "Success", value: { sessions: [session] } });
  commands.import.mockReset().mockResolvedValue({
    _tag: "Success",
    value: { threadId: ThreadId.make("thread-imported"), imported: true },
  });
}

it("lists sessions for the project and imports one", async () => {
  setup();
  await using screen = await renderSection();
  await screen.click("List sessions");
  expect(commands.list).toHaveBeenCalledWith({
    environmentId,
    input: { instanceId, projectId },
  });
  expect(screen.container.textContent).toContain("Fix the flaky test");
  await screen.click("Import");
  expect(commands.import).toHaveBeenCalledWith({
    environmentId,
    input: { instanceId, projectId, sessionId: session.sessionId },
  });
  expect(screen.button("Imported").disabled).toBe(true);
});

it("does not import without task access", async () => {
  setup();
  grants.scopes.delete("orchestration:operate");
  await using screen = await renderSection();
  await screen.click("List sessions");
  expect(screen.button("Import").disabled).toBe(true);
  await screen.click("Import");
  expect(commands.import).not.toHaveBeenCalled();
});
