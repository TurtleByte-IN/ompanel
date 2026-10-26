import type { OmpAccountsList, OmpSignInState } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type InputProps = {
  readonly accessibilityLabel: string;
  readonly secureTextEntry?: boolean;
  readonly value: string;
  readonly onChangeText: (value: string) => void;
};

vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
  }) => <div aria-label={accessibilityLabel}>{children}</div>,
  TextInput: (props: InputProps) => (
    <input
      aria-label={props.accessibilityLabel}
      type={props.secureTextEntry ? "password" : "text"}
      value={props.value}
      onChange={(event) => props.onChangeText(event.target.value)}
    />
  ),
  Linking: { openURL: vi.fn() },
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../../components/ui/Button", () => ({
  Button: (props: {
    label: string;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress: () => void;
  }) => (
    <button
      type="button"
      aria-label={props.accessibilityLabel ?? props.label}
      disabled={props.disabled}
      onClick={props.onPress}
    >
      {props.label}
    </button>
  ),
}));
vi.mock("../../state/query", () => ({ useEnvironmentQuery: () => ({ data: null, error: null }) }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));

import { OmpAccountsPanel, type OmpAccountsPanelProps } from "./OmpAccountsSection";

const LIST: OmpAccountsList = {
  apiKeySignIn: true,
  projectSecrets: [{ key: "providers.groq.apiKey", path: "/repo/.omp/config.yml" }],
  providers: [
    {
      id: "anthropic",
      name: "Anthropic",
      available: true,
      authenticated: true,
      apiKey: false,
      source: "oauth",
    },
    { id: "groq", name: "Groq", available: true, authenticated: false, apiKey: true },
  ],
};

const RUNNING: OmpSignInState = {
  phase: "running",
  flowId: "flow-1",
  providerId: "anthropic",
  openUrl: {
    url: "https://claude.ai/oauth/authorize?code=abc",
    launchUrl: "http://127.0.0.1:4711/l/1",
    instructions: "Approve access, then paste the code.",
  },
  prompt: { id: "code", title: "Authorization code", placeholder: "Paste code", secret: true },
  message: null,
};

let container: HTMLDivElement;
let root: Root;
const calls = {
  signIn: vi.fn(),
  answer: vi.fn(),
  cancel: vi.fn(),
  openUrl: vi.fn(),
  listSignOut: vi.fn(),
  signOut: vi.fn(),
  refresh: vi.fn(),
};

function render(overrides: Partial<OmpAccountsPanelProps> = {}) {
  act(() =>
    root.render(
      <OmpAccountsPanel
        title="OMP"
        list={LIST}
        signIn={null}
        signOut={null}
        error={null}
        disabled={false}
        onSignIn={calls.signIn}
        onAnswer={calls.answer}
        onCancel={calls.cancel}
        onOpenUrl={calls.openUrl}
        onListSignOut={calls.listSignOut}
        onSignOut={calls.signOut}
        onRefresh={calls.refresh}
        {...overrides}
      />,
    ),
  );
}

function button(name: string) {
  const match = container.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`);
  if (!match) throw new Error(`No button ${name}`);
  return match;
}

function input(name: string) {
  const match = container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`);
  if (!match) throw new Error(`No input ${name}`);
  return match;
}

function type(element: HTMLInputElement, value: string) {
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  for (const call of Object.values(calls)) call.mockClear();
});

afterEach(() => {
  act(() => root.unmount());
});

describe("OmpAccountsPanel (mobile)", () => {
  it("lists providers with their auth source and warns about committed project keys", () => {
    render();
    const providers = container.querySelector('[aria-label="OMP providers"]')!;
    expect(providers.textContent).toContain("AnthropicSigned in");
    expect(providers.textContent).toContain("GroqNot signed in");
    expect(container.textContent).toContain(
      "providers.groq.apiKey is set in /repo/.omp/config.yml",
    );
    act(() => button("Refresh").click());
    expect(calls.refresh).toHaveBeenCalledOnce();
  });

  it("opens the provider's OAuth page itself, not the server's loopback link", () => {
    render({ signIn: RUNNING });
    expect(container.textContent).toContain("Approve access, then paste the code.");
    expect(container.textContent).toContain("https://claude.ai/oauth/authorize?code=abc");
    act(() => button("Open sign-in page").click());
    expect(calls.openUrl).toHaveBeenCalledExactlyOnceWith(
      "https://claude.ai/oauth/authorize?code=abc",
    );
    // A running sign-in blocks starting another.
    expect(button("Sign in").disabled).toBe(true);
  });

  it("answers the sign-in prompt from a masked input card, and cancels", () => {
    render({ signIn: RUNNING });
    const code = input("Authorization code");
    expect(code.type).toBe("password");
    type(code, "secret-code");
    act(() => button("Submit").click());
    expect(calls.answer).toHaveBeenCalledExactlyOnceWith("flow-1", "code", "secret-code");
    expect(input("Authorization code").value).toBe("");
    act(() => button("Cancel sign-in").click());
    expect(calls.cancel).toHaveBeenCalledOnce();
  });

  it("takes an API key in a masked field and keeps no copy after saving", () => {
    render();
    act(() => button("Add API key").click());
    const key = input("Groq API key");
    expect(key.type).toBe("password");
    expect(button("Save key").disabled).toBe(true);
    type(key, "gsk-123");
    act(() => button("Save key").click());
    expect(calls.signIn).toHaveBeenCalledExactlyOnceWith("groq", "gsk-123");
    expect(container.querySelector('input[aria-label="Groq API key"]')).toBeNull();
    act(() => button("Add API key").click());
    expect(input("Groq API key").value).toBe("");
  });

  it("starts an OAuth sign-in and signs out a stored credential", () => {
    render();
    act(() => button("Sign in").click());
    expect(calls.signIn).toHaveBeenCalledExactlyOnceWith("anthropic");
    act(() => button("Sign out").click());
    expect(calls.listSignOut).toHaveBeenCalledExactlyOnceWith("anthropic");
    render({
      signOut: {
        providerId: "anthropic",
        accounts: [
          {
            credentialId: 7,
            provider: "anthropic",
            label: "me@example.com",
            detail: "OAuth",
            type: "oauth",
            active: true,
          },
        ],
      },
    });
    act(() => button("Remove me@example.com").click());
    expect(calls.signOut).toHaveBeenCalledExactlyOnceWith("anthropic", 7);
  });

  it("reports a failed sign-in and the request error", () => {
    render({
      signIn: { ...RUNNING, phase: "failed", prompt: null, message: "Token exchange failed." },
      error: "The OMP request failed.",
    });
    expect(container.textContent).toContain("Token exchange failed.");
    expect(container.textContent).toContain("The OMP request failed.");
  });
});
