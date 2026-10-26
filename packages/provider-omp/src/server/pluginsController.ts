/**
 * Settings → OMP → Plugins and Skills (PRD FR-15, FR-16): installed plugins and marketplaces
 * from `omp plugin`, one confirmed `omp plugin` command at a time, `/reload-plugins` in running
 * threads, `omp update --check`, and the skills `omp skill list --json` resolves. Every command
 * runs in the instance's global directory, so plugins install at user scope.
 */
import {
  ompPluginCommandArgs,
  OmpPluginsOperationError,
  type OmpInstalledPlugin,
  type OmpPluginList,
} from "@t3tools/contracts";
import type { ProviderOmpPluginsController } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";

import type {
  OmpControlError,
  OmpControlService,
  OmpControlTarget,
  OmpPluginListReport,
} from "./control.ts";
import type { OmpSidecarError } from "./sidecar.ts";
import type { OmpThreadSessions } from "./threadSessions.ts";

/** OMP's builtin that reloads skills, commands, hooks, tools, agents and MCP in a session. */
export const OMP_RELOAD_PLUGINS_COMMAND = "/reload-plugins";
/** Per-thread deadline for `/reload-plugins`; it re-reads plugin roots from disk. */
export const OMP_RELOAD_PLUGINS_TIMEOUT_MS = 30_000;

const ompFailed = (error: OmpControlError | OmpSidecarError) =>
  new OmpPluginsOperationError({
    reason:
      error._tag === "OmpControlError" && error.reason === "timeout" ? "timeout" : "omp_failed",
    message: error.message,
  });

const toOmpInstalledPlugins = (report: OmpPluginListReport): ReadonlyArray<OmpInstalledPlugin> => [
  ...report.npm.map((plugin): OmpInstalledPlugin => ({
    id: plugin.name,
    source: "npm",
    version: plugin.version,
    enabled: plugin.enabled,
    ...(plugin.manifest.description === undefined
      ? {}
      : { description: plugin.manifest.description }),
    shadowed: false,
  })),
  ...report.marketplace.map((plugin): OmpInstalledPlugin => {
    const entry = plugin.entries[0];
    return {
      id: plugin.id,
      source: "marketplace",
      version: entry?.version ?? "unknown",
      // OMP treats an entry without the flag as enabled.
      enabled: entry?.enabled !== false,
      scope: plugin.scope,
      shadowed: plugin.shadowedBy !== undefined,
    };
  }),
];

export const makeOmpPluginsController = (input: {
  readonly control: Pick<
    OmpControlService,
    | "pluginList"
    | "marketplaceList"
    | "marketplaceDiscover"
    | "pluginCommand"
    | "updateCheck"
    | "skillList"
  >;
  /** This instance's omp, resolved and verified for this call, run in `cwd`. */
  readonly target: (cwd: string) => Effect.Effect<OmpControlTarget, OmpSidecarError>;
  /** A directory with no project config: plugins and skills read at user scope. */
  readonly globalCwd: string;
  readonly sessions: Pick<OmpThreadSessions, "list">;
  /** Drops the per-workspace command and skill catalog after plugins change. */
  readonly invalidateCatalog: Effect.Effect<void>;
}): ProviderOmpPluginsController => {
  const { control } = input;
  const target = input.target(input.globalCwd);

  const list = Effect.gen(function* () {
    const resolved = yield* target;
    const [report, marketplaces] = yield* Effect.all(
      [control.pluginList(resolved), control.marketplaceList(resolved)],
      { concurrency: 2 },
    );
    return {
      // How Ompanel starts this instance's omp, as the confirmation shows it.
      command: resolved.profile === "" ? ["omp"] : ["omp", "--profile", resolved.profile],
      plugins: toOmpInstalledPlugins(report),
      marketplaces,
    } satisfies OmpPluginList;
  }).pipe(Effect.mapError(ompFailed), Effect.withSpan("OmpPlugins.list"));

  return {
    list,
    run: (command) =>
      target.pipe(
        Effect.flatMap((resolved) =>
          control.pluginCommand(resolved, ompPluginCommandArgs(command)),
        ),
        Effect.mapError(ompFailed),
        Effect.andThen(input.invalidateCatalog),
        Effect.andThen(list),
        Effect.withSpan("OmpPlugins.run", { attributes: { "omp.plugin_action": command.action } }),
      ),
    discover: (marketplace) =>
      target.pipe(
        Effect.flatMap((resolved) => control.marketplaceDiscover(resolved, marketplace)),
        Effect.map((plugins) => ({ marketplace, plugins })),
        Effect.mapError(ompFailed),
        Effect.withSpan("OmpPlugins.discover"),
      ),
    reload: input.sessions.list.pipe(
      Effect.flatMap((sessions) =>
        Effect.forEach(
          sessions,
          (session) =>
            // A turn in flight would show the reload's output inside it; the thread reloads on
            // its next start or the next reload instead.
            session.isBusy()
              ? Effect.succeed("busy" as const)
              : session.process
                  .request(
                    "prompt",
                    { message: OMP_RELOAD_PLUGINS_COMMAND },
                    { timeoutMs: OMP_RELOAD_PLUGINS_TIMEOUT_MS },
                  )
                  .pipe(
                    Effect.as("reloaded" as const),
                    Effect.orElseSucceed(() => "failed" as const),
                  ),
          { concurrency: "unbounded" },
        ),
      ),
      Effect.map((outcomes) => ({
        reloaded: outcomes.filter((outcome) => outcome === "reloaded").length,
        busy: outcomes.filter((outcome) => outcome === "busy").length,
        failed: outcomes.filter((outcome) => outcome === "failed").length,
      })),
      Effect.tap(() => input.invalidateCatalog),
      Effect.withSpan("OmpPlugins.reload"),
    ),
    checkUpdate: target.pipe(
      Effect.flatMap((resolved) => control.updateCheck(resolved)),
      Effect.mapError(ompFailed),
      Effect.withSpan("OmpPlugins.checkUpdate"),
    ),
    skills: target.pipe(
      Effect.flatMap((resolved) => control.skillList(resolved)),
      Effect.map((list) => ({
        skills: list.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          filePath: skill.filePath,
          source: skill.source,
          hidden: skill.hide,
        })),
        warnings: list.warnings,
      })),
      Effect.mapError(ompFailed),
      Effect.withSpan("OmpPlugins.skills"),
    ),
  };
};
