import type { OmpSettingsField, OmpSettingsForm } from "@t3tools/contracts";

/** Model roles the pinned OMP knows (`MODEL_ROLES` in `config/model-roles.ts`), with its labels. */
export const OMP_MODEL_ROLES: ReadonlyArray<{ readonly role: string; readonly label: string }> = [
  { role: "default", label: "Default" },
  { role: "smol", label: "Fast" },
  { role: "slow", label: "Thinking" },
  { role: "vision", label: "Vision" },
  { role: "plan", label: "Architect" },
  { role: "commit", label: "Commit" },
  { role: "tiny", label: "Tiny" },
  { role: "memory", label: "Memory" },
  { role: "task", label: "Subtask" },
  { role: "advisor", label: "Advisor" },
  { role: "widget", label: "Job widgets" },
  { role: "image", label: "Image generation" },
  { role: "web", label: "Web search" },
  { role: "speech", label: "Speech" },
  { role: "dictation", label: "Dictation" },
  { role: "judge", label: "Judge" },
];

export type OmpSettingsPageId =
  | "models"
  | "routing"
  | "thinking"
  | "advisor"
  | "sampling"
  | "approvals";

export interface OmpSettingsPage {
  readonly id: OmpSettingsPageId;
  readonly title: string;
  readonly description: string;
  /** Exact keys, or prefixes ending in `.` for a whole group; shown in this order. */
  readonly keys: ReadonlyArray<string>;
}

export const OMP_SETTINGS_PAGES: Readonly<Record<OmpSettingsPageId, OmpSettingsPage>> = {
  models: {
    id: "models",
    title: "Models & Roles",
    description:
      "Which model OMP uses for each role, and which models and providers it may pick from.",
    keys: [
      "modelRoles",
      "modelRoleStorage",
      "modelTags",
      "modelProviderOrder",
      "cycleOrder",
      "enabledModels",
      "disabledProviders",
      "includeModelInPrompt",
    ],
  },
  routing: {
    id: "routing",
    title: "Routing",
    description:
      "Retries, fallback chains, round-robin credentials and path-scoped model lists. The model and provider lists are shown, not edited, here.",
    keys: [
      "retry.",
      "auth.accountPolicies",
      "task.agentAccountPools",
      "enabledModels",
      "enabledProviders",
      "disabledProviders",
      "providers.anthropic.serverSideFallback",
    ],
  },
  thinking: {
    id: "thinking",
    title: "Thinking",
    description: "Default reasoning effort, token budgets per level, and how thinking is shown.",
    keys: [
      "defaultThinkingLevel",
      "hideThinkingBlock",
      "thinkingBudgets.",
      "providers.autoThinkingMaxEffort",
    ],
  },
  advisor: {
    id: "advisor",
    title: "Advisor & Agents",
    description:
      "The advisor that reviews the agent's work, which subagents get one, and the files in OMP's agent directory that configure advisors and custom agents.",
    keys: ["advisor.", "task.agentAdvisor"],
  },
  sampling: {
    id: "sampling",
    title: "Sampling",
    description:
      "Advanced sampling and service options sent with every request. -1 leaves a sampling value to the provider.",
    keys: [
      "temperature",
      "topP",
      "topK",
      "minP",
      "presencePenalty",
      "repetitionPenalty",
      "textVerbosity",
      "personality",
      "tier.",
    ],
  },
  approvals: {
    id: "approvals",
    title: "Approvals & Tools",
    description:
      "Which tool calls OMP runs without asking, per-tool and bash approval rules, and how tools are offered to the model.",
    keys: [
      "tools.approvalMode",
      "tools.approval",
      "bash.patterns",
      "bashInterceptor.",
      "tools.intentTracing",
      "tools.xdev",
      "tools.xdevDocs",
      "tools.xdevInlineDevices",
    ],
  },
};

/** OMP's approval modes (`tools/approval.ts` `APPROVAL_MODES`), with OMP's labels. */
export const OMP_APPROVAL_MODES: ReadonlyArray<{
  readonly mode: "always-ask" | "always-ask-cached" | "write" | "yolo";
  readonly label: string;
  /** The Ompanel permission mode whose threads launch with this mode, if any. */
  readonly ompanelMode: string | undefined;
}> = [
  { mode: "always-ask", label: "Always ask", ompanelMode: "Supervised" },
  { mode: "always-ask-cached", label: "Ask and remember", ompanelMode: undefined },
  { mode: "write", label: "Write", ompanelMode: "Auto-accept edits" },
  { mode: "yolo", label: "Yolo", ompanelMode: "Full access" },
];

/** Values of a `tools.approval` rule and a `bash.patterns` rule (`ApprovalPolicy` in OMP). */
export const OMP_APPROVAL_POLICIES = ["allow", "prompt", "deny"] as const;
export type OmpApprovalPolicy = (typeof OMP_APPROVAL_POLICIES)[number];

/**
 * Arrays OMP lets hold path-scoped entries (`pathScoped` in `config/model-settings.ts`).
 * `config list` reports them already resolved for its working directory, so a write of the shown
 * value would drop every entry scoped to another path. The pages show them read-only; edit them in
 * OMP's config file.
 */
export const OMP_PATH_SCOPED_KEYS: ReadonlyArray<string> = [
  "enabledModels",
  "enabledProviders",
  "disabledProviders",
];

/**
 * The page's fields, in the page's key order; keys the running OMP lacks are skipped. Path-scoped
 * arrays come back read-only.
 */
export function ompSettingsPageForm(form: OmpSettingsForm, page: OmpSettingsPage): OmpSettingsForm {
  const fields: OmpSettingsField[] = [];
  for (const pattern of page.keys) {
    for (const field of form.fields) {
      const inPage = pattern.endsWith(".") ? field.key.startsWith(pattern) : field.key === pattern;
      if (!inPage) continue;
      fields.push(OMP_PATH_SCOPED_KEYS.includes(field.key) ? { ...field, readOnly: true } : field);
    }
  }
  return { fields };
}
