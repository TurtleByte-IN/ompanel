#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - sha256 of the downloaded sidecar, as the server checks it.
import * as NodeCrypto from "node:crypto";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as NetService from "@t3tools/shared/Net";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { OMP_LOCK, pinnedOmpSidecar } from "@t3tools/provider-omp/sidecar";
import { windowsSystemTar } from "./lib/windows-tar.ts";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

// The first-run sidecar download is ~100 MB; a cold runner can take a while.
const OMP_DOWNLOAD_TIMEOUT = Duration.minutes(5);
// windows-latest answers / 1.5-3 s after spawn (70 runs, #192); a crash ends the wait early.
const READY_TIMEOUT = Duration.seconds(30);

// Windows reports a crash as an NTSTATUS exit code, such as 0xC0000374 for heap corruption.
const describeExit = (code: number) =>
  code > 0xffff ? `code ${String(code)} (0x${code.toString(16).toUpperCase()})` : `code ${String(code)}`;

export class CliArchiveSmokeError extends Schema.TaggedError<CliArchiveSmokeError>()(
  "CliArchiveSmokeError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `CLI archive smoke test failed while ${this.step}: ${this.detail}`;
  }
}

const collect = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

const runExecutable = Effect.fn("runExecutable")(function* (
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const child = yield* spawner.spawn(
    ChildProcess.make(executable, args, {
      cwd,
      // Isolate system Node and inherited launcher context from the archive smoke check.
      env: { PATH: "", HOME: cwd, USERPROFILE: cwd, TMPDIR: cwd, TEMP: cwd },
      extendEnv: false,
    }),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [collect(child.stdout), collect(child.stderr), child.exitCode.pipe(Effect.map(Number))],
    { concurrency: "unbounded" },
  );
  return { stdout, stderr, exitCode };
});

const smokeCliArchive = Effect.fn("smokeCliArchive")(function* (input: {
  readonly archive: Option.Option<string>;
  readonly executable: Option.Option<string>;
  readonly expectVersion: string;
  readonly ompSidecar: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scratch = yield* fs.makeTempDirectory({ prefix: "t3-cli-smoke-" });
  // Windows can briefly retain executable locks; cleanup retries but must not fail a successful smoke check.
  yield* Effect.addFinalizer(() =>
    fs.remove(scratch, { recursive: true }).pipe(
      Effect.retry({ times: 10, schedule: Schedule.spaced("500 millis") }),
      Effect.catch((error) =>
        Effect.logWarning(`[cli-smoke] could not remove ${scratch}: ${error.message}`),
      ),
    ),
  );

  const executableName = platform === "win32" ? "ompanel.exe" : "ompanel";
  let contentDir: string;
  if (Option.isSome(input.executable)) {
    // An installed CLI (scripts/install.sh links the executable into its bin directory).
    contentDir = path.dirname(yield* fs.realPath(input.executable.value));
  } else if (Option.isSome(input.archive)) {
    // Windows bsdtar reads zip; Git Bash's GNU tar does not.
    const tar = platform === "win32" ? windowsSystemTar() : "tar";
    const extract = yield* spawner
      .spawn(ChildProcess.make(tar, ["-xf", input.archive.value, "-C", scratch]))
      .pipe(Effect.flatMap((child) => child.exitCode));
    if (Number(extract) !== 0) {
      return yield* new CliArchiveSmokeError({
        step: "extracting the archive",
        detail: `tar exited with ${String(extract)}`,
      });
    }
    const [extracted] = yield* fs.readDirectory(scratch);
    if (extracted === undefined) {
      return yield* new CliArchiveSmokeError({
        step: "extracting the archive",
        detail: "the archive was empty",
      });
    }
    contentDir = path.join(scratch, extracted);
  } else {
    return yield* new CliArchiveSmokeError({
      step: "reading the arguments",
      detail: "pass --archive or --executable",
    });
  }
  const root = path.basename(contentDir);
  const executable = path.join(contentDir, executableName);
  for (const required of [executable, path.join(contentDir, "client/index.html")]) {
    if (!(yield* fs.exists(required))) {
      return yield* new CliArchiveSmokeError({
        step: "checking the archive layout",
        detail: `missing ${path.relative(contentDir, required)}`,
      });
    }
  }

  const version = yield* runExecutable(executable, ["--version"], contentDir);
  if (version.exitCode !== 0 || !version.stdout.includes(input.expectVersion)) {
    return yield* new CliArchiveSmokeError({
      step: "running --version",
      detail: `exit ${String(version.exitCode)}\n${version.stdout}${version.stderr}`,
    });
  }

  const net = yield* NetService.NetService;
  const port = yield* net.findAvailablePort(47700);
  const home = path.join(scratch, "home");
  // OMP enabled with no binary path: the server must download the pinned sidecar on its own,
  // as a fresh web/server install does (docs/omp/sidecar.md#first-run-download-web-and-server).
  const pinned = input.ompSidecar
    ? yield* pinnedOmpSidecar(OMP_LOCK).pipe(
        Effect.mapError(
          (cause) =>
            new CliArchiveSmokeError({
              step: "resolving the pinned sidecar",
              detail: cause.detail,
            }),
        ),
      )
    : undefined;
  if (pinned !== undefined) {
    yield* fs.makeDirectory(path.join(home, "userdata"), { recursive: true });
    yield* fs.writeFileString(
      path.join(home, "userdata", "settings.json"),
      '{"providerInstances":{"omp":{"driver":"omp","enabled":true}}}\n',
    );
  }
  const server = yield* spawner.spawn(
    ChildProcess.make(
      executable,
      ["serve", "--host", "127.0.0.1", "--port", String(port), "--no-browser"],
      {
        cwd: contentDir,
        env: {
          PATH: "",
          HOME: home,
          USERPROFILE: home,
          TMPDIR: scratch,
          TEMP: scratch,
          OMPANEL_HOME: home,
          // The archive has a release channel built in, so its events would
          // look like a real new install.
          OMPANEL_TELEMETRY_ENABLED: "false",
        },
        extendEnv: false,
      },
    ),
  );
  const output = yield* Effect.forkScoped(
    Effect.all([collect(server.stdout), collect(server.stderr)]),
  );
  const httpClient = yield* HttpClient.HttpClient;
  // Probes can hang during server initialization; bound each request as SSH readiness does.
  const probe = httpClient.execute(HttpClientRequest.get(`http://127.0.0.1:${String(port)}/`)).pipe(
    Effect.map((response) => response.status === 200),
    Effect.timeout(Duration.seconds(2)),
    Effect.orElseSucceed(() => false),
  );
  const pollUntilReady = Effect.gen(function* () {
    while (!(yield* probe)) {
      yield* Effect.sleep(Duration.millis(250));
    }
    return true;
  });
  // A server that dies answers nothing; report its exit status rather than waiting out the budget.
  const exited = server.exitCode.pipe(
    Effect.map((code) => ({ _tag: "Exited" as const, code: Number(code) })),
    Effect.orElseSucceed(() => ({ _tag: "Exited" as const, code: -1 })),
  );
  const start = yield* Effect.raceFirst(
    exited,
    pollUntilReady.pipe(
      Effect.timeout(READY_TIMEOUT),
      Effect.as({ _tag: "Ready" as const }),
      Effect.orElseSucceed(() => ({ _tag: "TimedOut" as const })),
    ),
  );
  const cachedSidecar =
    pinned === undefined ? undefined : path.join(home, "tools", "omp", OMP_LOCK.tag, pinned.asset);
  // The server renames the download into place only after its sha256 matched; hash it again here.
  const sidecarDigest = Effect.gen(function* () {
    if (cachedSidecar === undefined || !(yield* fs.exists(cachedSidecar))) return undefined;
    const bytes = yield* fs.readFile(cachedSidecar);
    return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  }).pipe(Effect.orElseSucceed(() => undefined));
  const downloaded =
    start._tag !== "Ready" || pinned === undefined
      ? undefined
      : yield* Effect.raceFirst(
          exited,
          Effect.gen(function* () {
            let digest = yield* sidecarDigest;
            while (digest === undefined) {
              yield* Effect.sleep(Duration.seconds(1));
              digest = yield* sidecarDigest;
            }
            return digest;
          }).pipe(Effect.timeoutOption(OMP_DOWNLOAD_TIMEOUT)),
        );
  yield* server.kill({ killSignal: "SIGTERM" }).pipe(Effect.ignore);
  yield* server.exitCode.pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
  const [stdout, stderr] = yield* Fiber.join(output).pipe(
    Effect.timeout(Duration.seconds(5)),
    Effect.orElseSucceed(() => ["", ""] as const),
  );
  if (start._tag === "Exited") {
    return yield* new CliArchiveSmokeError({
      step: "serving from the extracted archive",
      detail: `the server exited with ${describeExit(start.code)} before / answered\n${stdout}${stderr}`,
    });
  }
  if (start._tag === "TimedOut") {
    return yield* new CliArchiveSmokeError({
      step: "serving from the extracted archive",
      detail: `no 200 from / within ${Duration.format(READY_TIMEOUT)}\n${stdout}${stderr}`,
    });
  }
  if (pinned !== undefined && downloaded !== undefined) {
    if (!Option.isOption(downloaded)) {
      return yield* new CliArchiveSmokeError({
        step: "downloading the OMP sidecar",
        detail: `the server exited with ${describeExit(downloaded.code)} before ${cachedSidecar} appeared\n${stdout}${stderr}`,
      });
    }
    if (Option.isNone(downloaded)) {
      return yield* new CliArchiveSmokeError({
        step: "downloading the OMP sidecar",
        detail: `${cachedSidecar} did not appear within ${Duration.format(OMP_DOWNLOAD_TIMEOUT)}\n${stdout}${stderr}`,
      });
    }
    if (downloaded.value !== pinned.sha256) {
      return yield* new CliArchiveSmokeError({
        step: "downloading the OMP sidecar",
        detail: `${cachedSidecar} has sha256 ${downloaded.value}; omp.lock pins ${pinned.sha256}`,
      });
    }
    yield* Effect.log(
      `[cli-smoke] ${root}: downloaded ${OMP_LOCK.tag} ${pinned.asset} (sha256 ${downloaded.value}).`,
    );
  }
  yield* Effect.log(`[cli-smoke] ${root}: --version passed and serve answered on ${String(port)}.`);
});

const command = Command.make(
  "smoke-cli-archive",
  {
    archive: Flag.String("archive").pipe(Flag.optional),
    executable: Flag.String("executable").pipe(
      Flag.optional,
      Flag.withDescription("An installed CLI to test instead of an archive."),
    ),
    expectVersion: Flag.String("expect-version"),
    ompSidecar: Flag.Boolean("omp-sidecar").pipe(
      Flag.withDescription("Also require the server to download the pinned OMP sidecar."),
      Flag.withDefault(false),
    ),
  },
  (input) => smokeCliArchive(input).pipe(Effect.scoped),
).pipe(Command.withDescription("Run a CLI archive's or an installed CLI's executable."));

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
