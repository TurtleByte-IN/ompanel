import { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import "~/index.css";

import { render } from "../../../test/render";

const environmentId = EnvironmentId.make("remote");
const instanceId = ProviderInstanceId.make("omp");

/** The environment's connection as the presentation reports it; it never reaches `connected`. */
const connection = vi.hoisted(() => ({
  current: { phase: "connecting", error: null as string | null },
}));

vi.mock(import("../../state/presentation"), async (original) => ({
  ...(await original()),
  useEnvironmentPresentation: (() => ({
    isReady: true,
    presentation: { connection: connection.current },
  })) as never,
}));

vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: () => environmentId,
  useEnvironmentProviders: (() =>
    new Map([[environmentId, [{ driver: "omp", instanceId }]]])) as never,
}));

const commands = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => commands.read) as never,
}));

import { OmpUsageSection } from "../usage/OmpUsageSection";
import { OmpSettingsPanel } from "./OmpSettingsPage";

const statusText = () => document.querySelector('[role="status"]')?.textContent;

describe("OMP pages before the environment connects", () => {
  it("show the connection's status and read nothing while it connects", async () => {
    connection.current = { phase: "connecting", error: null };
    await using _ = await render(<OmpSettingsPanel pageId="models" />);
    await expect.poll(statusText).toBe("Connecting...");
    expect(document.querySelector("[data-omp-settings-page]")).toBeNull();
    expect(commands.read).not.toHaveBeenCalled();
  });

  it("show why a failed connection failed on a settings page", async () => {
    connection.current = { phase: "error", error: "The server rejected the pairing." };
    await using _ = await render(<OmpSettingsPanel pageId="models" />);
    await expect
      .poll(statusText)
      .toBe("Connection failed. Reason: The server rejected the pairing.");
    expect(commands.read).not.toHaveBeenCalled();
  });

  it("show an unsupported environment on the Usage OMP tab", async () => {
    connection.current = { phase: "unsupported", error: null };
    await using _ = await render(
      <OmpUsageSection environmentIds={[environmentId]} refreshKey={0} />,
    );
    await expect.poll(statusText).toBe("Client not supported");
    expect(commands.read).not.toHaveBeenCalled();
  });

  it("show an offline environment on the Usage OMP tab", async () => {
    connection.current = { phase: "offline", error: null };
    await using _ = await render(
      <OmpUsageSection environmentIds={[environmentId]} refreshKey={0} />,
    );
    await expect.poll(statusText).toBe("Offline");
    expect(commands.read).not.toHaveBeenCalled();
  });
});
