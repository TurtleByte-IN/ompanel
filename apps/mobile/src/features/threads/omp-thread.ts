import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";

import { useQuietThreadShell } from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";

export interface OmpThreadTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

/** The thread's OMP instance; null when the thread runs on another provider. */
export function ompThreadInstanceId(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>,
  providerInstanceId: ProviderInstanceId | null,
): ProviderInstanceId | null {
  if (providerInstanceId === null) return null;
  const provider = providers.find((candidate) => candidate.instanceId === providerInstanceId);
  return provider?.driver === "omp" ? provider.instanceId : null;
}

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];

/** The OMP instance `target` runs on, live; null for a thread on another provider. */
export function useOmpThreadInstanceId(target: OmpThreadTarget | null): ProviderInstanceId | null {
  const providers =
    useAtomValue(environmentPresentations.providersByEnvironmentAtom, (byEnvironment) =>
      target === null ? undefined : byEnvironment.get(target.environmentId),
    ) ?? NO_PROVIDERS;
  const shell = useQuietThreadShell(
    target === null ? null : scopeThreadRef(target.environmentId, target.threadId),
  );
  return target === null ? null : ompThreadInstanceId(providers, shell?.providerInstanceId ?? null);
}

/** The message a failed OMP call shows; null when it was interrupted. */
export function ompFailureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "OMP is unavailable.";
}
