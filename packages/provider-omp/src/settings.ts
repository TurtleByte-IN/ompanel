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

// Same rule the sidecar resolver enforces (absolute after `~` expansion), so a relative path is
// rejected in the form rather than only on the status card. No node:path: this runs in browsers.
const ABSOLUTE_PATH = /^(?:\/|~(?:$|[\\/])|[A-Za-z]:[\\/]|\\\\)/;

const isAbsoluteBinaryPath = Schema.makeFilter(
  (value: string) => value === "" || ABSOLUTE_PATH.test(value),
  { expected: "an absolute path to an omp executable (or ~/...)" },
);

const isAbsoluteAgentDir = Schema.makeFilter(
  (value: string) => value === "" || ABSOLUTE_PATH.test(value),
  { expected: "an absolute path to a directory (or ~/...)" },
);

export const OmpSettings = makeProviderSettingsSchema(
  {
    enabled: Schema.Boolean.pipe(
      Schema.withDecodingDefault(Effect.succeed(false)),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
    binaryPath: TrimmedString.check(isAbsoluteBinaryPath).pipe(
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
    agentDir: TrimmedString.check(isAbsoluteAgentDir).pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Agent directory",
        description:
          "OMP's agent directory (config.yml, models.yml, sessions). Sets PI_CODING_AGENT_DIR for every omp this instance runs. Leave empty for OMP's default, or the profile's; a profile has its own, so set one or the other.",
        providerSettingsForm: { placeholder: "~/.omp/agent", clearWhenEmpty: "omit" },
      }),
    ),
    launchArgs: TrimmedString.pipe(
      Schema.withDecodingDefault(Effect.succeed("")),
      Schema.annotateKey({
        title: "Launch arguments",
        description:
          "Extra CLI arguments for every omp session this instance starts (threads, text generation, its RPC servers), not for `omp config`, `omp plugin` or other subcommands. Flags Ompanel sets itself (mode, cwd, profile, config, session, approval, model) are refused.",
        providerSettingsForm: { placeholder: "--thinking high", clearWhenEmpty: "omit" },
      }),
    ),
    customModels: Schema.Array(CustomModelSetting).pipe(
      Schema.withDecodingDefault(Effect.succeed([])),
      Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
    ),
  },
  {
    order: ["binaryPath", "profile", "agentDir", "launchArgs"],
  },
);
export type OmpSettings = typeof OmpSettings.Type;
