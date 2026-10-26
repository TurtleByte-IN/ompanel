/**
 * Ompanel product identity. Everything an upstream T3 Code merge must re-brand flows from here;
 * see docs/omp/branding.md for the names that stay on purpose.
 */

/** Display name for UI strings, window titles and client identification. */
export const PRODUCT_NAME = "Ompanel";

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
export const REPOSITORY_URL = `https://github.com/${REPOSITORY}`;
/** Download page for desktop builds and CLI archives (no hosted download site, blocker B-003). */
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
export const RAW_CONTENT_URL = `https://raw.githubusercontent.com/${REPOSITORY}/main`;

export const UPSTREAM_PRODUCT_NAME = "T3 Code";

/**
 * Origin of an Ompanel-run hosted web app. Ompanel runs none, so hosted-only flows (hosted
 * pairing links, CLI cloud sign-in, Codex return via the hosted app, hosted prompt links) stay off
 * unless a build or deployment configures one. Never default this to an upstream origin: those
 * flows hand it pairing credentials.
 */
export const HOSTED_APP_URL: string | undefined = undefined;
