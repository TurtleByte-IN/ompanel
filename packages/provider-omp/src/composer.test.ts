import { assert, describe, it } from "@effect/vitest";

import {
  OMP_MAGIC_KEYWORDS,
  ompGoalCommandText,
  ompMagicKeywordCompletions,
  ompMagicKeywordsIn,
  parseOmpGoalCommand,
} from "./composer.ts";

const words = (text: string) => ompMagicKeywordsIn(text).map((keyword) => keyword.word);

describe("OMP magic keywords", () => {
  it("lists OMP's keywords: ultrathink, orchestrate, workflowz and jevify", () => {
    assert.deepStrictEqual(
      OMP_MAGIC_KEYWORDS.map((keyword) => keyword.word),
      ["ultrathink", "orchestrate", "workflowz", "jevify"],
    );
  });

  it.each([
    ["ultrathink about the parser", ["ultrathink"]],
    ["please orchestrate this, then workflowz.", ["orchestrate", "workflowz"]],
    ["(ultrathink) and jevify!", ["ultrathink", "jevify"]],
    ["ULTRATHINK is not lowercase", []],
    ["run `ultrathink` in code", []],
    ["```\northestrate\nultrathink\n```\nno keyword here", []],
    ["<note>ultrathink</note>", []],
    ["src/ultrathink.ts and my-ultrathink and ultrathink()", []],
    ["foo::orchestrate and orchestrated", []],
  ])("finds the keywords in %j", (text, expected) => {
    assert.deepStrictEqual(words(text), expected);
  });

  it("completes a typed prefix of three letters or more, not a finished word", () => {
    assert.deepStrictEqual(
      ompMagicKeywordCompletions("ult").map((keyword) => keyword.word),
      ["ultrathink"],
    );
    assert.deepStrictEqual(
      ompMagicKeywordCompletions("work").map((keyword) => keyword.word),
      ["workflowz"],
    );
    assert.lengthOf(ompMagicKeywordCompletions("ul"), 0);
    assert.lengthOf(ompMagicKeywordCompletions("ultrathink"), 0);
    assert.lengthOf(ompMagicKeywordCompletions("Ult"), 0);
    assert.lengthOf(ompMagicKeywordCompletions("xyz"), 0);
  });
});

describe("OMP /goal commands", () => {
  it.each([
    ["/goal", { op: "get" }],
    ["/goal show", { op: "get" }],
    ["/goal pause", { op: "pause" }],
    ["  /goal RESUME  ", { op: "resume" }],
    ["/goal drop", { op: "drop" }],
    ["/goal clear", { op: "drop" }],
    ["/goal budget 9000", { op: "budget" }],
    ["/goal Ship the release", { op: "create", objective: "Ship the release" }],
    ["/goal set Ship the release", { op: "create", objective: "Ship the release" }],
    ["/goal pause the deploy work", { op: "create", objective: "pause the deploy work" }],
    [
      "/goal set --budget 50000 Ship it",
      { op: "create", objective: "Ship it", tokenBudget: 50_000 },
    ],
    ["/goal --budget=1200 Ship it", { op: "create", objective: "Ship it", tokenBudget: 1_200 }],
  ] as const)("reads %j", (text, expected) => {
    assert.deepStrictEqual(parseOmpGoalCommand(text), expected);
  });

  it("refuses a goal without an objective or with a bad budget", () => {
    assert.strictEqual(parseOmpGoalCommand("/goal set")?.op, "invalid");
    assert.strictEqual(parseOmpGoalCommand("/goal set --budget 0 Ship")?.op, "invalid");
    assert.strictEqual(parseOmpGoalCommand("/goal --budget 50 ")?.op, "invalid");
  });

  it("is not a goal command when the prompt only mentions one", () => {
    assert.isNull(parseOmpGoalCommand("/goals"));
    assert.isNull(parseOmpGoalCommand("set a /goal"));
    assert.isNull(parseOmpGoalCommand("/compact"));
  });

  it("writes commands the parser reads back", () => {
    for (const command of [
      { op: "get" },
      { op: "pause" },
      { op: "resume" },
      { op: "drop" },
      { op: "create", objective: "Ship the release" },
      { op: "create", objective: "Ship it", tokenBudget: 50_000 },
    ] as const) {
      assert.deepStrictEqual(parseOmpGoalCommand(ompGoalCommandText(command)), command);
    }
    assert.strictEqual(
      ompGoalCommandText({ op: "create", objective: "Two\nlines" }),
      "/goal set Two lines",
    );
  });
});
