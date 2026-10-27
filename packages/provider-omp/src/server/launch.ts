/**
 * The command line of a thread's `omp` process. Every flag here exists on the pinned fork:
 * `--mode rpc-ui` and `--approval-mode` (`cli/flag-tables.ts`), `--profile`
 * (`cli/profile-bootstrap.ts`), repeatable `--config` overlays (`cli/flag-tables.ts`, loaded
 * strictly by `config/settings.ts`), `--cwd` (`cli/flag-tables.ts`).
 */
import type { RuntimeMode } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** OMP's `ApprovalMode` (`tools/approval.ts`). */
export type OmpApprovalMode = "always-ask" | "always-ask-cached" | "write" | "yolo";

const OMP_APPROVAL_MODES: Readonly<Record<string, true>> = {
  "always-ask": true,
  "always-ask-cached": true,
  write: true,
  yolo: true,
} satisfies Record<OmpApprovalMode, true>;

/**
 * The approval mode an `omp` command line sets with `--approval-mode <mode>`, or `undefined`
 * when it sets none or an unknown one. OMP's own default is `yolo` (O-9), so a process without
 * this flag would run every tool unasked: nothing is spawned unless this returns a mode.
 * Wrapped command lines (systemd scope, Windows job launcher) keep omp's argv as a suffix.
 */
export const ompArgsApprovalMode = (args: ReadonlyArray<string>): OmpApprovalMode | undefined => {
  const flag = args.lastIndexOf("--approval-mode");
  if (flag === -1) return undefined;
  const value = args[flag + 1];
  return value !== undefined && OMP_APPROVAL_MODES[value] === true
    ? (value as OmpApprovalMode)
    : undefined;
};

/**
 * T3 runtime mode → OMP approval mode. "Auto" is not offered for OMP (D-014) and runs as
 * Supervised, so a stored "auto" never widens what OMP may do unasked.
 */
export const ompApprovalModeFor = (runtimeMode: RuntimeMode): OmpApprovalMode => {
  switch (runtimeMode) {
    case "full-access":
      return "yolo";
    case "auto-accept-edits":
      return "write";
    case "approval-required":
    case "auto":
      return "always-ask";
  }
};

/**
 * Flags Ompanel sets or relies on for every omp it starts: mode, working directory, profile,
 * config overlay, session choice, approval policy (and what bypasses it), the model it picks per
 * thread or operation, and one-shot actions that exit. A launch argument may not set any of them.
 */
const OMP_RESERVED_LAUNCH_FLAGS: ReadonlyArray<string> = [
  "--mode",
  "--print",
  "-p",
  "--no-ui",
  "--cwd",
  "--profile",
  "--alias",
  "--config",
  "--approval-mode",
  "--auto-approve",
  "--yolo",
  "--plan-yolo",
  "--plan-yolo-into",
  "--session",
  "--session-dir",
  "--no-session",
  "--resume",
  "-r",
  "--restore",
  "--continue",
  "-c",
  "--fork",
  "--from-claude",
  "--from-codex",
  "--goal",
  "--export",
  "--model",
  "--provider",
  "--help",
  "-h",
  "--version",
  "-v",
];

/**
 * OMP's launch flags that take a credential (`--api-key` in `cli/flag-tables.ts`). Saved as a
 * launch argument, the secret would sit in every omp's argv, which other local users can read.
 */
const OMP_CREDENTIAL_LAUNCH_FLAGS: ReadonlyArray<string> = ["--api-key"];

/**
 * OMP's value-less launch flags that a launch argument may use (`VALUELESS_FLAGS` in
 * `cli/flag-tables.ts`, less the reserved ones). A bare token after one of these is a prompt.
 */
const OMP_VALUELESS_LAUNCH_FLAGS: Readonly<Record<string, true>> = {
  "--allow-home": true,
  "--no-tools": true,
  "--no-lsp": true,
  "--no-pty": true,
  "--hide-thinking": true,
  "--advisor": true,
  "--external-thinking": true,
  "--prewalk": true,
  "--no-prewalk": true,
  "--print-thoughts": true,
  "--no-extensions": true,
  "--no-skills": true,
  "--no-rules": true,
  "--no-title": true,
};

export type OmpLaunchArgsResolution =
  | { readonly ok: true; readonly args: ReadonlyArray<string> }
  | { readonly ok: false; readonly message: string };

/**
 * The instance's launch arguments, shell-tokenized. Refuses a flag Ompanel owns and anything OMP
 * would read as a prompt: `--`, or a bare token that is not the value of the flag before it.
 */
export const resolveOmpLaunchArgs = (launchArgs: string): OmpLaunchArgsResolution => {
  const args = tokenizeCliArgs(launchArgs);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const reserved = OMP_RESERVED_LAUNCH_FLAGS.find(
      (flag) => arg === flag || (flag.startsWith("--") && arg.startsWith(`${flag}=`)),
    );
    if (reserved !== undefined) {
      return {
        ok: false,
        message: `OMP launch argument '${reserved}' is set by Ompanel and cannot be overridden.`,
      };
    }
    const credential = OMP_CREDENTIAL_LAUNCH_FLAGS.find(
      (flag) => arg === flag || arg.startsWith(`${flag}=`),
    );
    if (credential !== undefined) {
      return {
        ok: false,
        message: `OMP launch argument '${credential}' would put a secret on the command line, where other local users can read it. Sign in to OMP or set the key in an environment variable instead.`,
      };
    }
    // Unknown flags may be extension flags that take a value, so only known value-less flags
    // and `--flag=value` forms leave a following bare token as a prompt.
    const previous = index === 0 ? undefined : args[index - 1]!;
    const isValue =
      previous !== undefined &&
      previous.startsWith("-") &&
      previous !== "-" &&
      !previous.includes("=") &&
      OMP_VALUELESS_LAUNCH_FLAGS[previous] !== true;
    if (arg === "--" || ((arg === "-" || !arg.startsWith("-")) && !isValue)) {
      return {
        ok: false,
        message: `OMP launch arguments cannot include a prompt or positional argument ('${arg}').`,
      };
    }
  }
  return { ok: true, args };
};

/**
 * Launch arguments an `omp -p` run keeps. Titles and commit messages run `-p --no-tools
 * --no-extensions` on untrusted text (messages, diffs); `--tools` overrides `--no-tools`, and
 * `-e`/`--extension`, `--hook`, `--plugin-dir` or an extension's own flag load code despite
 * `--no-extensions`. So only flags that change how the model answers, never what it can run,
 * pass; the rest still reach the instance's threads.
 */
const OMP_PRINT_VALUE_FLAGS: Readonly<Record<string, true>> = {
  "--thinking": true,
  "--service-tier": true,
};
const OMP_PRINT_VALUELESS_FLAGS: Readonly<Record<string, true>> = {
  "--hide-thinking": true,
  "--no-lsp": true,
  "--no-pty": true,
  "--no-skills": true,
  "--no-rules": true,
  "--no-title": true,
  "--no-tools": true,
  "--no-extensions": true,
};

/** `args` (already accepted by `resolveOmpLaunchArgs`) less every flag an `omp -p` must not get. */
export const ompPrintLaunchArgs = (args: ReadonlyArray<string>): ReadonlyArray<string> => {
  const kept: Array<string> = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    const equals = arg.indexOf("=");
    if (equals > 0 && OMP_PRINT_VALUE_FLAGS[arg.slice(0, equals)] === true) {
      kept.push(arg);
    } else if (OMP_PRINT_VALUELESS_FLAGS[arg] === true) {
      kept.push(arg);
    } else if (OMP_PRINT_VALUE_FLAGS[arg] === true) {
      kept.push(...args.slice(index, index + 2));
      index += 1;
    } else if (equals === -1 && args[index + 1]?.startsWith("-") === false) {
      // A dropped flag's value: accepted launch args have no bare token that is not one.
      index += 1;
    }
  }
  return kept;
};

export type OmpInstanceLaunchResolution =
  | {
      readonly ok: true;
      /** The environment every omp of the instance runs with. */
      readonly environment: NodeJS.ProcessEnv;
      /**
       * Appended to every `omp --mode rpc|rpc-ui`, and through `ompPrintLaunchArgs` to `omp -p`;
       * never to subcommands.
       */
      readonly launchArgs: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly message: string };

/**
 * How every omp of an instance runs, from its settings. `agentDir` becomes
 * `PI_CODING_AGENT_DIR`; inherited `OMP_PROFILE`/`PI_PROFILE` are dropped since a profile
 * outranks it, and a configured profile beside it is refused for the same reason.
 */
export const resolveOmpInstanceLaunch = (input: {
  readonly agentDir: string;
  readonly launchArgs: string;
  readonly profile: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDir: string;
}): OmpInstanceLaunchResolution => {
  const launchArgs = resolveOmpLaunchArgs(input.launchArgs);
  if (!launchArgs.ok) return launchArgs;
  if (input.agentDir === "") {
    return { ok: true, environment: input.environment, launchArgs: launchArgs.args };
  }
  if (input.profile !== "") {
    return {
      ok: false,
      message:
        "Set either an OMP profile or an agent directory, not both: a profile has its own agent directory.",
    };
  }
  const environment: NodeJS.ProcessEnv = { ...input.environment };
  delete environment["OMP_PROFILE"];
  delete environment["PI_PROFILE"];
  environment["PI_CODING_AGENT_DIR"] = expandHomePath(input.agentDir, input.homeDir);
  return { ok: true, environment, launchArgs: launchArgs.args };
};

export interface OmpSessionLaunch {
  readonly approvalMode: OmpApprovalMode;
  /** Empty for OMP's default profile. */
  readonly profile: string;
  readonly overlayPath: string;
  readonly cwd: string;
  /** The instance's launch arguments, appended after Ompanel's own flags. */
  readonly launchArgs?: ReadonlyArray<string>;
}

/**
 * `omp --mode rpc-ui --approval-mode <m> [--profile <p>] --config <overlay> --cwd <path>
 * [launch args]`.
 */
export const ompSessionArgs = (launch: OmpSessionLaunch): ReadonlyArray<string> => [
  "--mode",
  "rpc-ui",
  "--approval-mode",
  launch.approvalMode,
  ...(launch.profile === "" ? [] : ["--profile", launch.profile]),
  "--config",
  launch.overlayPath,
  "--cwd",
  launch.cwd,
  ...(launch.launchArgs ?? []),
];

/** OMP rejects a missing or non-mapping overlay, so an empty one is an explicit empty mapping. */
export const OMP_EMPTY_OVERLAY = "# Per-thread OMP settings written by Ompanel.\n{}\n";

/** The thread's `--config` overlay; thread ids are opaque, so each keeps to one path segment. */
export const ompThreadOverlayPath = (path: Path.Path, threadsDir: string, threadId: string) =>
  path.join(threadsDir, encodeURIComponent(threadId), "overlay.yml");

/**
 * Makes sure the thread's `--config` overlay (the highest config layer below flags and env)
 * exists, owner-only. An existing overlay holds the thread's settings overrides, so a respawn
 * keeps it.
 */
export const ensureOmpThreadOverlay = Effect.fn("ensureOmpThreadOverlay")(function* (
  overlayPath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(overlayPath), { recursive: true, mode: 0o700 });
  if (yield* fileSystem.exists(overlayPath)) return;
  yield* fileSystem.writeFileString(overlayPath, OMP_EMPTY_OVERLAY, { mode: 0o600 });
});
