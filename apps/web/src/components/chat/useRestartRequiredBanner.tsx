import { deriveRestartRequiredSettings } from "@t3tools/client-runtime/state/thread-execution";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { RotateCwIcon } from "lucide-react";
import { useState } from "react";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * Settings changed that the thread's session reads only at startup. Restart stops the session;
 * the next turn starts a fresh one with the current settings.
 */
export function useRestartRequiredBanner(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projection: ThreadStructure | null;
  readonly canOperate: boolean;
  readonly working: boolean;
}): ComposerBannerStackItem | null {
  const stopSession = useAtomCommand(threadEnvironment.stopSession, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const keys = input.projection === null ? [] : deriveRestartRequiredSettings(input.projection);
  if (keys.length === 0) return null;
  const { environmentId, threadId } = input;
  const restart = async () => {
    setPending(true);
    const result = await stopSession({ environmentId, input: { threadId } });
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not restart the session",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };
  return {
    id: `restart-required:${threadId}`,
    variant: "info",
    icon: <RotateCwIcon />,
    title: `Restart to apply ${keys.join(", ")}`,
    description: input.working
      ? "The session reads these settings only at startup. Restart after this turn."
      : "The session reads these settings only at startup.",
    actions: input.canOperate ? (
      <Button
        size="xs"
        variant="ghost"
        disabled={pending || input.working}
        onClick={() => void restart()}
      >
        {pending ? "Restarting..." : "Restart"}
      </Button>
    ) : null,
  };
}
