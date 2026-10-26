import { page } from "vite-plus/test/browser";

/** An iPhone-class phone in portrait: the width settings pages must fit (PRD §9). */
const PHONE_VIEWPORT = { width: 390, height: 844 } as const;

export async function usePhoneViewport(): Promise<AsyncDisposable> {
  await page.viewport(PHONE_VIEWPORT.width, PHONE_VIEWPORT.height);
  return {
    [Symbol.asyncDispose]: async () => {
      await page.viewport(1280, 900);
    },
  };
}

/**
 * The content column of the settings route at phone width: below `md` the settings nav collapses
 * to a `w-14` (56px) icon rail beside it (SettingsSidebarNav), leaving 334px for the page.
 */
export function settingsContentColumn(): HTMLElement {
  const column = document.createElement("div");
  column.style.marginInlineStart = "56px";
  column.style.width = "calc(100vw - 56px)";
  column.style.minWidth = "0";
  document.body.append(column);
  return column;
}

/**
 * Visible elements inside `root` whose box ends past the viewport's right edge, described as
 * `tag[aria-label|data-setting]`, so a failure names what pushes the page sideways.
 */
export function elementsPastViewport(root: Element): ReadonlyArray<string> {
  const limit = document.documentElement.clientWidth + 0.5;
  const past: string[] = [];
  for (const element of root.querySelectorAll("*")) {
    const box = element.getBoundingClientRect();
    if (box.width === 0 || box.height === 0 || box.right <= limit) continue;
    const name =
      element.getAttribute("aria-label") ??
      element.closest("[data-setting]")?.getAttribute("data-setting") ??
      element.textContent?.slice(0, 40);
    past.push(`${element.tagName.toLowerCase()}[${name}] right=${Math.round(box.right)}`);
  }
  return past;
}
