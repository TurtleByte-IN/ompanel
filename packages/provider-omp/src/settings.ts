// Shared with the client settings form; keep schema code browser-safe.
import { CustomModelSetting, makeProviderSettingsSchema, TrimmedString } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

// OMP's own profile-name rules (`normalizeProfileName` in the fork's pi-utils).
const OMP_PROFILE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;

const isOmpProfileName = Schema.makeFilter(
  (value: string) =>
    value === "" ||
    (OMP_PROFILE_NAME.test(value) && !value.endsWith(".") && !WINDOWS_RESERVED_NAME.test(value)),
  {
    expected:
      "an OMP profile name: up to 64 lowercase letters, digits, '.', '_' or '-', starting with a letter or digit",
  },
);

export const OmpSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Binary path",
        description:
          "Absolute path to an omp executable to run instead of the sidecar Ompanel manages. Ompanel does not verify it.",
        providerSettingsForm: { placeholder: "Managed sidecar", clearWhenEmpty: "omit" },
      }),
    ),
    profile: TrimmedString.check(isOmpProfileName).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Profile",
        description:
          "OMP profile for this instance (`omp --profile`). Each profile keeps its own config, logins and sessions under ~/.omp/profiles. Leave empty for the default profile.",
        providerSettingsForm: { placeholder: "default", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "profile"],
  },
);
export type OmpSettings = typeof OmpSettings.Type;
