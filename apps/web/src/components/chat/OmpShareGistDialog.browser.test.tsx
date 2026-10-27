import {
  EnvironmentId,
  OmpThreadMenuOperationError,
  ProviderInstanceId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { page } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../../test/render";

const environmentId = EnvironmentId.make("local");
const instanceId = ProviderInstanceId.make("omp");
const threadRef: ScopedThreadRef = { environmentId, threadId: ThreadId.make("thread-omp") };

// The thread runs on the OMP instance.
vi.mock(import("~/state/entities"), async (original) => ({
  ...(await original()),
  readThreadShell: (() => ({ providerInstanceId: "omp" })) as never,
}));
vi.mock(import("~/state/presentation"), async (original) => {
  // vi.mock factories are hoisted above the static imports.
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  return {
    ...actual,
    environmentPresentations: {
      ...actual.environmentPresentations,
      providersByEnvironmentAtom: Atom.make(
        new Map([["local", [{ instanceId: "omp", driver: "omp" }]]]),
      ) as never,
    },
  };
});

import { AppAtomRegistryProvider } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { OmpThreadDialogHost, runOmpThreadMenuAction } from "./OmpThreadMenu";

const GH_MISSING =
  "Sharing as a gist needs the GitHub CLI (gh). Install it, run `gh auth login`, then try again. Nothing was uploaded.";
const shared = {
  url: "https://my.omp.sh/s/0f3a9c#k=fake-key",
  gistUrl: "https://gist.github.com/tester/0f3a9c",
  truncated: false,
};

const share = vi.spyOn(serverEnvironment.shareOmpThreadGist, "run");

/** Opens Share as gist from the thread menu; the upload answers what the test set on `share`. */
async function openShareGist() {
  share.mockClear();
  // The menu opens the dialog on the app's registry, which the root provides.
  const screen = await render(
    <AppAtomRegistryProvider>
      <OmpThreadDialogHost />
    </AppAtomRegistryProvider>,
  );
  await act(() => runOmpThreadMenuAction("omp-share-gist", threadRef));
  const dialog = page.getByRole("dialog", { name: "Share as a secret gist" });
  await expect.element(dialog).toBeVisible();
  // A DOM click, as the other dialog tests do: the modal's inert backdrop takes Playwright's pointer.
  const press = (name: string) =>
    act(async () => (dialog.getByRole("button", { name }).element() as HTMLElement).click());
  return { screen, dialog, press };
}

describe("Share as gist dialog", () => {
  it("uploads only after the confirm, then shows the share link and its gist", async () => {
    share.mockResolvedValue(AsyncResult.success(shared));
    const { screen, dialog, press } = await openShareGist();
    await using _ = screen;
    // Opening explains what is uploaded; nothing is sent until the user confirms.
    await expect.element(dialog.getByText(/anyone with the link/i)).toBeVisible();
    expect(share).not.toHaveBeenCalled();

    await press("Share as gist");
    expect(share).toHaveBeenCalledTimes(1);
    expect(share.mock.calls[0]?.[1]).toEqual({
      environmentId,
      input: { instanceId, threadId: threadRef.threadId },
    });
    await expect.element(dialog.getByLabelText("Share link")).toHaveValue(shared.url);
    await expect.element(dialog.getByText(`Gist: ${shared.gistUrl}`)).toBeVisible();
    await expect.element(dialog.getByText(/trimmed/)).not.toBeInTheDocument();

    await press("Done");
    await expect.element(dialog).not.toBeInTheDocument();
  });

  it("shows the trim note when OMP trimmed large content", async () => {
    share.mockResolvedValue(AsyncResult.success({ ...shared, truncated: true }));
    const { screen, dialog, press } = await openShareGist();
    await using _ = screen;
    await press("Share as gist");
    await expect.element(dialog.getByText(/Large content was trimmed/)).toBeVisible();
  });

  it("shows the refusal when gh is missing, with no link, and lets the user retry", async () => {
    share.mockResolvedValue(
      AsyncResult.failure(
        Cause.fail(
          new OmpThreadMenuOperationError({ reason: "gh_unavailable", message: GH_MISSING }),
        ),
      ),
    );
    const { screen, dialog, press } = await openShareGist();
    await using _ = screen;
    await press("Share as gist");

    await expect.element(dialog.getByRole("alert")).toHaveTextContent(GH_MISSING);
    await expect.element(dialog.getByLabelText("Share link")).not.toBeInTheDocument();

    // After `gh auth login` the same dialog shares.
    share.mockResolvedValue(AsyncResult.success(shared));
    await press("Share as gist");
    await expect.element(dialog.getByLabelText("Share link")).toHaveValue(shared.url);
    expect(share).toHaveBeenCalledTimes(2);
  });

  it("Cancel closes the dialog without uploading", async () => {
    const { screen, dialog, press } = await openShareGist();
    await using _ = screen;
    await press("Cancel");
    await expect.element(dialog).not.toBeInTheDocument();
    expect(share).not.toHaveBeenCalled();
  });
});
