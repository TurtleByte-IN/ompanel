/** What desktop packaging needs to ship the pinned sidecar: the lock and the verified download. */
export { OMP_LOCK, type OmpLock, type OmpSidecarPlatform } from "./ompLock.ts";
export { OmpLockFile } from "../scripts/contractMatch.ts";
export { OmpHostLinuxLibc } from "./server/sidecar.ts";
export { installOmpSidecar } from "./server/sidecarInstall.ts";
