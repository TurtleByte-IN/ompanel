/**
 * Types a command into a T3 terminal's interactive shell and detects when it finishes, with its
 * exit code, across posix shells, fish and PowerShell. The PTY reports no per-command status, so
 * the command is wrapped to print a random per-run sentinel carrying `$?` once it ends.
 */
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";

import type * as TerminalManager from "./Manager.ts";

export interface TerminalCommandCompletion {
  /** `null` when the terminal exited or closed, or the run was abandoned, before the sentinel. */
  readonly exitCode: number | null;
  readonly durationMs: number;
}

const PARTIAL_LINE_MAX_LENGTH = 4_096;

// Random per-run tokens prevent command output from spoofing completion.
export function completionSentinel(prefix: string, token: string): string {
  return `${prefix}_${token}:`;
}

export function completionSentinelPattern(prefix: string, token: string): RegExp {
  return new RegExp(`${prefix}_${token}:(-?\\d+)`);
}

export function stripTerminalControl(text: string): string {
  return (
    text
      .replace(
        // eslint-disable-next-line no-control-regex -- ANSI escape sequences start with ESC.
        /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]/g,
        "",
      )
      // eslint-disable-next-line no-control-regex -- removing control characters is the point.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
  );
}

// Line editors (zsh, fish, bash 5.1+) enable bracketed paste when they start reading a command.
const BRACKETED_PASTE_ON = "\x1b[?2004h";
const BRACKETED_PASTE_OFF = "\x1b[?2004l";
// Longer than one subprocess poll plus its ps timeout, so a startup prompt is seen as busy first.
const SHELL_QUIET_FALLBACK = "3 seconds";

function lineEditorReading(text: string, previous: boolean): boolean {
  const on = text.lastIndexOf(BRACKETED_PASTE_ON);
  const off = text.lastIndexOf(BRACKETED_PASTE_OFF);
  return on === off ? previous : on > off;
}

export type CompletionShell = "posix" | "fish" | "powershell";

export function resolveCompletionShell(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): CompletionShell {
  if (platform === "win32") return "powershell";
  const shell = env.SHELL ?? "";
  const name = shell.split("/").at(-1) ?? shell;
  if (name === "fish") return "fish";
  if (name === "pwsh" || name === "powershell") return "powershell";
  return "posix";
}

// A block with its own closing line protects the sentinel from trailing comments, heredocs and scripts reading stdin.
export function wrapCommandForCompletion(
  command: string,
  shell: CompletionShell,
  sentinel: string,
): string {
  const body = command.replace(/\r?\n/g, "\r");
  switch (shell) {
    case "powershell":
      return `$global:LASTEXITCODE = $null; & {\r${body}\r}; if ($null -ne $LASTEXITCODE) { $__t3c = $LASTEXITCODE } elseif ($?) { $__t3c = 0 } else { $__t3c = 1 }; Write-Host "${sentinel}$__t3c"`;
    case "fish":
      return `begin\r${body}\rend; printf '\\n${sentinel}%s\\n' $status`;
    case "posix":
      return `( ${body}\r); printf '\\n${sentinel}%s\\n' "$?"`;
  }
}

export interface ObserveTerminalCompletionInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly sentinel: string;
  readonly sentinelPattern: RegExp;
  /** The shell echoes typed input; lines ending with these are the wrapper, not output. */
  readonly echoedWrapperLines: ReadonlyArray<string>;
  readonly onOutputLine: ((line: string) => Effect.Effect<void>) | undefined;
  /** Drop lines after the command finished: the shell's redrawn prompt, not command output. */
  readonly ignoreOutputAfterExit?: boolean;
}

export interface WatchShellReadinessInput {
  readonly threadId: string;
  readonly terminalId: string;
  readonly onStartupPrompt: Effect.Effect<void>;
}

/** Listeners on `terminalManager`; subscribe both before opening the terminal or writing to it. */
export const makeTerminalCommandObserver = (
  terminalManager: TerminalManager.TerminalManager["Service"],
  options: {
    /** Cleaned output lines longer than this are cut. */
    readonly outputLineMaxLength: number;
  },
) => {
  const observeTerminalCompletion = Effect.fn("TerminalCommand.observeTerminalCompletion")(
    function* (input: ObserveTerminalCompletionInput) {
      const startedAtMs = yield* Clock.currentTimeMillis;
      const done = yield* Deferred.make<TerminalCommandCompletion>();
      // Wait for the prompt redraw; closing earlier mistakes it for activity and preserves an idle shell.
      const promptReturned = yield* Deferred.make<void>();
      let lineBuffer = "";
      let settled = false;

      const settle = (exitCode: number | null) =>
        Effect.suspend(() => {
          if (settled) return Effect.void;
          settled = true;
          return Clock.currentTimeMillis.pipe(
            Effect.flatMap((nowMs) =>
              Deferred.succeed(done, { exitCode, durationMs: nowMs - startedAtMs }),
            ),
            Effect.asVoid,
          );
        });

      const handleLine = (rawLine: string) =>
        Effect.suspend(() => {
          if (settled && input.ignoreOutputAfterExit === true) return Effect.void;
          const sentinel = input.sentinelPattern.exec(rawLine);
          if (sentinel) {
            const parsed = Number(sentinel[1]);
            return settle(Number.isFinite(parsed) ? parsed : null);
          }
          const cleaned = stripTerminalControl(rawLine).trimEnd();
          if (
            cleaned.length === 0 ||
            cleaned.includes(input.sentinel) ||
            input.echoedWrapperLines.some((echoed) => cleaned.endsWith(echoed)) ||
            input.onOutputLine === undefined
          ) {
            return Effect.void;
          }
          return input.onOutputLine(cleaned.slice(0, options.outputLineMaxLength));
        });

      const unsubscribe = yield* terminalManager.subscribe((event) => {
        if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
          return Effect.void;
        }
        if (event.type === "output") {
          lineBuffer += event.data;
          // Bare CR redraws progress in place; split redraws instead of growing one line.
          const lines = lineBuffer.split(/\r\n|\r|\n/);
          lineBuffer = lines.pop() ?? "";
          // Bound newline-free output; the sentinel has its own line, so retaining the tail is safe.
          if (lineBuffer.length > PARTIAL_LINE_MAX_LENGTH) {
            lineBuffer = lineBuffer.slice(-PARTIAL_LINE_MAX_LENGTH);
          }
          return Effect.forEach(lines, handleLine, { discard: true }).pipe(
            Effect.andThen(
              Effect.suspend(() =>
                settled && lineBuffer.length > 0
                  ? Deferred.succeed(promptReturned, undefined).pipe(Effect.asVoid)
                  : Effect.void,
              ),
            ),
          );
        }
        if (event.type === "exited" || event.type === "closed") {
          return settle(null).pipe(Effect.andThen(Deferred.succeed(promptReturned, undefined)));
        }
        return Effect.void;
      });

      /** Waits for the command and the prompt after it; stays subscribed, even when interrupted. */
      const finished = Deferred.await(done).pipe(
        // A shell with an empty prompt never prints one; do not wait forever.
        Effect.tap(() => Deferred.await(promptReturned).pipe(Effect.timeoutOption("1 second"))),
      );
      const completion = finished.pipe(Effect.ensuring(Effect.sync(() => unsubscribe())));
      // A prompt waiting for input sits on a line that has no newline yet.
      const flushPartialLine = Effect.suspend(() => {
        const partial = lineBuffer;
        lineBuffer = "";
        return handleLine(partial);
      });
      const abandon = settle(null).pipe(
        Effect.andThen(Deferred.succeed(promptReturned, undefined)),
      );
      return { completion, finished, unsubscribe, flushPartialLine, abandon };
    },
  );

  // Input typed during shell startup can be read by an rc-file prompt (fnm, nvm) instead of the
  // shell, which loses the command. Subscribe before the terminal opens so no activity is missed.
  const watchShellReadiness = Effect.fn("TerminalCommand.watchShellReadiness")(function* (
    input: WatchShellReadinessInput,
  ) {
    const outcome = yield* Deferred.make<"ready" | "exited">();
    let reading = false;
    let carry = "";
    let busy = false;
    let activity = 0;
    const unsubscribe = yield* terminalManager.subscribe((event) => {
      if (event.threadId !== input.threadId || event.terminalId !== input.terminalId) {
        return Effect.void;
      }
      activity += 1;
      // A new shell process starts idle; the manager resets its subprocess state without an event.
      if (event.type === "started" || event.type === "restarted") {
        busy = false;
        reading = false;
        carry = "";
      }
      if (event.type === "activity") busy = event.hasRunningSubprocess;
      if (event.type === "output") {
        const text = carry + event.data;
        carry = text.slice(-(BRACKETED_PASTE_ON.length - 1));
        reading = lineEditorReading(text, reading);
      }
      if (event.type === "exited" || event.type === "closed") {
        return Deferred.succeed(outcome, "exited").pipe(Effect.asVoid);
      }
      return reading ? Deferred.succeed(outcome, "ready").pipe(Effect.asVoid) : Effect.void;
    });
    // A startup prompt runs as a child process, so a busy shell keeps waiting for the user.
    const quiet = Effect.gen(function* () {
      while (true) {
        const seen = activity;
        yield* Effect.sleep(SHELL_QUIET_FALLBACK);
        if (activity !== seen) continue;
        if (!busy) return "ready" as const;
        yield* input.onStartupPrompt;
      }
    });
    // Restored history can hold a previous shell's line editor state, so only live output counts.
    const wait = Deferred.await(outcome).pipe(Effect.raceFirst(quiet));
    return { wait, unsubscribe };
  });

  return { observeTerminalCompletion, watchShellReadiness };
};
