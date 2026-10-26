import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const switching: OrchestrationV2ProviderCapabilities = CodexProviderCapabilitiesV2;
const restarting: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: { ...CodexProviderCapabilitiesV2.sessions, supportsRuntimeModeSwitchInSession: false },
};
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(switching),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for mode commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "runtime-mode-switch" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

/**
 * Sets up a thread in `from` with one live session in `status`, switches it to `to` and returns
 * whether that switch detached the session.
 */
const switchDetaches = (input: {
  readonly name: string;
  readonly from: RuntimeMode;
  readonly to: RuntimeMode;
  readonly status: OrchestrationV2ProviderSession["status"];
  readonly capabilities: OrchestrationV2ProviderCapabilities;
}) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`thread:${input.name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${input.name}:create`),
      threadId,
      projectId: ProjectId.make("project:runtime-mode-switch"),
      title: input.name,
      modelSelection: { instanceId, model: "gpt-5" },
      runtimeMode: input.from,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const session: OrchestrationV2ProviderSession = {
      id: ProviderSessionId.make(`session:${input.name}`),
      driver,
      providerInstanceId: instanceId,
      status: input.status,
      cwd: "/work",
      model: "gpt-5",
      capabilities: input.capabilities,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:${input.name}:attached`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: session,
        },
      ],
    });
    const commandId = CommandId.make(`${input.name}:switch`);
    yield* orchestrator.dispatch({
      type: "thread.runtime-mode.set",
      commandId,
      threadId,
      runtimeMode: input.to,
    });
    const stored = yield* eventSink.readByCommandId({ commandId }).pipe(Stream.runCollect);
    return [...stored].some(
      ({ event }) =>
        event.type === "provider-session.detached" &&
        event.payload.providerSessionId === session.id,
    );
  });

it.layer(layerTest)("thread.runtime-mode.set with a live provider session", (it) => {
  it.effect("ends a running turn's session when the mode tightens", () =>
    Effect.gen(function* () {
      // The running turn would otherwise finish in the looser mode it started with.
      for (const [from, to] of [
        ["full-access", "approval-required"],
        ["full-access", "auto-accept-edits"],
        ["auto-accept-edits", "approval-required"],
        ["auto", "auto-accept-edits"],
      ] as const) {
        assert.isTrue(
          yield* switchDetaches({
            name: `tighten-${from}-${to}`,
            from,
            to,
            status: "running",
            capabilities: switching,
          }),
          `${from} → ${to}`,
        );
      }
      assert.isTrue(
        yield* switchDetaches({
          name: "tighten-waiting",
          from: "full-access",
          to: "approval-required",
          status: "waiting",
          capabilities: switching,
        }),
      );
    }),
  );

  it.effect("keeps the session when the mode widens or no turn is running", () =>
    Effect.gen(function* () {
      assert.isFalse(
        yield* switchDetaches({
          name: "widen-running",
          from: "approval-required",
          to: "full-access",
          status: "running",
          capabilities: switching,
        }),
      );
      assert.isFalse(
        yield* switchDetaches({
          name: "tighten-idle",
          from: "full-access",
          to: "approval-required",
          status: "ready",
          capabilities: switching,
        }),
      );
    }),
  );

  it.effect("always restarts a session that cannot switch modes in place", () =>
    Effect.gen(function* () {
      assert.isTrue(
        yield* switchDetaches({
          name: "restart-idle-widen",
          from: "approval-required",
          to: "full-access",
          status: "ready",
          capabilities: restarting,
        }),
      );
    }),
  );
});
