import type { EnvironmentId, OmpMcpFileName, ProviderInstanceId } from "@t3tools/contracts";

import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { OmpFileEditorPane, useOmpAgentFilesList, useOmpFileEditor } from "./OmpAgentFileEditor";

const MCP_TEMPLATE = '{\n  "mcpServers": {}\n}\n';

/**
 * Settings → OMP → MCP: the servers OMP starts from `mcp.json` and `.mcp.json` in the agent
 * directory of this instance's OMP profile, each file opened in the editor, next to a pointer to
 * Ompanel's own MCP server.
 */
export function OmpMcpSection({
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
  // Every save can add or drop servers, so the list is read again.
  const editor = useOmpFileEditor({
    environmentId,
    instanceId,
    onSaved: refresh,
    onDeleted: setList,
  });
  const open = editor.open;

  if (list === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {loadFailed ? "OMP's agent directory is unavailable." : "Reading OMP's agent directory…"}
      </p>
    );
  }

  const openMcpFile = (name: OmpMcpFileName, exists: boolean) =>
    exists
      ? editor.openFile({ kind: "mcp", name })
      : editor.startNew({ kind: "mcp", name }, name, MCP_TEMPLATE);

  return (
    <section aria-label="MCP servers" className="flex flex-col gap-4" data-omp-files="mcp">
      <div className="flex flex-col gap-1.5">
        <h3 className="font-medium text-sm">OMP's MCP servers</h3>
        <p className="text-muted-foreground text-xs">
          From <code>mcp.json</code> and <code>.mcp.json</code> in{" "}
          <code className="break-all">{list.agentDir}</code>, the agent directory of this OMP
          profile. OMP starts them in every thread; a repository's own <code>.omp/mcp.json</code>{" "}
          adds more there. Arguments, headers and environment are not shown; open the file to see
          them.
        </p>
        <p className="text-warning-foreground text-xs" data-omp-third-party="mcp">
          Each server is third-party code that runs with your permissions. By default OMP mounts its
          tools as <code>xd://</code> devices the agent calls, and their cards are labelled{" "}
          <code>xd://</code>. Add only servers you trust.
        </p>
        {list.mcpServers.length === 0 ? (
          <p className="text-muted-foreground text-xs">No servers.</p>
        ) : (
          <ul aria-label="OMP MCP servers" className="flex flex-col gap-1.5">
            {list.mcpServers.map((server) => (
              <li
                key={`${server.file}:${server.name}`}
                className="flex min-w-0 flex-wrap items-center gap-2"
                data-mcp-server={server.name}
              >
                <code className="text-xs">{server.name}</code>
                <Badge variant="outline" size="sm">
                  {server.transport}
                </Badge>
                {server.disabled ? (
                  <Badge variant="warning" size="sm">
                    Disabled
                  </Badge>
                ) : null}
                {server.target === undefined ? null : (
                  <code className="min-w-0 break-all text-muted-foreground text-xs">
                    {server.target}
                  </code>
                )}
                <span className="text-muted-foreground text-xs">{server.file}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs">Files</span>
        <ul aria-label="OMP MCP files" className="flex flex-wrap items-center gap-2">
          {list.mcpFiles.map((file) => (
            <li key={file.name} className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="xs"
                disabled={file.problem === "not_editable"}
                aria-pressed={open?.relativePath === file.name}
                onClick={() => openMcpFile(file.name, file.exists)}
              >
                {file.name}
              </Button>
              {!file.exists ? (
                <span className="text-muted-foreground text-xs">not created yet</span>
              ) : file.problem === "invalid_json" ? (
                <Badge variant="warning" size="sm">
                  Not valid JSON: OMP loads no servers from it
                </Badge>
              ) : file.problem === "not_editable" ? (
                <Badge variant="outline" size="sm">
                  Outside what Ompanel edits
                </Badge>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
      {open === null ? null : (
        <OmpFileEditorPane key={open.relativePath} editor={editor} open={open} />
      )}
      <div className="flex flex-col gap-1.5" data-ompanel-mcp="">
        <h3 className="font-medium text-sm">Ompanel's MCP server</h3>
        <p className="text-muted-foreground text-xs">
          Ompanel runs its own MCP server, separate from these: other agents reach this environment
          through it. Copy its URL from the environment's menu under Settings → Connections.
        </p>
      </div>
    </section>
  );
}
