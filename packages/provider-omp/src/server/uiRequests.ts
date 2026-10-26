/**
 * OMP's extension UI dialogs as V2 runtime requests: tool approvals and `confirm` become approval
 * cards, other dialogs question cards. Pure state; the adapter sends replies and runs deadlines.
 */
import {
  RuntimeRequestId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type OrchestrationV2UserInputQuestion,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ProviderRequestKind,
  type ProviderSessionId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as DateTime from "effect/DateTime";

import type {
  AskAnswer,
  ExtensionUiRequest,
  ExtensionUiResponse,
} from "../../contract/src/wire.generated.ts";
import { OMP_PROVIDER, type OmpRequestPlacement } from "./mapper.ts";

type Event = ProviderAdapter.ProviderAdapterV2Event;
type Reply = ExtensionUiResponse;

/** The methods that open a dialog the user answers. */
const DIALOG_METHODS: Record<string, true> = {
  select: true,
  confirm: true,
  input: true,
  editor: true,
  ask: true,
};

export type OmpDialogRequest = Extract<
  ExtensionUiRequest,
  { readonly method: "select" | "confirm" | "input" | "editor" | "ask" }
>;

export const isOmpDialogRequest = (frame: { readonly type: string }): frame is OmpDialogRequest =>
  frame.type === "extension_ui_request" &&
  DIALOG_METHODS[String((frame as Record<string, unknown>)["method"])] === true;
export type OmpCancelRequest = Extract<ExtensionUiRequest, { readonly method: "cancel" }>;

export const isOmpCancelRequest = (frame: { readonly type: string }): frame is OmpCancelRequest =>
  frame.type === "extension_ui_request" &&
  (frame as Record<string, unknown>)["method"] === "cancel";

/** The choices of a tool approval, by the labels OMP's `select` fallback uses. */
interface ApprovalChoices {
  /** `Approve`, or `Approve Once` when the prompt also offers grants. */
  readonly once: string;
  /** `Approve SUBJECT for this session`, when offered. */
  readonly session: string | undefined;
  /** The narrowest grant OMP offers (the exact target before the folder around it). */
  readonly grant: { readonly label: string; readonly alwaysLabel: string } | undefined;
  readonly deny: string;
}

interface AskQuestionShape {
  readonly id: string;
  readonly labels: ReadonlyArray<string>;
}

type Dialog =
  | { readonly kind: "approval"; readonly choices: ApprovalChoices }
  | { readonly kind: "confirm" }
  | {
      readonly kind: "select";
      readonly questionId: string;
      readonly options: ReadonlyArray<string>;
    }
  | { readonly kind: "value"; readonly questionId: string }
  | {
      readonly kind: "ask";
      /** T question id → OMP question, in OMP's order. */
      readonly questions: ReadonlyArray<readonly [string, AskQuestionShape]>;
    };

interface Pending {
  readonly nativeId: string;
  readonly dialog: Dialog;
  runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
}

export interface OmpDialogOpened {
  readonly events: ReadonlyArray<Event>;
  /** OMP's deadline for the answer; `null` when it waits for good. */
  readonly timeoutMs: number | null;
}

export interface OmpDialogAnswer {
  readonly nativeId: string;
  readonly reply: Reply;
}

const APPROVAL_KIND_BY_TOOL: Record<string, ProviderRequestKind> = {
  bash: "command",
  eval: "command",
  ssh: "command",
  python: "command",
  exec: "command",
  edit: "file-change",
  write: "file-change",
  ast_edit: "file-change",
  apply_patch: "file-change",
  notebook: "file-change",
  read: "file-read",
};

const APPROVAL_TITLE = /^Allow tool: (\S+)/;
const SESSION_CHOICE = /^Approve .+ for this session$/;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const strings = (value: unknown): Array<string> =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];

/**
 * Reads OMP's approval `select`: `[grant labels…, grant always-labels…, once, session?, Deny]`
 * (`approvalChoiceLabels` in OMP's `tools/approval.ts`). Anything else is an ordinary select.
 */
function approvalChoices(title: string, options: ReadonlyArray<string>): ApprovalChoices | null {
  if (!APPROVAL_TITLE.test(title) || options.at(-1) !== "Deny") return null;
  const onceIndex = options.includes("Approve Once")
    ? options.indexOf("Approve Once")
    : options.indexOf("Approve");
  if (onceIndex < 0 || onceIndex % 2 !== 0) return null;
  const grants = onceIndex / 2;
  const session = options[onceIndex + 1];
  const last = grants - 1;
  return {
    once: options[onceIndex]!,
    session: session !== undefined && SESSION_CHOICE.test(session) ? session : undefined,
    grant:
      grants === 0 ? undefined : { label: options[last]!, alwaysLabel: options[grants + last]! },
    deny: "Deny",
  };
}

const approvalKind = (toolName: string): ProviderRequestKind =>
  Object.hasOwn(APPROVAL_KIND_BY_TOOL, toolName) ? APPROVAL_KIND_BY_TOOL[toolName]! : "permission";

function approvalOptions(choices: ApprovalChoices): Array<ProviderApprovalOption> {
  const sessionLabel = choices.session ?? choices.grant?.label;
  return [
    { decision: "accept", label: choices.once },
    ...(sessionLabel === undefined
      ? []
      : [{ decision: "acceptForSession" as const, label: sessionLabel }]),
    ...(choices.grant === undefined
      ? []
      : [
          {
            decision: "acceptAlways" as const,
            label: choices.grant.alwaysLabel,
            warning: "OMP remembers this approval in later sessions too.",
          },
        ]),
    { decision: "decline", label: choices.deny },
  ];
}

function approvalReply(
  choices: ApprovalChoices,
  decision: ProviderApprovalDecision | undefined,
): string | undefined {
  switch (decision) {
    case "accept":
      return choices.once;
    case "acceptForSession":
      return choices.session ?? choices.grant?.label ?? choices.once;
    case "acceptAlways":
      return choices.grant?.alwaysLabel ?? choices.session ?? choices.once;
    case "decline":
      return choices.deny;
    default:
      return undefined;
  }
}

/** A T question id for each OMP question: OMP's own when it is usable, else its position. */
function questionIds(ids: ReadonlyArray<string>): Array<string> {
  const seen = new Set<string>();
  return ids.map((id, index) => {
    const usable =
      id.trim() === id && id.length > 0 && !seen.has(id) ? id : `question-${index + 1}`;
    seen.add(usable);
    return usable;
  });
}

/** One `ask` answer from T's: an option's label, a list of them, or free text ("Other"). */
function askAnswer(question: AskQuestionShape, answer: unknown): AskAnswer {
  if (Array.isArray(answer)) {
    const selected = [
      ...new Set(answer.filter((label): label is string => question.labels.includes(label))),
    ];
    return { id: question.id, selectedOptions: selected };
  }
  if (typeof answer === "string") {
    if (question.labels.includes(answer)) return { id: question.id, selectedOptions: [answer] };
    const custom = answer.trim();
    return custom.length === 0
      ? { id: question.id, selectedOptions: [] }
      : { id: question.id, selectedOptions: [], customInput: custom };
  }
  return { id: question.id, selectedOptions: [] };
}

export class OmpUiRequests {
  readonly #providerSessionId: ProviderSessionId;
  readonly #pending = new Map<string, Pending>();
  readonly #byNativeId = new Map<string, string>();

  constructor(options: { readonly providerSessionId: ProviderSessionId }) {
    this.#providerSessionId = options.providerSessionId;
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  /**
   * Opens the card for one dialog request; `null` for a malformed one nobody can answer. A
   * request whose card is already open changes nothing.
   */
  open(
    frame: OmpDialogRequest,
    placement: OmpRequestPlacement,
    now: DateTime.Utc,
  ): OmpDialogOpened | null {
    const f = frame as unknown as Record<string, unknown>;
    const nativeId = text(f["id"]);
    if (nativeId === undefined) return null;
    if (this.#byNativeId.has(nativeId)) return { events: [], timeoutMs: null };
    const timeout = f["timeout"];
    const timeoutMs =
      frame.method !== "editor" && typeof timeout === "number" && Number.isFinite(timeout)
        ? Math.max(0, timeout)
        : null;

    const requestId = RuntimeRequestId.make(
      `runtime-request:provider:omp:session:${this.#providerSessionId}:native-request:${nativeId}`,
    );
    const shape = this.#shape(frame, f, nativeId);
    if (shape === null) return null;

    const nodeId = IdAllocator.derive.approvalNode({ requestId });
    const runtimeRequest: OrchestrationV2RuntimeRequest = {
      id: requestId,
      nodeId,
      providerTurnId: placement.providerTurnId,
      nativeRequestRef: { driver: OMP_PROVIDER, nativeId, strength: "strong" },
      kind: shape.kind,
      status: "pending",
      responseCapability: { type: "live", providerSessionId: this.#providerSessionId },
      createdAt: now,
      resolvedAt: null,
    };
    const node: OrchestrationV2ExecutionNode = {
      id: nodeId,
      threadId: placement.threadId,
      runId: placement.runId,
      parentNodeId: placement.rootNodeId,
      rootNodeId: placement.rootNodeId ?? nodeId,
      kind: shape.item.type === "approval_request" ? "approval_request" : "user_input_request",
      status: "waiting",
      countsForRun: false,
      providerThreadId: placement.providerThreadId,
      providerTurnId: placement.providerTurnId,
      nativeItemRef: runtimeRequest.nativeRequestRef,
      runtimeRequestId: requestId,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: null,
    };
    const turnItem = {
      id: IdAllocator.derive.approvalTurnItem({ requestId }),
      threadId: placement.threadId,
      runId: placement.runId,
      nodeId,
      providerThreadId: placement.providerThreadId,
      providerTurnId: placement.providerTurnId,
      nativeItemRef: runtimeRequest.nativeRequestRef,
      parentItemId: null,
      ordinal: placement.ordinal,
      status: "waiting",
      startedAt: now,
      completedAt: null,
      updatedAt: now,
      requestId,
      ...shape.item,
    } as OrchestrationV2TurnItem;

    this.#pending.set(requestId, {
      nativeId,
      dialog: shape.dialog,
      runtimeRequest,
      node,
      turnItem,
    });
    this.#byNativeId.set(nativeId, requestId);
    return {
      events: [
        {
          type: "runtime_request.updated",
          driver: OMP_PROVIDER,
          threadId: placement.threadId,
          runtimeRequest,
        },
        { type: "node.updated", driver: OMP_PROVIDER, node },
        { type: "turn_item.updated", driver: OMP_PROVIDER, turnItem },
      ],
      timeoutMs,
    };
  }

  /**
   * The reply to OMP for T's answer, without settling the request: the adapter settles it once
   * the reply is written. `null` when no such request is pending.
   */
  answer(
    input: ProviderAdapter.ProviderAdapterV2RuntimeRequestResponseInput,
  ): OmpDialogAnswer | null {
    const pending = this.#pending.get(input.requestId);
    if (pending === undefined) return null;
    const id = pending.nativeId;
    const cancelled: Reply = { type: "extension_ui_response", id, cancelled: true };
    const dialog = pending.dialog;
    const reply = ((): Reply => {
      // A cancelled dialog rejects: OMP reads it as "no", "deny", or no answer.
      if (input.decision === "cancel") return cancelled;
      switch (dialog.kind) {
        case "approval": {
          const value = approvalReply(dialog.choices, input.decision);
          return value === undefined ? cancelled : { type: "extension_ui_response", id, value };
        }
        case "confirm":
          return input.decision === "accept" ||
            input.decision === "acceptForSession" ||
            input.decision === "acceptAlways"
            ? { type: "extension_ui_response", id, confirmed: true }
            : input.decision === "decline"
              ? { type: "extension_ui_response", id, confirmed: false }
              : cancelled;
        case "select": {
          const value = input.answers?.[dialog.questionId];
          return typeof value === "string" && dialog.options.includes(value)
            ? { type: "extension_ui_response", id, value }
            : cancelled;
        }
        case "value": {
          // An empty string is an answer; only no answer at all cancels.
          const value = input.answers?.[dialog.questionId];
          return typeof value === "string"
            ? { type: "extension_ui_response", id, value }
            : cancelled;
        }
        case "ask": {
          const answers = input.answers;
          if (answers === undefined) return cancelled;
          return {
            type: "extension_ui_response",
            id,
            answers: dialog.questions.map(([questionId, question]) =>
              askAnswer(question, answers[questionId]),
            ),
          };
        }
      }
    })();
    return { nativeId: id, reply };
  }

  /** Marks an answered request resolved. */
  resolve(requestId: RuntimeRequestId, now: DateTime.Utc): ReadonlyArray<Event> {
    return this.#settle(this.#pending.get(requestId), "resolved", now);
  }

  /**
   * OMP's deadline passed with no answer: the reply OMP gets (`timedOut` makes an `ask` take its
   * recommended answers) and the expired card. `null` once the dialog is gone.
   */
  expire(
    nativeId: string,
    now: DateTime.Utc,
  ): { readonly reply: Reply; readonly events: ReadonlyArray<Event> } | null {
    const pending = this.#byNative(nativeId);
    if (pending === undefined) return null;
    return {
      reply: { type: "extension_ui_response", id: nativeId, cancelled: true, timedOut: true },
      events: this.#settle(pending, "expired", now),
    };
  }

  /** OMP closed dialog `targetId` itself (aborted, or its own timeout fired); no reply is due. */
  close(targetId: string, now: DateTime.Utc): ReadonlyArray<Event> {
    return this.#settle(this.#byNative(targetId), "cancelled", now);
  }

  /** The process is gone: every open dialog closes unanswered. */
  closeAll(now: DateTime.Utc): ReadonlyArray<Event> {
    return [...this.#pending.values()].flatMap((pending) =>
      this.#settle(pending, "cancelled", now),
    );
  }

  #byNative(nativeId: string): Pending | undefined {
    const requestId = this.#byNativeId.get(nativeId);
    return requestId === undefined ? undefined : this.#pending.get(requestId);
  }

  #settle(
    pending: Pending | undefined,
    status: "resolved" | "expired" | "cancelled",
    now: DateTime.Utc,
  ): ReadonlyArray<Event> {
    if (pending === undefined) return [];
    this.#pending.delete(pending.runtimeRequest.id);
    this.#byNativeId.delete(pending.nativeId);
    pending.runtimeRequest = { ...pending.runtimeRequest, status, resolvedAt: now };
    const done = status === "resolved" ? "completed" : "cancelled";
    return [
      {
        type: "runtime_request.updated",
        driver: OMP_PROVIDER,
        threadId: pending.node.threadId,
        runtimeRequest: pending.runtimeRequest,
      },
      {
        type: "node.updated",
        driver: OMP_PROVIDER,
        node: { ...pending.node, status: done, completedAt: now },
      },
      {
        type: "turn_item.updated",
        driver: OMP_PROVIDER,
        turnItem: { ...pending.turnItem, status: done, completedAt: now, updatedAt: now },
      },
    ];
  }

  #shape(
    frame: OmpDialogRequest,
    f: Record<string, unknown>,
    nativeId: string,
  ): {
    readonly kind: OrchestrationV2RuntimeRequest["kind"];
    readonly dialog: Dialog;
    readonly item: Record<string, unknown> & { readonly type: OrchestrationV2TurnItem["type"] };
  } | null {
    const title = text(f["title"]);
    switch (frame.method) {
      case "select": {
        const options = strings(f["options"]);
        const choices = title === undefined ? null : approvalChoices(title, options);
        if (choices !== null && title !== undefined) {
          const toolName = APPROVAL_TITLE.exec(title)?.[1] ?? "tool";
          const lines = title.split("\n");
          const reason = lines
            .find((line) => line.startsWith("Reason: "))
            ?.slice("Reason: ".length)
            .trim();
          const prompt = lines.filter((line) => !line.startsWith("Reason: ")).join("\n");
          return {
            kind: approvalKind(toolName),
            dialog: { kind: "approval", choices },
            item: {
              type: "approval_request",
              title: lines[0]!,
              requestKind: approvalKind(toolName),
              prompt,
              ...(reason === undefined || reason.length === 0 ? {} : { reason }),
              options: approvalOptions(choices),
            },
          };
        }
        if (options.length === 0) return null;
        const details = Array.isArray(f["optionDetails"]) ? f["optionDetails"] : [];
        const question: OrchestrationV2UserInputQuestion = {
          id: nativeId,
          header: title?.split("\n")[0] ?? "Choose one",
          question: title ?? "Choose one",
          options: options.map((option, index) => {
            const label = text(option) ?? "(empty)";
            return {
              label,
              description: text(asRecord(details[index])?.["description"]) ?? label,
              value: option,
            };
          }),
          multiSelect: false,
          allowCustomAnswer: false,
        };
        return {
          kind: "user_input",
          dialog: { kind: "select", questionId: nativeId, options },
          item: { type: "user_input_request", title: title ?? null, questions: [question] },
        };
      }
      case "confirm": {
        const message = text(f["message"]);
        return {
          kind: "permission",
          dialog: { kind: "confirm" },
          item: {
            type: "approval_request",
            title: title ?? null,
            requestKind: "permission",
            prompt: [title, message].filter((line) => line !== undefined).join("\n"),
            options: [
              { decision: "accept", label: "Yes" },
              { decision: "decline", label: "No" },
            ],
          },
        };
      }
      case "input":
      case "editor": {
        const isEditor = frame.method === "editor";
        const header = title?.split("\n")[0] ?? (isEditor ? "Edit text" : "Enter a value");
        const question: OrchestrationV2UserInputQuestion = {
          id: nativeId,
          header,
          question: (isEditor ? title : (text(f["placeholder"]) ?? title)) ?? header,
          options: isEditor
            ? []
            : [
                {
                  label: "Submit empty value",
                  description: "Answer with an empty value.",
                  value: "",
                },
              ],
          allowCustomAnswer: true,
          ...(isEditor
            ? { initialAnswer: typeof f["prefill"] === "string" ? f["prefill"] : "" }
            : {}),
        };
        return {
          kind: "user_input",
          dialog: { kind: "value", questionId: nativeId },
          item: { type: "user_input_request", title: title ?? null, questions: [question] },
        };
      }
      case "ask": {
        const raw = (Array.isArray(f["questions"]) ? f["questions"] : []).flatMap((entry) => {
          const q = asRecord(entry);
          const id = typeof q?.["id"] === "string" ? q["id"] : undefined;
          return q === undefined || id === undefined ? [] : [{ q, id }];
        });
        if (raw.length === 0) return null;
        const ids = questionIds(raw.map(({ id }) => id));
        const questions = raw.map(({ q, id }, index) => {
          const options = (Array.isArray(q["options"]) ? q["options"] : [])
            .map(asRecord)
            .filter(
              (option): option is Record<string, unknown> & { readonly label: string } =>
                typeof option?.["label"] === "string",
            );
          const labels = options.map((option) => option.label);
          const recommended = typeof q["recommended"] === "number" ? q["recommended"] : -1;
          const header = text(q["header"]) ?? `Question ${index + 1}`;
          const question: OrchestrationV2UserInputQuestion = {
            id: ids[index]!,
            header,
            question: text(q["question"]) ?? header,
            options: options.map((option, optionIndex) => {
              const label = text(option.label) ?? "(empty)";
              const preview = option["preview"];
              return {
                label: optionIndex === recommended ? `${label} (Recommended)` : label,
                description: text(option["description"]) ?? label,
                value: option.label,
                ...(typeof preview === "string" && preview.length > 0 ? { preview } : {}),
              };
            }),
            multiSelect: q["multi"] === true,
            // OMP's ask always takes free text besides the options ("Other").
            allowCustomAnswer: true,
          };
          return [ids[index]!, { id, labels }, question] as const;
        });
        return {
          kind: "user_input",
          dialog: {
            kind: "ask",
            questions: questions.map(([questionId, shape]) => [questionId, shape] as const),
          },
          item: {
            type: "user_input_request",
            title: questions.length === 1 ? questions[0]![2].header : "Questions",
            questions: questions.map(([, , question]) => question),
          },
        };
      }
    }
  }
}
