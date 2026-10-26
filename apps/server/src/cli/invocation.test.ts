import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import packageJson from "../../package.json" with { type: "json" };
import {
  resolveHostCliCommand,
  resolveRootCliCommand,
  resolveServerInstallation,
} from "./invocation.ts";

it.layer(NodeServices.layer)("root CLI commands", (it) => {
  const rootCommand = (input: {
    readonly node: string;
    readonly entry: string;
    readonly path?: string;
    readonly env?: Record<string, string>;
    readonly executable?: boolean;
  }) =>
    resolveRootCliCommand("browser setup").pipe(
      Effect.provideService(HostProcess.ExecutablePath, input.node),
      Effect.provideService(HostProcess.Arguments, [input.node, input.entry]),
      Effect.provideService(HostProcess.IsExecutable, input.executable ?? false),
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HostProcess.Environment, { PATH: input.path ?? "", ...input.env }),
    );

  const pathWithT3 = Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const bin = yield* fs.makeTempDirectoryScoped();
    yield* fs.writeFileString(path.join(bin, "ompanel"), "#!/bin/sh\n", { mode: 0o755 });
    return bin;
  });

  it.effect("keeps a user-installed Node reachable when the command runs under sudo", () =>
    Effect.gen(function* () {
      const npx = "/home/theo/.npm/_npx/abc/node_modules/ompanel/dist/bin.mjs";
      expect(yield* rootCommand({ node: "/usr/bin/node", entry: npx })).toBe(
        "sudo npx ompanel browser setup",
      );
      expect(
        yield* rootCommand({ node: "/home/theo/.nvm/versions/node/v24/bin/node", entry: npx }),
      ).toBe('sudo env "PATH=$PATH" npx ompanel browser setup');
      expect(
        yield* rootCommand({
          node: "/home/theo/.local/node/bin/node",
          entry: "/home/theo/.local/lib/node_modules/ompanel/dist/bin.mjs",
          path: yield* pathWithT3,
        }),
      ).toBe('sudo env "PATH=$PATH" ompanel browser setup');
    }).pipe(Effect.scoped),
  );

  it.effect("names this install's launcher when ompanel is not on PATH", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, ".local bin", "ompanel");
      yield* fs.makeDirectory(path.dirname(shim), { recursive: true });
      yield* fs.writeFileString(shim, "#!/bin/sh\n", { mode: 0o755 });
      const desktop = {
        node: "/tmp/.mount_T3abc/t3code",
        entry: "/tmp/.mount_T3abc/resources/app.asar/apps/server/dist/bin.mjs",
        env: { OMPANEL_CLI_PATH: shim },
      };

      expect(yield* rootCommand(desktop)).toBe(`sudo '${shim}' browser setup`);

      expect(yield* rootCommand({ ...desktop, path: yield* pathWithT3 })).toBe(
        'sudo env "PATH=$PATH" ompanel browser setup',
      );

      expect(
        yield* rootCommand({
          node: "/opt/ompanel/ompanel",
          entry: "/opt/ompanel/ompanel",
          executable: true,
        }),
      ).toBe("sudo /opt/ompanel/ompanel browser setup");

      expect(
        yield* rootCommand({ ...desktop, env: { OMPANEL_CLI_PATH: path.join(home, "gone") } }),
      ).toBe('sudo env "PATH=$PATH" ompanel browser setup');
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("host CLI commands", (it) => {
  it.effect("renders a PowerShell command line on Windows", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped();
      const shim = path.join(home, "ompanel.cmd");
      yield* fs.writeFileString(shim, "@echo off\r\n");
      const hostCommand = (platform: NodeJS.Platform, env: Record<string, string>) =>
        resolveHostCliCommand("doctor", ["--base-dir", "C:\\Users\\Jane Doe\\.ompanel"]).pipe(
          Effect.provideService(
            HostProcess.ExecutablePath,
            "C:\\Program Files\\Ompanel\\ompanel.exe",
          ),
          Effect.provideService(HostProcess.Arguments, [
            "C:\\Program Files\\Ompanel\\ompanel.exe",
            "C:\\Program Files\\Ompanel\\resources\\app.asar\\apps\\server\\dist\\bin.mjs",
          ]),
          Effect.provideService(HostProcess.IsExecutable, false),
          Effect.provideService(HostProcess.Platform, platform),
          Effect.provideService(HostProcess.Environment, { PATH: "", ...env }),
        );
      expect((yield* hostCommand("win32", { OMPANEL_CLI_PATH: shim })).command).toBe(
        `& "${shim}" doctor "--base-dir" "C:\\Users\\Jane Doe\\.ompanel"`,
      );
      expect((yield* hostCommand("win32", {})).command).toBe(
        'ompanel doctor "--base-dir" "C:\\Users\\Jane Doe\\.ompanel"',
      );
      expect(
        (yield* resolveHostCliCommand("doctor", ["--base-dir", "C:\\T3\\\u201CArchive\u201D"]).pipe(
          Effect.provideService(HostProcess.Platform, "win32"),
          Effect.provideService(HostProcess.Environment, { PATH: "" }),
          Effect.provideService(HostProcess.ExecutablePath, "C:\\ompanel.exe"),
          Effect.provideService(HostProcess.Arguments, ["C:\\ompanel.exe", "C:\\bin.mjs"]),
          Effect.provideService(HostProcess.IsExecutable, false),
        )).command,
      ).toBe('ompanel doctor "--base-dir" "C:\\T3\\\u201C\u201CArchive\u201D\u201D"');
      expect((yield* hostCommand("linux", { OMPANEL_CLI_PATH: shim })).command).toMatch(
        / doctor --base-dir 'C:\\Users\\Jane Doe\\\.ompanel'$/,
      );
    }).pipe(Effect.scoped),
  );
});

it.layer(NodeServices.layer)("manual server installation ownership", (it) => {
  it.effect("recognizes runner caches for script packages and the npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const executable = path.join(root, ".ompanel/runtime/versions/1.0.0/ompanel");
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.writeFileString(executable, "");
      for (const [relative, kind] of [
        ["npm/_npx/hash/node_modules/ompanel/dist/bin.mjs", "npx"],
        ["npm/_npx/hash/node_modules/ompanel/bin/ompanel.mjs", "npx"],
        ["pnpm/dlx/hash/node_modules/ompanel/dist/bin.mjs", "pnpm-dlx"],
        [".bun/install/cache/ompanel/dist/bin.mjs", "bunx"],
      ] as const) {
        const entry = path.join(root, relative);
        yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
        yield* fs.writeFileString(entry, "");
        yield* fs.writeFileString(
          path.join(path.dirname(entry), "../package.json"),
          `{"name":"ompanel","version":"${packageJson.version}","bin":{"ompanel":"./bin/ompanel.mjs"}}`,
        );
        const launchedBy = entry.endsWith("ompanel.mjs");
        const installation = yield* resolveServerInstallation.pipe(
          Effect.provideService(HostProcess.Arguments, [launchedBy ? executable : "node", entry]),
          Effect.provideService(HostProcess.ExecutablePath, executable),
          Effect.provideService(HostProcess.IsExecutable, launchedBy),
          Effect.provideService(
            HostProcess.Environment,
            launchedBy ? { OMPANEL_NPM_LAUNCHER_PATH: entry } : {},
          ),
        );
        expect(installation).toEqual({ kind });
      }
    }),
  );

  it.effect("requires the npm prefix's bin to point to the running package", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/ompanel");
      const entry = path.join(packageRoot, "dist/bin.mjs");
      const globalBin = path.join(prefix, "bin/ompanel");
      yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
      yield* fs.makeDirectory(path.dirname(globalBin), { recursive: true });
      yield* fs.writeFileString(entry, "");
      yield* fs.writeFileString(
        path.join(packageRoot, "package.json"),
        '{"name":"ompanel","version":"0.0.45","bin":{"ompanel":"./dist/bin.mjs"}}',
      );
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.Arguments, ["node", entry]),
        Effect.provideService(HostProcess.IsExecutable, false),
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      expect(yield* resolve).toBeNull();
      yield* fs.symlink(entry, globalBin);
      expect(yield* resolve).toEqual({ kind: "npm-global", prefix });
      yield* fs.remove(globalBin);
      yield* fs.writeFileString(globalBin, "an unrelated ompanel command");
      expect(yield* resolve).toBeNull();
      expect(yield* resolve.pipe(Effect.provideService(HostProcess.Platform, "win32"))).toBeNull();
    }),
  );

  it.effect("proves the downloaded executable was started by a global npm launcher", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      const prefix = path.join(root, "bunx-tools");
      const packageRoot = path.join(prefix, "lib/node_modules/ompanel");
      const launcher = path.join(packageRoot, "bin/ompanel.mjs");
      const executable = path.join(root, ".ompanel/runtime/versions/1.0.0/ompanel");
      yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
      yield* fs.makeDirectory(path.dirname(executable), { recursive: true });
      yield* fs.makeDirectory(path.join(prefix, "bin"));
      yield* fs.writeFileString(launcher, "");
      yield* fs.writeFileString(executable, "");
      yield* fs.symlink(launcher, path.join(prefix, "bin/ompanel"));
      const resolve = resolveServerInstallation.pipe(
        Effect.provideService(HostProcess.ExecutablePath, executable),
        Effect.provideService(HostProcess.Arguments, [executable, executable]),
        Effect.provideService(HostProcess.IsExecutable, true),
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Environment, { OMPANEL_NPM_LAUNCHER_PATH: launcher }),
      );
      for (const [version, expected] of [
        ["0.0.1", null],
        [packageJson.version, { kind: "npm-global", prefix }],
      ] as const) {
        yield* fs.writeFileString(
          path.join(packageRoot, "package.json"),
          `{"name":"ompanel","version":"${version}","bin":{"ompanel":"./bin/ompanel.mjs"}}`,
        );
        expect(yield* resolve).toEqual(expected);
      }
    }),
  );

  it.effect("leaves local, standalone, missing and unreadable installs unknown", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped();
      for (const relative of [
        "project/node_modules/ompanel/dist/bin.mjs",
        "project/apps/server/dist/bin.mjs",
        ".ompanel/runtime/0.0.45/ompanel",
        "missing/dist/bin.mjs",
      ]) {
        const entry = path.join(root, relative);
        if (!relative.startsWith("missing")) {
          yield* fs.makeDirectory(path.dirname(entry), { recursive: true });
          yield* fs.writeFileString(entry, "");
        }
        expect(
          yield* resolveServerInstallation.pipe(
            Effect.provideService(HostProcess.Arguments, ["node", entry]),
            Effect.provideService(HostProcess.IsExecutable, false),
          ),
        ).toBeNull();
      }
    }),
  );
});
