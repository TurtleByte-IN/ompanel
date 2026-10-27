// @effect-diagnostics nodeBuiltinImport:off - the scratch agent directory must be owner-only (`mkdtemp`) and removed with whatever OMP wrote into it.
/**
 * Checks a `models.yml` text with OMP itself before it replaces the real file: OMP starts in a
 * scratch agent directory holding only that text and lists its models. OMP validates the file
 * when it loads it and, on any problem, drops every custom provider it declares, so a marker
 * provider added to the scratch copy is listed back exactly when OMP accepted the file.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { OmpAgentFilesOperationError, type OmpCheckedModel } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { readOmpModelsConfig, withOmpModelsCheckProvider } from "../modelsConfig.ts";
import type { OmpControlService, OmpControlTarget } from "./control.ts";

const invalid = (message: string) =>
  new OmpAgentFilesOperationError({ reason: "invalid", message });

const ioFailed = () =>
  new OmpAgentFilesOperationError({
    reason: "io_failed",
    message: "Could not prepare a scratch agent directory to check models.yml.",
  });

/** An owner-only scratch directory holding `models.yml`, removed with everything OMP left in it. */
const scratchAgentDir = (text: string) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      try: async () => {
        const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "ompanel-models-check-"));
        // The text can hold API keys: only the owner may read it.
        await NodeFSP.writeFile(NodePath.join(dir, "models.yml"), text, { mode: 0o600 });
        return dir;
      },
      catch: ioFailed,
    }),
    (dir) =>
      Effect.promise(() => NodeFSP.rm(dir, { recursive: true, force: true }).catch(() => {})),
  );

/**
 * OMP's verdict on `content` as `models.yml`: the models of its own providers OMP listed, or
 * `invalid` when OMP did not load it. The real agent directory is never touched.
 */
export const checkOmpModelsConfig = Effect.fn("checkOmpModelsConfig")(function* (input: {
  readonly control: Pick<OmpControlService, "modelsInAgentDir">;
  readonly target: OmpControlTarget;
  readonly content: string;
}) {
  const read = readOmpModelsConfig(input.content);
  if (!read.ok) return yield* invalid(read.error);
  const marker = `ompanel-check-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const scratch = withOmpModelsCheckProvider(input.content, marker);
  if (!scratch.ok) return yield* invalid(scratch.error);

  const listed = yield* Effect.scoped(
    scratchAgentDir(scratch.text).pipe(
      Effect.flatMap((dir) => input.control.modelsInAgentDir(input.target, dir)),
    ),
  ).pipe(
    Effect.catchTags({
      OmpControlError: (error) =>
        // With the marker's model OMP always has one to start with, unless it dropped the file:
        // then it stops before `ready`, saying it has no model (`unconfigured`) or just exiting.
        error.reason === "exit" || error.reason === "unconfigured"
          ? Effect.fail(
              invalid(
                "OMP did not load this models.yml and stopped before it was ready, so the file was not saved. Run `omp models` in a terminal to see OMP's reason.",
              ),
            )
          : Effect.fail(
              new OmpAgentFilesOperationError({
                reason: "omp_failed",
                message: `Could not check models.yml with OMP: ${error.message}`,
              }),
            ),
    }),
  );
  if (!listed.some((model) => model.provider === marker)) {
    return yield* invalid(
      "OMP did not load this models.yml: it failed OMP's checks, so OMP would drop every provider in it. The file was not saved. Run `omp models` in a terminal to see OMP's reason.",
    );
  }
  const providers = new Set(read.providers.map((provider) => provider.id));
  return listed
    .filter((model) => providers.has(model.provider))
    .map((model): OmpCheckedModel => ({ provider: model.provider, id: model.id }));
});
