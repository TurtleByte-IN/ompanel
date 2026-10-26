// Cards for OMP tool calls (packages/provider-omp/src/server/ompCards.ts). Images arrive as the
// item's own tool-output images and audio as a local media file; nothing is fetched remotely.
import type { EnvironmentId, OmpToolCard as OmpToolCardModel, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { useAssetUrlState } from "../../assets/assetUrls";
import { cn } from "../../lib/utils";
import { AudioPreview } from "../files/AudioPreview";

const PROPOSAL_LABEL = {
  proposed: "Proposed: files not modified yet. The agent applies or discards it.",
  applied: "Applied",
  discarded: "Discarded",
} as const;

function Section(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground">{props.label}</div>
      {props.children}
    </div>
  );
}

function Pre(props: { readonly text: string }) {
  return props.text.length === 0 ? null : (
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/45 bg-muted/15 p-2">
      {props.text}
    </pre>
  );
}

function SpeechPreview(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly path: string;
}) {
  const asset = useAssetUrlState(props.environmentId, {
    _tag: "media-file",
    threadId: props.threadId,
    path: props.path,
  });
  const name = props.path.split(/[\\/]/).pop() ?? props.path;
  return asset._tag === "Success" ? (
    <AudioPreview compact src={asset.url} name={name} />
  ) : (
    <div className="text-muted-foreground">
      {asset._tag === "Failure" ? `Audio unavailable: ${name}` : `Loading ${name}…`}
    </div>
  );
}

export function OmpToolCard(props: {
  readonly card: OmpToolCardModel;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  /** The item's inline images (eval cells, generated pictures). */
  readonly images?: ReactNode;
}) {
  const { card } = props;
  const body = (() => {
    switch (card.kind) {
      case "ask":
        return (
          <ul className="space-y-1.5">
            {card.chatRedirect ? (
              <li className="italic">The user chose to discuss in chat.</li>
            ) : null}
            {card.answers.map((answer) => (
              <li key={answer.question}>
                <div className="text-foreground">{answer.question}</div>
                <div className="text-muted-foreground">
                  {[
                    ...answer.selected,
                    ...(answer.custom === undefined ? [] : [`Other: ${answer.custom}`]),
                  ].join(", ") || (answer.timedOut ? "Timed out" : "No answer")}
                  {answer.note ? ` (${answer.note})` : ""}
                </div>
              </li>
            ))}
          </ul>
        );
      case "proposed_edit":
        return (
          <>
            <div
              data-omp-proposal={card.state}
              className={cn(
                card.state === "proposed"
                  ? "text-warning"
                  : card.state === "discarded"
                    ? "text-muted-foreground line-through"
                    : "text-success",
              )}
            >
              {PROPOSAL_LABEL[card.state]} · {card.replacements} replacement
              {card.replacements === 1 ? "" : "s"}
            </div>
            {card.files.length > 0 ? (
              <ul>
                {card.files.map((file) => (
                  <li key={file.path} className="font-mono">
                    {file.path} <span className="text-muted-foreground">×{file.count}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {card.reason ? (
              <div className="text-muted-foreground">Reason: {card.reason}</div>
            ) : null}
            <Pre text={card.diff} />
          </>
        );
      case "conflict_resolution":
        return (
          <div>
            <span className="font-mono">{card.target}</span>: {card.summary}
          </div>
        );
      case "debug":
        return (
          <>
            <div>
              {card.action}
              {card.state ? ` · ${card.state}` : ""}
              {card.stopReason ? ` (${card.stopReason})` : ""}
            </div>
            {card.location ? (
              <div className="font-mono text-muted-foreground">
                {[
                  card.location.name,
                  card.location.path &&
                    `${card.location.path}${card.location.line === undefined ? "" : `:${card.location.line}`}`,
                ]
                  .filter(Boolean)
                  .join(" at ")}
              </div>
            ) : null}
            {card.frames ? (
              <Section label="Frames">
                <ol className="font-mono">
                  {card.frames.map((frame) => (
                    <li key={frame.id}>
                      {frame.name}
                      {frame.path ? (
                        <span className="text-muted-foreground">
                          {" "}
                          {frame.path}:{frame.line}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              </Section>
            ) : null}
            {card.scopes ? (
              <Section label="Scopes">
                <div className="font-mono">{card.scopes.map((scope) => scope.name).join(", ")}</div>
              </Section>
            ) : null}
            {card.variables ? (
              <Section label="Locals">
                <table className="font-mono">
                  <tbody>
                    {card.variables.map((variable) => (
                      <tr key={variable.name}>
                        <td className="pr-3">{variable.name}</td>
                        <td>{variable.value}</td>
                        <td className="pl-3 text-muted-foreground">{variable.type}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Section>
            ) : null}
            {card.evaluation ? (
              <div className="font-mono">
                = {card.evaluation.result}
                {card.evaluation.type ? (
                  <span className="text-muted-foreground"> : {card.evaluation.type}</span>
                ) : null}
              </div>
            ) : null}
          </>
        );
      case "lsp":
        return (
          <>
            <div className={cn(!card.success && "text-destructive")}>
              {card.action}
              {card.server ? ` · ${card.server}` : ""}
              {card.target ? ` · ${card.target}` : ""}
            </div>
            <Pre text={card.text} />
          </>
        );
      case "eval":
        return (
          <>
            {card.cells.map((cell) => (
              <Section
                key={cell.index}
                label={[
                  cell.title ?? `Cell ${cell.index + 1}`,
                  card.language,
                  cell.status,
                  cell.durationMs === undefined ? undefined : `${cell.durationMs} ms`,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              >
                <Pre text={cell.code} />
                <Pre text={cell.output} />
              </Section>
            ))}
            {props.images}
          </>
        );
      case "generated_image":
        return (
          <>
            {props.images}
            <div className="text-muted-foreground">
              {[card.provider, card.model].filter(Boolean).join(" · ")}
            </div>
            {card.paths.map((path) => (
              <div key={path} className="font-mono">
                {path}
              </div>
            ))}
            {card.responseText ? <div>{card.responseText}</div> : null}
          </>
        );
      case "speech":
        return (
          <>
            <SpeechPreview
              environmentId={props.environmentId}
              threadId={props.threadId}
              path={card.path}
            />
            <div className="text-muted-foreground">
              {[
                card.voice && `Voice ${card.voice}`,
                card.bytes !== undefined && `${card.bytes} bytes`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </div>
            <div>{card.text}</div>
          </>
        );
      case "memory":
        return (
          <>
            <div>
              Memory {card.op}
              {card.query ? `: ${card.query}` : ""}
              {card.memoryId ? ` · ${card.memoryId}` : ""}
              {card.status ? ` · ${card.status}` : ""}
            </div>
            {card.items ? (
              <ul className="list-disc pl-4">
                {card.items.map((item) => (
                  <li key={item.content}>
                    {item.content}
                    {item.scope ? (
                      <span className="text-muted-foreground"> ({item.scope})</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            <Pre text={card.text} />
          </>
        );
    }
  })();
  return (
    <div className="space-y-1.5 text-xs" data-omp-card={card.kind}>
      {body}
    </div>
  );
}
