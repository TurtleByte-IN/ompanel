import { afterEach, assert, describe, expect, it, vi } from "vite-plus/test";

import {
  buildHostedPairingUrl,
  configuredHostedAppUrl,
  isHostedStaticApp,
  hasHostedPairingRequest,
  readHostedPairingRequest,
} from "./hostedPairing";

describe("hostedPairing", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reads hosted pairing host and query token parameters", () => {
    const url = new URL("https://hosted.example.test/pair?host=100.64.1.2:3773&token=ABCD1234");

    expect(readHostedPairingRequest(url)).toEqual({
      host: "100.64.1.2:3773",
      token: "ABCD1234",
      label: "",
    });
    expect(hasHostedPairingRequest(url)).toBe(true);
  });

  it("prefers hash tokens so generated hosted links do not put credentials in search params", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "https://hosted.example.test");

    const link = buildHostedPairingUrl({
      host: "https://backend.example.com:3773",
      token: "pairing-token",
      label: "Workstation",
    });
    assert(link !== null);
    const url = new URL(link);

    expect(url.origin).toBe("https://hosted.example.test");
    expect(url.pathname).toBe("/pair");
    expect(url.searchParams.get("host")).toBe("https://backend.example.com:3773");
    expect(url.searchParams.get("label")).toBe("Workstation");
    expect(url.searchParams.has("token")).toBe(false);
    expect(url.hash).toBe("#token=pairing-token");
  });

  it("builds no hosted link and is never the hosted app when no hosted app is configured", () => {
    vi.stubEnv("VITE_HOSTED_APP_URL", "");

    expect(configuredHostedAppUrl()).toBeNull();
    expect(
      buildHostedPairingUrl({ host: "https://backend.example.com:3773", token: "pairing-token" }),
    ).toBeNull();
    expect(isHostedStaticApp(new URL("https://app.t3.codes/"))).toBe(false);
  });
});
