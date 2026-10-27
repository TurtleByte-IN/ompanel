import type { OmpSettingsField } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({ useSafeAreaInsets: () => ({ bottom: 0 }) }));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => new Map() }));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/ScreenScrollView", () => ({ ScreenScrollView: () => null }));
vi.mock("../../state/presentation", () => ({ environmentPresentations: {} }));
vi.mock("../../state/entities", () => ({ useProjects: () => [] }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./components/SettingsEnvironmentFilterHeader", () => ({
  AndroidSettingsEnvironmentFilter: () => null,
  SettingsEnvironmentFilterHeader: () => null,
}));
vi.mock("./components/SettingsScreen", () => ({ SettingsScreen: () => null }));
vi.mock("./settings-environment-filter", () => ({ useSettingsEnvironmentFilter: () => ({}) }));
vi.mock("./components/SettingsSection", () => ({
  SettingsSection: (props: { title: string; footer: string; children?: ReactNode }) => (
    <section aria-label={props.title}>
      {props.children}
      <footer>{props.footer}</footer>
    </section>
  ),
}));

import { OmpSettingsSummaryView, ompSettingValueText } from "./SettingsOmpRouteScreen";

function field(
  overrides: Partial<OmpSettingsField> & Pick<OmpSettingsField, "key">,
): OmpSettingsField {
  return {
    group: overrides.key.split(".")[0]!,
    type: "string",
    description: "",
    source: "default",
    redacted: false,
    credential: false,
    readOnly: false,
    launchScoped: false,
    threadOverride: "none",
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("ompSettingValueText", () => {
  it("summarizes each value type and never shows a credential", () => {
    expect(ompSettingValueText(field({ key: "a", type: "boolean", value: true }))).toBe("On");
    expect(ompSettingValueText(field({ key: "a", type: "boolean", value: false }))).toBe("Off");
    expect(ompSettingValueText(field({ key: "a", type: "number", value: 0.7 }))).toBe("0.7");
    expect(ompSettingValueText(field({ key: "a", value: "high" }))).toBe("high");
    expect(ompSettingValueText(field({ key: "a" }))).toBe("Not set");
    expect(ompSettingValueText(field({ key: "a", type: "array", value: [] }))).toBe("Empty");
    expect(
      ompSettingValueText(field({ key: "a", type: "record", value: { default: "opus" } })),
    ).toBe('{"default":"opus"}');
    expect(
      ompSettingValueText(field({ key: "a", type: "array", value: ["x".repeat(400)] })),
    ).toHaveLength(160);
    expect(
      ompSettingValueText(field({ key: "k", credential: true, redacted: true, value: "sk-1" })),
    ).toBe("Stored (hidden)");
    expect(ompSettingValueText(field({ key: "k", credential: true }))).toBe("Not set");
  });
});

describe("OmpSettingsSummaryView", () => {
  it("groups fields by OMP settings page, read-only, with source and restart notes", () => {
    act(() =>
      root.render(
        <OmpSettingsSummaryView
          form={{
            fields: [
              field({
                key: "modelRoles",
                type: "record",
                value: { default: "opus" },
                source: "global",
              }),
              field({ key: "enabledModels", type: "array", value: ["opus"], launchScoped: true }),
              field({
                key: "temperature",
                type: "number",
                value: 0.2,
                source: "env",
                readOnly: true,
              }),
              field({ key: "not.on.a.page", value: "hidden" }),
            ],
          }}
        />,
      ),
    );
    const sections = Array.from(container.querySelectorAll("section"), (section) =>
      section.getAttribute("aria-label"),
    );
    // A key shows on every page that lists it, as on web (Routing and Search reuse model keys).
    expect(sections).toEqual(["Models & Roles", "Routing", "Sampling", "Search"]);
    const rows = (page: string) =>
      Array.from(container.querySelectorAll(`section[aria-label="${page}"] > div`), (row) =>
        row.getAttribute("aria-label"),
      );
    expect(rows("Models & Roles")).toEqual([
      'modelRoles: {"default":"opus"}. Global',
      'enabledModels: ["opus"]. Default · Restarts threads',
    ]);
    expect(rows("Sampling")).toEqual([
      "temperature: 0.2. Environment · Set by an environment variable",
    ]);
    expect(container.querySelector('section[aria-label="Sampling"] footer')?.textContent).toContain(
      "Advanced sampling",
    );
    expect(container.textContent).not.toContain("not.on.a.page");
    expect(container.querySelector("input, button")).toBeNull();
  });
});
