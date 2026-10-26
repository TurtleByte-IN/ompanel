import { expect, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentControlAction,
  OrchestrationV2SubagentControlError,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const OMP = ProviderDriverKind.make("omp");
const INSTANCE = ProviderInstanceId.make("omp-work");
const THREAD = ThreadId.make("thread:subagent-control");
const PROVIDER_THREAD = ProviderThreadId.make("provider-thread:subagent-control");
const SESSION = ProviderSessionId.make("provider-session:subagent-control");
const SUBAGENT = NodeId.make("node:subagent-control:reader");
const T0 = DateTime.makeUnsafe("2026-10-26T10:00:00.000Z");

const subagent: OrchestrationV2Subagent = {
  id: SUBAGENT,
  threadId: THREAD,
  runId: RunId.make("run:subagent-control"),
  parentNodeId: NodeId.make("node:subagent-control:root"),
  origin: "provider_native",
  createdBy: "agent",
  driver: OMP,
  providerInstanceId: INSTANCE,
  providerThreadId: PROVIDER_THREAD,
  childThreadId: null,
  nativeTaskRef: { driver: OMP, nativeId: "Reader", strength: "strong" },
  prompt: "Read src/auth.ts",
  title: "Reader (explore)",
  model: null,
  status: "running",
  result: null,
  startedAt: T0,
  completedAt: null,
  updatedAt: T0,
};

const providerThread = {
  id: PROVIDER_THREAD,
  driver: OMP,
  providerInstanceId: INSTANCE,
  providerSessionId: SESSION,
  appThreadId: THREAD,
} as OrchestrationV2ProviderThread;

interface Calls {
  readonly control: Array<{ nativeTaskId: string; action: OrchestrationV2SubagentControlAction }>;
  readonly read: Array<{ nativeTaskId: string; fromByte: number }>;
}

type Runtime = ProviderAdapter.ProviderAdapterV2SessionRuntime;
type ControlInput = Parameters<NonNullable<Runtime["controlSubagent"]>>[0];
type ReadInput = Parameters<NonNullable<Runtime["readSubagentTranscript"]>>[0];

const layerWith = (options: {
  readonly calls: Calls;
  readonly live?: boolean;
  readonly refuse?: string;
}) =>
  ThreadManagementService.layer.pipe(
    Layer.provide(
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
        get: () =>
          Effect.succeed(
            options.live === false
              ? Option.none()
              : Option.some({
                  controlSubagent: (input: ControlInput) =>
                    options.refuse === undefined
                      ? Effect.sync(() => {
                          options.calls.control.push({
                            nativeTaskId: input.nativeTaskId,
                            action: input.action,
                          });
                        })
                      : Effect.fail(
                          new ProviderAdapter.ProviderAdapterProtocolError({
                            driver: OMP,
                            detail: options.refuse,
                          }),
                        ),
                  readSubagentTranscript: (input: ReadInput) =>
                    Effect.sync(() => {
                      options.calls.read.push({
                        nativeTaskId: input.nativeTaskId,
                        fromByte: input.fromByte,
                      });
                      return { fromByte: input.fromByte, nextByte: 64, reset: false, entries: [] };
                    }),
                } as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime),
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(Orchestrator.OrchestratorV2)({
        getThreadRecords: () =>
          Effect.succeed({
            thread: { id: THREAD, projectId: ProjectId.make("project:subagents"), deletedAt: null },
            subagents: [subagent],
            runs: [],
            providerThreads: [providerThread],
          } as unknown as OrchestrationV2ThreadProjection),
      }),
    ),
    Layer.provide(ServerSettings.layerTest()),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  );

it.effect("routes steer, kill and revive to the owning provider session by native id", () => {
  const calls: Calls = { control: [], read: [] };
  return Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    for (const action of [
      { type: "steer", message: "Only the login path" },
      { type: "kill" },
      { type: "revive", message: "Now logout" },
    ] as const) {
      yield* threads.controlSubagent({ threadId: THREAD, subagentId: SUBAGENT, action });
    }
    const page = yield* threads.readSubagentTranscript({
      threadId: THREAD,
      subagentId: SUBAGENT,
      fromByte: 32,
    });

    expect(calls.control).toEqual([
      { nativeTaskId: "Reader", action: { type: "steer", message: "Only the login path" } },
      { nativeTaskId: "Reader", action: { type: "kill" } },
      { nativeTaskId: "Reader", action: { type: "revive", message: "Now logout" } },
    ]);
    expect(calls.read).toEqual([{ nativeTaskId: "Reader", fromByte: 32 }]);
    expect(page.nextByte).toBe(64);
  }).pipe(Effect.provide(layerWith({ calls })));
});

it.effect("names the subagent errors: unknown, no live session, and the provider's refusal", () => {
  const calls: Calls = { control: [], read: [] };
  return Effect.gen(function* () {
    const unknown = yield* Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      return yield* Effect.flip(
        threads.controlSubagent({
          threadId: THREAD,
          subagentId: NodeId.make("node:subagent-control:missing"),
          action: { type: "kill" },
        }),
      );
    }).pipe(Effect.provide(layerWith({ calls })));
    const offline = yield* Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      return yield* Effect.flip(
        threads.readSubagentTranscript({ threadId: THREAD, subagentId: SUBAGENT }),
      );
    }).pipe(Effect.provide(layerWith({ calls, live: false })));
    const refused = yield* Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      return yield* Effect.flip(
        threads.controlSubagent({
          threadId: THREAD,
          subagentId: SUBAGENT,
          action: { type: "steer", message: "hi" },
        }),
      );
    }).pipe(Effect.provide(layerWith({ calls, refuse: "Subagent not running: Reader" })));

    expect(unknown).toBeInstanceOf(OrchestrationV2SubagentControlError);
    expect(unknown.reason).toBe("not-found");
    expect(offline.reason).toBe("unavailable");
    expect(refused.reason).toBe("failed");
    expect(refused.message).toBe("Subagent not running: Reader");
    expect(calls.control).toEqual([]);
  });
});
