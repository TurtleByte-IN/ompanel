import * as Schema from "effect/Schema";

/** Where the contract lives at the pinned OMP tag. */
export const TAG_CONTRACT_DIR = "packages/rpc-contract";
/** Where this package vendors it. */
export const VENDORED_CONTRACT_DIR = "contract";

/** The files a host vendors, per the OMP fork's `docs/rpc-contract.md`. */
export const isVendoredContractPath = (relativePath: string): boolean =>
  relativePath === "contract.json" ||
  relativePath === "rpc-wire.schema.json" ||
  relativePath.startsWith("src/");

export const OmpLockFile = Schema.Struct({
  repository: Schema.String,
  tag: Schema.String,
  commit: Schema.String,
  version: Schema.String,
  contract: Schema.Struct({ version: Schema.String, schemaHash: Schema.String }),
  sidecars: Schema.Record(
    Schema.String,
    Schema.Struct({ asset: Schema.String, sha256: Schema.String }),
  ),
});
export type OmpLockFile = typeof OmpLockFile.Type;

export const ContractManifest = Schema.Struct({
  contractVersion: Schema.String,
  schemaHash: Schema.String,
});
export type ContractManifest = typeof ContractManifest.Type;

export type ContractMismatch =
  | { readonly kind: "missing"; readonly path: string }
  | { readonly kind: "unexpected"; readonly path: string }
  | { readonly kind: "differs"; readonly path: string };

const sameBytes = (left: Uint8Array, right: Uint8Array): boolean =>
  left.length === right.length && left.every((byte, index) => byte === right[index]);

/** Byte-for-byte comparison of the tag's contract files with the vendored copy. */
export function compareContractFiles(
  expected: ReadonlyMap<string, Uint8Array>,
  vendored: ReadonlyMap<string, Uint8Array>,
): ReadonlyArray<ContractMismatch> {
  const mismatches: Array<ContractMismatch> = [];
  for (const [path, bytes] of expected) {
    const copy = vendored.get(path);
    if (copy === undefined) mismatches.push({ kind: "missing", path });
    else if (!sameBytes(bytes, copy)) mismatches.push({ kind: "differs", path });
  }
  for (const path of vendored.keys()) {
    if (!expected.has(path)) mismatches.push({ kind: "unexpected", path });
  }
  return mismatches.toSorted((left, right) => left.path.localeCompare(right.path));
}

/** Disagreements between `omp.lock` and what the pinned tag actually contains. */
export function lockProblems(
  lock: OmpLockFile,
  tag: { readonly commit: string; readonly contract: ContractManifest },
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  if (tag.commit !== lock.commit) {
    problems.push(`tag ${lock.tag} points at ${tag.commit}, omp.lock pins ${lock.commit}`);
  }
  if (tag.contract.contractVersion !== lock.contract.version) {
    problems.push(
      `tag ${lock.tag} has contract ${tag.contract.contractVersion}, omp.lock pins ${lock.contract.version}`,
    );
  }
  if (tag.contract.schemaHash !== lock.contract.schemaHash) {
    problems.push(
      `tag ${lock.tag} has schema hash ${tag.contract.schemaHash}, omp.lock pins ${lock.contract.schemaHash}`,
    );
  }
  return problems;
}

export const describeMismatch = (mismatch: ContractMismatch): string => {
  switch (mismatch.kind) {
    case "missing":
      return `${VENDORED_CONTRACT_DIR}/${mismatch.path} is missing`;
    case "unexpected":
      return `${VENDORED_CONTRACT_DIR}/${mismatch.path} is not in the pinned tag`;
    case "differs":
      return `${VENDORED_CONTRACT_DIR}/${mismatch.path} differs from the pinned tag`;
  }
};
