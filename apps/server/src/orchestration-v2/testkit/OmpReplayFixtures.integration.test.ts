// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { OMP_LOCK } from "@t3tools/provider-omp/rpc";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import {
  decodeOmpRpcReplayTranscript,
  replayOmpScenario,
} from "../Adapters/OmpAdapterV2.testkit.ts";
import { OMP_REPLAY_SCENARIOS, ompTranscriptUrl } from "./fixtures/ompScenarios.ts";

// Transport replays of the pinned OMP fork. Re-record with `record:omp-replay`
// (docs/omp/testing.md) whenever `omp.lock` moves.
describe("OMP replay fixtures", () => {
  it.live.each(OMP_REPLAY_SCENARIOS)("omp/$name", (scenario) =>
    Effect.gen(function* () {
      const recorded = yield* readProviderReplayTranscript(ompTranscriptUrl(scenario.name));
      const transcript = yield* decodeOmpRpcReplayTranscript(recorded);
      assert.strictEqual(
        transcript.metadata.contractVersion,
        OMP_LOCK.contract.version,
        `omp_${scenario.name} was recorded against another RPC contract; re-record it`,
      );
      assert.strictEqual(transcript.metadata.ompTag, OMP_LOCK.tag);
      const pidfilesDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "omp-replay-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(pidfilesDir, { recursive: true, force: true })),
      );
      yield* replayOmpScenario(scenario, transcript, {
        platform: HostProcess.Platform.defaultValue(),
        pidfilesDir,
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
