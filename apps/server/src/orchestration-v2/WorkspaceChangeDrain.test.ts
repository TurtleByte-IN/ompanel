import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

// A workspace change while a turn runs (`/wt` binds the thread from inside its own turn,
// ompanel#132): a session serving only that thread drains the turn and stays the thread's
// session until released, so the commands that must end a turn still reach it.

const driver = ProviderDriverKind.make("omp");
const instanceId = ProviderInstanceId.make("omp");
const singleThread: OrchestrationV2ProviderCapabilities = {
  ...CodexProviderCapabilitiesV2,
  sessions: {
    ...CodexProviderCapabilitiesV2.sessions,
    supportsMultipleProviderThreadsPerSession: false,
  },
};
const adapter = {
  instanceId,
  driver,
  getCapabilities: () => Effect.succeed(singleThread),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for workspace commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "workspace-change-drain" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

/** A thread whose single-thread session runs a turn, moved to a worktree. */
const moveRunningThread = (name: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`${name}:create`),
      threadId,
      projectId: ProjectId.make("project:workspace-change-drain"),
      title: name,
      modelSelection: { instanceId, model: "default" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const now = yield* DateTime.now;
    const session: OrchestrationV2ProviderSession = {
      id: ProviderSessionId.make(`session:${name}`),
      driver,
      providerInstanceId: instanceId,
      status: "running",
      cwd: "/work",
      model: "default",
      capabilities: singleThread,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    };
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:${name}:attached`),
          type: "provider-session.attached",
          threadId,
          driver,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: session,
        },
      ],
    });
    const moveCommandId = CommandId.make(`${name}:wt`);
    yield* orchestrator.dispatch({
      type: "thread.metadata.update",
      commandId: moveCommandId,
      threadId,
      branch: "feature",
      worktreePath: "/work/.worktrees/feature",
    });
    return { threadId, session, moveCommandId };
  });

const commandResults = (commandId: CommandId) =>
  Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const events = yield* eventSink.readByCommandId({ commandId }).pipe(Stream.runCollect);
    return {
      eventTypes: [...events].map(({ event }) => event.type),
      detaches: (yield* outbox.listByCommandId(commandId))
        .map((effect) => effect.request)
        .filter((request) => request.type === "provider-session.detach"),
    };
  });

it.layer(layerTest)("a workspace change with a single-thread session", (it) => {
  it.effect("drains the session and keeps it the thread's session", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threadId, session, moveCommandId } = yield* moveRunningThread("drain");

      const moved = yield* commandResults(moveCommandId);
      assert.notInclude(moved.eventTypes, "provider-session.detached");
      assert.deepEqual(moved.detaches, [
        {
          type: "provider-session.detach",
          providerSessionId: session.id,
          detail: "Workspace changed.",
          drain: true,
        },
      ]);
      assert.deepEqual(
        (yield* projections.getThreadProviderContext(threadId)).providerSessions.map(
          (candidate) => candidate.id,
        ),
        [session.id],
      );
    }),
  );

  it.effect("still ends the draining turn on a tighter mode, archive and delete", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      for (const [name, command, expected] of [
        [
          "drain-mode",
          (threadId: ThreadId, commandId: CommandId): OrchestrationV2Command => ({
            type: "thread.runtime-mode.set",
            commandId,
            threadId,
            runtimeMode: "approval-required",
          }),
          { detail: "Runtime mode changed." },
        ],
        [
          "drain-archive",
          (threadId: ThreadId, commandId: CommandId): OrchestrationV2Command => ({
            type: "thread.archive",
            commandId,
            threadId,
          }),
          { detail: "Thread archived.", revokeMcpCredential: true },
        ],
        [
          "drain-delete",
          (threadId: ThreadId, commandId: CommandId): OrchestrationV2Command => ({
            type: "thread.delete",
            commandId,
            threadId,
          }),
          { detail: "Thread deleted.", revokeMcpCredential: true },
        ],
      ] as const) {
        const { threadId, session } = yield* moveRunningThread(name);
        const commandId = CommandId.make(`${name}:end`);
        yield* orchestrator.dispatch(command(threadId, commandId));

        const ended = yield* commandResults(commandId);
        assert.include(ended.eventTypes, "provider-session.detached", name);
        assert.deepEqual(
          ended.detaches,
          [{ type: "provider-session.detach", providerSessionId: session.id, ...expected }],
          name,
        );
      }
    }),
  );
});
