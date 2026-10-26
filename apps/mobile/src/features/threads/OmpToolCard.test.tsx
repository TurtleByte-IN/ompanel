// One test per OMP card kind, with cards shaped as packages/provider-omp/src/server/ompCards.ts
// builds them, rendered through the mobile work-log card.
import { OMP_CARD_OUTPUT_KEY, readOmpToolCard, type OmpToolCard as Card } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <p className={className}>{children}</p>
  ),
}));

import { OmpToolCard } from "./OmpToolCard";

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

function render(card: Card, renderAudio?: (path: string) => ReactNode) {
  // Cards reach the client inside the dynamic_tool output, beside OMP's content blocks.
  const parsed = readOmpToolCard({ content: [], [OMP_CARD_OUTPUT_KEY]: card });
  if (parsed === null) throw new Error(`${card.kind} card did not parse`);
  act(() =>
    root.render(
      renderAudio === undefined ? (
        <OmpToolCard card={parsed} />
      ) : (
        <OmpToolCard card={parsed} renderAudio={renderAudio} />
      ),
    ),
  );
  const element = container.querySelector(`[data-testid="omp-card-${card.kind}"]`);
  if (element === null) throw new Error(`${card.kind} card not rendered`);
  return Array.from(element.querySelectorAll("p"), (line) => line.textContent);
}

describe("OmpToolCard (mobile)", () => {
  it("renders ask answers with Other text, notes and timeouts", () => {
    expect(
      render({
        kind: "ask",
        chatRedirect: true,
        answers: [
          { question: "Which parts?", multi: true, selected: ["API", "Web"], custom: "CLI" },
          { question: "Tone?", multi: false, selected: [], note: "skipped", timedOut: true },
        ],
      }),
    ).toEqual([
      "The user chose to discuss in chat.",
      "Which parts?",
      "API, Web, Other: CLI",
      "Tone?",
      "Timed out (skipped)",
    ]);
  });

  it("renders a proposed edit with its state, files, reason and diff", () => {
    const lines = render({
      kind: "proposed_edit",
      source: "ast_edit",
      state: "proposed",
      files: [{ path: "src/a.ts", count: 2 }],
      replacements: 2,
      diff: "-old\n+new",
      reason: "rename",
    });
    expect(lines).toEqual([
      "Proposed: files not modified yet. The agent applies or discards it. · 2 replacements",
      "src/a.ts ×2",
      "Reason: rename",
      "-old\n+new",
    ]);
    expect(container.querySelector("p")?.className).toContain("text-warning-foreground");
    render({ ...applied(), state: "discarded" });
    expect(container.querySelector("p")?.className).toContain("line-through");
  });

  it("renders a conflict resolution with its target and resolved path", () => {
    expect(
      render({
        kind: "conflict_resolution",
        target: "conflict://1",
        resolvedPath: "src/a.ts",
        summary: "kept ours",
      }),
    ).toEqual(["conflict://1", "kept ours", "src/a.ts"]);
  });

  it("renders the debug inspector: location, frames, scopes, locals, evaluation", () => {
    expect(
      render({
        kind: "debug",
        action: "stack",
        state: "stopped",
        stopReason: "breakpoint",
        location: { name: "main", path: "src/a.ts", line: 4 },
        frames: [{ id: 1, name: "main", path: "src/a.ts", line: 4, column: 1 }],
        scopes: [{ name: "Locals", reference: 3 }],
        variables: [{ name: "x", value: "1", type: "number" }],
        evaluation: { result: "2", type: "number" },
      }),
    ).toEqual([
      "stack · stopped (breakpoint)",
      "main at src/a.ts:4",
      "Frames",
      "main src/a.ts:4",
      "Scopes",
      "Locals",
      "Locals",
      "x = 1 : number",
      "= 2 : number",
    ]);
  });

  it("renders an LSP result and marks a failure", () => {
    expect(
      render({
        kind: "lsp",
        action: "definition",
        success: false,
        server: "tsserver",
        target: "src/a.ts",
        text: "no definition",
      }),
    ).toEqual(["definition · tsserver · src/a.ts", "no definition"]);
    expect(container.querySelector("p")?.className).toContain("text-danger-foreground");
  });

  it("renders eval cells with code, output, status and duration", () => {
    expect(
      render({
        kind: "eval",
        language: "py",
        cells: [{ index: 0, code: "1+1", output: "2", status: "ok", durationMs: 12 }],
      }),
    ).toEqual(["Cell 1 · py · ok · 12 ms", "1+1", "2"]);
  });

  it("renders a generated image's provider, model, saved paths and text", () => {
    expect(
      render({
        kind: "generated_image",
        provider: "openai",
        model: "gpt-image-1",
        paths: ["/tmp/cat.png"],
        responseText: "A cat",
      }),
    ).toEqual(["openai · gpt-image-1", "/tmp/cat.png", "A cat"]);
  });

  it("renders speech through the audio renderer, with voice and size", () => {
    const requested: string[] = [];
    const lines = render(
      {
        kind: "speech",
        path: "out/hello.wav",
        mimeType: "audio/wav",
        bytes: 2048,
        voice: "alloy",
        text: "Hello",
      },
      (path) => {
        requested.push(path);
        return <p>player</p>;
      },
    );
    expect(requested).toEqual(["out/hello.wav"]);
    expect(lines).toEqual(["player", "Voice alloy · 2048 bytes", "Hello"]);
  });

  it("renders a memory operation with its items", () => {
    expect(
      render({
        kind: "memory",
        op: "recall",
        query: "deploys",
        items: [{ content: "Deploys run Fridays", scope: "project" }],
        text: "1 memory",
      }),
    ).toEqual(["Memory recall: deploys", "• Deploys run Fridays (project)", "1 memory"]);
  });
});

function applied(): Extract<Card, { kind: "proposed_edit" }> {
  return {
    kind: "proposed_edit",
    source: "ast_edit",
    state: "applied",
    files: [],
    replacements: 1,
    diff: "",
  };
}
