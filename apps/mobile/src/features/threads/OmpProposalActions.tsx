// Accept and Reject on a staged OMP `ast_edit` card (PRD FR-18b). The card itself follows the
// thread's events, whoever resolves the proposal first: the user here, on web, or the agent.
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OmpProposalAction, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { View } from "react-native";

import { Button } from "../../components/ui/Button";
import { serverEnvironment } from "../../state/server";
import { environmentThreadDetails } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function OmpProposalActions(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The `ast_edit` tool call that staged the proposal. */
  readonly toolCallId: string;
}) {
  const instanceId = useAtomValue(
    environmentThreadDetails.threadAtom(scopeThreadRef(props.environmentId, props.threadId)),
    (thread) => thread?.projection.thread.providerInstanceId ?? null,
  );
  const resolve = useAtomCommand(serverEnvironment.resolveOmpProposal, "resolve OMP proposal");
  const [pending, setPending] = useState<OmpProposalAction | null>(null);
  if (instanceId === null) return null;
  const press = (action: OmpProposalAction) => {
    setPending(action);
    void Haptics.selectionAsync();
    void resolve({
      environmentId: props.environmentId,
      input: { instanceId, threadId: props.threadId, toolCallId: props.toolCallId, action },
    }).finally(() => setPending(null));
  };
  return (
    <View className="flex-row gap-2">
      <Button
        label="Accept"
        accessibilityLabel="Accept the proposed edit"
        loading={pending === "apply"}
        disabled={pending !== null}
        onPress={() => press("apply")}
      />
      <Button
        label="Reject"
        tone="secondary"
        accessibilityLabel="Reject the proposed edit"
        loading={pending === "discard"}
        disabled={pending !== null}
        onPress={() => press("discard")}
      />
    </View>
  );
}
