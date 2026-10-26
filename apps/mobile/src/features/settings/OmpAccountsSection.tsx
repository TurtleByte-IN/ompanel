// OMP Accounts on mobile: the native counterpart of the web Settings → OMP instance → Accounts
// (apps/web/src/components/settings/OmpAccountsSection.tsx), over the same server RPCs.
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OmpAccountProvider,
  OmpAccountsList,
  OmpSignInState,
  OmpSignOutAccount,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Redacted from "effect/Redacted";
import { useState } from "react";
import { Linking, TextInput, View } from "react-native";

import { Button } from "../../components/ui/Button";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

const SOURCE_LABEL: Record<NonNullable<OmpAccountProvider["source"]>, string> = {
  runtime: "Command-line key",
  config: "Models config",
  oauth: "Signed in",
  api_key: "API key",
  env: "Environment",
};

const INPUT_CLASS = "rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";

export interface OmpAccountsPanelProps {
  readonly title: string;
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

/** OMP's providers with sign-in and sign-out; presentational, driven by {@link OmpProviderAccounts}. */
export function OmpAccountsPanel(props: OmpAccountsPanelProps) {
  const [keyProvider, setKeyProvider] = useState<string | null>(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [answerDraft, setAnswerDraft] = useState({ promptId: "", value: "" });
  const { list, signIn } = props;
  const running = signIn?.phase === "running";
  const prompt = running ? signIn.prompt : null;
  const answer = prompt !== null && answerDraft.promptId === prompt.id ? answerDraft.value : "";
  // The phone opens the provider's own page: `launchUrl` redirects through the server's loopback,
  // which only the server's machine can reach.
  const signInUrl = running ? (signIn.openUrl?.url ?? null) : null;

  return (
    <View className="gap-3 border-b border-border-subtle p-4">
      <Text className="text-lg font-semibold text-foreground">{props.title}</Text>
      {list?.projectSecrets.map((secret) => (
        <Text
          key={secret.key}
          accessibilityRole="alert"
          className="rounded-lg border border-border px-3 py-2 text-sm text-warning-foreground"
        >
          {`${secret.key} is set in ${secret.path}, which is usually committed to version control. Move the key to an environment variable or OMP sign-in, and reset it in the project config.`}
        </Text>
      ))}
      {props.error ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {props.error}
        </Text>
      ) : null}

      {running ? (
        <View
          accessibilityLabel="OMP sign-in"
          className="gap-2 rounded-xl border border-border p-3"
        >
          <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
            {`Signing in to ${signIn.providerId}…${signIn.message ? ` ${signIn.message}` : ""}`}
          </Text>
          {signInUrl !== null ? (
            <>
              {signIn.openUrl?.instructions ? (
                <Text className="text-sm text-foreground-muted">{signIn.openUrl.instructions}</Text>
              ) : null}
              <Button
                label="Open sign-in page"
                icon="globe"
                tone="primary"
                onPress={() => props.onOpenUrl(signInUrl)}
              />
              <Text
                selectable
                numberOfLines={3}
                className="font-mono text-xs text-foreground-muted"
              >
                {signInUrl}
              </Text>
            </>
          ) : null}
          {prompt ? (
            <>
              <TextInput
                accessibilityLabel={prompt.title}
                className={INPUT_CLASS}
                placeholderTextColorClassName="accent-foreground-muted"
                placeholder={prompt.placeholder ?? prompt.title}
                secureTextEntry={prompt.secret}
                autoCapitalize="none"
                autoCorrect={false}
                autoComplete="off"
                editable={!props.disabled}
                maxLength={16_384}
                value={answer}
                onChangeText={(value) => setAnswerDraft({ promptId: prompt.id, value })}
              />
              <Button
                label="Submit"
                tone="primary"
                disabled={props.disabled}
                onPress={() => {
                  props.onAnswer(signIn.flowId!, prompt.id, answer);
                  setAnswerDraft({ promptId: "", value: "" });
                }}
              />
            </>
          ) : null}
          <Button label="Cancel sign-in" tone="text" onPress={props.onCancel} />
        </View>
      ) : signIn?.phase === "failed" && signIn.message ? (
        <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
          {signIn.message}
        </Text>
      ) : signIn?.phase === "succeeded" ? (
        <Text accessibilityLiveRegion="polite" className="text-sm text-foreground">
          {`Signed in to ${signIn.providerId}.`}
        </Text>
      ) : null}

      <Button
        label={list === null ? "Show providers" : "Refresh"}
        tone="secondary"
        onPress={props.onRefresh}
      />
      {list === null ? null : (
        <View accessibilityLabel="OMP providers" className="gap-1">
          {list.providers.map((provider) => {
            const source = sourceText(provider);
            const removable = provider.source === "oauth" || provider.source === "api_key";
            const keyOpen = keyProvider === provider.id;
            const accounts =
              props.signOut?.providerId === provider.id ? props.signOut.accounts : null;
            return (
              <View key={provider.id} className="gap-2 border-t border-border-subtle py-3">
                <View className="gap-0.5">
                  <Text className="text-base font-t3-medium text-foreground">{provider.name}</Text>
                  <Text className="text-sm text-foreground-muted">
                    {provider.authenticated ? (source ?? "Signed in") : "Not signed in"}
                  </Text>
                </View>
                <View className="flex-row flex-wrap gap-2">
                  {provider.apiKey && list.apiKeySignIn ? (
                    <Button
                      label={provider.authenticated ? "Replace key" : "Add API key"}
                      disabled={props.disabled || running || !provider.available}
                      onPress={() => {
                        setKeyProvider(keyOpen ? null : provider.id);
                        setKeyDraft("");
                      }}
                    />
                  ) : provider.apiKey ? null : (
                    <Button
                      label="Sign in"
                      disabled={props.disabled || running || !provider.available}
                      onPress={() => props.onSignIn(provider.id)}
                    />
                  )}
                  {removable ? (
                    <Button
                      label="Sign out"
                      tone="text"
                      disabled={props.disabled}
                      onPress={() => props.onListSignOut(provider.id)}
                    />
                  ) : null}
                </View>
                {keyOpen ? (
                  <View className="gap-2">
                    <TextInput
                      accessibilityLabel={`${provider.name} API key`}
                      className={INPUT_CLASS}
                      placeholderTextColorClassName="accent-foreground-muted"
                      placeholder="API key"
                      secureTextEntry
                      autoCapitalize="none"
                      autoCorrect={false}
                      autoComplete="off"
                      maxLength={16_384}
                      value={keyDraft}
                      onChangeText={setKeyDraft}
                    />
                    <Button
                      label="Save key"
                      tone="primary"
                      disabled={props.disabled || keyDraft.trim() === ""}
                      onPress={() => {
                        props.onSignIn(provider.id, keyDraft);
                        setKeyDraft("");
                        setKeyProvider(null);
                      }}
                    />
                  </View>
                ) : null}
                {accounts === null ? null : accounts.length === 0 ? (
                  <Text className="text-sm text-foreground-muted">
                    Nothing stored to remove; this provider's auth comes from its source.
                  </Text>
                ) : (
                  <View accessibilityLabel={`${provider.name} accounts`} className="gap-2">
                    {accounts.map((account) => (
                      <View key={account.credentialId} className="gap-1">
                        <Text className="text-sm text-foreground">{account.label}</Text>
                        <Text className="text-xs text-foreground-muted">{account.detail}</Text>
                        <Button
                          label="Remove"
                          accessibilityLabel={`Remove ${account.label}`}
                          tone="danger"
                          disabled={props.disabled}
                          onPress={() => props.onSignOut(provider.id, account.credentialId)}
                        />
                      </View>
                    ))}
                  </View>
                )}
              </View>
            );
          })}
        </View>
      )}
      <Text className="text-xs text-foreground-muted">
        Keys go to OMP's own credential store (or its auth broker); Ompanel keeps no copy.
      </Text>
    </View>
  );
}

/** Accounts for one OMP provider instance on one environment. */
export function OmpProviderAccounts(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly title: string;
}) {
  const { environmentId, instanceId } = props;
  const options = { reportFailure: false, reportDefect: false };
  const listAccounts = useAtomCommand(serverEnvironment.listOmpAccounts, options);
  const start = useAtomCommand(serverEnvironment.startOmpSignIn, options);
  const answer = useAtomCommand(serverEnvironment.answerOmpSignIn, options);
  const cancel = useAtomCommand(serverEnvironment.cancelOmpSignIn, options);
  const listSignOut = useAtomCommand(serverEnvironment.listOmpSignOutAccounts, options);
  const signOutCommand = useAtomCommand(serverEnvironment.ompSignOut, options);
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
    <OmpAccountsPanel
      title={props.title}
      list={list}
      signIn={signInQuery.data}
      signOut={signOut}
      error={error ?? signInQuery.error}
      disabled={pending}
      onRefresh={() => void refresh()}
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
        void Linking.openURL(url).catch(() =>
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
  );
}
