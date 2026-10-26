/**
 * OMP provider accounts for the server (PRD §7 Auth, FR-13): the login providers with their auth
 * state, one RPC `login` at a time per instance with its `open_url`, `notify` and `input` requests
 * relayed to the client, and sign-out through `get_logout_accounts`/`logout`.
 *
 * Secrets rule: an API key or a secret answer arrives `Redacted` and is unwrapped only where it is
 * written into the login process's stdin (`control.login`). Nothing here stores, logs or traces it,
 * and no omp is ever started with it in argv.
 */
import {
  OmpAccountsOperationError,
  type OmpAccountsList,
  type OmpSettingsForm,
  type OmpSignInPrompt,
  type OmpSignInState,
} from "@t3tools/contracts";
import type { ProviderOmpAccountsController } from "@t3tools/provider-core/server/driver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import type * as Scope from "effect/Scope";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { ExtensionUiRequest, ExtensionUiResponse } from "../../contract/src/wire.generated.ts";
import {
  OMP_LOGIN_INPUT_CONTRACT,
  ompContractAtLeast,
  type OmpControlError,
  type OmpControlService,
  type OmpControlTarget,
} from "./control.ts";
import type { OmpSidecarError } from "./sidecar.ts";

export const IDLE_SIGN_IN: OmpSignInState = {
  phase: "idle",
  flowId: null,
  providerId: null,
  openUrl: null,
  prompt: null,
  message: null,
};

const ompFailed = (error: OmpControlError | OmpSidecarError) =>
  new OmpAccountsOperationError({
    reason:
      error._tag === "OmpControlError" && error.reason === "unsupported"
        ? "needs_newer_omp"
        : "omp_failed",
    message: error.message,
  });

/**
 * Credentials the project layer supplies. OMP redacts every configured credential, so `redacted`
 * plus `source: "project"` means the key sits in `<project>/.omp/config.yml`.
 */
export const ompProjectSecrets = (form: OmpSettingsForm, cwd: string) =>
  form.fields
    .filter((field) => field.credential && field.redacted && field.source === "project")
    .map((field) => ({ key: field.key, path: `${cwd.replace(/\/+$/, "")}/.omp/config.yml` }));

export const makeOmpAccountsController = Effect.fn("makeOmpAccountsController")(function* (input: {
  readonly control: OmpControlService;
  /** This instance's omp, resolved and verified for this call, run in `cwd`. */
  readonly target: (cwd: string) => Effect.Effect<OmpControlTarget, OmpSidecarError>;
  /** Every setting for `cwd`, credentials redacted (the settings engine's read). */
  readonly readSettings: (
    target: OmpControlTarget,
  ) => Effect.Effect<OmpSettingsForm, OmpControlError>;
  /** A directory with no project config: sign-in and sign-out act on OMP's global store. */
  readonly globalCwd: string;
}): Effect.fn.Return<ProviderOmpAccountsController, never, Scope.Scope> {
  const { control } = input;
  const scope = yield* Effect.scope;
  const state = yield* SubscriptionRef.make<OmpSignInState>(IDLE_SIGN_IN);
  /** Prompts of the running flow waiting for an answer, by prompt id. */
  const prompts = new Map<string, Deferred.Deferred<Redacted.Redacted<string> | undefined>>();
  let running: Fiber.Fiber<void> | undefined;
  let nextFlow = 0;

  const globalTarget = input.target(input.globalCwd);

  /** Updates the state only while `flowId` is still the current flow. */
  const updateFlow = (flowId: string, change: (current: OmpSignInState) => OmpSignInState) =>
    SubscriptionRef.update(state, (current) =>
      current.flowId === flowId ? change(current) : current,
    );

  const answerRequest =
    (flowId: string) =>
    (request: ExtensionUiRequest): Effect.Effect<ExtensionUiResponse | undefined> => {
      switch (request.method) {
        case "open_url":
          return updateFlow(flowId, (current) => ({
            ...current,
            openUrl: {
              url: request.url,
              ...(request.launchUrl === undefined ? {} : { launchUrl: request.launchUrl }),
              ...(request.instructions === undefined ? {} : { instructions: request.instructions }),
            },
          })).pipe(Effect.as(undefined));
        case "notify":
          return updateFlow(flowId, (current) => ({ ...current, message: request.message })).pipe(
            Effect.as(undefined),
          );
        case "input":
          return Effect.gen(function* () {
            const promptId = `${flowId}:${request.id}`;
            const answered = yield* Deferred.make<Redacted.Redacted<string> | undefined>();
            prompts.set(promptId, answered);
            // `secret` is a contract 1.6.0 field; older servers never send secret prompts.
            const secret = "secret" in request && request.secret === true;
            const prompt: OmpSignInPrompt = {
              id: promptId,
              title: request.title,
              ...(request.placeholder === undefined ? {} : { placeholder: request.placeholder }),
              secret,
            };
            yield* updateFlow(flowId, (current) => ({ ...current, prompt }));
            const value = yield* Deferred.await(answered).pipe(
              Effect.ensuring(
                Effect.sync(() => prompts.delete(promptId)).pipe(
                  Effect.andThen(
                    updateFlow(flowId, (current) =>
                      current.prompt?.id === promptId ? { ...current, prompt: null } : current,
                    ),
                  ),
                ),
              ),
            );
            return value === undefined
              ? { type: "extension_ui_response", id: request.id, cancelled: true }
              : { type: "extension_ui_response", id: request.id, value: Redacted.value(value) };
          });
        case "select":
        case "confirm":
        case "editor":
        case "ask":
          // Login flows only ask for URLs and text; refuse anything else instead of hanging.
          return Effect.succeed({
            type: "extension_ui_response",
            id: request.id,
            cancelled: true,
          } satisfies ExtensionUiResponse);
        default:
          return Effect.succeed(undefined);
      }
    };

  const list: ProviderOmpAccountsController["list"] = ({ cwd }) =>
    Effect.gen(function* () {
      const listed = yield* globalTarget.pipe(Effect.flatMap(control.loginProviders));
      const projectSecrets =
        cwd === undefined
          ? []
          : ompProjectSecrets(
              yield* input.target(cwd).pipe(Effect.flatMap(input.readSettings)),
              cwd,
            );
      return {
        providers: listed.providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          available: provider.available,
          authenticated: provider.authenticated,
          apiKey: provider.apiKey === true,
          ...(provider.source === undefined ? {} : { source: provider.source }),
          ...(provider.envVar === undefined ? {} : { envVar: provider.envVar }),
        })),
        apiKeySignIn: ompContractAtLeast(listed.contractVersion, OMP_LOGIN_INPUT_CONTRACT),
        projectSecrets,
      } satisfies OmpAccountsList;
    }).pipe(Effect.mapError(ompFailed));

  const start: ProviderOmpAccountsController["start"] = ({ providerId, apiKey }) =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      if (current.phase === "running") {
        return yield* new OmpAccountsOperationError({
          reason: "busy",
          message: `Signing in to ${current.providerId ?? "a provider"} is still running.`,
        });
      }
      const flowId = `omp-sign-in-${++nextFlow}`;
      const started: OmpSignInState = {
        phase: "running",
        flowId,
        providerId,
        openUrl: null,
        prompt: null,
        message: null,
      };
      yield* SubscriptionRef.set(state, started);
      const login = globalTarget.pipe(
        Effect.flatMap((target) =>
          control.login(target, providerId, answerRequest(flowId), {
            ...(apiKey === undefined ? {} : { input: apiKey }),
            secretInput: true,
          }),
        ),
        Effect.matchEffect({
          onSuccess: () =>
            updateFlow(flowId, (latest) => ({
              ...latest,
              phase: "succeeded",
              prompt: null,
              message: null,
            })),
          onFailure: (error) =>
            updateFlow(flowId, (latest) => ({
              ...latest,
              phase: "failed",
              prompt: null,
              message: error.message,
            })),
        }),
      );
      running = yield* Effect.forkIn(login, scope);
      return started;
    });

  const answer: ProviderOmpAccountsController["answer"] = ({ flowId, promptId, value }) =>
    Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(state);
      const pending = prompts.get(promptId);
      if (current.flowId !== flowId || current.phase !== "running" || pending === undefined) {
        return yield* new OmpAccountsOperationError({
          reason: "not_found",
          message: "That sign-in prompt is no longer waiting for an answer.",
        });
      }
      yield* Deferred.succeed(pending, value);
      return yield* SubscriptionRef.get(state);
    });

  const cancel: ProviderOmpAccountsController["cancel"] = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    if (current.phase !== "running" || current.flowId === null) return current;
    const fiber = running;
    running = undefined;
    // Interrupting the login closes its scope, which stops the omp process group.
    if (fiber !== undefined) yield* Fiber.interrupt(fiber);
    yield* updateFlow(current.flowId, (latest) =>
      latest.phase === "running"
        ? { ...latest, phase: "cancelled", prompt: null, message: null }
        : latest,
    );
    return yield* SubscriptionRef.get(state);
  });

  return {
    list,
    start,
    answer,
    cancel,
    subscribe: SubscriptionRef.changes(state),
    signOutAccounts: ({ providerId }) =>
      globalTarget.pipe(
        Effect.flatMap((target) => control.logoutAccounts(target, providerId)),
        Effect.map((accounts) => ({ accounts })),
        Effect.mapError(ompFailed),
      ),
    signOut: ({ providerId, credentialId }) =>
      globalTarget.pipe(
        Effect.flatMap((target) => control.logout(target, providerId, credentialId)),
        Effect.map((result) =>
          result.remainingSource === undefined ? {} : { remainingSource: result.remainingSource },
        ),
        Effect.mapError(ompFailed),
      ),
  };
});
