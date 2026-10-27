// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

import {
  ompPrintLaunchArgs,
  ompSessionArgs,
  resolveOmpInstanceLaunch,
  resolveOmpLaunchArgs,
} from "./launch.ts";

const REPO_ROOT = NodeURL.fileURLToPath(new URL("../../../../", import.meta.url));

/** Every non-test TypeScript file under `dir`. */
const sources = (dir: string): ReadonlyArray<string> =>
  NodeFS.readdirSync(NodePath.join(REPO_ROOT, dir), { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
    .map((file) => NodePath.join(REPO_ROOT, dir, file));

describe("omp launch on every platform", () => {
  it("passes the thread overlay as one --config path, never as a PI_CONFIG_FILES list", () => {
    // A Windows path carries `:` and may carry `;`: as a single argv entry neither is a separator.
    const overlay = "C:\\Users\\a;b\\.ompanel\\userdata\\omp\\threads\\t\\overlay.yml";
    const args = ompSessionArgs({
      approvalMode: "always-ask",
      profile: "",
      overlayPath: overlay,
      cwd: "C:\\work",
    });
    assert.deepStrictEqual(args.slice(args.indexOf("--config"), args.indexOf("--config") + 2), [
      "--config",
      overlay,
    ]);
    assert.strictEqual(args.filter((arg) => arg === "--config").length, 1);
  });

  it("never sets PI_CONFIG_FILES or runs `omp config init-xdg`", () => {
    // PI_CONFIG_FILES is split on `:`/`;` and `init-xdg` fails on Windows (docs/omp/processes.md).
    // `omp share` takes no `--config`: "Share as gist" sets one delimiter-free overlay path.
    // That one call site is allowed (docs/omp/thread-menu.md).
    const piConfigFilesExceptions = new Set([
      NodePath.join(REPO_ROOT, "packages/provider-omp/src/server/threadMenuController.ts"),
    ]);
    const offenders = [
      ...sources("packages/provider-omp/src"),
      ...sources("apps/server/src"),
      ...sources("apps/desktop/src"),
    ].filter((file) => {
      const text = NodeFS.readFileSync(file, "utf8");
      return (
        text.includes("init-xdg") ||
        (!piConfigFilesExceptions.has(file) && /PI_CONFIG_FILES["'\]]{0,2}\s*[:=](?!=)/.test(text))
      );
    });
    assert.deepStrictEqual(offenders, []);
  });
});

describe("OMP instance launch settings", () => {
  it("tokenizes launch arguments like a shell, values and quotes included", () => {
    assert.deepStrictEqual(
      resolveOmpLaunchArgs(
        "--thinking high --append-system-prompt 'be brief' --no-lsp -e ./ext.ts",
      ),
      {
        ok: true,
        args: [
          "--thinking",
          "high",
          "--append-system-prompt",
          "be brief",
          "--no-lsp",
          "-e",
          "./ext.ts",
        ],
      },
    );
    assert.deepStrictEqual(resolveOmpLaunchArgs(""), { ok: true, args: [] });
    // An unknown flag may be an extension flag that takes a value.
    assert.deepStrictEqual(resolveOmpLaunchArgs("--my-ext-flag on"), {
      ok: true,
      args: ["--my-ext-flag", "on"],
    });
  });

  it.each([
    ["--mode json", "--mode"],
    ["--mode=json", "--mode"],
    ["--cwd /tmp", "--cwd"],
    ["--profile work", "--profile"],
    ["--config extra.yml", "--config"],
    ["--approval-mode yolo", "--approval-mode"],
    ["--yolo", "--yolo"],
    ["--session abc", "--session"],
    ["--session-dir /tmp/s", "--session-dir"],
    ["--no-session", "--no-session"],
    ["--resume", "--resume"],
    ["-c", "-c"],
    ["--model openai/gpt-5", "--model"],
    ["--no-ui", "--no-ui"],
    ["-p", "-p"],
  ])("refuses %j, a flag Ompanel sets", (launchArgs, flag) => {
    const resolved = resolveOmpLaunchArgs(launchArgs);
    assert.isFalse(resolved.ok);
    if (!resolved.ok) assert.include(resolved.message, `'${flag}'`);
  });

  it.each(["hello", "--no-lsp hello", "--thinking=high hello", "--thinking high -- x", "-"])(
    "refuses %j, which OMP would read as a prompt",
    (launchArgs) => {
      const resolved = resolveOmpLaunchArgs(launchArgs);
      assert.isFalse(resolved.ok);
      if (!resolved.ok) assert.include(resolved.message, "prompt");
    },
  );

  it.each(["--api-key sk-secret", "--api-key=sk-secret", "--no-lsp --api-key sk-secret"])(
    "refuses %j, a credential every omp's argv would show",
    (launchArgs) => {
      const resolved = resolveOmpLaunchArgs(launchArgs);
      assert.isFalse(resolved.ok);
      if (!resolved.ok) {
        assert.include(resolved.message, "'--api-key'");
        assert.include(resolved.message, "environment variable");
        assert.notInclude(resolved.message, "sk-secret");
      }
    },
  );

  it("gives omp -p only flags that change how the model answers, never tools or code", () => {
    const resolved = resolveOmpLaunchArgs(
      "--tools read,bash --thinking high -e ./ext.ts --extension=./b.ts --hook ./h.ts " +
        "--plugin-dir /p --trusted-extension ./t.ts --my-ext-flag on --service-tier=flex " +
        "--no-lsp --advisor --append-system-prompt 'be brief' --tools=bash",
    );
    assert.isTrue(resolved.ok);
    if (!resolved.ok) return;
    assert.deepStrictEqual(ompPrintLaunchArgs(resolved.args), [
      "--thinking",
      "high",
      "--service-tier=flex",
      "--no-lsp",
    ]);
    assert.deepStrictEqual(ompPrintLaunchArgs([]), []);
  });

  it("points PI_CODING_AGENT_DIR at the agent dir, ~ expanded, without an inherited profile", () => {
    const resolved = resolveOmpInstanceLaunch({
      agentDir: "~/omp-work/agent",
      launchArgs: "--no-lsp",
      profile: "",
      environment: { PATH: "/usr/bin", OMP_PROFILE: "env", PI_PROFILE: "env", KEEP: "1" },
      homeDir: "/home/u",
    });
    assert.deepStrictEqual(resolved, {
      ok: true,
      environment: {
        PATH: "/usr/bin",
        KEEP: "1",
        PI_CODING_AGENT_DIR: NodePath.join("/home/u", "omp-work/agent"),
      },
      launchArgs: ["--no-lsp"],
    });
  });

  it("leaves the environment alone without an agent dir", () => {
    const environment = { PATH: "/usr/bin", OMP_PROFILE: "env" };
    const resolved = resolveOmpInstanceLaunch({
      agentDir: "",
      launchArgs: "",
      profile: "",
      environment,
      homeDir: "/home/u",
    });
    assert.isTrue(resolved.ok);
    if (resolved.ok) assert.strictEqual(resolved.environment, environment);
  });

  it("refuses an agent dir beside a profile, which would outrank it", () => {
    const resolved = resolveOmpInstanceLaunch({
      agentDir: "/srv/agent",
      launchArgs: "",
      profile: "work",
      environment: {},
      homeDir: "/home/u",
    });
    assert.isFalse(resolved.ok);
    if (!resolved.ok) assert.include(resolved.message, "not both");
  });

  it("appends launch arguments after Ompanel's thread flags", () => {
    const args = ompSessionArgs({
      approvalMode: "always-ask",
      profile: "",
      overlayPath: "/o.yml",
      cwd: "/w",
      launchArgs: ["--thinking", "high"],
    });
    assert.deepStrictEqual(args.slice(-2), ["--thinking", "high"]);
    assert.deepStrictEqual(args.slice(0, 4), ["--mode", "rpc-ui", "--approval-mode", "always-ask"]);
  });
});
