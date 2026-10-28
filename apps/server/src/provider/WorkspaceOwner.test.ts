import { assert, describe, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { makeWorkspaceOwnerResolver, type WorkspaceOwnerDeps } from "./WorkspaceOwner.ts";

const PARENT = "project-parent" as ProjectId;
const CHILD = "project-child" as ProjectId;
const REPO = "project-repo" as ProjectId;
const APP = "project-app" as ProjectId;

interface Shell {
  readonly id: ProjectId;
  readonly workspaceRoot: string;
}

/** `/home/u/app` is a repository with a second worktree; `/repo` is one too (see `listed`). */
const WORKTREES: Record<string, ReadonlyArray<string>> = {
  "/home/u": ["/home/u"],
  "/home/u/app": ["/home/u/app", "/home/u/wt/app-feature"],
  "/repo": ["/repo", "/wt/repo-feature"],
  "/repo/app": ["/repo", "/wt/repo-feature"],
};

const makeDeps = (
  shells: ReadonlyArray<Shell>,
  listed: Array<string> = [],
): WorkspaceOwnerDeps => ({
  projects: { listShells: () => Effect.succeed(shells as never) },
  gitWorkflow: {
    listRefs: (input) =>
      Effect.sync(() => {
        listed.push(input.cwd);
        return {
          isRepo: WORKTREES[input.cwd] !== undefined,
          refs: (WORKTREES[input.cwd] ?? []).map((worktreePath, index) => ({
            name: `branch-${index}`,
            isRemote: false,
            worktreePath,
          })),
          nextCursor: null,
        } as never;
      }),
  },
  fileSystem: { realPath: (path: string) => Effect.succeed(path) },
  path: {
    resolve: (path: string) => path,
    relative: (from: string, to: string) =>
      to === from ? "" : to.startsWith(`${from}/`) ? to.slice(from.length + 1) : `../${to}`,
    join: (...parts: Array<string>) => parts.join("/"),
    isAbsolute: (path: string) => path.startsWith("/"),
  },
});

const ownerOf = (shells: ReadonlyArray<Shell>, cwd: string) =>
  makeWorkspaceOwnerResolver(makeDeps(shells))(cwd).pipe(Effect.map(Option.getOrUndefined));

const NESTED: ReadonlyArray<Shell> = [
  { id: PARENT, workspaceRoot: "/home/u" },
  { id: CHILD, workspaceRoot: "/home/u/app" },
];

describe("makeWorkspaceOwnerResolver", () => {
  it.effect("owns a project's workspace root", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* ownerOf(NESTED, "/home/u"), PARENT);
      assert.strictEqual(yield* ownerOf(NESTED, "/home/u/app"), CHILD);
    }),
  );

  it.effect("owns a project's git worktree outside its root, never a parent project's", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* ownerOf(NESTED, "/home/u/wt/app-feature"), CHILD);
    }),
  );

  it.effect("owns no folder inside a project, nor an unrelated directory", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* ownerOf(NESTED, "/home/u/app/node_modules/pkg"));
      assert.isUndefined(yield* ownerOf(NESTED, "/home/u/Downloads"));
      assert.isUndefined(yield* ownerOf(NESTED, "/etc"));
    }),
  );

  it.effect("owns nothing when git cannot list worktrees", () =>
    Effect.gen(function* () {
      const failing: WorkspaceOwnerDeps = {
        ...makeDeps(NESTED),
        gitWorkflow: { listRefs: () => Effect.fail("git failed") as never },
      };
      const found = yield* makeWorkspaceOwnerResolver(failing)("/home/u/wt/app-feature");
      assert.isTrue(Option.isNone(found));
    }),
  );

  describe.each([
    [
      "repo root first",
      [
        { id: REPO, workspaceRoot: "/repo" },
        { id: APP, workspaceRoot: "/repo/app" },
      ],
    ],
    [
      "subfolder first",
      [
        { id: APP, workspaceRoot: "/repo/app" },
        { id: REPO, workspaceRoot: "/repo" },
      ],
    ],
  ] as const)("a repository root and a subfolder project, %s", (_label, shells) => {
    it.effect("maps each folder to the project whose subpath it is", () =>
      Effect.gen(function* () {
        assert.strictEqual(yield* ownerOf(shells, "/repo"), REPO);
        assert.strictEqual(yield* ownerOf(shells, "/wt/repo-feature"), REPO);
        assert.strictEqual(yield* ownerOf(shells, "/repo/app"), APP);
        assert.strictEqual(yield* ownerOf(shells, "/wt/repo-feature/app"), APP);
      }),
    );
  });

  it.effect("gives a lone subfolder project neither the repository root nor a whole worktree", () =>
    Effect.gen(function* () {
      const only: ReadonlyArray<Shell> = [{ id: APP, workspaceRoot: "/repo/app" }];
      assert.strictEqual(yield* ownerOf(only, "/repo/app"), APP);
      assert.strictEqual(yield* ownerOf(only, "/wt/repo-feature/app"), APP);
      assert.isUndefined(yield* ownerOf(only, "/repo"));
      assert.isUndefined(yield* ownerOf(only, "/wt/repo-feature"));
    }),
  );

  it.effect("owns nothing a second project also claims, in either order", () =>
    Effect.gen(function* () {
      const twins: ReadonlyArray<Shell> = [
        { id: REPO, workspaceRoot: "/repo" },
        { id: APP, workspaceRoot: "/repo" },
      ];
      assert.isUndefined(yield* ownerOf(twins, "/repo"));
      assert.isUndefined(yield* ownerOf(twins, "/wt/repo-feature"));
      assert.isUndefined(yield* ownerOf([...twins].reverse(), "/repo"));
    }),
  );

  it.effect("lists each project's worktrees once for a few seconds, then again", () =>
    Effect.gen(function* () {
      const listed: Array<string> = [];
      const resolve = makeWorkspaceOwnerResolver(
        makeDeps(
          [
            { id: REPO, workspaceRoot: "/repo" },
            { id: APP, workspaceRoot: "/repo/app" },
          ],
          listed,
        ),
      );
      yield* resolve("/repo");
      yield* resolve("/wt/repo-feature");
      assert.deepStrictEqual([...listed].toSorted(), ["/repo", "/repo/app"]);
      yield* TestClock.adjust("6 seconds");
      yield* resolve("/repo");
      assert.lengthOf(listed, 4);
    }),
  );

  it.effect("drops a removed project's listing and lists a new one at once", () =>
    Effect.gen(function* () {
      const listed: Array<string> = [];
      const shells: Array<Shell> = [{ id: REPO, workspaceRoot: "/repo" }];
      const resolve = makeWorkspaceOwnerResolver(makeDeps(shells, listed));
      assert.strictEqual(Option.getOrUndefined(yield* resolve("/repo")), REPO);
      shells.length = 0;
      shells.push({ id: APP, workspaceRoot: "/repo/app" });
      assert.isUndefined(Option.getOrUndefined(yield* resolve("/repo")));
      assert.deepStrictEqual(listed, ["/repo", "/repo/app"]);
    }),
  );
});
