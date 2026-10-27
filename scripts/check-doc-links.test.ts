// @effect-diagnostics nodeBuiltinImport:off - Writes Markdown fixtures to a temp directory.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { checkFile, slug } from "./check-doc-links.ts";

function fixture(files: Record<string, string>): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "doc-links-"));
  for (const [name, text] of Object.entries(files))
    NodeFS.writeFileSync(NodePath.join(dir, name), text);
  return dir;
}

describe("check-doc-links", () => {
  it("reports a broken link whose text wraps onto the next line, at its first line", () => {
    const dir = fixture({ "a.md": "intro\nsee [the\nother page](./missing.md) here\n" });
    const errors = checkFile(NodePath.join(dir, "a.md"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/a\.md:2: missing \.\/missing\.md$/);
  });

  it("accepts a wrapped link and an anchor from a heading with a code span", () => {
    const dir = fixture({
      "a.md": "[the\nlist](./b.md#omp-skill-list-dir---json)\n",
      "b.md": "# `omp skill list <dir> --json`\n",
    });
    expect(checkFile(NodePath.join(dir, "a.md"))).toEqual([]);
  });

  it("drops raw HTML from heading slugs", () => {
    expect(slug("Title <sup>beta</sup>")).toBe("title-beta");
  });
});
