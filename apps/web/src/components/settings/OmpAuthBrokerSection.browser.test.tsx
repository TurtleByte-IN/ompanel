import type { OmpSettingsField } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { OmpAuthBrokerPanel, type OmpAuthBrokerPanelProps } from "./OmpAuthBrokerSection";

const field = (key: string, overrides: Partial<OmpSettingsField> = {}): OmpSettingsField => ({
  key,
  group: "auth",
  type: "string",
  description: "",
  source: "default",
  redacted: false,
  credential: key === "auth.broker.token",
  readOnly: false,
  launchScoped: false,
  threadOverride: "overlay",
  ...overrides,
});

const props = (overrides: Partial<OmpAuthBrokerPanelProps> = {}): OmpAuthBrokerPanelProps => ({
  url: field("auth.broker.url"),
  token: field("auth.broker.token"),
  loading: false,
  error: null,
  disabled: false,
  onWrite: vi.fn(),
  onReset: vi.fn(),
  ...overrides,
});

const row = (key: string) => document.querySelector(`[data-setting="${key}"]`);

describe("OmpAuthBrokerPanel", () => {
  it("writes the broker URL through the settings engine and resets it", async () => {
    const onWrite = vi.fn();
    const onReset = vi.fn();
    await using screen = await render(<OmpAuthBrokerPanel {...props({ onWrite, onReset })} />);
    await userEvent.type(
      screen.getByRole("textbox", { name: "Auth broker URL" }),
      "https://broker.example:8765{Enter}",
    );
    expect(onWrite).toHaveBeenCalledExactlyOnceWith(
      "auth.broker.url",
      "https://broker.example:8765",
    );
    // Nothing set yet: no Reset.
    expect(row("auth.broker.url")?.querySelector("button")).toBeNull();
  });

  it("takes where OMP reads the token, never the token itself", async () => {
    const onWrite = vi.fn();
    await using screen = await render(<OmpAuthBrokerPanel {...props({ onWrite })} />);
    const source = screen.getByRole("textbox", { name: "Auth broker token source" });
    await userEvent.type(source, "q9X-Zr3_base64url-token{Enter}");
    await expect
      .poll(() => document.querySelector('[role="alert"]')?.textContent)
      .toContain("not the token itself");
    expect(onWrite).not.toHaveBeenCalled();
    // The field never keeps what was typed.
    await expect.element(source).toHaveValue("");

    await userEvent.type(source, "BROKER_TOKEN{Enter}");
    await userEvent.type(source, "!op read op://vault/broker/token{Enter}");
    expect(onWrite.mock.calls).toEqual([
      ["auth.broker.token", "BROKER_TOKEN"],
      ["auth.broker.token", "!op read op://vault/broker/token"],
    ]);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("shows a stored token without its value and offers Reset", async () => {
    const onReset = vi.fn();
    await using screen = await render(
      <OmpAuthBrokerPanel
        {...props({
          url: field("auth.broker.url", { source: "global", value: "https://broker.example" }),
          token: field("auth.broker.token", { source: "global", redacted: true }),
          onReset,
        })}
      />,
    );
    expect(row("auth.broker.token")?.textContent).toContain("Global · stored");
    await expect
      .element(screen.getByRole("textbox", { name: "Auth broker URL" }))
      .toHaveValue("https://broker.example");
    const tokenRow = screen.getByRole("region", { name: "Auth broker" });
    await userEvent.click(tokenRow.getByRole("button", { name: "Reset" }).nth(1));
    expect(onReset).toHaveBeenCalledExactlyOnceWith("auth.broker.token");
  });

  it("leaves environment-set broker settings read-only", async () => {
    await using screen = await render(
      <OmpAuthBrokerPanel
        {...props({
          url: field("auth.broker.url", { source: "env", readOnly: true, value: "https://env" }),
          token: field("auth.broker.token", { source: "env", readOnly: true, redacted: true }),
        })}
      />,
    );
    await expect.element(screen.getByRole("textbox", { name: "Auth broker URL" })).toBeDisabled();
    await expect
      .element(screen.getByRole("textbox", { name: "Auth broker token source" }))
      .toBeDisabled();
    expect(row("auth.broker.url")?.textContent).toContain("Environment");
    expect(document.body.textContent).toContain("Set by OMP_AUTH_BROKER_TOKEN");
    expect(document.querySelectorAll("[data-setting] button")).toHaveLength(0);
  });
});
