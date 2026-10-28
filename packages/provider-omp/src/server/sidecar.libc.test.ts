import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

import { OMP_LOCK } from "../ompLock.ts";
import { pinnedOmpSidecar } from "./sidecar.ts";

// Its own file: the libc reference caches its first detection for the whole module graph.
describe("pinnedOmpSidecar", () => {
  it.effect("builds no process report off Linux", () =>
    Effect.gen(function* () {
      const getReport = vi.spyOn(process.report, "getReport");
      try {
        for (const [platform, asset] of [
          ["win32", "omp-windows-x64.exe"],
          ["darwin", "omp-darwin-x64"],
        ] as const) {
          const pinned = yield* pinnedOmpSidecar(OMP_LOCK).pipe(
            Effect.provideService(HostProcess.Platform, platform),
            Effect.provideService(HostProcess.Architecture, "x64"),
          );
          assert.strictEqual(pinned.asset, asset);
        }
        assert.strictEqual(getReport.mock.calls.length, 0);
      } finally {
        getReport.mockRestore();
      }
    }),
  );
});
