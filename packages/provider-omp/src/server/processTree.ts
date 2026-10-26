/**
 * Everything an `omp` session starts dies with it. POSIX: `omp` leads its own process group.
 * Windows: a launcher puts itself in a kill-on-close job object that every descendant inherits,
 * so the tree dies when the launcher does (docs/omp/processes.md).
 */
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { signalProcessGroup } from "@t3tools/provider-core/server/processGroup";

/** Time a tree gets between SIGTERM and SIGKILL. */
export const OMP_TREE_KILL_GRACE = Duration.seconds(2);
const POLL_INTERVAL = Duration.millis(25);

/** C# run by the Windows launcher; kept free of `'@` so it can sit in a PowerShell here-string. */
const JOB_LAUNCHER_CSHARP = String.raw`
using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class OmpanelJobLauncher {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long PerProcessUserTimeLimit;
    public long PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize;
    public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass;
    public uint SchedulingClass;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }

  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemoryLimit;
    public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed;
    public UIntPtr PeakJobMemoryUsed;
  }

  const uint KillOnJobClose = 0x2000;
  const int ExtendedLimitInformation = 9;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObjectW(IntPtr attributes, string name);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits info, uint length);

  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();

  // MSVCRT command-line quoting, so the child sees exactly the arguments it was given.
  static string Quote(string arg) {
    if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return arg;
    StringBuilder quoted = new StringBuilder("\"");
    int backslashes = 0;
    foreach (char c in arg) {
      if (c == '\\') { backslashes++; continue; }
      if (c == '"') quoted.Append('\\', backslashes * 2 + 1);
      else quoted.Append('\\', backslashes);
      backslashes = 0;
      quoted.Append(c);
    }
    quoted.Append('\\', backslashes * 2);
    return quoted.Append('"').ToString();
  }

  public static int Run(string[] argv) {
    // The handle is never closed: it lives exactly as long as this process.
    IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
    if (job == IntPtr.Zero) throw new Win32Exception();
    ExtendedLimits limits = new ExtendedLimits();
    limits.Basic.LimitFlags = KillOnJobClose;
    if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
      throw new Win32Exception();
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) throw new Win32Exception();

    StringBuilder arguments = new StringBuilder();
    for (int i = 1; i < argv.Length; i++) {
      if (i > 1) arguments.Append(' ');
      arguments.Append(Quote(argv[i]));
    }
    // No redirection: the child inherits this process's stdin, stdout and stderr handles.
    ProcessStartInfo start = new ProcessStartInfo(argv[0], arguments.ToString());
    start.UseShellExecute = false;
    Process child = Process.Start(start);
    child.WaitForExit();
    return child.ExitCode;
  }
}
`;

/** PowerShell script the Windows launcher runs: `-File <script> <omp> <args...>`. */
const OMP_JOB_LAUNCHER_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `Add-Type -TypeDefinition @'${JOB_LAUNCHER_CSHARP}'@`,
  "$exitCode = [OmpanelJobLauncher]::Run([string[]]$args)",
  "exit $exitCode",
  "",
].join("\n");

const OMP_JOB_LAUNCHER_FILE = "omp-job-launcher.ps1";

/**
 * A Windows system binary by absolute path. Windows resolves a bare name in the child's working
 * directory before `PATH`, and a session's working directory is the thread's repository, so a
 * `powershell.exe` committed there would run instead (PRD §9).
 */
const windowsSystemBinary = (relativePath: string): string =>
  `${process.env["SystemRoot"] || process.env["windir"] || "C:\\Windows"}\\System32\\${relativePath}`;

export interface OmpLaunchCommand {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/** Wraps an `omp` command in the job-object launcher at `launcherPath`. */
export const ompJobLauncherCommand = (
  launcherPath: string,
  launch: OmpLaunchCommand,
): OmpLaunchCommand => ({
  command: windowsSystemBinary("WindowsPowerShell\\v1.0\\powershell.exe"),
  args: [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-InputFormat",
    "None",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    launcherPath,
    launch.command,
    ...launch.args,
  ],
});

/** Writes the launcher script into `dir` (owner-only) and returns its path. */
export const materializeOmpJobLauncher = Effect.fn("materializeOmpJobLauncher")(function* (
  dir: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(dir, { recursive: true, mode: 0o700 });
  const launcherPath = path.join(dir, OMP_JOB_LAUNCHER_FILE);
  const current = yield* fileSystem
    .readFileString(launcherPath)
    .pipe(Effect.orElseSucceed(() => undefined));
  if (current !== OMP_JOB_LAUNCHER_SCRIPT) {
    yield* fileSystem.writeFileString(launcherPath, OMP_JOB_LAUNCHER_SCRIPT, { mode: 0o600 });
  }
  return launcherPath;
});

/** Whether `pid` (POSIX: or any member of the group it led) still exists. */
export const isOmpTreeAlive = (pid: number, platform: NodeJS.Platform): boolean => {
  try {
    if (platform === "win32") process.kill(pid, 0);
    else signalProcessGroup(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export const isProcessAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const collectText = (stream: Stream.Stream<Uint8Array, unknown>) =>
  stream.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => ""),
  );

const runForText = Effect.fn("OmpProcessTree.runForText")(
  function* (command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const child = yield* spawner.spawn(
      ChildProcess.make(command, [...args], {
        ...(env === undefined ? {} : { env, extendEnv: true }),
        detached: false,
      }),
    );
    const [stdout, code] = yield* Effect.all(
      [collectText(child.stdout), child.exitCode.pipe(Effect.map(Number))],
      { concurrency: "unbounded" },
    );
    return code === 0 ? Option.some(stdout.trim()) : Option.none<string>();
  },
  Effect.scoped,
  Effect.timeoutOption(Duration.seconds(10)),
  Effect.map(Option.flatten),
  Effect.orElseSucceed(() => Option.none<string>()),
);

/**
 * When `pid` started, as an opaque string that differs between two processes that reused the
 * same pid. `null` when the process is gone or the platform gives no answer.
 */
export const readProcessStartTime = Effect.fn("readProcessStartTime")(function* (
  pid: number,
  platform: NodeJS.Platform,
) {
  if (platform === "linux") {
    const fileSystem = yield* FileSystem.FileSystem;
    const stat = yield* fileSystem
      .readFileString(`/proc/${pid}/stat`)
      .pipe(Effect.orElseSucceed(() => ""));
    // Field 22 (starttime) counts from the field after the parenthesised command name.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startTime = fields[19];
    return startTime !== undefined && /^\d+$/.test(startTime) ? `linux:${startTime}` : null;
  }
  if (platform === "win32") {
    const output = yield* runForText(
      windowsSystemBinary("WindowsPowerShell\\v1.0\\powershell.exe"),
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-Process -Id ${pid}).StartTime.ToFileTimeUtc()`,
      ],
    );
    return Option.isSome(output) && /^\d+$/.test(output.value) ? `win32:${output.value}` : null;
  }
  const output = yield* runForText("ps", ["-o", "lstart=", "-p", String(pid)], { LC_ALL: "C" });
  return Option.isSome(output) && output.value.length > 0 ? `ps:${output.value}` : null;
});

const waitUntilGone = Effect.fn("OmpProcessTree.waitUntilGone")(function* (
  pid: number,
  platform: NodeJS.Platform,
  timeout: Duration.Duration,
) {
  const deadline = (yield* Clock.currentTimeMillis) + Duration.toMillis(timeout);
  while (isOmpTreeAlive(pid, platform) && (yield* Clock.currentTimeMillis) < deadline) {
    yield* Effect.sleep(POLL_INTERVAL);
  }
  return !isOmpTreeAlive(pid, platform);
});

/**
 * Kills the tree `pid` heads: POSIX signals its process group (SIGTERM, then SIGKILL after the
 * grace), Windows runs `taskkill /T /F` on it. Only for processes this server did not spawn
 * itself (pidfile sweep); live sessions use their own child handle.
 */
export const killOmpProcessTree = Effect.fn("killOmpProcessTree")(function* (
  pid: number,
  platform: NodeJS.Platform,
) {
  if (platform === "win32") {
    yield* runForText(windowsSystemBinary("taskkill.exe"), ["/PID", String(pid), "/T", "/F"]);
    return yield* waitUntilGone(pid, platform, OMP_TREE_KILL_GRACE);
  }
  try {
    signalProcessGroup(pid, "SIGTERM");
  } catch {
    return !isOmpTreeAlive(pid, platform);
  }
  if (yield* waitUntilGone(pid, platform, OMP_TREE_KILL_GRACE)) return true;
  try {
    signalProcessGroup(pid, "SIGKILL");
  } catch {
    return !isOmpTreeAlive(pid, platform);
  }
  return yield* waitUntilGone(pid, platform, OMP_TREE_KILL_GRACE);
});
