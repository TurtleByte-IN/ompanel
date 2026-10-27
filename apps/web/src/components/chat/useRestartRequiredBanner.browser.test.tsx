import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderSessionId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { makeThreadProjectionFixture } from "../../test-fixtures";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({ stopSession: vi.fn() }));

vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.stopSession) as never,
}));

import { ComposerBannerStack } from "./ComposerBannerStack";
import { useRestartRequiredBanner } from "./useRestartRequiredBanner";

const environmentId = EnvironmentId.make("environment-test");

function projectionWith(restartRequired?: ReadonlyArray<string>): OrchestrationV2ThreadProjection {
  const projection = makeThreadProjectionFixture();
  const now = DateTime.makeUnsafe("2026-10-27T10:00:00.000Z");
  return {
    ...projection,
    providerSessions: [
      {
        id: ProviderSessionId.make("session-1"),
        driver: ProviderDriverKind.make("omp"),
        providerInstanceId: projection.thread.providerInstanceId,
        status: "ready",
        cwd: "/repo",
        model: null,
        capabilities: {} as never,
        createdAt: now,
        updatedAt: now,
        lastError: null,
        ...(restartRequired === undefined ? {} : { restartRequired }),
      },
    ],
  };
}

function Harness(props: { projection: OrchestrationV2ThreadProjection; working?: boolean }) {
  const item = useRestartRequiredBanner({
    environmentId,
    threadId: props.projection.thread.id,
    projection: props.projection,
    canOperate: true,
    working: props.working ?? false,
  });
  return <ComposerBannerStack items={item === null ? [] : [item]} />;
}

it("offers a restart for launch-only settings and stops the session", async () => {
  state.stopSession.mockReset().mockResolvedValue({ _tag: "Success", value: { sequence: 1 } });
  const projection = projectionWith(["memory.backend"]);
  await using screen = await render(<Harness projection={projection} />);

  await expect.element(page.getByText("Restart to apply memory.backend")).toBeVisible();
  await page.getByRole("button", { name: "Restart" }).click();
  await vi.waitFor(() =>
    expect(state.stopSession).toHaveBeenCalledWith({
      environmentId,
      input: { threadId: projection.thread.id },
    }),
  );

  // Stopping detaches the session; the replacement starts without the marker.
  await screen.rerender(<Harness projection={projectionWith()} />);
  await expect.element(page.getByText("Restart to apply memory.backend")).not.toBeInTheDocument();
});

it("holds the restart while a turn runs", async () => {
  state.stopSession.mockReset();
  await using _screen = await render(
    <Harness projection={projectionWith(["memory.backend"])} working />,
  );
  await expect.element(page.getByRole("button", { name: "Restart" })).toBeDisabled();
  await expect.element(page.getByText("Restart after this turn.", { exact: false })).toBeVisible();
});
