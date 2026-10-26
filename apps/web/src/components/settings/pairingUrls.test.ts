import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { resolveDesktopPairingUrl, resolveHostedPairingUrl } from "./pairingUrls";

describe("settings pairing URL helpers", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses direct backend pairing URLs for HTTP endpoints", () => {
    expect(resolveHostedPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBeNull();
    expect(resolveDesktopPairingUrl("http://192.168.1.44:3773", "PAIRCODE")).toBe(
      "http://192.168.1.44:3773/pair#token=PAIRCODE",
    );
  });

  it("uses hosted pairing URLs for HTTPS endpoints", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");

    expect(resolveHostedPairingUrl("https://host.tailnet.example.ts.net:3773", "PAIRCODE")).toBe(
      "https://hosted.example.test/pair?host=https%3A%2F%2Fhost.tailnet.example.ts.net%3A3773#token=PAIRCODE",
    );
  });

  it("never sends an HTTPS endpoint's credential to a hosted origin when none is configured", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "");
    const endpoint = "https://host.tailnet.example.ts.net:3773";

    expect(resolveHostedPairingUrl(endpoint, "PAIRCODE")).toBeNull();
    const direct = resolveDesktopPairingUrl(endpoint, "PAIRCODE");
    expect(direct).toBe("https://host.tailnet.example.ts.net:3773/pair#token=PAIRCODE");
    expect(direct).not.toContain("t3.codes");
  });
});
