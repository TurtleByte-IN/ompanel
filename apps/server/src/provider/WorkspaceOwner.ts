/**
 * Which project owns a directory. A project owns its workspace root, and the same folder of each
 * git worktree of its repository: the worktree's path joined with the project's subpath inside
 * the repository (a project at `repo/app` owns `repo/app` and `<worktree>/app`, not the repository
 * root or a whole worktree). A folder that two projects claim, any folder inside a project, and
 * any other directory belong to no project, so none of them is trusted.
 */
import type { ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
  readonly path: Pick<Path.Path, "resolve" | "relative" | "join" | "isAbsolute">;
}

/** How long one project's worktree listing is reused; a new worktree shows up within it. */
export const WORKSPACE_OWNER_CACHE_TTL_MS = 5_000;

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

/** A resolver whose per-project worktree listings are cached for a few seconds. */
export const makeWorkspaceOwnerResolver = (deps: WorkspaceOwnerDeps) => {
  const canonical = (directory: string) =>
    deps.fileSystem
      .realPath(directory)
      .pipe(Effect.orElseSucceed(() => deps.path.resolve(directory)));
  /** Keyed by project id and root, so a project that moved or was replaced misses the cache. */
  const claimsCache = new Map<
    string,
    { readonly at: number; readonly claims: ReadonlySet<string> }
  >();

  const claimsOf = Effect.fn("WorkspaceOwner.claimsOf")(function* (
    key: string,
    workspaceRoot: string,
  ) {
    const now = yield* Clock.currentTimeMillis;
    const hit = claimsCache.get(key);
    if (hit !== undefined && now - hit.at < WORKSPACE_OWNER_CACHE_TTL_MS) return hit.claims;
    const root = yield* canonical(workspaceRoot);
    const claims = new Set([root]);
    const worktrees = yield* Effect.forEach(
      yield* listWorktreePaths(deps, workspaceRoot),
      canonical,
    );
    // The worktree the project's root sits in gives its subpath inside the repository.
    let base: { readonly path: string; readonly subpath: string } | undefined;
    for (const worktree of worktrees) {
      const subpath = deps.path.relative(worktree, root);
      const inside =
        subpath !== ".." && !subpath.startsWith("..") && !deps.path.isAbsolute(subpath);
      if (inside && (base === undefined || worktree.length > base.path.length)) {
        base = { path: worktree, subpath };
      }
    }
    if (base !== undefined) {
      for (const worktree of worktrees) {
        claims.add(base.subpath === "" ? worktree : deps.path.join(worktree, base.subpath));
      }
    }
    claimsCache.set(key, { at: now, claims });
    return claims;
  });

  /** The one project that owns `cwd`, or none (also when two claim it). Never fails. */
  return Effect.fn("WorkspaceOwner.resolve")(
    function* (cwd: string) {
      const target = yield* canonical(cwd);
      const shells = yield* deps.projects.listShells();
      const keys = new Set(shells.map((shell) => `${shell.id}\0${shell.workspaceRoot}`));
      for (const key of claimsCache.keys()) if (!keys.has(key)) claimsCache.delete(key);
      const owners: Array<ProjectId> = [];
      for (const shell of shells) {
        const claims = yield* claimsOf(`${shell.id}\0${shell.workspaceRoot}`, shell.workspaceRoot);
        if (claims.has(target)) owners.push(shell.id);
      }
      return owners.length === 1 ? Option.some(owners[0]!) : Option.none<ProjectId>();
    },
    // An unreadable directory or project list has no owner.
    Effect.orElseSucceed(() => Option.none<ProjectId>()),
  );
};
