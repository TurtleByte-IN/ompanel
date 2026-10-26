// @effect-diagnostics nodeBuiltinImport:off - the real omp runs with a throwaway HOME.
/**
 * The `models.yml` check against a real omp, when `T3_TEST_OMP_BINARY` names one (a local `omp`
 * or the OMP E2E build). It runs under a temporary HOME, so nothing of the user's OMP is read or
 * written.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { makeOmpControlService } from "./control.ts";
import { checkOmpModelsConfig } from "./modelsCheck.ts";

// `vp test` passes `T3_*` variables through to the workers.
const binary = process.env["T3_TEST_OMP_BINARY"];

const VALID = `providers:
  lab:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    apiKey: LAB_KEY
    models:
      - id: lab-model
`;

describe.runIf(binary !== undefined && HostProcess.Platform.defaultValue() !== "win32")(
  "models.yml check with a real omp",
  () => {
    it.live("accepts a file OMP loads and refuses one it drops", () =>
      Effect.gen(function* () {
        const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ompanel-real-omp-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(home, { recursive: true, force: true })),
        );
        const control = yield* makeOmpControlService();
        const target = {
          binaryPath: binary!,
          profile: "",
          environment: { HOME: home, PATH: process.env["PATH"] ?? "/usr/bin:/bin" },
          cwd: home,
        };
        const check = (content: string) =>
          checkOmpModelsConfig({ control, target, content }).pipe(Effect.result);

        const valid = yield* check(VALID);
        assert.strictEqual(valid._tag, "Success");
        if (valid._tag === "Success") {
          assert.deepStrictEqual(valid.success, [{ provider: "lab", id: "lab-model" }]);
        }
        for (const content of [
          VALID.replace("openai-completions", "carrier-pigeon"),
          VALID.replace("    apiKey: LAB_KEY\n", ""),
        ]) {
          const refused = yield* check(content);
          assert.strictEqual(refused._tag, "Failure");
          if (refused._tag === "Failure") assert.strictEqual(refused.failure.reason, "invalid");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  },
);
