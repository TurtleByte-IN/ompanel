import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { OmpSettings } from "./settings.ts";

export const ompClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("omp"),
  label: "OMP",
  badgeLabel: "Preview",
  settingsSchema: OmpSettings,
  icon: {
    viewBox: "0 0 24 24",
    fill: { light: "#0F0F0F", dark: "#F5F5F5" },
    paths: [
      {
        d: "M12 1a11 11 0 1 0 0 22 11 11 0 1 0 0-22Zm0 2a9 9 0 1 1 0 18 9 9 0 1 1 0-18Z",
        fillRule: "evenodd",
      },
      { d: "M7 7.5h10v2h-2V17h-2V9.5h-2V17H9V9.5H7Z" },
    ],
  },
});
