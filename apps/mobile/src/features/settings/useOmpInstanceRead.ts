// One read of an OMP instance for the mobile read-only summaries (Settings → OMP, Usage → OMP):
// loading, its value, or why it failed. Parents key the caller by environment and instance (and
// refresh), so each mount reads once.
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

export type OmpRead<A> =
  | { readonly status: "loading" }
  | { readonly status: "ok"; readonly value: A }
  | { readonly status: "error"; readonly message: string };

export const OMP_READ_LOADING = { status: "loading" } as const;

/** The settled read, or null for an interrupted call (the screen went away). */
export function settleOmpRead<A>(
  result: AtomCommandResult<A, unknown>,
  fallbackMessage: string,
): OmpRead<A> | null {
  if (result._tag === "Success") return { status: "ok", value: result.value };
  if (isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return { status: "error", message: error instanceof Error ? error.message : fallbackMessage };
}

/** Runs `read` (a `useAtomCommand` over an instance-scoped server RPC) once per instance. */
export function useOmpInstanceRead<A>(
  read: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly instanceId: ProviderInstanceId };
  }) => Promise<AtomCommandResult<A, unknown>>,
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId,
  fallbackMessage: string,
): OmpRead<A> {
  const [state, setState] = useState<OmpRead<A>>(OMP_READ_LOADING);
  useEffect(() => {
    let cancelled = false;
    void read({ environmentId, input: { instanceId } }).then((result) => {
      const settled = settleOmpRead(result, fallbackMessage);
      if (!cancelled && settled !== null) setState(settled);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, read, fallbackMessage]);
  return state;
}
