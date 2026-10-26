import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { assert, it as effectIt } from "@effect/vitest";
import { describe, expect, it } from "vite-plus/test";

import * as Schema from "effect/Schema";

import { OmpSettings } from "../settings.ts";
import { ompUsageFormat, ompUsageReader } from "./usage.ts";

const usage = (input: number, output: number, cost = 0) => ({
  input,
  output,
  cacheRead: 1_000,
  cacheWrite: 10,
  totalTokens: input + output + 1_010,
  reasoningTokens: 5,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
});

/** A session file as the pinned omp writes it. */
const LINES = [
  {
    type: "session",
    version: 3,
    id: "omp-session-1",
    timestamp: "2026-10-26T10:00:00.000Z",
    cwd: "/w",
  },
  {
    type: "message",
    id: "a1",
    parentId: null,
    timestamp: "2026-10-26T10:00:01.000Z",
    message: { role: "user", content: "hi", timestamp: 1 },
  },
  {
    type: "message",
    id: "a2",
    parentId: "a1",
    timestamp: "2026-10-26T10:00:02.000Z",
    message: {
      role: "assistant",
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      api: "anthropic-messages",
      usage: usage(100, 50, 0.01),
    },
  },
  {
    type: "model_usage",
    id: "a3",
    parentId: "a2",
    timestamp: "2026-10-26T10:00:03.000Z",
    purpose: "title",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5-mini",
    usage: usage(20, 5),
    stopReason: "stop",
  },
  // A task result sums its subagents, whose own transcripts are counted instead.
  {
    type: "message",
    id: "a4",
    parentId: "a3",
    timestamp: "2026-10-26T10:00:04.000Z",
    message: { role: "toolResult", toolName: "task", details: { usage: usage(999, 999, 9) } },
  },
].map((line) => JSON.stringify(line));

describe("ompUsageFormat", () => {
  it("reads assistant messages and model_usage entries under the session id", () => {
    const state = { sessionId: "" };
    const records = LINES.flatMap((line) => ompUsageFormat.parseLine(line, state));
    expect(records).toEqual([
      {
        provider: "omp",
        timestampMs: Date.parse("2026-10-26T10:00:02.000Z"),
        model: "anthropic/claude-sonnet-4-5",
        rateModel: "claude-sonnet-4-5",
        sessionId: "omp-session-1",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 1_000,
          cacheCreationTokens: 10,
          outputTokens: 50,
          reasoningTokens: 5,
        },
        reportedCostUsd: 0.01,
        speed: "standard",
        dedupeKey: JSON.stringify([
          "omp",
          "a2",
          "2026-10-26T10:00:02.000Z",
          "anthropic/claude-sonnet-4-5",
        ]),
      },
      expect.objectContaining({
        model: "openai/gpt-5-mini",
        // A subscription login records no price: the shared price table fills it in.
        reportedCostUsd: null,
        sessionId: "omp-session-1",
      }),
    ]);
  });

  it("skips malformed lines and entries without usage", () => {
    const state = { sessionId: "" };
    expect(ompUsageFormat.parseLine("{not json", state)).toEqual([]);
    expect(
      ompUsageFormat.parseLine(
        JSON.stringify({ type: "model_change", id: "m", timestamp: "2026-10-26T10:00:00Z" }),
        state,
      ),
    ).toEqual([]);
  });
});

describe("ompUsageReader", () => {
  const directories = (profile: string, environment: NodeJS.ProcessEnv) => {
    if (ompUsageReader.kind !== "transcripts") throw new Error("expected a transcript reader");
    return ompUsageReader
      .directories({
        instanceId: ProviderInstanceId.make("omp"),
        config: Schema.decodeSync(OmpSettings)({ profile }),
        environment,
        configured: true,
      })
      .pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.HomeDirectory, "/home/server"),
      );
  };

  effectIt.effect("reads the sessions of the instance's profile, as its threads write them", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* directories("", { HOME: "/home/tester" }), [
        { dir: "/home/tester/.omp/agent/sessions" },
      ]);
      assert.deepStrictEqual(yield* directories("work", { HOME: "/home/tester" }), [
        { dir: "/home/tester/.omp/profiles/work/agent/sessions" },
      ]);
      assert.deepStrictEqual(
        yield* directories("", { HOME: "/home/tester", PI_CODING_AGENT_SESSION_DIR: "/data/s" }),
        [{ dir: "/data/s" }],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
