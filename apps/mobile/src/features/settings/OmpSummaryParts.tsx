// Rows and notes shared by the read-only OMP summaries on mobile (Settings → OMP).
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/** One read-only row: a name, a line of facts, an optional description and a path or command. */
export function OmpSummaryRow(props: {
  readonly title: string;
  readonly meta?: string | null | undefined;
  readonly detail?: string | null | undefined;
  readonly code?: string | null | undefined;
}) {
  const parts = [props.title, props.meta, props.detail, props.code].filter(
    (part): part is string => typeof part === "string" && part !== "",
  );
  return (
    <View
      accessible
      accessibilityLabel={parts.join(". ")}
      className="gap-1 border-b border-border-subtle px-4 py-3"
    >
      <Text selectable className="text-base text-foreground">
        {props.title}
      </Text>
      {props.meta ? <Text className="text-xs text-foreground-muted">{props.meta}</Text> : null}
      {props.detail ? <Text className="text-sm text-foreground-muted">{props.detail}</Text> : null}
      {props.code ? (
        <Text selectable className="font-mono text-xs text-foreground-muted">
          {props.code}
        </Text>
      ) : null}
    </View>
  );
}

/** A line of text inside a summary section: muted, a warning, or an error. */
export function OmpSummaryNote(props: {
  readonly children: string;
  readonly tone?: "muted" | "warning" | "error";
}) {
  const tone = props.tone ?? "muted";
  return (
    <Text
      accessibilityRole={tone === "error" ? "alert" : undefined}
      className={
        tone === "error"
          ? "px-4 py-3 text-sm text-danger-foreground"
          : tone === "warning"
            ? "px-4 py-3 text-sm text-warning-foreground"
            : "px-4 py-3 text-sm text-foreground-muted"
      }
    >
      {props.children}
    </Text>
  );
}

/** Joins the present parts of a row's fact line with " · ". */
export function joinMeta(parts: ReadonlyArray<string | null | undefined | false>): string {
  return parts
    .filter((part): part is string => typeof part === "string" && part !== "")
    .join(" · ");
}
