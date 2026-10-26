import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each(["t3code", "T3 Code (Alpha)"])(
  "never seeds Ompanel's profile from upstream's %s profile, so their safeStorage keys differ",
  (sourceName) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "ompanel-profile-" });
      const source = path.join(directory, sourceName);
      yield* fs.makeDirectory(source, { recursive: true });
      yield* fs.writeFileString(
        path.join(source, "Local State"),
        '{"os_crypt":{"encrypted_key":"upstream-key"}}',
      );

      const userData = yield* resolveUserDataPath({
        appDataDirectory: directory,
        isDevelopment: false,
      });

      assert.equal(userData, path.join(directory, "ompanel"));
      assert.isFalse(yield* fs.exists(path.join(userData, "Local State")));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
