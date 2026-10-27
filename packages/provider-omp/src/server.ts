export { OmpDriver, type OmpDriverEnv } from "./server/driver.ts";

import { OMP_LOCK } from "./ompLock.ts";
import { ompWorkspaceTrustAvailable } from "./server/toolGuards.ts";

/** Whether the pinned OMP enforces a project's workspace trust (contract 1.9.0). */
export const OMP_WORKSPACE_TRUST_ENFORCED = ompWorkspaceTrustAvailable(OMP_LOCK.contract.version);
