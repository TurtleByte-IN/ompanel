import type { OmpAccountsList, OmpSignInState } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";

import {
  elementsPastViewport,
  settingsContentColumn,
  usePhoneViewport,
} from "../../../test/phoneViewport";
import { render } from "../../../test/render";
import { OmpAccountsPanel, type OmpAccountsPanelProps } from "./OmpAccountsSection";

const LIST: OmpAccountsList = {
  apiKeySignIn: true,
  projectSecrets: [{ key: "auth.broker.token", path: "/work/repo/.omp/config.yml" }],
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      available: true,
      authenticated: true,
      apiKey: false,
      source: "oauth",
    },
    {
      id: "openai",
      name: "OpenAI",
      available: true,
      authenticated: true,
      apiKey: true,
      source: "env",
      envVar: "OPENAI_API_KEY",
    },
    { id: "groq", name: "Groq", available: true, authenticated: false, apiKey: true },
  ],
};

const IDLE: OmpSignInState = {
  phase: "idle",
  flowId: null,
  providerId: null,
  openUrl: null,
  prompt: null,
  message: null,
};

const props = (overrides: Partial<OmpAccountsPanelProps> = {}): OmpAccountsPanelProps => ({
  list: LIST,
  signIn: IDLE,
  signOut: null,
  error: null,
  disabled: false,
  onSignIn: vi.fn(),
  onAnswer: vi.fn(),
  onCancel: vi.fn(),
  onOpenUrl: vi.fn(),
  onListSignOut: vi.fn(),
  onSignOut: vi.fn(),
  onRefresh: vi.fn(),
  ...overrides,
});

const provider = (id: string) => document.querySelector(`[data-provider="${id}"]`)!;

describe("OmpAccountsPanel", () => {
  it("lists providers with their auth source and warns about a key in project config", async () => {
    await using screen = await render(<OmpAccountsPanel {...props()} />);

    await expect.element(screen.getByRole("list", { name: "OMP providers" })).toBeVisible();
    expect(provider("anthropic").textContent).toContain("Signed in");
    expect(provider("openai").textContent).toContain("Environment (OPENAI_API_KEY)");
    expect(provider("groq").textContent).toContain("Not signed in");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      "auth.broker.token is set in /work/repo/.omp/config.yml",
    );
    // Only stored credentials can be signed out; an env var is removed at its source.
    expect(provider("openai").textContent).not.toContain("Sign out");
    expect(provider("anthropic").textContent).toContain("Sign out");
  });

  it("takes an API key in a masked field and hands it over once", async () => {
    const onSignIn = vi.fn();
    await using screen = await render(<OmpAccountsPanel {...props({ onSignIn })} />);

    await userEvent.click(screen.getByRole("button", { name: "Add API key" }));
    const field = screen.getByLabelText("Groq API key");
    await expect.element(field).toHaveAttribute("type", "password");
    await userEvent.fill(field, "gsk-browser-key");
    await userEvent.click(screen.getByRole("button", { name: "Save key" }));
    expect(onSignIn).toHaveBeenCalledWith("groq", "gsk-browser-key");
    // The draft is cleared and the field closed.
    expect(document.body.innerHTML).not.toContain("gsk-browser-key");
  });

  it("shows a running sign-in's page and masks a secret prompt", async () => {
    const onAnswer = vi.fn();
    const onOpenUrl = vi.fn();
    const signIn: OmpSignInState = {
      phase: "running",
      flowId: "omp-sign-in-1",
      providerId: "anthropic",
      openUrl: {
        url: "https://auth.example/authorize",
        launchUrl: "http://127.0.0.1:54545/launch",
      },
      prompt: { id: "omp-sign-in-1:ui-1", title: "Paste the code", secret: true },
      message: null,
    };
    await using screen = await render(
      <OmpAccountsPanel {...props({ signIn, onAnswer, onOpenUrl })} />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Open sign-in page" }));
    expect(onOpenUrl).toHaveBeenCalledWith("http://127.0.0.1:54545/launch");
    const field = screen.getByLabelText("Paste the code");
    await expect.element(field).toHaveAttribute("type", "password");
    await userEvent.fill(field, "code-123");
    await userEvent.click(screen.getByRole("button", { name: "Submit" }));
    expect(onAnswer).toHaveBeenCalledWith("omp-sign-in-1", "omp-sign-in-1:ui-1", "code-123");
  });

  it("lists stored accounts and removes one", async () => {
    const onSignOut = vi.fn();
    await using screen = await render(
      <OmpAccountsPanel
        {...props({
          onSignOut,
          signOut: {
            providerId: "anthropic",
            accounts: [
              {
                credentialId: 4,
                provider: "anthropic",
                label: "me@example.com",
                detail: "Max",
                type: "oauth",
                active: true,
              },
            ],
          },
        })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onSignOut).toHaveBeenCalledWith("anthropic", 4);
  });
});

describe("OmpAccountsPanel at phone width", () => {
  it("fits an API key field, stored accounts and a running sign-in in a 390px viewport", async () => {
    const signOut: OmpAccountsPanelProps["signOut"] = {
      providerId: "anthropic",
      accounts: [
        {
          credentialId: 4,
          provider: "anthropic",
          label: "someone.with.a.long.address@example-company.com",
          detail: "OAuth · expires in 30 days",
          type: "oauth",
          active: true,
        },
      ],
    };
    await using _viewport = await usePhoneViewport();
    await using screen = await render(<OmpAccountsPanel {...props({ signOut })} />, {
      container: settingsContentColumn(),
    });
    await userEvent.click(screen.getByRole("button", { name: "Add API key" }));
    await expect.element(screen.getByLabelText("Groq API key")).toBeVisible();
    expect(elementsPastViewport(screen.container)).toEqual([]);

    await screen.rerender(
      <OmpAccountsPanel
        {...props({
          signOut,
          signIn: {
            phase: "running",
            flowId: "omp-sign-in-1",
            providerId: "anthropic",
            openUrl: {
              url: `https://auth.example/authorize?${"scope=a-long-oauth-scope&".repeat(12)}`,
              instructions: "Approve access in the browser, then paste the code shown there.",
            },
            prompt: { id: "omp-sign-in-1:ui-1", title: "Paste the code", secret: true },
            message: "Waiting for the code.",
          },
        })}
      />,
    );
    await expect.element(screen.getByLabelText("Paste the code")).toBeVisible();
    expect(elementsPastViewport(screen.container)).toEqual([]);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
  });
});
