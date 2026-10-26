// @effect-diagnostics nodeBuiltinImport:off - Scans tracked files on disk.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

// Upstream marks that must not reappear in user-facing sources. See docs/omp/branding.md.
const MARKS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: "T3 Code", pattern: /T3 Code/ },
  { name: "t3.codes", pattern: /t3\.codes/ },
  { name: "T3CODE_", pattern: /T3CODE_/ },
  { name: "Theo's handle", pattern: /t3dotgg|@theo\b/ },
];

const REPOSITORY_ROOT = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);

// Tests, recorded provider transcripts and vendored sources are not user-facing.
const NOT_USER_FACING: ReadonlyArray<RegExp> = [
  /^\.repos\//,
  /\.test\.[cm]?[jt]sx?$/,
  /\.ndjson$/,
  /\/(?:fixtures|testkit|__snapshots__)\//,
  /^apps\/server\/scripts\//,
  /^LICENSE$/,
  // Dependency patches must match the lockfile's hashes byte for byte.
  /^patches\//,
  /\.(?:png|jpe?g|webp|gif|ico|icns|woff2?|ttf|otf|wasm|zip|gz)$/,
  // Rebranded in its own pull request (feature/rebrand-ompanel-marketing), which drops this line.
  /^apps\/marketing\//,
];

interface Allowance {
  readonly path: string;
  readonly marks: ReadonlyArray<string>;
  readonly reason: string;
}

// Mirrors "Names kept on purpose" and "Hosted services" in docs/omp/branding.md. An entry
// allows the listed marks anywhere in that file; keep it as narrow as the file allows.
const ALLOWLIST: ReadonlyArray<Allowance> = [
  {
    path: "docs/omp/branding.md",
    marks: ["T3 Code", "t3.codes", "T3CODE_"],
    reason: "branding record",
  },
  { path: "packages/shared/src/brand.ts", marks: ["T3 Code"], reason: "UPSTREAM_PRODUCT_NAME" },
  { path: "README.md", marks: ["T3 Code"], reason: "fork attribution" },
  { path: "AGENTS.md", marks: ["T3 Code"], reason: "fork attribution" },
  {
    path: "apps/mobile/modules/t3-source-text/UPSTREAM.md",
    marks: ["T3 Code"],
    reason: "third-party modification notice",
  },
  // Migration inputs.
  { path: "docs/user/install.md", marks: ["T3 Code", "T3CODE_"], reason: "Moving from T3 Code" },
  { path: "apps/server/src/legacyHomeMigration.ts", marks: ["T3 Code"], reason: "~/.t3 migration" },
  {
    path: "apps/desktop/src/app/DesktopUserData.ts",
    marks: ["T3 Code"],
    reason: "legacy profile names",
  },
  {
    path: "apps/desktop/src/app/DesktopLegacyLocalStorage.ts",
    marks: ["T3 Code"],
    reason: "legacy profile names",
  },
  // Upstream project file format.
  { path: "t3.json", marks: ["t3.codes"], reason: "upstream t3.json schema URL" },
  {
    path: "packages/contracts/src/t3ProjectFile.ts",
    marks: ["t3.codes", "T3 Code"],
    reason: "t3.json schema URL",
  },
  {
    path: "docs/internals/product-analytics.md",
    marks: ["t3.codes"],
    reason: "names the removed default",
  },
  // Hosted infrastructure with no Ompanel equivalent yet (blocker B-003): upstream's hosted web
  // app, relay and Clerk. Only reachable when a build opts into them.
  { path: ".env.example", marks: ["t3.codes"], reason: "B-003 hosted relay/app" },
  { path: "apps/web/vercel.ts", marks: ["t3.codes"], reason: "B-003 hosted app router" },
  { path: "apps/mobile/app.config.ts", marks: ["t3.codes"], reason: "B-003 Clerk passkey domain" },
  { path: "infra/relay/src/monitoring.ts", marks: ["t3.codes"], reason: "B-003 relay monitoring" },
  { path: "docs/operations/release.md", marks: ["t3.codes"], reason: "B-003 hosted app channels" },
  { path: "docs/operations/relay-observability.md", marks: ["t3.codes"], reason: "B-003 relay" },
  { path: ".github/workflows/release.yml", marks: ["t3.codes"], reason: "B-003 hosted app deploy" },
];

function trackedFiles(): ReadonlyArray<string> {
  return NodeChildProcess.execFileSync("git", ["ls-files", "-z"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  })
    .split("\0")
    .filter((path) => path.length > 0 && !NOT_USER_FACING.some((rule) => rule.test(path)));
}

describe("upstream brand marks", () => {
  it("appear in user-facing sources only where docs/omp/branding.md keeps them", () => {
    const allowed = new Map(ALLOWLIST.map((entry) => [entry.path, new Set(entry.marks)]));
    const findings: string[] = [];
    for (const path of trackedFiles()) {
      const absolute = NodePath.join(REPOSITORY_ROOT, path);
      if (!NodeFS.existsSync(absolute) || NodeFS.statSync(absolute).isDirectory()) continue;
      const text = NodeFS.readFileSync(absolute, "utf8");
      if (text.includes("\0")) continue;
      const lines = text.split("\n");
      for (const mark of MARKS) {
        if (allowed.get(path)?.has(mark.name)) continue;
        lines.forEach((line, index) => {
          if (mark.pattern.test(line)) findings.push(`${path}:${index + 1}: ${mark.name}`);
        });
      }
    }
    expect(findings).toEqual([]);
  });

  it("has no stale allowlist entries", () => {
    const stale = ALLOWLIST.filter((entry) => {
      const absolute = NodePath.join(REPOSITORY_ROOT, entry.path);
      if (!NodeFS.existsSync(absolute)) return true;
      const text = NodeFS.readFileSync(absolute, "utf8");
      return !entry.marks.some((name) =>
        MARKS.find((mark) => mark.name === name)?.pattern.test(text),
      );
    }).map((entry) => entry.path);
    expect(stale).toEqual([]);
  });
});
