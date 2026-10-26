import { useAtomValue } from "@effect/atom-react";
import {
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { CheckIcon, TerminalIcon } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import {
  getOmpOnboardingStep,
  OMP_EXECUTABLE_SOURCE_LABEL,
  type OmpOnboardingStep,
} from "../../onboarding/ompOnboarding.logic";
import { resolveOnboardingProviderLoginCommand } from "../../onboarding/providerReadiness.logic";
import { serverEnvironment } from "../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  ProviderCommandTerminal,
  type ProviderTerminalSession,
} from "../onboarding/ProviderCommandTerminal";
import { Button } from "../ui/button";
import { SettingsSection } from "./settingsLayout";

const SETUP_POLL_MS = 5_000;

export interface OmpOnboardingPanelProps {
  readonly provider: ServerProvider;
  /** The `omp setup` command for this instance, or `null` when it cannot be built yet. */
  readonly setupCommand: string | null;
  /** The open setup terminal, if any. */
  readonly terminal: ReactNode;
  readonly canRunSetup: boolean;
  readonly onRunSetup: () => void;
  readonly onCheckAgain: () => void;
  readonly onOpenAccounts: () => void;
}

type StepState = "done" | "current" | "pending";

function Step(props: {
  readonly index: number;
  readonly title: string;
  readonly state: StepState;
  readonly children?: ReactNode;
}) {
  return (
    <li
      aria-current={props.state === "current" ? "step" : undefined}
      data-state={props.state}
      className="flex gap-3"
    >
      <span
        aria-hidden
        className={
          props.state === "done"
            ? "flex size-5 shrink-0 items-center justify-center rounded-full bg-success/15 text-success-foreground"
            : props.state === "current"
              ? "flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-2xs font-medium text-primary-foreground"
              : "flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs text-muted-foreground"
        }
      >
        {props.state === "done" ? <CheckIcon className="size-3" /> : props.index}
      </span>
      <div className="min-w-0 flex-1">
        <p
          className={
            props.state === "pending" ? "text-sm text-muted-foreground" : "text-sm font-medium"
          }
        >
          {props.title}
          {props.state === "done" ? <span className="sr-only"> (done)</span> : null}
        </p>
        {props.children ? (
          <div className="mt-1 flex flex-col gap-2 text-xs text-muted-foreground">
            {props.children}
          </div>
        ) : null}
      </div>
    </li>
  );
}

const stepStates = (step: OmpOnboardingStep): readonly [StepState, StepState, StepState] =>
  step === "accounts"
    ? ["done", "done", "current"]
    : step === "setup"
      ? ["done", "current", "pending"]
      : ["current", "pending", "pending"];

/** Detect → `omp setup` → Accounts for one OMP instance; presentational. */
export function OmpOnboardingPanel(props: OmpOnboardingPanelProps) {
  const { provider } = props;
  const step = getOmpOnboardingStep(provider);
  const [detect, setup, accounts] = stepStates(step);
  const executable = provider.executable;
  const signedIn = provider.auth.status === "authenticated";

  return (
    <div className="flex flex-col gap-3 px-3 py-3 sm:px-4">
      <ol aria-label="OMP setup steps" className="flex flex-col gap-3">
        <Step index={1} title="Find OMP" state={detect}>
          {step === "checking" ? (
            <p role="status">Checking the OMP sidecar…</p>
          ) : executable ? (
            <>
              <p>
                {OMP_EXECUTABLE_SOURCE_LABEL[executable.source]}
                {provider.version ? ` · v${provider.version}` : ""}
              </p>
              <code className="block max-w-full truncate font-mono text-2xs">
                {executable.path}
              </code>
            </>
          ) : null}
          {step === "missing" || step === "error" ? (
            <>
              <p role="alert" className="text-destructive">
                {provider.message ?? "Ompanel could not start OMP."}
              </p>
              <div>
                <Button size="xs" variant="outline" onClick={props.onCheckAgain}>
                  Check again
                </Button>
              </div>
            </>
          ) : null}
        </Step>
        <Step index={2} title="Run omp setup" state={setup}>
          {step === "setup" ? (
            <p>
              OMP has no model or sign-in yet. Its setup wizard signs you in to a provider and picks
              a default model; it runs in a terminal here.
            </p>
          ) : null}
          {step === "setup" || step === "accounts" ? (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant={step === "setup" ? "default" : "ghost"}
                disabled={!props.canRunSetup || props.setupCommand === null}
                onClick={props.onRunSetup}
              >
                <TerminalIcon className="size-3.5" />
                {step === "setup" ? "Run omp setup" : "Run omp setup again"}
              </Button>
              {step === "setup" ? (
                <Button size="xs" variant="ghost-muted" onClick={props.onCheckAgain}>
                  Check again
                </Button>
              ) : null}
            </div>
          ) : null}
          {props.terminal}
        </Step>
        <Step index={3} title="Sign in under Accounts" state={signedIn ? "done" : accounts}>
          {step === "accounts" ? (
            <div className="flex flex-wrap items-center gap-2">
              {signedIn && provider.auth.label ? (
                <span>Signed in · {provider.auth.label}</span>
              ) : null}
              <Button size="xs" variant="outline" onClick={props.onOpenAccounts}>
                Open Accounts
              </Button>
            </div>
          ) : null}
        </Step>
      </ol>
    </div>
  );
}

/** Settings → OMP instance → Setup: the onboarding flow (FR-22). */
export function OmpOnboardingSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
  /** Shows and loads the Accounts section. */
  readonly onOpenAccounts: () => void;
}) {
  const { environmentId, instanceId, provider, onOpenAccounts } = props;
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const canOperateTerminal = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const [terminal, setTerminal] = useState<ProviderTerminalSession | null>(null);
  const step = getOmpOnboardingStep(provider);

  // Re-checks OMP; setup finishing (OMP turning ready) leads straight on to Accounts.
  const checkAgain = () =>
    void refreshProviders({ environmentId, input: { instanceId } }).then((result) => {
      if (result._tag !== "Success" || step !== "setup") return;
      const next = result.value.providers.find((entry) => entry.instanceId === instanceId);
      if (getOmpOnboardingStep(next) === "accounts") onOpenAccounts();
    });

  // `omp setup` ends inside the terminal (the shell stays open), so the status is checked while it
  // runs; OMP's probe does not cache the no-model state.
  const awaitingSetup = terminal !== null && step === "setup";
  useEffect(() => {
    if (!awaitingSetup) return;
    const timer = window.setInterval(checkAgain, SETUP_POLL_MS);
    return () => window.clearInterval(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- The timer lives while setup is awaited; `checkAgain` is rebuilt every render.
  }, [awaitingSetup]);

  const setupCommand =
    serverConfig === null
      ? null
      : resolveOnboardingProviderLoginCommand(
          provider,
          serverConfig.settings,
          serverConfig.environment.platform.os,
        );

  return (
    <SettingsSection title="Setup">
      <OmpOnboardingPanel
        provider={provider}
        setupCommand={setupCommand}
        canRunSetup={!props.readOnly && canOperateTerminal && terminal === null}
        onCheckAgain={checkAgain}
        onOpenAccounts={onOpenAccounts}
        onRunSetup={() => {
          if (
            serverConfig === null ||
            setupCommand === null ||
            !readEnvironmentScope(environmentId, AuthTerminalOperateScope)
          )
            return;
          setTerminal({
            environmentId,
            key: `omp-${provider.instanceId}`,
            label: "OMP setup",
            providerInstanceId: provider.instanceId,
            cwd: serverConfig.cwd,
            command: setupCommand,
            keybindings: serverConfig.keybindings,
          });
        }}
        terminal={
          terminal === null ? null : (
            <ProviderCommandTerminal
              session={terminal}
              onClose={() => {
                setTerminal(null);
                checkAgain();
              }}
            />
          )
        }
      />
    </SettingsSection>
  );
}
