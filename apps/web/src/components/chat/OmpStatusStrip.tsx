import type { OrchestrationV2ProviderExtensionStatus } from "@t3tools/contracts";

/**
 * Status lines and widgets the thread's agent extensions show (OMP `setStatus` /
 * `setWidget`), above the composer. Status lines share one row; each widget gets its own
 * block. Renders nothing when no extension shows anything.
 */
export function OmpStatusStrip(props: {
  readonly entries: ReadonlyArray<OrchestrationV2ProviderExtensionStatus> | undefined;
}) {
  const entries = props.entries ?? [];
  if (entries.length === 0) return null;
  const statuses = entries.filter((entry) => entry.kind === "status");
  const widgets = entries.filter((entry) => entry.kind === "widget");
  return (
    <section
      aria-label="Extension status"
      data-omp-status-strip="true"
      className="mb-1.5 flex flex-col gap-1 rounded-xl border border-border/60 bg-muted/40 px-3 py-1.5 font-mono text-muted-foreground text-xs"
    >
      {statuses.length > 0 ? (
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          {statuses.map((entry) => (
            <li
              key={entry.key}
              data-extension-status={entry.key}
              className="min-w-0 max-w-full truncate"
            >
              {entry.lines.join(" ")}
            </li>
          ))}
        </ul>
      ) : null}
      {widgets.map((entry) => (
        <pre
          key={entry.key}
          data-extension-widget={entry.key}
          aria-label={entry.key}
          className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono"
        >
          {entry.lines.join("\n")}
        </pre>
      ))}
    </section>
  );
}
