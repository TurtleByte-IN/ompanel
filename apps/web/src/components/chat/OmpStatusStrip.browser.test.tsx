import type { OrchestrationV2ProviderExtensionStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";

import { OmpStatusStrip } from "./OmpStatusStrip";
import "~/index.css";

function setup(entries: ReadonlyArray<OrchestrationV2ProviderExtensionStatus> | undefined) {
  const container = document.createElement("div");
  container.style.width = "560px";
  container.className = "bg-background text-foreground";
  return { container, element: <OmpStatusStrip entries={entries} /> };
}

describe("OmpStatusStrip", () => {
  it("shows status lines in one row and each widget as its own block", async () => {
    const { container, element } = setup([
      { key: "git", kind: "status", lines: ["main ✓"] },
      { key: "tests", kind: "widget", lines: ["12 passed", "1 failed"], placement: "belowEditor" },
      { key: "review", kind: "status", lines: ["Loading open PRs…"] },
    ]);
    await using screen = await render(element, { container });

    await expect.element(screen.getByRole("region", { name: "Extension status" })).toBeVisible();
    await expect.element(screen.getByText("main ✓")).toBeVisible();
    await expect.element(screen.getByText("Loading open PRs…")).toBeVisible();
    expect(
      [...container.querySelectorAll("[data-extension-status]")].map((node) =>
        node.getAttribute("data-extension-status"),
      ),
    ).toEqual(["git", "review"]);
    const widget = container.querySelector('[data-extension-widget="tests"]');
    expect(widget?.textContent).toBe("12 passed\n1 failed");
    await expect.element(screen.getByText(/12 passed/)).toBeVisible();
    // Review artifact; `__screenshots__/` is git-ignored.
    await page.screenshot({ path: "__screenshots__/omp-status-strip.png", element: container });
  });

  it("renders nothing without entries", async () => {
    for (const entries of [undefined, []]) {
      const { container, element } = setup(entries);
      await using _screen = await render(element, { container });
      expect(container.querySelector("[data-omp-status-strip]")).toBeNull();
      expect(container.textContent).toBe("");
    }
  });
});
