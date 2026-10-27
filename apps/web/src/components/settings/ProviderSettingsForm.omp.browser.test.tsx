import { ProviderDriverKind } from "@t3tools/contracts";
import { OmpSettings } from "@t3tools/provider-omp/settings";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { userEvent } from "vite-plus/test/browser";
import { describe, expect, it, vi } from "vite-plus/test";

import { render, type Screen } from "../../../test/render";
import { providerClients } from "./providerDriverMeta";
import { ProviderSettingsForm } from "./ProviderSettingsForm";

const omp = providerClients.get(ProviderDriverKind.make("omp"))!;
// The schema the server decodes an instance's config with (the OMP driver's `configSchema`)
// before it starts the instance; the form renders from the same schema.
const decodeConfig = Schema.decodeUnknownResult(OmpSettings);

/** The OMP instance form as the instance card and Add provider dialog render it. */
function OmpInstanceForm(props: { readonly onChange: (config: unknown) => void }) {
  const [config, setConfig] = useState<unknown>({});
  return (
    <ProviderSettingsForm
      definition={omp}
      value={config}
      idPrefix="provider-instance-omp"
      variant="settings"
      onChange={(next) => {
        setConfig(next);
        props.onChange(next);
      }}
    />
  );
}

async function commitProfile(screen: Screen, profile: string) {
  const field = screen.getByLabelText("Profile");
  await userEvent.clear(field);
  if (profile !== "") await userEvent.type(field, profile);
  await userEvent.keyboard("{Tab}");
}

describe("OMP instance form: Profile", () => {
  it("shows Profile after Binary path, with the default profile as its placeholder", async () => {
    await using screen = await render(<OmpInstanceForm onChange={vi.fn()} />);
    const labels = [...screen.container.querySelectorAll("label")].map(
      (label) => label.textContent,
    );
    expect(labels).toEqual(["Binary path", "Profile"]);
    expect(omp.settingsSchema).toBe(OmpSettings);
    const field = screen.getByLabelText("Profile");
    await expect.element(field).toHaveAttribute("placeholder", "default");
    await expect.element(screen.getByText(/omp --profile/)).toBeVisible();
  });

  it("stores a valid profile name, and omits the key when cleared", async () => {
    const onChange = vi.fn();
    await using screen = await render(<OmpInstanceForm onChange={onChange} />);
    await commitProfile(screen, "work");
    const stored = onChange.mock.lastCall?.[0];
    expect(stored).toEqual({ profile: "work" });
    const decoded = decodeConfig(stored);
    expect(Result.isSuccess(decoded) && decoded.success.profile).toBe("work");

    // Cleared: no profile key, so the instance runs the default profile.
    await commitProfile(screen, "");
    expect(onChange.mock.lastCall?.[0]).toBeUndefined();
  });

  it.each(["Work Space", "../work", "-work", "con"])(
    "rejects the invalid profile name %j",
    async (profile) => {
      const onChange = vi.fn();
      await using screen = await render(<OmpInstanceForm onChange={onChange} />);
      await commitProfile(screen, profile);
      const stored = onChange.mock.lastCall?.[0];
      expect(stored).toEqual({ profile });
      const decoded = decodeConfig(stored);
      expect(Result.isFailure(decoded)).toBe(true);
      if (Result.isFailure(decoded))
        expect(String(decoded.failure)).toContain("an OMP profile name");
    },
  );
});
