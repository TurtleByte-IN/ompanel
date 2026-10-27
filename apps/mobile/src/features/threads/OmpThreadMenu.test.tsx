import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OmpBranchNode,
  type OmpCollabStatus,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
    accessibilityRole,
    style,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    style?: { paddingLeft?: number };
  }) => (
    <div aria-label={accessibilityLabel} role={accessibilityRole} data-indent={style?.paddingLeft}>
      {children}
    </div>
  ),
  Pressable: (props: {
    readonly children?: ReactNode;
    readonly accessibilityLabel?: string;
    readonly accessibilityRole?: string;
    readonly accessibilityState?: { readonly checked?: boolean };
    readonly disabled?: boolean;
    readonly onPress?: () => void;
  }) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel}
      role={props.accessibilityRole === "radio" ? "radio" : undefined}
      aria-checked={props.accessibilityState?.checked}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
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
vi.mock("../../components/ui/AppSymbol", () => ({ SymbolView: () => null }));
vi.mock("./CopyTextButton", () => ({
  CopyTextButton: (props: { accessibilityLabel: string; text: string }) => (
    <button type="button" aria-label={props.accessibilityLabel} data-copy={props.text}>
      Copy
    </button>
  ),
}));
const mocks = vi.hoisted(() => ({
  alert: vi.fn(),
  shareHtmlFile: vi.fn(async (_fileName: string, _html: string) => undefined),
  commands: {
    exportOmpThreadHtml: { name: "export" },
    shareOmpThreadGist: { name: "gist" },
    startOmpThreadCollab: { name: "start" },
    stopOmpThreadCollab: { name: "stop" },
    getOmpThreadCollab: { name: "status" },
    getOmpThreadBranchTree: { name: "tree" },
  },
  calls: [] as Array<{ command: string; input: unknown }>,
  results: new Map<string, (input: unknown) => Promise<unknown>>(),
  canOperate: true,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: mocks.alert }));
vi.mock("../../lib/shareHtmlFile", () => ({ shareHtmlFile: mocks.shareHtmlFile }));
vi.mock("../../state/server", () => ({ serverEnvironment: mocks.commands }));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { name: string }) => mocks.results.get(`spy:${command.name}`)!,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => undefined }));
vi.mock("../../state/entities", () => ({ useQuietThreadShell: () => null }));
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
vi.mock("../../state/session", () => ({ useEnvironmentScope: () => mocks.canOperate }));

import {
  OMP_COLLAB_REFRESH_MS,
  OmpBranchTreeView,
  OmpShareGistPanel,
  OmpShareLivePanel,
  OmpThreadMenu,
} from "./OmpThreadMenu";

const TARGET = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  instanceId: ProviderInstanceId.make("omp"),
};
const INPUT = { instanceId: TARGET.instanceId, threadId: TARGET.threadId };

const success = (value: unknown) => ({ _tag: "Success", value });
const failure = (message: string) => ({ _tag: "Failure", cause: Cause.fail(new Error(message)) });

/** Answers `command` with `respond`; every call is recorded in `mocks.calls`. */
function answer(command: string, respond: (input: unknown) => unknown) {
  mocks.results.set(`spy:${command}`, async (input) => {
    mocks.calls.push({ command, input });
    return respond(input);
  });
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  mocks.calls.length = 0;
  mocks.alert.mockClear();
  mocks.shareHtmlFile.mockClear();
  mocks.canOperate = true;
  for (const name of Object.values(mocks.commands).map((command) => command.name)) {
    answer(name, () => new Promise(() => undefined));
  }
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

const button = (label: string) =>
  Array.from(container.querySelectorAll("button")).find(
    (node) => node.textContent === label || node.getAttribute("aria-label") === label,
  ) ?? null;

async function press(label: string) {
  await act(async () => {
    button(label)!.click();
  });
}

async function mount(element: ReactNode) {
  await act(async () => root.render(element));
}

describe("OmpThreadMenu", () => {
  it("opens the goal sheet and the views", async () => {
    const onOpenGoal = vi.fn();
    const onOpenView = vi.fn();
    await mount(<OmpThreadMenu {...TARGET} onOpenGoal={onOpenGoal} onOpenView={onOpenView} />);
    await press("Goal");
    await press("Share as gist");
    await press("Share live");
    await press("Branch tree");
    expect(onOpenGoal).toHaveBeenCalledTimes(1);
    expect(onOpenView.mock.calls.map(([view]) => view)).toEqual([
      "share-gist",
      "share-live",
      "branch-tree",
    ]);
  });

  it("exports the HTML through the share sheet", async () => {
    answer("export", () => success({ fileName: "omp-session-1.html", html: "<html></html>" }));
    await mount(<OmpThreadMenu {...TARGET} onOpenGoal={vi.fn()} onOpenView={vi.fn()} />);
    await press("Export HTML");
    expect(mocks.calls).toEqual([
      { command: "export", input: { environmentId: TARGET.environmentId, input: INPUT } },
    ]);
    expect(mocks.shareHtmlFile).toHaveBeenCalledWith("omp-session-1.html", "<html></html>");
  });

  it("says why an export failed", async () => {
    answer("export", () => failure("The thread has no OMP session yet."));
    await mount(<OmpThreadMenu {...TARGET} onOpenGoal={vi.fn()} onOpenView={vi.fn()} />);
    await press("Export HTML");
    expect(mocks.shareHtmlFile).not.toHaveBeenCalled();
    expect(mocks.alert).toHaveBeenCalledWith(
      "Could not export HTML",
      "The thread has no OMP session yet.",
    );
  });

  it("keeps Export HTML and Branch tree on a read-only connection", async () => {
    mocks.canOperate = false;
    await mount(<OmpThreadMenu {...TARGET} onOpenGoal={vi.fn()} onOpenView={vi.fn()} />);
    expect(button("Export HTML")?.disabled).toBe(false);
    expect(button("Branch tree")?.disabled).toBe(false);
    expect(button("Share as gist")?.disabled).toBe(true);
    expect(button("Share live")?.disabled).toBe(true);
    expect(button("Stop sharing live")?.disabled).toBe(true);
  });

  it("stops a live share and says whether one was running", async () => {
    answer("stop", () => success({ stopped: false }));
    await mount(<OmpThreadMenu {...TARGET} onOpenGoal={vi.fn()} onOpenView={vi.fn()} />);
    await press("Stop sharing live");
    expect(mocks.alert).toHaveBeenCalledWith("No live share was running");
  });
});

describe("OmpShareGistPanel", () => {
  it("confirms with the upload warning, then shows the link to copy", async () => {
    answer("gist", () =>
      success({
        url: "https://share.example/#key",
        gistUrl: "https://gist.github.com/x",
        truncated: true,
      }),
    );
    const busy: boolean[] = [];
    await mount(
      <OmpShareGistPanel {...TARGET} onDone={vi.fn()} onBusyChange={(next) => busy.push(next)} />,
    );
    expect(container.textContent).toContain(
      "Anyone with the link can read the whole conversation, tool output included.",
    );
    // Nothing is uploaded before the user confirms.
    expect(mocks.calls).toEqual([]);
    await press("Share as gist");
    expect(mocks.calls).toEqual([
      { command: "gist", input: { environmentId: TARGET.environmentId, input: INPUT } },
    ]);
    expect(button("Copy Share link")?.getAttribute("data-copy")).toBe("https://share.example/#key");
    expect(container.textContent).toContain("Gist: https://gist.github.com/x");
    expect(container.textContent).toContain("Large content was trimmed");
    expect(button("Done")).not.toBeNull();
    // The sheet is held open only while the upload runs.
    expect(busy).toEqual([true, false]);
  });

  it("shows why the gist failed and lets the user retry", async () => {
    answer("gist", () => failure("gh is not signed in; nothing was uploaded."));
    await mount(<OmpShareGistPanel {...TARGET} onDone={vi.fn()} onBusyChange={vi.fn()} />);
    await press("Share as gist");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "gh is not signed in; nothing was uploaded.",
    );
    expect(button("Share as gist")?.disabled).toBe(false);
  });
});

const WARNING_TITLE = "This link bypasses T3 pairing";
const WARNING_BODY =
  "Anyone holding it reaches the session through OMP's collab relay, outside T3's pairing and permissions. With control access they can also send prompts, which run with this thread's permissions. Share it only with people you trust, and stop sharing when you are done.";

const ACTIVE_ROOM: OmpCollabStatus = {
  active: true,
  access: "control",
  link: "omp://join/abc",
  webLink: "https://collab.example/abc",
  participants: [
    { name: "host", role: "host" },
    { name: "Ada", role: "guest" },
  ],
};

describe("OmpShareLivePanel", () => {
  it("warns before sharing and starts with the chosen access", async () => {
    answer("status", () => success({ active: false, participants: [] }));
    answer("start", () => success(ACTIVE_ROOM));
    const busy: boolean[] = [];
    await mount(
      <OmpShareLivePanel {...TARGET} onDone={vi.fn()} onBusyChange={(next) => busy.push(next)} />,
    );
    expect(container.textContent).toContain(WARNING_TITLE);
    expect(container.textContent).toContain(WARNING_BODY);
    expect(button("View only")?.getAttribute("aria-checked")).toBe("true");
    await press("View and prompt");
    await press("Start sharing");
    expect(mocks.calls.find((call) => call.command === "start")).toEqual({
      command: "start",
      input: { environmentId: TARGET.environmentId, input: { ...INPUT, access: "control" } },
    });
    // The warning stays while the room is open, with its links and guests.
    expect(container.textContent).toContain(WARNING_TITLE);
    expect(container.textContent).toContain(WARNING_BODY);
    expect(button("Copy Browser link")?.getAttribute("data-copy")).toBe(
      "https://collab.example/abc",
    );
    expect(button("Copy omp join link")?.getAttribute("data-copy")).toBe("omp://join/abc");
    expect(container.textContent).toContain("Guests can watch and prompt. 1 guest: Ada.");
    expect(busy).toEqual([true, false]);
  });

  it("stops an active share", async () => {
    answer("status", () => success(ACTIVE_ROOM));
    answer("stop", () => success({ stopped: true }));
    await mount(<OmpShareLivePanel {...TARGET} onDone={vi.fn()} onBusyChange={vi.fn()} />);
    expect(container.textContent).toContain(WARNING_TITLE);
    await press("Stop sharing");
    expect(mocks.calls.some((call) => call.command === "stop")).toBe(true);
    expect(button("Start sharing")).not.toBeNull();
  });

  it("refreshes the room every five seconds while open", async () => {
    vi.useFakeTimers();
    answer("status", () => success({ active: false, participants: [] }));
    await mount(<OmpShareLivePanel {...TARGET} onDone={vi.fn()} onBusyChange={vi.fn()} />);
    const reads = () => mocks.calls.filter((call) => call.command === "status").length;
    expect(reads()).toBe(1);
    await act(async () => {
      vi.advanceTimersByTime(OMP_COLLAB_REFRESH_MS);
    });
    expect(reads()).toBe(2);
    act(() => root.unmount());
    root = createRoot(container);
    await act(async () => {
      vi.advanceTimersByTime(OMP_COLLAB_REFRESH_MS * 2);
    });
    expect(reads()).toBe(2);
  });

  it("shows why the room could not be read", async () => {
    answer("status", () => failure("The thread's OMP session is not running."));
    await mount(<OmpShareLivePanel {...TARGET} onDone={vi.fn()} onBusyChange={vi.fn()} />);
    expect(container.querySelector('[role="alert"]:not(div)')?.textContent).toBe(
      "The thread's OMP session is not running.",
    );
    expect(button("Start sharing")?.disabled).toBe(true);
  });
});

const node = (
  entryId: string,
  parentId: string | null,
  kind: OmpBranchNode["kind"] = "user",
): OmpBranchNode => ({
  entryId,
  parentId,
  kind,
  preview: kind === "assistant" ? "" : `${entryId} text`,
  timestamp: null,
  label: null,
});

describe("OmpBranchTreeView", () => {
  it("lists rows indented at forks, highlights the active path and marks the current leaf", async () => {
    await mount(
      <OmpBranchTreeView
        state={{
          status: "ready",
          tree: {
            nodes: [node("a", null), node("b", "a", "assistant"), node("c", "a"), node("d", "c")],
            leafId: "d",
            activePath: ["a", "c", "d"],
          },
        }}
      />,
    );
    expect(container.textContent).toContain("2 branches");
    const rows = Array.from(
      container.querySelectorAll('[aria-label="Session branches"] > div'),
    ).map((row) => [row.getAttribute("aria-label"), row.getAttribute("data-indent")]);
    expect(rows).toEqual([
      ["a text, on the active path", "0"],
      ["Reply", "16"],
      ["c text, on the active path", "16"],
      ["d text, on the active path, current", "16"],
    ]);
  });

  it("shows one branch, loading and failure", async () => {
    await mount(
      <OmpBranchTreeView
        state={{
          status: "ready",
          tree: { nodes: [node("a", null)], leafId: null, activePath: [] },
        }}
      />,
    );
    expect(container.textContent).toContain("One branch");
    await mount(<OmpBranchTreeView state={{ status: "loading" }} />);
    expect(container.textContent).toBe("Reading the session tree…");
    await mount(<OmpBranchTreeView state={{ status: "failed", message: "OMP is unavailable." }} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("OMP is unavailable.");
  });
});
