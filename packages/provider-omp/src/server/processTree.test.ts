import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { materializeOmpJobLauncher, ompJobLauncherCommand } from "./processTree.ts";

describe("Windows job-object launcher", () => {
  it.effect("wraps omp so the launcher, and with it the job, comes first", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "omp-launcher-" });
      const launcherPath = yield* materializeOmpJobLauncher(dir);
      const script = yield* fileSystem.readFileString(launcherPath);
      // Kill-on-close job, joined before omp starts, so every descendant inherits it.
      assert.include(script, "KillOnJobClose = 0x2000");
      assert.isBelow(
        script.indexOf("AssignProcessToJobObject(job"),
        script.indexOf("Process.Start"),
      );
      assert.strictEqual(((yield* fileSystem.stat(launcherPath)).mode & 0o777).toString(8), "600");
      // A second boot reuses the same file.
      assert.strictEqual(yield* materializeOmpJobLauncher(dir), launcherPath);

      const command = ompJobLauncherCommand(launcherPath, {
        command: "C:\\Ompanel\\omp.exe",
        args: ["--mode", "rpc-ui", "--cwd", "C:\\work tree"],
      });
      assert.strictEqual(command.command, "powershell.exe");
      assert.deepStrictEqual(command.args.slice(-6), [
        launcherPath,
        "C:\\Ompanel\\omp.exe",
        "--mode",
        "rpc-ui",
        "--cwd",
        "C:\\work tree",
      ]);
      assert.include(command.args, "-NonInteractive");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
