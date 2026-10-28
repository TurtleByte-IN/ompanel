// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  hardenSpawnEnvironment,
  nonexistentCommandPath,
  resolveTrustedCommandSync,
  SpawnExecutableResolution,
  type SpawnExecutableResolver,
} from "@t3tools/shared/shell";
import type {
  SpawnedProcess as ClaudeSpawnedProcess,
  SpawnOptions as ClaudeSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Node 20.12+ cannot spawn Windows launcher scripts without a shell; the SDK cannot use these as executables. */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

export const isWindowsClaudeLauncherShimPath = (filePath: string): boolean =>
  WINDOWS_SHIM_EXTENSIONS.has(NodePath.win32.extname(filePath).toLowerCase());

/** New packages provide bin/claude.exe; older packages need a JavaScript runtime for cli.js. */
const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

export type ExecutableFileCheck = (filePath: string) => boolean;

function isExistingFile(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export const ClaudeExecutableFileCheck = Context.Reference<ExecutableFileCheck>(
  "server/provider/Drivers/ClaudeExecutableFileCheck",
  {
    defaultValue: () => isExistingFile,
  },
);

/** On Windows the SDK skips shell and PATH/PATHEXT lookup: bare names and .cmd shims fail. */
export const resolveClaudeSdkExecutablePath = Effect.fn("resolveClaudeSdkExecutablePath")(
  function* (binaryPath: string, environment: NodeJS.ProcessEnv): Effect.fn.Return<string> {
    const platform = yield* HostProcess.Platform;
    if (platform !== "win32") {
      return binaryPath;
    }

    const resolveExecutable = yield* SpawnExecutableResolution;
    const isFile = yield* ClaudeExecutableFileCheck;
    const explicitPath = binaryPath.includes("/") || binaryPath.includes("\\");
    // A bare name the SDK would look up in the thread's repository must not survive a miss.
    const resolved =
      resolveExecutable(binaryPath, platform, environment) ??
      (explicitPath ? binaryPath : nonexistentCommandPath(binaryPath, platform, environment));
    const extension = NodePath.win32.extname(resolved).toLowerCase();
    if (!WINDOWS_SHIM_EXTENSIONS.has(extension)) {
      return resolved;
    }

    const shimDirectory = NodePath.win32.dirname(resolved);
    for (const entrySegments of NPM_PACKAGE_ENTRY_CANDIDATES) {
      const candidate = NodePath.win32.join(shimDirectory, ...entrySegments);
      if (isFile(candidate)) {
        return candidate;
      }
    }

    yield* Effect.logWarning(
      "Claude launcher shim resolved but no known package entry was found next to it; the Claude Agent SDK cannot spawn launcher scripts directly.",
      { binaryPath, resolvedShimPath: resolved },
    );
    return resolved;
  },
);

/**
 * The CLI runs in the thread's repository, so neither the `node` the SDK starts for a script
 * entry nor the PATH it searches may be answered from there: the command is resolved against the
 * absolute PATH entries, and the environment loses its relative ones.
 */
export function hardenClaudeSpawnOptions(
  options: ClaudeSpawnOptions,
  platform: NodeJS.Platform,
  resolveExecutable: SpawnExecutableResolver,
): ClaudeSpawnOptions {
  const env = hardenSpawnEnvironment(options.env, platform);
  return {
    ...options,
    env,
    command: resolveTrustedCommandSync(options.command, platform, env, resolveExecutable),
  };
}

/** A `spawnClaudeCodeProcess` for SDK calls that have no process-group handling of their own. */
export function makeHardenedClaudeSpawn(
  platform: NodeJS.Platform,
  resolveExecutable: SpawnExecutableResolver,
  onStderr?: (chunk: string) => void,
): (options: ClaudeSpawnOptions) => ClaudeSpawnedProcess {
  return (unsafeOptions) => {
    const options = hardenClaudeSpawnOptions(unsafeOptions, platform, resolveExecutable);
    const child = NodeChildProcess.spawn(options.command, options.args, {
      cwd: options.cwd,
      env: options.env,
      signal: options.signal,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => onStderr?.(chunk));
    return child;
  };
}
