import type { OrchestrationV2SubagentTranscriptPage } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { applyTranscriptPage, EMPTY_SUBAGENT_TRANSCRIPT } from "./subagentTranscript";

const page = (
  fromByte: number,
  nextByte: number,
  texts: ReadonlyArray<string>,
  reset = false,
): OrchestrationV2SubagentTranscriptPage => ({
  fromByte,
  nextByte,
  reset,
  entries: texts.map((text) => ({ role: "assistant", text })),
});

const texts = (state: { entries: ReadonlyArray<{ text: string }> }) =>
  state.entries.map((entry) => entry.text);

describe("applyTranscriptPage", () => {
  it("appends pages and advances nextByte", () => {
    const first = applyTranscriptPage(EMPTY_SUBAGENT_TRANSCRIPT, page(0, 40, ["one", "two"]));
    const second = applyTranscriptPage(first, page(40, 90, ["three"]));
    expect(texts(second)).toEqual(["one", "two", "three"]);
    expect(second.nextByte).toBe(90);
  });

  it("keeps the same state for an empty page at the end", () => {
    const first = applyTranscriptPage(EMPTY_SUBAGENT_TRANSCRIPT, page(0, 40, ["one"]));
    expect(applyTranscriptPage(first, page(40, 40, []))).toBe(first);
  });

  it("replaces everything on reset", () => {
    const first = applyTranscriptPage(EMPTY_SUBAGENT_TRANSCRIPT, page(0, 40, ["one", "two"]));
    const reset = applyTranscriptPage(first, page(0, 12, ["fresh"], true));
    expect(texts(reset)).toEqual(["fresh"]);
    expect(reset.nextByte).toBe(12);
  });

  it("ignores a stale page that does not start at nextByte", () => {
    const first = applyTranscriptPage(EMPTY_SUBAGENT_TRANSCRIPT, page(0, 40, ["one"]));
    expect(applyTranscriptPage(first, page(0, 40, ["one"]))).toBe(first);
    expect(applyTranscriptPage(first, page(55, 80, ["gap"]))).toBe(first);
  });
});
