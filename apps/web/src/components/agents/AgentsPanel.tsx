import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import type {
  EnvironmentId,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentControlAction,
  OrchestrationV2SubagentTranscriptEntry,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { formatCount, formatTokens } from "@t3tools/shared/usageFormat";
import { BotIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useThreadProjection } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { formatEnvironmentQueryError } from "~/state/query";
import { useAtomCommand } from "~/state/use-atom-command";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Textarea } from "../ui/textarea";
import {
  type AgentsTreeNode,
  buildAgentsTree,
  canKill,
  canRevive,
  canSteer,
  isSubagentActive,
} from "./agentsTree";
import { useSubagentTranscript } from "./subagentTranscript";

type SubagentStatus = OrchestrationV2Subagent["status"];

const STATUS_BADGE: Record<
  SubagentStatus,
  {
    readonly label: string;
    readonly variant: "outline" | "info" | "warning" | "success" | "error";
  }
> = {
  idle: { label: "Idle", variant: "outline" },
  pending: { label: "Pending", variant: "info" },
  running: { label: "Running", variant: "info" },
  waiting: { label: "Waiting", variant: "warning" },
  completed: { label: "Completed", variant: "success" },
  failed: { label: "Failed", variant: "error" },
  cancelled: { label: "Cancelled", variant: "outline" },
  interrupted: { label: "Interrupted", variant: "warning" },
};

const ROLE_LABEL: Record<OrchestrationV2SubagentTranscriptEntry["role"], string> = {
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  system: "System",
};

const ROLE_CLASS: Record<OrchestrationV2SubagentTranscriptEntry["role"], string> = {
  user: "border-l-primary bg-primary/6",
  assistant: "border-l-transparent",
  tool: "border-l-muted-foreground/40 bg-muted/48 font-mono text-[11px]",
  system: "border-l-warning/60 bg-warning/6 text-muted-foreground italic",
};

const EMPTY_SUBAGENTS: ReadonlyArray<OrchestrationV2Subagent> = [];

/** On the newest transcript entry: keeps the transcript scrolled to the end as entries arrive. */
function scrollTranscriptToEnd(entry: HTMLElement | null) {
  const transcript = entry?.parentElement;
  if (transcript) transcript.scrollTop = transcript.scrollHeight;
}

function subagentTitle(subagent: OrchestrationV2Subagent): string {
  const title = subagent.title?.trim();
  if (title) return formatSubagentDisplayTitle(title);
  return subagent.prompt.trim().split("\n", 1)[0] || "Subagent";
}

function usageLabels(subagent: OrchestrationV2Subagent): ReadonlyArray<string> {
  const usage = subagent.usage;
  return [
    subagent.model,
    usage?.costUsd === undefined ? null : `$${usage.costUsd.toFixed(4)}`,
    usage?.totalTokens === undefined ? null : `${formatTokens(usage.totalTokens)} tokens`,
    usage?.toolCalls === undefined
      ? null
      : `${formatCount(usage.toolCalls)} ${usage.toolCalls === 1 ? "tool call" : "tool calls"}`,
  ].filter((label): label is string => label !== null && label.length > 0);
}

/** A thread's provider-native subagents as a tree, with the selected one's transcript and controls. */
export function AgentsPanel(props: { readonly threadRef: ScopedThreadRef }) {
  const { environmentId, threadId } = props.threadRef;
  const subagents = useThreadProjection(props.threadRef)?.projection.subagents ?? EMPTY_SUBAGENTS;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const tree = buildAgentsTree(subagents);
  const selected = subagents.find((subagent) => subagent.id === selectedId) ?? null;

  if (subagents.length === 0) {
    return (
      <Empty size="compact" data-agents-panel>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <BotIcon />
          </EmptyMedia>
          <EmptyTitle>No agents yet</EmptyTitle>
          <EmptyDescription>
            Subagents this thread's agent starts show up here while they work.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-agents-panel>
      <nav
        aria-label="Agents"
        className="max-h-[45%] shrink-0 overflow-y-auto border-b border-border p-1.5"
      >
        <AgentsTreeList
          nodes={tree}
          selectedId={selectedId}
          onSelect={(id) => setSelectedId((current) => (current === id ? null : id))}
        />
      </nav>
      {selected ? (
        <AgentDetail
          key={selected.id}
          environmentId={environmentId}
          threadId={threadId}
          subagent={selected}
        />
      ) : (
        <p className="p-4 text-center text-xs text-muted-foreground">
          Select an agent to see its transcript.
        </p>
      )}
    </div>
  );
}

function AgentsTreeList(props: {
  readonly nodes: ReadonlyArray<AgentsTreeNode<OrchestrationV2Subagent>>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <ul className="flex flex-col gap-px">
      {props.nodes.map((node) => {
        const { subagent } = node;
        const status = STATUS_BADGE[subagent.status];
        const title = subagentTitle(subagent);
        const meta = usageLabels(subagent);
        return (
          <li key={subagent.id} data-agent-row={subagent.id} data-depth={node.depth}>
            <button
              type="button"
              aria-pressed={props.selectedId === subagent.id}
              aria-label={`${title}, ${status.label}`}
              className={cn(
                "flex w-full min-w-0 flex-col gap-0.5 rounded-md py-1 pr-2 text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                props.selectedId === subagent.id && "bg-accent",
              )}
              style={{ paddingInlineStart: `${0.5 + node.depth * 1}rem` }}
              onClick={() => props.onSelect(subagent.id)}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {node.depth > 0 ? (
                  <span aria-hidden className="shrink-0 text-muted-foreground/60">
                    └
                  </span>
                ) : null}
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
                <Badge size="sm" variant={status.variant} className="shrink-0">
                  {status.label}
                </Badge>
              </span>
              {meta.length > 0 ? (
                <span
                  className={cn(
                    "truncate text-xs text-muted-foreground tabular-nums",
                    node.depth > 0 && "pl-3.5",
                  )}
                >
                  {meta.join(" · ")}
                </span>
              ) : null}
            </button>
            {node.children.length > 0 ? (
              <AgentsTreeList
                nodes={node.children}
                selectedId={props.selectedId}
                onSelect={props.onSelect}
              />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function DetailSection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        {props.title}
      </h3>
      {props.children}
    </section>
  );
}

function AgentDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly subagent: OrchestrationV2Subagent;
}) {
  const { environmentId, threadId, subagent } = props;
  const control = useAtomCommand(orchestrationEnvironment.controlSubagent, {
    reportFailure: false,
  });
  const permitted = useAtomValue(
    orchestrationEnvironment.controlSubagent.permissionAtom(environmentId),
  );
  const transcript = useSubagentTranscript({ environmentId, threadId, subagent });
  const [busy, setBusy] = useState<OrchestrationV2SubagentControlAction["type"] | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [steerMessage, setSteerMessage] = useState("");
  const [reviveMessage, setReviveMessage] = useState("");

  const entryCount = transcript.entries.length;

  const run = async (action: OrchestrationV2SubagentControlAction) => {
    if (busy !== null) return;
    setBusy(action.type);
    setActionError(null);
    const result = await control({
      environmentId,
      input: { threadId, subagentId: subagent.id, action },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setActionError(formatEnvironmentQueryError(result.cause));
      }
      return;
    }
    if (action.type === "steer") setSteerMessage("");
    if (action.type === "revive") setReviveMessage("");
  };

  const steerable = permitted && canSteer(subagent);
  const killable = permitted && canKill(subagent);
  const revivable = permitted && canRevive(subagent);
  const steerText = steerMessage.trim();
  const reviveText = reviveMessage.trim();
  const title = subagentTitle(subagent);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3"
      aria-label={`${title} details`}
      role="region"
    >
      {subagent.prompt.trim() ? (
        <DetailSection title="Task">
          <p className="text-xs whitespace-pre-wrap wrap-anywhere">{subagent.prompt}</p>
        </DetailSection>
      ) : null}
      {subagent.progress && isSubagentActive(subagent.status) ? (
        <p className="truncate text-xs text-muted-foreground" data-agent-progress>
          {subagent.progress}
        </p>
      ) : null}
      {subagent.result && !isSubagentActive(subagent.status) ? (
        <DetailSection title="Result">
          <p className="text-xs whitespace-pre-wrap wrap-anywhere">{subagent.result}</p>
        </DetailSection>
      ) : null}
      {subagent.controls?.transcript ? (
        <DetailSection title="Transcript">
          <div
            className="flex max-h-80 min-h-16 flex-col gap-1 overflow-y-auto rounded-md border border-border p-1.5"
            data-agent-transcript
          >
            {transcript.entries.map((entry, index) => (
              <div
                // oxlint-disable-next-line react/no-array-index-key -- positional: pages append, a reset replaces all
                key={index}
                ref={index === entryCount - 1 ? scrollTranscriptToEnd : undefined}
                data-role={entry.role}
                className={cn(
                  "rounded-sm border-l-2 px-2 py-1 text-xs whitespace-pre-wrap wrap-anywhere",
                  ROLE_CLASS[entry.role],
                  entry.isError && "border-l-destructive text-destructive-foreground",
                )}
              >
                <span className="mr-1.5 font-sans font-medium text-muted-foreground not-italic">
                  {entry.role === "tool" && entry.toolName
                    ? entry.toolName
                    : ROLE_LABEL[entry.role]}
                </span>
                <span>{entry.text}</span>
              </div>
            ))}
            {entryCount === 0 ? (
              <p className="p-1 text-xs text-muted-foreground">
                {transcript.loading ? "Loading transcript…" : "No messages yet."}
              </p>
            ) : null}
          </div>
          {transcript.error ? (
            <p role="alert" className="text-xs text-destructive-foreground">
              {transcript.error}
            </p>
          ) : null}
        </DetailSection>
      ) : null}
      {steerable ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            if (steerText) void run({ type: "steer", message: steerText });
          }}
        >
          <Textarea
            size="sm"
            aria-label={`Message to ${title}`}
            placeholder="Steer this agent…"
            value={steerMessage}
            onChange={(event) => setSteerMessage(event.target.value)}
          />
          <div className="flex justify-end gap-1.5">
            {killable ? (
              <Button
                type="button"
                size="xs"
                variant="destructive"
                disabled={busy !== null}
                onClick={() => void run({ type: "kill" })}
              >
                Kill
              </Button>
            ) : null}
            <Button type="submit" size="xs" disabled={busy !== null || !steerText}>
              Send
            </Button>
          </div>
        </form>
      ) : killable ? (
        <div className="flex justify-end">
          <Button
            type="button"
            size="xs"
            variant="destructive"
            disabled={busy !== null}
            onClick={() => void run({ type: "kill" })}
          >
            Kill
          </Button>
        </div>
      ) : null}
      {revivable ? (
        <form
          className="flex flex-col gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void run(reviveText ? { type: "revive", message: reviveText } : { type: "revive" });
          }}
        >
          <Textarea
            size="sm"
            aria-label={`Message to revive ${title} with`}
            placeholder="Optional message for the revived agent…"
            value={reviveMessage}
            onChange={(event) => setReviveMessage(event.target.value)}
          />
          <div className="flex justify-end">
            <Button type="submit" size="xs" variant="outline" disabled={busy !== null}>
              Revive
            </Button>
          </div>
        </form>
      ) : null}
      {actionError ? (
        <p role="alert" className="text-xs text-destructive-foreground">
          {actionError}
        </p>
      ) : null}
    </div>
  );
}
