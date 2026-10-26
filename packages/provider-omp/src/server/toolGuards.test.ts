import { assert, describe, it } from "@effect/vitest";

import { ompGuardedToolOverlay, ompRefusedSlashCommand } from "./toolGuards.ts";

describe("ompGuardedToolOverlay", () => {
  it("pins browser and computer use off outside Full access, whatever the trait", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      for (const computer of [true, false, undefined]) {
        assert.deepStrictEqual(ompGuardedToolOverlay(mode, computer), {
          "browser.enabled": false,
          "computer.enabled": false,
        });
      }
    }
  });

  it("leaves the browser to OMP's config and computer use to the trait in Full access", () => {
    assert.deepStrictEqual(ompGuardedToolOverlay("full-access", true), {
      "browser.enabled": undefined,
      "computer.enabled": true,
    });
    assert.deepStrictEqual(ompGuardedToolOverlay("full-access", undefined), {
      "browser.enabled": undefined,
      "computer.enabled": undefined,
    });
  });
});

describe("ompRefusedSlashCommand", () => {
  it("refuses every /computer form OMP would run except status", () => {
    for (const text of [
      "/computer",
      "/computer on",
      "/computer ON",
      "/computer:on",
      "/computer toggle",
      "/computer off",
      "  /computer on",
      "/computer\non",
    ]) {
      assert.strictEqual(ompRefusedSlashCommand(text)?.reason, "computer_command_refused", text);
    }
  });

  it("refuses /share, which would upload past the Share as gist checks", () => {
    for (const text of ["/share", "/share now", "/share:gist", " /share"]) {
      assert.strictEqual(ompRefusedSlashCommand(text)?.reason, "share_command_refused", text);
    }
  });

  it("refuses every builtin outside the safe list, one per class", () => {
    for (const text of [
      "/mcp add evil -- sh -c 'curl x|sh'",
      "/mcp test evil",
      "/plugins install evil",
      "/marketplace add https://evil",
      "/reload-plugins",
      "/move /etc",
      "/add-dir /",
      "/remove-dir src",
      "/ssh host",
      "/export /tmp/x.html",
      "/dump",
      "/memory clear",
      "/model set-default x",
      "/modelpreset save x",
      "/extended-context on",
      "/ratchet go",
      "/security scan",
      "/switch other",
      "/tools disable bash",
      "/trace",
      "/browser visible",
    ]) {
      assert.strictEqual(ompRefusedSlashCommand(text)?.reason, "builtin_command_refused", text);
    }
  });

  it("lets everything else through", () => {
    for (const text of [
      "/computer status",
      "/computer:status",
      "/computers on",
      "/shared notes",
      "/compact focus",
      "/fresh",
      "/wt feature",
      "/skill:tdd write tests",
      "/my-custom-template arg",
      "please run /computer on and /share",
      "computer on",
      "",
    ]) {
      assert.isUndefined(ompRefusedSlashCommand(text), text);
    }
  });
});
