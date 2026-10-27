import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderWorkspaceSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  makeOmpCommandCatalog,
  OMP_COMMAND_CATALOG_TTL_MS,
  ompSkills,
  ompSlashCommands,
  rewriteOmpSkillMention,
} from "./commands.ts";
import {
  OmpControlError,
  type OmpAvailableSlashCommand,
  type OmpControlService,
  type OmpControlTarget,
  type OmpSkillList,
} from "./control.ts";
import type { OmpCatalogModel } from "./modelTraits.ts";
import { ompProviderModels } from "./status.ts";

const BUILTINS: ReadonlyArray<OmpAvailableSlashCommand> = [
  {
    name: "compact",
    source: "builtin",
    description: "Compact the context",
    input: { hint: "focus" },
  },
  { name: "fresh", source: "builtin", description: "Start a fresh session" },
  { name: "skill:tdd", source: "skill", description: "Test first" },
  { name: "deploy", source: "file", description: "  ", input: { hint: "" } },
];

const skillList = (cwd: string): OmpSkillList => ({
  skills: [
    {
      name: "tdd",
      description: "Test first",
      filePath: `${cwd}/.omp/skills/tdd/SKILL.md`,
      baseDir: `${cwd}/.omp/skills/tdd`,
      source: "native:project",
      hide: false,
    },
    {
      name: "release",
      description: "",
      filePath: "/home/tester/.omp/agent/skills/release/SKILL.md",
      baseDir: "/home/tester/.omp/agent/skills/release",
      source: "native:user",
      hide: true,
    },
  ],
  warnings: [],
});

/** `/repo`'s project config scopes OMP to one of the two models every other directory lists. */
const listedModels = (cwd: string): ReadonlyArray<OmpCatalogModel> => [
  { id: "a", name: "Lab A", provider: "lab", reasoning: false },
  ...(cwd === "/repo" ? [] : [{ id: "b", name: "Lab B", provider: "lab", reasoning: false }]),
];

/** A control service whose catalog operations record the directory of every `omp` they start. */
const fakeControl = (
  options: { readonly failSkills?: boolean; readonly failModels?: boolean } = {},
) => {
  const spawns: Array<{ readonly op: "commands" | "skills" | "models"; readonly cwd: string }> = [];
  const control = {
    availableCommands: (target: OmpControlTarget) =>
      Effect.sync(() => {
        spawns.push({ op: "commands", cwd: target.cwd });
        return BUILTINS;
      }),
    skillList: (target: OmpControlTarget) =>
      Effect.suspend(() => {
        spawns.push({ op: "skills", cwd: target.cwd });
        return options.failSkills === true
          ? Effect.fail(new OmpControlError({ operation: "skill_list", reason: "exit" }))
          : Effect.succeed(skillList(target.cwd));
      }),
    availableModels: (target: OmpControlTarget) =>
      Effect.suspend(() => {
        spawns.push({ op: "models", cwd: target.cwd });
        return options.failModels === true
          ? Effect.fail(new OmpControlError({ operation: "available_models", reason: "timeout" }))
          : Effect.succeed(listedModels(target.cwd));
      }),
  } as unknown as OmpControlService;
  return { control, spawns };
};

const target = (cwd: string) =>
  Effect.succeed<OmpControlTarget>({
    binaryPath: "/opt/ompanel/omp",
    profile: "",
    environment: {},
    cwd,
  });

const makeCatalog = (control: OmpControlService) =>
  makeOmpCommandCatalog({
    control,
    target,
    models: (listed) => ompProviderModels([], listed),
  });

const slugs = (models: ReadonlyArray<{ readonly slug: string }> | undefined) =>
  models?.map((model) => model.slug);

describe("OMP command mapping", () => {
  it("lists every command but skill ones, with non-empty descriptions and hints, then /goal", () => {
    assert.deepStrictEqual(ompSlashCommands(BUILTINS), [
      { name: "compact", description: "Compact the context", input: { hint: "focus" } },
      { name: "fresh", description: "Start a fresh session" },
      { name: "deploy" },
      {
        name: "goal",
        description: "Set, show, pause, resume or drop this thread's goal",
        input: { hint: "[objective | show | pause | resume | drop]" },
      },
    ]);
  });

  it("keeps OMP's own /goal entry when it lists one", () => {
    const commands = ompSlashCommands([{ name: "goal", source: "builtin", description: "Goal" }]);
    assert.deepStrictEqual(commands, [{ name: "goal", description: "Goal" }]);
  });

  it("drops builtins the adapter refuses as prompts", () => {
    const commands = ompSlashCommands([
      { name: "computer", source: "builtin", description: "Toggle computer use" },
      { name: "share", source: "builtin", description: "Share session" },
      { name: "mcp", source: "builtin", description: "Manage MCP servers" },
      { name: "fresh", source: "builtin", description: "Start a fresh session" },
    ]);
    assert.deepStrictEqual(
      commands.map((command) => command.name),
      ["fresh", "goal"],
    );
  });

  it("maps skills to composer skills; hidden ones are user-only", () => {
    assert.deepStrictEqual(ompSkills(skillList("/repo")), [
      {
        name: "tdd",
        path: "/repo/.omp/skills/tdd/SKILL.md",
        enabled: true,
        description: "Test first",
        scope: "project",
      },
      {
        name: "release",
        path: "/home/tester/.omp/agent/skills/release/SKILL.md",
        enabled: true,
        scope: "user",
        userInvocationOnly: true,
      },
    ]);
  });

  it.each([
    ["$tdd fix the parser", "/skill:tdd fix the parser"],
    ["fix the parser with $tdd please", "fix the parser with /skill:tdd please"],
    ["$HOME stays, $tdd goes", "$HOME stays, /skill:tdd goes"],
    ["$tdd then $release", "/skill:tdd then $release"],
    ["/review $tdd", "/review $tdd"],
    ["$ ls $tdd", "$ ls $tdd"],
    ["!echo $tdd", "!echo $tdd"],
    ["cost is $5", "cost is $5"],
    ["no$tdd inside a word", "no$tdd inside a word"],
  ])("rewrites %j to %j", (text, expected) => {
    assert.strictEqual(rewriteOmpSkillMention(text, new Set(["tdd", "release"])), expected);
  });
});

describe("OmpCommandCatalog", () => {
  it.effect("discovers a directory once, and again for another directory", () =>
    Effect.gen(function* () {
      const { control, spawns } = fakeControl();
      const catalog = yield* makeCatalog(control);
      const first = yield* catalog.forCwd("/repo");
      assert.deepStrictEqual(
        first.slashCommands.map((command) => command.name),
        ["compact", "fresh", "deploy", "goal"],
      );
      assert.deepStrictEqual(
        first.skills.map((skill) => skill.name),
        ["tdd", "release"],
      );
      assert.lengthOf(spawns, 3);

      const second = yield* catalog.forCwd("/repo");
      assert.deepStrictEqual(second, first);
      assert.lengthOf(spawns, 3, "the same directory reuses its lists");

      yield* catalog.forCwd("/other");
      assert.deepStrictEqual(spawns.slice(3), [
        { op: "commands", cwd: "/other" },
        { op: "skills", cwd: "/other" },
        { op: "models", cwd: "/other" },
      ]);

      yield* TestClock.adjust(OMP_COMMAND_CATALOG_TTL_MS);
      yield* catalog.forCwd("/repo");
      assert.lengthOf(spawns, 9, "an expired directory is discovered again");

      yield* catalog.invalidate;
      yield* catalog.forCwd("/repo");
      assert.lengthOf(spawns, 12, "invalidate drops discovered lists");
    }).pipe(Effect.scoped),
  );

  it.effect("shares one discovery between concurrent callers", () =>
    Effect.gen(function* () {
      const { control, spawns } = fakeControl();
      const catalog = yield* makeCatalog(control);
      yield* Effect.all([catalog.forCwd("/repo"), catalog.forCwd("/repo")], {
        concurrency: "unbounded",
      });
      assert.lengthOf(spawns, 3);
    }).pipe(Effect.scoped),
  );

  it.effect("does not keep a failed discovery", () =>
    Effect.gen(function* () {
      const failing = fakeControl({ failSkills: true });
      const catalog = yield* makeCatalog(failing.control);
      const error = yield* catalog.forCwd("/repo").pipe(Effect.flip);
      assert.strictEqual(error._tag, "OmpControlError");
      yield* catalog.forCwd("/repo").pipe(Effect.flip);
      assert.deepStrictEqual(
        failing.spawns.filter((spawn) => spawn.op === "skills"),
        [
          { op: "skills", cwd: "/repo" },
          { op: "skills", cwd: "/repo" },
        ],
      );
    }).pipe(Effect.scoped),
  );

  it.effect("replaces the menu with a pushed list and publishes it", () =>
    Effect.gen(function* () {
      const { control, spawns } = fakeControl();
      const catalog = yield* makeCatalog(control);
      const published: Array<ReadonlyArray<ServerProviderWorkspaceSnapshot>> = [];
      const watcher = yield* catalog.workspaceSnapshots.pipe(
        Stream.runForEach((list) => Effect.sync(() => published.push(list))),
        Effect.forkChild,
      );
      yield* catalog.forCwd("/repo");

      yield* catalog.onAvailableCommands("/repo", [
        ...BUILTINS,
        { name: "review", source: "custom", description: "Launch interactive code review" },
        { name: "skill:tdd", source: "skill" },
      ]);
      yield* Effect.yieldNow;
      const latest = published.at(-1)?.find((entry) => entry.cwd === "/repo");
      assert.deepStrictEqual(
        latest?.slashCommands.map((command) => command.name),
        ["compact", "fresh", "deploy", "review", "goal"],
      );
      assert.deepStrictEqual(
        latest?.skills.map((skill) => skill.name),
        ["tdd", "release"],
      );

      // A pushed list outlives the TTL and invalidation; skills are rediscovered.
      yield* TestClock.adjust(OMP_COMMAND_CATALOG_TTL_MS);
      yield* catalog.invalidate;
      const after = yield* catalog.forCwd("/repo");
      assert.include(
        after.slashCommands.map((command) => command.name),
        "review",
      );
      assert.deepStrictEqual(
        spawns.filter((spawn) => spawn.op === "commands"),
        [{ op: "commands", cwd: "/repo" }],
      );
      yield* Fiber.interrupt(watcher);
    }).pipe(Effect.scoped),
  );

  it.effect("lists skills in the background when a push arrives for a new directory", () =>
    Effect.gen(function* () {
      const { control, spawns } = fakeControl();
      const catalog = yield* makeCatalog(control);
      yield* catalog.onAvailableCommands("/repo", BUILTINS);
      const published = yield* catalog.workspaceSnapshots.pipe(
        Stream.filter((list) => list.length > 0),
        Stream.runHead,
      );
      assert.deepStrictEqual(
        published._tag === "Some" ? published.value.map((entry) => entry.cwd) : null,
        ["/repo"],
      );
      assert.deepStrictEqual(spawns, [
        { op: "skills", cwd: "/repo" },
        { op: "models", cwd: "/repo" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("rewrites a known $skill and leaves other prompts alone without listing", () =>
    Effect.gen(function* () {
      const { control, spawns } = fakeControl();
      const catalog = yield* makeCatalog(control);
      assert.strictEqual(yield* catalog.resolvePrompt("/repo", "plain prompt"), "plain prompt");
      assert.lengthOf(spawns, 0);
      assert.strictEqual(
        yield* catalog.resolvePrompt("/repo", "$tdd add a test"),
        "/skill:tdd add a test",
      );
      assert.strictEqual(yield* catalog.resolvePrompt("/repo", "$nope stays"), "$nope stays");
      assert.deepStrictEqual(spawns, [{ op: "skills", cwd: "/repo" }]);
    }).pipe(Effect.scoped),
  );

  it.effect("sends the prompt as typed when skills cannot be listed", () =>
    Effect.gen(function* () {
      const { control } = fakeControl({ failSkills: true });
      const catalog = yield* makeCatalog(control);
      assert.strictEqual(yield* catalog.resolvePrompt("/repo", "$tdd go"), "$tdd go");
    }).pipe(Effect.scoped),
  );

  it.effect("lists a workspace's project models", () =>
    Effect.gen(function* () {
      const { control, spawns } = fakeControl();
      const catalog = yield* makeCatalog(control);
      const repo = yield* catalog.forCwd("/repo");
      const other = yield* catalog.forCwd("/other");
      assert.deepStrictEqual(slugs(repo.models), ["default", "lab/a"]);
      assert.deepStrictEqual(slugs(other.models), ["default", "lab/a", "lab/b"]);

      const published = yield* catalog.workspaceSnapshots.pipe(Stream.runHead);
      assert.deepStrictEqual(
        published._tag === "Some"
          ? published.value.map((entry) => [entry.cwd, slugs(entry.models)])
          : null,
        [
          ["/repo", ["default", "lab/a"]],
          ["/other", ["default", "lab/a", "lab/b"]],
        ],
      );

      yield* catalog.forCwd("/repo");
      assert.deepStrictEqual(
        spawns.filter((spawn) => spawn.op === "models"),
        [
          { op: "models", cwd: "/repo" },
          { op: "models", cwd: "/other" },
        ],
        "each directory's list is cached",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("keeps the menu and skills when OMP cannot list a directory's models", () =>
    Effect.gen(function* () {
      const { control, spawns } = fakeControl({ failModels: true });
      const catalog = yield* makeCatalog(control);
      const workspace = yield* catalog.forCwd("/repo");
      assert.isUndefined(workspace.models);
      assert.include(
        workspace.slashCommands.map((command) => command.name),
        "compact",
      );
      yield* catalog.forCwd("/repo");
      assert.lengthOf(
        spawns.filter((spawn) => spawn.op === "models"),
        2,
        "a failed list is not kept",
      );
    }).pipe(Effect.scoped),
  );
});
