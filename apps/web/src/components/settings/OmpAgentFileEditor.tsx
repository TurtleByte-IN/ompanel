import type {
  EnvironmentId,
  OmpAgentFile,
  OmpAgentFileRef,
  OmpAgentFilesList,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

export function reportOmpFileFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "OMP's agent directory is unavailable.",
  });
}

interface OmpFilesTarget {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}

/** The instance's agent directory listing, read once on mount. */
export function useOmpAgentFilesList({ environmentId, instanceId }: OmpFilesTarget) {
  const listFiles = useAtomCommand(serverEnvironment.listOmpAgentFiles, { reportFailure: false });
  const [list, setList] = useState<OmpAgentFilesList | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // The parent keys the page by environment and instance, so state starts fresh for each.
  useEffect(() => {
    let cancelled = false;
    void listFiles({ environmentId, input: { instanceId } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") setList(result.value);
      else {
        setLoadFailed(true);
        reportOmpFileFailure("Could not list OMP's agent files", result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, listFiles]);

  const refresh = () =>
    void listFiles({ environmentId, input: { instanceId } }).then((result) => {
      if (result._tag === "Success") setList(result.value);
    });

  return { list, setList, loadFailed, refresh };
}

/** The file open in an editor: what was read, and the unsaved text. */
export interface OmpOpenFile {
  readonly file: OmpAgentFileRef;
  readonly relativePath: string;
  /** The version read; absent while the file does not exist yet. */
  readonly version: string | undefined;
  readonly saved: string;
  readonly draft: string;
}

export interface OmpFileEditor {
  readonly open: OmpOpenFile | null;
  readonly saving: boolean;
  readonly openFile: (file: OmpAgentFileRef) => void;
  /** Opens a file that does not exist yet, with `draft` as its first text. */
  readonly startNew: (file: OmpAgentFileRef, relativePath: string, draft: string) => void;
  readonly setDraft: (draft: string) => void;
  readonly save: (current: OmpOpenFile) => void;
  readonly remove: (current: OmpOpenFile) => void;
  readonly close: () => void;
}

/**
 * Opening, saving and deleting one agent directory file at a time. A save sends the version that
 * was read, so the server refuses it when the file changed on disk in between.
 */
export function useOmpFileEditor({
  environmentId,
  instanceId,
  onSaved,
  onDeleted,
}: OmpFilesTarget & {
  /** After a save; `created` when the file did not exist before. */
  readonly onSaved?: (file: OmpAgentFile, created: boolean) => void;
  readonly onDeleted?: (list: OmpAgentFilesList) => void;
}): OmpFileEditor {
  const readFile = useAtomCommand(serverEnvironment.readOmpAgentFile, { reportFailure: false });
  const writeFile = useAtomCommand(serverEnvironment.writeOmpAgentFile, { reportFailure: false });
  const deleteFile = useAtomCommand(serverEnvironment.deleteOmpAgentFile, { reportFailure: false });
  const [open, setOpen] = useState<OmpOpenFile | null>(null);
  const [saving, setSaving] = useState(false);

  const openFile = (file: OmpAgentFileRef) =>
    void readFile({ environmentId, input: { instanceId, file } }).then((result) => {
      if (result._tag !== "Success") {
        reportOmpFileFailure("Could not open the file", result);
        return;
      }
      const content = result.value.content ?? "";
      setOpen({
        file,
        relativePath: result.value.relativePath,
        version: result.value.version,
        saved: content,
        draft: content,
      });
    });

  const startNew = (file: OmpAgentFileRef, relativePath: string, draft: string) =>
    setOpen({ file, relativePath, version: undefined, saved: "", draft });

  const setDraft = (draft: string) =>
    setOpen((current) => (current === null ? null : { ...current, draft }));

  const save = (current: OmpOpenFile) => {
    setSaving(true);
    void writeFile({
      environmentId,
      input: {
        instanceId,
        file: current.file,
        content: current.draft,
        ...(current.version === undefined ? {} : { baseVersion: current.version }),
      },
    }).then((result) => {
      setSaving(false);
      if (result._tag !== "Success") {
        reportOmpFileFailure(`Could not save ${current.relativePath}`, result);
        return;
      }
      const content = result.value.content ?? current.draft;
      setOpen({ ...current, version: result.value.version, saved: content, draft: content });
      toastManager.add({ type: "success", title: `Saved ${result.value.relativePath}` });
      onSaved?.(result.value, current.version === undefined);
    });
  };

  const remove = (current: OmpOpenFile) => {
    if (current.version === undefined) return;
    void deleteFile({
      environmentId,
      input: { instanceId, file: current.file, baseVersion: current.version },
    }).then((result) => {
      if (result._tag !== "Success") {
        reportOmpFileFailure(`Could not delete ${current.relativePath}`, result);
        return;
      }
      setOpen(null);
      toastManager.add({ type: "success", title: `Deleted ${current.relativePath}` });
      onDeleted?.(result.value);
    });
  };

  return { open, saving, openFile, startNew, setDraft, save, remove, close: () => setOpen(null) };
}

/**
 * The open file as text: its path, the text, and Save, Reload and (optionally) Delete. Key it by
 * the file's path so a pending delete never carries over to another file.
 */
export function OmpFileEditorPane({
  editor,
  open,
  canDelete = true,
  rows = 16,
}: {
  readonly editor: OmpFileEditor;
  readonly open: OmpOpenFile;
  readonly canDelete?: boolean;
  readonly rows?: number;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = open.draft !== open.saved;
  return (
    <div className="flex min-w-0 flex-col gap-2" data-agent-file={open.relativePath}>
      <div className="flex flex-wrap items-center gap-2">
        <code className="break-all text-xs">{open.relativePath}</code>
        {open.version === undefined ? (
          <Badge variant="outline" size="sm">
            New
          </Badge>
        ) : null}
      </div>
      <Textarea
        aria-label={`Contents of ${open.relativePath}`}
        rows={rows}
        value={open.draft}
        onChange={(event) => editor.setDraft(event.target.value)}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="xs"
          disabled={editor.saving || (!dirty && open.version !== undefined)}
          onClick={() => editor.save(open)}
        >
          Save
        </Button>
        <Button variant="ghost" size="xs" onClick={() => editor.openFile(open.file)}>
          Reload
        </Button>
        {!canDelete || open.version === undefined ? null : confirmDelete ? (
          <Button
            variant="destructive"
            size="xs"
            onClick={() => {
              setConfirmDelete(false);
              editor.remove(open);
            }}
          >
            Delete {open.relativePath}
          </Button>
        ) : (
          <Button variant="ghost-destructive" size="xs" onClick={() => setConfirmDelete(true)}>
            Delete…
          </Button>
        )}
      </div>
    </div>
  );
}
