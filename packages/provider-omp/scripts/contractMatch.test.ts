import { assert, describe, it } from "@effect/vitest";

import {
  compareContractFiles,
  describeMismatch,
  isVendoredContractPath,
  lockProblems,
  type OmpLockFile,
} from "./contractMatch.ts";

const bytes = (value: string) => new TextEncoder().encode(value);

const LOCK: OmpLockFile = {
  repository: "TurtleByte-IN/oh-my-pi",
  tag: "v1.0.0-ompanel.1",
  commit: "a".repeat(40),
  version: "1.0.0",
  contract: { version: "1.0.0", schemaHash: "sha256:abc" },
  cliContract: { version: "1.0.0", schemaHash: "sha256:cli" },
  sidecars: {},
};

describe("isVendoredContractPath", () => {
  it("vendors the schema, the manifest and src/, but not package metadata", () => {
    assert.isTrue(isVendoredContractPath("contract.json"));
    assert.isTrue(isVendoredContractPath("rpc-wire.schema.json"));
    assert.isTrue(isVendoredContractPath("cli-contract.json"));
    assert.isTrue(isVendoredContractPath("cli-contract.schema.json"));
    assert.isTrue(isVendoredContractPath("src/wire.generated.ts"));
    assert.isFalse(isVendoredContractPath("package.json"));
    assert.isFalse(isVendoredContractPath("README.md"));
    assert.isFalse(isVendoredContractPath("tsconfig.json"));
  });
});

describe("compareContractFiles", () => {
  const tag = new Map([
    ["contract.json", bytes('{"contractVersion":"1.0.0"}\n')],
    ["src/index.ts", bytes('export * from "./wire.generated";\n')],
  ]);

  it("accepts an identical copy", () => {
    assert.deepStrictEqual(compareContractFiles(tag, new Map(tag)), []);
  });

  it("reports a copy whose bytes differ, even by whitespace", () => {
    const vendored = new Map(tag).set(
      "src/index.ts",
      bytes('export * from "./wire.generated";\r\n'),
    );
    assert.deepStrictEqual(compareContractFiles(tag, vendored), [
      { kind: "differs", path: "src/index.ts" },
    ]);
  });

  it("reports missing and extra files", () => {
    const vendored = new Map([
      ["contract.json", bytes('{"contractVersion":"1.0.0"}\n')],
      ["src/extra.ts", bytes("")],
    ]);
    const mismatches = compareContractFiles(tag, vendored);
    assert.deepStrictEqual(mismatches, [
      { kind: "unexpected", path: "src/extra.ts" },
      { kind: "missing", path: "src/index.ts" },
    ]);
    assert.deepStrictEqual(mismatches.map(describeMismatch), [
      "contract/src/extra.ts is not in the pinned tag",
      "contract/src/index.ts is missing",
    ]);
  });
});

describe("lockProblems", () => {
  it("accepts a lock that matches the tag", () => {
    assert.deepStrictEqual(
      lockProblems(LOCK, {
        commit: LOCK.commit,
        contract: { contractVersion: "1.0.0", schemaHash: "sha256:abc" },
        cliContract: { cliContractVersion: "1.0.0", schemaHash: "sha256:cli" },
      }),
      [],
    );
  });

  it("refuses a moved tag and a contract the lock does not pin", () => {
    const problems = lockProblems(LOCK, {
      commit: "b".repeat(40),
      contract: { contractVersion: "1.1.0", schemaHash: "sha256:def" },
      cliContract: { cliContractVersion: "1.1.0", schemaHash: "sha256:cli2" },
    });
    assert.lengthOf(problems, 5);
    assert.include(problems[0], "points at bbbb");
    assert.include(problems[1], "contract 1.1.0");
    assert.include(problems[2], "sha256:def");
    assert.include(problems[3], "CLI contract 1.1.0");
    assert.include(problems[4], "sha256:cli2");
  });
});
