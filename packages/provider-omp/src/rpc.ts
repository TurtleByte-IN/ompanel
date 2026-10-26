// The `omp --mode rpc-ui` process layer and the pinned wire contract, for the server's replay
// testkit and fixture recorder.
export type * from "../contract/src/wire.generated.ts";
export { OMP_LOCK } from "./ompLock.ts";
export { makeOmpPidfiles } from "./server/pidfiles.ts";
export {
  type OmpRpcCommand,
  type OmpRpcParams,
  type OmpRpcProcess,
  type OmpRpcRequestError,
  type OmpRpcResult,
  startOmpRpcProcess,
} from "./server/rpcProcess.ts";
