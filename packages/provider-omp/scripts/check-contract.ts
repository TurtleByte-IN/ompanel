#!/usr/bin/env node
/**
 * Checks that `contract/` is a byte-for-byte copy of `packages/rpc-contract` at the OMP fork tag
 * pinned in `omp.lock`, and that the lock's commit and contract version match that tag.
 * `--write` replaces `contract/` with the tag's files instead. Needs only `git` and network
 * access to the public fork; no credentials.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import {
  compareContractFiles,
  ContractManifest,
  describeMismatch,
  isVendoredContractPath,
  lockProblems,
  OmpLockFile,
  TAG_CONTRACT_DIR,
  VENDORED_CONTRACT_DIR,
} from "./contractMatch.ts";

export class ContractCheckError extends Schema.TaggedError<ContractCheckError>()(
  "ContractCheckError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

const decodeLock = Schema.decodeUnknownEffect(Schema.fromJsonString(OmpLockFile));
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(ContractManifest));

const concatBytes = (chunks: ReadonlyArray<Uint8Array>): Uint8Array => {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

const git = Effect.fn("git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const failed = (cause: unknown) =>
    new ContractCheckError({ detail: `git ${args.join(" ")} failed`, cause });
  const child = yield* spawner
    .spawn(
      ChildProcess.make("git", args, { cwd, env: { GIT_TERMINAL_PROMPT: "0" }, extendEnv: true }),
    )
    .pipe(Effect.mapError(failed));
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.runCollect(child.stdout).pipe(Effect.map(concatBytes)),
      Stream.runCollect(child.stderr).pipe(Effect.map(concatBytes)),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(Effect.mapError(failed));
  if (exitCode !== 0) {
    return yield* new ContractCheckError({
      detail: `git ${args.join(" ")} exited with ${exitCode}: ${new TextDecoder().decode(stderr).trim()}`,
    });
  }
  return stdout;
}, Effect.scoped);

/** Fetches the pinned tag without blobs, then reads only the contract files from it. */
const readTagContract = Effect.fn("readTagContract")(function* (lock: OmpLockFile) {
  const fileSystem = yield* FileSystem.FileSystem;
  const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "omp-contract-" });
  const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes).trim();
  yield* git(dir, ["init", "--quiet"]);
  yield* git(dir, ["remote", "add", "origin", `https://github.com/${lock.repository}.git`]);
  yield* git(dir, [
    "fetch",
    "--quiet",
    "--depth=1",
    "--filter=blob:none",
    "origin",
    `+refs/tags/${lock.tag}:refs/tags/${lock.tag}`,
  ]);
  const commit = text(yield* git(dir, ["rev-parse", `refs/tags/${lock.tag}^{commit}`]));
  const listed = text(
    yield* git(dir, ["ls-tree", "-r", "--name-only", lock.tag, "--", TAG_CONTRACT_DIR]),
  );
  const files = new Map<string, Uint8Array>();
  for (const fullPath of listed.split("\n")) {
    const relativePath = fullPath.slice(TAG_CONTRACT_DIR.length + 1);
    if (!isVendoredContractPath(relativePath)) continue;
    files.set(relativePath, yield* git(dir, ["show", `${lock.tag}:${fullPath}`]));
  }
  const manifestBytes = files.get("contract.json");
  if (manifestBytes === undefined) {
    return yield* new ContractCheckError({
      detail: `${lock.tag} has no ${TAG_CONTRACT_DIR}/contract.json`,
    });
  }
  const contract = yield* decodeManifest(new TextDecoder().decode(manifestBytes)).pipe(
    Effect.mapError(
      (cause) => new ContractCheckError({ detail: "Invalid contract.json at the tag", cause }),
    ),
  );
  return { commit, contract, files };
}, Effect.scoped);

const readVendoredContract = Effect.fn("readVendoredContract")(function* (dir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = new Map<string, Uint8Array>();
  if (!(yield* fileSystem.exists(dir))) return files;
  for (const entry of yield* fileSystem.readDirectory(dir, { recursive: true })) {
    const absolute = path.join(dir, entry);
    if ((yield* fileSystem.stat(absolute)).type !== "File") continue;
    files.set(entry.split(path.sep).join("/"), yield* fileSystem.readFile(absolute));
  }
  return files;
});

const checkContract = Effect.fn("checkContract")(function* (write: boolean) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const packageDir = path.dirname(path.dirname(yield* path.fromFileUrl(new URL(import.meta.url))));
  const lock = yield* decodeLock(
    yield* fileSystem.readFileString(path.join(packageDir, "omp.lock")),
  ).pipe(Effect.mapError((cause) => new ContractCheckError({ detail: "Invalid omp.lock", cause })));
  const vendoredDir = path.join(packageDir, VENDORED_CONTRACT_DIR);
  const tag = yield* readTagContract(lock);

  if (write) {
    yield* fileSystem.remove(vendoredDir, { recursive: true, force: true });
    for (const [relativePath, bytes] of tag.files) {
      const target = path.join(vendoredDir, relativePath);
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem.writeFile(target, bytes);
    }
    yield* Console.log(`Vendored ${tag.files.size} contract files from ${lock.tag}.`);
  }

  const problems = [
    ...lockProblems(lock, tag),
    ...compareContractFiles(tag.files, yield* readVendoredContract(vendoredDir)).map(
      describeMismatch,
    ),
  ];
  if (problems.length > 0) {
    return yield* new ContractCheckError({
      detail: [
        `The vendored OMP contract does not match ${lock.repository}@${lock.tag}:`,
        ...problems.map((problem) => `  - ${problem}`),
        "Run `pnpm --filter @t3tools/provider-omp contract:vendor` after updating omp.lock.",
      ].join("\n"),
    });
  }
  yield* Console.log(
    `contract/ matches ${lock.repository}@${lock.tag} (${lock.commit}), contract ${lock.contract.version}.`,
  );
});

const command = Command.make(
  "check-contract",
  {
    write: Flag.Boolean("write").pipe(
      Flag.withDescription("Replace contract/ with the files at the pinned tag."),
      Flag.withDefault(false),
    ),
  },
  ({ write }) => checkContract(write),
).pipe(Command.withDescription("Check the vendored OMP RPC contract against omp.lock's tag."));

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.scoped,
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
