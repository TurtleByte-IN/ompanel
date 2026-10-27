// FR-18h-m: an OMP eval call's images reach the mobile work log. The item is shaped as
// packages/provider-omp/src/server/mapper.ts builds it (mapperCards.test.ts ‹eval: cells with
// inline images kept as output blocks›): OMP's content blocks, image included, beside the card.
import {
  EnvironmentId,
  OMP_CARD_OUTPUT_KEY,
  readOmpToolCard,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { turnItemOutputImages } from "@t3tools/client-runtime/work-log/item-detail";
import * as DateTime from "effect/DateTime";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));
vi.mock("../../components/FilePreviewGallery", () => ({
  FilePreviewGallery: (props: { value: ReadonlyArray<unknown>; children?: ReactNode }) => (
    <div data-gallery={props.value.length}>{props.children}</div>
  ),
}));
vi.mock("./ThreadMarkdownImage", () => ({
  ThreadMarkdownImage: (props: {
    resource: { _tag: string; threadId: string; itemId: string; index: number };
  }) => (
    <img
      alt=""
      data-tag={props.resource._tag}
      data-item={props.resource.itemId}
      data-index={props.resource.index}
    />
  ),
}));

import { OmpToolCard } from "./OmpToolCard";
import { WorkLogOutputImages } from "./WorkLogOutputImages";

const PNG = "iVBORw0KGgo=";
const threadId = ThreadId.make("thread");
const at = DateTime.makeUnsafe(Date.parse("2026-06-20T00:00:01.000Z"));

function evalItem(output: unknown, outputOmitted = false): OrchestrationV2TurnItem {
  return {
    id: TurnItemId.make("eval-1"),
    threadId,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: "eval",
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "dynamic_tool",
    toolName: "eval",
    input: { language: "py", code: "plot()" },
    output,
    ...(outputOmitted ? { outputOmitted: true } : {}),
  } as OrchestrationV2TurnItem;
}

const OUTPUT = {
  content: [
    { type: "text", text: "(1 image; no text output)" },
    { type: "image", data: PNG, mimeType: "image/png" },
  ],
  [OMP_CARD_OUTPUT_KEY]: {
    kind: "eval",
    language: "python",
    cells: [{ index: 0, code: "plot()", output: "", status: "complete", durationMs: 12 }],
  },
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

/** What an expanded eval row renders: the item's images, then its card. */
function renderExpandedRow(item: OrchestrationV2TurnItem) {
  const card = item.type === "dynamic_tool" ? readOmpToolCard(item.output) : null;
  if (card === null) throw new Error("eval card did not parse");
  act(() =>
    root.render(
      <>
        <WorkLogOutputImages
          environmentId={EnvironmentId.make("env")}
          resources={turnItemOutputImages(item)}
          onPressPreview={() => undefined}
        />
        <OmpToolCard card={card} />
      </>,
    ),
  );
}

describe("OMP eval images on mobile", () => {
  it("shows the eval cell and the image it produced, in a preview gallery", () => {
    renderExpandedRow(evalItem(OUTPUT));
    const images = Array.from(container.querySelectorAll("img"));
    expect(
      images.map((image) => [image.dataset.tag, image.dataset.item, image.dataset.index]),
    ).toEqual([["tool-output-image", "eval-1", "0"]]);
    expect(container.querySelector("[data-gallery]")?.getAttribute("data-gallery")).toBe("1");
    const card = container.querySelector('[data-testid="omp-card-eval"]');
    expect(Array.from(card?.querySelectorAll("p") ?? [], (line) => line.textContent)).toEqual([
      "Cell 1 · python · complete · 12 ms",
      "plot()",
    ]);
  });

  it("shows no image until the omitted output is fetched", () => {
    renderExpandedRow(evalItem(OUTPUT, true));
    expect(container.querySelectorAll("img")).toHaveLength(0);
  });
});
