// `composer.cycleModel` over an OMP thread's models, through the default keybindings and the
// chat's shortcut listener. The stand-in composer applies picks the way ChatComposer does: it
// asks nextComposerCycleModel and selects the result.
import { ProviderInstanceId } from "@t3tools/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import type { ChatComposerHandle } from "./ChatComposer";
import { nextComposerCycleModel } from "./composerModelCycle";
import { useChatShortcuts } from "./useChatShortcuts";

const OMP = ProviderInstanceId.make("omp");
// The OMP picker: OMP default first, then the catalog as `provider/modelId`.
const OMP_MODELS = [
  { slug: "default" },
  { slug: "anthropic/claude-sonnet-4-5" },
  { slug: "openai/gpt-5.1-codex" },
  { slug: "openai/gpt-5-legacy", isLegacy: true },
  { slug: "google/gemini-2.5-pro" },
];

const shortcutContext = {
  terminalFocus: false,
  terminalOpen: false,
  previewFocus: false,
  previewOpen: false,
  isWeb: true,
  isDesktop: false,
  modelPickerOpen: false,
};

function Composer(props: { favorites?: ReadonlyArray<string> }) {
  const [model, setModel] = useState("default");
  useChatShortcuts({
    enabled: true,
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    scriptKeybindings: [],
    getShortcutContext: () => shortcutContext,
    threadFindActive: false,
    composerRef: {
      current: {
        insertTextAtEnd: () => false,
        cycleModel: (direction: 1 | -1) => {
          setModel((current) => {
            const next = nextComposerCycleModel({
              instanceId: OMP,
              models: OMP_MODELS,
              current,
              direction,
              favoriteModelKeys: props.favorites ?? [],
            });
            return next ?? current;
          });
        },
      } as Partial<ChatComposerHandle> as ChatComposerHandle,
    },
    branchToolbarRef: { current: null },
    closeThreadFind: () => {},
    commands: {},
    fallback: () => undefined,
  });
  return <output aria-label="Selected model">{model}</output>;
}

const selected = () => page.getByRole("status", { name: "Selected model" });
const forward = () => userEvent.keyboard("{Control>}{Alt>}p{/Alt}{/Control}");
const backward = () => userEvent.keyboard("{Control>}{Alt>}{Shift>}p{/Shift}{/Alt}{/Control}");

it("steps forward through the OMP models in picker order, skipping legacy, and wraps", async () => {
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  await using _screen = await render(<Composer />, { router: false });
  await expect.element(selected()).toHaveTextContent("default");

  const seen: string[] = [];
  for (let step = 0; step < 4; step += 1) {
    await forward();
    seen.push((await selected().element()).textContent ?? "");
  }
  await expect.element(selected()).toHaveTextContent("default");
  expect(seen).toEqual([
    "anthropic/claude-sonnet-4-5",
    "openai/gpt-5.1-codex",
    "google/gemini-2.5-pro",
    "default",
  ]);
});

it("steps backward from OMP default to the last model", async () => {
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  await using _screen = await render(<Composer />, { router: false });

  await backward();
  await expect.element(selected()).toHaveTextContent("google/gemini-2.5-pro");
  await backward();
  await expect.element(selected()).toHaveTextContent("openai/gpt-5.1-codex");
});

it("visits favorites first, as the picker lists them", async () => {
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  await using _screen = await render(<Composer favorites={["omp:google/gemini-2.5-pro"]} />, {
    router: false,
  });

  // Order: gemini (favorite), default, sonnet, codex.
  await forward();
  await expect.element(selected()).toHaveTextContent("anthropic/claude-sonnet-4-5");
  await forward();
  await forward();
  await expect.element(selected()).toHaveTextContent("google/gemini-2.5-pro");
  await forward();
  await expect.element(selected()).toHaveTextContent("default");
});
