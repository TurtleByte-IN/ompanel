#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeModule from "node:module";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { DesktopBackendBootstrap } from "@t3tools/contracts";
import { waitForHttpReady } from "@t3tools/shared/httpReadiness";
import * as NetService from "@t3tools/shared/Net";

// apps/desktop/src/backend/DesktopBackendManager.ts waits for this path before it uses a backend.
const READINESS_PATH = "/.well-known/t3/environment";
const encodeBootstrapJson = Schema.encodeEffect(Schema.fromJsonString(DesktopBackendBootstrap));

export class ServerBootSmokeError extends Schema.TaggedError<ServerBootSmokeError>()(
  "ServerBootSmokeError",
  { target: Schema.String, step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Server boot smoke test failed for ${this.target} while ${this.step}: ${this.detail}`;
  }
}

interface BootTarget {
  readonly name: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string>;
  // Sent on fd 3, as the desktop app delivers its backend bootstrap.
  readonly bootstrap?: DesktopBackendBootstrap;
}

const bootTarget = Effect.fn("bootTarget")(function* (
  target: BootTarget,
  input: { readonly port: number; readonly readyTimeout: number; readonly stableFor: number },
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const output: string[] = [];
  const fail = (step: string, detail: string) =>
    new ServerBootSmokeError({
      target: target.name,
      step,
      detail: `${detail}\n--- backend output ---\n${output.join("\n")}`,
    });

  const bootstrapJson =
    target.bootstrap === undefined ? undefined : yield* encodeBootstrapJson(target.bootstrap);
  const child = yield* spawner.spawn(
    ChildProcess.make(target.executable, target.args, {
      env: target.env,
      extendEnv: true,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      killSignal: "SIGTERM",
      forceKillAfter: Duration.seconds(5),
      ...(bootstrapJson === undefined
        ? {}
        : {
            additionalFds: {
              fd3: { type: "input", stream: Stream.encodeText(Stream.make(`${bootstrapJson}\n`)) },
            },
          }),
    }),
  );
  yield* child.all.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.sync(() => {
        output.push(line);
        process.stdout.write(`[${target.name}] ${line}\n`);
      }),
    ),
    Effect.ignore,
    Effect.forkScoped,
  );

  // A backend that exits is a failure whenever it happens: the desktop app would restart it in a loop.
  const exited = child.exitCode.pipe(
    Effect.map((code) => ({ _tag: "Exited" as const, code: Number(code) })),
    Effect.orElseSucceed(() => ({ _tag: "Exited" as const, code: -1 })),
  );
  const answers = (timeoutMs: number) =>
    waitForHttpReady({
      baseUrl: `http://127.0.0.1:${String(input.port)}`,
      path: READINESS_PATH,
      timeoutMs,
      intervalMs: 250,
      makeError: ({ requestUrl }) =>
        new ServerBootSmokeError({ target: target.name, step: "probing", detail: requestUrl }),
    }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  const ready = answers(input.readyTimeout * 1000).pipe(
    Effect.map((answered) => ({ _tag: answered ? ("Ready" as const) : ("TimedOut" as const) })),
  );

  const start = yield* Effect.raceFirst(exited, ready);
  if (start._tag === "Exited") {
    return yield* fail("starting", `exited with code ${String(start.code)} before it answered`);
  }
  if (start._tag === "TimedOut") {
    return yield* fail(
      "starting",
      `no 200 from ${READINESS_PATH} within ${String(input.readyTimeout)}s`,
    );
  }
  yield* Effect.log(`[server-boot-smoke] ${target.name}: ready on ${String(input.port)}`);

  const settled = yield* Effect.raceFirst(
    exited,
    Effect.sleep(Duration.seconds(input.stableFor)).pipe(Effect.as({ _tag: "Up" as const })),
  );
  if (settled._tag === "Exited") {
    return yield* fail(
      "staying up",
      `exited with code ${String(settled.code)} after it became ready`,
    );
  }
  const stillReady = yield* answers(5_000);
  if (!stillReady) {
    return yield* fail(
      "staying up",
      `${READINESS_PATH} stopped answering after ${String(input.stableFor)}s`,
    );
  }

  yield* child.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
  yield* Effect.log(
    `[server-boot-smoke] ${target.name}: stayed up ${String(input.stableFor)}s and answered ${READINESS_PATH}.`,
  );
});

const smokeServerBoot = Effect.fn("smokeServerBoot")(function* (input: {
  readonly targets: ReadonlyArray<"node" | "electron">;
  readonly readyTimeout: number;
  readonly stableFor: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const net = yield* NetService.NetService;
  const repoRoot = yield* path.fromFileUrl(new URL("..", import.meta.url));
  const entry = path.join(repoRoot, "apps/server/dist/bin.mjs");
  if (!(yield* fs.exists(entry))) {
    return yield* new ServerBootSmokeError({
      target: "all",
      step: "locating the build",
      detail: `${entry} is missing; run \`vp run --filter t3 build\` first`,
    });
  }

  for (const name of input.targets) {
    const scratch = yield* fs.makeTempDirectoryScoped({ prefix: `t3-server-boot-${name}-` });
    const home = path.join(scratch, "home");
    const port = yield* net.findAvailablePort(47800);
    // Isolate the data directory and keep smoke runs out of telemetry.
    const env = {
      HOME: scratch,
      USERPROFILE: scratch,
      OMPANEL_HOME: home,
      OMPANEL_TELEMETRY_ENABLED: "false",
    };
    const target: BootTarget =
      name === "node"
        ? {
            // The CLI and `pnpm start`: plain Node runs the bundle.
            name,
            executable: process.execPath,
            args: [entry, "serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
            env,
          }
        : {
            // `pnpm dev:desktop` and the packaged app: Electron's Node runs the bundle with a fd 3 bootstrap.
            name,
            executable: NodeModule.createRequire(path.join(repoRoot, "apps/desktop/package.json"))(
              "electron",
            ) as string,
            args: [entry, "--bootstrap-fd", "3"],
            env: { ...env, ELECTRON_RUN_AS_NODE: "1" },
            bootstrap: {
              mode: "desktop",
              noBrowser: true,
              port,
              t3Home: home,
              host: "127.0.0.1",
              desktopBootstrapToken: NodeCrypto.randomBytes(32).toString("base64url"),
              shellEnvironmentPrepared: true,
              tailscaleServeEnabled: false,
              tailscaleServePort: 443,
            },
          };
    yield* bootTarget(target, { port, ...input }).pipe(Effect.scoped);
  }
});

const command = Command.make(
  "smoke-server-boot",
  {
    target: Flag.Literals("target", ["node", "electron"]).pipe(
      Flag.atLeast(1),
      Flag.withDescription("Runtime to boot apps/server/dist/bin.mjs under; repeat for both."),
    ),
    readyTimeout: Flag.Int("ready-timeout").pipe(
      Flag.withDescription("Seconds to wait for the readiness endpoint."),
      Flag.withDefault(90),
    ),
    stableFor: Flag.Int("stable-for").pipe(
      Flag.withDescription("Seconds the backend must stay up after it is ready."),
      Flag.withDefault(15),
    ),
  },
  (input) =>
    smokeServerBoot({
      targets: input.target,
      readyTimeout: input.readyTimeout,
      stableFor: input.stableFor,
    }).pipe(Effect.scoped),
).pipe(
  Command.withDescription(
    "Boot the built server under Node and Electron and fail unless it answers and stays up.",
  ),
);

if (import.meta.main) {
  Command.run(command, { version: "0.0.0" }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Logger.layer([Logger.consolePretty()]),
        NodeServices.layer,
        NetService.layer,
        FetchHttpClient.layer,
      ),
    ),
    NodeRuntime.runMain,
  );
}
