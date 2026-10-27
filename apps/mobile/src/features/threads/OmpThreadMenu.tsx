/**
 * The OMP section of an OMP thread on mobile (PRD FR-23f; docs/omp/thread-menu.md): Goal,
 * Export HTML through the share sheet, Share as gist and Share live with their warnings,
 * Stop sharing live, and the session's Branch tree.
 */
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type OmpBranchTree,
  type OmpCollabAccess,
  type OmpCollabStatus,
  type OmpShareGistResult,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import {
  ompBranchCount,
  ompBranchNodeLabel,
  ompBranchTreeRows,
} from "@t3tools/provider-omp/branchTree";
import { useEffect, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { shareHtmlFile } from "../../lib/shareHtmlFile";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { CopyTextButton } from "./CopyTextButton";
import { ompFailureMessage } from "./omp-thread";

export type OmpThreadView = "menu" | "share-gist" | "share-live" | "branch-tree";

export const OMP_THREAD_VIEW_TITLES: Record<OmpThreadView, string> = {
  menu: "OMP",
  "share-gist": "Share as a secret gist",
  "share-live": "Share live",
  "branch-tree": "Branch tree",
};

export type OmpThreadMenuAction =
  | "goal"
  | "export-html"
  | "share-gist"
  | "share-live"
  | "stop-live"
  | "branch-tree";

const MENU_ROWS: ReadonlyArray<{
  readonly action: OmpThreadMenuAction;
  readonly label: string;
  readonly description: string;
  readonly icon: AppSymbolName;
  /** Needs operate access; read-only connections see the row disabled. */
  readonly operates?: true;
}> = [
  {
    action: "goal",
    label: "Goal",
    description: "See, pause, resume, drop or set the thread's goal",
    icon: "target",
  },
  {
    action: "export-html",
    label: "Export HTML",
    description: "The session as one page, to save or send",
    icon: "square.and.arrow.up",
  },
  {
    action: "share-gist",
    label: "Share as gist",
    description: "An encrypted link in a secret GitHub gist",
    icon: "link",
    operates: true,
  },
  {
    action: "share-live",
    label: "Share live",
    description: "Others follow the session as it runs",
    icon: "person.2",
    operates: true,
  },
  {
    action: "stop-live",
    label: "Stop sharing live",
    description: "End the live share room",
    icon: "stop.fill",
    operates: true,
  },
  {
    action: "branch-tree",
    label: "Branch tree",
    description: "Every branch of the OMP session",
    icon: "arrow.triangle.branch",
  },
];

export interface OmpThreadTargetProps {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
}

/** A sharing view: `onBusyChange` holds the sheet open while a request whose result it shows runs. */
export type OmpSharePanelProps = OmpThreadTargetProps & {
  readonly onDone: () => void;
  readonly onBusyChange: (busy: boolean) => void;
};

/** The OMP menu's rows; `busy` is the action still running, whose row waits. */
export function OmpThreadMenuView(props: {
  readonly busy: OmpThreadMenuAction | null;
  /** The connection may operate the thread; without it the sharing rows are disabled. */
  readonly canOperate: boolean;
  readonly onPick: (action: OmpThreadMenuAction) => void;
}) {
  return (
    <View accessibilityLabel="OMP actions">
      {MENU_ROWS.map((row) => {
        const busy = props.busy === row.action;
        const disabled = props.busy !== null || (row.operates === true && !props.canOperate);
        return (
          <Pressable
            key={row.action}
            accessibilityRole="button"
            accessibilityLabel={row.label}
            accessibilityState={{ disabled, busy }}
            disabled={disabled}
            onPress={() => props.onPick(row.action)}
            className="flex-row items-center gap-3 border-b border-border py-3.5 active:opacity-70"
          >
            <SymbolView
              name={row.icon}
              size={15}
              tintColorClassName="accent-foreground-muted"
              type="monochrome"
            />
            <View className="min-w-0 flex-1">
              <Text className="font-t3-medium text-sm text-foreground">
                {busy && row.action === "export-html"
                  ? "Exporting…"
                  : busy && row.action === "stop-live"
                    ? "Stopping…"
                    : row.label}
              </Text>
              <Text className="text-xs text-foreground-muted">{row.description}</Text>
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

/**
 * The OMP menu with its actions wired: Export HTML and Stop sharing live run in place,
 * the others open their view or the goal sheet.
 */
export function OmpThreadMenu(
  props: OmpThreadTargetProps & {
    readonly onOpenView: (view: Exclude<OmpThreadView, "menu">) => void;
    readonly onOpenGoal: () => void;
  },
) {
  const exportHtml = useAtomCommand(serverEnvironment.exportOmpThreadHtml, {
    reportFailure: false,
  });
  const stopLive = useAtomCommand(serverEnvironment.stopOmpThreadCollab, {
    reportFailure: false,
  });
  const [busy, setBusy] = useState<OmpThreadMenuAction | null>(null);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const call = {
    environmentId: props.environmentId,
    input: { instanceId: props.instanceId, threadId: props.threadId },
  };

  const runExport = async () => {
    setBusy("export-html");
    const result = await exportHtml(call);
    if (result._tag === "Success") {
      try {
        await shareHtmlFile(result.value.fileName, result.value.html);
      } catch (error) {
        Dialog.alert(
          "Could not export HTML",
          error instanceof Error ? error.message : "Could not open the share sheet. Try again.",
        );
      }
    } else {
      const message = ompFailureMessage(result);
      if (message !== null) Dialog.alert("Could not export HTML", message);
    }
    setBusy(null);
  };

  const runStopLive = async () => {
    setBusy("stop-live");
    const result = await stopLive(call);
    if (result._tag === "Success") {
      Dialog.alert(result.value.stopped ? "Live share stopped" : "No live share was running");
    } else {
      const message = ompFailureMessage(result);
      if (message !== null) Dialog.alert("Could not stop sharing", message);
    }
    setBusy(null);
  };

  return (
    <OmpThreadMenuView
      busy={busy}
      canOperate={canOperate}
      onPick={(action) => {
        switch (action) {
          case "goal":
            props.onOpenGoal();
            return;
          case "export-html":
            void runExport();
            return;
          case "stop-live":
            void runStopLive();
            return;
          case "share-gist":
          case "share-live":
          case "branch-tree":
            props.onOpenView(action);
            return;
        }
      }}
    />
  );
}

function CopyableLink(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="gap-1">
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <View className="flex-row items-center gap-2 rounded-lg border border-border-subtle px-3 py-2">
        <Text selectable className="min-w-0 flex-1 text-sm text-foreground" numberOfLines={2}>
          {props.value}
        </Text>
        <CopyTextButton accessibilityLabel={`Copy ${props.label}`} text={props.value} />
      </View>
    </View>
  );
}

function FailureText(props: { readonly message: string }) {
  return (
    <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
      {props.message}
    </Text>
  );
}

type GistState =
  | { readonly status: "confirm" }
  | { readonly status: "sharing" }
  | { readonly status: "shared"; readonly result: OmpShareGistResult }
  | { readonly status: "failed"; readonly message: string };

/** Share as gist: confirm what is uploaded, upload, then the link to copy. */
export function OmpShareGistPanel(props: OmpSharePanelProps) {
  const shareGist = useAtomCommand(serverEnvironment.shareOmpThreadGist, {
    reportFailure: false,
  });
  const [state, setState] = useState<GistState>({ status: "confirm" });

  const share = async () => {
    setState({ status: "sharing" });
    props.onBusyChange(true);
    const result = await shareGist({
      environmentId: props.environmentId,
      input: { instanceId: props.instanceId, threadId: props.threadId },
    });
    props.onBusyChange(false);
    if (result._tag === "Success") {
      setState({ status: "shared", result: result.value });
      return;
    }
    const message = ompFailureMessage(result);
    setState(message === null ? { status: "confirm" } : { status: "failed", message });
  };

  return (
    <View className="gap-4 pt-2" accessibilityLabel="Share as a secret gist">
      <Text className="text-sm text-foreground">
        OMP encrypts this thread&apos;s session and uploads it to a secret GitHub gist with your gh
        account, and nowhere else: if the gist fails, nothing is uploaded. Anyone with the link can
        read the whole conversation, tool output included.
      </Text>
      {state.status === "shared" ? (
        <View className="gap-2">
          <CopyableLink label="Share link" value={state.result.url} />
          <Text className="text-xs text-foreground-muted">Gist: {state.result.gistUrl}</Text>
          {state.result.truncated ? (
            <Text className="text-xs text-foreground-muted">
              Large content was trimmed to fit the share size limit.
            </Text>
          ) : null}
        </View>
      ) : (
        <Text className="text-xs text-foreground-muted">
          The decryption key is in the link&apos;s fragment, so the gist alone cannot be read.
        </Text>
      )}
      {state.status === "failed" ? <FailureText message={state.message} /> : null}
      <View className="flex-row flex-wrap gap-2">
        {state.status === "shared" ? (
          <Button label="Done" onPress={props.onDone} />
        ) : (
          <>
            <Button
              label="Cancel"
              tone="secondary"
              disabled={state.status === "sharing"}
              onPress={props.onDone}
            />
            <Button
              label={state.status === "sharing" ? "Sharing…" : "Share as gist"}
              disabled={state.status === "sharing"}
              onPress={() => void share()}
            />
          </>
        )}
      </View>
    </View>
  );
}

/** How often an open Share live view refreshes who is in the room. */
export const OMP_COLLAB_REFRESH_MS = 5_000;

type LiveState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly room: OmpCollabStatus }
  | { readonly status: "busy"; readonly room: OmpCollabStatus }
  | { readonly status: "failed"; readonly room: OmpCollabStatus | null; readonly message: string };

const NO_ROOM: OmpCollabStatus = { active: false, participants: [] };

const ACCESS_CHOICES: ReadonlyArray<{ readonly value: OmpCollabAccess; readonly label: string }> = [
  { value: "view", label: "View only" },
  { value: "control", label: "View and prompt" },
];

/** Share live: the bypass-pairing warning, the access choice, then links and guests. */
export function OmpShareLivePanel(props: OmpSharePanelProps) {
  const { environmentId, instanceId, threadId } = props;
  const readRoom = useAtomCommand(serverEnvironment.getOmpThreadCollab, { reportFailure: false });
  const startRoom = useAtomCommand(serverEnvironment.startOmpThreadCollab, {
    reportFailure: false,
  });
  const stopRoom = useAtomCommand(serverEnvironment.stopOmpThreadCollab, {
    reportFailure: false,
  });
  const [state, setState] = useState<LiveState>({ status: "loading" });
  const [access, setAccess] = useState<OmpCollabAccess>("view");
  const room = state.status === "loading" ? null : state.room;
  const active = room?.active === true;

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const result = await readRoom({ environmentId, input: { instanceId, threadId } });
      if (cancelled) return;
      if (result._tag === "Success") {
        setState((current) =>
          current.status === "busy" ? current : { status: "ready", room: result.value },
        );
        return;
      }
      const message = ompFailureMessage(result);
      if (message !== null) setState({ status: "failed", room: null, message });
    };
    void refresh();
    const timer = setInterval(() => void refresh(), OMP_COLLAB_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [environmentId, instanceId, readRoom, threadId]);

  const settle = (
    before: OmpCollabStatus,
    result: AtomCommandResult<unknown, unknown>,
    next: OmpCollabStatus,
  ) => {
    if (result._tag === "Success") {
      setState({ status: "ready", room: next });
      return;
    }
    const message = ompFailureMessage(result);
    setState(
      message === null
        ? { status: "ready", room: before }
        : { status: "failed", room: before, message },
    );
  };

  const start = async () => {
    const before = room ?? NO_ROOM;
    setState({ status: "busy", room: before });
    props.onBusyChange(true);
    const result = await startRoom({ environmentId, input: { instanceId, threadId, access } });
    props.onBusyChange(false);
    settle(before, result, result._tag === "Success" ? result.value : before);
  };

  const stop = async () => {
    const before = room ?? NO_ROOM;
    setState({ status: "busy", room: before });
    props.onBusyChange(true);
    const result = await stopRoom({ environmentId, input: { instanceId, threadId } });
    props.onBusyChange(false);
    settle(before, result, NO_ROOM);
  };

  const guests = room?.participants.filter((participant) => participant.role === "guest") ?? [];
  // A failed status read leaves nothing to start from: the sidecar or the session is the problem.
  const canStart = state.status === "ready" || (state.status === "failed" && room !== null);

  return (
    <View className="gap-4 pt-2" accessibilityLabel="Share live">
      <Text className="text-sm text-foreground">
        Others follow this thread&apos;s OMP session as it runs, in a browser or with omp join.
      </Text>
      <View
        accessibilityRole="alert"
        className="gap-1 rounded-xl border border-warning-border bg-warning px-3.5 py-3"
      >
        <View className="flex-row items-center gap-2">
          <SymbolView
            name="exclamationmark.triangle"
            size={14}
            tintColorClassName="accent-warning-foreground"
            type="monochrome"
          />
          <Text className="font-t3-medium text-sm text-warning-foreground">
            This link bypasses T3 pairing
          </Text>
        </View>
        <Text className="text-xs text-warning-foreground">
          Anyone holding it reaches the session through OMP&apos;s collab relay, outside T3&apos;s
          pairing and permissions. With control access they can also send prompts, which run with
          this thread&apos;s permissions. Share it only with people you trust, and stop sharing when
          you are done.
        </Text>
      </View>
      {active && room !== null ? (
        <View className="gap-3">
          {room.webLink === undefined ? null : (
            <CopyableLink label="Browser link" value={room.webLink} />
          )}
          {room.link === undefined ? null : (
            <CopyableLink label="omp join link" value={room.link} />
          )}
          <Text className="text-xs text-foreground-muted">
            {room.access === "control" ? "Guests can watch and prompt." : "Guests can watch."}{" "}
            {guests.length === 0
              ? "Nobody has joined yet."
              : `${guests.length} ${guests.length === 1 ? "guest" : "guests"}: ${guests
                  .map((guest) => guest.name)
                  .join(", ")}.`}
            {room.relayConnected === false ? " The relay is reconnecting." : ""}
          </Text>
        </View>
      ) : state.status === "loading" ? (
        <Text className="text-sm text-foreground-muted">Checking for a live share…</Text>
      ) : (
        <View accessibilityRole="radiogroup" accessibilityLabel="What guests may do">
          {ACCESS_CHOICES.map((choice) => (
            <Pressable
              key={choice.value}
              accessibilityRole="radio"
              accessibilityLabel={choice.label}
              accessibilityState={{ checked: access === choice.value }}
              onPress={() => setAccess(choice.value)}
              className="flex-row items-center gap-3 border-b border-border py-3 active:opacity-70"
            >
              <SymbolView
                name={access === choice.value ? "checkmark.circle.fill" : "circle"}
                size={16}
                tintColorClassName={
                  access === choice.value ? "accent-foreground" : "accent-icon-subtle"
                }
                type="monochrome"
              />
              <Text className="font-t3-medium text-sm text-foreground">{choice.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
      {state.status === "failed" ? <FailureText message={state.message} /> : null}
      <View className="flex-row flex-wrap gap-2">
        <Button
          label="Close"
          tone="secondary"
          disabled={state.status === "busy"}
          onPress={props.onDone}
        />
        {active ? (
          <Button
            label="Stop sharing"
            tone="danger"
            disabled={state.status === "busy"}
            onPress={() => void stop()}
          />
        ) : (
          <Button
            label={state.status === "busy" ? "Starting…" : "Start sharing"}
            disabled={!canStart}
            onPress={() => void start()}
          />
        )}
      </View>
    </View>
  );
}

export type OmpBranchTreeState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly tree: OmpBranchTree }
  | { readonly status: "failed"; readonly message: string };

const NODE_ICONS = {
  user: "text.bubble",
  assistant: "sparkles",
  branch_summary: "arrow.triangle.branch",
  compaction: "archivebox",
} as const satisfies Record<OmpBranchTree["nodes"][number]["kind"], AppSymbolName>;

/** The branch tree, rows indented at forks; the path the thread continues from is highlighted. */
export function OmpBranchTreeView(props: { readonly state: OmpBranchTreeState }) {
  const { state } = props;
  if (state.status === "loading") {
    return <Text className="pt-2 text-sm text-foreground-muted">Reading the session tree…</Text>;
  }
  if (state.status === "failed") {
    return (
      <View className="pt-2">
        <FailureText message={state.message} />
      </View>
    );
  }
  const active = new Set(state.tree.activePath);
  const rows = ompBranchTreeRows(state.tree);
  const branches = ompBranchCount(rows);
  return (
    <View className="gap-2 pt-2">
      <Text className="text-xs text-foreground-muted">
        Every branch of this thread&apos;s OMP session. The highlighted path is the one the thread
        continues from.
      </Text>
      <Text className="font-t3-medium text-sm text-foreground">
        {branches === 1 ? "One branch" : `${branches} branches`}
      </Text>
      <View accessibilityLabel="Session branches">
        {rows.map(({ node, depth, fork }) => {
          const onPath = active.has(node.entryId);
          const current = node.entryId === state.tree.leafId;
          const label = ompBranchNodeLabel(node);
          return (
            <View
              key={node.entryId}
              accessible
              accessibilityLabel={`${label}${onPath ? ", on the active path" : ""}${current ? ", current" : ""}`}
              className="h-8 flex-row items-center gap-2"
              style={{ paddingLeft: depth * 16 }}
            >
              <SymbolView
                name={fork ? "arrow.triangle.branch" : NODE_ICONS[node.kind]}
                size={13}
                tintColorClassName={onPath ? "accent-foreground" : "accent-icon-subtle"}
                type="monochrome"
              />
              <Text
                numberOfLines={1}
                className={
                  onPath
                    ? "min-w-0 flex-1 font-t3-medium text-sm text-foreground"
                    : "min-w-0 flex-1 text-sm text-foreground-muted"
                }
              >
                {label}
              </Text>
              {current ? <Text className="text-xs text-foreground-muted">current</Text> : null}
            </View>
          );
        })}
      </View>
    </View>
  );
}

/** Reads the thread's branch tree once and shows it. */
export function OmpBranchTreePanel(props: OmpThreadTargetProps & { readonly onDone: () => void }) {
  const { environmentId, instanceId, threadId } = props;
  const readTree = useAtomCommand(serverEnvironment.getOmpThreadBranchTree, {
    reportFailure: false,
  });
  const [state, setState] = useState<OmpBranchTreeState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void readTree({ environmentId, input: { instanceId, threadId } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        setState({ status: "ready", tree: result.value });
        return;
      }
      setState({ status: "failed", message: ompFailureMessage(result) ?? "Cancelled." });
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, readTree, threadId]);

  return (
    <View className="gap-4">
      <OmpBranchTreeView state={state} />
      <View className="flex-row">
        <Button label="Done" onPress={props.onDone} />
      </View>
    </View>
  );
}
