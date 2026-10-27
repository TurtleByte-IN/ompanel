import type { RunId } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import type { ThreadFeedEntry } from "../../lib/threadActivity";
import { ShimmeringWorkContent } from "./thread-work-log";

export function ThreadContextDivider(props: {
  label: string;
  icon: AppSymbolName;
  iconColor: ColorValue;
  active?: boolean;
  failed?: boolean;
  children?: ReactNode;
}) {
  return (
    <View className="mb-3 flex-row items-center gap-3 px-1 py-1">
      <View className="h-px min-w-2 flex-1 bg-separator" />
      <View className="shrink flex-row flex-wrap items-center justify-center gap-1.5">
        <SymbolView name={props.icon} size={12} tintColor={props.iconColor} type="monochrome" />
        {props.active ? (
          <ShimmeringWorkContent
            className="flex-none"
            textClassName="font-t3-medium"
            compact
            icon="brain"
            iconSubtleColor={props.iconColor}
            label={props.label}
            showIcon={false}
          />
        ) : (
          <Text
            className={
              props.failed
                ? "font-t3-medium text-xs text-danger-foreground"
                : "font-t3-medium text-xs text-foreground-muted"
            }
          >
            {props.label}
          </Text>
        )}
        {props.children}
      </View>
      <View className="h-px min-w-2 flex-1 bg-separator" />
    </View>
  );
}

/**
 * A context compaction item as one divider that shimmers while its run compacts, then names how
 * it ended. `labels` lead with why Ompanel compacted, when it did so without being asked.
 */
export function ThreadCompactionDivider(props: {
  entry: Extract<ThreadFeedEntry, { readonly type: "activity-group" }>;
  unsettledTurnId: RunId | null;
  labels: { readonly title: string; readonly compacting: string } | undefined;
  iconColor: ColorValue;
}) {
  const { entry, labels } = props;
  const label = entry.activities[0]!.summary;
  const item = entry.activities[0]!.projectedItem.item;
  const active =
    props.unsettledTurnId !== null &&
    entry.runId === props.unsettledTurnId &&
    item.status === "running";
  const failure =
    item.type === "compaction" && item.status === "failed" ? item.summary?.trim() : undefined;
  return (
    <ThreadContextDivider
      label={
        failure
          ? `${label} · ${failure}`
          : active && labels
            ? labels.compacting
            : labels !== undefined && label.startsWith("Context compacted")
              ? labels.title + label.slice("Context compacted".length)
              : label
      }
      icon={
        item.status === "failed" ? "exclamationmark.circle" : "arrow.down.right.and.arrow.up.left"
      }
      iconColor={props.iconColor}
      active={active}
      failed={item.status === "failed"}
    />
  );
}
