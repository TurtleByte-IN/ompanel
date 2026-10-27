// OMP tool cards as the omp mapper emits them (packages/provider-omp/src/server/ompCards.ts),
// rendered through the item inspector that expands a tool row.
import {
  EnvironmentId,
  OMP_CARD_OUTPUT_KEY,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type AssetResource,
  type OmpToolCard,
  type OrchestrationV2ProjectedTurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";

const requested = vi.hoisted(() => [] as Array<AssetResource | null>);
vi.mock(import("~/assets/assetUrls"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    // Every asset resolves to a local data URL; the test records which resources were asked for.
    useAssetUrlState: ((_environmentId: unknown, resource: AssetResource | null) => {
      requested.push(resource);
      return {
        _tag: "Success",
        url:
          resource?._tag === "media-file"
            ? "data:audio/wav;base64,UklGRg=="
            : "data:image/png;base64,iVBORw0KGgo=",
      };
    }) as typeof actual.useAssetUrlState,
  };
});

const resolveCalls = vi.hoisted(
  () => [] as Array<{ threadRef: unknown; toolCallId: string; action: string }>,
);
vi.mock(import("./OmpThreadMenu"), async (original) => ({
  ...(await original()),
  // Records the click instead of calling the server; the card then follows the thread.
  resolveOmpProposal: async (threadRef, toolCallId, action) => {
    resolveCalls.push({ threadRef, toolCallId, action });
  },
}));

import { render } from "../../../test/render";
import { V2ItemInspector } from "./V2ItemInspector";

const NOW = DateTime.makeUnsafe("2026-10-26T10:00:00.000Z");
const ENVIRONMENT_ID = EnvironmentId.make("env");
const THREAD_ID = ThreadId.make("thread");
const PNG = "iVBORw0KGgo=";

function projected(
  toolName: string,
  card: OmpToolCard,
  content: ReadonlyArray<unknown> = [],
  status = "completed",
): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make(`turn-item:omp:${toolName}`);
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: THREAD_ID,
    sourceItemId: id,
    item: {
      id,
      threadId: THREAD_ID,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: {
        driver: ProviderDriverKind.make("omp"),
        nativeId: toolName,
        strength: "strong",
      },
      parentItemId: null,
      ordinal: 1,
      status,
      startedAt: NOW,
      completedAt: NOW,
      updatedAt: NOW,
      title: toolName,
      type: "dynamic_tool",
      toolName,
      input: {},
      output: { content, [OMP_CARD_OUTPUT_KEY]: card },
    },
  } as unknown as OrchestrationV2ProjectedTurnItem;
}

async function show(item: OrchestrationV2ProjectedTurnItem) {
  requested.length = 0;
  const screen = await render(
    <V2ItemInspector projectedItem={item} environmentId={ENVIRONMENT_ID} onOpenThread={() => {}} />,
  );
  const root = screen.container.querySelector<HTMLElement>("[data-omp-card]");
  if (root === null) throw new Error("no OMP card rendered");
  return Object.assign(screen, { root, text: () => root.textContent ?? "" });
}

it("ask card lists single, multi and Other answers", async () => {
  await using screen = await show(
    projected("ask", {
      kind: "ask",
      answers: [
        { question: "Which?", multi: true, selected: ["x", "y"] },
        { question: "Name?", multi: false, selected: [], custom: "Zed" },
      ],
    }),
  );
  expect(screen.text()).toContain("Which?x, y");
  expect(screen.text()).toContain("Name?Other: Zed");
});

it("a resolvable proposed edit offers Accept and Reject for its tool call", async () => {
  resolveCalls.length = 0;
  await using screen = await show(
    projected(
      "ast_edit",
      {
        kind: "proposed_edit",
        source: "ast_edit",
        state: "proposed",
        files: [{ path: "src/x.ts", count: 1 }],
        replacements: 1,
        diff: "-1:a\n+1:b",
        resolvable: true,
      },
      [],
      "waiting",
    ),
  );
  expect(screen.text()).toContain("Accept or reject it");
  const buttons = [...screen.root.querySelectorAll("button")];
  expect(buttons.map((button) => button.textContent)).toEqual(["Accept", "Reject"]);
  buttons[0]!.click();
  await vi.waitFor(() => expect(resolveCalls).toHaveLength(1));
  expect(resolveCalls[0]).toEqual({
    threadRef: { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
    toolCallId: "ast_edit",
    action: "apply",
  });
});

it("a resolvable card whose item is no longer waiting offers no buttons", async () => {
  // Crash recovery cancels the item; OMP lost the preview with its process.
  await using screen = await show(
    projected(
      "ast_edit",
      {
        kind: "proposed_edit",
        source: "ast_edit",
        state: "proposed",
        files: [],
        replacements: 1,
        diff: "",
        resolvable: true,
      },
      [],
      "cancelled",
    ),
  );
  expect(screen.root.querySelectorAll("button")).toHaveLength(0);
});

it("an applied proposed edit offers no buttons", async () => {
  await using screen = await show(
    projected("ast_edit", {
      kind: "proposed_edit",
      source: "ast_edit",
      state: "applied",
      files: [{ path: "src/x.ts", count: 1 }],
      replacements: 1,
      diff: "-1:a\n+1:b",
    }),
  );
  expect(screen.root.querySelector("[data-omp-proposal=applied]")).not.toBeNull();
  expect(screen.root.querySelectorAll("button")).toHaveLength(0);
});

it("proposed edit card shows the staged state without accept or reject buttons", async () => {
  await using screen = await show(
    projected("ast_edit", {
      kind: "proposed_edit",
      source: "ast_edit",
      state: "proposed",
      files: [{ path: "src/x.ts", count: 2 }],
      replacements: 2,
      diff: "-1:a\n+1:b",
    }),
  );
  expect(screen.root.querySelector("[data-omp-proposal=proposed]")).not.toBeNull();
  expect(screen.text()).toContain("files not modified yet");
  expect(screen.text()).toContain("src/x.ts ×2");
  expect(screen.text()).toContain("+1:b");
  expect(screen.root.querySelectorAll("button")).toHaveLength(0);
});

it("conflict card names the conflict and its resolution", async () => {
  await using screen = await show(
    projected("write", {
      kind: "conflict_resolution",
      target: "conflict://2",
      summary: "Resolved conflict #2 at lines 4–9 in src/a.ts.",
    }),
  );
  expect(screen.text()).toBe("conflict://2: Resolved conflict #2 at lines 4–9 in src/a.ts.");
});

it("debug card shows the stop location, frames and locals", async () => {
  await using screen = await show(
    projected("debug", {
      kind: "debug",
      action: "variables",
      state: "stopped",
      stopReason: "breakpoint",
      location: { name: "main", path: "/w/a.py", line: 3 },
      frames: [{ id: 1, name: "main", path: "/w/a.py", line: 3, column: 1 }],
      variables: [{ name: "x", value: "1", type: "int" }],
    }),
  );
  expect(screen.text()).toContain("variables · stopped (breakpoint)");
  expect(screen.text()).toContain("main at /w/a.py:3");
  expect(screen.text()).toContain("Locals");
  const cells = [...screen.root.querySelectorAll("td")].map((cell) => cell.textContent);
  expect(cells).toEqual(["x", "1", "int"]);
});

it("lsp card shows the action, server and result", async () => {
  await using screen = await show(
    projected("lsp", {
      kind: "lsp",
      action: "hover",
      success: true,
      server: "tsserver",
      target: "src/a.ts · foo",
      text: "function foo(): void",
    }),
  );
  expect(screen.text()).toContain("hover · tsserver · src/a.ts · foo");
  expect(screen.text()).toContain("function foo(): void");
});

it("eval card shows cells and the item's own images inline", async () => {
  await using screen = await show(
    projected(
      "eval",
      {
        kind: "eval",
        language: "python",
        cells: [{ index: 0, code: "plot()", output: "done", status: "complete", durationMs: 12 }],
      },
      [
        { type: "text", text: "(1 image)" },
        { type: "image", data: PNG, mimeType: "image/png" },
      ],
    ),
  );
  expect(screen.text()).toContain("Cell 1 · python · complete · 12 ms");
  expect(screen.text()).toContain("plot()");
  await expect.poll(() => screen.root.querySelectorAll("img").length).toBe(1);
  // The image is the item's own tool-output image, served by T, not a remote URL.
  expect(
    requested.filter((resource) => resource !== null).map((resource) => resource._tag),
  ).toEqual(expect.arrayContaining(["tool-output-image"]));
  expect(
    requested.every((resource) => resource === null || resource._tag === "tool-output-image"),
  ).toBe(true);
});

it("generated image card shows the picture inline with its provider and path", async () => {
  await using screen = await show(
    projected(
      "generate_image",
      {
        kind: "generated_image",
        provider: "openai",
        model: "gpt-image-1",
        paths: ["/tmp/omp-image-1.png"],
      },
      [{ type: "image", data: PNG, mimeType: "image/png" }],
    ),
  );
  await expect.poll(() => screen.root.querySelectorAll("img").length).toBe(1);
  expect(screen.text()).toContain("openai · gpt-image-1");
  expect(screen.text()).toContain("/tmp/omp-image-1.png");
  expect(
    requested.every((resource) => resource === null || resource._tag === "tool-output-image"),
  ).toBe(true);
});

it("speech card plays the audio file OMP wrote", async () => {
  await using screen = await show(
    projected("tts", {
      kind: "speech",
      path: "out/hello.wav",
      mimeType: "audio/wav",
      bytes: 10,
      voice: "sol",
      text: "Hello",
    }),
  );
  expect(requested).toContainEqual({
    _tag: "media-file",
    threadId: THREAD_ID,
    path: "out/hello.wav",
  });
  expect(screen.text()).toContain("hello.wav");
  expect(screen.text()).toContain("Voice sol · 10 bytes");
});

it("memory card shows the operation and its items", async () => {
  await using screen = await show(
    projected("retain", {
      kind: "memory",
      op: "retain",
      items: [{ content: "likes tabs", scope: "project" }],
      text: "1 memories stored.",
    }),
  );
  expect(screen.text()).toContain("Memory retain");
  expect(screen.text()).toContain("likes tabs (project)");
  expect(screen.text()).toContain("1 memories stored.");
});

it("advisor, rule injection and fallback notices show their detail when expanded", async () => {
  const notice = (nativeId: string, title: string, summary: string, detail: string) => {
    const base = projected(nativeId, { kind: "lsp", action: "x", success: true, text: "" });
    const {
      toolName: _toolName,
      input: _input,
      output: _output,
      ...item
    } = base.item as never as Record<string, unknown>;
    return {
      ...base,
      item: {
        ...item,
        title,
        type: "notification",
        source: { kind: "system" },
        outcome: "updated",
        summary,
        detail,
      },
    } as unknown as OrchestrationV2ProjectedTurnItem;
  };
  for (const [title, summary, detail] of [
    ["Advisor", "Advisor: Check the null case", "[blocker · safety] Check the null case"],
    ["Rule injected", "Rule injected: no-any", "no-any (/r/no-any.md)\nNever use any."],
    ["Fallback applied", "Fallback applied: a/m1 → b/m2 (default)", "rate limited"],
  ] as const) {
    await using screen = await render(
      <V2ItemInspector
        projectedItem={notice(title, title, summary, detail)}
        environmentId={ENVIRONMENT_ID}
        onOpenThread={() => {}}
      />,
    );
    expect(
      screen.container.querySelector("[data-v2-item-inspector=notification]")?.textContent,
    ).toBe(detail);
  }
});
