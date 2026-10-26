import type { OmpMagicKeyword } from "@t3tools/provider-omp/composer";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const GRADIENT_STOPS = 5;

/** The keyword's colours as OMP draws them: a gradient along its hue sweep. */
function magicKeywordGradient(keyword: OmpMagicKeyword): string {
  const [from, to] = keyword.hue;
  const stops = Array.from({ length: GRADIENT_STOPS }, (_, index) => {
    const hue = (from + ((to - from) * index) / (GRADIENT_STOPS - 1)) % 360;
    return `oklch(0.68 0.17 ${hue.toFixed(1)})`;
  });
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** "needs task/eval" for a keyword OMP drops unless the session has those tools, else null. */
export function magicKeywordRequiresNote(keyword: OmpMagicKeyword): string | null {
  return keyword.requires.length === 0 ? null : `needs ${keyword.requires.join("/")}`;
}

/** The keyword's word, painted with its gradient. */
export function MagicKeywordWord(props: { keyword: OmpMagicKeyword; className?: string }) {
  return (
    <span
      className={cn("bg-clip-text font-semibold text-transparent", props.className)}
      style={{ backgroundImage: magicKeywordGradient(props.keyword) }}
    >
      {props.keyword.word}
    </span>
  );
}

/** A keyword the prompt contains, with what it does on hover or focus. */
export function MagicKeywordChip(props: { keyword: OmpMagicKeyword }) {
  const { keyword } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            data-magic-keyword={keyword.id}
            aria-label={`${keyword.label}: ${keyword.description}`}
            className="inline-flex h-5 shrink-0 items-center rounded-full border border-border/70 px-1.5 text-xs leading-none outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <MagicKeywordWord keyword={keyword} />
      </TooltipTrigger>
      <TooltipPopup side="top" className="max-w-64">
        <span className="block font-medium">{keyword.label}</span>
        <span className="block text-muted-foreground">{keyword.description}</span>
        {keyword.requires.length > 0 ? (
          <span className="block text-muted-foreground">
            Works only when the session has the {keyword.requires.join(" and ")}{" "}
            {keyword.requires.length === 1 ? "tool" : "tools"}.
          </span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}
