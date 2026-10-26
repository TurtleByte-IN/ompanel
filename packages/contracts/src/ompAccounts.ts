import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

const OmpLoginProviderId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const OmpSignInFlowId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
const OmpSignInPromptId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
/**
 * A pasted API key or answer to a secret prompt. In memory it stays `Redacted`, so logging or
 * tracing the payload prints `<redacted>`; on the wire it is the plain string.
 */
const OmpSecretText = Schema.Redacted(Schema.String.check(Schema.isMaxLength(16_384)));

/** Where a provider's auth comes from: `--api-key`, models config, OAuth, a stored key, an env var. */
export const OmpAuthSource = Schema.Literals(["runtime", "config", "oauth", "api_key", "env"]);
export type OmpAuthSource = typeof OmpAuthSource.Type;

/** One OMP login provider with its sign-in state. */
export const OmpAccountProvider = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  available: Schema.Boolean,
  authenticated: Schema.Boolean,
  /** Sign-in takes one pasted API key. */
  apiKey: Schema.Boolean,
  source: Schema.optionalKey(OmpAuthSource),
  /** The env var behind `source: "env"`. */
  envVar: Schema.optionalKey(Schema.String),
});
export type OmpAccountProvider = typeof OmpAccountProvider.Type;

/** A credential set in a project's `.omp/config.yml`, which is usually committed. */
export const OmpProjectSecret = Schema.Struct({
  key: Schema.String,
  /** The project config file holding it. */
  path: Schema.String,
});
export type OmpProjectSecret = typeof OmpProjectSecret.Type;

export const OmpAccountsListInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  /** Project whose `.omp/config.yml` is checked for credentials. */
  projectId: Schema.optionalKey(ProjectId),
});
export type OmpAccountsListInput = typeof OmpAccountsListInput.Type;

export const OmpAccountsList = Schema.Struct({
  providers: Schema.Array(OmpAccountProvider),
  /** The instance's OMP accepts API keys and masked prompts over RPC (contract 1.6.0+). */
  apiKeySignIn: Schema.Boolean,
  projectSecrets: Schema.Array(OmpProjectSecret),
});
export type OmpAccountsList = typeof OmpAccountsList.Type;

export const OmpSignInStartInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  providerId: OmpLoginProviderId,
  /** For an `apiKey` provider: the key, handed to OMP inside the RPC `login` command. */
  apiKey: Schema.optionalKey(OmpSecretText),
});
export type OmpSignInStartInput = typeof OmpSignInStartInput.Type;

export const OmpSignInInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type OmpSignInInput = typeof OmpSignInInput.Type;

/** A question the sign-in flow asks; `secret` answers are masked. */
export const OmpSignInPrompt = Schema.Struct({
  id: OmpSignInPromptId,
  title: Schema.String,
  placeholder: Schema.optionalKey(Schema.String),
  secret: Schema.Boolean,
});
export type OmpSignInPrompt = typeof OmpSignInPrompt.Type;

export const OmpSignInUrl = Schema.Struct({
  url: Schema.String,
  /** Short loopback redirect to `url`, safer to copy. */
  launchUrl: Schema.optionalKey(Schema.String),
  instructions: Schema.optionalKey(Schema.String),
});
export type OmpSignInUrl = typeof OmpSignInUrl.Type;

/** The instance's current (or last) OMP sign-in. One runs at a time per instance. */
export const OmpSignInState = Schema.Struct({
  phase: Schema.Literals(["idle", "running", "succeeded", "failed", "cancelled"]),
  flowId: Schema.NullOr(OmpSignInFlowId),
  providerId: Schema.NullOr(Schema.String),
  /** The page OMP asks the user to open. */
  openUrl: Schema.NullOr(OmpSignInUrl),
  /** The question waiting for an answer. */
  prompt: Schema.NullOr(OmpSignInPrompt),
  /** Latest progress note, or the failure. */
  message: Schema.NullOr(Schema.String),
});
export type OmpSignInState = typeof OmpSignInState.Type;

export const OmpSignInAnswerInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  flowId: OmpSignInFlowId,
  promptId: OmpSignInPromptId,
  /** Absent cancels the prompt. */
  value: Schema.optionalKey(OmpSecretText),
});
export type OmpSignInAnswerInput = typeof OmpSignInAnswerInput.Type;

export const OmpSignOutAccountsInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  providerId: OmpLoginProviderId,
});
export type OmpSignOutAccountsInput = typeof OmpSignOutAccountsInput.Type;

/** A stored credential sign-out can remove; `active` marks one OMP may be using. */
export const OmpSignOutAccount = Schema.Struct({
  credentialId: Schema.Int,
  provider: Schema.String,
  label: Schema.String,
  detail: Schema.String,
  type: Schema.Literals(["api_key", "oauth"]),
  active: Schema.Boolean,
});
export type OmpSignOutAccount = typeof OmpSignOutAccount.Type;

export const OmpSignOutAccounts = Schema.Struct({ accounts: Schema.Array(OmpSignOutAccount) });
export type OmpSignOutAccounts = typeof OmpSignOutAccounts.Type;

export const OmpSignOutInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  providerId: OmpLoginProviderId,
  credentialId: Schema.Int,
});
export type OmpSignOutInput = typeof OmpSignOutInput.Type;

export const OmpSignOutResult = Schema.Struct({
  /** Auth that still applies after the removal: another credential, an env var, config. */
  remainingSource: Schema.optionalKey(Schema.String),
});
export type OmpSignOutResult = typeof OmpSignOutResult.Type;

export const OmpAccountsOperationErrorReason = Schema.Literals([
  "instance_not_found",
  "unsupported",
  "project_not_found",
  /** The instance's OMP predates API-key sign-in over RPC. */
  "needs_newer_omp",
  /** No running sign-in has that flow or prompt. */
  "not_found",
  "busy",
  "omp_failed",
]);
export type OmpAccountsOperationErrorReason = typeof OmpAccountsOperationErrorReason.Type;

export class OmpAccountsOperationError extends Schema.TaggedError<OmpAccountsOperationError>()(
  "OmpAccountsOperationError",
  {
    reason: OmpAccountsOperationErrorReason,
    message: Schema.String,
  },
) {}
