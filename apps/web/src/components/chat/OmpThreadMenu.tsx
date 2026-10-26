/**
 * The OMP section of an OMP thread's menu (PRD FR-21; docs/omp/thread-menu.md): Export HTML
 * downloads the session as one page, Share as gist and Share live open their dialogs, Stop
 * sharing live ends the room, Branch tree shows OMP's session tree. The sidebar and the chat
 * header menus close as their command runs, so the dialogs render once, from the root.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  type AtomCommand,
  type AtomCommandResult,
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  OmpBranchNode,
  OmpBranchTree,
  OmpCollabAccess,
  OmpCollabStatus,
  OmpShareGistResult,
  ProviderInstanceId,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import {
  BotIcon,
  CheckIcon,
  CopyIcon,
  GitForkIcon,
  ArchiveIcon,
  MessageSquareIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { cn } from "~/lib/utils";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { readThreadShell } from "~/state/entities";
import { environmentPresentations } from "~/state/presentation";
import { serverEnvironment } from "~/state/server";
import type { OmpThreadMenuActionId } from "../threadActionMenu.logic";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { QRCodeSvg } from "../ui/qr-code";
import { Radio, RadioGroup } from "../ui/radio-group";
import { toastManager } from "../ui/toast";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

interface OmpThreadDialog {
  readonly kind: "share-gist" | "share-live" | "branch-tree";
  readonly threadRef: ScopedThreadRef;
  readonly instanceId: ProviderInstanceId;
}

const ompThreadDialogAtom = Atom.make<OmpThreadDialog | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("omp-thread-menu:dialog"),
);

const closeDialog = () => appAtomRegistry.set(ompThreadDialogAtom, null);

/** The thread's OMP instance; null when the thread runs on another provider. */
export function readOmpThreadInstanceId(threadRef: ScopedThreadRef): ProviderInstanceId | null {
  const thread = readThreadShell(threadRef);
  if (thread === null) return null;
  const providers =
    appAtomRegistry
      .get(environmentPresentations.providersByEnvironmentAtom)
      .get(threadRef.environmentId) ?? [];
  const provider = providers.find(
    (candidate) => candidate.instanceId === thread.providerInstanceId,
  );
  return provider?.driver === "omp" ? provider.instanceId : null;
}

/** The message a failed call shows; null when it was interrupted. */
function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "OMP is unavailable.";
}

function downloadHtml(fileName: string, html: string): void {
  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** Every OMP call shows its own failure, in its dialog or a toast. */
const command = <W, A, E>(atomCommand: AtomCommand<W, A, E>, input: W) =>
  runAtomCommand(appAtomRegistry, atomCommand, input, { reportFailure: false });

/** Runs a picked OMP menu item for `threadRef`; the parent `omp` item does nothing. */
export async function runOmpThreadMenuAction(
  action: OmpThreadMenuActionId,
  threadRef: ScopedThreadRef,
): Promise<void> {
  const instanceId = readOmpThreadInstanceId(threadRef);
  if (instanceId === null || action === "omp") return;
  const input = { instanceId, threadId: threadRef.threadId };
  switch (action) {
    case "omp-export-html": {
      const result = await command(serverEnvironment.exportOmpThreadHtml, {
        environmentId: threadRef.environmentId,
        input,
      });
      if (result._tag === "Success") {
        downloadHtml(result.value.fileName, result.value.html);
        toastManager.add({
          type: "success",
          title: "Exported",
          description: result.value.fileName,
        });
        return;
      }
      const message = failureMessage(result);
      if (message !== null) {
        toastManager.add({ type: "error", title: "Could not export HTML", description: message });
      }
      return;
    }
    case "omp-stop-live": {
      const result = await command(serverEnvironment.stopOmpThreadCollab, {
        environmentId: threadRef.environmentId,
        input,
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: result.value.stopped ? "success" : "info",
          title: result.value.stopped ? "Live share stopped" : "No live share was running",
        });
        return;
      }
      const message = failureMessage(result);
      if (message !== null) {
        toastManager.add({ type: "error", title: "Could not stop sharing", description: message });
      }
      return;
    }
    case "omp-share-gist":
      appAtomRegistry.set(ompThreadDialogAtom, { kind: "share-gist", threadRef, instanceId });
      return;
    case "omp-share-live":
      appAtomRegistry.set(ompThreadDialogAtom, { kind: "share-live", threadRef, instanceId });
      return;
    case "omp-branch-tree":
      appAtomRegistry.set(ompThreadDialogAtom, { kind: "branch-tree", threadRef, instanceId });
      return;
  }
}

export function OmpThreadDialogHost() {
  const dialog = useAtomValue(ompThreadDialogAtom);
  if (dialog === null) return null;
  const key = `${dialog.kind}:${dialog.threadRef.environmentId}:${dialog.threadRef.threadId}`;
  switch (dialog.kind) {
    case "share-gist":
      return <OmpShareGistDialog key={key} dialog={dialog} />;
    case "share-live":
      return <OmpShareLiveDialog key={key} dialog={dialog} />;
    case "branch-tree":
      return <OmpBranchTreeDialog key={key} dialog={dialog} />;
  }
}

function CopyableLink({ label, value }: { readonly label: string; readonly value: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: label });
  return (
    <div className="flex items-center gap-2">
      <Input
        readOnly
        aria-label={label}
        value={value}
        onFocus={(event) => event.currentTarget.select()}
      />
      <Button size="sm" variant="outline" onClick={() => copyToClipboard(value)}>
        {isCopied ? <CheckIcon /> : <CopyIcon />}
        {isCopied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

type GistState =
  | { readonly status: "confirm" }
  | { readonly status: "sharing" }
  | { readonly status: "shared"; readonly result: OmpShareGistResult }
  | { readonly status: "failed"; readonly message: string };

function OmpShareGistDialog({ dialog }: { readonly dialog: OmpThreadDialog }) {
  const [state, setState] = useState<GistState>({ status: "confirm" });

  const share = async () => {
    setState({ status: "sharing" });
    const result = await command(serverEnvironment.shareOmpThreadGist, {
      environmentId: dialog.threadRef.environmentId,
      input: { instanceId: dialog.instanceId, threadId: dialog.threadRef.threadId },
    });
    if (result._tag === "Success") {
      setState({ status: "shared", result: result.value });
      return;
    }
    const message = failureMessage(result);
    setState(message === null ? { status: "confirm" } : { status: "failed", message });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state.status !== "sharing") closeDialog();
      }}
    >
      <DialogPopup className="max-w-lg" data-omp-share-gist-dialog>
        <DialogHeader>
          <DialogTitle>Share as a secret gist</DialogTitle>
          <DialogDescription>
            OMP encrypts this thread&apos;s session and uploads it to a secret GitHub gist with your
            <code> gh </code>
            account, and nowhere else: if the gist fails, nothing is uploaded. Anyone with the link
            can read the whole conversation, tool output included.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            {state.status === "shared" ? (
              <>
                <CopyableLink label="Share link" value={state.result.url} />
                <p className="text-muted-foreground text-xs">Gist: {state.result.gistUrl}</p>
                {state.result.truncated ? (
                  <p className="text-muted-foreground text-xs">
                    Large content was trimmed to fit the share size limit.
                  </p>
                ) : null}
              </>
            ) : (
              <p className="text-muted-foreground text-sm">
                The decryption key is in the link&apos;s fragment, so the gist alone cannot be read.
              </p>
            )}
            {state.status === "failed" ? (
              <p role="alert" className="text-destructive text-xs">
                {state.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          {state.status === "shared" ? (
            <Button size="sm" onClick={closeDialog}>
              Done
            </Button>
          ) : (
            <>
              <Button
                variant="outline"
                size="sm"
                onClick={closeDialog}
                disabled={state.status === "sharing"}
              >
                Cancel
              </Button>
              <Button size="sm" onClick={() => void share()} disabled={state.status === "sharing"}>
                {state.status === "sharing" ? "Sharing…" : "Share as gist"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

/** How often an open Share live dialog refreshes who is in the room. */
const COLLAB_REFRESH_MS = 5_000;

type LiveState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly room: OmpCollabStatus }
  | { readonly status: "busy"; readonly room: OmpCollabStatus }
  | { readonly status: "failed"; readonly room: OmpCollabStatus | null; readonly message: string };

function OmpShareLiveDialog({ dialog }: { readonly dialog: OmpThreadDialog }) {
  const [state, setState] = useState<LiveState>({ status: "loading" });
  const [access, setAccess] = useState<OmpCollabAccess>("view");
  const environmentId = dialog.threadRef.environmentId;
  const input = { instanceId: dialog.instanceId, threadId: dialog.threadRef.threadId };
  const room = state.status === "loading" ? null : state.room;
  const active = room?.active === true;

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      const result = await command(serverEnvironment.getOmpThreadCollab, {
        environmentId,
        input: { instanceId: dialog.instanceId, threadId: dialog.threadRef.threadId },
      });
      if (cancelled) return;
      if (result._tag === "Success") {
        setState((current) =>
          current.status === "busy" ? current : { status: "ready", room: result.value },
        );
        return;
      }
      const message = failureMessage(result);
      if (message !== null) setState({ status: "failed", room: null, message });
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), COLLAB_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [environmentId, dialog.instanceId, dialog.threadRef.threadId]);

  const start = async () => {
    const before = room ?? { active: false, participants: [] };
    setState({ status: "busy", room: before });
    const result = await command(serverEnvironment.startOmpThreadCollab, {
      environmentId,
      input: { ...input, access },
    });
    if (result._tag === "Success") {
      setState({ status: "ready", room: result.value });
      return;
    }
    const message = failureMessage(result);
    setState(
      message === null
        ? { status: "ready", room: before }
        : { status: "failed", room: before, message },
    );
  };

  const stop = async () => {
    const before = room ?? { active: false, participants: [] };
    setState({ status: "busy", room: before });
    const result = await command(serverEnvironment.stopOmpThreadCollab, { environmentId, input });
    if (result._tag === "Success") {
      setState({ status: "ready", room: { active: false, participants: [] } });
      return;
    }
    const message = failureMessage(result);
    setState(
      message === null
        ? { status: "ready", room: before }
        : { status: "failed", room: before, message },
    );
  };

  const guests = room?.participants.filter((participant) => participant.role === "guest") ?? [];
  // A failed status read leaves nothing to start from: the sidecar or the session is the problem.
  const canStart = state.status === "ready" || (state.status === "failed" && room !== null);

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && state.status !== "busy") closeDialog();
      }}
    >
      <DialogPopup className="max-w-lg" data-omp-share-live-dialog>
        <DialogHeader>
          <DialogTitle>Share live</DialogTitle>
          <DialogDescription>
            Others follow this thread&apos;s OMP session as it runs, in a browser or with{" "}
            <code>omp join</code>.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-3">
            <Alert variant="warning">
              <TriangleAlertIcon />
              <AlertTitle>This link bypasses T3 pairing</AlertTitle>
              <AlertDescription>
                Anyone holding it reaches the session through OMP&apos;s collab relay, outside
                T3&apos;s pairing and permissions. With control access they can also send prompts,
                which run with this thread&apos;s permissions. Share it only with people you trust,
                and stop sharing when you are done.
              </AlertDescription>
            </Alert>
            {active && room !== null ? (
              <>
                {room.webLink === undefined ? null : (
                  <>
                    <div className="flex justify-center rounded-xl border border-border/60 bg-muted/30 p-4">
                      <QRCodeSvg
                        value={room.webLink}
                        size={148}
                        level="M"
                        marginSize={2}
                        title="Live share link. Scan to open in a browser"
                      />
                    </div>
                    <CopyableLink label="Browser link" value={room.webLink} />
                  </>
                )}
                {room.link === undefined ? null : (
                  <CopyableLink label="omp join link" value={room.link} />
                )}
                <p className="text-muted-foreground text-xs">
                  {room.access === "control" ? "Guests can watch and prompt." : "Guests can watch."}{" "}
                  {guests.length === 0
                    ? "Nobody has joined yet."
                    : `${guests.length} ${guests.length === 1 ? "guest" : "guests"}: ${guests
                        .map((guest) => guest.name)
                        .join(", ")}.`}
                  {room.relayConnected === false ? " The relay is reconnecting." : ""}
                </p>
              </>
            ) : state.status === "loading" ? (
              <p className="text-muted-foreground text-sm">Checking for a live share…</p>
            ) : (
              <RadioGroup
                aria-label="What guests may do"
                value={access}
                onValueChange={(value) => setAccess(value as OmpCollabAccess)}
              >
                <label className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm">
                  <Radio value="view" />
                  <span className="font-medium">View only</span>
                </label>
                <label className="flex cursor-pointer items-center gap-3 rounded-lg border px-3 py-3 text-sm">
                  <Radio value="control" />
                  <span className="font-medium">View and prompt</span>
                </label>
              </RadioGroup>
            )}
            {state.status === "failed" ? (
              <p role="alert" className="text-destructive text-xs">
                {state.message}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={closeDialog}
            disabled={state.status === "busy"}
          >
            Close
          </Button>
          {active ? (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void stop()}
              disabled={state.status === "busy"}
            >
              Stop sharing
            </Button>
          ) : (
            <Button size="sm" onClick={() => void start()} disabled={!canStart}>
              {state.status === "busy" ? "Starting…" : "Start sharing"}
            </Button>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

const NODE_ICONS = {
  user: MessageSquareIcon,
  assistant: BotIcon,
  branch_summary: GitForkIcon,
  compaction: ArchiveIcon,
} as const satisfies Record<OmpBranchNode["kind"], unknown>;

const NODE_FALLBACK_LABELS = {
  user: "Message",
  assistant: "Reply",
  branch_summary: "Branch summary",
  compaction: "Compaction",
} as const satisfies Record<OmpBranchNode["kind"], string>;

/** Depth-first rows with their depth; `nodes` are parents first, so one pass orders them. */
function ompBranchTreeRows(
  tree: OmpBranchTree,
): ReadonlyArray<{ readonly node: OmpBranchNode; readonly depth: number; readonly fork: boolean }> {
  const children = new Map<string | null, Array<OmpBranchNode>>();
  for (const node of tree.nodes) {
    const siblings = children.get(node.parentId) ?? [];
    siblings.push(node);
    children.set(node.parentId, siblings);
  }
  const rows: Array<{ node: OmpBranchNode; depth: number; fork: boolean }> = [];
  const stack = (children.get(null) ?? []).toReversed().map((node) => ({ node, depth: 0 }));
  while (stack.length > 0) {
    const { node, depth } = stack.pop()!;
    const below = children.get(node.entryId) ?? [];
    rows.push({ node, depth, fork: below.length > 1 });
    // A lone child continues its parent's line; only a fork indents.
    const childDepth = below.length > 1 ? depth + 1 : depth;
    for (const child of below.toReversed()) stack.push({ node: child, depth: childDepth });
  }
  return rows;
}

type TreeState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly tree: OmpBranchTree }
  | { readonly status: "failed"; readonly message: string };

function OmpBranchTreeDialog({ dialog }: { readonly dialog: OmpThreadDialog }) {
  const [state, setState] = useState<TreeState>({ status: "loading" });

  useEffect(() => {
    let cancelled = false;
    void command(serverEnvironment.getOmpThreadBranchTree, {
      environmentId: dialog.threadRef.environmentId,
      input: { instanceId: dialog.instanceId, threadId: dialog.threadRef.threadId },
    }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") {
        setState({ status: "ready", tree: result.value });
        return;
      }
      setState({ status: "failed", message: failureMessage(result) ?? "Cancelled." });
    });
    return () => {
      cancelled = true;
    };
  }, [dialog.instanceId, dialog.threadRef.environmentId, dialog.threadRef.threadId]);

  const active = new Set(state.status === "ready" ? state.tree.activePath : []);
  const rows = state.status === "ready" ? ompBranchTreeRows(state.tree) : [];
  const forks = rows.filter((row) => row.fork).length;

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : closeDialog())}>
      <DialogPopup className="max-w-xl" data-omp-branch-tree-dialog>
        <DialogHeader>
          <DialogTitle>Branch tree</DialogTitle>
          <DialogDescription>
            Every branch of this thread&apos;s OMP session. The highlighted path is the one the
            thread continues from.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {state.status === "loading" ? (
            <p className="text-muted-foreground text-sm">Reading the session tree…</p>
          ) : state.status === "failed" ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : (
            <ThreadDetailsSection
              headingId="omp-branch-tree-heading"
              title={forks === 0 ? "One branch" : `${forks + 1} branches`}
              separated={false}
            >
              <ul
                aria-label="Session branches"
                className="m-0 max-h-[60dvh] list-none overflow-y-auto p-0"
              >
                {rows.map(({ node, depth, fork }) => {
                  const Icon = fork ? GitForkIcon : NODE_ICONS[node.kind];
                  const onPath = active.has(node.entryId);
                  return (
                    <li
                      key={node.entryId}
                      data-entry-id={node.entryId}
                      data-active-path={onPath ? "" : undefined}
                      className={cn(
                        "flex h-8 min-w-0 items-center rounded-lg text-sm",
                        THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
                        onPath ? "font-medium text-foreground/80" : "text-muted-foreground/70",
                      )}
                      style={{ paddingInlineStart: `${0.625 + depth * 1}rem` }}
                    >
                      <Icon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                      <span
                        className={cn("min-w-0 flex-1 truncate", THREAD_DETAILS_PANEL_LABEL_CLASS)}
                      >
                        {node.label ?? (node.preview || NODE_FALLBACK_LABELS[node.kind])}
                      </span>
                      {node.entryId === state.tree.leafId ? (
                        <span className="text-xs font-normal text-muted-foreground">current</span>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </ThreadDetailsSection>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" onClick={closeDialog}>
            Done
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
