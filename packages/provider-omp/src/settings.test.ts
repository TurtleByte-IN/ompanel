import { assert, describe, it } from "@effect/vitest";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { OmpSettings } from "./settings.ts";

const decode = Schema.decodeUnknownResult(OmpSettings);

describe("OmpSettings.enabled", () => {
  // Z-09: a fresh profile (no saved OMP settings) must start with OMP on; only an explicit
  // `enabled: false` turns it off.
  it("is on when the profile has no saved OMP settings", () => {
    const decoded = decode({});
    assert.isTrue(Result.isSuccess(decoded));
    if (Result.isSuccess(decoded)) assert.isTrue(decoded.success.enabled);
  });

  it("is on when only other fields were saved", () => {
    const decoded = decode({ binaryPath: "/opt/omp/bin/omp" });
    assert.isTrue(Result.isSuccess(decoded));
    if (Result.isSuccess(decoded)) assert.isTrue(decoded.success.enabled);
  });

  it("keeps an explicit off", () => {
    const decoded = decode({ enabled: false });
    assert.isTrue(Result.isSuccess(decoded));
    if (Result.isSuccess(decoded)) assert.isFalse(decoded.success.enabled);
  });
});

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
