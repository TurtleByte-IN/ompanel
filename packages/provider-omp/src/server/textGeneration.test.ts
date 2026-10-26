import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, TextGenerationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { OmpAnsi } from "./ompAnsi.ts";
import { makeOmpTextGeneration } from "./textGeneration.ts";

// Records argv and stdin, then behaves per FAKE_OMP_MODE.
const FAKE_OMP = `#!/usr/bin/env node
const fs = require("node:fs");
const log = process.env.FAKE_OMP_LOG;
let stdin = "";
process.stdin.on("data", (chunk) => (stdin += chunk));
process.stdin.on("end", () => {
  fs.writeFileSync(log, JSON.stringify({ args: process.argv.slice(2), stdin, cwd: process.cwd() }));
  const mode = process.env.FAKE_OMP_MODE;
  if (mode === "fail") {
    process.stderr.write("\\u001b[31mmodel @commit is not configured\\u001b[0m\\n");
    process.exit(3);
  }
  if (mode === "hang") {
    process.stdout.write('{"subject":"Partial');
    setInterval(() => {}, 1000);
    return;
  }
  const reply = { subject: "Add feature", body: "Details.", title: "Fix login", branch: "feature/login" };
  process.stdout.write("\\u001b[1m\\u001b[32m" + JSON.stringify(reply) + "\\u001b[0m\\n");
});
`;

const modelSelection = { instanceId: ProviderInstanceId.make("omp"), model: "default" };
const isTextGenerationError = Schema.is(TextGenerationError);

const setup = (mode: "ok" | "fail" | "hang", options?: { readonly profile?: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = yield* fs.makeTempDirectoryScoped({ prefix: "omp-textgen-test-" });
    const binary = path.join(dir, "omp");
    const log = path.join(dir, "log.json");
    // Stands in for the empty directory Ompanel owns; `dir` plays the checkout.
    const ownedCwd = path.join(dir, "owned");
    yield* fs.makeDirectory(ownedCwd);
    yield* fs.writeFileString(binary, FAKE_OMP);
    yield* fs.chmod(binary, 0o755);
    // Wraps the real spawner so a test can await the child's first stdout bytes.
    const firstOutput = yield* Deferred.make<ChildProcessSpawner.ChildProcessHandle>();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const observed = ChildProcessSpawner.make((command) =>
      spawner.spawn(command).pipe(
        Effect.map((handle) =>
          ChildProcessSpawner.makeHandle({
            ...handle,
            stdout: handle.stdout.pipe(Stream.tap(() => Deferred.succeed(firstOutput, handle))),
          }),
        ),
      ),
    );
    const textGeneration = yield* makeOmpTextGeneration({
      resolveBinary: Effect.succeed(binary),
      profile: options?.profile ?? "",
      environment: { PATH: process.env.PATH, FAKE_OMP_LOG: log, FAKE_OMP_MODE: mode },
      cwd: ownedCwd,
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, observed));
    const readLog = fs.readFileString(log).pipe(
      Effect.map(
        (text) =>
          JSON.parse(text) as {
            readonly args: ReadonlyArray<string>;
            readonly stdin: string;
            readonly cwd: string;
          },
      ),
    );
    return { textGeneration, readLog, dir, firstOutput, ownedCwd: yield* fs.realPath(ownedCwd) };
  });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("OmpTextGeneration", () => {
  it.live(
    "runs the @commit chain for commit messages in the owned directory, prompt on stdin",
    () =>
      Effect.gen(function* () {
        const { textGeneration, readLog, dir, ownedCwd } = yield* setup("ok");
        const result = yield* textGeneration.generateCommitMessage({
          cwd: dir,
          branch: "main",
          stagedSummary: "M src/a.ts",
          stagedPatch: "+const a = 1;",
          modelSelection,
        });
        assert.deepStrictEqual(result, { subject: "Add feature", body: "Details." });
        const launch = yield* readLog;
        assert.deepStrictEqual(launch.args, [
          "-p",
          "--no-session",
          "--no-tools",
          "--no-extensions",
          "--model",
          "@commit,@smol,@default",
        ]);
        assert.include(launch.stdin, "+const a = 1;");
        // Never the checkout the request names.
        assert.strictEqual(launch.cwd, ownedCwd);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("runs the @commit chain for PR content and branch names", () =>
    Effect.gen(function* () {
      const { textGeneration, readLog, dir } = yield* setup("ok");
      const pr = yield* textGeneration.generatePrContent({
        cwd: dir,
        baseBranch: "main",
        headBranch: "feature/login",
        commitSummary: "Fix login",
        diffSummary: "1 file",
        diffPatch: "+x",
        modelSelection,
      });
      assert.strictEqual(pr.title, "Fix login");
      assert.strictEqual((yield* readLog).args.at(-1), "@commit,@smol,@default");
      const branch = yield* textGeneration.generateBranchName({
        cwd: dir,
        message: "Fix the login form",
        modelSelection,
      });
      assert.include(branch.branch, "login");
      assert.strictEqual((yield* readLog).args.at(-1), "@commit,@smol,@default");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("runs @tiny for thread titles, with the instance profile", () =>
    Effect.gen(function* () {
      const { textGeneration, readLog, dir } = yield* setup("ok", { profile: "work" });
      const result = yield* textGeneration.generateThreadTitle({
        cwd: dir,
        message: "The login form rejects valid passwords",
        modelSelection,
      });
      assert.strictEqual(result.title, "Fix login");
      assert.deepStrictEqual((yield* readLog).args, [
        "--profile",
        "work",
        "-p",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--model",
        "@tiny",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("passes a non-default model slug through", () =>
    Effect.gen(function* () {
      const { textGeneration, readLog, dir } = yield* setup("ok");
      yield* textGeneration.generateThreadTitle({
        cwd: dir,
        message: "hello",
        modelSelection: { ...modelSelection, model: "anthropic/claude-haiku-4-5" },
      });
      assert.strictEqual((yield* readLog).args.at(-1), "anthropic/claude-haiku-4-5");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails with a typed, ANSI-free error on a non-zero exit", () =>
    Effect.gen(function* () {
      const { textGeneration, dir } = yield* setup("fail");
      const error = yield* textGeneration
        .generateThreadTitle({ cwd: dir, message: "hello", modelSelection })
        .pipe(Effect.flip);
      assert.isTrue(isTextGenerationError(error));
      assert.strictEqual(error.operation, "generateThreadTitle");
      assert.strictEqual(error.detail, "OMP exited with code 3: model @commit is not configured");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("cancellation kills the process and returns no partial text", () =>
    Effect.gen(function* () {
      const { textGeneration, dir, firstOutput } = yield* setup("hang");
      const fiber = yield* textGeneration
        .generateCommitMessage({
          cwd: dir,
          branch: null,
          stagedSummary: "",
          stagedPatch: "",
          modelSelection,
        })
        .pipe(Effect.forkChild);
      // The fake has written partial JSON and is now blocked forever.
      const handle = yield* Deferred.await(firstOutput);
      const pid = Number(handle.pid);
      assert.isTrue(isAlive(pid));
      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause));
      // Closing the operation's scope waits for the kill to land.
      assert.isFalse(isAlive(pid));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

it("OmpAnsi strips colour, cursor and OSC sequences", () => {
  assert.strictEqual(
    OmpAnsi.strip("\u001b[1;32mok\u001b[0m \u001b[2K\u001b]8;;https://x\u0007link\u001b]8;;\u0007"),
    "ok link",
  );
});
