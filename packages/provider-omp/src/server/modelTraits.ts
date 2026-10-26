/**
 * OMP's composer traits: the model catalog from `get_available_models`, the thinking selector
 * (including OMP's `inherit`), the boolean traits (fast mode, advisor, prewalk, computer use,
 * vibe mode) and the role chip. docs/omp/models.md has the mapping.
 */
import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionChoice,
  ProviderOptionDescriptor,
  ServerProviderModel,
} from "@t3tools/contracts";
import {
  createModelCapabilities,
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import * as Schema from "effect/Schema";

import type { ThinkingLevel } from "../../contract/src/wire.generated.ts";
import { OMP_LOCK } from "../ompLock.ts";
import { ompVibeModeAvailable } from "./vibe.ts";

/** The model slug that leaves the model to OMP's config (`modelRoles.default`). */
export const OMP_DEFAULT_MODEL_SLUG = "default";

const OMP_TRAIT_IDS = {
  thinking: "thinking",
  role: "role",
  fastMode: "fastMode",
  advisor: "advisor",
  prewalk: "prewalk",
  computer: "computer",
  vibe: "vibe",
} as const;

/** The client-relevant subset of the wire `ModelInfo` the catalog needs. */
export const OmpCatalogModel = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  provider: Schema.String,
  reasoning: Schema.Boolean,
  thinking: Schema.optionalKey(Schema.Struct({ efforts: Schema.Array(Schema.String) })),
});
export type OmpCatalogModel = typeof OmpCatalogModel.Type;

const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;
/** Efforts a reasoning model without a `thinking` descriptor accepts (`pi-ai` defaults). */
const BASE_EFFORTS = ["minimal", "low", "medium", "high"] as const;
const THINKING_LEVELS: ReadonlyArray<ThinkingLevel> = ["inherit", "off", ...EFFORTS];

const THINKING_LABELS: Readonly<Record<ThinkingLevel, string>> = {
  inherit: "Inherit",
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

const isOmpThinkingLevel = (value: unknown): value is ThinkingLevel =>
  typeof value === "string" && (THINKING_LEVELS as ReadonlyArray<string>).includes(value);

/**
 * Roles a thread can run as (`CHAT_MODEL_ROLE_IDS` in oh-my-pi, minus the internal `memory` and
 * `widget`). A role other than `default` is written to the thread's overlay as
 * `modelRoles.default: "@<role>"`.
 */
const OMP_THREAD_ROLES = [
  "default",
  "smol",
  "slow",
  "plan",
  "vision",
  "task",
  "advisor",
  "commit",
  "tiny",
] as const;
export type OmpThreadRole = (typeof OMP_THREAD_ROLES)[number];

const ROLE_LABELS: Readonly<Record<OmpThreadRole, string>> = {
  default: "Default",
  smol: "Smol",
  slow: "Slow",
  plan: "Plan",
  vision: "Vision",
  task: "Task",
  advisor: "Advisor",
  commit: "Commit",
  tiny: "Tiny",
};

const thinkingDescriptor = (
  efforts: ReadonlyArray<string>,
): ProviderOptionDescriptor | undefined => {
  const levels = EFFORTS.filter((effort) => efforts.includes(effort));
  if (levels.length === 0) return undefined;
  return {
    id: OMP_TRAIT_IDS.thinking,
    label: "Thinking",
    type: "select",
    options: (["inherit", "off", ...levels] as const).map((level): ProviderOptionChoice => ({
      id: level,
      label: THINKING_LABELS[level],
      ...(level === "inherit"
        ? { description: "The level OMP's config sets", isDefault: true }
        : {}),
    })),
  };
};

const roleDescriptor: ProviderOptionDescriptor = {
  id: OMP_TRAIT_IDS.role,
  label: "Role",
  description: "The OMP model role this thread runs as; changing it restarts the session",
  type: "select",
  options: OMP_THREAD_ROLES.map((role): ProviderOptionChoice => ({
    id: role,
    label: ROLE_LABELS[role],
    ...(role === "default" ? { isDefault: true } : {}),
  })),
};

/** The boolean traits a sidecar speaking `contractVersion` takes. */
export function ompBooleanTraitDescriptors(
  contractVersion: string,
): ReadonlyArray<ProviderOptionDescriptor> {
  return [
    { id: OMP_TRAIT_IDS.fastMode, label: "Fast Mode", type: "boolean" },
    {
      id: OMP_TRAIT_IDS.advisor,
      label: "Advisor",
      description: "Runs the model assigned to the advisor role alongside the session",
      type: "boolean",
    },
    {
      id: OMP_TRAIT_IDS.prewalk,
      label: "Prewalk",
      description: "Hands the next turn off to the prewalk target model",
      type: "boolean",
    },
    {
      id: OMP_TRAIT_IDS.computer,
      label: "Computer Use",
      description: "The host-desktop eval prelude",
      type: "boolean",
    },
    ...(ompVibeModeAvailable(contractVersion)
      ? [
          {
            id: OMP_TRAIT_IDS.vibe,
            label: "Vibe Mode",
            description:
              "The agent directs fast and good worker sessions and only reads files itself; turning it off ends the workers",
            type: "boolean" as const,
          },
        ]
      : []),
  ];
}

const booleanDescriptors = ompBooleanTraitDescriptors(OMP_LOCK.contract.version);

const capabilities = (
  thinking: ProviderOptionDescriptor | undefined,
  role: boolean,
): ModelCapabilities =>
  createModelCapabilities({
    optionDescriptors: [
      ...(thinking === undefined ? [] : [thinking]),
      ...(role ? [roleDescriptor] : []),
      ...booleanDescriptors,
    ],
  });

/** OMP's default model: every level (OMP clamps to the resolved model) and the role chip. */
export const OMP_DEFAULT_MODEL_CAPABILITIES = capabilities(thinkingDescriptor(EFFORTS), true);

/**
 * A custom model OMP did not list: Ompanel cannot know its efforts, so every level is offered and
 * OMP clamps the pick to what the model supports (`set_thinking_level`).
 */
export const OMP_CUSTOM_MODEL_CAPABILITIES = capabilities(thinkingDescriptor(EFFORTS), false);

/** `provider/modelId`; model ids may themselves contain `/`, provider ids never do. */
export const parseOmpModelSlug = (
  slug: string,
): { readonly provider: string; readonly modelId: string } | undefined => {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return undefined;
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
};

/** The composer's models: OMP's default, then each listed model once. */
export const ompCatalogModels = (
  models: ReadonlyArray<OmpCatalogModel>,
): ReadonlyArray<ServerProviderModel> => {
  const seen = new Set<string>([OMP_DEFAULT_MODEL_SLUG]);
  const entries: Array<ServerProviderModel> = [];
  for (const model of models) {
    const slug = `${model.provider}/${model.id}`;
    if (seen.has(slug)) continue;
    seen.add(slug);
    entries.push({
      slug,
      name: model.name || model.id,
      subProvider: model.provider,
      isCustom: false,
      capabilities: capabilities(
        model.reasoning ? thinkingDescriptor(model.thinking?.efforts ?? BASE_EFFORTS) : undefined,
        false,
      ),
    });
  }
  return entries;
};

/** What a selection asks OMP for; an absent field leaves OMP's own value alone. */
export interface OmpTraitSelection {
  readonly model: string;
  readonly thinking?: ThinkingLevel;
  readonly role: OmpThreadRole;
  readonly fastMode?: boolean;
  readonly advisor?: boolean;
  readonly prewalk?: boolean;
  readonly computer?: boolean;
  readonly vibe?: boolean;
}

const isRole = (value: unknown): value is OmpThreadRole =>
  typeof value === "string" && (OMP_THREAD_ROLES as ReadonlyArray<string>).includes(value);

export const readOmpTraitSelection = (selection: ModelSelection): OmpTraitSelection => {
  const thinking = getModelSelectionStringOptionValue(selection, OMP_TRAIT_IDS.thinking);
  const role = getModelSelectionStringOptionValue(selection, OMP_TRAIT_IDS.role);
  const flag = (id: string) => getModelSelectionBooleanOptionValue(selection, id);
  const fastMode = flag(OMP_TRAIT_IDS.fastMode);
  const advisor = flag(OMP_TRAIT_IDS.advisor);
  const prewalk = flag(OMP_TRAIT_IDS.prewalk);
  const computer = flag(OMP_TRAIT_IDS.computer);
  const vibe = flag(OMP_TRAIT_IDS.vibe);
  return {
    model: selection.model,
    // The role picks the model only while the thread leaves the model to OMP.
    role: selection.model === OMP_DEFAULT_MODEL_SLUG && isRole(role) ? role : "default",
    ...(isOmpThinkingLevel(thinking) ? { thinking } : {}),
    ...(fastMode === undefined ? {} : { fastMode }),
    ...(advisor === undefined ? {} : { advisor }),
    ...(prewalk === undefined ? {} : { prewalk }),
    ...(computer === undefined ? {} : { computer }),
    ...(vibe === undefined ? {} : { vibe }),
  };
};

/** The overlay value of `modelRoles.default` for `role`; `undefined` removes Ompanel's entry. */
export const ompRoleOverlayValue = (role: OmpThreadRole): string | undefined =>
  role === "default" ? undefined : `@${role}`;
