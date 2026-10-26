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
});
