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
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { OmpSettings } from "../settings.ts";
import { makeOmpAdapter } from "./adapter.ts";
import { makeOmpProbeCache, probeOmp } from "./probe.ts";
import { makeOmpSidecarResolver, OMP_BUNDLED_SIDECAR_ENV } from "./sidecar.ts";
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
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const host = yield* ProviderHost.ProviderHost;
    const path = yield* Path.Path;
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
    const resolver = yield* makeOmpSidecarResolver();
    const probeCache = yield* makeOmpProbeCache();
    const checkProvider = Effect.gen(function* () {
      if (!effectiveConfig.enabled) return yield* buildInitialOmpProviderSnapshot(effectiveConfig);
      const resolved = yield* resolver
        .resolve({ overridePath: effectiveConfig.binaryPath, bundledPath, cacheDir })
        .pipe(Effect.result);
      if (Result.isFailure(resolved)) {
        return ompProviderSnapshot({
          settings: effectiveConfig,
          checkedAt: DateTime.formatIso(yield* DateTime.now),
          resolution: { kind: "unresolved", error: resolved.failure },
        });
      }
      const probeInput = {
        binaryPath: resolved.success.path,
        profile: effectiveConfig.profile,
        environment: processEnv,
        cwd: host.paths.cwd,
      };
      const probe = yield* probeCache.get(probeInput, probeOmp(probeInput));
      return ompProviderSnapshot({
        settings: effectiveConfig,
        checkedAt: DateTime.formatIso(yield* DateTime.now),
        resolution: { kind: "probed", probe },
      });
    }).pipe(
      Effect.map(stampIdentity),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<OmpSettings>>({
      resolveMaintenance: () => Effect.succeed(MAINTENANCE),
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      initialSnapshot: (settings) =>
        buildInitialOmpProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
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

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      orchestrationAdapter: makeOmpAdapter(instanceId),
      textGeneration: makeOmpTextGeneration(),
    } satisfies ProviderInstance;
  }),
};
