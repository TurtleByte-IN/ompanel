// @effect-diagnostics nodeBuiltinImport:off - fixtures build real folders, files and links.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import { OmpAgentFileRef, OmpAgentFilesOperationError } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeOmpAgentFilesController, ompAgentDirFiles } from "./agentFiles.ts";
import { makeOmpControlService, type OmpControlTarget } from "./control.ts";

// Links behave differently on Windows (they need privileges); the rules are POSIX-tested.
const posixOnly = describe.skipIf(HostProcess.Platform.defaultValue() === "win32");

const WATCHDOG: OmpAgentFileRef = { kind: "watchdog" };
const agent = (name: string): OmpAgentFileRef => ({ kind: "agent", name });
const version = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** The reason a refused call fails with. */
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (cause) {
    return cause instanceof Error && "reason" in cause ? cause.reason : "thrown";
  }
  return "resolved";
};

let base: string;
/** `~/.omp/profiles/work/agent`: what `omp config path` prints for profile `work`. */
let agentDir: string;
/** A folder beside the agent directory that nothing may reach. */
let outside: string;

beforeEach(() => {
  base = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-agent-files-")),
  );
  agentDir = NodePath.join(base, ".omp", "profiles", "work", "agent");
  outside = NodePath.join(base, "outside");
  NodeFS.mkdirSync(agentDir, { recursive: true });
  NodeFS.mkdirSync(outside);
  NodeFS.writeFileSync(NodePath.join(outside, "secret.md"), "outside\n");
});

afterEach(() => {
  NodeFS.rmSync(base, { recursive: true, force: true });
});

posixOnly("OMP agent directory files", () => {
  it("creates, reads and updates WATCHDOG.yml only at the version it was read", async () => {
    const files = ompAgentDirFiles(agentDir);
    assert.deepStrictEqual(await files.list(), {
      agentDir,
      watchdogFileName: "WATCHDOG.yml",
      watchdogExists: false,
      agents: [],
    });
    assert.deepStrictEqual(await files.read(WATCHDOG), {
      file: WATCHDOG,
      relativePath: "WATCHDOG.yml",
    });

    const roster = "advisors:\n  - name: Security\n";
    const created = await files.write({ file: WATCHDOG, content: roster, baseVersion: undefined });
    assert.strictEqual(created.version, version(roster));
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(agentDir, "WATCHDOG.yml"), "utf8"),
      roster,
    );

    // A second create, or an edit from a stale read, would overwrite someone else's change.
    assert.strictEqual(
      await refusal(files.write({ file: WATCHDOG, content: "x", baseVersion: undefined })),
      "conflict",
    );
    assert.strictEqual(
      await refusal(files.write({ file: WATCHDOG, content: "x", baseVersion: version("stale") })),
      "conflict",
    );

    NodeFS.chmodSync(NodePath.join(agentDir, "WATCHDOG.yml"), 0o600);
    const next = "advisors: []\n";
    await files.write({ file: WATCHDOG, content: next, baseVersion: created.version });
    assert.deepStrictEqual(await files.read(WATCHDOG), {
      file: WATCHDOG,
      relativePath: "WATCHDOG.yml",
      content: next,
      version: version(next),
    });
    assert.strictEqual(
      NodeFS.statSync(NodePath.join(agentDir, "WATCHDOG.yml")).mode & 0o777,
      0o600,
    );
    // No temporary file is left beside it.
    assert.deepStrictEqual(NodeFS.readdirSync(agentDir).toSorted(), ["WATCHDOG.yml"]);
  });

  it("edits an existing WATCHDOG.yaml in place, as OMP's own editor does", async () => {
    NodeFS.writeFileSync(NodePath.join(agentDir, "WATCHDOG.yaml"), "advisors: []\n");
    const files = ompAgentDirFiles(agentDir);
    const list = await files.list();
    assert.strictEqual(list.watchdogFileName, "WATCHDOG.yaml");
    assert.isTrue(list.watchdogExists);
    const read = await files.read(WATCHDOG);
    assert.strictEqual(read.relativePath, "WATCHDOG.yaml");
    await files.write({ file: WATCHDOG, content: "advisors:\n", baseVersion: read.version });
    assert.isFalse(NodeFS.existsSync(NodePath.join(agentDir, "WATCHDOG.yml")));
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(agentDir, "WATCHDOG.yaml"), "utf8"),
      "advisors:\n",
    );
  });

  it("creates agents/ on the first agent, lists `.md` files and deletes at the read version", async () => {
    const files = ompAgentDirFiles(agentDir);
    const body = "---\nname: reviewer\ndescription: Reviews diffs\n---\nReview the diff.\n";
    await files.write({ file: agent("reviewer.md"), content: body, baseVersion: undefined });
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(agentDir, "agents", "reviewer.md"), "utf8"),
      body,
    );
    NodeFS.writeFileSync(NodePath.join(agentDir, "agents", "notes.txt"), "not an agent");
    NodeFS.writeFileSync(NodePath.join(agentDir, "agents", "has space.md"), "loaded by OMP");
    assert.deepStrictEqual((await files.list()).agents, [
      { name: "has space.md", editable: false },
      { name: "reviewer.md", editable: true },
    ]);

    assert.strictEqual(
      await refusal(files.remove({ file: agent("reviewer.md"), baseVersion: version("stale") })),
      "conflict",
    );
    const after = await files.remove({ file: agent("reviewer.md"), baseVersion: version(body) });
    assert.deepStrictEqual(after.agents, [{ name: "has space.md", editable: false }]);
    assert.strictEqual(
      await refusal(files.remove({ file: agent("reviewer.md"), baseVersion: version(body) })),
      "not_found",
    );
  });

  it("refuses names that leave agents/, even past the contract", async () => {
    const decode = Schema.decodeUnknownSync(OmpAgentFileRef);
    for (const name of [
      "../config.yml.md",
      "nested/agent.md",
      "/etc/passwd.md",
      ".hidden.md",
      "agent.txt",
      "..md",
    ]) {
      assert.throws(() => decode({ kind: "agent", name }), undefined, undefined, name);
      const files = ompAgentDirFiles(agentDir);
      assert.strictEqual(await refusal(files.read(agent(name))), "not_editable", name);
      assert.strictEqual(
        await refusal(files.write({ file: agent(name), content: "x", baseVersion: undefined })),
        "not_editable",
        name,
      );
    }
    assert.isFalse(NodeFS.existsSync(NodePath.join(agentDir, "agents")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(agentDir, "config.yml.md")));
  });

  it("refuses an agents/ link that leads out of the agent directory", async () => {
    NodeFS.symlinkSync(outside, NodePath.join(agentDir, "agents"));
    const files = ompAgentDirFiles(agentDir);
    assert.strictEqual(await refusal(files.list()), "not_editable");
    assert.strictEqual(await refusal(files.read(agent("secret.md"))), "not_editable");
    assert.strictEqual(
      await refusal(
        files.write({
          file: agent("secret.md"),
          content: "pwned",
          baseVersion: version("outside\n"),
        }),
      ),
      "not_editable",
    );
    assert.strictEqual(
      await refusal(files.write({ file: agent("new.md"), content: "x", baseVersion: undefined })),
      "not_editable",
    );
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(outside, "secret.md"), "utf8"),
      "outside\n",
    );
    assert.deepStrictEqual(NodeFS.readdirSync(outside), ["secret.md"]);
  });

  it("refuses file links that lead out, and edits through links that stay inside", async () => {
    const agentsDir = NodePath.join(agentDir, "agents");
    NodeFS.mkdirSync(agentsDir);
    NodeFS.symlinkSync(NodePath.join(outside, "secret.md"), NodePath.join(agentsDir, "escape.md"));
    NodeFS.symlinkSync(
      NodePath.join(outside, "secret.md"),
      NodePath.join(agentDir, "WATCHDOG.yml"),
    );
    NodeFS.mkdirSync(NodePath.join(agentDir, "shared"));
    NodeFS.writeFileSync(NodePath.join(agentDir, "shared", "base.md"), "base\n");
    NodeFS.symlinkSync(
      NodePath.join(agentDir, "shared", "base.md"),
      NodePath.join(agentsDir, "linked.md"),
    );
    NodeFS.mkdirSync(NodePath.join(agentsDir, "folder.md"));

    const files = ompAgentDirFiles(agentDir);
    assert.deepStrictEqual((await files.list()).agents, [
      { name: "escape.md", editable: false },
      { name: "linked.md", editable: true },
    ]);
    for (const ref of [agent("escape.md"), WATCHDOG]) {
      assert.strictEqual(await refusal(files.read(ref)), "not_editable");
      assert.strictEqual(
        await refusal(
          files.write({ file: ref, content: "pwned", baseVersion: version("outside\n") }),
        ),
        "not_editable",
      );
      assert.strictEqual(
        await refusal(files.remove({ file: ref, baseVersion: version("outside\n") })),
        "not_editable",
      );
    }
    assert.strictEqual(await refusal(files.read(agent("folder.md"))), "not_editable");
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(outside, "secret.md"), "utf8"),
      "outside\n",
    );

    // Writing through an inside link changes its target and keeps the link.
    await files.write({
      file: agent("linked.md"),
      content: "edited\n",
      baseVersion: version("base\n"),
    });
    assert.isTrue(NodeFS.lstatSync(NodePath.join(agentsDir, "linked.md")).isSymbolicLink());
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(agentDir, "shared", "base.md"), "utf8"),
      "edited\n",
    );
    // Deleting it removes the link, not the file it points to.
    await files.remove({ file: agent("linked.md"), baseVersion: version("edited\n") });
    assert.isFalse(NodeFS.existsSync(NodePath.join(agentsDir, "linked.md")));
    assert.isTrue(NodeFS.existsSync(NodePath.join(agentDir, "shared", "base.md")));
  });

  it("follows an agent directory that is itself a link, like a dotfiles checkout", async () => {
    const linkedDir = NodePath.join(base, "linked-agent");
    NodeFS.symlinkSync(agentDir, linkedDir);
    const files = ompAgentDirFiles(linkedDir);
    await files.write({ file: agent("a.md"), content: "a\n", baseVersion: undefined });
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(agentDir, "agents", "a.md"), "utf8"),
      "a\n",
    );
    assert.strictEqual((await files.list()).agentDir, linkedDir);
  });

  it("refuses files that are too large or not UTF-8 text, and a relative or missing directory", async () => {
    const files = ompAgentDirFiles(agentDir);
    NodeFS.writeFileSync(NodePath.join(agentDir, "WATCHDOG.yml"), Buffer.from([0xff, 0xfe, 0x00]));
    assert.strictEqual(await refusal(files.read(WATCHDOG)), "not_editable");
    NodeFS.writeFileSync(NodePath.join(agentDir, "WATCHDOG.yml"), "x".repeat(512 * 1024 + 1));
    assert.strictEqual(await refusal(files.read(WATCHDOG)), "too_large");
    assert.strictEqual(
      await refusal(
        files.write({
          file: agent("big.md"),
          content: "é".repeat(300 * 1024),
          baseVersion: undefined,
        }),
      ),
      "too_large",
    );
    assert.strictEqual(await refusal(ompAgentDirFiles("relative/agent").list()), "omp_failed");
    assert.strictEqual(
      await refusal(ompAgentDirFiles(NodePath.join(base, "missing")).list()),
      "not_found",
    );
  });
});

const encoder = new TextEncoder();

/** A scripted omp answering `config path` with the profile's agent directory. */
const fakeConfigPath = (dir: string) => {
  const calls: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    calls.push(command.args);
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_995),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(false),
        stdout: Stream.succeed(encoder.encode(`${dir}\n`)),
        stderr: Stream.empty,
      }),
    );
  });
  return { spawner, calls };
};

posixOnly("OMP agent files controller", () => {
  it.effect("asks the instance's omp for its profile's agent directory on every call", () => {
    const omp = fakeConfigPath(agentDir);
    return Effect.gen(function* () {
      const target: OmpControlTarget = {
        binaryPath: "/opt/ompanel/omp",
        profile: "work",
        environment: { HOME: base },
        cwd: "/unused",
      };
      const control = yield* makeOmpControlService();
      const controller = makeOmpAgentFilesController({
        control,
        target: (cwd) => Effect.succeed({ ...target, cwd }),
        globalCwd: "/state/omp/launcher",
      });
      const written = yield* controller.write({
        file: agent("planner.md"),
        content: "plan\n",
        baseVersion: undefined,
      });
      assert.strictEqual(written.relativePath, "agents/planner.md");
      const list = yield* controller.list;
      assert.deepStrictEqual(list.agents, [{ name: "planner.md", editable: true }]);
      assert.strictEqual(list.agentDir, agentDir);
      assert.deepStrictEqual(omp.calls, [
        ["--profile", "work", "config", "path"],
        ["--profile", "work", "config", "path"],
      ]);
      const refused = yield* controller.read(agent("../x.md")).pipe(Effect.flip);
      assert.instanceOf(refused, OmpAgentFilesOperationError);
      assert.strictEqual(refused.reason, "not_editable");
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
      Effect.scoped,
    );
  });
});
