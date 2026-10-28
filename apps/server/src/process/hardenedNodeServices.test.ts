import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as HardenedNodeServices from "./hardenedNodeServices.ts";

const HOST_PLATFORM = HostProcess.Platform.defaultValue();
const POSIX = HOST_PLATFORM !== "win32";

const runInRepo = (
  layer: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const repo = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hardened-repo-" });
    yield* fs.writeFileString(path.join(repo, "planted"), "#!/bin/sh\necho planted\n", {
      mode: 0o755,
    });
    return yield* spawner
      .string(
        ChildProcess.make("planted", [], {
          cwd: repo,
          env: { PATH: `.:${path.dirname(process.execPath)}:` },
          extendEnv: false,
        }),
      )
      .pipe(Effect.result);
  }).pipe(Effect.scoped, Effect.provide(layer));

it.effect.runIf(POSIX)("an unhardened spawner runs a planted executable through PATH=.", () =>
  Effect.gen(function* () {
    const result = yield* runInRepo(NodeServices.layer);
    assert.strictEqual(result._tag, "Success");
  }),
);

it.effect.runIf(POSIX)(
  "the hardened spawner never runs an executable a relative or empty PATH entry points at",
  () =>
    Effect.gen(function* () {
      const result = yield* runInRepo(HardenedNodeServices.layer);
      assert.strictEqual(result._tag, "Failure");
    }),
);

it.effect("still starts a command found through an absolute PATH entry", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const out = yield* spawner.string(
      ChildProcess.make(
        path.basename(process.execPath),
        ["-e", "console.log(process.env.NoDefaultCurrentDirectoryInExePath ?? 'unset')"],
        {
          env: { PATH: `.:${path.dirname(process.execPath)}` },
          extendEnv: false,
        },
      ),
    );
    assert.strictEqual(out.trim(), HOST_PLATFORM === "win32" ? "1" : "unset");
  }).pipe(Effect.provide(HardenedNodeServices.layer)),
);

it.effect("tells a Windows child not to search its working directory", () =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const out = yield* spawner.string(
      ChildProcess.make(
        process.execPath,
        ["-e", "console.log(process.env.NoDefaultCurrentDirectoryInExePath ?? 'unset')"],
        { env: { PATH: path.dirname(process.execPath) }, extendEnv: false },
      ),
    );
    assert.strictEqual(out.trim(), "1");
  }).pipe(
    Effect.provide(
      HardenedNodeServices.layer.pipe(Layer.provide(Layer.succeed(HostProcess.Platform, "win32"))),
    ),
  ),
);
