import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { OmpSettings } from "./settings.ts";

const decode = Schema.decodeUnknownResult(OmpSettings);

describe("OmpSettings.binaryPath", () => {
  it.each([
    "",
    "/opt/omp/bin/omp",
    "~/bin/omp",
    "C:\\Tools\\omp.exe",
    "d:/omp.exe",
    "\\\\host\\share\\omp.exe",
  ])("accepts %j", (binaryPath) => {
    assert.isTrue(Result.isSuccess(decode({ binaryPath })));
  });

  it.each(["omp", "./omp", "bin/omp", "~omp"])("rejects the relative path %j", (binaryPath) => {
    assert.isTrue(Result.isFailure(decode({ binaryPath })));
  });
});
