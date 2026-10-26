// The mobile agents panel for provider-native subagents (OMP): the thread's subagents as an
// indented tree with status and usage, and the selected one's transcript. The web panel
// (apps/web/src/components/agents/AgentsPanel.tsx) shares its view model through
// @t3tools/client-runtime/state/agents-tree.
import {
  applyTranscriptPage,
  buildAgentsTree,
  EMPTY_SUBAGENT_TRANSCRIPT,
  flattenAgentsTree,
  isSubagentActive,
  SUBAGENT_TRANSCRIPT_POLL_MS,
  subagentTitle,
  subagentUsageLabels,
  type SubagentTranscriptState,
} from "@t3tools/client-runtime/state/agents-tree";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentTranscriptEntry,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useAtomCommand } from "../../state/use-atom-command";
import { SUBAGENT_TONE_TEXT_CLASS, SubagentStatusDot } from "./SubagentStatusDot";
import { resolveSubagentRowPresentation } from "./threadAgentsPresentation";

const ROLE_LABEL: Record<OrchestrationV2SubagentTranscriptEntry["role"], string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  system: "System",
};

/** Indent per tree level; deep trees stop indenting so rows keep a readable width on a phone. */
const INDENT_PER_DEPTH = 14;
const MAX_INDENT_DEPTH = 4;

export interface SubagentTranscriptView {
  readonly entries: ReadonlyArray<OrchestrationV2SubagentTranscriptEntry>;
  readonly error: string | null;
  readonly loading: boolean;
}

const NO_TRANSCRIPT: SubagentTranscriptView = { entries: [], error: null, loading: false };

/**
 * Reads the selected subagent's transcript from the start, then pages from `nextByte` while it
 * runs, and once more when it stops.
 */
function useSubagentTranscript(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly subagent: OrchestrationV2Subagent | null;
}): SubagentTranscriptView {
  const { environmentId, threadId, subagent } = input;
  const subagentId = subagent?.controls?.transcript === true ? subagent.id : null;
  const active = subagent !== null && isSubagentActive(subagent.status);
  // Polling would repeat the same failure every tick; the panel shows it instead.
  const read = useAtomCommand(orchestrationEnvironment.readSubagentTranscript, {
    reportFailure: false,
  });
  const transcriptRef = useRef<{ id: string; state: SubagentTranscriptState } | null>(null);
  const [view, setView] = useState<(SubagentTranscriptView & { id: string }) | null>(null);

  useEffect(() => {
    if (subagentId === null) {
      transcriptRef.current = null;
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const current = () =>
      transcriptRef.current?.id === subagentId
        ? transcriptRef.current.state
        : EMPTY_SUBAGENT_TRANSCRIPT;
    const poll = async () => {
      const result = await read({
        environmentId,
        input: { threadId, subagentId, fromByte: current().nextByte },
      });
      if (cancelled || isAtomCommandInterrupted(result)) return;
      if (result._tag === "Success") {
        const state = applyTranscriptPage(current(), result.value);
        transcriptRef.current = { id: subagentId, state };
        setView({ id: subagentId, entries: state.entries, error: null, loading: false });
      } else {
        const failure = squashAtomCommandFailure(result);
        setView({
          id: subagentId,
          entries: current().entries,
          error: failure instanceof Error ? failure.message : "Could not read the transcript.",
          loading: false,
        });
      }
      // Inactive: this was the first read, or the final one after the subagent stopped.
      if (!cancelled && active) timer = setTimeout(() => void poll(), SUBAGENT_TRANSCRIPT_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [active, environmentId, read, subagentId, threadId]);

  if (subagentId === null) return NO_TRANSCRIPT;
  if (view?.id !== subagentId) return { entries: [], error: null, loading: true };
  return view;
}

function Transcript(props: {
  readonly subagent: OrchestrationV2Subagent;
  readonly view: SubagentTranscriptView;
}) {
  const { view } = props;
  if (props.subagent.controls?.transcript !== true) {
    return (
      <Text className="text-sm text-foreground-muted">
        This provider does not share this agent's transcript.
      </Text>
    );
  }
  return (
    <View accessibilityLabel="Transcript" className="gap-2">
      {view.error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {view.error}
        </Text>
      ) : null}
      {view.loading ? (
        <Text className="text-sm text-foreground-muted">Reading transcript…</Text>
      ) : view.entries.length === 0 && !view.error ? (
        <Text className="text-sm text-foreground-muted">No messages yet.</Text>
      ) : null}
      {view.entries.map((entry, index) => (
        <View
          // Entries only append (or reset wholesale), so their position is stable.
          key={index}
          className={cn(
            "gap-0.5 rounded-lg px-2.5 py-1.5",
            entry.role === "user" && "bg-primary/10",
            entry.role === "tool" && "bg-subtle",
          )}
        >
          <Text
            className={cn(
              "text-2xs font-t3-medium uppercase text-foreground-muted",
              entry.isError && "text-danger-foreground",
            )}
          >
            {entry.toolName
              ? `${ROLE_LABEL[entry.role]} · ${entry.toolName}`
              : ROLE_LABEL[entry.role]}
          </Text>
          <Text
            selectable
            className={cn(
              "text-sm leading-normal text-foreground",
              entry.role === "tool" && "font-mono text-xs",
              entry.role === "system" && "italic text-foreground-muted",
            )}
          >
            {entry.text}
          </Text>
        </View>
      ))}
    </View>
  );
}

/** The tree and the selected subagent's transcript; presentational, driven by {@link ThreadAgentsTree}. */
export function AgentsTreeView(props: {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly selectedId: string | null;
  readonly transcript: SubagentTranscriptView;
  readonly onSelect: (subagentId: string) => void;
  readonly onOpenThread: (childThreadId: ThreadId) => void;
}) {
  const rows = flattenAgentsTree(buildAgentsTree(props.subagents));
  return (
    <View accessibilityLabel="Agents" className="gap-px">
      {rows.map(({ subagent, depth }) => {
        const presentation = resolveSubagentRowPresentation(subagent);
        const selected = subagent.id === props.selectedId;
        const childThreadId = subagent.childThreadId;
        const usage = subagentUsageLabels(subagent);
        const title = subagentTitle(subagent);
        return (
          <View key={subagent.id} className="border-b border-border">
            <Pressable
              accessibilityRole={childThreadId === null ? "button" : "link"}
              accessibilityLabel={`${title}, ${presentation.statusLabel}${depth > 0 ? `, level ${depth + 1}` : ""}`}
              accessibilityState={childThreadId === null ? { expanded: selected } : undefined}
              accessibilityHint={
                childThreadId === null
                  ? `Double tap to ${selected ? "hide" : "show"} its transcript.`
                  : "Opens this agent's thread"
              }
              onPress={() =>
                childThreadId === null
                  ? props.onSelect(subagent.id)
                  : props.onOpenThread(childThreadId)
              }
              className="min-h-[44px] flex-row gap-3 py-3 active:opacity-70"
              style={{ paddingLeft: Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PER_DEPTH }}
            >
              <View className="h-5 justify-center">
                <SubagentStatusDot tone={presentation.tone} placement="sheet" />
              </View>
              <View className="min-w-0 flex-1 gap-0.5">
                <Text numberOfLines={2} className="font-t3-medium text-sm text-foreground">
                  {title}
                </Text>
                <Text className={cn("text-xs", SUBAGENT_TONE_TEXT_CLASS[presentation.tone])}>
                  {presentation.statusLabel}
                </Text>
                {usage.length > 0 ? (
                  <Text className="text-xs text-foreground-muted">{usage.join(" · ")}</Text>
                ) : null}
              </View>
            </Pressable>
            {selected ? (
              <View
                className="pb-3"
                style={{ paddingLeft: Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PER_DEPTH }}
              >
                <Transcript subagent={subagent} view={props.transcript} />
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}

/** A thread's provider-native subagents, readable on mobile: tree, status, usage, transcript. */
export function ThreadAgentsTree(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly initialSelectedId?: string | undefined;
  readonly onOpenThread: (childThreadId: ThreadId) => void;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(props.initialSelectedId ?? null);
  const selected = props.subagents.find((subagent) => subagent.id === selectedId) ?? null;
  const transcript = useSubagentTranscript({
    environmentId: props.environmentId,
    threadId: props.threadId,
    subagent: selected,
  });
  return (
    <AgentsTreeView
      subagents={props.subagents}
      selectedId={selectedId}
      transcript={transcript}
      onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
      onOpenThread={props.onOpenThread}
    />
  );
}
