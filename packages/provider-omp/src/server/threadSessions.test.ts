import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";

import { ompInstanceThreadSessions, type OmpThreadSession } from "./threadSessions.ts";

const session = (published: Array<ReadonlyArray<string>>): OmpThreadSession => ({
  threadId: "thread-1",
  providerSessionId: ProviderSessionId.make("session-1"),
  cwd: "/work/app",
  process: { request: () => Effect.die("unused") },
  onRestartRequired: (keys) => Effect.sync(() => void published.push(keys)),
  isBusy: () => false,
});

describe("ompInstanceThreadSessions", () => {
  it.effect("keeps a running thread visible to a rebuilt instance until its session ends", () =>
    Effect.gen(function* () {
      const published: Array<ReadonlyArray<string>> = [];
      // The first build's adapter opens the thread in a session scope that outlives the build.
      const first = ompInstanceThreadSessions("omp-rebuilt");
      const sessionScope = yield* Scope.make();
      yield* first.register(session(published)).pipe(Scope.provide(sessionScope));

      // A settings change rebuilds the instance; its settings engine reads the same registry.
      const rebuilt = ompInstanceThreadSessions("omp-rebuilt");
      assert.deepStrictEqual(
        (yield* rebuilt.list).map((open) => open.threadId),
        ["thread-1"],
      );
      yield* rebuilt.markRestartRequired("thread-1", ["memory.backend"]);
      assert.deepStrictEqual(published, [["memory.backend"]]);
      assert.deepStrictEqual(rebuilt.restartRequired(ProviderSessionId.make("session-1")), [
        "memory.backend",
      ]);

      // Other instances keep their own threads.
      assert.deepStrictEqual(yield* ompInstanceThreadSessions("omp-other").list, []);

      yield* Scope.close(sessionScope, Exit.void);
      assert.deepStrictEqual(yield* rebuilt.list, []);
    }),
  );
});
