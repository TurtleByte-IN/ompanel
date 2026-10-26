// The OMP traits picker as the omp status probe builds it (packages/provider-omp/src/server/modelTraits.ts).
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderOptionSelection,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TraitsPicker } from "./TraitsPicker";

const level = (id: string, label: string, isDefault = false) => ({
  id,
  label,
  ...(isDefault ? { isDefault } : {}),
});

const DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "OMP default",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "thinking",
        label: "Thinking",
        type: "select",
        options: [
          level("inherit", "Inherit", true),
          level("off", "Off"),
          level("low", "Low"),
          level("high", "High"),
        ],
      },
      {
        id: "role",
        label: "Role",
        type: "select",
        options: [level("default", "Default", true), level("smol", "Smol"), level("slow", "Slow")],
      },
      { id: "fastMode", label: "Fast Mode", type: "boolean" },
      { id: "advisor", label: "Advisor", type: "boolean" },
      { id: "prewalk", label: "Prewalk", type: "boolean" },
      { id: "computer", label: "Computer Use", type: "boolean" },
    ],
  },
};

it("shows OMP's thinking levels, role chip and boolean traits, and writes picks", async () => {
  const changes: Array<ReadonlyArray<ProviderOptionSelection> | undefined> = [];
  await render(
    <TraitsPicker
      provider={ProviderDriverKind.make("omp")}
      instanceId={ProviderInstanceId.make("omp")}
      models={[DEFAULT_MODEL]}
      model="default"
      modelOptions={[]}
      planModeEnabled={false}
      onModelOptionsChange={(next) => changes.push(next)}
    />,
  );
  await page.getByRole("button", { name: /Inherit/ }).click();
  for (const label of ["Thinking", "Role", "Fast Mode", "Advisor", "Prewalk", "Computer Use"]) {
    await expect.element(page.getByText(label, { exact: true })).toBeVisible();
  }
  await expect.element(page.getByRole("menuitemradio", { name: /^High/ })).toBeVisible();
  await page.getByRole("menuitemradio", { name: /^Smol/ }).click();
  expect(changes.at(-1)).toContainEqual({ id: "role", value: "smol" });
});
