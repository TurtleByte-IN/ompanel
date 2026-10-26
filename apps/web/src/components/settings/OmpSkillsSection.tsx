import type { EnvironmentId, OmpSkillsList, ProviderInstanceId } from "@t3tools/contracts";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState } from "react";

import { useOpenInPreferredEditor } from "../../editorPreferences";
import { primaryServerAvailableEditorsAtom, serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { reportOmpFailure } from "./OmpPluginsSection";

/**
 * Settings → OMP → Skills: what `omp skill list --json` resolves for a thread outside any
 * project (user skills, other agents' user skills, plugin skills), each opened in the editor.
 */
export function OmpSkillsSection({
  environmentId,
  instanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const listSkills = useAtomCommand(serverEnvironment.listOmpSkills, { reportFailure: false });
  const availableEditors = useAtomValue(primaryServerAvailableEditorsAtom);
  const openInEditor = useOpenInPreferredEditor(environmentId, availableEditors);
  const [list, setList] = useState<OmpSkillsList | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  // The parent keys this section by environment and instance, so it reads once per instance.
  useEffect(() => {
    let cancelled = false;
    void listSkills({ environmentId, input: { instanceId } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") setList(result.value);
      else if (!isAtomCommandInterrupted(result)) setLoadFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, listSkills]);

  if (list === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {loadFailed ? "OMP's skills are unavailable." : "Reading OMP's skills…"}
      </p>
    );
  }

  const open = (filePath: string) =>
    void openInEditor(filePath).then((result) => {
      if (result._tag !== "Success") reportOmpFailure("Could not open the skill", result);
    });

  return (
    <section aria-label="OMP skills" className="flex flex-col gap-3" data-omp-skills>
      <p className="text-muted-foreground text-xs">
        Skills from plugins are third-party content, like the plugins themselves. A repository's own
        skills in <code>.omp/skills</code> load in its threads and show in the composer's{" "}
        <code>$</code> menu there. Create and edit your own under Customization.
      </p>
      {list.skills.length === 0 ? (
        <p className="text-muted-foreground text-xs">OMP found no skills.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {list.skills.map((skill) => (
            <li
              key={skill.filePath}
              className="flex flex-wrap items-center gap-2 px-3 py-2"
              data-omp-skill={skill.name}
            >
              <div className="flex min-w-0 flex-1 flex-col">
                <span className="flex flex-wrap items-center gap-1.5 text-sm">
                  <span className="font-medium">{skill.name}</span>
                  <Badge variant="outline" size="sm">
                    {skill.source}
                  </Badge>
                  {skill.hidden ? (
                    <Badge variant="secondary" size="sm">
                      hidden from the model
                    </Badge>
                  ) : null}
                </span>
                <span className="text-muted-foreground text-xs">{skill.description}</span>
                <code className="break-all text-2xs text-muted-foreground">{skill.filePath}</code>
              </div>
              <Button
                variant="outline"
                size="xs"
                disabled={availableEditors.length === 0}
                onClick={() => open(skill.filePath)}
              >
                Open in editor
              </Button>
            </li>
          ))}
        </ul>
      )}
      {list.warnings.length === 0 ? null : (
        <div className="flex flex-col gap-1" data-omp-skill-warnings>
          <h3 className="font-medium text-sm">Warnings</h3>
          <ul className="flex flex-col gap-1 text-warning-foreground text-xs">
            {list.warnings.map((warning) => (
              <li key={`${warning.skillPath}:${warning.message}`}>
                <code className="break-all">{warning.skillPath}</code>: {warning.message}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
