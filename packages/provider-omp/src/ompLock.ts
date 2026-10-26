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
  /** Platforms without a released asset are absent; no sidecar is resolved for them. */
  readonly sidecars: Partial<Record<OmpSidecarPlatform, OmpSidecarAsset>>;
}

export const OMP_LOCK: OmpLock = {
  repository: "TurtleByte-IN/oh-my-pi",
  tag: "v18.12.6-ompanel.1",
  commit: "dd272e929a4e1b607df1a3242bb46c047cac6a4f",
  version: "18.12.6",
  contract: {
    version: "1.0.0",
    schemaHash: "sha256:7163c1c55792ee38a975e8d7cbba53b5c10762b338dc82838ffa21b1ea3a4797",
  },
  sidecars: {},
};
