/**
 * Accept and Reject on a staged `ast_edit` card (PRD FR-18b): OMP's `resolve_proposal` applies or
 * discards the preview a tool call staged, through the same handler as the agent's own
 * `xd://resolve`/`xd://reject` write, so a proposal is consumed once whoever gets there first.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { contractAtLeast } from "./hostTools.ts";
import {
  OmpRpcCommandError,
  type OmpRpcProcess,
  type OmpRpcRequestError,
  type OmpRpcRequestOptions,
} from "./rpcProcess.ts";

/** The first RPC contract with `resolve_proposal` (oh-my-pi#61). */
export const OMP_RESOLVE_PROPOSAL_CONTRACT = "1.10.0";

/** Whether a sidecar speaking `contractVersion` takes `resolve_proposal`. */
export const ompProposalsResolvable = (contractVersion: string): boolean =>
  contractAtLeast(contractVersion, OMP_RESOLVE_PROPOSAL_CONTRACT);

export type OmpProposalAction = "apply" | "discard";

/** The part of OMP's `ResolveProposalResult` Ompanel uses. */
const ResolveProposalAnswer = Schema.Struct({
  action: Schema.Literals(["apply", "discard"]),
  text: Schema.String,
  isError: Schema.Boolean,
});
export type OmpResolveProposalAnswer = typeof ResolveProposalAnswer.Type;

const decodeAnswer = Schema.decodeUnknownEffect(ResolveProposalAnswer);

/** OMP's refusal when the tool call has nothing staged any more (docs/rpc.md, contract 1.10.0). */
const NOT_PENDING = /^No staged proposal\b/;

/** OMP refused because the proposal is no longer staged: the agent or another click resolved it. */
export const isOmpProposalNotPending = (error: OmpRpcRequestError): boolean =>
  error._tag === "OmpRpcCommandError" && NOT_PENDING.test(error.detail);

type UntypedRequest = (
  command: string,
  params: unknown,
  options?: OmpRpcRequestOptions,
) => Effect.Effect<unknown, OmpRpcRequestError>;

/**
 * `resolve_proposal` for the proposal `toolCallId` staged. The vendored contract is the pinned
 * one, which predates the command, so it is sent untyped and its answer decoded here; callers
 * check {@link ompProposalsResolvable} first.
 */
export const requestResolveProposal = (
  process: Pick<OmpRpcProcess, "request">,
  params: { readonly toolCallId: string; readonly action: OmpProposalAction },
  options: OmpRpcRequestOptions,
): Effect.Effect<OmpResolveProposalAnswer, OmpRpcRequestError> =>
  (process.request as unknown as UntypedRequest)("resolve_proposal", params, options).pipe(
    Effect.flatMap((answer) =>
      decodeAnswer(answer).pipe(
        Effect.mapError(
          () =>
            new OmpRpcCommandError({
              command: "resolve_proposal",
              detail: "OMP answered resolve_proposal with an unknown shape.",
            }),
        ),
      ),
    ),
  );
