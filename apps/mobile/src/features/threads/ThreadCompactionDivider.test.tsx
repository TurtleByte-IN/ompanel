// FR-18f: OmpThreadMapper's `#compactionEvent` turns `auto_compaction_*` and
// `manual_compaction_*` frames into one `compaction` item per run. These items copy its output
// (packages/provider-omp/src/server/mapperCards.test.ts "compaction: auto and manual runs share
// one card from start to end") and reach the divider through the mobile thread feed.
import {
  MessageId,
  NodeId,
  type OrchestrationV2ProjectedTurnItem,
  ProviderDriverKind,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children, className }: { children?: ReactNode; className?: string }) => (
    <p className={className}>{children}</p>
  ),
}));
vi.mock("../../components/ui/AppSymbol", () => ({
  SymbolView: ({ name }: { name: string }) => <i data-icon={name} />,
}));
vi.mock("./thread-work-log", () => ({
  ShimmeringWorkContent: ({ label }: { label: string }) => <p data-shimmer>{label}</p>,
}));

import {
  buildThreadFeed,
  deriveThreadFeedPresentation,
  isContextCompactionActivityGroup,
  threadFeedCompactionLabels,
  threadFeedRunIsUnsettled,
} from "../../lib/threadActivity";
import { ThreadCompactionDivider } from "./thread-context-divider";

const RUN = RunId.make("run:omp:1");
const THREAD = ThreadId.make("thread:omp");
const OMP = ProviderDriverKind.make("omp");
const time = (second: number) =>
  DateTime.makeUnsafe(Date.parse("2026-10-26T10:00:00.000Z") + second * 1000);
const STARTED_AT = DateTime.formatIso(time(0));

function prompt(text: string): OrchestrationV2ProjectedTurnItem {
  const id = TurnItemId.make("turn-item:omp:user");
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: id,
    item: {
      id,
      threadId: THREAD,
      runId: RUN,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 100,
      status: "completed",
      title: null,
      startedAt: time(0),
      completedAt: time(0),
      updatedAt: time(0),
      type: "user_message",
      messageId: MessageId.make("message:omp:1"),
      text,
      attachments: [],
      inputIntent: "turn_start",
      createdBy: "user",
      creationSource: "web",
    },
  };
}

/** The mapper's card for the `card`-th compaction of the turn; `end` is null while it runs. */
function compaction(
  card: number,
  second: number,
  end: { status: "interrupted" | "failed" | "completed"; summary?: string; before?: number } | null,
): OrchestrationV2ProjectedTurnItem {
  const nativeId = `compaction:provider-turn:provider:omp:native-turn:provider-thread%3Aprovider%3Aomp%3Anative-thread%3As%3Aattempt%3Arun-attempt%3Aomp%3A1:${card}`;
  const encoded = encodeURIComponent(nativeId);
  const id = TurnItemId.make(`turn-item:provider:omp:native-item:${encoded}`);
  return {
    position: card,
    visibility: "local",
    sourceThreadId: THREAD,
    sourceItemId: id,
    item: {
      id,
      threadId: THREAD,
      runId: RUN,
      nodeId: NodeId.make(`node:provider:omp:native-item:${encoded}`),
      providerThreadId: ProviderThreadId.make("provider-thread:provider:omp:native-thread:s"),
      providerTurnId: ProviderTurnId.make(
        "provider-turn:provider:omp:native-turn:provider-thread%3Aprovider%3Aomp%3Anative-thread%3As%3Aattempt%3Arun-attempt%3Aomp%3A1",
      ),
      nativeItemRef: { driver: OMP, nativeId, strength: "strong" },
      parentItemId: null,
      ordinal: 100 + card,
      startedAt: time(second),
      updatedAt: time(end === null ? second : second + 1),
      status: end?.status ?? "running",
      completedAt: end === null ? null : time(second + 1),
      title: null,
      type: "compaction",
      driver: OMP,
      ...(end?.summary === undefined ? {} : { summary: end.summary }),
      ...(end?.before === undefined ? {} : { beforeTokenCount: end.before }),
    },
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

/** Renders the feed's one compaction divider as ThreadFeed does and reads it back. */
function render(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>, running: boolean) {
  const latestRun = {
    runId: RUN,
    status: running ? ("running" as const) : ("completed" as const),
    startedAt: STARTED_AT,
    completedAt: running ? null : DateTime.formatIso(time(9)),
  };
  const feed = deriveThreadFeedPresentation(
    buildThreadFeed(items),
    latestRun,
    new Set(),
    new Set(),
    STARTED_AT,
  );
  const dividers = feed.flatMap((entry) =>
    entry.type === "activity-group" && isContextCompactionActivityGroup(entry) ? [entry] : [],
  );
  expect(dividers).toHaveLength(1);
  const labels = threadFeedCompactionLabels(feed);
  act(() =>
    root.render(
      <ThreadCompactionDivider
        entry={dividers[0]!}
        unsettledTurnId={threadFeedRunIsUnsettled(latestRun) ? latestRun.runId : null}
        labels={labels.get(dividers[0]!.id)}
        iconColor="gray"
      />,
    ),
  );
  const label = container.querySelector("p");
  return {
    label: label?.textContent,
    active: label?.hasAttribute("data-shimmer") ?? false,
    failed: label?.className.includes("text-danger-foreground") ?? false,
    icon: container.querySelector("i")?.getAttribute("data-icon"),
  };
}

describe("OMP compaction divider (mobile)", () => {
  it("runs an automatic compaction as one divider from start to end", () => {
    const ask = prompt("Summarize the repository");
    expect(render([ask, compaction(1, 1, null)], true)).toEqual({
      label: "Compacting context",
      active: true,
      failed: false,
      icon: "arrow.down.right.and.arrow.up.left",
    });
    expect(
      render(
        [ask, compaction(1, 1, { status: "completed", summary: "Compacted", before: 90_000 })],
        false,
      ),
    ).toEqual({
      label: "Context compacted",
      active: false,
      failed: false,
      icon: "arrow.down.right.and.arrow.up.left",
    });
  });

  it("runs a manual /compact as one divider that ends stopped or failed", () => {
    const ask = prompt("/compact");
    expect(render([ask, compaction(2, 3, null)], true)).toMatchObject({
      label: "Compacting context",
      active: true,
    });
    expect(render([ask, compaction(2, 3, { status: "interrupted" })], false)).toEqual({
      label: "Context compaction stopped",
      active: false,
      failed: false,
      icon: "arrow.down.right.and.arrow.up.left",
    });
    expect(
      render(
        [ask, compaction(3, 5, { status: "failed", summary: "Compaction model unavailable" })],
        false,
      ),
    ).toEqual({
      label: "Context compaction failed · Compaction model unavailable",
      active: false,
      failed: true,
      icon: "exclamationmark.circle",
    });
  });
});
