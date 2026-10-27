// Mobile cards for OMP tool calls (packages/provider-omp/src/server/ompCards.ts), the native
// counterpart of the web item inspector's OmpToolCard. Images reach the work log as the item's own
// tool-output images; audio plays through the thread's inline file preview.
import type { OmpToolCard as OmpToolCardModel } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { cn } from "../../lib/cn";

const PROPOSAL_LABEL = {
  proposed: "Proposed: files not modified yet. The agent applies or discards it.",
  applied: "Applied",
  discarded: "Discarded",
} as const;

/** A staged proposal the user can resolve from the card (OMP sidecar with `resolve_proposal`). */
const RESOLVABLE_LABEL = "Proposed: files not modified yet. Accept or reject it.";

const PROPOSAL_CLASS = {
  proposed: "text-warning-foreground",
  applied: "text-adaptive-emerald-600-400",
  discarded: "text-foreground-muted line-through",
} as const;

function Line(props: { readonly children: ReactNode; readonly className?: string }) {
  return (
    <Text selectable className={cn("text-xs leading-normal text-foreground", props.className)}>
      {props.children}
    </Text>
  );
}

function Mono(props: { readonly children: ReactNode; readonly muted?: boolean }) {
  return (
    <Text
      selectable
      className={cn(
        "font-mono text-2xs leading-normal",
        props.muted ? "text-foreground-muted" : "text-foreground",
      )}
    >
      {props.children}
    </Text>
  );
}

function Section(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <View className="gap-1">
      <Line className="text-foreground-muted">{props.label}</Line>
      {props.children}
    </View>
  );
}

function Pre(props: { readonly text: string }) {
  return props.text.length === 0 ? null : (
    <View className="rounded-md border border-border bg-subtle p-2">
      <Mono>{props.text}</Mono>
    </View>
  );
}

function joined(parts: ReadonlyArray<string | false | null | undefined>, separator = " · ") {
  return parts
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(separator);
}

function CardBody(props: {
  readonly card: OmpToolCardModel;
  readonly renderAudio?: ((path: string) => ReactNode) | undefined;
  readonly renderProposalActions?: (() => ReactNode) | undefined;
}) {
  const { card } = props;
  switch (card.kind) {
    case "ask":
      return (
        <>
          {card.chatRedirect ? (
            <Line className="italic">The user chose to discuss in chat.</Line>
          ) : null}
          {card.answers.map((answer) => (
            <View key={answer.question} className="gap-0.5">
              <Line>{answer.question}</Line>
              <Line className="text-foreground-muted">
                {[
                  ...answer.selected,
                  ...(answer.custom === undefined ? [] : [`Other: ${answer.custom}`]),
                ].join(", ") || (answer.timedOut ? "Timed out" : "No answer")}
                {answer.note ? ` (${answer.note})` : ""}
              </Line>
            </View>
          ))}
        </>
      );
    case "proposed_edit": {
      const actions =
        card.state === "proposed" && card.resolvable === true
          ? props.renderProposalActions?.()
          : undefined;
      return (
        <>
          <Line className={PROPOSAL_CLASS[card.state]}>
            {`${actions === undefined ? PROPOSAL_LABEL[card.state] : RESOLVABLE_LABEL} · ${card.replacements} replacement${
              card.replacements === 1 ? "" : "s"
            }`}
          </Line>
          {card.files.map((file) => (
            <Mono key={file.path}>{`${file.path} ×${file.count}`}</Mono>
          ))}
          {card.reason ? (
            <Line className="text-foreground-muted">Reason: {card.reason}</Line>
          ) : null}
          <Pre text={card.diff} />
          {actions ?? null}
        </>
      );
    }
    case "conflict_resolution":
      return (
        <>
          <Mono>{card.target}</Mono>
          <Line>{card.summary}</Line>
          {card.resolvedPath ? <Mono muted>{card.resolvedPath}</Mono> : null}
        </>
      );
    case "debug":
      return (
        <>
          <Line>
            {card.action}
            {card.state ? ` · ${card.state}` : ""}
            {card.stopReason ? ` (${card.stopReason})` : ""}
          </Line>
          {card.location ? (
            <Mono muted>
              {joined(
                [
                  card.location.name,
                  card.location.path &&
                    `${card.location.path}${card.location.line === undefined ? "" : `:${card.location.line}`}`,
                ],
                " at ",
              )}
            </Mono>
          ) : null}
          {card.frames ? (
            <Section label="Frames">
              {card.frames.map((frame) => (
                <Mono key={frame.id}>
                  {frame.name}
                  {frame.path ? ` ${frame.path}:${frame.line}` : ""}
                </Mono>
              ))}
            </Section>
          ) : null}
          {card.scopes ? (
            <Section label="Scopes">
              <Mono>{card.scopes.map((scope) => scope.name).join(", ")}</Mono>
            </Section>
          ) : null}
          {card.variables ? (
            <Section label="Locals">
              {card.variables.map((variable) => (
                <Mono key={variable.name}>
                  {`${variable.name} = ${variable.value}`}
                  {variable.type ? ` : ${variable.type}` : ""}
                </Mono>
              ))}
            </Section>
          ) : null}
          {card.evaluation ? (
            <Mono>
              {`= ${card.evaluation.result}`}
              {card.evaluation.type ? ` : ${card.evaluation.type}` : ""}
            </Mono>
          ) : null}
        </>
      );
    case "lsp":
      return (
        <>
          <Line className={card.success ? undefined : "text-danger-foreground"}>
            {joined([card.action, card.server, card.target])}
          </Line>
          <Pre text={card.text} />
        </>
      );
    case "eval":
      return (
        <>
          {card.cells.map((cell) => (
            <Section
              key={cell.index}
              label={joined([
                cell.title ?? `Cell ${cell.index + 1}`,
                card.language,
                cell.status,
                cell.durationMs === undefined ? undefined : `${cell.durationMs} ms`,
              ])}
            >
              <Pre text={cell.code} />
              <Pre text={cell.output} />
            </Section>
          ))}
        </>
      );
    case "generated_image":
      return (
        <>
          {card.provider || card.model ? (
            <Line className="text-foreground-muted">{joined([card.provider, card.model])}</Line>
          ) : null}
          {card.paths.map((path) => (
            <Mono key={path}>{path}</Mono>
          ))}
          {card.responseText ? <Line>{card.responseText}</Line> : null}
        </>
      );
    case "speech":
      return (
        <>
          {props.renderAudio?.(card.path) ?? <Mono>{card.path}</Mono>}
          {card.voice || card.bytes !== undefined ? (
            <Line className="text-foreground-muted">
              {joined([
                card.voice && `Voice ${card.voice}`,
                card.bytes !== undefined && `${card.bytes} bytes`,
              ])}
            </Line>
          ) : null}
          <Line>{card.text}</Line>
        </>
      );
    case "memory":
      return (
        <>
          <Line>
            {`Memory ${card.op}`}
            {card.query ? `: ${card.query}` : ""}
            {card.memoryId ? ` · ${card.memoryId}` : ""}
            {card.status ? ` · ${card.status}` : ""}
          </Line>
          {card.items?.map((item) => (
            <Line key={item.content}>
              {`• ${item.content}`}
              {item.scope ? ` (${item.scope})` : ""}
            </Line>
          ))}
          <Pre text={card.text} />
        </>
      );
  }
}

/** An OMP tool card in an expanded work-log row, in place of the raw arguments and output. */
export function OmpToolCard(props: {
  readonly card: OmpToolCardModel;
  /** Renders the playable audio a `speech` card points at; without it the path is shown. */
  readonly renderAudio?: (path: string) => ReactNode;
  /** Accept and Reject for a staged edit; absent where the card is read-only. */
  readonly renderProposalActions?: () => ReactNode;
}) {
  return (
    <View className="gap-1.5" testID={`omp-card-${props.card.kind}`}>
      <CardBody
        card={props.card}
        renderAudio={props.renderAudio}
        renderProposalActions={props.renderProposalActions}
      />
    </View>
  );
}
