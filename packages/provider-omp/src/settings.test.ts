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

describe("OmpSettings.agentDir and launchArgs", () => {
  it("decodes both to empty by default", () => {
    const decoded = decode({});
    assert.isTrue(Result.isSuccess(decoded));
    if (Result.isSuccess(decoded)) {
      assert.strictEqual(decoded.success.agentDir, "");
      assert.strictEqual(decoded.success.launchArgs, "");
    }
  });

  it.each(["/srv/omp/agent", "~/.omp-work/agent", "C:\\omp\\agent"])(
    "accepts the agent dir %j",
    (agentDir) => {
      assert.isTrue(Result.isSuccess(decode({ agentDir })));
    },
  );

  it.each(["agent", "./agent", ".omp/agent"])("rejects the relative agent dir %j", (agentDir) => {
    assert.isTrue(Result.isFailure(decode({ agentDir })));
  });

  it("keeps launch arguments as written, trimmed", () => {
    const decoded = decode({ launchArgs: "  --thinking high --append-system-prompt 'be brief'  " });
    assert.isTrue(Result.isSuccess(decoded));
    if (Result.isSuccess(decoded)) {
      assert.strictEqual(
        decoded.success.launchArgs,
        "--thinking high --append-system-prompt 'be brief'",
      );
    }
  });
});
