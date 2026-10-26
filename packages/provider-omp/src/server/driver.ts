import { ProviderDriverKind, type ServerProvider } from "@t3tools/contracts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ServerProviderDraft } from "@t3tools/provider-core/server/snapshotProbe";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { OMP_LOCK } from "../ompLock.ts";
import { OmpSettings } from "../settings.ts";
import { makeOmpAdapter } from "./adapter.ts";
import { makeOmpAccountsController } from "./accountsController.ts";
import { makeOmpCommandCatalog } from "./commands.ts";
import { makeOmpAgentFilesController } from "./agentFiles.ts";
import { makeOmpControlService } from "./control.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import {
  listOmpSessions,
  readOmpThreadSessionRecords,
  resolveOmpSessionsLocation,
} from "./ompSessions.ts";
import { ompStateDirs } from "./session.ts";
import { makeOmpSettingsController } from "./settingsController.ts";
import { makeOmpSettingsEngine } from "./settingsEngine.ts";
import { makeOmpThreadSessions, makeOmpThreadSettingsHost } from "./threadSessions.ts";
import { OMP_BUNDLED_SIDECAR_ENV } from "./sidecar.ts";
import { makeOmpSidecarProvisioner } from "./sidecarInstall.ts";
import { buildInitialOmpProviderSnapshot, ompProviderSnapshot } from "./status.ts";
import { makeOmpTextGeneration } from "./textGeneration.ts";

const DRIVER_KIND = ProviderDriverKind.make("omp");
const decodeOmpSettings = Schema.decodeSync(OmpSettings);

// Ompanel pins and ships the sidecar; a new OMP arrives with a new Ompanel release.
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type OmpDriverEnv =
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

export const OmpDriver: ProviderDriver<OmpSettings, OmpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OMP",
    supportsMultipleInstances: true,
  },
  configSchema: OmpSettings,
  defaultConfig: (): OmpSettings => decodeOmpSettings({}),
  create: Effect.fn("OmpDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const host = yield* ProviderHost.ProviderHost;
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const bundledPath = (yield* HostProcess.Environment)[OMP_BUNDLED_SIDECAR_ENV];
    const cacheDir = path.join(host.paths.baseDir, "tools", "omp");
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = (snapshot: ServerProviderDraft): ServerProvider => ({
      ...snapshot,
      instanceId,
      driver: DRIVER_KIND,
      ...(displayName ? { displayName } : {}),
      ...(accentColor ? { accentColor } : {}),
      continuation: { groupKey: continuationIdentity.continuationKey },
    });
    const effectiveConfig = { ...config, enabled } satisfies OmpSettings;
    // Downloads the pinned sidecar into the cache on first use when none is bundled or cached.
    const resolver = yield* makeOmpSidecarProvisioner();
    const control = yield* makeOmpControlService();
    const resolveBinary = resolver
      .resolve({ overridePath: effectiveConfig.binaryPath, bundledPath, cacheDir })
      .pipe(Effect.provide(FetchHttpClient.layer));
    const controlTarget = (cwd: string) =>
      resolveBinary.pipe(
        Effect.map((sidecar) => ({
          binaryPath: sidecar.path,
          binaryIdentity: sidecar.identity,
          profile: effectiveConfig.profile,
          environment: processEnv,
          cwd,
        })),
      );
    const catalog = yield* makeOmpCommandCatalog({ control, target: controlTarget });
    const checkProvider = Effect.gen(function* () {
      if (!effectiveConfig.enabled) return yield* buildInitialOmpProviderSnapshot(effectiveConfig);
      // Resolve (and re-hash) right before every probe; a resolved path is never reused.
      const resolved = yield* resolver
        .resolve({ overridePath: effectiveConfig.binaryPath, bundledPath, cacheDir })
        .pipe(Effect.provide(FetchHttpClient.layer), Effect.result);
      if (Result.isFailure(resolved)) {
        return ompProviderSnapshot({
          settings: effectiveConfig,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          resolution: { kind: "unresolved", error: resolved.failure },
        });
      }
      const probe = yield* control.probe({
        binaryPath: resolved.success.path,
        binaryIdentity: resolved.success.identity,
        profile: effectiveConfig.profile,
        environment: processEnv,
        cwd: host.paths.cwd,
      });
      return ompProviderSnapshot({
        settings: effectiveConfig,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        resolution: { kind: "probed", probe, sidecar: resolved.success },
      });
    }).pipe(Effect.map(stampIdentity));

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialOmpProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      // Each directory's `/` and `$` catalog rides on the snapshot, so a list a thread's server
      // pushes reaches the composer without a rescan.
      enrichSnapshot: ({ getSnapshot, publishSnapshot }) =>
        catalog.workspaceSnapshots.pipe(
          Stream.runForEach((workspaceSnapshots) =>
            workspaceSnapshots.length === 0
              ? Effect.void
              : getSnapshot.pipe(
                  Effect.flatMap((current) => publishSnapshot({ ...current, workspaceSnapshots })),
                ),
          ),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build the OMP snapshot.",
            cause,
          }),
      ),
    );

    // Session processes: pidfiles are swept at boot, so trees a crashed server left are killed.
    const platform = yield* HostProcess.Platform;
    const stateDirs = ompStateDirs(path, host.paths.stateDir);
    // Global-only settings calls run here: a directory Ompanel owns, with no project config.
    yield* (yield* FileSystem.FileSystem)
      .makeDirectory(stateDirs.launcher, { recursive: true, mode: 0o700 })
      .pipe(Effect.ignore);
    const pidfiles = yield* makeOmpPidfiles({ dir: stateDirs.pidfiles, platform });
    yield* pidfiles.sweep.pipe(
      Effect.tap((entries) =>
        entries.length === 0
          ? Effect.void
          : Effect.logInfo("Swept OMP processes left by an earlier server", {
              outcomes: entries.map((entry) => entry.outcome),
            }),
      ),
      Effect.forkDetach,
    );
    // Running threads, shared by the adapter (which registers them) and the settings engine.
    const threadSessions = makeOmpThreadSessions();
    // Threads map 1:1 to OMP's own session files, so terminal and Ompanel share them.
    const sessionsLocation = yield* resolveOmpSessionsLocation({
      environment: processEnv,
      profile: effectiveConfig.profile,
      platform,
      homeDir: yield* HostProcess.HomeDirectory,
    });
    const orchestrationAdapter = yield* makeOmpAdapter({
      instanceId,
      profile: effectiveConfig.profile,
      environment: processEnv,
      platform,
      defaultCwd: host.paths.cwd,
      // Same provisioning resolver as the probe: re-hashed right before every spawn.
      resolveBinary: resolveBinary.pipe(Effect.map((sidecar) => sidecar.path)),
      dirs: stateDirs,
      pidfiles,
      expectedContractVersion: OMP_LOCK.contract.version,
      threadSessions,
      sessions: sessionsLocation,
      commands: catalog,
      resolveAttachmentPath: host.resolveAttachmentPath,
    });
    // Text generation runs in its own empty directory, never the checkout or `launcher`.
    const textGenerationCwd = path.join(stateDirs.launcher, "text-generation");
    yield* (yield* FileSystem.FileSystem)
      .makeDirectory(textGenerationCwd, { recursive: true, mode: 0o700 })
      .pipe(Effect.ignore);

    const settingsEngine = makeOmpSettingsEngine({
      control,
      threads: yield* makeOmpThreadSettingsHost({
        sessions: threadSessions,
        threadsDir: stateDirs.threads,
      }),
    });

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd: (workspaceCwd) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([snapshot.getSnapshot, catalog.forCwd(workspaceCwd)]).pipe(
              Effect.map(([machineSnapshot, workspace]) => ({
                ...machineSnapshot,
                ...workspace,
                slashCommandsPending: false,
              })),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail: "Failed to list OMP commands and skills for the workspace.",
                    cause,
                  }),
              ),
            ),
      invalidateCaches: catalog.invalidate,
      orchestrationAdapter,
      textGeneration: yield* makeOmpTextGeneration({
        // Same provisioning resolver as the probe: re-hashed right before every spawn.
        resolveBinary: resolveBinary.pipe(Effect.map((sidecar) => sidecar.path)),
        profile: effectiveConfig.profile,
        environment: processEnv,
        cwd: textGenerationCwd,
      }),
      ompSettings: makeOmpSettingsController({
        engine: settingsEngine,
        sessions: threadSessions,
        target: controlTarget,
        globalCwd: stateDirs.launcher,
      }),
      ompAccounts: yield* makeOmpAccountsController({
        control,
        target: controlTarget,
        readSettings: settingsEngine.read,
        globalCwd: stateDirs.launcher,
      }),
      // Unreadable buckets and files are skipped, so listing itself does not fail.
      ompSessions: {
        list: Effect.fn("OmpSessions.list")(
          function* ({ cwd }: { readonly cwd: string }) {
            const owners = yield* readOmpThreadSessionRecords(stateDirs.threads);
            const sessions = yield* listOmpSessions(sessionsLocation, cwd);
            return sessions.map((session) => ({
              sessionId: session.sessionId,
              cwd: session.cwd,
              title: session.title,
              firstMessage: session.firstMessage,
              createdAt: session.createdAt === "" ? session.updatedAt : session.createdAt,
              updatedAt: session.updatedAt,
              threadId: owners.get(session.sessionId) ?? null,
            }));
          },
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      },
      ompAgentFiles: makeOmpAgentFilesController({
        control,
        target: controlTarget,
        globalCwd: stateDirs.launcher,
      }),
    } satisfies ProviderInstance;
  }),
};
