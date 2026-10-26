import {
  OMP_AGENT_FILE_NAME_PATTERN,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useState } from "react";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { OmpFileEditorPane, useOmpAgentFilesList, useOmpFileEditor } from "./OmpAgentFileEditor";

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
  const { list, setList, loadFailed, refresh } = useOmpAgentFilesList({
    environmentId,
    instanceId,
  });
  const editor = useOmpFileEditor({
    environmentId,
    instanceId,
    onSaved: (_file, created) => {
      if (created) refresh();
    },
    onDeleted: setList,
  });
  const [newName, setNewName] = useState("");
  const open = editor.open;

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

  return (
    <section aria-label="Agent directory files" className="flex flex-col gap-3">
      <h3 className="font-medium text-sm">Files</h3>
      <p className="text-muted-foreground text-xs">
        In <code className="break-all">{list.agentDir}</code>, the agent directory of this OMP
        profile. OMP reads the advisor roster when a thread starts, so open threads may keep what
        they loaded until they restart.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="xs"
          aria-pressed={open?.file.kind === "watchdog"}
          onClick={() => editor.openFile({ kind: "watchdog" })}
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
                    onClick={() => editor.openFile({ kind: "agent", name: entry.name })}
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
              editor.startNew(
                { kind: "agent", name: newFileName },
                `agents/${newFileName}`,
                agentTemplate(newFileName),
              );
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
        <OmpFileEditorPane key={open.relativePath} editor={editor} open={open} />
      )}
    </section>
  );
}
