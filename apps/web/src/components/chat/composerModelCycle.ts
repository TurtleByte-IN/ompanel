import type { ProviderInstanceId } from "@t3tools/contracts";

import { sortProviderModelItems } from "../../modelOrdering";

export interface CycleModelCandidate {
  readonly slug: string;
  readonly isLegacy?: boolean | undefined;
  readonly isUnavailable?: boolean | undefined;
}

/**
 * The model `composer.cycleModel` moves to: the next one (or previous, for -1) in the thread
 * provider's model list, in the picker's order (favorites first, then the provider's order),
 * wrapping at either end. Legacy, unavailable and disabled models are skipped. Null when there is
 * nothing else to move to.
 */
export function nextComposerCycleModel(input: {
  readonly instanceId: ProviderInstanceId;
  readonly models: ReadonlyArray<CycleModelCandidate>;
  readonly current: string;
  readonly direction: 1 | -1;
  readonly favoriteModelKeys?: ReadonlySet<string> | ReadonlyArray<string>;
  readonly isDisabled?: (slug: string) => boolean;
}): string | null {
  const ordered = sortProviderModelItems(
    input.models.map((model) => ({ ...model, instanceId: input.instanceId })),
    { favoriteModelKeys: input.favoriteModelKeys ?? [], groupFavorites: true },
  );
  const cycle = ordered.filter(
    (model) =>
      model.slug === input.current ||
      (!model.isLegacy && !model.isUnavailable && !input.isDisabled?.(model.slug)),
  );
  if (cycle.length === 0) return null;
  const index = cycle.findIndex((model) => model.slug === input.current);
  const nextIndex =
    index === -1
      ? input.direction === 1
        ? 0
        : cycle.length - 1
      : (index + input.direction + cycle.length) % cycle.length;
  const next = cycle[nextIndex]!.slug;
  return next === input.current ? null : next;
}
