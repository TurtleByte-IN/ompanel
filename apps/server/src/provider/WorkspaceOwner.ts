/**
 * Which project owns a directory: the one whose workspace root it is, or whose repository has it
 * checked out as a git worktree (the same worktree listing `vcs.listRefs` and threads use). Any
 * other directory, such as a folder inside a project or a worktree of an unrelated repository
 * under a project's root, belongs to no project.
 */
import type { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";

import type * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type * as ProjectService from "../project/ProjectService.ts";

export interface WorkspaceOwnerDeps {
  readonly projects: Pick<ProjectService.ProjectService["Service"], "listShells">;
  readonly gitWorkflow: Pick<GitWorkflowService.GitWorkflowService["Service"], "listRefs">;
  readonly fileSystem: Pick<FileSystem.FileSystem, "realPath">;
  readonly path: Pick<Path.Path, "resolve">;
}

/** Local branches' worktree directories of the repository at `cwd`; none when it is not one. */
const listWorktreePaths = Effect.fn("WorkspaceOwner.listWorktreePaths")(
  function* (deps: WorkspaceOwnerDeps, cwd: string) {
    const found: Array<string> = [];
    let cursor: number | undefined;
    do {
      const page = yield* deps.gitWorkflow.listRefs({
        cwd,
        refKind: "local",
        limit: 200,
        // The first page re-reads git so worktrees added since the last listing count.
        ...(cursor === undefined ? { refresh: true } : { cursor }),
      });
      if (!page.isRepo) return found;
      for (const ref of page.refs) {
        if (ref.isRemote !== true && ref.worktreePath !== null) found.push(ref.worktreePath);
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    return found;
  },
  Effect.orElseSucceed((): Array<string> => []),
);

/** The project that owns `cwd`, or none. Never fails: an unreadable directory has no owner. */
export const resolveWorkspaceOwner = Effect.fn("WorkspaceOwner.resolve")(
  function* (deps: WorkspaceOwnerDeps, cwd: string) {
    const canonical = (directory: string) =>
      deps.fileSystem
        .realPath(directory)
        .pipe(Effect.orElseSucceed(() => deps.path.resolve(directory)));
    const target = yield* canonical(cwd);
    const shells = yield* deps.projects.listShells();
    for (const shell of shells) {
      if ((yield* canonical(shell.workspaceRoot)) === target) return Option.some(shell.id);
    }
    for (const shell of shells) {
      for (const worktree of yield* listWorktreePaths(deps, shell.workspaceRoot)) {
        if ((yield* canonical(worktree)) === target) return Option.some(shell.id);
      }
    }
    return Option.none<ProjectId>();
  },
  // An unreadable directory or project list has no owner.
  Effect.orElseSucceed(() => Option.none<ProjectId>()),
);
