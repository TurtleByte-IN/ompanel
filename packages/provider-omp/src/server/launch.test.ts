// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { assert, describe, it } from "@effect/vitest";

import { ompSessionArgs } from "./launch.ts";

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
    // OMP splits PI_CONFIG_FILES on `:` (Unix) or `;` (Windows); Ompanel avoids that by passing
    // `--config`. `init-xdg` exits non-zero on Windows and moves nothing, so Ompanel follows
    // whatever directories OMP already resolves instead (docs/omp/processes.md).
    const offenders = [
      ...sources("packages/provider-omp/src"),
      ...sources("apps/server/src"),
      ...sources("apps/desktop/src"),
    ].filter((file) => {
      const text = NodeFS.readFileSync(file, "utf8");
      return text.includes("init-xdg") || /PI_CONFIG_FILES["'\]]{0,2}\s*[:=](?!=)/.test(text);
    });
    assert.deepStrictEqual(offenders, []);
  });
});
