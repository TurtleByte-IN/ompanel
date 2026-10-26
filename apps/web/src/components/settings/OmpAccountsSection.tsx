import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type OmpAccountProvider,
  type OmpAccountsList,
  type OmpSignInState,
  type OmpSignOutAccount,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Redacted from "effect/Redacted";
import { useState } from "react";

import { useEnvironmentScope } from "~/state/session";
import { ensureLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";

const SOURCE_LABEL: Record<NonNullable<OmpAccountProvider["source"]>, string> = {
  runtime: "Command-line key",
  config: "Models config",
  oauth: "Signed in",
  api_key: "API key",
  env: "Environment",
};

export interface OmpAccountsPanelProps {
  readonly list: OmpAccountsList | null;
  readonly signIn: OmpSignInState | null;
  readonly signOut: {
    readonly providerId: string;
    readonly accounts: ReadonlyArray<OmpSignOutAccount>;
  } | null;
  readonly error: string | null;
  readonly disabled: boolean;
  /** `apiKey` is set for API-key providers; the panel keeps no copy after the call. */
  readonly onSignIn: (providerId: string, apiKey?: string) => void;
  readonly onAnswer: (flowId: string, promptId: string, value: string | undefined) => void;
  readonly onCancel: () => void;
  readonly onOpenUrl: (url: string) => void;
  readonly onListSignOut: (providerId: string) => void;
  readonly onSignOut: (providerId: string, credentialId: number) => void;
  /** Reloads the provider list (auth state lives in OMP's store, so it is read on demand). */
  readonly onRefresh: () => void;
}

function sourceText(provider: OmpAccountProvider) {
  if (provider.source === undefined) return null;
  return provider.source === "env" && provider.envVar !== undefined
    ? `Environment (${provider.envVar})`
    : SOURCE_LABEL[provider.source];
}

/** OMP's providers with sign-in and sign-out; presentational, driven by {@link OmpAccountsSection}. */
export function OmpAccountsPanel(props: OmpAccountsPanelProps) {
  const [keyProvider, setKeyProvider] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [answerDraft, setAnswerDraft] = useState({ promptId: "", value: "" });
  const { list, signIn } = props;
  const running = signIn?.phase === "running";
  const prompt = running ? signIn.prompt : null;
  const answer = prompt !== null && answerDraft.promptId === prompt.id ? answerDraft.value : "";

  return (
    <div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
      {list?.projectSecrets.map((secret) => (
        <p
          key={secret.key}
          role="alert"
          className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs"
        >
          {secret.key} is set in {secret.path}, which is usually committed to version control. Move
          the key to an environment variable or OMP sign-in, and reset it in the project config.
        </p>
      ))}
      {props.error ? (
        <p role="status" className="text-xs text-destructive">
          {props.error}
        </p>
      ) : null}

      {running ? (
        <div
          role="region"
          aria-label="OMP sign-in"
          className="flex flex-col gap-2 rounded-md border p-3"
        >
          <p className="text-sm">
            Signing in to {signIn.providerId}…{signIn.message ? ` ${signIn.message}` : ""}
          </p>
          {signIn.openUrl ? (
            <div className="flex flex-wrap items-center gap-2">
              {signIn.openUrl.instructions ? (
                <span className="text-xs text-muted-foreground">{signIn.openUrl.instructions}</span>
              ) : null}
              <Button
                size="xs"
                onClick={() => props.onOpenUrl(signIn.openUrl!.launchUrl ?? signIn.openUrl!.url)}
              >
                Open sign-in page
              </Button>
              <code className="max-w-full truncate text-xs">
                {signIn.openUrl.launchUrl ?? signIn.openUrl.url}
              </code>
            </div>
          ) : null}
          {prompt ? (
            <form
              className="flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                props.onAnswer(signIn.flowId!, prompt.id, answer);
                setAnswerDraft({ promptId: "", value: "" });
              }}
            >
              <Input
                aria-label={prompt.title}
                placeholder={prompt.placeholder ?? prompt.title}
                type={prompt.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                value={answer}
                onChange={(event) =>
                  setAnswerDraft({ promptId: prompt.id, value: event.target.value })
                }
                className="w-full max-w-72"
              />
              <Button size="xs" type="submit" disabled={props.disabled}>
                Submit
              </Button>
            </form>
          ) : null}
          <div>
            <Button size="xs" variant="outline" onClick={props.onCancel}>
              Cancel sign-in
            </Button>
          </div>
        </div>
      ) : signIn?.phase === "failed" && signIn.message ? (
        <p role="status" className="text-xs text-destructive">
          {signIn.message}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        {signIn?.phase === "succeeded" ? (
          <span role="status" className="text-xs">
            Signed in to {signIn.providerId}.
          </span>
        ) : null}
        <Button size="xs" variant="outline" className="ms-auto" onClick={props.onRefresh}>
          {list === null ? "Show providers" : "Refresh"}
        </Button>
      </div>
      {list === null ? null : (
        <ul className="flex flex-col divide-y" aria-label="OMP providers">
          {list.providers.map((provider) => {
            const source = sourceText(provider);
            const removable = provider.source === "oauth" || provider.source === "api_key";
            const keyOpen = keyProvider === provider.id;
            const accounts =
              props.signOut?.providerId === provider.id ? props.signOut.accounts : null;
            return (
              <li
                key={provider.id}
                data-provider={provider.id}
                className="flex flex-col gap-2 py-2"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium">{provider.name}</span>
                  {provider.authenticated ? (
                    <Badge variant="secondary">{source ?? "Signed in"}</Badge>
                  ) : (
                    <Badge variant="outline">Not signed in</Badge>
                  )}
                  <span className="ms-auto flex gap-1.5">
                    {provider.apiKey && list.apiKeySignIn ? (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={props.disabled || running || !provider.available}
                        onClick={() => {
                          setKeyProvider(keyOpen ? null : provider.id);
                          setKeyDraft("");
                        }}
                      >
                        {provider.authenticated ? "Replace key" : "Add API key"}
                      </Button>
                    ) : provider.apiKey ? null : (
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={props.disabled || running || !provider.available}
                        onClick={() => props.onSignIn(provider.id)}
                      >
                        Sign in
                      </Button>
                    )}
                    {removable ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={props.disabled}
                        onClick={() => props.onListSignOut(provider.id)}
                      >
                        Sign out
                      </Button>
                    ) : null}
                  </span>
                </div>
                {keyOpen ? (
                  <form
                    className="flex flex-wrap items-center gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (keyDraft.trim() === "") return;
                      props.onSignIn(provider.id, keyDraft);
                      setKeyDraft("");
                      setKeyProvider(null);
                    }}
                  >
                    <Input
                      aria-label={`${provider.name} API key`}
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={keyDraft}
                      onChange={(event) => setKeyDraft(event.target.value)}
                      className="w-full max-w-72"
                    />
                    <Button size="xs" type="submit" disabled={props.disabled}>
                      Save key
                    </Button>
                  </form>
                ) : null}
                {accounts !== null ? (
                  accounts.length === 0 ? (
                    <p className="text-xs text-muted-foreground">
                      Nothing stored to remove; this provider's auth comes from its source.
                    </p>
                  ) : (
                    <ul className="flex flex-col gap-1" aria-label={`${provider.name} accounts`}>
                      {accounts.map((account) => (
                        <li
                          key={account.credentialId}
                          className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
                        >
                          <span className="min-w-0 break-all">{account.label}</span>
                          <span className="text-muted-foreground">{account.detail}</span>
                          <Button
                            size="xs"
                            variant="destructive-outline"
                            disabled={props.disabled}
                            onClick={() => props.onSignOut(provider.id, account.credentialId)}
                          >
                            Remove
                          </Button>
                        </li>
                      ))}
                    </ul>
                  )
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        Keys go to OMP's own credential store (or its auth broker when `auth.broker.url` is set);
        Ompanel keeps no copy. The broker token is read from `OMP_AUTH_BROKER_TOKEN` or OMP's token
        file and is never entered here.
      </p>
    </div>
  );
}

/** Settings → OMP instance → Accounts. */
export function OmpAccountsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly readOnly: boolean;
}) {
  const { environmentId, instanceId } = props;
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const commands = { reportFailure: false, reportDefect: false };
  const listAccounts = useAtomCommand(serverEnvironment.listOmpAccounts, commands);
  const start = useAtomCommand(serverEnvironment.startOmpSignIn, commands);
  const answer = useAtomCommand(serverEnvironment.answerOmpSignIn, commands);
  const cancel = useAtomCommand(serverEnvironment.cancelOmpSignIn, commands);
  const listSignOut = useAtomCommand(serverEnvironment.listOmpSignOutAccounts, commands);
  const signOutCommand = useAtomCommand(serverEnvironment.ompSignOut, commands);
  const signInQuery = useEnvironmentQuery(
    serverEnvironment.ompSignInState({ environmentId, input: { instanceId } }),
  );
  const [list, setList] = useState<OmpAccountsList | null>(null);
  const [signOut, setSignOut] = useState<OmpAccountsPanelProps["signOut"]>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function run<A>(command: () => Promise<AtomCommandResult<A, unknown>>) {
    setPending(true);
    setError(null);
    let value: A | undefined;
    try {
      const result = await command();
      if (result._tag === "Success") value = result.value;
      else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "The OMP request failed.");
      }
    } catch {
      setError("The OMP request failed.");
    }
    setPending(false);
    return value;
  }

  const refresh = () =>
    run(() => listAccounts({ environmentId, input: { instanceId } })).then((next) => {
      if (next !== undefined) setList(next);
    });

  return (
    <SettingsSection title="Accounts">
      <OmpAccountsPanel
        onRefresh={() => void refresh()}
        list={list}
        signIn={signInQuery.data ?? null}
        signOut={signOut}
        error={error}
        disabled={props.readOnly || !canManage || pending}
        onSignIn={(providerId, apiKey) =>
          void run(() =>
            start({
              environmentId,
              input: {
                instanceId,
                providerId,
                ...(apiKey === undefined ? {} : { apiKey: Redacted.make(apiKey) }),
              },
            }),
          )
        }
        onAnswer={(flowId, promptId, value) =>
          void run(() =>
            answer({
              environmentId,
              input: {
                instanceId,
                flowId,
                promptId,
                ...(value === undefined ? {} : { value: Redacted.make(value) }),
              },
            }),
          )
        }
        onCancel={() => void run(() => cancel({ environmentId, input: { instanceId } }))}
        onOpenUrl={(url) => {
          void ensureLocalApi()
            .shell.openExternal(url)
            .catch(() =>
              setError("Could not open the sign-in page. Copy the link into your browser."),
            );
        }}
        onListSignOut={(providerId) =>
          void run(() => listSignOut({ environmentId, input: { instanceId, providerId } })).then(
            (result) => {
              if (result !== undefined) setSignOut({ providerId, accounts: result.accounts });
            },
          )
        }
        onSignOut={(providerId, credentialId) =>
          void run(() =>
            signOutCommand({ environmentId, input: { instanceId, providerId, credentialId } }),
          ).then((result) => {
            if (result === undefined) return;
            setSignOut(null);
            if (result.remainingSource !== undefined) {
              setError(
                `Signed out. ${providerId} still authenticates through ${result.remainingSource}.`,
              );
            }
            void refresh();
          })
        }
      />
    </SettingsSection>
  );
}
