import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelayAgentActivityState } from "@t3tools/contracts/relay";
import { makeAggregateState } from "./agentActivityAggregate.ts";
import {
  agentMessageAlertAllowed,
  attentionTransitionRows,
  newAgentMessage,
  terminalTransitionRows,
  shouldAlertForActivity,
} from "./agentActivityAlerts.ts";

const state: RelayAgentActivityState = {
  environmentId: EnvironmentId.make("env"),
  threadId: ThreadId.make("thread"),
  projectTitle: "Project",
  threadTitle: "Thread",
  modelTitle: "Model",
  headline: "Working",
  phase: "running",
  updatedAt: "1970-01-01T00:00:00.000Z",
  deepLink: "/threads/env/thread",
};
const preferences = {
  notificationsEnabled: true,
  liveActivitiesEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};
const aggregate = (states: RelayAgentActivityState[]) =>
  makeAggregateState({ activeStates: states, terminalState: null, nowMs: 0 })!;

describe("shared agent activity policy", () => {
  it.each(["waiting_for_approval", "waiting_for_input"] as const)(
    "keeps an older %s ahead of five running rows",
    (phase) => {
      const running = Array.from({ length: 5 }, (_, i) => ({
        ...state,
        threadId: ThreadId.make(`running-${i}`),
      }));
      const waiting = { ...state, phase, updatedAt: "1969-12-31T23:59:00.000Z" };
      const next = aggregate([...running, waiting]);
      expect(next.activities[0]?.threadId).toBe(state.threadId);
      expect(next.activeCount).toBe(6);
      expect(next.activities).toHaveLength(5);
      expect(
        attentionTransitionRows({
          previousAggregate: aggregate(running),
          nextAggregate: next,
          preferences,
        }),
      ).toMatchObject([{ threadId: state.threadId }]);
    },
  );

  it("allows fresh unobserved completions for events, but not reconciliation or repeats", () => {
    const previousAggregate = aggregate([
      { ...state, threadId: ThreadId.make("old"), phase: "completed" },
    ]);
    const nextAggregate = aggregate([{ ...state, phase: "completed" }]);
    const input = { previousAggregate, nextAggregate, preferences, nowMs: 0 };
    expect(terminalTransitionRows(input)).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true })).toHaveLength(1);
    expect(
      terminalTransitionRows({
        ...input,
        includeUnobserved: true,
        previousAggregate: nextAggregate,
      }),
    ).toEqual([]);
    expect(terminalTransitionRows({ ...input, includeUnobserved: true, nowMs: 180_000 })).toEqual(
      [],
    );
  });

  it("distinguishes equal thread IDs across environments", () => {
    const waiting = { ...state, phase: "waiting_for_input" as const };
    const other = { ...waiting, environmentId: EnvironmentId.make("other") };
    expect(
      attentionTransitionRows({
        previousAggregate: aggregate([waiting]),
        nextAggregate: aggregate([waiting, other]),
        preferences,
      }),
    ).toMatchObject([{ environmentId: other.environmentId }]);
  });

  it("checks current permission, event preferences, and freshness together", () => {
    const input = { ...state, phase: "completed" as const, preferences, nowMs: 0 };
    expect(shouldAlertForActivity(input)).toBe(true);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notificationsEnabled: false },
      }),
    ).toBe(false);
    expect(
      shouldAlertForActivity({
        ...input,
        preferences: { ...preferences, notifyOnCompletion: false },
      }),
    ).toBe(false);
    expect(shouldAlertForActivity({ ...input, nowMs: 180_000 })).toBe(false);
  });

  it("alerts an agent message once, while the agent works, and only while it is fresh", () => {
    const agentMessage = { id: "notify:1", text: "Build is green", sentAt: state.updatedAt };
    const next = { ...state, agentMessage };
    expect(newAgentMessage({ previous: state, next, nowMs: 0 })).toEqual(agentMessage);
    // The relay has no row yet: a first publish that already carries a message still alerts.
    expect(newAgentMessage({ previous: null, next, nowMs: 0 })).toEqual(agentMessage);
    // Republishing the same message (a phase or title change) never rings again.
    expect(newAgentMessage({ previous: next, next, nowMs: 0 })).toBeNull();
    expect(
      newAgentMessage({
        previous: next,
        next: { ...next, agentMessage: { ...agentMessage, id: "notify:2" } },
        nowMs: 0,
      }),
    ).toMatchObject({ id: "notify:2" });
    // Attention and terminal phases carry their own alerts.
    for (const phase of ["waiting_for_input", "completed", "failed"] as const) {
      expect(newAgentMessage({ previous: state, next: { ...next, phase }, nowMs: 0 })).toBeNull();
    }
    // A replay long after the agent sent it stays quiet.
    expect(newAgentMessage({ previous: state, next, nowMs: 180_000 })).toBeNull();
    expect(newAgentMessage({ previous: state, next: state, nowMs: 0 })).toBeNull();
  });

  it("honours the agent-message preference; devices registered before it get messages", () => {
    expect(agentMessageAlertAllowed(preferences)).toBe(true);
    expect(agentMessageAlertAllowed({ ...preferences, notifyOnAgentMessage: true })).toBe(true);
    expect(agentMessageAlertAllowed({ ...preferences, notifyOnAgentMessage: false })).toBe(false);
    expect(agentMessageAlertAllowed({ ...preferences, notificationsEnabled: false })).toBe(false);
    expect(agentMessageAlertAllowed(null)).toBe(false);
  });
});
