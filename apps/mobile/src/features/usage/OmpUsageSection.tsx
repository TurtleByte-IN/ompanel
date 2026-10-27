// Usage → OMP on mobile: the native counterpart of web's Usage → OMP tab
// (apps/web/src/components/usage/OmpUsageSection.tsx), over the same server RPCs. Read-only.
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  OmpAccountUsage,
  OmpSessionUsageList,
  OmpStatsSummary,
  OmpStatsTotals,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { formatCount, formatPercent, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { useState, type ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { environmentPresentations } from "../../state/presentation";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useOmpInstanceRead, type OmpRead } from "../settings/useOmpInstanceRead";

const FAILED_TEXT = "OMP did not answer.";

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

function SourceSection<A>(props: {
  readonly title: string;
  readonly description: string;
  readonly read: OmpRead<A>;
  readonly loadingText: string;
  readonly children: (value: A) => ReactNode;
}) {
  const { read } = props;
  return (
    <SettingsSection title={props.title} footer={props.description}>
      <View className="gap-3 px-4 py-3">
        {read.status === "loading" ? (
          <Text accessibilityState={{ busy: true }} className="text-sm text-foreground-muted">
            {props.loadingText}
          </Text>
        ) : read.status === "error" ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {read.message}
          </Text>
        ) : (
          props.children(read.value)
        )}
      </View>
    </SettingsSection>
  );
}

function Metric(props: { readonly label: string; readonly value: string }) {
  return (
    <View
      accessible
      accessibilityLabel={`${props.label}: ${props.value}`}
      className="min-w-[40%] flex-1 gap-0.5"
    >
      <Text className="text-xs text-foreground-muted">{props.label}</Text>
      <Text className="text-lg font-t3-medium tabular-nums text-foreground">{props.value}</Text>
    </View>
  );
}

/** Account limits, the last 24 hours and running threads of one OMP instance, as each settles. */
export function OmpUsageView(props: {
  readonly account: OmpRead<OmpAccountUsage>;
  readonly stats: OmpRead<OmpStatsSummary>;
  readonly sessions: OmpRead<OmpSessionUsageList>;
  readonly now: number;
}) {
  const { now } = props;
  return (
    <View className="gap-6">
      <SourceSection
        title="Account limits"
        description="Quota windows of the signed-in accounts (omp usage)."
        read={props.account}
        loadingText="Asking OMP for account limits…"
      >
        {(value) =>
          value.limits.length === 0 ? (
            <Text className="text-sm text-foreground-muted">
              No signed-in account reports limits.
            </Text>
          ) : (
            value.limits.map((limit) => {
              const fraction = limit.usedFraction;
              const name = [limit.provider, limit.accountId, limit.label]
                .filter((part) => part !== undefined)
                .join(" · ");
              const amount = `${fraction === undefined ? "unknown" : formatPercent(fraction, 0)}${
                limit.resetsAt === undefined ? "" : ` · ${formatReset(limit.resetsAt, now)}`
              }`;
              return (
                <View
                  key={`${limit.provider}:${limit.accountId ?? ""}:${limit.id}`}
                  accessible
                  accessibilityLabel={`${name}: ${amount}`}
                  className="gap-1"
                >
                  <View className="flex-row items-baseline justify-between gap-3">
                    <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
                      {name}
                    </Text>
                    <Text className="text-sm tabular-nums text-foreground-muted">{amount}</Text>
                  </View>
                  {fraction === undefined ? null : (
                    <View className="h-1.5 overflow-hidden rounded-full bg-subtle">
                      <View
                        className={
                          limit.status === "exhausted" || fraction >= 1
                            ? "h-full rounded-full bg-red-500"
                            : limit.status === "warning" || fraction >= 0.8
                              ? "h-full rounded-full bg-amber-500"
                              : "h-full rounded-full bg-foreground"
                        }
                        style={{ width: `${Math.min(100, Math.max(0, fraction * 100))}%` }}
                      />
                    </View>
                  )}
                </View>
              );
            })
          )
        }
      </SourceSection>

      <SourceSection
        title="Last 24 hours"
        description="Totals over the last 24 hours of this profile's OMP sessions (omp stats)."
        read={props.stats}
        loadingText="OMP is reading its session history…"
      >
        {(value) => (
          <>
            <View className="flex-row flex-wrap gap-3">
              <Metric label="Requests" value={formatCount(value.overall.requests)} />
              <Metric label="Failed" value={formatCount(value.overall.failedRequests)} />
              <Metric label="Tokens" value={formatTokens(totalTokensOf(value.overall))} />
              <Metric label="Cost" value={formatUsd(value.overall.costUsd)} />
            </View>
            {value.byModel.map((model) => {
              const name = `${model.provider}/${model.model}`;
              const figures = `${formatCount(model.requests)} requests · ${formatTokens(
                totalTokensOf(model),
              )} tokens · ${formatUsd(model.costUsd)}`;
              return (
                <View
                  key={name}
                  accessible
                  accessibilityLabel={`${name}: ${figures}`}
                  className="gap-0.5 border-t border-border-subtle pt-2"
                >
                  <Text numberOfLines={1} className="text-sm text-foreground">
                    {name}
                  </Text>
                  <Text className="text-xs tabular-nums text-foreground-muted">{figures}</Text>
                </View>
              );
            })}
          </>
        )}
      </SourceSection>

      <SourceSection
        title="Running threads"
        description="Each running OMP thread's own session (get_session_stats)."
        read={props.sessions}
        loadingText="Asking running threads…"
      >
        {(value) =>
          value.sessions.length === 0 ? (
            <Text className="text-sm text-foreground-muted">No OMP thread is running.</Text>
          ) : (
            value.sessions.map((session) => (
              <View key={session.threadId} className="gap-0.5 border-t border-border-subtle pt-2">
                <Text numberOfLines={1} className="text-xs text-foreground-muted">
                  {session.cwd}
                </Text>
                {session.status === "error" ? (
                  <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                    {session.message}
                  </Text>
                ) : (
                  <Text className="text-sm tabular-nums text-foreground">
                    {[
                      `${formatTokens(session.stats.totalTokens)} tokens`,
                      formatUsd(session.stats.costUsd),
                      `${formatCount(session.stats.toolCalls)} tool calls`,
                      `${formatCount(
                        session.stats.userMessages + session.stats.assistantMessages,
                      )} messages`,
                      session.stats.contextUsage === undefined
                        ? null
                        : `context ${formatPercent(session.stats.contextUsage.percent / 100, 0)}`,
                    ]
                      .filter((part) => part !== null)
                      .join(" · ")}
                  </Text>
                )}
              </View>
            ))
          )
        }
      </SourceSection>
    </View>
  );
}

/** Reads the three sources independently, so a slow `omp stats` never holds the others. */
function OmpUsagePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const { environmentId, instanceId } = props;
  const options = { reportFailure: false };
  const account = useOmpInstanceRead(
    useAtomCommand(serverEnvironment.getOmpAccountUsage, options),
    environmentId,
    instanceId,
    FAILED_TEXT,
  );
  const stats = useOmpInstanceRead(
    useAtomCommand(serverEnvironment.getOmpStats, options),
    environmentId,
    instanceId,
    FAILED_TEXT,
  );
  const sessions = useOmpInstanceRead(
    useAtomCommand(serverEnvironment.getOmpSessionStats, options),
    environmentId,
    instanceId,
    FAILED_TEXT,
  );
  const [now] = useState(() => Date.now());
  return <OmpUsageView account={account} stats={stats} sessions={sessions} now={now} />;
}

export interface OmpUsageEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

/** The OMP instances of these environments, ordered by environment. */
export function useOmpUsageInstances(environments: ReadonlyArray<OmpUsageEnvironment>) {
  const providersByEnvironment = useAtomValue(environmentPresentations.providersByEnvironmentAtom);
  return environments.flatMap((environment) =>
    (providersByEnvironment.get(environment.environmentId) ?? [])
      .filter((provider) => provider.driver === "omp")
      .map((provider) => ({
        key: `${environment.environmentId}:${provider.instanceId}`,
        environmentId: environment.environmentId,
        instanceId: provider.instanceId,
        label: `${environment.label} · ${provider.displayName ?? provider.instanceId}`,
      })),
  );
}

/**
 * Usage → OMP: every OMP instance of the selected environments, one after another (web shows one
 * at a time with a picker). `refreshKey` changes on pull to refresh and remounts each panel.
 */
export function OmpUsageSection(props: {
  readonly environments: ReadonlyArray<OmpUsageEnvironment>;
  readonly refreshKey: number;
}) {
  const instances = useOmpUsageInstances(props.environments);
  if (instances.length === 0) {
    return (
      <Text className="py-16 text-center text-base text-foreground-muted">
        Add an OMP provider to see its account limits and usage stats here.
      </Text>
    );
  }
  return (
    <View className="gap-8">
      {instances.map((instance) => (
        <View key={`${instance.key}:${props.refreshKey}`} className="gap-3">
          {instances.length > 1 ? (
            <Text className="text-lg font-semibold text-foreground">{instance.label}</Text>
          ) : null}
          <OmpUsagePanel environmentId={instance.environmentId} instanceId={instance.instanceId} />
        </View>
      ))}
    </View>
  );
}
