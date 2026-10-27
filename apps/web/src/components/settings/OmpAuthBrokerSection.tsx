import type {
  EnvironmentId,
  OmpSettingsField,
  OmpSettingsForm,
  OmpSettingsWriteResult,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isOmpSecretReference } from "@t3tools/provider-omp/configForm";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";

const URL_KEY = "auth.broker.url";
const TOKEN_KEY = "auth.broker.token";

const SOURCE_LABEL: Record<OmpSettingsField["source"], string> = {
  default: "Not set",
  global: "Global",
  project: "Project",
  overlay: "Overlay",
  runtime: "Runtime",
  env: "Environment",
};

export interface OmpAuthBrokerPanelProps {
  /** `auth.broker.url` and `auth.broker.token` as the global layers resolve them; undefined until read. */
  readonly url: OmpSettingsField | undefined;
  readonly token: OmpSettingsField | undefined;
  readonly loading: boolean;
  readonly error: string | null;
  readonly disabled: boolean;
  readonly onWrite: (key: string, value: string) => void;
  readonly onReset: (key: string) => void;
}

/** OMP's auth broker: where OMP keeps credentials instead of its local store; presentational. */
export function OmpAuthBrokerPanel(props: OmpAuthBrokerPanelProps) {
  const { url, token } = props;
  const [tokenError, setTokenError] = useState<string | null>(null);
  return (
    <section aria-label="Auth broker" className="flex flex-col gap-3 border-t pt-3">
      <div className="flex flex-col gap-1">
        <h3 className="font-medium text-sm">Auth broker</h3>
        <p className="text-muted-foreground text-xs">
          A remote <code>omp auth-broker serve</code> host OMP keeps credentials on instead of its
          local store. OMP reads both settings from its global config only.
        </p>
      </div>
      {props.loading ? (
        <p className="text-muted-foreground text-xs">Reading OMP settings…</p>
      ) : url === undefined || token === undefined ? (
        <p className="text-muted-foreground text-xs">This OMP has no auth broker settings.</p>
      ) : (
        <>
          <div className="flex flex-col gap-1.5" data-setting={URL_KEY}>
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-xs">{URL_KEY}</code>
              <Badge variant="outline" size="sm">
                {SOURCE_LABEL[url.source]}
              </Badge>
              {url.source === "global" && !url.readOnly ? (
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={props.disabled}
                  onClick={() => props.onReset(URL_KEY)}
                >
                  Reset
                </Button>
              ) : null}
            </div>
            <div className="max-w-xl">
              <DraftInput
                aria-label="Auth broker URL"
                placeholder="https://broker.example:8765"
                disabled={props.disabled || url.readOnly}
                value={typeof url.value === "string" ? url.value : ""}
                onCommit={(next) => {
                  const trimmed = next.trim();
                  if (trimmed !== "") props.onWrite(URL_KEY, trimmed);
                }}
              />
            </div>
            {url.readOnly ? (
              <p className="text-muted-foreground text-xs">
                Set by OMP_AUTH_BROKER_URL; change it where OMP is launched.
              </p>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5" data-setting={TOKEN_KEY}>
            <div className="flex flex-wrap items-center gap-2">
              <code className="text-xs">{TOKEN_KEY}</code>
              <Badge variant="outline" size="sm">
                {token.redacted
                  ? `${SOURCE_LABEL[token.source]} · stored`
                  : SOURCE_LABEL[token.source]}
              </Badge>
              {token.source === "global" && !token.readOnly ? (
                <Button
                  variant="ghost"
                  size="compact"
                  disabled={props.disabled}
                  onClick={() => props.onReset(TOKEN_KEY)}
                >
                  Reset
                </Button>
              ) : null}
            </div>
            <div className="max-w-xl">
              <DraftInput
                aria-label="Auth broker token source"
                placeholder={
                  token.redacted
                    ? "Stored; enter a new source to replace it"
                    : "BROKER_TOKEN or !op read op://vault/broker/token"
                }
                disabled={props.disabled || token.readOnly}
                value=""
                onCommit={(next) => {
                  const trimmed = next.trim();
                  if (trimmed === "") return;
                  if (!isOmpSecretReference(trimmed)) {
                    setTokenError(
                      "Enter an environment variable name (upper case) or a !command that prints the token, not the token itself.",
                    );
                    return;
                  }
                  setTokenError(null);
                  props.onWrite(TOKEN_KEY, trimmed);
                }}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              {token.readOnly
                ? "Set by OMP_AUTH_BROKER_TOKEN; change it where OMP is launched."
                : "Where OMP reads the bearer token: an environment variable name or a !command OMP runs. Ompanel never takes the token itself; without a source OMP uses OMP_AUTH_BROKER_TOKEN or the token file omp auth-broker token writes."}
            </p>
            {tokenError === null ? null : (
              <p role="alert" className="text-destructive text-xs">
                {tokenError}
              </p>
            )}
          </div>
        </>
      )}
      {props.error === null ? null : (
        <p role="alert" className="text-destructive text-xs">
          {props.error}
        </p>
      )}
    </section>
  );
}

function failureText(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const failure = squashAtomCommandFailure(result);
  return failure instanceof Error ? failure.message : "OMP could not apply the setting.";
}

/** The auth broker settings for one OMP instance, read and written through the settings engine. */
export function OmpAuthBrokerSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly disabled: boolean;
}) {
  const { environmentId, instanceId } = props;
  const commands = { reportFailure: false } as const;
  const readSettings = useAtomCommand(serverEnvironment.readOmpSettings, commands);
  const writeSetting = useAtomCommand(serverEnvironment.writeOmpSetting, commands);
  const resetSetting = useAtomCommand(serverEnvironment.resetOmpSetting, commands);
  const [form, setForm] = useState<OmpSettingsForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readSettings({ environmentId, input: { instanceId } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") setForm(result.value);
      else setError(failureText(result) ?? "OMP settings are unavailable.");
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, readSettings]);

  const applied = (result: AtomCommandResult<OmpSettingsWriteResult, unknown>) => {
    setPending(false);
    if (result._tag === "Success") {
      setForm(result.value.form);
      setError(
        result.value.overriddenBy === undefined
          ? null
          : `Saved, but ${result.value.overriddenBy} still overrides it.`,
      );
    } else setError(failureText(result));
  };

  const field = (key: string) => form?.fields.find((candidate) => candidate.key === key);
  return (
    <OmpAuthBrokerPanel
      url={field(URL_KEY)}
      token={field(TOKEN_KEY)}
      loading={form === null && error === null}
      error={error}
      disabled={props.disabled || pending}
      onWrite={(key, value) => {
        setPending(true);
        void writeSetting({
          environmentId,
          input: { instanceId, scope: "global", key, value },
        }).then(applied);
      }}
      onReset={(key) => {
        setPending(true);
        void resetSetting({ environmentId, input: { instanceId, scope: "global", key } }).then(
          applied,
        );
      }}
    />
  );
}
