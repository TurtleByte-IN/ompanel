import { TextGenerationError } from "@t3tools/contracts";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as Effect from "effect/Effect";

/** Each operation fails until `omp -p` text generation exists. */
export const makeOmpTextGeneration = (): ProviderTextGeneration => {
  const unavailable = (operation: keyof ProviderTextGeneration) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "OMP text generation is not available in this Ompanel build yet.",
      }),
    );
  return {
    generateCommitMessage: () => unavailable("generateCommitMessage"),
    generatePrContent: () => unavailable("generatePrContent"),
    generateBranchName: () => unavailable("generateBranchName"),
    generateThreadTitle: () => unavailable("generateThreadTitle"),
    generateReviewGuide: () => unavailable("generateReviewGuide"),
  };
};
