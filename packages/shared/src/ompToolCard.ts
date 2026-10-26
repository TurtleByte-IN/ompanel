import * as Predicate from "effect/Predicate";

/**
 * Structured cards for OMP tool calls. The omp provider puts one beside the result's content
 * blocks in a `dynamic_tool` item's output (`{content, ompCard}`); clients render it in place of
 * the generic tool output. Shapes follow the tools' `details` at the pinned OMP contract.
 */
export const OMP_CARD_OUTPUT_KEY = "ompCard";

export interface OmpAskAnswer {
  readonly question: string;
  readonly multi: boolean;
  readonly selected: ReadonlyArray<string>;
  /** Free text typed instead of (or beside) an option: OMP's "Other". */
  readonly custom?: string;
  readonly note?: string;
  readonly timedOut?: boolean;
}

/** Where an `ast_edit` proposal stands. OMP stages it; only the agent applies or discards it. */
export type OmpProposalState = "proposed" | "applied" | "discarded";

export interface OmpDebugFrame {
  readonly id: number;
  readonly name: string;
  readonly path?: string;
  readonly line: number;
  readonly column: number;
}

export interface OmpDebugVariable {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
}

export interface OmpEvalCell {
  readonly index: number;
  readonly title?: string;
  readonly code: string;
  readonly output: string;
  readonly status: string;
  readonly durationMs?: number;
}

export type OmpMemoryOp = "recall" | "retain" | "reflect" | "edit";

export type OmpToolCard =
  | {
      readonly kind: "ask";
      readonly answers: ReadonlyArray<OmpAskAnswer>;
      readonly chatRedirect?: boolean;
    }
  | {
      readonly kind: "proposed_edit";
      readonly source: "ast_edit";
      readonly state: OmpProposalState;
      readonly files: ReadonlyArray<{ readonly path: string; readonly count: number }>;
      readonly replacements: number;
      readonly diff: string;
      readonly reason?: string;
    }
  | {
      readonly kind: "conflict_resolution";
      readonly target: string;
      readonly resolvedPath?: string;
      readonly summary: string;
    }
  | {
      readonly kind: "debug";
      readonly action: string;
      readonly state?: string;
      readonly stopReason?: string;
      readonly location?: {
        readonly name?: string;
        readonly path?: string;
        readonly line?: number;
      };
      readonly frames?: ReadonlyArray<OmpDebugFrame>;
      readonly scopes?: ReadonlyArray<{ readonly name: string; readonly reference: number }>;
      readonly variables?: ReadonlyArray<OmpDebugVariable>;
      readonly evaluation?: { readonly result: string; readonly type?: string };
    }
  | {
      readonly kind: "lsp";
      readonly action: string;
      readonly success: boolean;
      readonly server?: string;
      readonly target?: string;
      readonly text: string;
    }
  | {
      readonly kind: "eval";
      readonly language?: string;
      readonly cells: ReadonlyArray<OmpEvalCell>;
    }
  | {
      readonly kind: "generated_image";
      readonly provider?: string;
      readonly model?: string;
      readonly paths: ReadonlyArray<string>;
      readonly responseText?: string;
    }
  | {
      readonly kind: "speech";
      /** Absolute or workspace-relative path of the audio OMP wrote. */
      readonly path: string;
      readonly mimeType: "audio/mpeg" | "audio/wav";
      readonly bytes?: number;
      readonly voice?: string;
      readonly text: string;
    }
  | {
      readonly kind: "memory";
      readonly op: OmpMemoryOp;
      readonly query?: string;
      readonly items?: ReadonlyArray<{ readonly content: string; readonly scope?: string }>;
      readonly status?: string;
      readonly memoryId?: string;
      readonly text: string;
    };

const KINDS: Record<OmpToolCard["kind"], true> = {
  ask: true,
  proposed_edit: true,
  conflict_resolution: true,
  debug: true,
  lsp: true,
  eval: true,
  generated_image: true,
  speech: true,
  memory: true,
};

/** The OMP card of a `dynamic_tool` output, if it carries one. */
export function readOmpToolCard(output: unknown): OmpToolCard | null {
  if (!Predicate.isObject(output)) return null;
  const card = (output as Record<string, unknown>)[OMP_CARD_OUTPUT_KEY];
  if (!Predicate.isObject(card)) return null;
  const kind = (card as Record<string, unknown>)["kind"];
  return typeof kind === "string" && Object.hasOwn(KINDS, kind)
    ? (card as unknown as OmpToolCard)
    : null;
}
