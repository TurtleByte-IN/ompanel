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

describe("OmpSettings.profile", () => {
  it.each(["", "work", "client-a", "v1.2_beta", "0day", "a".repeat(64)])(
    "accepts %j",
    (profile) => {
      const decoded = decode({ profile });
      assert.isTrue(Result.isSuccess(decoded));
      if (Result.isSuccess(decoded)) assert.strictEqual(decoded.success.profile, profile);
    },
  );

  it("trims the name and defaults to the default profile", () => {
    const trimmed = decode({ profile: "  work  " });
    assert.isTrue(Result.isSuccess(trimmed) && trimmed.success.profile === "work");
    const absent = decode({});
    assert.isTrue(Result.isSuccess(absent) && absent.success.profile === "");
  });

  it.each([
    "Work",
    "my profile",
    "-work",
    ".work",
    "_work",
    "work.",
    "../work",
    "work/sub",
    "a".repeat(65),
    "con",
    "NUL.txt",
    "com1",
  ])("rejects %j with OMP's profile-name rule", (profile) => {
    const decoded = decode({ profile });
    assert.isTrue(Result.isFailure(decoded));
    if (Result.isFailure(decoded)) assert.include(String(decoded.failure), "an OMP profile name");
  });
});
