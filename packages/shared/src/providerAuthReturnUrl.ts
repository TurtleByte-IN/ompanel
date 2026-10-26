import { HOSTED_APP_URL } from "./brand.ts";
import { isLoopbackHost } from "./preview.ts";

/** Web returns go only to loopback or the configured hosted app; with none configured, loopback only. */
export function providerAuthReturnUrl(
  value: string | undefined,
  hostedAppUrl: string | undefined = HOSTED_APP_URL,
): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const desktop = ["ompanel:", "ompanel-dev:"].includes(url.protocol) && url.host === "app";
    const hostedOrigin =
      hostedAppUrl && URL.canParse(hostedAppUrl) ? new URL(hostedAppUrl).origin : null;
    const web =
      ["http:", "https:"].includes(url.protocol) &&
      (isLoopbackHost(url.hostname) || (hostedOrigin !== null && url.origin === hostedOrigin));
    if (
      url.username ||
      url.password ||
      (!desktop && !web) ||
      (url.pathname !== "/welcome" &&
        url.pathname !== "/settings" &&
        !url.pathname.startsWith("/settings/"))
    )
      return undefined;
    for (const key of Array.from(url.searchParams.keys())) {
      if (
        url.pathname === "/welcome" ||
        !["machine", "project", "checkout", "environmentId", "instanceId"].includes(key)
      ) {
        url.searchParams.delete(key);
      }
    }
    if (url.pathname !== "/welcome" || !/^#agents:[\w-]+$/u.test(url.hash)) url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}
