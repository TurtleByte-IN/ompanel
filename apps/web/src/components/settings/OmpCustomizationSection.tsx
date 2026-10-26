import {
  ompCustomizationPathAllowed,
  type EnvironmentId,
  type OmpAgentFileRef,
  type OmpCustomizationCategory,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import {
  OmpFileEditorPane,
  reportOmpFileFailure,
  useOmpAgentFilesList,
  useOmpFileEditor,
} from "./OmpAgentFileEditor";

interface CategoryView {
  readonly category: OmpCustomizationCategory;
  readonly title: string;
  readonly where: string;
  /** How a new file of this kind is named and started; absent for code (hooks, tools). */
  readonly create?: {
    readonly placeholder: string;
    readonly path: (name: string) => string;
    readonly template: (name: string) => string;
  };
}

/** Kinds in the order the page shows them, with where OMP loads each from. */
const CATEGORIES: ReadonlyArray<CategoryView> = [
  {
    category: "skill",
    title: "Skills",
    where: "skills/<name>/SKILL.md, and managed-skills/ for skills OMP learned",
    create: {
      placeholder: "tdd",
      path: (name) => `skills/${name}/SKILL.md`,
      template: (name) => `---\nname: ${name}\ndescription: \n---\n\n`,
    },
  },
  {
    category: "rule",
    title: "Rules",
    where:
      "rules/*.md and *.mdc (a condition makes a rule fire mid-turn: TTSR), plus RULES.md, applied to every request",
    create: {
      placeholder: "no-any",
      path: (name) => `rules/${name}.md`,
      template: () => "---\ndescription: \n---\n\n",
    },
  },
  {
    category: "prompt",
    title: "Prompt templates",
    where: "prompts/*.md",
    create: {
      placeholder: "review",
      path: (name) => `prompts/${name}.md`,
      template: () => "",
    },
  },
  {
    category: "hook",
    title: "Hooks",
    where: "hooks/pre/* and hooks/post/*, named after the tool they wrap (* for every tool)",
  },
  {
    category: "tool",
    title: "Custom tools",
    where: "tools/*.{json,md,ts,js,sh,bash,py} and tools/<name>/index.ts",
  },
];

/** A file name without its folder or extension; the kind adds both. */
const stem = (input: string) => input.trim().replace(/\.(?:md|mdc)$/, "");

function NewFileRow({
  view,
  taken,
  onCreate,
}: {
  readonly view: CategoryView & { readonly create: NonNullable<CategoryView["create"]> };
  readonly taken: (path: string) => boolean;
  readonly onCreate: (path: string, draft: string) => void;
}) {
  const [name, setName] = useState("");
  const path = view.create.path(stem(name));
  const valid = stem(name) !== "" && ompCustomizationPathAllowed(view.category, path);
  const exists = valid && taken(path);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Input
        className="max-w-56"
        aria-label={`New ${view.title.toLowerCase()} name`}
        placeholder={view.create.placeholder}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      <Button
        variant="outline"
        size="xs"
        disabled={!valid || exists}
        onClick={() => {
          onCreate(path, view.create.template(stem(name)));
          setName("");
        }}
      >
        New
      </Button>
      {name.trim() !== "" && !valid ? (
        <span className="text-destructive-foreground text-xs">
          Letters, digits, <code>. _ -</code>; no folders.
        </span>
      ) : exists ? (
        <span className="text-muted-foreground text-xs">{path} exists.</span>
      ) : null}
    </div>
  );
}

/**
 * Settings → OMP → Customization: the skills, rules, prompt templates, hooks, custom tools and
 * custom agents in the agent directory of this instance's OMP profile, each opened in the editor.
 */
export function OmpCustomizationSection({
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
  const unpackAgents = useAtomCommand(serverEnvironment.unpackOmpAgents, { reportFailure: false });
  const [unpacking, setUnpacking] = useState(false);
  const open = editor.open;

  if (list === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {loadFailed ? "OMP's agent directory is unavailable." : "Reading OMP's agent directory…"}
      </p>
    );
  }

  const unpack = () => {
    setUnpacking(true);
    void unpackAgents({ environmentId, input: { instanceId } }).then((result) => {
      setUnpacking(false);
      if (result._tag !== "Success") {
        reportOmpFileFailure("Could not unpack OMP's bundled agents", result);
        return;
      }
      setList(result.value.files);
      const { written, skipped } = result.value;
      toastManager.add({
        type: "success",
        title:
          written.length === 0
            ? "Every bundled agent is already in agents/"
            : `Unpacked ${written.length} bundled agent(s) into agents/`,
        ...(skipped.length === 0
          ? {}
          : { description: `Kept ${skipped.length} existing file(s): ${skipped.join(", ")}` }),
      });
    });
  };

  return (
    <section
      aria-label="Customization files"
      className="flex flex-col gap-4"
      data-omp-files="customization"
    >
      <p className="text-muted-foreground text-xs">
        In <code className="break-all">{list.agentDir}</code>, the agent directory of this OMP
        profile. OMP discovers these when a thread starts; open threads keep what they loaded until
        they restart. Project files in <code>.omp/</code> of a repository are not shown here.
      </p>
      {CATEGORIES.map((view) => {
        const entries = list.customization.filter((entry) => entry.category === view.category);
        return (
          <div
            key={view.category}
            className="flex flex-col gap-1.5"
            data-customization={view.category}
          >
            <h3 className="font-medium text-sm">{view.title}</h3>
            <p className="text-muted-foreground text-xs">{view.where}</p>
            {entries.length === 0 ? (
              <p className="text-muted-foreground text-xs">None yet.</p>
            ) : (
              <ul aria-label={view.title} className="flex flex-wrap gap-2">
                {entries.map((entry) => {
                  const file: OmpAgentFileRef = {
                    kind: "custom",
                    category: entry.category,
                    path: entry.path,
                  };
                  return (
                    <li key={entry.path} className="min-w-0">
                      {entry.editable ? (
                        <Button
                          variant="outline"
                          size="xs"
                          className="max-w-full"
                          aria-pressed={open?.relativePath === entry.path}
                          onClick={() => editor.openFile(file)}
                        >
                          <span className="truncate">{entry.path}</span>
                        </Button>
                      ) : (
                        <Badge variant="outline" size="sm" title="Outside what Ompanel edits">
                          {entry.path} (not editable here)
                        </Badge>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {view.create === undefined ? null : (
              <NewFileRow
                view={{ ...view, create: view.create }}
                taken={(path) => list.customization.some((entry) => entry.path === path)}
                onCreate={(path, draft) =>
                  editor.startNew({ kind: "custom", category: view.category, path }, path, draft)
                }
              />
            )}
          </div>
        );
      })}
      <div className="flex flex-col gap-1.5" data-customization="agents">
        <h3 className="font-medium text-sm">Custom agents</h3>
        <p className="text-muted-foreground text-xs">
          agents/*.md; create them under Advisor &amp; Agents.
        </p>
        {list.agents.length === 0 ? (
          <p className="text-muted-foreground text-xs">None yet.</p>
        ) : (
          <ul aria-label="Custom agents" className="flex flex-wrap gap-2">
            {list.agents.map((entry) => {
              const file: OmpAgentFileRef = { kind: "agent", name: entry.name };
              return (
                <li key={entry.name}>
                  {entry.editable ? (
                    <Button
                      variant="outline"
                      size="xs"
                      aria-pressed={open?.relativePath === `agents/${entry.name}`}
                      onClick={() => editor.openFile(file)}
                    >
                      {entry.name}
                    </Button>
                  ) : (
                    <Badge variant="outline" size="sm" title="Outside what Ompanel edits">
                      {entry.name} (not editable here)
                    </Badge>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="xs" disabled={unpacking} onClick={unpack}>
            Unpack bundled agents
          </Button>
          <span className="text-muted-foreground text-xs">
            <code>omp agents unpack</code> copies OMP's built-in agents into <code>agents/</code> to
            customize; existing files are kept.
          </span>
        </div>
      </div>
      {open === null ? null : (
        <OmpFileEditorPane key={open.relativePath} editor={editor} open={open} />
      )}
    </section>
  );
}
