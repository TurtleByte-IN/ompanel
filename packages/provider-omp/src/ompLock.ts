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
  tag: "v18.12.6-ompanel.4",
  commit: "8d699e7c1a953acda3097f7d99c5a66f8ad700dd",
  version: "18.12.6",
  contract: {
    version: "1.8.0",
    schemaHash: "sha256:4ded2ddb80d417c1190a6ff3371fe5e6d702100deaae08f7d301e49e03e11087",
  },
  cliContract: {
    version: "1.0.0",
    schemaHash: "sha256:c69d63a87d5f91f918f9afb03f6aed8d637262e9c2f783e1524f62c1e6d14540",
  },
  sidecars: {
    "darwin-arm64": {
      asset: "omp-darwin-arm64",
      sha256: "612fff7dfcf2de3444ebe5832d257966f33876b099e2906d267d3fd0240ef886",
    },
    "darwin-x64": {
      asset: "omp-darwin-x64",
      sha256: "0daa7eadacb2b9b27b52043586bc24f8004fac7126916fa2471f819ee7f86125",
    },
    "linux-arm64": {
      asset: "omp-linux-arm64",
      sha256: "c7ea00c0a686a0f9fd5fa405c34a1d2f942933c51887b4c5a42de995772eea58",
    },
    "linux-x64": {
      asset: "omp-linux-x64",
      sha256: "e352dee11144c4a01a3742e22ff8f5e1b83d9c52418286b99c1fa571a7977502",
    },
    "linux-musl-arm64": {
      asset: "omp-linux-musl-arm64",
      sha256: "a72ef78c3e2e677ea0d946893779b8561b983901e087a1b6aae070df05f14c17",
    },
    "linux-musl-x64": {
      asset: "omp-linux-musl-x64",
      sha256: "f20267928b6264ac1e1bd282a88ed5245f95d0a0b070c6838cbe685a0f622505",
    },
    "win32-arm64": {
      asset: "omp-windows-arm64.exe",
      sha256: "57e5328f8c895e58182da38ec15a3c9038dcbe742259665b6ebb1f1003efd46d",
    },
    "win32-x64": {
      asset: "omp-windows-x64.exe",
      sha256: "e16643918a8976e2dfe45e467591a496618bde0f44e6ac9c8018f8d4e600bf5a",
    },
  },
};
