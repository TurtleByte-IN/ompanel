/**
 * An OMP thread's goal on mobile (PRD FR-23e; docs/omp/composer.md): what it is, how far it
 * got, and pause, resume, drop or set one. Every action is a standalone `/goal …` turn queued
 * through the thread outbox, the same path the composer sends through.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import { presentProviderGoal } from "@t3tools/client-runtime/state/thread-execution";
import {
  AuthOrchestrationOperateScope,
  CommandId,
  MessageId,
  type EnvironmentId,
  type OrchestrationV2ProviderGoal,
  type ThreadId,
} from "@t3tools/contracts";
import { ompGoalCommandText } from "@t3tools/provider-omp/composer";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { useThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";

type GoalStatus = OrchestrationV2ProviderGoal["status"];

const STATUS_TEXT_CLASS: Record<GoalStatus, string> = {
  active: "text-foreground",
  paused: "text-foreground-muted",
  blocked: "text-warning-foreground",
  usage_limited: "text-warning-foreground",
  budget_limited: "text-warning-foreground",
  complete: "text-foreground",
};

const INPUT_CLASS = "rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";

export interface GoalPanelViewProps {
  /** The thread's goal, updated live; null when it has none. */
  readonly goal: OrchestrationV2ProviderGoal | null;
  /** The thread is working: an active goal is being pursued and actions wait for it. */
  readonly working: boolean;
  /** The goal cannot be changed now: no permission to operate the thread, or a send is in flight. */
  readonly disabled: boolean;
  /** Why the last command did not send; null when it did. */
  readonly error: string | null;
  /** Sends a `/goal …` command as its own turn. */
  readonly onSendCommand: (text: string, failureMessage: string) => void;
}

/** Number of tokens in a budget field: empty is no budget, anything but a positive integer is invalid. */
export function parseTokenBudget(value: string): number | null | "invalid" {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  if (!/^\d+$/.test(trimmed)) return "invalid";
  const tokens = Number(trimmed);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : "invalid";
}

export function GoalPanelView(props: GoalPanelViewProps) {
  const { goal, working, disabled, onSendCommand } = props;
  return (
    <View className="gap-5 pt-2">
      {goal === null ? null : (
        <GoalSummary
          goal={goal}
          working={working}
          disabled={disabled}
          onSendCommand={onSendCommand}
        />
      )}
      {goal === null || goal.status === "complete" ? (
        <SetGoalForm
          replacesComplete={goal !== null}
          disabled={disabled || working}
          onSendCommand={onSendCommand}
        />
      ) : null}
      {props.error === null ? null : (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {props.error}
        </Text>
      )}
      <Text className="text-xs text-foreground-muted">
        OMP keeps working on a goal by itself only when its goal.continuationModes setting includes
        rpc; otherwise each message you send works toward it.
      </Text>
    </View>
  );
}

function GoalSummary(props: {
  readonly goal: OrchestrationV2ProviderGoal;
  readonly working: boolean;
  readonly disabled: boolean;
  readonly onSendCommand: GoalPanelViewProps["onSendCommand"];
}) {
  const { goal, working, disabled, onSendCommand } = props;
  const presentation = presentProviderGoal(goal, working);
  const send = (op: "pause" | "resume" | "drop") =>
    onSendCommand(ompGoalCommandText({ op }), `Failed to ${op} goal.`);
  return (
    <View accessibilityLabel="Goal" className="gap-2">
      <Text className={`font-t3-bold text-sm ${STATUS_TEXT_CLASS[goal.status]}`}>
        {presentation.title}
      </Text>
      <Text className="text-base text-foreground">{presentation.objective}</Text>
      {presentation.usage === null ? null : (
        <Text className="text-xs text-foreground-muted">{presentation.usage}</Text>
      )}
      {goal.tokenBudget == null ? null : (
        <Text className="text-xs text-foreground-muted">
          Token budget: {goal.tokenBudget.toLocaleString()}
        </Text>
      )}
      {working ? (
        <Text className="text-xs text-foreground-muted">
          You can pause, resume or drop the goal once this turn ends.
        </Text>
      ) : (
        <View className="flex-row flex-wrap gap-2">
          {goal.status === "active" ? (
            <Button
              label="Pause"
              tone="secondary"
              disabled={disabled}
              onPress={() => send("pause")}
            />
          ) : null}
          {presentation.canResume ? (
            <Button
              label="Resume"
              tone="secondary"
              disabled={disabled}
              onPress={() => send("resume")}
            />
          ) : null}
          <Button label="Drop" tone="text" disabled={disabled} onPress={() => send("drop")} />
        </View>
      )}
    </View>
  );
}

function SetGoalForm(props: {
  /** The thread has a completed goal the new one replaces. */
  readonly replacesComplete: boolean;
  readonly disabled: boolean;
  readonly onSendCommand: GoalPanelViewProps["onSendCommand"];
}) {
  const { replacesComplete, disabled, onSendCommand } = props;
  const [objective, setObjective] = useState("");
  const [budget, setBudget] = useState("");
  const tokenBudget = parseTokenBudget(budget);
  const canSubmit = !disabled && objective.trim() !== "" && tokenBudget !== "invalid";
  const submit = () => {
    if (!canSubmit) return;
    onSendCommand(
      ompGoalCommandText({
        op: "create",
        objective,
        ...(tokenBudget === null ? {} : { tokenBudget }),
      }),
      "Failed to set goal.",
    );
    setObjective("");
    setBudget("");
  };
  return (
    <View accessibilityLabel="Set a goal" className="gap-3">
      <View className="gap-1">
        <Text className="font-t3-medium text-sm text-foreground">
          {replacesComplete ? "Set a new goal" : "No goal set"}
        </Text>
        <Text className="text-xs text-foreground-muted">
          OMP works toward the goal across turns and reports when it is done.
        </Text>
      </View>
      <View className="gap-1.5">
        <Text className="text-xs text-foreground-muted">Objective</Text>
        <TextInput
          accessibilityLabel="Objective"
          className={`${INPUT_CLASS} min-h-20`}
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder="What should this thread achieve?"
          multiline
          editable={!disabled}
          value={objective}
          onChangeText={setObjective}
        />
      </View>
      <View className="gap-1.5">
        <Text className="text-xs text-foreground-muted">Token budget (optional)</Text>
        <TextInput
          accessibilityLabel="Token budget (optional)"
          className={INPUT_CLASS}
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder="No limit"
          keyboardType="number-pad"
          editable={!disabled}
          value={budget}
          onChangeText={setBudget}
        />
        {tokenBudget === "invalid" ? (
          <Text accessibilityRole="alert" className="text-xs text-danger-foreground">
            Enter a whole number of tokens.
          </Text>
        ) : null}
      </View>
      <View className="flex-row">
        <Button label="Set goal" disabled={!canSubmit} onPress={submit} />
      </View>
    </View>
  );
}

/** Queues `text` as its own user turn, the way the composer queues a message. */
export function enqueueOmpCommandTurn(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
}): Promise<void> {
  const metadata = makeQueuedMessageMetadata();
  return enqueueThreadOutboxMessage({
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: MessageId.make(metadata.messageId),
    commandId: CommandId.make(metadata.commandId),
    text: input.text,
    attachments: [],
    createdAt: metadata.createdAt,
  });
}

/** The goal of the thread at `environmentId`/`threadId`, live, with its commands wired. */
export function ThreadGoalPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { environmentId, threadId } = props;
  const thread = useThreadShell(scopeThreadRef(environmentId, threadId));
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const send = (text: string, failureMessage: string) => {
    if (sending) return;
    setSending(true);
    setError(null);
    enqueueOmpCommandTurn({ environmentId, threadId, text }).then(
      () => setSending(false),
      (cause: unknown) => {
        setSending(false);
        setError(cause instanceof Error ? cause.message : failureMessage);
      },
    );
  };
  return (
    <GoalPanelView
      goal={thread?.goal ?? null}
      working={threadRuntimeIsActive(thread?.runtime)}
      disabled={thread === null || !canOperate || sending}
      error={error}
      onSendCommand={send}
    />
  );
}
