// @effect-diagnostics nodeBuiltinImport:off - an end-to-end test reading the stack's files.
// P-07 (FR-22, ompanel#144): a fresh OMP install — no default model, no credentials — against a
// real `omp` built from the omp.lock tag. OMP refuses `--mode rpc` there; Ompanel shows it as
// needing setup (never "Unavailable"), offers `omp setup` in an embedded terminal, then hands over
// to Accounts. `omp setup`'s own wizard is OMP's TUI; the test leaves the OMP home as the wizard
// would (`completeOmpSetup`) while the terminal is open. Steps run in order on one page.
import * as NodePath from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { FAKE_SIGN_IN_PROVIDER } from "./fakeSignIn.ts";
import { useOmpSuite } from "./ompSuite.ts";

const ARTIFACTS = NodePath.join(
  process.env.OMPANEL_E2E_ARTIFACTS_DIR ??
    NodePath.join(import.meta.dirname, "..", "..", ".playwright", "omp-artifacts"),
  "onboarding",
);

test.describe.configure({ mode: "serial" });

const suite = useOmpSuite({
  artifacts: ARTIFACTS,
  stack: () => ({ fakeSignIn: true, freshOmpHome: true }),
});

const openPage = async (page: Page, path: string) => {
  await page.goto(new URL(path, page.url()).href);
};

const setupSteps = (page: Page) => page.getByRole("list", { name: "OMP setup steps" });

test("shows a fresh install as needing setup, not as unavailable", async () => {
  const { page, screenshot } = suite.current();
  await openPage(page, "/settings/providers");
  const steps = setupSteps(page);
  await expect(steps.getByRole("button", { name: "Run omp setup" })).toBeVisible({
    timeout: 60_000,
  });
  // Detect: the sidecar the instance runs (the stack's binary is a custom path).
  await expect(steps.locator('li[data-state="done"]').first()).toContainText("Custom path");
  await expect(steps.locator('li[aria-current="step"]')).toContainText("Run omp setup");
  await expect(page.getByText("Needs setup", { exact: true })).toBeVisible();
  await expect(page.getByText("Unavailable", { exact: true })).toHaveCount(0);
  await expect(page.getByText("OMP exited before its RPC server answered.")).toHaveCount(0);
  await steps.scrollIntoViewIfNeeded();
  await screenshot("01-needs-setup");
});

test("lists sign-in providers before setup", async () => {
  const { page, screenshot } = suite.current();
  // The control server falls back to a placeholder model, so Accounts works on a fresh install.
  await page.getByRole("button", { name: "Show providers" }).click();
  const providers = page.getByRole("list", { name: "OMP providers" });
  await expect(providers.locator(`[data-provider="${FAKE_SIGN_IN_PROVIDER.id}"]`)).toContainText(
    "Not signed in",
  );
  await expect(providers.locator('[data-provider="anthropic"]')).toBeVisible();
  await providers.scrollIntoViewIfNeeded();
  await screenshot("02-accounts-before-setup");
});

test("offers omp setup in an embedded terminal, then hands over to Accounts", async () => {
  const { page, stack, screenshot } = suite.current();
  await openPage(page, "/settings/providers");
  const steps = setupSteps(page);
  await steps.getByRole("button", { name: "Run omp setup" }).click();
  await expect(page.getByText("Review the command, then press Enter to run it.")).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Terminal input" })).toBeVisible();
  await steps.scrollIntoViewIfNeeded();
  await screenshot("03-setup-terminal");

  // What `omp setup` leaves behind: a provider and a default model.
  stack.completeOmpSetup();
  // The section re-checks OMP while the setup terminal is open, then opens Accounts.
  await expect(steps.locator('li[aria-current="step"]')).toContainText("Sign in under Accounts", {
    timeout: 60_000,
  });
  await expect(page.getByText("Needs setup", { exact: true })).toHaveCount(0);
  const provider = page
    .getByRole("list", { name: "OMP providers" })
    .locator(`[data-provider="${FAKE_SIGN_IN_PROVIDER.id}"]`);
  await expect(provider).toContainText("Not signed in");
  await screenshot("04-accounts-after-setup");
  // Sign-in starts from the hand-over (the full flow is the G2 suite's).
  await provider.getByRole("button", { name: "Sign in" }).click();
  const flow = page.getByRole("region", { name: "OMP sign-in" });
  await expect(flow.getByRole("button", { name: "Open sign-in page" })).toBeVisible();
  await screenshot("05-sign-in-started");
  await flow.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(flow).toHaveCount(0);
});
