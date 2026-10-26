// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import * as Brand from "./brand.ts";

describe("brand", () => {
  it("ships no hosted app, so pairing credentials never default to an upstream origin", () => {
    expect(Brand.HOSTED_APP_URL).toBeUndefined();
  });

  it("names no upstream web origin in any default", () => {
    for (const [name, value] of Object.entries(Brand)) {
      if (typeof value === "string") expect(value, name).not.toContain("t3.codes");
    }
  });

  it("ships no upstream Clerk instance or relay in the copyable source-build env", () => {
    const envExample = NodeFS.readFileSync(
      new URL("../../../.env.example", import.meta.url),
      "utf8",
    );
    const values = envExample
      .split("\n")
      .filter((line) => line.trim().length > 0 && !line.trimStart().startsWith("#"));
    for (const line of values) {
      expect(line).not.toMatch(/t3\.codes|pk_live_|t3-relay|hzxSgY2cH10sDU2r/u);
    }
  });
});
