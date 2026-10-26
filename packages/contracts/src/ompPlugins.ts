import * as Schema from "effect/Schema";

import { ProviderInstanceId } from "./providerInstance.ts";

/** Settings → OMP → Plugins and Skills read one instance at a time. */
export const OmpPluginsInput = Schema.Struct({ instanceId: ProviderInstanceId });
export type OmpPluginsInput = typeof OmpPluginsInput.Type;

/** The longest plugin spec, plugin name, marketplace source or name Ompanel passes to omp. */
const OMP_PLUGIN_TARGET_MAX_LENGTH = 512;

/**
 * A spec, name or source Ompanel may pass to `omp plugin`: one argument with no surrounding
 * space, no control characters and no leading `-`, so it can never read as a flag. A leading `~`
 * is refused too: no shell expands it on the way to omp, so it would not name the home directory.
 */
export const ompPluginTargetAllowed = (target: string): boolean =>
  target.length > 0 &&
  target.length <= OMP_PLUGIN_TARGET_MAX_LENGTH &&
  target.trim() === target &&
  !target.startsWith("-") &&
  !target.startsWith("~") &&
  // oxlint-disable-next-line no-control-regex -- control characters are what is refused.
  !/[\u0000-\u001f\u007f]/.test(target);

const OmpPluginTarget = Schema.String.check(
  Schema.makeFilter((target: string) => ompPluginTargetAllowed(target), {
    expected: "one argument without control characters, surrounding space or a leading '-' or '~'",
  }),
);

/**
 * What the Plugins page asks omp to change. Each maps to exactly one `omp plugin` command
 * ({@link ompPluginCommandArgs}); the page shows that command before it runs.
 */
export const OmpPluginCommand = Schema.Union([
  /** `omp plugin install <spec>`: npm package, `github:`/git URL, local path or `name@marketplace`. */
  Schema.Struct({ action: Schema.Literal("install"), spec: OmpPluginTarget }),
  Schema.Struct({ action: Schema.Literal("uninstall"), name: OmpPluginTarget }),
  Schema.Struct({ action: Schema.Literal("enable"), name: OmpPluginTarget }),
  Schema.Struct({ action: Schema.Literal("disable"), name: OmpPluginTarget }),
  /** `omp plugin marketplace add <source>`: a GitHub `owner/repo`, git URL or local path. */
  Schema.Struct({ action: Schema.Literal("marketplace_add"), source: OmpPluginTarget }),
  Schema.Struct({ action: Schema.Literal("marketplace_remove"), name: OmpPluginTarget }),
]);
export type OmpPluginCommand = typeof OmpPluginCommand.Type;

/** The `omp` arguments of a command, after any `--profile`. */
export const ompPluginCommandArgs = (command: OmpPluginCommand): ReadonlyArray<string> => {
  switch (command.action) {
    case "install":
      return ["plugin", "install", command.spec];
    case "uninstall":
      return ["plugin", "uninstall", command.name];
    case "enable":
      return ["plugin", "enable", command.name];
    case "disable":
      return ["plugin", "disable", command.name];
    case "marketplace_add":
      return ["plugin", "marketplace", "add", command.source];
    case "marketplace_remove":
      return ["plugin", "marketplace", "remove", command.name];
  }
};

/** True for commands that bring third-party code onto the machine or turn it on. */
export const ompPluginCommandRunsThirdPartyCode = (command: OmpPluginCommand): boolean =>
  command.action === "install" ||
  command.action === "enable" ||
  command.action === "marketplace_add";

/**
 * POSIX-shell quoting of one argument, for showing a command the way a terminal takes it.
 * `[ ]` (globs), `~` (home) and `=` (zsh equals expansion) are quoted too, so a shell runs
 * exactly the argument Ompanel passes.
 */
const shellQuote = (arg: string): string =>
  /^[\w@%+:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

/** The command line shown before a command runs: `prefix` from {@link OmpPluginList.command}. */
export const formatOmpCommandLine = (
  prefix: ReadonlyArray<string>,
  args: ReadonlyArray<string>,
): string => [...prefix, ...args].map(shellQuote).join(" ");

/** One installed plugin, from `omp plugin list --json`. */
export const OmpInstalledPlugin = Schema.Struct({
  /** What `uninstall`, `enable` and `disable` take: the npm name or `name@marketplace`. */
  id: Schema.String,
  source: Schema.Literals(["npm", "marketplace"]),
  version: Schema.String,
  enabled: Schema.Boolean,
  description: Schema.optionalKey(Schema.String),
  /** Marketplace installs only; Ompanel installs at user scope. */
  scope: Schema.optionalKey(Schema.Literals(["user", "project"])),
  /** A user install overridden by a project install of the same plugin. */
  shadowed: Schema.Boolean,
});
export type OmpInstalledPlugin = typeof OmpInstalledPlugin.Type;

/** A configured marketplace, from `omp plugin marketplace list`. */
export const OmpMarketplace = Schema.Struct({ name: Schema.String, source: Schema.String });
export type OmpMarketplace = typeof OmpMarketplace.Type;

export const OmpPluginList = Schema.Struct({
  /** How Ompanel starts this instance's omp, as shown: `omp`, then `--profile <p>` if set. */
  command: Schema.Array(Schema.String),
  plugins: Schema.Array(OmpInstalledPlugin),
  marketplaces: Schema.Array(OmpMarketplace),
});
export type OmpPluginList = typeof OmpPluginList.Type;

export const OmpPluginCommandInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  command: OmpPluginCommand,
});
export type OmpPluginCommandInput = typeof OmpPluginCommandInput.Type;

export const OmpMarketplaceDiscoverInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  marketplace: OmpPluginTarget,
});
export type OmpMarketplaceDiscoverInput = typeof OmpMarketplaceDiscoverInput.Type;

/** One plugin a marketplace offers, from `omp plugin discover <marketplace>`. */
export const OmpMarketplacePlugin = Schema.Struct({
  name: Schema.String,
  version: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.String),
});
export type OmpMarketplacePlugin = typeof OmpMarketplacePlugin.Type;

export const OmpMarketplaceDiscover = Schema.Struct({
  marketplace: Schema.String,
  plugins: Schema.Array(OmpMarketplacePlugin),
});
export type OmpMarketplaceDiscover = typeof OmpMarketplaceDiscover.Type;

/** `/reload-plugins` sent to this instance's running threads. */
export const OmpPluginsReloadResult = Schema.Struct({
  reloaded: Schema.Number,
  /** Threads in the middle of a turn, left alone. */
  busy: Schema.Number,
  failed: Schema.Number,
});
export type OmpPluginsReloadResult = typeof OmpPluginsReloadResult.Type;

/**
 * `omp update --check`. Ompanel never installs an update: the sidecar is pinned and only
 * changes with an app update.
 */
export const OmpUpdateCheck = Schema.Struct({
  /** `available`: a newer omp exists upstream; `managed`: a package manager owns the omp on PATH. */
  status: Schema.Literals(["current", "available", "managed", "unknown"]),
  currentVersion: Schema.NullOr(Schema.String),
  latestVersion: Schema.NullOr(Schema.String),
});
export type OmpUpdateCheck = typeof OmpUpdateCheck.Type;

/** One skill a session would load, from `omp skill list <dir> --json`. */
export const OmpSkill = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  filePath: Schema.String,
  /** OMP's provider and level, e.g. `native:user`, `claude:project`, `claude-plugins:user`. */
  source: Schema.String,
  /** Hidden from the model's skill list; still invocable by name. */
  hidden: Schema.Boolean,
});
export type OmpSkill = typeof OmpSkill.Type;

export const OmpSkillsList = Schema.Struct({
  skills: Schema.Array(OmpSkill),
  warnings: Schema.Array(Schema.Struct({ skillPath: Schema.String, message: Schema.String })),
});
export type OmpSkillsList = typeof OmpSkillsList.Type;

export const OmpPluginsOperationErrorReason = Schema.Literals([
  "instance_not_found",
  "unsupported",
  "timeout",
  "omp_failed",
]);
export type OmpPluginsOperationErrorReason = typeof OmpPluginsOperationErrorReason.Type;

/** Carries no omp output: it may echo a spec or URL with credentials in it. */
export class OmpPluginsOperationError extends Schema.TaggedError<OmpPluginsOperationError>()(
  "OmpPluginsOperationError",
  {
    reason: OmpPluginsOperationErrorReason,
    message: Schema.String,
  },
) {}
