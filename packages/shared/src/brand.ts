/**
 * Ompanel product identity. Everything an upstream T3 Code merge must re-brand flows from here;
 * see docs/omp/branding.md for the names that stay on purpose.
 */

/** Lowercase identity for executables, URL schemes, OS service and profile names. */
export const PRODUCT_SLUG = "ompanel";
export const CLI_COMMAND = "ompanel";

export const ENV_PREFIX = "OMPANEL_";
export const HOME_DIR_NAME = ".ompanel";
/** Upstream T3 Code home, read once by the first-run migration. */
export const LEGACY_HOME_DIR_NAME = ".t3";

/** Reverse-DNS application id (desktop bundle, mobile bundle/package, launchd). */
export const APP_ID = "in.turtlebyte.ompanel";

export const REPOSITORY = "TurtleByte-IN/ompanel";
export const RAW_CONTENT_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main`;

export const UPSTREAM_PRODUCT_NAME = "T3 Code";
