import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ompMagicKeywordCompletions } from "@t3tools/provider-omp/composer";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@t3tools/shared/keybindings";
import { useLayoutEffect } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import type { ComposerTrigger } from "../../composer-logic";
import type { ComposerPromptEditorHandle } from "../ComposerPromptEditor";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import { type ComposerCommandKeyInput, useComposerCommandKey } from "./useComposerCommandKey";

type CommandKeyHandler = (key: string, event: KeyboardEvent) => boolean;

function Harness(props: {
  readonly input: ComposerCommandKeyInput;
  readonly onHandler: (handler: CommandKeyHandler) => void;
}) {
  const { onComposerCommandKey } = useComposerCommandKey(props.input);
  const { onHandler } = props;
  useLayoutEffect(() => {
    onHandler(onComposerCommandKey);
  });
  return null;
}

function setup(prompt: string, trigger: ComposerTrigger, items: ComposerCommandItem[]) {
  const spies = {
    onSelectComposerItem: vi.fn<ComposerCommandKeyInput["onSelectComposerItem"]>(),
    nudgeComposerMenuHighlight: vi.fn<ComposerCommandKeyInput["nudgeComposerMenuHighlight"]>(),
    dismissComposerTrigger: vi.fn<ComposerCommandKeyInput["dismissComposerTrigger"]>(),
    submitComposer: vi.fn<ComposerCommandKeyInput["submitComposer"]>(),
  };
  const editor = {
    readSelectionRange: () => ({ start: prompt.length, end: prompt.length }),
    isCaretOnVisualEdge: () => true,
  } as unknown as ComposerPromptEditorHandle;
  const input: ComposerCommandKeyInput = {
    keybindings: DEFAULT_RESOLVED_KEYBINDINGS,
    sendShortcut: "enter",
    routeKind: "server",
    phase: "ready",
    isCompacting: false,
    followUpBehavior: "queue",
    isSoftwareKeyboardOpen: false,
    planModeUiEnabled: false,
    isLiteralPendingAnswer: false,
    pendingUserInputs: [],
    promptHistoryMessages: [],
    promptHistoryPositionRef: { current: null },
    composerDraftTarget: scopeThreadRef(EnvironmentId.make("env-1"), ThreadId.make("thread-1")),
    promptRef: { current: prompt },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    composerEditorRef: { current: editor },
    composerMenuOpenRef: { current: true },
    composerMenuItemsRef: { current: items },
    activeComposerMenuItemRef: { current: null },
    setComposerDraftPrompt: vi.fn(),
    setComposerCursor: vi.fn(),
    setComposerTrigger: vi.fn(),
    setComposerHighlightedItemId: vi.fn(),
    toggleInteractionMode: vi.fn(),
    resolveActiveComposerTrigger: () => ({ trigger }),
    readComposerSnapshot: () => ({ value: prompt }),
    applyPromptReplacement: vi.fn(() => false),
    ...spies,
  };
  const handlers: CommandKeyHandler[] = [];
  return {
    spies,
    element: <Harness input={input} onHandler={(handler) => handlers.push(handler)} />,
    press: (key: string) => handlers.at(-1)!(key, new KeyboardEvent("keydown", { key })),
  };
}

const keywordPrompt = "fix the parser, ultra";
const keywordTrigger: ComposerTrigger = {
  kind: "keyword",
  query: "ultra",
  rangeStart: "fix the parser, ".length,
  rangeEnd: keywordPrompt.length,
};
const keywordItems: ComposerCommandItem[] = ompMagicKeywordCompletions("ultra").map((keyword) => ({
  id: `magic-keyword:${keyword.id}`,
  type: "magic-keyword",
  keyword,
  label: keyword.word,
  description: keyword.description,
}));

describe("useComposerCommandKey with magic keyword suggestions", () => {
  it("leaves Tab, the arrows and Enter to the editor and never inserts a keyword", async () => {
    const { element, spies, press } = setup(keywordPrompt, keywordTrigger, keywordItems);
    // The hook reads no route.
    await using _screen = await render(element, { router: false });

    expect(press("Tab")).toBe(false);
    expect(press("ArrowDown")).toBe(false);
    expect(press("ArrowUp")).toBe(false);
    expect(spies.onSelectComposerItem).not.toHaveBeenCalled();
    expect(spies.nudgeComposerMenuHighlight).not.toHaveBeenCalled();

    // Enter sends the prompt as typed.
    expect(press("Enter")).toBe(true);
    expect(spies.submitComposer).toHaveBeenCalledTimes(1);
    expect(spies.onSelectComposerItem).not.toHaveBeenCalled();

    // Escape still closes the suggestions.
    expect(press("Escape")).toBe(true);
    expect(spies.dismissComposerTrigger).toHaveBeenCalledWith(keywordTrigger);
  });

  it("still lets other menus take Tab, the arrows and Enter", async () => {
    const slashItem: ComposerCommandItem = {
      id: "slash:model",
      type: "slash-command",
      command: "model",
      label: "/model",
      description: "Switch response model for this thread",
    };
    const { element, spies, press } = setup(
      "/mo",
      { kind: "slash-command", query: "mo", rangeStart: 0, rangeEnd: 3 },
      [slashItem],
    );
    // The hook reads no route.
    await using _screen = await render(element, { router: false });

    expect(press("ArrowDown")).toBe(true);
    expect(spies.nudgeComposerMenuHighlight).toHaveBeenCalledWith("ArrowDown");
    expect(press("Tab")).toBe(true);
    expect(press("Enter")).toBe(true);
    expect(spies.onSelectComposerItem).toHaveBeenCalledTimes(2);
    expect(spies.onSelectComposerItem).toHaveBeenLastCalledWith(slashItem);
    expect(spies.submitComposer).not.toHaveBeenCalled();
  });
});
