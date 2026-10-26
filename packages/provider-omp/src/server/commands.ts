/**
 * OMP's `/` menu and `$` skills per directory: control discovery, replaced by a thread's pushed
 * `available_commands_update`; skills from `omp skill list`. See docs/omp/commands.md.
 */
import type {
  ServerProviderSkill,
  ServerProviderSlashCommand,
  ServerProviderWorkspaceSnapshot,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type {
  OmpAvailableSlashCommand,
  OmpControlError,
  OmpControlService,
  OmpControlTarget,
  OmpSkillList,
} from "./control.ts";
import type { OmpSidecarError } from "./sidecar.ts";

/** How long a discovered command list or skill list is reused for one directory. */
export const OMP_COMMAND_CATALOG_TTL_MS = 60_000;
/** Directories whose catalogs the provider snapshot carries; the registry keeps as many. */
const MAX_PUBLISHED_WORKSPACES = 16;

/** The fields of `AvailableSlashCommand` the menu uses, from the RPC reply or a pushed frame. */
type AvailableCommand = Pick<OmpAvailableSlashCommand, "name" | "source" | "description"> & {
  readonly input?: { readonly hint?: string | undefined } | undefined;
};

const nonEmpty = (text: string | undefined): string | undefined => {
  const trimmed = text?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
};

/** OMP's command list as menu entries: skill commands dropped, first of each name kept. */
export const ompSlashCommands = (
  commands: ReadonlyArray<AvailableCommand>,
): ReadonlyArray<ServerProviderSlashCommand> => {
  const seen = new Set<string>();
  const result: Array<ServerProviderSlashCommand> = [];
  for (const command of commands) {
    const name = nonEmpty(command.name);
    if (name === undefined || command.source === "skill" || seen.has(name)) continue;
    seen.add(name);
    const description = nonEmpty(command.description);
    const hint = nonEmpty(command.input?.hint);
    result.push({
      name,
      ...(description === undefined ? {} : { description }),
      ...(hint === undefined ? {} : { input: { hint } }),
    });
  }
  return result;
};

/** `omp skill list` entries as composer skills. `hide` skills are kept: OMP hides them from the model only. */
export const ompSkills = (list: OmpSkillList): ReadonlyArray<ServerProviderSkill> => {
  const seen = new Set<string>();
  const result: Array<ServerProviderSkill> = [];
  for (const skill of list.skills) {
    const name = nonEmpty(skill.name);
    const path = nonEmpty(skill.filePath);
    if (name === undefined || path === undefined || seen.has(name)) continue;
    seen.add(name);
    const description = nonEmpty(skill.description);
    // `source` is `<provider>:<level>`; the level is the scope (`user`, `project`).
    const scope = nonEmpty(skill.source.slice(skill.source.lastIndexOf(":") + 1));
    result.push({
      name,
      path,
      enabled: true,
      ...(description === undefined ? {} : { description }),
      ...(scope === undefined ? {} : { scope }),
      ...(skill.hide ? { userInvocationOnly: true } : {}),
    });
  }
  return result;
};

/** A `$name` mention delimited by whitespace or the text's edges. */
const SKILL_MENTION = /(^|\s)\$([^\s$]+)(?=\s|$)/g;
/**
 * Drafts OMP consumes verbatim, where a `/skill:` token would not be expanded: another slash
 * command, and the `!` and `$ ` local-execution sigils (`allowsSkillTokens` in OMP's TUI).
 */
const VERBATIM_DRAFT = /^(\/|!|\$\$?(\s|$))/;

/** Whether `text` could hold a skill mention at all; skips skill discovery for most prompts. */
const mayMentionSkill = (text: string): boolean =>
  !VERBATIM_DRAFT.test(text.trimStart()) && /(^|\s)\$[^\s$]/.test(text);

/**
 * Rewrites the first `$name` mention of a known skill to `/skill:name`. OMP expands one skill
 * token per prompt, leading (`/skill:a args`) or mid-prompt (`args /skill:a args`); later
 * mentions stay as typed.
 */
export const rewriteOmpSkillMention = (text: string, skillNames: ReadonlySet<string>): string => {
  if (!mayMentionSkill(text)) return text;
  for (const match of text.matchAll(SKILL_MENTION)) {
    const name = match[2]!;
    if (!skillNames.has(name)) continue;
    const start = match.index + match[1]!.length;
    return `${text.slice(0, start)}/skill:${name}${text.slice(start + 1 + name.length)}`;
  }
  return text;
};

export interface OmpWorkspaceCatalog {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
}

/** What a thread's session feeds into, and asks of, the catalog. */
export interface OmpCommandHooks {
  /** A thread's server pushed `available_commands_update` for `cwd`. */
  readonly onAvailableCommands: (
    cwd: string,
    commands: ReadonlyArray<AvailableCommand>,
  ) => Effect.Effect<void>;
  /** The prompt text OMP receives: the first `$skill` mention rewritten to `/skill:name`. */
  readonly resolvePrompt: (cwd: string, text: string) => Effect.Effect<string>;
}

export interface OmpCommandCatalog extends OmpCommandHooks {
  /** The directory's commands and skills: cached, pushed, or discovered now. */
  readonly forCwd: (
    cwd: string,
  ) => Effect.Effect<OmpWorkspaceCatalog, OmpControlError | OmpSidecarError>;
  /** Every directory with both lists known, newest last; for the provider snapshot. */
  readonly workspaceSnapshots: Stream.Stream<ReadonlyArray<ServerProviderWorkspaceSnapshot>>;
  /** Drops discovered lists; lists a thread's server pushed stay until it pushes again. */
  readonly invalidate: Effect.Effect<void>;
}

export interface OmpCommandCatalogOptions {
  readonly control: OmpControlService;
  /** The control target for a directory; resolves the binary. */
  readonly target: (cwd: string) => Effect.Effect<OmpControlTarget, OmpSidecarError>;
  readonly ttlMs?: number;
}

type CatalogError = OmpControlError | OmpSidecarError;

interface Entry<A> {
  readonly deferred: Deferred.Deferred<A, CatalogError>;
  /** Set once the run succeeded. */
  value: A | undefined;
  settledAt: number | null;
  /** Pushed by a thread's server: never expires. */
  readonly pushed: boolean;
}

export const makeOmpCommandCatalog = Effect.fn("makeOmpCommandCatalog")(function* (
  options: OmpCommandCatalogOptions,
): Effect.fn.Return<OmpCommandCatalog, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  const ttlMs = options.ttlMs ?? OMP_COMMAND_CATALOG_TTL_MS;
  const commands = new Map<string, Entry<ReadonlyArray<ServerProviderSlashCommand>>>();
  const skills = new Map<string, Entry<ReadonlyArray<ServerProviderSkill>>>();
  const published = yield* SubscriptionRef.make<ReadonlyArray<ServerProviderWorkspaceSnapshot>>([]);

  /** Shares one run per directory while in flight and, once it succeeded, for `ttlMs`. */
  const memo = <A>(
    entries: Map<string, Entry<A>>,
    cwd: string,
    run: Effect.Effect<A, CatalogError>,
  ): Effect.Effect<A, CatalogError> =>
    Effect.flatMap(Clock.currentTimeMillis, (now) => {
      const existing = entries.get(cwd);
      if (
        existing !== undefined &&
        (existing.pushed || existing.settledAt === null || now - existing.settledAt < ttlMs)
      ) {
        return Deferred.await(existing.deferred);
      }
      const entry: Entry<A> = {
        deferred: Deferred.makeUnsafe<A, CatalogError>(),
        value: undefined,
        settledAt: null,
        pushed: false,
      };
      entries.set(cwd, entry);
      return run.pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Effect.flatMap(Clock.currentTimeMillis, (settledAt) => {
            if (Exit.isSuccess(exit)) {
              entry.value = exit.value;
              entry.settledAt = settledAt;
              // Failures are not kept: the next caller retries.
            } else if (entries.get(cwd) === entry) entries.delete(cwd);
            return Deferred.done(entry.deferred, exit);
          }),
        ),
        // Runs in the catalog's scope, so a caller that gives up never strands the others.
        Effect.forkIn(scope),
        Effect.andThen(Deferred.await(entry.deferred)),
      );
    });

  const discoverSkills = (cwd: string) =>
    options.target(cwd).pipe(Effect.flatMap(options.control.skillList), Effect.map(ompSkills));

  /** Puts the directory's current lists into the published snapshots once both are known. */
  const publish = Effect.fnUntraced(function* (cwd: string) {
    const slashCommands = commands.get(cwd)?.value;
    const skillList = skills.get(cwd)?.value;
    if (slashCommands === undefined || skillList === undefined) return;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(published, (current) =>
      [
        ...current.filter((entry) => entry.cwd !== cwd),
        { cwd, checkedAt, slashCommands, skills: skillList },
      ].slice(-MAX_PUBLISHED_WORKSPACES),
    );
  });

  const forCwd = Effect.fn("OmpCommandCatalog.forCwd")(function* (cwd: string) {
    const [discoveredCommands, discoveredSkills] = yield* Effect.all(
      [
        memo(
          commands,
          cwd,
          options
            .target(cwd)
            .pipe(Effect.flatMap(options.control.availableCommands), Effect.map(ompSlashCommands)),
        ),
        memo(skills, cwd, discoverSkills(cwd)),
      ],
      { concurrency: 2 },
    );
    yield* publish(cwd);
    // A list a thread pushed while discovery ran is newer than what discovery found.
    return {
      slashCommands: commands.get(cwd)?.value ?? discoveredCommands,
      skills: skills.get(cwd)?.value ?? discoveredSkills,
    } satisfies OmpWorkspaceCatalog;
  });

  const onAvailableCommands = Effect.fn("OmpCommandCatalog.onAvailableCommands")(function* (
    cwd: string,
    pushed: ReadonlyArray<AvailableCommand>,
  ) {
    const value = ompSlashCommands(pushed);
    const entry: Entry<ReadonlyArray<ServerProviderSlashCommand>> = {
      deferred: Deferred.makeUnsafe(),
      value,
      settledAt: yield* Clock.currentTimeMillis,
      pushed: true,
    };
    yield* Deferred.succeed(entry.deferred, value);
    commands.set(cwd, entry);
    if (skills.get(cwd)?.value !== undefined) return yield* publish(cwd);
    // Skills unknown yet: discover them in the background, which publishes both.
    yield* forCwd(cwd).pipe(
      Effect.catch((error) =>
        Effect.logWarning("omp skills not listed", { cwd, detail: error.message }),
      ),
      Effect.forkIn(scope),
    );
  });

  const resolvePrompt = Effect.fn("OmpCommandCatalog.resolvePrompt")(function* (
    cwd: string,
    text: string,
  ) {
    if (!mayMentionSkill(text)) return text;
    return yield* memo(skills, cwd, discoverSkills(cwd)).pipe(
      Effect.map((list) => rewriteOmpSkillMention(text, new Set(list.map((skill) => skill.name)))),
      // Without the skill list the prompt goes as typed.
      Effect.catch((error) =>
        Effect.logWarning("omp skills not listed", { cwd, detail: error.message }).pipe(
          Effect.as(text),
        ),
      ),
    );
  });

  const invalidate = Effect.sync(() => {
    skills.clear();
    for (const [cwd, entry] of commands) if (!entry.pushed) commands.delete(cwd);
  });

  return {
    forCwd,
    onAvailableCommands,
    resolvePrompt,
    workspaceSnapshots: SubscriptionRef.changes(published),
    invalidate,
  } satisfies OmpCommandCatalog;
});
