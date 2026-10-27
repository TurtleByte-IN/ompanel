// While a gist upload or a live room request runs, its result (the share link) shows only in this
// sheet, so nothing may close it: hardware back (removal guard) or swipe-down. React tests compile
// the screen the way an iOS release build does (`Platform.OS` is inlined as "ios"), so this drives
// the iOS frame, which has no header back button.
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const navigation = vi.hoisted(() => ({
  goBack: vi.fn(),
  dispatch: vi.fn(),
  preventRemove: [] as boolean[],
  gestureEnabled: [] as Array<boolean | undefined>,
}));

vi.mock("@react-navigation/native", () => ({
  StackActions: { replace: (name: string, params: unknown) => ({ name, params }) },
  useNavigation: () => navigation,
  usePreventRemove: (prevent: boolean) => {
    navigation.preventRemove.push(prevent);
  },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "android", Version: 34 },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-screens", () => ({
  ScreenStack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock("../../components/ui/AndroidScreenHeader", () => ({
  AndroidSheetHeader: (props: { title: string; onBack: () => void }) => (
    <button type="button" aria-label={`Back from ${props.title}`} onClick={props.onBack} />
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ScreenContent", () => ({
  ScreenContent: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../native/StackHeader", () => ({
  nativeHeaderScrollEdgeEffects: () => undefined,
  NativeStackScreenOptions: (props: { options: { gestureEnabled?: boolean } }) => {
    if ("gestureEnabled" in props.options) {
      navigation.gestureEnabled.push(props.options.gestureEnabled);
    }
    return null;
  },
}));
vi.mock("../../native/ThemedScreenStack", () => ({
  NativeHeader: (props: { title: string }) => <h1>{props.title}</h1>,
  NativeScreen: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../layout/AdaptiveWorkspaceLayout", () => ({
  useAdaptiveWorkspaceLayout: () => ({ layout: { usesSplitView: false } }),
}));
vi.mock("./omp-thread", () => ({ useOmpThreadInstanceId: () => "omp" }));
vi.mock("./ThreadGoalPanel", () => ({ ThreadGoalPanel: () => null }));
vi.mock("./OmpThreadMenu", () => {
  const SharePanel = (props: { onBusyChange: (busy: boolean) => void }) => (
    <>
      <button type="button" aria-label="Start request" onClick={() => props.onBusyChange(true)} />
      <button type="button" aria-label="Finish request" onClick={() => props.onBusyChange(false)} />
    </>
  );
  return {
    OMP_THREAD_VIEW_TITLES: {
      menu: "OMP",
      "share-gist": "Share as gist",
      "share-live": "Share live",
      "branch-tree": "Branch tree",
    },
    OmpShareGistPanel: SharePanel,
    OmpShareLivePanel: SharePanel,
    OmpBranchTreePanel: () => null,
    OmpThreadMenu: (props: { onOpenView: (view: string) => void }) => (
      <button
        type="button"
        aria-label="Open Share live"
        onClick={() => props.onOpenView("share-live")}
      />
    ),
  };
});

import { ThreadOmpSheet } from "./ThreadOmpSheet";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  navigation.goBack.mockClear();
  navigation.preventRemove.length = 0;
  navigation.gestureEnabled.length = 0;
});

afterEach(() => {
  act(() => root.unmount());
});

const press = (label: string) =>
  act(() => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!.click());

describe("ThreadOmpSheet", () => {
  it("cannot be dismissed while a share request runs, and can again once it settles", () => {
    act(() =>
      root.render(
        <ThreadOmpSheet
          route={{ params: { environmentId: "env", threadId: "thread" } } as never}
        />,
      ),
    );
    press("Open Share live");
    expect(container.querySelector("h1")?.textContent).toBe("Share live");

    press("Start request");
    expect(navigation.preventRemove.at(-1)).toBe(true);
    expect(navigation.gestureEnabled.at(-1)).toBe(false);

    press("Finish request");
    expect(navigation.preventRemove.at(-1)).toBe(false);
    expect(navigation.gestureEnabled.at(-1)).toBe(true);
  });
});
