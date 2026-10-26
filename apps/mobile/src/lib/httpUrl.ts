/**
 * `href` (resolved against `base`) when it is an http(s) URL; null for any other scheme or an
 * unparseable value. Links from servers and documents pass through this before `Linking.openURL`,
 * so they cannot dial (`tel:`), text (`sms:`) or launch other apps' URL schemes.
 */
export function httpUrl(href: string, base?: string): string | null {
  if (href.trim().length === 0) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
