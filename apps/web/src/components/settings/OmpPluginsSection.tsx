import {
  formatOmpCommandLine,
  ompPluginCommandArgs,
  ompPluginCommandRunsThirdPartyCode,
  ompPluginTargetAllowed,
  type EnvironmentId,
  type OmpMarketplaceDiscover,
  type OmpPluginCommand,
  type OmpPluginList,
  type OmpUpdateCheck,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { ShieldAlertIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";

/** Toasts a failed OMP call; an interrupted one says nothing. */
export function reportOmpFailure(title: string, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add({
    type: "error",
    title,
    description: error instanceof Error ? error.message : "OMP is unavailable.",
  });
}

const CONFIRM_TITLES: Readonly<Record<OmpPluginCommand["action"], string>> = {
  install: "Install this plugin?",
  uninstall: "Uninstall this plugin?",
  enable: "Enable this plugin?",
  disable: "Disable this plugin?",
  marketplace_add: "Add this marketplace?",
  marketplace_remove: "Remove this marketplace?",
};

const CONFIRM_LABELS: Readonly<Record<OmpPluginCommand["action"], string>> = {
  install: "Install",
  uninstall: "Uninstall",
  enable: "Enable",
  disable: "Disable",
  marketplace_add: "Add marketplace",
  marketplace_remove: "Remove marketplace",
};

const THIRD_PARTY_NOTICE =
  "Plugins are third-party code. Once installed and enabled, a plugin runs on this machine with your permissions in every OMP thread: its tools (which the agent calls as xd:// devices), hooks, commands, skills and MCP servers. Ompanel does not review them.";

/**
 * Asks before one `omp plugin` command runs, showing the exact command line; commands that
 * bring in or turn on third-party code say so first.
 */
function OmpPluginCommandDialog({
  prefix,
  command,
  onCancel,
  onConfirm,
}: {
  readonly prefix: ReadonlyArray<string>;
  readonly command: OmpPluginCommand | null;
  readonly onCancel: () => void;
  readonly onConfirm: (command: OmpPluginCommand) => void;
}) {
  return (
    <AlertDialog
      open={command !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      {command === null ? null : (
        <AlertDialogPopup data-omp-plugin-confirm={command.action}>
          <AlertDialogHeader>
            <AlertDialogTitle>{CONFIRM_TITLES[command.action]}</AlertDialogTitle>
            <AlertDialogDescription>Ompanel will run this command:</AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-3 px-6 pb-2">
            <pre
              className="overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs"
              data-omp-plugin-command
            >
              {formatOmpCommandLine(prefix, ompPluginCommandArgs(command))}
            </pre>
            {ompPluginCommandRunsThirdPartyCode(command) ? (
              <Alert variant="warning">
                <ShieldAlertIcon />
                <AlertTitle>Third-party code</AlertTitle>
                <AlertDescription>
                  {command.action === "marketplace_add"
                    ? "A marketplace is a third-party catalog: OMP clones it, and every plugin installed from it is third-party code."
                    : THIRD_PARTY_NOTICE}{" "}
                  Continue only if you trust its source.
                </AlertDescription>
              </Alert>
            ) : null}
          </div>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant={
                command.action === "uninstall" || command.action === "marketplace_remove"
                  ? "destructive"
                  : "default"
              }
              onClick={() => onConfirm(command)}
            >
              {CONFIRM_LABELS[command.action]}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      )}
    </AlertDialog>
  );
}

function updateSummary(check: OmpUpdateCheck): string {
  const current = check.currentVersion ?? "unknown";
  switch (check.status) {
    case "current":
      return `OMP ${current} is the latest release.`;
    case "available":
      return `OMP ${check.latestVersion ?? "?"} is out; this app ships ${current}. The new OMP reaches Ompanel with an app update.`;
    case "managed":
      return `OMP ${current}: another omp on this machine is managed by a package manager, so OMP could not say whether a newer release exists.`;
    case "unknown":
      return `OMP ${current}: OMP did not say whether a newer release exists.`;
  }
}

/**
 * Settings → OMP → Plugins: installed plugins and marketplaces of this instance's OMP profile,
 * installs and removals through `omp plugin` after a confirmation that shows the command,
 * `/reload-plugins` in running threads, and the `omp update --check` notice.
 */
export function OmpPluginsSection({
  environmentId,
  instanceId,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
}) {
  const listPlugins = useAtomCommand(serverEnvironment.listOmpPlugins, { reportFailure: false });
  const runCommand = useAtomCommand(serverEnvironment.runOmpPluginCommand, {
    reportFailure: false,
  });
  const discover = useAtomCommand(serverEnvironment.discoverOmpMarketplace, {
    reportFailure: false,
  });
  const reload = useAtomCommand(serverEnvironment.reloadOmpPlugins, { reportFailure: false });
  const checkUpdate = useAtomCommand(serverEnvironment.checkOmpUpdate, { reportFailure: false });
  const [list, setList] = useState<OmpPluginList | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [pending, setPending] = useState<OmpPluginCommand | null>(null);
  const [running, setRunning] = useState(false);
  const [installSpec, setInstallSpec] = useState("");
  const [marketplaceSource, setMarketplaceSource] = useState("");
  const [browsing, setBrowsing] = useState<OmpMarketplaceDiscover | null>(null);
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [reloading, setReloading] = useState(false);
  const [update, setUpdate] = useState<OmpUpdateCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const target = { environmentId, input: { instanceId } };

  // The parent keys this section by environment and instance, so it reads once per instance.
  useEffect(() => {
    let cancelled = false;
    void listPlugins({ environmentId, input: { instanceId } }).then((result) => {
      if (cancelled) return;
      if (result._tag === "Success") setList(result.value);
      else if (!isAtomCommandInterrupted(result)) setLoadFailed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, instanceId, listPlugins]);

  if (list === null) {
    return (
      <p className="text-muted-foreground text-xs">
        {loadFailed ? "OMP's plugins are unavailable." : "Reading OMP's plugins…"}
      </p>
    );
  }

  const confirm = (command: OmpPluginCommand) => {
    setPending(null);
    setRunning(true);
    void runCommand({ environmentId, input: { instanceId, command } }).then((result) => {
      setRunning(false);
      if (result._tag !== "Success") {
        reportOmpFailure(
          `${CONFIRM_LABELS[command.action]} failed. Run the command in a terminal to see OMP's message.`,
          result,
        );
        return;
      }
      setList(result.value);
      if (command.action === "install") setInstallSpec("");
      if (command.action === "marketplace_add") setMarketplaceSource("");
      if (command.action === "marketplace_remove" && browsing?.marketplace === command.name) {
        setBrowsing(null);
      }
      toastManager.add({
        type: "success",
        title: `${CONFIRM_LABELS[command.action]}: done`,
        description:
          command.action === "install" || command.action === "enable"
            ? "New threads load it. Reload plugins to load it into running threads."
            : "Reload plugins to apply this to running threads.",
      });
    });
  };

  const browse = (marketplace: string) => {
    setDiscovering(marketplace);
    void discover({ environmentId, input: { instanceId, marketplace } }).then((result) => {
      setDiscovering(null);
      if (result._tag !== "Success") {
        reportOmpFailure(`Could not list ${marketplace}'s plugins`, result);
        return;
      }
      setBrowsing(result.value);
    });
  };

  const reloadThreads = () => {
    setReloading(true);
    void reload(target).then((result) => {
      setReloading(false);
      if (result._tag !== "Success") {
        reportOmpFailure("Could not reload plugins", result);
        return;
      }
      const { reloaded, busy, failed } = result.value;
      const total = reloaded + busy + failed;
      toastManager.add({
        type: failed > 0 ? "warning" : "success",
        title:
          total === 0
            ? "No OMP thread is running; new threads load plugins when they start"
            : `Reloaded plugins in ${reloaded} of ${total} running thread(s)`,
        ...(busy + failed === 0
          ? {}
          : {
              description: [
                busy > 0 ? `${busy} busy with a turn, left alone` : null,
                failed > 0 ? `${failed} did not answer` : null,
              ]
                .filter((part) => part !== null)
                .join("; "),
            }),
      });
    });
  };

  const runUpdateCheck = () => {
    setChecking(true);
    void checkUpdate(target).then((result) => {
      setChecking(false);
      if (result._tag !== "Success") {
        reportOmpFailure("Could not check for OMP updates", result);
        return;
      }
      setUpdate(result.value);
    });
  };

  const installed = new Set(list.plugins.map((plugin) => plugin.id));
  const installSpecValid = ompPluginTargetAllowed(installSpec);
  const marketplaceSourceValid = ompPluginTargetAllowed(marketplaceSource);

  return (
    <section aria-label="OMP plugins" className="flex flex-col gap-5" data-omp-plugins>
      <Alert variant="warning" data-omp-third-party>
        <ShieldAlertIcon />
        <AlertTitle>Plugins are third-party code</AlertTitle>
        <AlertDescription>
          {THIRD_PARTY_NOTICE} Every install, enable and new marketplace is confirmed with the exact
          command first.
        </AlertDescription>
      </Alert>

      <div className="flex flex-col gap-2" data-omp-plugin-list>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium text-sm">Installed</h3>
          <Button
            variant="outline"
            size="xs"
            disabled={reloading}
            onClick={reloadThreads}
            data-omp-reload-plugins
          >
            {reloading ? "Reloading…" : "Reload plugins"}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Reload plugins sends OMP's <code>/reload-plugins</code> to every running thread that is
          not mid-turn; new threads load plugins when they start.
        </p>
        {list.plugins.length === 0 ? (
          <p className="text-muted-foreground text-xs">No plugins installed.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {list.plugins.map((plugin) => (
              <li
                key={`${plugin.source}:${plugin.id}`}
                className="flex flex-wrap items-center gap-2 px-3 py-2"
                data-omp-plugin={plugin.id}
              >
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="break-all font-medium">{plugin.id}</span>
                    <span className="text-muted-foreground text-xs">{plugin.version}</span>
                    <Badge variant="outline" size="sm">
                      {plugin.source}
                    </Badge>
                    {plugin.enabled ? null : (
                      <Badge variant="warning" size="sm">
                        disabled
                      </Badge>
                    )}
                    {plugin.shadowed ? (
                      <Badge variant="info" size="sm">
                        overridden by a project install
                      </Badge>
                    ) : null}
                  </span>
                  {plugin.description === undefined ? null : (
                    <span className="text-muted-foreground text-xs">{plugin.description}</span>
                  )}
                </div>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={running}
                  onClick={() =>
                    setPending({ action: plugin.enabled ? "disable" : "enable", name: plugin.id })
                  }
                >
                  {plugin.enabled ? "Disable" : "Enable"}
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={running}
                  onClick={() => setPending({ action: "uninstall", name: plugin.id })}
                >
                  Uninstall
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (installSpecValid) setPending({ action: "install", spec: installSpec });
          }}
        >
          <Input
            aria-label="Plugin to install"
            className="min-w-0 flex-1"
            placeholder="npm package, github:user/repo, git URL, path or name@marketplace"
            value={installSpec}
            onChange={(event) => setInstallSpec(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={running || !installSpecValid}>
            Install…
          </Button>
        </form>
      </div>

      <div className="flex flex-col gap-2" data-omp-marketplaces>
        <h3 className="font-medium text-sm">Marketplaces</h3>
        {list.marketplaces.length === 0 ? (
          <p className="text-muted-foreground text-xs">No marketplaces configured.</p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {list.marketplaces.map((marketplace) => (
              <li
                key={marketplace.name}
                className="flex flex-wrap items-center gap-2 px-3 py-2"
                data-omp-marketplace={marketplace.name}
              >
                <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-sm">
                  <span className="font-medium">{marketplace.name}</span>
                  <span className="break-all text-muted-foreground text-xs">
                    {marketplace.source}
                  </span>
                </span>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={discovering !== null}
                  onClick={() => browse(marketplace.name)}
                >
                  {discovering === marketplace.name ? "Reading…" : "Browse"}
                </Button>
                <Button
                  variant="outline"
                  size="xs"
                  disabled={running}
                  onClick={() =>
                    setPending({ action: "marketplace_remove", name: marketplace.name })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (marketplaceSourceValid) {
              setPending({ action: "marketplace_add", source: marketplaceSource });
            }
          }}
        >
          <Input
            aria-label="Marketplace to add"
            className="min-w-0 flex-1"
            placeholder="owner/repo, git URL or path"
            value={marketplaceSource}
            onChange={(event) => setMarketplaceSource(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={running || !marketplaceSourceValid}>
            Add marketplace…
          </Button>
        </form>
        {browsing === null ? null : (
          <div className="flex flex-col gap-1" data-omp-marketplace-browse={browsing.marketplace}>
            <div className="flex items-center justify-between gap-2">
              <h4 className="font-medium text-xs">Plugins in {browsing.marketplace}</h4>
              <Button variant="ghost" size="xs" onClick={() => setBrowsing(null)}>
                Close
              </Button>
            </div>
            {browsing.plugins.length === 0 ? (
              <p className="text-muted-foreground text-xs">This marketplace lists no plugins.</p>
            ) : (
              <ul className="flex max-h-96 flex-col divide-y overflow-y-auto rounded-md border">
                {browsing.plugins.map((plugin) => {
                  const spec = `${plugin.name}@${browsing.marketplace}`;
                  return (
                    <li
                      key={plugin.name}
                      className="flex items-center gap-2 px-3 py-2"
                      data-omp-marketplace-plugin={spec}
                    >
                      <div className="flex min-w-0 flex-1 flex-col">
                        <span className="text-sm">
                          <span className="font-medium">{plugin.name}</span>{" "}
                          {plugin.version === undefined ? null : (
                            <span className="text-muted-foreground text-xs">{plugin.version}</span>
                          )}
                        </span>
                        {plugin.description === undefined ? null : (
                          <span className="text-muted-foreground text-xs">
                            {plugin.description}
                          </span>
                        )}
                      </div>
                      {installed.has(spec) ? (
                        <Badge variant="success" size="sm">
                          installed
                        </Badge>
                      ) : (
                        <Button
                          variant="outline"
                          size="xs"
                          disabled={running}
                          onClick={() => setPending({ action: "install", spec })}
                        >
                          Install…
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-2" data-omp-update>
        <div className="flex items-center justify-between gap-2">
          <h3 className="font-medium text-sm">OMP updates</h3>
          <Button variant="outline" size="xs" disabled={checking} onClick={runUpdateCheck}>
            {checking ? "Checking…" : "Check for updates"}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">
          Ompanel ships a pinned OMP. Sidecar updates only arrive with app updates; Ompanel never
          runs OMP's self-update. The check runs <code>omp update --check</code>, which only
          reports.
        </p>
        {update === null ? null : (
          <p className="text-sm" data-omp-update-status={update.status}>
            {updateSummary(update)}
          </p>
        )}
      </div>

      <OmpPluginCommandDialog
        prefix={list.command}
        command={pending}
        onCancel={() => setPending(null)}
        onConfirm={confirm}
      />
    </section>
  );
}
