import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentTranscriptEntry,
  ThreadId,
} from "@t3tools/contracts";
import {
  applyTranscriptPage,
  EMPTY_SUBAGENT_TRANSCRIPT,
  isSubagentActive,
  SUBAGENT_TRANSCRIPT_POLL_MS,
  type SubagentTranscriptState,
} from "@t3tools/client-runtime/state/agents-tree";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "~/hooks/useStableCallback";
import { orchestrationEnvironment } from "~/state/orchestration";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

export interface SubagentTranscriptView {
  readonly entries: ReadonlyArray<OrchestrationV2SubagentTranscriptEntry>;
  readonly error: string | null;
  readonly loading: boolean;
}

interface KeyedTranscriptView extends SubagentTranscriptView {
  readonly key: string;
}

/**
 * Reads the selected subagent's transcript from the start, then pages from `nextByte` every
 * {@link SUBAGENT_TRANSCRIPT_POLL_MS} while it runs, and once more when it stops.
 */
export function useSubagentTranscript(input: {
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly threadId: ThreadId;
  readonly subagent: Pick<OrchestrationV2Subagent, "id" | "status" | "controls"> | null;
}): SubagentTranscriptView {
  const { environmentId, threadId, subagent } = input;
  const subagentId = subagent?.id ?? null;
  const key =
    environmentId && subagentId !== null && subagent?.controls?.transcript === true
      ? `${environmentId}\u0000${threadId}\u0000${subagentId}`
      : null;
  const active = subagent !== null && isSubagentActive(subagent.status);

  const readCommand = useAtomCommand(orchestrationEnvironment.readSubagentTranscript, {
    // Polling would repeat the same failure every tick; the panel shows it instead.
    reportFailure: false,
  });
  const read = useStableCallback(readCommand);
  const transcriptRef = useRef<{ key: string; transcript: SubagentTranscriptState } | null>(null);
  const [view, setView] = useState<KeyedTranscriptView | null>(null);

  useEffect(() => {
    if (key === null || !environmentId || subagentId === null) {
      // Selecting a subagent again reads it from the start.
      transcriptRef.current = null;
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () =>
      transcriptRef.current?.key === key
        ? transcriptRef.current.transcript
        : EMPTY_SUBAGENT_TRANSCRIPT;
    const readOnce = async () => {
      const result = await read({
        environmentId,
        input: { threadId, subagentId, fromByte: current().nextByte },
      });
      if (cancelled || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Success") {
        const transcript = applyTranscriptPage(current(), result.value);
        transcriptRef.current = { key, transcript };
        setView({ key, entries: transcript.entries, error: null, loading: false });
      } else {
        const error = formatEnvironmentQueryError(result.cause);
        setView({ key, entries: current().entries, error, loading: false });
      }
    };
    const poll = async () => {
      await readOnce();
      // Inactive: this was the first read, or the final one after the subagent stopped.
      if (!cancelled && active) timer = setTimeout(() => void poll(), SUBAGENT_TRANSCRIPT_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, environmentId, key, read, subagentId, threadId]);

  if (key === null) return { entries: [], error: null, loading: false };
  if (view?.key !== key) return { entries: [], error: null, loading: true };
  return view;
}
