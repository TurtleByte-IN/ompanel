// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readOmpThreadOverlay, writeOmpThreadOverlay } from "./threadSessions.ts";

const HEADER = "# Per-thread OMP settings written by Ompanel.\n";

describe("thread overlay writes", () => {
  it.effect(
    "keep the adapter's browser and computer-use guard through a stale settings write",
    () =>
      Effect.gen(function* () {
        const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-overlay-guard-"));
        // The settings engine read the overlay while the thread was in Full access…
        const staleEngineWrite = `${HEADER}{"memory":{"backend":"local"}}\n`;
        // …then the adapter pinned both preludes off for Supervised…
        yield* writeOmpThreadOverlay(
          dir,
          "thread/1",
          `${HEADER}{"browser":{"enabled":false},"computer":{"enabled":false}}\n`,
          { ownsGuardKeys: true },
        );
        // …and the engine's write, based on its older read, lands last, concurrently with another.
        yield* Effect.all(
          [
            writeOmpThreadOverlay(dir, "thread/1", staleEngineWrite),
            writeOmpThreadOverlay(dir, "thread/1", `${HEADER}{"browser":{"enabled":true}}\n`),
          ],
          { concurrency: "unbounded" },
        );
        const overlay = yield* readOmpThreadOverlay(dir, "thread/1");
        assert.include(overlay, '"browser":{"enabled":false}');
        assert.include(overlay, '"computer":{"enabled":false}');
        NodeFS.rmSync(dir, { recursive: true, force: true });
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});
