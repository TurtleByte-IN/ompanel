import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { OmpOnboardingPanel, type OmpOnboardingPanelProps } from "./OmpOnboardingSection";

const READY: ServerProvider = {
  instanceId: ProviderInstanceId.make("omp"),
  driver: ProviderDriverKind.make("omp"),
  enabled: true,
  installed: true,
  version: "18.12.6",
  status: "ready",
  auth: { status: "unknown" },
  checkedAt: "2026-10-27T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  executable: {
    source: "bundled",
    path: "/Applications/Ompanel.app/Contents/Resources/omp",
  },
};

const NEEDS_SETUP: ServerProvider = {
  ...READY,
  status: "warning",
  auth: { status: "unauthenticated" },
  message: "OMP has no model or sign-in yet. Run `omp setup`, then sign in under Accounts.",
};

const props = (overrides: Partial<OmpOnboardingPanelProps> = {}): OmpOnboardingPanelProps => ({
  provider: NEEDS_SETUP,
  setupCommand: "/Applications/Ompanel.app/Contents/Resources/omp setup",
  terminal: null,
  canRunSetup: true,
  onRunSetup: vi.fn(),
  onCheckAgain: vi.fn(),
  onOpenAccounts: vi.fn(),
  ...overrides,
});

const stepStates = () =>
  [...document.querySelectorAll('[aria-label="OMP setup steps"] > li')].map((step) =>
    step.getAttribute("data-state"),
  );

describe("OmpOnboardingPanel", () => {
  it("shows a fresh install as found and waiting for `omp setup`, with no error", async () => {
    const onRunSetup = vi.fn();
    await using screen = await render(<OmpOnboardingPanel {...props({ onRunSetup })} />);

    await expect.element(screen.getByText("Bundled with Ompanel · v18.12.6")).toBeVisible();
    await expect
      .element(screen.getByText("/Applications/Ompanel.app/Contents/Resources/omp"))
      .toBeVisible();
    expect(stepStates()).toEqual(["done", "current", "pending"]);
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Unavailable");

    await userEvent.click(screen.getByRole("button", { name: "Run omp setup" }));
    expect(onRunSetup).toHaveBeenCalledOnce();
  });

  it("hands over to Accounts once OMP is ready", async () => {
    const onOpenAccounts = vi.fn();
    await using screen = await render(
      <OmpOnboardingPanel {...props({ provider: READY, onOpenAccounts })} />,
    );

    expect(stepStates()).toEqual(["done", "done", "current"]);
    await expect.element(screen.getByRole("button", { name: "Run omp setup again" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Open Accounts" }));
    expect(onOpenAccounts).toHaveBeenCalledOnce();
  });

  it("marks sign-in done when OMP reports a signed-in provider", async () => {
    await using screen = await render(
      <OmpOnboardingPanel
        {...props({
          provider: {
            ...READY,
            auth: { status: "authenticated", type: "oauth", label: "Anthropic" },
          },
        })}
      />,
    );

    expect(stepStates()).toEqual(["done", "done", "done"]);
    await expect.element(screen.getByText("Signed in · Anthropic")).toBeVisible();
  });

  it("explains a missing sidecar and offers to check again", async () => {
    const onCheckAgain = vi.fn();
    await using screen = await render(
      <OmpOnboardingPanel
        {...props({
          provider: {
            ...READY,
            installed: false,
            status: "error",
            version: null,
            message: "The OMP v18.12.6-ompanel.3 sidecar is not installed.",
          },
          onCheckAgain,
        })}
      />,
    );

    await expect
      .element(screen.getByRole("alert"))
      .toHaveTextContent("The OMP v18.12.6-ompanel.3 sidecar is not installed.");
    expect(stepStates()).toEqual(["current", "pending", "pending"]);
    expect(screen.getByRole("button", { name: "Run omp setup" }).elements()).toHaveLength(0);
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(onCheckAgain).toHaveBeenCalledOnce();
  });

  it("keeps setup closed to a connection that cannot run terminals", async () => {
    await using screen = await render(<OmpOnboardingPanel {...props({ canRunSetup: false })} />);

    await expect.element(screen.getByRole("button", { name: "Run omp setup" })).toBeDisabled();
  });
});
