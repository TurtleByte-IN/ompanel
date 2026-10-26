import { TextGenerationError } from "@t3tools/contracts";
import { collectStreamAsString } from "@t3tools/provider-core/server/snapshotProbe";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { OmpAnsi } from "./ompAnsi.ts";
import type { OmpSidecarError } from "./sidecar.ts";

const OMP_TEXT_GENERATION_TIMEOUT_MS = 180_000;
/** The model slug that defers to the OMP profile's own role configuration. */
const OMP_DEFAULT_MODEL_SLUG = "default";
const STDERR_DETAIL_MAX_CHARS = 2_000;

const isTextGenerationError = Schema.is(TextGenerationError);

export interface OmpTextGenerationOptions {
  /** Resolves the omp executable (sidecar resolver) when an operation runs. */
  readonly resolveBinary: Effect.Effect<string, OmpSidecarError>;
  readonly profile: string;
  readonly environment: NodeJS.ProcessEnv;
  /**
   * An empty directory Ompanel owns. omp runs here, never in the checkout, so the checkout's
   * `.mcp.json`, `.omp/tools`, `.claude/tools`, rules and extensions are never discovered.
   */
  readonly cwd: string;
}

/**
 * The OMP model selector for an operation. Thread titles use `@tiny`, which OMP itself falls
 * back to `@smol` when unset. The source-control writers use the chain `omp commit` resolves
 * (`commit`, then `smol`, then the default model); `@commit` alone has no fallback.
 */
const ompTextGenerationRole = (operation: TextGenerationOperations.Operation) =>
  operation === "generateThreadTitle" ? "@tiny" : "@commit,@smol,@default";

/**
 * `omp -p` one-shot args; the prompt is piped on stdin so diffs never hit argv limits.
 * `--no-tools` drops built-in tools and `--no-extensions` stops extension discovery; neither
 * disables MCP servers or custom tools, which the owned empty cwd keeps to user-level ones.
 */
const ompTextGenerationArgs = (input: {
  readonly operation: TextGenerationOperations.Operation;
  readonly model: string;
  readonly profile: string;
}): ReadonlyArray<string> => [
  ...(input.profile === "" ? [] : ["--profile", input.profile]),
  "-p",
  "--no-session",
  "--no-tools",
  "--no-extensions",
  "--model",
  input.model === OMP_DEFAULT_MODEL_SLUG ? ompTextGenerationRole(input.operation) : input.model,
];

const failureDetail = (exitCode: number, stderr: string, stdout: string) => {
  const text = OmpAnsi.strip(stderr).trim() || OmpAnsi.strip(stdout).trim();
  const clipped =
    text.length > STDERR_DETAIL_MAX_CHARS ? text.slice(-STDERR_DETAIL_MAX_CHARS) : text;
  return clipped.length > 0
    ? `OMP exited with code ${exitCode}: ${clipped}`
    : `OMP exited with code ${exitCode}.`;
};

/**
 * Text generation through a short-lived `omp -p --no-session --no-tools` process. Interrupting
 * an operation closes its scope, which kills the process; partial output is never returned.
 */
export const makeOmpTextGeneration = Effect.fn("makeOmpTextGeneration")(function* (
  options: OmpTextGenerationOptions,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runOmp: TextGenerationOperations.Runner = Effect.fn("OmpTextGeneration.run")(
    function* (request) {
      const { operation, prompt, modelSelection } = request;
      const binaryPath = yield* options.resolveBinary.pipe(
        Effect.mapError(
          (cause) =>
            new TextGenerationError({
              operation,
              detail: "Could not locate the OMP executable.",
              cause,
            }),
        ),
      );
      const command = ChildProcess.make(
        binaryPath,
        ompTextGenerationArgs({
          operation,
          model: modelSelection.model,
          profile: options.profile,
        }),
        {
          cwd: options.cwd,
          env: options.environment,
          extendEnv: false,
          stdin: { stream: Stream.encodeText(Stream.make(prompt)) },
          forceKillAfter: "1 second",
        },
      );

      const output = yield* Effect.gen(function* () {
        const child = yield* spawner.spawn(command);
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectStreamAsString(child.stdout),
            collectStreamAsString(child.stderr),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        if (exitCode !== 0) {
          return yield* new TextGenerationError({
            operation,
            detail: failureDetail(exitCode, stderr, stdout),
          });
        }
        return OmpAnsi.strip(stdout).trim();
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(OMP_TEXT_GENERATION_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new TextGenerationError({ operation, detail: "OMP request timed out." })),
            onSome: Effect.succeed,
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({ operation, detail: "Failed to run OMP.", cause }),
        ),
      );

      if (output.length === 0) {
        return yield* new TextGenerationError({ operation, detail: "OMP returned empty output." });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "OMP", output);
    },
  );

  return TextGenerationOperations.fromRunner(
    "OmpTextGeneration",
    TextGenerationOperations.withoutInvestigation("OMP", runOmp),
  ) satisfies ProviderTextGeneration;
});
