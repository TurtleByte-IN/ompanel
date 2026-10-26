// @effect-diagnostics nodeBuiltinImport:off - fixtures build real folders, files and links.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach } from "vite-plus/test";
import { assert, describe, it } from "@effect/vitest";
import { OmpAgentFileRef, OmpAgentFilesOperationError } from "@t3tools/contracts";
import type { ProviderOmpAgentFilesController } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { parse as parseYaml } from "yaml";

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
      modelsFileName: "models.yml",
      modelsExists: false,
      modelsLegacyJson: false,
      mcpFiles: [
        { name: "mcp.json", exists: false },
        { name: ".mcp.json", exists: false },
      ],
      mcpServers: [],
      customization: [],
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

  it("lists skills, rules, prompts, hooks and tools where OMP discovers them", async () => {
    const write = (relative: string, content = "x\n") => {
      NodeFS.mkdirSync(NodePath.dirname(NodePath.join(agentDir, relative)), { recursive: true });
      NodeFS.writeFileSync(NodePath.join(agentDir, relative), content);
    };
    write("skills/tdd/SKILL.md");
    write("skills/notes/README.md"); // no SKILL.md: not a skill
    write("managed-skills/learned/SKILL.md");
    write("RULES.md");
    write("rules/no-any.md");
    write("rules/style.mdc");
    write("rules/ignored.txt");
    write("rules/.hidden.md");
    write("prompts/review.md");
    write("hooks/pre/bash.ts");
    write("hooks/post/*.ts");
    write("tools/fetch.py");
    write("tools/meta.json");
    write("tools/readme.txt");
    write("tools/kit/index.ts");
    write("tools/empty/other.ts");
    write("prompts/has space.md");
    NodeFS.symlinkSync(
      NodePath.join(outside, "secret.md"),
      NodePath.join(agentDir, "prompts/out.md"),
    );
    // A folder that links out is not listed at all.
    NodeFS.symlinkSync(outside, NodePath.join(agentDir, "skills", "escape"));

    const list = await ompAgentDirFiles(agentDir).list();
    assert.deepStrictEqual(list.customization, [
      { category: "hook", path: "hooks/post/*.ts", editable: true },
      { category: "hook", path: "hooks/pre/bash.ts", editable: true },
      { category: "skill", path: "managed-skills/learned/SKILL.md", editable: true },
      { category: "prompt", path: "prompts/has space.md", editable: false },
      { category: "prompt", path: "prompts/out.md", editable: false },
      { category: "prompt", path: "prompts/review.md", editable: true },
      { category: "rule", path: "RULES.md", editable: true },
      { category: "rule", path: "rules/no-any.md", editable: true },
      { category: "rule", path: "rules/style.mdc", editable: true },
      { category: "skill", path: "skills/tdd/SKILL.md", editable: true },
      { category: "tool", path: "tools/fetch.py", editable: true },
      { category: "tool", path: "tools/kit/index.ts", editable: true },
      { category: "tool", path: "tools/meta.json", editable: true },
    ]);
  });

  it("opens and creates customization files only at their own paths", async () => {
    const files = ompAgentDirFiles(agentDir);
    const rule: OmpAgentFileRef = { kind: "custom", category: "rule", path: "rules/no-any.md" };
    await files.write({ file: rule, content: "Never use any.\n", baseVersion: undefined });
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(agentDir, "rules", "no-any.md"), "utf8"),
      "Never use any.\n",
    );
    const skill: OmpAgentFileRef = {
      kind: "custom",
      category: "skill",
      path: "skills/tdd/SKILL.md",
    };
    await files.write({ file: skill, content: "---\nname: tdd\n---\n", baseVersion: undefined });
    assert.isTrue(NodeFS.existsSync(NodePath.join(agentDir, "skills", "tdd", "SKILL.md")));
    assert.strictEqual((await files.read(rule)).content, "Never use any.\n");

    const escapes: ReadonlyArray<OmpAgentFileRef> = [
      { kind: "custom", category: "rule", path: "rules/../config.yml" },
      { kind: "custom", category: "rule", path: "../rules/x.md" },
      { kind: "custom", category: "rule", path: "/etc/passwd" },
      { kind: "custom", category: "rule", path: "prompts/x.md" },
      { kind: "custom", category: "prompt", path: "prompts/a/b.md" },
      { kind: "custom", category: "skill", path: "skills/tdd/other.md" },
      { kind: "custom", category: "skill", path: "skills/../SKILL.md" },
      { kind: "custom", category: "hook", path: "hooks/pre/../../x" },
      { kind: "custom", category: "hook", path: "hooks/other/x.ts" },
      { kind: "custom", category: "tool", path: "tools/x.exe" },
      { kind: "custom", category: "tool", path: "tools/kit/lib.ts" },
      { kind: "custom", category: "tool", path: "tools/.hidden.ts" },
    ];
    for (const ref of escapes) {
      const label = ref.kind === "custom" ? ref.path : ref.kind;
      assert.strictEqual(await refusal(files.read(ref)), "not_editable", label);
      assert.strictEqual(
        await refusal(files.write({ file: ref, content: "pwned", baseVersion: undefined })),
        "not_editable",
        label,
      );
    }
    assert.isFalse(NodeFS.existsSync(NodePath.join(agentDir, "config.yml")));
    assert.isFalse(NodeFS.existsSync(NodePath.join(base, ".omp", "profiles", "work", "x")));

    // A folder on the way that links out is refused, and nothing is written through it.
    NodeFS.symlinkSync(outside, NodePath.join(agentDir, "prompts"));
    const prompt: OmpAgentFileRef = {
      kind: "custom",
      category: "prompt",
      path: "prompts/secret.md",
    };
    assert.strictEqual(await refusal(files.read(prompt)), "not_editable");
    assert.strictEqual(
      await refusal(
        files.write({ file: prompt, content: "pwned", baseVersion: version("outside\n") }),
      ),
      "not_editable",
    );
    assert.strictEqual(
      NodeFS.readFileSync(NodePath.join(outside, "secret.md"), "utf8"),
      "outside\n",
    );
  });

  it("lists MCP servers from both files without their arguments, headers or environment", async () => {
    NodeFS.writeFileSync(
      NodePath.join(agentDir, "mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-github"],
            env: { GITHUB_TOKEN: "ghp_secret" },
          },
          docs: {
            type: "http",
            url: "https://user:pass@docs.example.com/mcp?token=secret",
            headers: { Authorization: "Bearer secret" },
            enabled: false,
          },
        },
      }),
    );
    NodeFS.writeFileSync(NodePath.join(agentDir, ".mcp.json"), "{ not json");
    const list = await ompAgentDirFiles(agentDir).list();
    assert.deepStrictEqual(list.mcpFiles, [
      { name: "mcp.json", exists: true },
      { name: ".mcp.json", exists: true, problem: "invalid_json" },
    ]);
    assert.deepStrictEqual(list.mcpServers, [
      { name: "github", file: "mcp.json", transport: "stdio", target: "npx", disabled: false },
      {
        name: "docs",
        file: "mcp.json",
        transport: "http",
        target: "https://docs.example.com/mcp",
        disabled: true,
      },
    ]);
    assert.notInclude(JSON.stringify(list), "secret");

    const files = ompAgentDirFiles(agentDir);
    const created = await files.write({
      file: { kind: "mcp", name: ".mcp.json" },
      content: "{}\n",
      baseVersion: version("{ not json"),
    });
    assert.strictEqual(created.relativePath, ".mcp.json");
    const decode = Schema.decodeUnknownSync(OmpAgentFileRef);
    assert.throws(() => decode({ kind: "mcp", name: "../mcp.json" }));
  });

  it("edits models.yaml in place, creates models.yml owner-only, and leaves a legacy models.json to OMP", async () => {
    const files = ompAgentDirFiles(agentDir);
    await files.write({
      file: { kind: "models" },
      content: "providers: {}\n",
      baseVersion: undefined,
    });
    assert.strictEqual(NodeFS.statSync(NodePath.join(agentDir, "models.yml")).mode & 0o777, 0o600);
    NodeFS.rmSync(NodePath.join(agentDir, "models.yml"));

    NodeFS.writeFileSync(NodePath.join(agentDir, "models.yaml"), "providers: {}\n");
    const list = await files.list();
    assert.strictEqual(list.modelsFileName, "models.yaml");
    assert.isTrue(list.modelsExists);
    const read = await files.read({ kind: "models" });
    assert.strictEqual(read.relativePath, "models.yaml");
    NodeFS.rmSync(NodePath.join(agentDir, "models.yaml"));

    NodeFS.writeFileSync(NodePath.join(agentDir, "models.json"), "{}");
    assert.isTrue((await files.list()).modelsLegacyJson);
    assert.strictEqual(
      await refusal(
        files.write({
          file: { kind: "models" },
          content: "providers: {}\n",
          baseVersion: undefined,
        }),
      ),
      "not_editable",
    );
    assert.isFalse(NodeFS.existsSync(NodePath.join(agentDir, "models.yml")));
  });
});

const encoder = new TextEncoder();

const handleOf = (input: {
  readonly stdout: Stream.Stream<Uint8Array>;
  readonly exitCode: number | "running";
}) =>
  ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(999_999_995),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
    exitCode:
      input.exitCode === "running"
        ? Effect.never
        : Effect.succeed(ChildProcessSpawner.ExitCode(input.exitCode)),
    isRunning: Effect.succeed(input.exitCode === "running"),
    stdout: input.stdout,
    stderr: Stream.empty,
  });

const lines = (...values: ReadonlyArray<unknown>) =>
  Stream.fromIterable(values.map((value) => encoder.encode(`${JSON.stringify(value)}\n`)));

interface ModelsCheckLaunch {
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined>;
  readonly scratchDir: string;
  /** `models.yml` in the scratch directory, and its permissions, as omp found it. */
  readonly text: string;
  readonly mode: number;
}

interface FakeOmp {
  readonly spawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly calls: Array<ReadonlyArray<string>>;
  readonly checks: Array<ModelsCheckLaunch>;
}

/**
 * A scripted omp: `config path` prints the profile's agent directory; `agents unpack` writes
 * two agents and prints OMP's JSON; `--mode rpc` loads the scratch `models.yml` like OMP does,
 * dropping every custom provider when one names an unknown `api`, and quits before `ready` when
 * that leaves it no model.
 */
const fakeOmp = (dir: string): FakeOmp => {
  const calls: Array<ReadonlyArray<string>> = [];
  const checks: Array<ModelsCheckLaunch> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    if (!ChildProcess.isStandardCommand(command)) return Effect.die("Unexpected pipeline");
    calls.push(command.args);
    if (command.args.includes("unpack")) {
      const agents = NodePath.join(dir, "agents");
      NodeFS.mkdirSync(agents, { recursive: true });
      const written = ["explore.md", "plan.md"].filter(
        (name) => !NodeFS.existsSync(NodePath.join(agents, name)),
      );
      for (const name of written) NodeFS.writeFileSync(NodePath.join(agents, name), "bundled\n");
      const result = {
        targetDir: agents,
        total: 2,
        written: written.map((name) => NodePath.join(agents, name)),
        skipped: ["explore.md", "plan.md"]
          .filter((name) => !written.includes(name))
          .map((name) => NodePath.join(agents, name)),
      };
      return Effect.succeed(
        handleOf({
          stdout: Stream.succeed(encoder.encode(JSON.stringify(result, null, 2))),
          exitCode: 0,
        }),
      );
    }
    if (!command.args.includes("rpc")) {
      return Effect.succeed(
        handleOf({ stdout: Stream.succeed(encoder.encode(`${dir}\n`)), exitCode: 0 }),
      );
    }
    const env = { ...command.options.env };
    const scratchDir = env["PI_CODING_AGENT_DIR"] ?? "";
    const file = NodePath.join(scratchDir, "models.yml");
    const text = NodeFS.readFileSync(file, "utf8");
    checks.push({
      args: command.args,
      env,
      scratchDir,
      text,
      mode: NodeFS.statSync(file).mode & 0o777,
    });
    const config = parseYaml(text) as {
      readonly providers?: Record<string, { api?: string; models?: Array<{ id: string }> }>;
    };
    const providers = Object.entries(config.providers ?? {});
    const valid = providers.every(
      ([, provider]) => provider.api === undefined || provider.api.startsWith("openai-"),
    );
    if (!valid) return Effect.succeed(handleOf({ stdout: Stream.empty, exitCode: 1 }));
    const models = providers.flatMap(([provider, entry]) =>
      (entry.models ?? []).map((model) => ({ provider, id: model.id, api: entry.api })),
    );
    const stdin = command.options.stdin;
    const inbound = Stream.isStream(stdin) ? stdin : Stream.empty;
    const responses = inbound.pipe(
      Stream.decodeText(),
      Stream.splitLines,
      Stream.map((line) => JSON.parse(line) as { readonly id: string; readonly type: string }),
      Stream.map((frame) => ({
        type: "response",
        id: frame.id,
        command: frame.type,
        success: true,
        data: { models },
      })),
      Stream.map((frame) => encoder.encode(`${JSON.stringify(frame)}\n`)),
      Stream.orDie,
    );
    return Effect.succeed(
      handleOf({
        stdout: Stream.concat(lines({ type: "ready", contractVersion: "1.6.0" }), responses),
        exitCode: "running",
      }),
    );
  });
  return { spawner, calls, checks };
};

const TARGET: OmpControlTarget = {
  binaryPath: "/opt/ompanel/omp",
  profile: "work",
  environment: { HOME: "/home/tester", OMP_PROFILE: "work", PATH: "/usr/bin" },
  cwd: "/unused",
};

const withController = <A, E>(
  omp: FakeOmp,
  use: (controller: ProviderOmpAgentFilesController) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    const control = yield* makeOmpControlService();
    return yield* use(
      makeOmpAgentFilesController({
        control,
        target: (cwd) => Effect.succeed({ ...TARGET, cwd }),
        globalCwd: "/state/omp/launcher",
      }),
    );
  }).pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, omp.spawner),
    Effect.scoped,
  );

posixOnly("OMP agent files controller", () => {
  it.effect("asks the instance's omp for its profile's agent directory on every call", () => {
    const omp = fakeOmp(agentDir);
    return withController(omp, (controller) =>
      Effect.gen(function* () {
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
      }),
    );
  });

  it.effect("refuses a models.yml OMP does not load and leaves the file as it was", () => {
    const original =
      "providers:\n  lab:\n    api: openai-completions\n    apiKey: LAB_KEY\n    models:\n      - id: a\n";
    NodeFS.writeFileSync(NodePath.join(agentDir, "models.yml"), original, { mode: 0o600 });
    const omp = fakeOmp(agentDir);
    return withController(omp, (controller) =>
      Effect.gen(function* () {
        const unknownApi = original.replace("openai-completions", "carrier-pigeon");
        const refused = yield* controller
          .write({ file: { kind: "models" }, content: unknownApi, baseVersion: version(original) })
          .pipe(Effect.flip);
        assert.strictEqual(refused.reason, "invalid");
        assert.include(refused.message, "not saved");
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(agentDir, "models.yml"), "utf8"),
          original,
        );

        // Broken YAML never reaches omp.
        const launches = omp.checks.length;
        const broken = yield* controller
          .write({
            file: { kind: "models" },
            content: "providers: [",
            baseVersion: version(original),
          })
          .pipe(Effect.flip);
        assert.strictEqual(broken.reason, "invalid");
        assert.match(broken.message, /line \d+, column \d+/);
        assert.strictEqual(omp.checks.length, launches);
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(agentDir, "models.yml"), "utf8"),
          original,
        );

        // omp ran in an owner-only scratch directory, not the profile's, which is gone again.
        const [check] = omp.checks;
        assert.isDefined(check);
        assert.notStrictEqual(check!.scratchDir, agentDir);
        assert.isFalse(NodeFS.existsSync(check!.scratchDir));
        assert.strictEqual(check!.mode, 0o600);
        assert.isUndefined(check!.env["OMP_PROFILE"]);
        assert.strictEqual(check!.env["PATH"], "/usr/bin");
        assert.notInclude(check!.args, "--profile");
        assert.deepStrictEqual(check!.args.slice(-2), ["--approval-mode", "always-ask"]);
        assert.includeMembers([...check!.args], ["--mode", "rpc", "--no-session", "--no-tools"]);
      }),
    );
  });

  it.effect("saves a models.yml OMP loads and reports the models it listed from it", () => {
    const omp = fakeOmp(agentDir);
    const next =
      "# lab box\nproviders:\n  lab:\n    baseUrl: http://lab:8000/v1\n    api: openai-completions\n    apiKey: LAB_KEY\n    models:\n      - id: a\n      - id: b\n";
    return withController(omp, (controller) =>
      Effect.gen(function* () {
        const written = yield* controller.write({
          file: { kind: "models" },
          content: next,
          baseVersion: undefined,
        });
        assert.deepStrictEqual(written.checkedModels, [
          { provider: "lab", id: "a" },
          { provider: "lab", id: "b" },
        ]);
        // Saved byte for byte: the marker provider only ever lived in the scratch copy.
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(agentDir, "models.yml"), "utf8"),
          next,
        );
        assert.include(omp.checks[0]!.text, "ompanel-check-");
        assert.include(omp.checks[0]!.text, "# lab box");
      }),
    );
  });

  it.effect("unpacks OMP's bundled agents without overwriting the user's", () => {
    NodeFS.mkdirSync(NodePath.join(agentDir, "agents"));
    NodeFS.writeFileSync(NodePath.join(agentDir, "agents", "plan.md"), "mine\n");
    const omp = fakeOmp(agentDir);
    return withController(omp, (controller) =>
      Effect.gen(function* () {
        const result = yield* controller.unpackAgents;
        assert.deepStrictEqual(result.written, ["explore.md"]);
        assert.deepStrictEqual(result.skipped, ["plan.md"]);
        assert.deepStrictEqual(
          result.files.agents.map((entry) => entry.name),
          ["explore.md", "plan.md"],
        );
        assert.deepStrictEqual(omp.calls[0], [
          "--profile",
          "work",
          "agents",
          "unpack",
          "--user",
          "--json",
        ]);
        assert.strictEqual(
          NodeFS.readFileSync(NodePath.join(agentDir, "agents", "plan.md"), "utf8"),
          "mine\n",
        );
      }),
    );
  });
});
