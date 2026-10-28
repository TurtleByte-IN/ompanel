import * as NodeServices from "@effect/platform-node/NodeServices";
import { layerHardenedSpawner } from "@t3tools/shared/shell";
import * as Layer from "effect/Layer";

/**
 * The Node platform services with a child-process spawner that never lets a relative PATH entry
 * or the working directory (an untrusted repository) decide which executable runs.
 */
export const layer = layerHardenedSpawner.pipe(Layer.provideMerge(NodeServices.layer));
