/**
 * The OMP fork release this build drives. `omp.lock` at the package root is the copy that
 * release tooling and the contract check read; this module mirrors it for the bundled server,
 * and `ompLock.test.ts` fails when the two differ.
 */

/** Release targets of the OMP fork, named after its release matrix `target_id`. */
export type OmpSidecarPlatform =
  | "darwin-arm64"
  | "darwin-x64"
  | "linux-arm64"
  | "linux-x64"
  | "linux-musl-arm64"
  | "linux-musl-x64"
  | "win32-arm64"
  | "win32-x64";

export interface OmpSidecarAsset {
  /** File name of the release asset, which is the standalone executable itself. */
  readonly asset: string;
  /** Lowercase hex sha256 from the release's SHA256SUMS.txt. */
  readonly sha256: string;
}

export interface OmpLock {
  readonly repository: string;
  readonly tag: string;
  /** Commit the tag points at; the contract check refuses a tag that moved. */
  readonly commit: string;
  /** Version `omp --version` reports for this release. */
  readonly version: string;
  readonly contract: {
    /** `contractVersion` the sidecar must report in `ready` and `negotiate_protocol`. */
    readonly version: string;
    readonly schemaHash: string;
  };
  /**
   * `cliContractVersion` and `schemaHash` of the CLI JSON contract (`omp <cmd> --json` output)
   * at the tag. No subcommand reports it at runtime; the tag pin is the check.
   */
  readonly cliContract: {
    readonly version: string;
    readonly schemaHash: string;
  };
  /** Platforms without a released asset are absent; no sidecar is resolved for them. */
  readonly sidecars: Partial<Record<OmpSidecarPlatform, OmpSidecarAsset>>;
}

export const OMP_LOCK: OmpLock = {
  repository: "TurtleByte-IN/oh-my-pi",
  tag: "v18.12.6-ompanel.6",
  commit: "d73b2b3e4f6ee298a7494c02053d16640a207c71",
  version: "18.12.6",
  contract: {
    version: "1.10.0",
    schemaHash: "sha256:d897f2aeeb735e5e81735118dbce5cc5083512323957242b44ebf5f6b95c69e2",
  },
  cliContract: {
    version: "1.1.0",
    schemaHash: "sha256:678ce0308cd99c3419c023beeedd8783c662436a3da185007def26a6b7ea6e6c",
  },
  sidecars: {},
};
