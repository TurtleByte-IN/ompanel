// PRD §12: Ompanel keeps T3's other providers. Each must start in the server's instance registry:
// created, probed and listed. Spawns go to a missing path, so no real CLI runs. Sessions on each
// provider run in the per-driver replay fixtures (docs/omp/open-questions.md).
import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, it, assert } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as OpenCodeRuntime from "@t3tools/provider-opencode/server/OpenCodeRuntime";
import * as OpenCodeServerLedger from "@t3tools/provider-opencode/server/OpenCodeServerLedger";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as CodexManagedTokenBroker from "./CodexManagedTokenBroker.ts";
import { BUILT_IN_DRIVERS } from "./builtInDrivers.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as ProviderInstanceRegistryHydration from "./ProviderInstanceRegistryHydration.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ResetCreditCoordinator from "./resetCreditCoordinator.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

/**
 * T3's providers Ompanel keeps next to OMP (PRD §12: keep, do not strip), with the instance the
 * smoke test starts for each: the driver's default instance, or a configured one for ACP
 * Registry, which has no default instance.
 */
const KEPT_PROVIDERS = [
  ["codex", "codex"],
  ["claudeAgent", "claudeAgent"],
  ["cursor", "cursor"],
  ["grok", "grok"],
  ["opencode", "opencode"],
  ["antigravity", "antigravity"],
  ["pi", "pi"],
  ["muse", "muse"],
  ["acpRegistry", "acp_registry_smoke"],
] as const;

const MISSING_BINARY_DIR = "/nonexistent/ompanel-kept-providers-smoke";
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

const layerTestHttpClient = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const layerBackgroundPolicyAlwaysRun = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

describe("kept T3 providers", () => {
  it("are all still built in next to OMP", () => {
    assert.deepStrictEqual(
      BUILT_IN_DRIVERS.map((driver) => driver.driverKind).toSorted(),
      [...KEPT_PROVIDERS.map(([driver]) => driver), "omp"].toSorted(),
    );
  });

  it.effect("each start: the server creates, probes and lists every one", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const layerProviderRegistry = ProviderRegistry.layer.pipe(
        Layer.provideMerge(ProviderInstanceRegistryHydration.layer),
        Layer.provideMerge(AntigravityInstallation.AntigravityInstallation.layer),
        Layer.provideMerge(
          ServerSettingsModule.layerTest({
            providerInstances: Object.fromEntries(
              KEPT_PROVIDERS.map(([driver, instanceId]) => [
                ProviderInstanceId.make(instanceId),
                { driver: ProviderDriverKind.make(driver), enabled: true },
              ]),
            ),
          }),
        ),
        Layer.provideMerge(ServerSecretStore.layer),
        Layer.provideMerge(
          ServerConfig.layerTest(process.cwd(), { prefix: "ompanel-kept-providers-" }),
        ),
        Layer.provideMerge(layerTestHttpClient),
        Layer.provideMerge(
          Layer.succeed(
            ProviderEventLoggers.ProviderEventLoggers,
            ProviderEventLoggers.NoOpProviderEventLoggers,
          ),
        ),
        Layer.provideMerge(ProviderLatestVersions.layer),
        Layer.provideMerge(McpProviderSessions.layer),
        Layer.provideMerge(ModelManifest.layerTest),
        Layer.provideMerge(ResetCreditCoordinator.layerTest),
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.mock(CodexManagedTokenBroker.CodexManagedTokenBroker)({
              endpoint: Effect.succeed("unused-private-pipe"),
            }),
            Layer.mock(CodexInstallation.CodexInstallation)({
              managedDirectory: "unused-managed-installation",
            }),
            Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
              getEnvironmentId: Effect.succeed(
                EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
              ),
            }),
          ),
        ),
        Layer.provideMerge(
          OpenCodeRuntime.layer.pipe(Layer.provide(OpenCodeServerLedger.layerTest)),
        ),
        // Hermetic: a provider CLI installed on this machine never runs.
        Layer.updateService(ChildProcessSpawner.ChildProcessSpawner, (spawner) =>
          ChildProcessSpawner.make((command) =>
            command._tag === "StandardCommand"
              ? spawner.spawn(
                  ChildProcess.make(
                    `${MISSING_BINARY_DIR}/${command.command.replaceAll("/", "_")}`,
                    command.args,
                    command.options,
                  ),
                )
              : spawner.spawn(command),
          ),
        ),
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(layerBackgroundPolicyAlwaysRun),
      );
      const runtimeServices = yield* Layer.build(layerProviderRegistry).pipe(Scope.provide(scope));

      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        const providers = yield* registry.refresh();
        for (const [driver, instanceId] of KEPT_PROVIDERS) {
          const provider = providers.find((entry) => entry.instanceId === instanceId);
          assert.notStrictEqual(provider, undefined, `${driver} is not listed`);
          assert.strictEqual(provider?.driver, ProviderDriverKind.make(driver));
          assert.notStrictEqual(
            provider?.availability,
            "unavailable",
            `${driver} did not start: ${provider?.unavailableReason ?? ""}`,
          );
          assert.strictEqual(provider?.enabled, true, `${driver} is not enabled`);
          // Without a CLI (or, for Cursor's bundled SDK, a sign-in) a started provider says what
          // it needs; a provider that failed to start has no such probe result.
          assert.include(["error", "warning"], provider?.status, `${driver}: ${provider?.status}`);
          assert.isAbove(provider?.message?.length ?? 0, 0, `${driver} has no probe message`);
        }
      }).pipe(Effect.provide(runtimeServices));
    }),
  );
});
