// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - a build helper: git, bun and the fork's scripts.
// Builds the `omp` the end-to-end test runs, from the fork release `omp.lock` pins:
// `node apps/web/e2e/omp/build-omp.ts <checkout-dir>`. Clones the public fork at the pinned tag
// when the directory does not exist, refuses a checkout at another commit, and prints the
// binary's path. See docs/omp/testing.md.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

interface OmpLock {
  readonly repository: string;
  readonly tag: string;
  readonly commit: string;
  readonly version: string;
}

const lock = JSON.parse(
  NodeFS.readFileSync(
    new URL("../../../../packages/provider-omp/omp.lock", import.meta.url),
    "utf8",
  ),
) as OmpLock;

const checkout = process.argv[2];
if (checkout === undefined) throw new Error("usage: build-omp.ts <checkout-dir>");
const bun = process.env.T3_BUN_BIN ?? "bun";

const run = (command: string, args: ReadonlyArray<string>, cwd: string) => {
  console.error(`$ ${command} ${args.join(" ")}  (in ${cwd})`);
  NodeChildProcess.execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });
};

if (!NodeFS.existsSync(checkout)) {
  const url = `https://github.com/${lock.repository}.git`;
  run("git", ["clone", "--depth", "1", "--branch", lock.tag, url, checkout], process.cwd());
}
const head = NodeChildProcess.execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], {
  encoding: "utf8",
}).trim();
if (head !== lock.commit) {
  throw new Error(
    `${checkout} is at ${head}; omp.lock pins ${lock.tag} (${lock.commit}). Check out the pinned tag.`,
  );
}

const agent = NodePath.join(checkout, "packages", "coding-agent");
const binary = NodePath.resolve(agent, "dist", "omp");
// The fork's version string is the same for every `-ompanel.<n>` tag, so the commit is stamped.
const stamp = `${binary}.commit`;
const built =
  NodeFS.existsSync(binary) &&
  NodeFS.existsSync(stamp) &&
  NodeFS.readFileSync(stamp, "utf8").trim() === lock.commit;
if (!built) {
  run(bun, ["install", "--frozen-lockfile"], checkout);
  run(bun, ["--cwd=packages/natives", "run", "build"], checkout);
  run(bun, ["scripts/build-binary.ts"], agent);
  NodeFS.writeFileSync(stamp, `${lock.commit}\n`);
}

const version = NodeChildProcess.execFileSync(binary, ["--version"], { encoding: "utf8" }).trim();
if (version !== `omp/${lock.version}`) {
  throw new Error(`${binary} reports ${version}; omp.lock expects omp/${lock.version}.`);
}
console.log(binary);
