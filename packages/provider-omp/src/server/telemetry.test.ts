// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Metric from "effect/Metric";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as Tracer from "effect/Tracer";

import { OMP_LOCK } from "../ompLock.ts";
import { makeOmpAdapter } from "./adapter.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import { OmpFramingError } from "./rpcFrames.ts";
import { OmpContractMismatchError, OmpRpcError, OmpRpcTimeoutError } from "./rpcProcess.ts";
import { ompStateDirs } from "./session.ts";
import {
  OMP_METRIC_ATTRIBUTE_RULES,
  ompErrorClass,
  ompLockVersionLabel,
  ompMetricAttributes,
} from "./telemetry.ts";
import { makeOmpThreadSessions } from "./threadSessions.ts";
import { fakeOmpFrames, makeFakeOmpState } from "./testing/fakeOmp.ts";

const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const INSTANCE_ID = ProviderInstanceId.make("omp-telemetry");
const THREAD_ID = ThreadId.make("thread/telemetry");
const OMP_VERSION = ompLockVersionLabel(OMP_LOCK);
const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
  runtimeMode: "full-access",
  interactionMode: "default",
  cwd: null,
});

/** Everything a turn carries that must never reach telemetry: prompt, reply, paths, secrets. */
const CONTENT = {
  prompt: "Deploy with key sk-live-PROMPTSECRET to /Users/alice/private/prod",
  reply: "REPLY-CONTENT the token is ghp_REPLYSECRET",
  thinking: "THINKING-CONTENT",
  toolPath: "/Users/alice/private/app.ts",
  toolOutput: "TOOL-OUTPUT password=hunter2",
  extensionPath: "/Users/alice/.omp/extensions/leaky.ts",
  extensionError: "EXTENSION-ERROR at /Users/alice/.omp",
  frameError: "FRAME-ERROR payload of /Users/alice/huge.log",
  sessionFile: "/Users/alice/.omp/sessions/telemetry.jsonl",
} as const;
const CONTENT_NEEDLES = [
  ...Object.values(CONTENT),
  "sk-live",
  "ghp_",
  "hunter2",
  "/Users/",
  "alice",
  "SECRET",
];

const ompSnapshots = Metric.snapshot.pipe(
  Effect.map((snapshots) => snapshots.filter((snapshot) => snapshot.id.startsWith("t3_omp_"))),
);
const countOf = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
): number =>
  snapshots
    .filter(
      (snapshot) =>
        snapshot.id === id &&
        Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
    )
    .reduce(
      (total, snapshot) => total + (snapshot.type === "Counter" ? Number(snapshot.state.count) : 0),
      0,
    );

/** The guard itself: every OMP metric attribute is allow-listed and passes its value rule. */
const assertNoContent = (snapshots: ReadonlyArray<Metric.Metric.Snapshot>) => {
  for (const snapshot of snapshots) {
    for (const [key, value] of Object.entries(snapshot.attributes ?? {})) {
      assert.isTrue(
        Object.hasOwn(OMP_METRIC_ATTRIBUTE_RULES, key),
        `${snapshot.id} carries attribute key "${key}", which is not allow-listed`,
      );
      const rule = OMP_METRIC_ATTRIBUTE_RULES[key as keyof typeof OMP_METRIC_ATTRIBUTE_RULES];
      assert.isTrue(rule(String(value)), `${snapshot.id}.${key} = "${String(value)}"`);
      for (const needle of CONTENT_NEEDLES) {
        assert.notInclude(String(value), needle, `${snapshot.id}.${key} carries content`);
      }
    }
  }
};

describe("OMP telemetry attributes", () => {
  it("keeps allow-listed keys only and replaces any value off its rule", () => {
    const recorded = ompMetricAttributes({
      ompVersion: CONTENT.prompt,
      ompContract: "1.6.0",
      errorClass: CONTENT.extensionError as never,
      // A key outside the allow-list, smuggled past the type.
      ...({ prompt: CONTENT.prompt } as object),
    } as never);
    assert.deepStrictEqual(recorded, [
      ["provider", "omp"],
      ["ompVersion", "other"],
      ["ompContract", "1.6.0"],
      ["errorClass", "other"],
    ]);
  });

  it("classifies errors from their tag and reason, never their message", () => {
    assert.strictEqual(
      ompErrorClass(new OmpRpcError({ reason: "closed", detail: CONTENT.prompt })),
      "closed",
    );
    assert.strictEqual(
      ompErrorClass(
        new OmpRpcError({
          reason: "protocol",
          detail: CONTENT.frameError,
          cause: new OmpFramingError("frame_too_large", CONTENT.frameError),
        }),
      ),
      "framing_frame_too_large",
    );
    assert.strictEqual(
      ompErrorClass(
        new OmpContractMismatchError({ expected: "1.6.0", actual: "2.0.0", stage: "ready" }),
      ),
      "contract_mismatch",
    );
    assert.strictEqual(
      ompErrorClass(new OmpRpcTimeoutError({ command: "get_state", timeoutMs: 1 })),
      "rpc_timeout",
    );
    assert.strictEqual(ompErrorClass(new Error(CONTENT.prompt)), "other");
  });

  it("records metrics only in telemetry.ts, so nothing bypasses the allow-list", () => {
    const root = NodePath.dirname(NodeURL.fileURLToPath(new URL("..", import.meta.url)));
    const offenders: Array<string> = [];
    const visit = (dir: string) => {
      for (const entry of NodeFS.readdirSync(dir, { withFileTypes: true })) {
        const file = NodePath.join(dir, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (
          entry.name.endsWith(".ts") &&
          !entry.name.endsWith(".test.ts") &&
          entry.name !== "telemetry.ts" &&
          /effect\/Metric"|Metric\.(counter|gauge|timer|histogram|update|withAttributes)\(/.test(
            NodeFS.readFileSync(file, "utf8"),
          )
        ) {
          offenders.push(NodePath.relative(root, file));
        }
      }
    };
    visit(NodePath.join(root, "src"));
    assert.deepStrictEqual(offenders, []);
  });
});

posixOnly("OMP telemetry on a real adapter turn", () => {
  it.live("records driver kind, version, outcomes, errors and drops, and no content", () => {
    const spans: Array<Tracer.NativeSpan> = [];
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        spans.push(span);
        return span;
      },
    });
    const [promptAck, ...promptFrames] = fakeOmpFrames.promptTurn({
      text: [CONTENT.reply],
      thinking: [CONTENT.thinking],
      tool: {
        toolCallId: "call-read",
        toolName: "read",
        args: { path: CONTENT.toolPath },
        result: { content: [{ type: "text", text: CONTENT.toolOutput }] },
      },
    });
    return Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const script = state.script({
        // Before any turn: dropped and counted. Frames are handled in order, so it is counted
        // before the turn's terminal event.
        afterNegotiate: [{ emit: { type: "notice", level: "info", message: CONTENT.reply } }],
        commands: {
          get_state: [
            {
              respond: {
                sessionId: "fake-session",
                sessionFile: CONTENT.sessionFile,
                todoPhases: [],
              },
            },
          ],
          set_session_name: [{ respond: null }],
          prompt: [
            promptAck!,
            // An event OMP had to drop, and an extension that failed, both carrying content.
            {
              emit: {
                type: "rpc_frame_error",
                error: CONTENT.frameError,
                originalType: "tool_execution_end",
              },
            },
            {
              emit: {
                type: "extension_error",
                extensionPath: CONTENT.extensionPath,
                event: "tool_call",
                error: CONTENT.extensionError,
              },
            },
            ...promptFrames,
          ],
        },
      });
      const path = yield* Path.Path;
      const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
      const makeAdapter = (expectedContractVersion: string) =>
        Effect.gen(function* () {
          return yield* makeOmpAdapter({
            instanceId: INSTANCE_ID,
            profile: "",
            environment: state.env(script),
            platform,
            defaultCwd: state.dir,
            resolveBinary: Effect.succeed(state.executable()),
            dirs,
            pidfiles: yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform }),
            expectedContractVersion,
            ompVersion: OMP_VERSION,
            threadSessions: makeOmpThreadSessions(),
            sessions: state.sessions,
          });
        });

      const adapter = yield* makeAdapter("1.0.0");
      yield* Effect.gen(function* () {
        const session = yield* adapter.openSession({
          threadId: THREAD_ID,
          providerSessionId: ProviderSessionId.make("session-telemetry"),
          modelSelection: { instanceId: INSTANCE_ID, model: "default" },
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId: THREAD_ID,
          modelSelection: { instanceId: INSTANCE_ID, model: "default" },
          runtimePolicy,
        });
        const now = yield* DateTime.now;
        const appThread: OrchestrationV2AppThread = {
          createdBy: "user",
          creationSource: "web",
          id: THREAD_ID,
          projectId: "project:omp" as OrchestrationV2AppThread["projectId"],
          title: "Telemetry thread",
          providerInstanceId: INSTANCE_ID,
          modelSelection: { instanceId: INSTANCE_ID, model: "default" },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: providerThread.id,
          lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: THREAD_ID },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        };
        yield* session.startTurn({
          appThread,
          threadId: THREAD_ID,
          runId: RunId.make("run:telemetry:1"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("run-attempt:telemetry:1"),
          rootNodeId: NodeId.make("node:telemetry:root"),
          providerThread,
          message: {
            messageId: "message:telemetry:1" as never,
            text: CONTENT.prompt,
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection: { instanceId: INSTANCE_ID, model: "default" },
          runtimePolicy,
        });
        yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runDrain,
        );
      }).pipe(Effect.scoped);

      // A sidecar speaking another contract: the start fails, and only its class is kept.
      const mismatched = yield* makeAdapter("9.9.9");
      yield* mismatched
        .openSession({
          threadId: ThreadId.make("thread/telemetry-mismatch"),
          providerSessionId: ProviderSessionId.make("session-telemetry-mismatch"),
          modelSelection: { instanceId: INSTANCE_ID, model: "default" },
          runtimePolicy,
        })
        .pipe(Effect.scoped, Effect.flip);

      const snapshots = yield* ompSnapshots;
      const base = { provider: "omp", ompVersion: OMP_VERSION };
      const running = { ...base, ompContract: "1.0.0" };
      assert.strictEqual(
        countOf(snapshots, "t3_omp_sessions_total", { ...running, outcome: "started" }),
        1,
      );
      assert.strictEqual(
        countOf(snapshots, "t3_omp_turns_total", { ...running, outcome: "completed" }),
        1,
      );
      assert.strictEqual(
        countOf(snapshots, "t3_omp_frames_dropped_total", {
          ...running,
          reason: "sidecar_oversize",
        }),
        1,
      );
      assert.isAtLeast(
        countOf(snapshots, "t3_omp_frames_dropped_total", { ...running, reason: "out_of_turn" }),
        1,
      );
      assert.strictEqual(
        countOf(snapshots, "t3_omp_errors_total", { ...running, errorClass: "extension" }),
        1,
      );
      assert.strictEqual(
        countOf(snapshots, "t3_omp_sessions_total", {
          ...base,
          ompContract: "unknown",
          outcome: "failed",
          errorClass: "contract_mismatch",
        }),
        1,
      );
      assertNoContent(snapshots);

      // Spans the driver opens carry no content either.
      const ompSpans = spans.filter((span) => /omp/i.test(span.name));
      assert.isNotEmpty(ompSpans);
      for (const span of ompSpans) {
        for (const [key, value] of span.attributes) {
          for (const needle of CONTENT_NEEDLES) {
            assert.notInclude(String(value), needle, `span ${span.name} attribute ${key}`);
          }
        }
      }
    }).pipe(
      Effect.withTracer(tracer),
      Effect.provideService(Metric.MetricRegistry, new Map()),
      Effect.scoped,
      Effect.provide(NodeServices.layer),
    );
  });
});
