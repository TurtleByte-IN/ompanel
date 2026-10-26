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

/** A control service whose catalog operations record the directory of every `omp` they start. */
const fakeControl = (options: { readonly failSkills?: boolean } = {}) => {
  const spawns: Array<{ readonly op: "commands" | "skills"; readonly cwd: string }> = [];
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

describe("OMP command mapping", () => {
  it("lists every command but skill ones, with non-empty descriptions and hints", () => {
    assert.deepStrictEqual(ompSlashCommands(BUILTINS), [
      { name: "compact", description: "Compact the context", input: { hint: "focus" } },
      { name: "fresh", description: "Start a fresh session" },
      { name: "deploy" },
    ]);
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
      const catalog = yield* makeOmpCommandCatalog({ control, target });
      const first = yield* catalog.forCwd("/repo");
      assert.deepStrictEqual(
        first.slashCommands.map((command) => command.name),
        ["compact", "fresh", "deploy"],
      );
      assert.deepStrictEqual(
        first.skills.map((skill) => skill.name),
        ["tdd", "release"],
      );
      assert.lengthOf(spawns, 2);

      const second = yield* catalog.forCwd("/repo");
      assert.deepStrictEqual(second, first);
      assert.lengthOf(spawns, 2, "the same directory reuses its lists");

      yield* catalog.forCwd("/other");
      assert.deepStrictEqual(spawns.slice(2), [
        { op: "commands", cwd: "/other" },
        { op: "skills", cwd: "/other" },
      ]);

      yield* TestClock.adjust(OMP_COMMAND_CATALOG_TTL_MS);
      yield* catalog.forCwd("/repo");
      assert.lengthOf(spawns, 6, "an expired directory is discovered again");

      yield* catalog.invalidate;
      yield* catalog.forCwd("/repo");
      assert.lengthOf(spawns, 8, "invalidate drops discovered lists");
    }).pipe(Effect.scoped),
  );

  it.effect("shares one discovery between concurrent callers", () =>
    Effect.gen(function* () {
      const { control, spawns } = fakeControl();
      const catalog = yield* makeOmpCommandCatalog({ control, target });
      yield* Effect.all([catalog.forCwd("/repo"), catalog.forCwd("/repo")], {
        concurrency: "unbounded",
      });
      assert.lengthOf(spawns, 2);
    }).pipe(Effect.scoped),
  );

  it.effect("does not keep a failed discovery", () =>
    Effect.gen(function* () {
      const failing = fakeControl({ failSkills: true });
      const catalog = yield* makeOmpCommandCatalog({ control: failing.control, target });
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
      const catalog = yield* makeOmpCommandCatalog({ control, target });
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
        ["compact", "fresh", "deploy", "review"],
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
      const catalog = yield* makeOmpCommandCatalog({ control, target });
      yield* catalog.onAvailableCommands("/repo", BUILTINS);
      const published = yield* catalog.workspaceSnapshots.pipe(
        Stream.filter((list) => list.length > 0),
        Stream.runHead,
      );
      assert.deepStrictEqual(
        published._tag === "Some" ? published.value.map((entry) => entry.cwd) : null,
        ["/repo"],
      );
      assert.deepStrictEqual(spawns, [{ op: "skills", cwd: "/repo" }]);
    }).pipe(Effect.scoped),
  );

  it.effect("rewrites a known $skill and leaves other prompts alone without listing", () =>
    Effect.gen(function* () {
      const { control, spawns } = fakeControl();
      const catalog = yield* makeOmpCommandCatalog({ control, target });
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
      const catalog = yield* makeOmpCommandCatalog({ control, target });
      assert.strictEqual(yield* catalog.resolvePrompt("/repo", "$tdd go"), "$tdd go");
    }).pipe(Effect.scoped),
  );
});
