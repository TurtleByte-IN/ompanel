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
  tag: "v18.12.6-ompanel.3",
  commit: "acf0d2313915dbff0009ad37088bcd15292288f6",
  version: "18.12.6",
  contract: {
    version: "1.6.0",
    schemaHash: "sha256:a61c22dd6dc95fdaedac129d37eca8d471e4e9736f0f384452762d69d36233b2",
  },
  cliContract: {
    version: "1.0.0",
    schemaHash: "sha256:c69d63a87d5f91f918f9afb03f6aed8d637262e9c2f783e1524f62c1e6d14540",
  },
  sidecars: {},
};
