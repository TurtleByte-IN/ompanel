import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

/**
 * Ompanel's own Chromium profile. Nothing is read from or seeded by upstream T3 Code's profiles
 * (`T3 Code (Alpha)`, `t3code`, `T3 Code (Dev)`): on Windows their `Local State` holds the
 * safeStorage key, and sharing it would let either app decrypt the other's stored secrets.
 */
export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: { readonly appDataDirectory: string; readonly isDevelopment: boolean }) {
    const path = yield* Path.Path;
    return path.join(input.appDataDirectory, input.isDevelopment ? "Ompanel (Dev)" : "ompanel");
  },
);
