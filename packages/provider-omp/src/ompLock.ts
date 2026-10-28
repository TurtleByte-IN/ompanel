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
  commit: "989009119bd2df391c8f2dd52891da9abcede556",
  version: "18.12.6",
  contract: {
    version: "1.10.0",
    schemaHash: "sha256:d897f2aeeb735e5e81735118dbce5cc5083512323957242b44ebf5f6b95c69e2",
  },
  cliContract: {
    version: "1.1.0",
    schemaHash: "sha256:678ce0308cd99c3419c023beeedd8783c662436a3da185007def26a6b7ea6e6c",
  },
  sidecars: {
    "darwin-arm64": {
      asset: "omp-darwin-arm64",
      sha256: "3183fb1ff93c7d664df29a0eedb75cb30cc807bf55d227b8e94bae0470002ff0",
    },
    "darwin-x64": {
      asset: "omp-darwin-x64",
      sha256: "f081578652fad02f5aa9f6d7f310bfa06f5545afb274d8da339752689950fd14",
    },
    "linux-arm64": {
      asset: "omp-linux-arm64",
      sha256: "16ddcb311fedda1920db01d88743c66e31424a06dfac349411af4c39505ffb4f",
    },
    "linux-x64": {
      asset: "omp-linux-x64",
      sha256: "70ab8545536dfa37a18d9777ed989efa4feaffaa7445edc980d6086d6898b5d5",
    },
    "linux-musl-arm64": {
      asset: "omp-linux-musl-arm64",
      sha256: "5c8112380296e554abaa3e03d4d1d94699e21ec914870754442fbfcbee61c4c0",
    },
    "linux-musl-x64": {
      asset: "omp-linux-musl-x64",
      sha256: "2b7d638da2c6a984373f1224ad8b5fd86e23b4120b02154c4affab4f5258fe13",
    },
    "win32-arm64": {
      asset: "omp-windows-arm64.exe",
      sha256: "8999061efd11f76c96c35008535e6e6879da536451bed8b0d980a804999247ba",
    },
    "win32-x64": {
      asset: "omp-windows-x64.exe",
      sha256: "08698cd441ccf85a215329f397e491816f7a819aacbf465007e8f61d7afc1e7c",
    },
  },
};
