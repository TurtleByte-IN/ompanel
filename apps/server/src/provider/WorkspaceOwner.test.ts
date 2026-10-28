import { assert, describe, it } from "@effect/vitest";
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { resolveWorkspaceOwner, type WorkspaceOwnerDeps } from "./WorkspaceOwner.ts";

const PARENT = "project-parent" as ProjectId;
const CHILD = "project-child" as ProjectId;

/** A trusted project at `/home/u` and an unrelated one at `/home/u/app`, which has a worktree. */
const deps = (): WorkspaceOwnerDeps => ({
  projects: {
    listShells: () =>
      Effect.succeed([
        { id: PARENT, workspaceRoot: "/home/u" },
        { id: CHILD, workspaceRoot: "/home/u/app" },
      ] as never),
  },
  gitWorkflow: {
    listRefs: (input) =>
      Effect.succeed({
        isRepo: true,
        refs: [
          {
            name: "main",
            isRemote: false,
            worktreePath: input.cwd,
          },
          ...(input.cwd === "/home/u/app"
            ? [{ name: "feature", isRemote: false, worktreePath: "/home/u/wt/app-feature" }]
            : []),
        ],
        nextCursor: null,
      } as never),
  },
  fileSystem: { realPath: (path: string) => Effect.succeed(path) },
  path: { resolve: (path: string) => path },
});

const ownerOf = (cwd: string) =>
  resolveWorkspaceOwner(deps(), cwd).pipe(Effect.map(Option.getOrUndefined));

describe("resolveWorkspaceOwner", () => {
  it.effect("owns a project's workspace root", () =>
    Effect.gen(function* () {
      assert.strictEqual(yield* ownerOf("/home/u"), PARENT);
      assert.strictEqual(yield* ownerOf("/home/u/app"), CHILD);
    }),
  );

  it.effect("owns a project's git worktree even outside, or under another project's root", () =>
    Effect.gen(function* () {
      // Not under `/home/u/app`, and `/home/u` is a project of its own: the repository decides.
      assert.strictEqual(yield* ownerOf("/home/u/wt/app-feature"), CHILD);
    }),
  );

  it.effect("owns no folder inside a project, nor an unrelated directory", () =>
    Effect.gen(function* () {
      assert.isUndefined(yield* ownerOf("/home/u/app/node_modules/pkg"));
      assert.isUndefined(yield* ownerOf("/home/u/Downloads"));
      assert.isUndefined(yield* ownerOf("/etc"));
    }),
  );

  it.effect("owns nothing when git cannot list worktrees", () =>
    Effect.gen(function* () {
      const failing: WorkspaceOwnerDeps = {
        ...deps(),
        gitWorkflow: { listRefs: () => Effect.fail("git failed") as never },
      };
      const found = yield* resolveWorkspaceOwner(failing, "/home/u/wt/app-feature");
      assert.isTrue(Option.isNone(found));
    }),
  );
});
