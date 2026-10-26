// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import { isProcessAlive } from "../processTree.ts";

export const FAKE_OMP_FIXTURE = NodeURL.fileURLToPath(
  new URL("./fakeOmp.fixture.mjs", import.meta.url),
);

export interface FakeOmpTree {
  readonly omp: number;
  readonly child: number;
  readonly grandchild: number;
}

/** A scratch directory the fake writes its observations into, removed with the scope. */
export const makeFakeOmpState = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "fake-omp-"))),
  (dir) => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true, force: true })),
).pipe(
  Effect.map((dir) => ({
    dir,
    env: (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({
      ...process.env,
      FAKE_OMP_STATE: dir,
      ...vars,
    }),
    argv: (): { readonly argv: ReadonlyArray<string>; readonly cwd: string } =>
      JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "argv.json"), "utf8")),
    events: (): ReadonlyArray<string> => {
      const file = NodePath.join(dir, "events.log");
      return NodeFS.existsSync(file)
        ? NodeFS.readFileSync(file, "utf8").split("\n").filter(Boolean)
        : [];
    },
    tree: (): FakeOmpTree | undefined => {
      const file = NodePath.join(dir, "tree.json");
      return NodeFS.existsSync(file) ? JSON.parse(NodeFS.readFileSync(file, "utf8")) : undefined;
    },
    /** A `#!/bin/sh` omp that execs the fake, so its pid is the fake's pid. */
    executable: (): string => {
      const file = NodePath.join(dir, "omp");
      NodeFS.writeFileSync(
        file,
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_OMP_FIXTURE)} "$@"\n`,
        { mode: 0o755 },
      );
      return file;
    },
  })),
);

export type FakeOmpState = Effect.Success<typeof makeFakeOmpState>;

/** Polls `check` with wall time until it holds or `timeoutMs` passes. */
export const waitUntil = (check: () => boolean, timeoutMs = 10_000) =>
  Effect.gen(function* () {
    const deadline = (yield* Clock.currentTimeMillis) + timeoutMs;
    while (!check()) {
      if ((yield* Clock.currentTimeMillis) > deadline) return false;
      yield* Effect.sleep("20 millis");
    }
    return true;
  });

export const allDead = (pids: ReadonlyArray<number>) => pids.every((pid) => !isProcessAlive(pid));
