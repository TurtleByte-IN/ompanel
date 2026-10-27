/**
 * What release tooling needs for the pinned sidecar: the lock and the verified download for
 * desktop packaging, and the host's pinned asset for the CLI smoke test.
 */
export { OMP_LOCK, type OmpLock, type OmpSidecarPlatform } from "./ompLock.ts";
export { OmpLockFile } from "../scripts/contractMatch.ts";
export { OmpHostLinuxLibc, pinnedOmpSidecar } from "./server/sidecar.ts";
export { installOmpSidecar } from "./server/sidecarInstall.ts";
