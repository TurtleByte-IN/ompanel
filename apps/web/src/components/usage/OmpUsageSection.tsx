import type {
  EnvironmentId,
  OmpAccountUsage,
  OmpSessionUsageList,
  OmpStatsSummary,
  OmpStatsTotals,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { useEffect, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentProviders } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";

/** One source of the tab: loading, its value, or why it failed. */
type OmpUsageSource<A> =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly value: A }
  | { readonly status: "error"; readonly message: string };

const LOADING = { status: "loading" } as const;

function toSource<A>(result: AtomCommandResult<A, unknown>): OmpUsageSource<A> | null {
  if (result._tag === "Success") return { status: "ok", value: result.value };
  if (isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return {
    status: "error",
    message: error instanceof Error ? error.message : "OMP did not answer.",
  };
}

/**
 * Usage → OMP: the OMP instances of the selected environments, one at a time, with a picker when
 * there are several. `refreshKey` changes when the page's refresh button is pressed.
 */
export function OmpUsageSection({
  environmentIds,
  refreshKey,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly refreshKey: number;
}) {
  const providersByEnvironment = useEnvironmentProviders();
  const instances = environmentIds.flatMap((environmentId) =>
    (providersByEnvironment.get(environmentId) ?? [])
      .filter((provider) => provider.driver === "omp")
      .map((provider) => ({
        key: `${environmentId}:${provider.instanceId}`,
        environmentId,
        instanceId: provider.instanceId,
        label: provider.displayName ?? provider.instanceId,
      })),
  );
  const [picked, setPicked] = useState<string | null>(null);
  const current = instances.find((instance) => instance.key === picked) ?? instances[0];

  if (current === undefined) {
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        Add an OMP provider to see its account limits and usage stats here.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {instances.length > 1 ? (
        <Select value={current.key} onValueChange={(next) => setPicked(next)}>
          <SelectTrigger size="sm" aria-label="OMP instance" className="w-auto">
            <SelectValue>{current.label}</SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {instances.map((instance) => (
              <SelectItem key={instance.key} value={instance.key}>
                {instance.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      {/* A refresh remounts the panel, so every source starts over from loading. */}
      <OmpUsagePanel
        key={`${current.key}:${refreshKey}`}
        environmentId={current.environmentId}
        instanceId={current.instanceId}
      />
    </div>
  );
}

/**
 * Fetches the three sources independently, so a slow `omp stats` never holds the others. The
 * parent keys it by instance and refresh, so state starts fresh for each.
 */
export function OmpUsagePanel({
  environmentId,
  instanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const getAccount = useAtomCommand(serverEnvironment.getOmpAccountUsage, { reportFailure: false });
  const getStats = useAtomCommand(serverEnvironment.getOmpStats, { reportFailure: false });
  const getSessions = useAtomCommand(serverEnvironment.getOmpSessionStats, {
    reportFailure: false,
  });
  const [account, setAccount] = useState<OmpUsageSource<OmpAccountUsage>>(LOADING);
  const [stats, setStats] = useState<OmpUsageSource<OmpStatsSummary>>(LOADING);
  const [sessions, setSessions] = useState<OmpUsageSource<OmpSessionUsageList>>(LOADING);
  const [now] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    const input = { environmentId, input: { instanceId } };
    const settle =
      <A,>(set: (source: OmpUsageSource<A>) => void) =>
      (result: AtomCommandResult<A, unknown>) => {
        const source = toSource(result);
        if (!cancelled && source !== null) set(source);
      };
    void getAccount(input).then(settle(setAccount));
    void getStats(input).then(settle(setStats));
    void getSessions(input).then(settle(setSessions));
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, getAccount, getStats, getSessions]);

  return <OmpUsageView account={account} stats={stats} sessions={sessions} now={now} />;
}

function SourceCard<A>({
  title,
  description,
  source,
  loadingText,
  children,
}: {
  readonly title: string;
  readonly description: string;
  readonly source: OmpUsageSource<A>;
  readonly loadingText: string;
  readonly children: (value: A) => ReactNode;
}) {
  return (
    <section
      className="rounded-lg border bg-card p-4"
      aria-label={title}
      data-omp-usage-source={source.status}
    >
      <header className="mb-3">
        <h2 className="text-sm font-medium">{title}</h2>
        <p className="text-xs text-muted-foreground">{description}</p>
      </header>
      {source.status === "loading" ? (
        <p className="text-sm text-muted-foreground" aria-busy="true">
          {loadingText}
        </p>
      ) : source.status === "error" ? (
        <p role="alert" className="text-sm text-destructive-foreground">
          {source.message}
        </p>
      ) : (
        children(source.value)
      )}
    </section>
  );
}

function formatReset(resetsAt: number, now: number): string {
  const minutes = Math.max(0, Math.round((resetsAt - now) / 60_000));
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `resets in ${hours} h`;
  return `resets in ${Math.round(hours / 24)} d`;
}

function totalTokensOf(totals: OmpStatsTotals) {
  return (
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  );
}

function Metric({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-medium tabular-nums">{value}</dd>
    </div>
  );
}

/** The tab's content, given each source's state. */
function OmpUsageView({
  account,
  stats,
  sessions,
  now,
}: {
  readonly account: OmpUsageSource<OmpAccountUsage>;
  readonly stats: OmpUsageSource<OmpStatsSummary>;
  readonly sessions: OmpUsageSource<OmpSessionUsageList>;
  readonly now: number;
}) {
  return (
    <div className="space-y-4">
      <SourceCard
        title="Account limits"
        description="Quota windows of the signed-in accounts (omp usage)."
        source={account}
        loadingText="Asking OMP for account limits…"
      >
        {(value) =>
          value.limits.length === 0 ? (
            <p className="text-sm text-muted-foreground">No signed-in account reports limits.</p>
          ) : (
            <ul className="space-y-3">
              {value.limits.map((limit) => {
                const fraction = limit.usedFraction;
                return (
                  <li
                    key={`${limit.provider}:${limit.accountId ?? ""}:${limit.id}`}
                    data-omp-limit={limit.id}
                  >
                    <div className="flex items-baseline justify-between gap-3 text-sm">
                      <span className="min-w-0 truncate">
                        <span className="font-medium">{limit.provider}</span>
                        {limit.accountId === undefined ? null : (
                          <span className="text-muted-foreground"> · {limit.accountId}</span>
                        )}
                        <span> · {limit.label}</span>
                      </span>
                      <span className="shrink-0 tabular-nums text-muted-foreground">
                        {fraction === undefined ? "unknown" : formatPercent(fraction, 0)}
                        {limit.resetsAt === undefined
                          ? null
                          : ` · ${formatReset(limit.resetsAt, now)}`}
                      </span>
                    </div>
                    {fraction === undefined ? null : (
                      <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className={cn(
                            "h-full rounded-full",
                            limit.status === "exhausted" || fraction >= 1
                              ? "bg-destructive"
                              : limit.status === "warning" || fraction >= 0.8
                                ? "bg-warning"
                                : "bg-primary",
                          )}
                          style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }}
                        />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        }
      </SourceCard>

      <SourceCard
        title="Last 24 hours"
        description="Totals over the last 24 hours of this profile's OMP sessions (omp stats)."
        source={stats}
        loadingText="OMP is reading its session history…"
      >
        {(value) => (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Metric label="Requests" value={formatCount(value.overall.requests)} />
              <Metric label="Failed" value={formatCount(value.overall.failedRequests)} />
              <Metric label="Tokens" value={formatTokens(totalTokensOf(value.overall))} />
              <Metric label="Cost" value={formatUsd(value.overall.costUsd)} />
            </dl>
            {value.byModel.length === 0 ? null : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted-foreground">
                  <tr>
                    <th className="text-start font-normal">Model</th>
                    <th className="text-end font-normal">Requests</th>
                    <th className="text-end font-normal">Tokens</th>
                    <th className="text-end font-normal">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {value.byModel.map((model) => (
                    <tr key={`${model.provider}/${model.model}`}>
                      <td className="truncate">
                        {model.provider}/{model.model}
                      </td>
                      <td className="text-end tabular-nums">{formatCount(model.requests)}</td>
                      <td className="text-end tabular-nums">
                        {formatTokens(totalTokensOf(model))}
                      </td>
                      <td className="text-end tabular-nums">{formatUsd(model.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </SourceCard>

      <SourceCard
        title="Running threads"
        description="Each running OMP thread's own session (get_session_stats)."
        source={sessions}
        loadingText="Asking running threads…"
      >
        {(value) =>
          value.sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground">No OMP thread is running.</p>
          ) : (
            <ul className="divide-y">
              {value.sessions.map((session) => (
                <li
                  key={session.threadId}
                  className="py-2 text-sm"
                  data-omp-session={session.sessionId}
                >
                  <div className="truncate text-xs text-muted-foreground">{session.cwd}</div>
                  {session.status === "error" ? (
                    <p role="alert" className="text-destructive-foreground">
                      {session.message}
                    </p>
                  ) : (
                    <div className="flex flex-wrap gap-x-4 tabular-nums">
                      <span>{formatTokens(session.stats.totalTokens)} tokens</span>
                      <span>{formatUsd(session.stats.costUsd)}</span>
                      <span>{formatCount(session.stats.toolCalls)} tool calls</span>
                      <span>
                        {formatCount(session.stats.userMessages + session.stats.assistantMessages)}{" "}
                        messages
                      </span>
                      {session.stats.contextUsage === undefined ? null : (
                        <span>
                          context {formatPercent(session.stats.contextUsage.percent / 100, 0)}
                        </span>
                      )}
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </SourceCard>
    </div>
  );
}
