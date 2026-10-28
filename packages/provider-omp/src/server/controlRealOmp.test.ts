// @effect-diagnostics nodeBuiltinImport:off - the real omp runs with a throwaway HOME.
/**
 * Control operations against a real omp, when `T3_TEST_OMP_BINARY` names one (a local `omp` or the
 * OMP E2E build), under a temporary HOME, so nothing of the user's OMP is read or written.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { makeOmpControlService } from "./control.ts";

// `vp test` passes `T3_*` variables through to the workers.
const binary = process.env["T3_TEST_OMP_BINARY"];

const MODELS = `providers:
  lab:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    apiKey: LAB_KEY
    models:
      - id: lab-a
      - id: lab-b
`;

describe.runIf(binary !== undefined && HostProcess.Platform.defaultValue() !== "win32")(
  "OMP control with a real omp",
  () => {
    it.live("lists a workspace's project models", () =>
      Effect.gen(function* () {
        const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ompanel-real-omp-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true })),
        );
        const agentDir = NodePath.join(home, ".omp", "agent");
        const project = NodePath.join(home, "project");
        const other = NodePath.join(home, "other");
        for (const dir of [agentDir, NodePath.join(project, ".omp"), other]) {
          NodeFS.mkdirSync(dir, { recursive: true });
        }
        NodeFS.writeFileSync(NodePath.join(agentDir, "models.yml"), MODELS);
        // The project's own config limits sessions there to lab-a, once the project is trusted.
        NodeFS.writeFileSync(
          NodePath.join(project, ".omp", "config.yml"),
          "enabledModels: [lab/lab-a]\n",
        );

        const control = yield* makeOmpControlService();
        const models = (cwd: string) =>
          control
            .availableModels({
              binaryPath: binary!,
              profile: "",
              environment: { HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
              cwd,
            })
            .pipe(
              Effect.map((listed) =>
                listed
                  .filter((model) => model.provider === "lab")
                  .map((model) => model.id)
                  .toSorted(),
              ),
            );

        // A control session starts untrusted, so it ignores the project's own `enabledModels`.
        assert.deepStrictEqual(yield* models(project), ["lab-a", "lab-b"]);
        assert.deepStrictEqual(yield* models(other), ["lab-a", "lab-b"]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
