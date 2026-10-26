import {
  OMP_AGENT_FILE_NAME_PATTERN,
  type EnvironmentId,
  type OmpAgentFileRef,
  type OmpAgentFilesList,
  type ProviderInstanceId,
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
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

function reportFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "OMP's agent directory is unavailable.",
  });
}

/** The file open in the editor: what was read, and the unsaved text. */
interface OpenFile {
  readonly file: OmpAgentFileRef;
  readonly relativePath: string;
  /** The version read; absent while the file does not exist yet. */
  readonly version: string | undefined;
  readonly saved: string;
  readonly draft: string;
}

const agentTemplate = (name: string) =>
  `---\nname: ${name.replace(/\.md$/, "")}\ndescription: \n---\n\n`;

/**
 * Settings → OMP Advisor & Agents files: the user-level `WATCHDOG.yml` advisor roster and the
 * custom agents in `agents/`, in the agent directory of this instance's OMP profile.
 */
export function OmpAgentFilesSection({
  environmentId,
  instanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const listFiles = useAtomCommand(serverEnvironment.listOmpAgentFiles, { reportFailure: false });
  const readFile = useAtomCommand(serverEnvironment.readOmpAgentFile, { reportFailure: false });
  const writeFile = useAtomCommand(serverEnvironment.writeOmpAgentFile, { reportFailure: false });
  const deleteFile = useAtomCommand(serverEnvironment.deleteOmpAgentFile, { reportFailure: false });
  const [list, setList] = useState<OmpAgentFilesList | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [open, setOpen] = useState<OpenFile | null>(null);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);

  // The parent keys this section by environment and instance, so state starts fresh for each.
  useEffect(() => {
    let cancelled = false;
    void listFiles({ environmentId, input: { instanceId } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") setList(result.value);
      else {
        setLoadFailed(true);
        reportFailure("Could not list OMP's agent files", result);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, listFiles]);

  const refreshList = () =>
    void listFiles({ environmentId, input: { instanceId } }).then((result) => {
      if (result._tag === "Success") setList(result.value);
    });

  const openFile = (file: OmpAgentFileRef) => {
    setConfirmDelete(false);
    void readFile({ environmentId, input: { instanceId, file } }).then((result) => {
      if (result._tag !== "Success") {
        reportFailure("Could not open the file", result);
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
  };

  const save = (current: OpenFile) =>
    void writeFile({
      environmentId,
      input: {
        instanceId,
        file: current.file,
        content: current.draft,
        ...(current.version === undefined ? {} : { baseVersion: current.version }),
      },
    }).then((result) => {
      if (result._tag !== "Success") {
        reportFailure(`Could not save ${current.relativePath}`, result);
        return;
      }
      const content = result.value.content ?? current.draft;
      setOpen({ ...current, version: result.value.version, saved: content, draft: content });
      toastManager.add({ type: "success", title: `Saved ${result.value.relativePath}` });
      if (current.version === undefined) refreshList();
    });

  const remove = (current: OpenFile) => {
    if (current.version === undefined) return;
    void deleteFile({
      environmentId,
      input: { instanceId, file: current.file, baseVersion: current.version },
    }).then((result) => {
      setConfirmDelete(false);
      if (result._tag !== "Success") {
        reportFailure(`Could not delete ${current.relativePath}`, result);
        return;
      }
      setList(result.value);
      setOpen(null);
      toastManager.add({ type: "success", title: `Deleted ${current.relativePath}` });
    });
  };

  const newFileName = newName.trim().endsWith(".md") ? newName.trim() : `${newName.trim()}.md`;
  const newNameValid = newName.trim() !== "" && OMP_AGENT_FILE_NAME_PATTERN.test(newFileName);
  const newNameTaken = list?.agents.some((entry) => entry.name === newFileName) ?? false;

  if (list === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {loadFailed ? "OMP's agent directory is unavailable." : "Reading OMP's agent directory…"}
      </p>
    );
  }

  const dirty = open !== null && open.draft !== open.saved;
  return (
    <section aria-label="Agent directory files" className="flex flex-col gap-3">
      <h3 className="font-medium text-sm">Files</h3>
      <p className="text-muted-foreground text-xs">
        In <code>{list.agentDir}</code>, the agent directory of this OMP profile. OMP reads the
        advisor roster when a thread starts, so open threads may keep what they loaded until they
        restart.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="xs"
          aria-pressed={open?.file.kind === "watchdog"}
          onClick={() => openFile({ kind: "watchdog" })}
        >
          {list.watchdogFileName}
        </Button>
        {list.watchdogExists ? null : (
          <span className="text-muted-foreground text-xs">not created yet</span>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs">Custom agents</span>
        {list.agents.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            No agents in <code>agents/</code>.
          </p>
        ) : (
          <ul aria-label="Custom agents" className="flex flex-wrap gap-2">
            {list.agents.map((entry) => (
              <li key={entry.name}>
                {entry.editable ? (
                  <Button
                    variant="outline"
                    size="xs"
                    aria-pressed={open?.file.kind === "agent" && open.file.name === entry.name}
                    onClick={() => openFile({ kind: "agent", name: entry.name })}
                  >
                    {entry.name}
                  </Button>
                ) : (
                  <Badge variant="outline" size="sm" title="Outside what Ompanel edits">
                    {entry.name} (not editable here)
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-56"
            aria-label="New agent file name"
            placeholder="reviewer.md"
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
          />
          <Button
            variant="outline"
            size="xs"
            disabled={!newNameValid || newNameTaken}
            onClick={() => {
              const content = agentTemplate(newFileName);
              setConfirmDelete(false);
              setOpen({
                file: { kind: "agent", name: newFileName },
                relativePath: `agents/${newFileName}`,
                version: undefined,
                saved: "",
                draft: content,
              });
              setNewName("");
            }}
          >
            New agent
          </Button>
          {newName.trim() !== "" && !newNameValid ? (
            <span className="text-destructive-foreground text-xs">
              Letters, digits, <code>. _ -</code>; no folders.
            </span>
          ) : newNameTaken ? (
            <span className="text-muted-foreground text-xs">{newFileName} exists.</span>
          ) : null}
        </div>
      </div>
      {open === null ? null : (
        <div className="flex flex-col gap-2" data-agent-file={open.relativePath}>
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs">{open.relativePath}</code>
            {open.version === undefined ? (
              <Badge variant="outline" size="sm">
                New
              </Badge>
            ) : null}
          </div>
          <Textarea
            aria-label={`Contents of ${open.relativePath}`}
            rows={16}
            value={open.draft}
            onChange={(event) => setOpen({ ...open, draft: event.target.value })}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="xs"
              disabled={!dirty && open.version !== undefined}
              onClick={() => save(open)}
            >
              Save
            </Button>
            <Button variant="ghost" size="xs" onClick={() => openFile(open.file)}>
              Reload
            </Button>
            {open.version === undefined ? null : confirmDelete ? (
              <Button variant="destructive" size="xs" onClick={() => remove(open)}>
                Delete {open.relativePath}
              </Button>
            ) : (
              <Button variant="ghost-destructive" size="xs" onClick={() => setConfirmDelete(true)}>
                Delete…
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
