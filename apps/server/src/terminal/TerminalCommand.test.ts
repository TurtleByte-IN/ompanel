import { describe, expect, it } from "@effect/vitest";

import { wrapCommandForCompletion } from "./TerminalCommand.ts";

const sentinel = "__DONE___abc:";

describe("wrapCommandForCompletion", () => {
  it("isolates a posix command in a subshell", () => {
    expect(wrapCommandForCompletion("cd x\nmake", "posix", sentinel, "subshell")).toBe(
      `( cd x\rmake\r); printf '\\n${sentinel}%s\\n' "$?"`,
    );
  });

  it("runs a posix command in the current shell, closing the group on its own line", () => {
    expect(wrapCommandForCompletion("cd x\nmake", "posix", sentinel, "current")).toBe(
      `{ cd x\rmake\r}; printf '\\n${sentinel}%s\\n' "$?"`,
    );
  });

  it("keeps fish in begin/end for either scope", () => {
    const wrapped = `begin\rcd x\rend; printf '\\n${sentinel}%s\\n' $status`;
    expect(wrapCommandForCompletion("cd x", "fish", sentinel, "subshell")).toBe(wrapped);
    expect(wrapCommandForCompletion("cd x", "fish", sentinel, "current")).toBe(wrapped);
  });

  it("calls a PowerShell block in a child scope or dot-sources it into the current one", () => {
    expect(wrapCommandForCompletion("cd x", "powershell", sentinel, "subshell")).toMatch(
      /^\$global:LASTEXITCODE = \$null; & \{\rcd x\r\};/,
    );
    expect(wrapCommandForCompletion("cd x", "powershell", sentinel, "current")).toMatch(
      /^\$global:LASTEXITCODE = \$null; \. \{\rcd x\r\};/,
    );
  });
});
