import { ProjectId, type ProjectScript } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  projectScriptRuntimeEnv,
  projectScriptTerminalInput,
  resolveProjectScripts,
  settleProjectScript,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";

import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import {
  completionSentinel,
  completionSentinelPattern,
  makeTerminalCommandObserver,
  resolveCompletionShell,
  wrapCommandForCompletion,
} from "../terminal/TerminalCommand.ts";
import * as ProjectService from "./ProjectService.ts";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly scriptCommand: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly async: boolean;
  /** Null exit code means the terminal exited or closed before the sentinel. */
  readonly completion?: Effect.Effect<ProjectSetupScriptCompletion>;
}

export interface ProjectSetupScriptCompletion {
  readonly exitCode: number | null;
  readonly durationMs: number;
}

export interface ProjectSetupScriptOutputLine {
  readonly line: string;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
  readonly trigger?: "setup" | "settle";
  readonly project?: {
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly scripts: ReadonlyArray<ProjectScript>;
  };
  readonly observeCompletion?: {
    readonly onOutputLine?: (line: string) => Effect.Effect<void>;
  };
}

export class ProjectSetupScriptOperationError extends Schema.TaggedError<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals(["resolveProject", "readSettings", "openTerminal"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedError<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

// Random per-run tokens prevent script output from spoofing completion.
const COMPLETION_SENTINEL_PREFIX = "__T3_SETUP_DONE__";
const OUTPUT_LINE_MAX_LENGTH = 400;

/** @public */
export const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;
  const serviceScope = yield* Effect.scope;
  const completionShell = resolveCompletionShell(
    yield* HostProcess.Platform,
    yield* HostProcess.Environment,
  );
  const { observeTerminalCompletion, watchShellReadiness } = makeTerminalCommandObserver(
    terminalManager,
    { outputLineMaxLength: OUTPUT_LINE_MAX_LENGTH },
  );

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const suppliedProject = input.project;
    const projectById =
      suppliedProject ??
      (input.projectId
        ? yield* projects.getById(ProjectId.make(input.projectId)).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);
    const project =
      suppliedProject ??
      projectById ??
      (input.projectCwd
        ? yield* projects.getByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(
        (cause) =>
          new ProjectSetupScriptOperationError({
            ...errorContext,
            operation: "readSettings",
            cause,
          }),
      ),
    );
    const trigger = input.trigger ?? "setup";
    const scripts = resolveProjectScripts(settings, project);
    const script =
      trigger === "settle" ? settleProjectScript(scripts) : setupProjectScript(scripts);
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    // Earlier settle shells may still run foreground programs; do not type resumed settles into them.
    const terminalId =
      input.preferredTerminalId ??
      (trigger === "settle"
        ? `settle-${script.id}-${(yield* crypto.randomUUIDv4().pipe(Effect.orDie)).slice(0, 8)}`
        : `setup-${script.id}`);
    const cwd = input.worktreePath;
    const env = {
      ...projectScriptRuntimeEnv({
        project: { cwd: project.workspaceRoot },
        worktreePath: input.worktreePath,
      }),
      // Before client attachment, truecolor probes wait for terminal replies nobody can send.
      COLORTERM: "",
    };
    const observe = input.observeCompletion;
    const completionToken = observe
      ? (yield* crypto.randomUUIDv4().pipe(Effect.orDie)).replaceAll("-", "")
      : null;
    const commandLine =
      observe && completionToken
        ? wrapCommandForCompletion(
            script.command,
            completionShell,
            completionSentinel(COMPLETION_SENTINEL_PREFIX, completionToken),
          )
        : script.command;

    // Subscribe before opening so neither startup activity nor the sentinel can race the listeners.
    const observed =
      observe && completionToken
        ? yield* observeTerminalCompletion({
            threadId: input.threadId,
            terminalId,
            sentinel: completionSentinel(COMPLETION_SENTINEL_PREFIX, completionToken),
            sentinelPattern: completionSentinelPattern(COMPLETION_SENTINEL_PREFIX, completionToken),
            echoedWrapperLines: commandLine.split("\r").filter((line) => line.length > 0),
            onOutputLine: observe.onOutputLine,
          })
        : undefined;
    // PowerShell has no line-editor signal; keep its immediate write.
    const readiness =
      completionShell === "powershell"
        ? undefined
        : yield* watchShellReadiness({
            threadId: input.threadId,
            terminalId,
            onStartupPrompt: observed?.flushPartialLine ?? Effect.void,
          });

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "openTerminal",
              cause,
            }),
        ),
        Effect.onError(() =>
          Effect.sync(() => {
            observed?.unsubscribe();
            readiness?.unsubscribe();
          }),
        ),
      );

    // Return once the terminal exists so callers can show it while a startup prompt waits.
    yield* (readiness?.wait ?? Effect.succeed("ready" as const)).pipe(
      Effect.flatMap((shell) =>
        shell === "exited"
          ? Effect.void
          : terminalManager.write({
              threadId: input.threadId,
              terminalId,
              data: projectScriptTerminalInput(commandLine),
            }),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("project script command was not written", {
          ...errorContext,
          terminalId,
          cause,
        }).pipe(Effect.andThen(observed?.abandon ?? Effect.void)),
      ),
      Effect.ensuring(Effect.sync(() => readiness?.unsubscribe())),
      Effect.forkIn(serviceScope),
    );

    const completion = observed?.completion.pipe(
      Effect.tap(({ exitCode }) =>
        exitCode === 0
          ? terminalManager.closeIdle({ threadId: input.threadId, terminalId })
          : Effect.void,
      ),
    );

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      scriptCommand: script.command,
      terminalId,
      cwd,
      async: script.async !== false,
      ...(completion ? { completion } : {}),
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
