import { describe, expect, it } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import { OmpSignInAnswerInput, OmpSignInStartInput } from "./ompAccounts.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

describe("OMP accounts contract", () => {
  it("carries an API key as a plain string on the wire and Redacted in memory", () => {
    const codec = Schema.toCodecJson(OmpSignInStartInput);
    const wire = { instanceId: "omp", providerId: "groq", apiKey: "gsk-wire-key" };
    const decoded = Schema.decodeUnknownSync(codec)(wire);
    expect(Redacted.isRedacted(decoded.apiKey)).toBe(true);
    expect(Redacted.value(decoded.apiKey!)).toBe("gsk-wire-key");
    expect(String(decoded.apiKey)).not.toContain("gsk-wire-key");
    expect(JSON.stringify(decoded)).not.toContain("gsk-wire-key");
    expect(Schema.encodeSync(codec)(decoded)).toEqual(wire);
  });

  it("treats an absent answer as a cancelled prompt", () => {
    const decoded = Schema.decodeUnknownSync(Schema.toCodecJson(OmpSignInAnswerInput))({
      instanceId: ProviderInstanceId.make("omp"),
      flowId: "omp-sign-in-1",
      promptId: "omp-sign-in-1:ui-1",
    });
    expect(decoded.value).toBeUndefined();
  });
});
