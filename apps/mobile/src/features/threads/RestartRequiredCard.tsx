import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useThreadRestartRequiredSettings } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Settings changed that the thread's session reads only at startup. Restart stops the session;
 * the next turn starts a fresh one with the current settings.
 */
export function RestartRequiredCard(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly canOperateThread: boolean;
  readonly working: boolean;
}) {
  const keys = useThreadRestartRequiredSettings(props.threadRef);
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { threadRef } = props;
  if (threadRef === null || keys.length === 0) return null;
  async function restart() {
    if (threadRef === null) return;
    setPending(true);
    setError(null);
    const result = await stopSession({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    setPending(false);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : "Could not restart the session.");
    }
  }
  return (
    <View className="mx-3 mb-2 gap-2 rounded-xl border border-border bg-card p-3">
      <Text className="text-sm text-foreground">{`Restart to apply ${keys.join(", ")}`}</Text>
      <Text className="text-xs text-foreground-muted">
        {props.working
          ? "The session reads these settings only at startup. Restart after this turn."
          : "The session reads these settings only at startup."}
      </Text>
      {props.canOperateThread ? (
        <View className="flex-row flex-wrap gap-2">
          <Button
            label={pending ? "Restarting..." : "Restart"}
            tone="secondary"
            disabled={pending || props.working}
            onPress={() => void restart()}
          />
        </View>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}
