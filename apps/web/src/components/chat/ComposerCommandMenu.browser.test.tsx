import { ompMagicKeywordCompletions } from "@t3tools/provider-omp/composer";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";

import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import "~/index.css";

// The items useComposerMenuItems builds for a keyword trigger.
const keywordItems = (query: string): ComposerCommandItem[] =>
  ompMagicKeywordCompletions(query).map((keyword) => ({
    id: `magic-keyword:${keyword.id}`,
    type: "magic-keyword",
    keyword,
    label: keyword.word,
    description: keyword.description,
  }));

function menu(items: ComposerCommandItem[], onSelect: (item: ComposerCommandItem) => void) {
  return (
    <ComposerCommandMenu
      listId="composer-suggestions"
      items={items}
      resolvedTheme="light"
      isLoading={false}
      triggerKind="keyword"
      activeItemId={items[0]?.id ?? null}
      onHighlightedItemChange={() => {}}
      onSelect={onSelect}
    />
  );
}

describe("ComposerCommandMenu magic keywords", () => {
  it("lists the keywords a prefix completes as gradient chips", async () => {
    const onSelect = vi.fn<(item: ComposerCommandItem) => void>();
    const container = document.createElement("div");
    container.style.width = "560px";
    container.className = "bg-background text-foreground";
    await using screen = await render(menu(keywordItems("ult"), onSelect), { container });

    await expect.element(screen.getByRole("listbox", { name: "Magic keywords" })).toBeVisible();
    const word = screen.getByText("ultrathink", { exact: true });
    await expect.element(word).toBeVisible();
    expect(word.element().getAttribute("style")).toContain("linear-gradient");
    await expect
      .element(screen.getByText("Maximum thinking for this turn, with a careful-reasoning notice"))
      .toBeVisible();
    // Ultrathink needs no tools, so no note.
    expect(screen.getByText(/^needs /).query()).toBeNull();

    await screen.getByText("ultrathink", { exact: true }).click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0]![0]).toMatchObject({
      type: "magic-keyword",
      keyword: { word: "ultrathink" },
    });
  });

  it("notes the tools a keyword needs", async () => {
    const container = document.createElement("div");
    container.style.width = "560px";
    await using screen = await render(menu(keywordItems("wor"), vi.fn()), { container });

    await expect.element(screen.getByText("workflowz", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("needs task/eval")).toBeVisible();
  });
});
