import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  keys: [] as ReadonlyArray<string>,
  stopSession: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: { label: string; disabled?: boolean; onPress?: () => void }) => (
    <button type="button" disabled={props.disabled} onClick={props.onPress}>
      {props.label}
    </button>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../state/entities", () => ({
  useThreadRestartRequiredSettings: () => state.keys,
}));
vi.mock("../../state/threads", () => ({ threadEnvironment: { stopSession: "stopSession" } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => state.stopSession }));

import { RestartRequiredCard } from "./RestartRequiredCard";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.stopSession.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function renderCard(working = false) {
  act(() =>
    root.render(<RestartRequiredCard threadRef={threadRef} canOperateThread working={working} />),
  );
}

function restartButton() {
  return Array.from(container.querySelectorAll("button")).find(
    (button) => button.textContent === "Restart",
  );
}

it("offers a restart for launch-only settings and stops the session", async () => {
  state.keys = ["memory.backend"];
  renderCard();
  expect(container.textContent).toContain("Restart to apply memory.backend");
  await act(async () => restartButton()!.click());
  expect(state.stopSession).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { threadId: threadRef.threadId },
  });

  // The replacement session starts without the marker.
  state.keys = [];
  renderCard();
  expect(container.textContent).toBe("");
});

it("holds the restart while a turn runs", () => {
  state.keys = ["memory.backend"];
  renderCard(true);
  expect(restartButton()!.disabled).toBe(true);
  expect(container.textContent).toContain("Restart after this turn.");
});
