import type {
  EnvironmentId,
  ProviderRuntimeEntry,
  ProviderRuntimeInstalledVersion,
  ProviderRuntimeInventory,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { useGT } from "gt-react";
import { ChevronDownIcon, ChevronRightIcon, Trash2Icon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { m as resolveNow } from "../../i18n/messages";
import { formatBytes } from "../../lib/formatBytes";
import { ensureLocalApi } from "../../localApi";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export interface ProviderRuntimeMaintenanceSectionProps {
  readonly environmentId: EnvironmentId;
  readonly readOnly: boolean;
  readonly canWriteSettings: boolean;
  readonly canManageProviders: boolean;
  readonly autoPruneOldVersions: boolean;
  readonly onToggleAutoPrune: (enabled: boolean) => void;
  readonly onRuntimeChanged?: (() => void) | undefined;
}

const EMPTY_INVENTORY: ProviderRuntimeInventory = {
  checkedAt: "",
  totalSizeBytes: 0,
  reclaimableBytes: 0,
  autoPruneOldVersions: false,
  runtimes: [],
};

export function ProviderRuntimeMaintenanceSection({
  environmentId,
  readOnly,
  canWriteSettings,
  canManageProviders,
  autoPruneOldVersions,
  onToggleAutoPrune,
  onRuntimeChanged,
}: ProviderRuntimeMaintenanceSectionProps) {
  const gt = useGT();
  const listProviderRuntimes = useAtomCommand(serverEnvironment.listProviderRuntimes, {
    reportFailure: false,
  });
  const checkProviderRuntimeUpdates = useAtomCommand(
    serverEnvironment.checkProviderRuntimeUpdates,
    { reportFailure: false },
  );
  const updateProviderRuntime = useAtomCommand(serverEnvironment.updateProviderRuntime, {
    reportFailure: false,
  });
  const pruneProviderRuntimeVersions = useAtomCommand(
    serverEnvironment.pruneProviderRuntimeVersions,
    {
      reportFailure: false,
    },
  );

  const [inventory, setInventory] = useState<ProviderRuntimeInventory | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [updatingRuntimeId, setUpdatingRuntimeId] = useState<string | null>(null);
  const [pruningKey, setPruningKey] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [expandedOverrides, setExpandedOverrides] = useState<Readonly<Record<string, boolean>>>({});
  const loadGeneration = useRef(0);

  const isBusy = isCheckingUpdates || updatingRuntimeId !== null || pruningKey !== null;

  const errorText = useStableCallback((error: unknown, fallback: string) =>
    error instanceof Error ? (thrownErrorMessage(error, resolveNow) ?? error.message) : fallback,
  );

  const showActionError = useStableCallback(
    (title: string, result: AtomCommandResult<unknown, unknown>) => {
      if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title,
        description: errorText(error, gt("Something went wrong. Try again.")),
      });
    },
  );

  const loadInventory = useStableCallback(() => {
    const generation = ++loadGeneration.current;
    setIsLoading(true);
    setErrorMessage(null);
    void listProviderRuntimes({ environmentId, input: {} }).then((result) => {
      if (loadGeneration.current !== generation) return;
      setIsLoading(false);
      if (result._tag === "Success") {
        setInventory(result.value);
        setErrorMessage(null);
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      const error = squashAtomCommandFailure(result);
      setErrorMessage(errorText(error, gt("Could not load runtime versions.")));
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the runtime inventory from the server on mount; it is command data with no atom to read from
  useEffect(() => {
    loadInventory();
    return () => {
      // Stale responses from a previous environment are discarded by the generation check.
      loadGeneration.current += 1;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reload when the environment changes; the stable loader already reads it
  }, [environmentId, loadInventory]);

  const handleCheckUpdates = async () => {
    if (isBusy) return;
    setIsCheckingUpdates(true);
    const result = await checkProviderRuntimeUpdates({ environmentId, input: {} });
    setIsCheckingUpdates(false);
    if (result._tag === "Success") {
      setInventory(result.value);
      setErrorMessage(null);
      const updateCount = result.value.runtimes.filter((runtime) => runtime.updateAvailable).length;
      toastManager.add({
        type: "success",
        title:
          updateCount > 0
            ? gt("{count} runtime updates available", { count: updateCount })
            : gt("All runtimes are up to date"),
      });
      return;
    }
    showActionError(gt("Could not check runtime updates"), result);
  };

  const handleUpdateRuntime = async (runtime: ProviderRuntimeEntry) => {
    if (isBusy) return;
    setUpdatingRuntimeId(runtime.runtimeId);
    const result = await updateProviderRuntime({
      environmentId,
      input: { runtimeId: runtime.runtimeId, action: "update" },
    });
    setUpdatingRuntimeId(null);
    if (result._tag === "Success") {
      setInventory(result.value.inventory);
      onRuntimeChanged?.();
      toastManager.add({
        type: "success",
        title:
          result.value.activeVersion === null
            ? gt("Updated {name}", { name: runtime.displayName })
            : gt("Updated {name} to v{version}", {
                name: runtime.displayName,
                version: result.value.activeVersion,
              }),
      });
      return;
    }
    showActionError(gt("Could not update {name}", { name: runtime.displayName }), result);
  };

  const handleSwitchVersion = async (
    runtime: ProviderRuntimeEntry,
    version: ProviderRuntimeInstalledVersion,
  ) => {
    if (isBusy) return;
    setUpdatingRuntimeId(runtime.runtimeId);
    const result = await updateProviderRuntime({
      environmentId,
      input: {
        runtimeId: runtime.runtimeId,
        action: "switch",
        targetVersion: version.version,
      },
    });
    setUpdatingRuntimeId(null);
    if (result._tag === "Success") {
      setInventory(result.value.inventory);
      onRuntimeChanged?.();
      toastManager.add({
        type: "success",
        title: gt("Switched {name} to v{version}", {
          name: runtime.displayName,
          version: version.version,
        }),
      });
      return;
    }
    showActionError(gt("Could not switch {name}", { name: runtime.displayName }), result);
  };

  const handleCleanOldVersions = async () => {
    if (inventory === null || isBusy) return;
    const inactiveCount = inventory.runtimes.reduce(
      (count, runtime) => count + runtime.versions.filter((version) => !version.isActive).length,
      0,
    );
    if (inactiveCount === 0) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      gt("Remove {count} old runtime versions and free {size}? Active versions will be kept.", {
        count: inactiveCount,
        size: formatBytes(inventory.reclaimableBytes),
      }),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    setPruningKey("all");
    const result = await pruneProviderRuntimeVersions({ environmentId, input: {} });
    setPruningKey(null);
    if (result._tag === "Success") {
      setInventory(result.value.inventory);
      onRuntimeChanged?.();
      const deletedCount = result.value.deleted.length;
      toastManager.add({
        type: "success",
        title: gt("Cleaned {count} old version(s), freed {size}", {
          count: deletedCount,
          size: formatBytes(result.value.reclaimedBytes),
        }),
      });
      const skippedCount = result.value.skipped.filter(
        (entry) => entry.reason === "in_use" || entry.reason === "failed",
      ).length;
      if (skippedCount > 0) {
        toastManager.add({
          type: "warning",
          title: gt("Skipped {count} version(s) still in use or that could not be removed.", {
            count: skippedCount,
          }),
        });
      }
      return;
    }
    showActionError(gt("Could not remove old runtime versions"), result);
  };

  const handleDeleteVersion = async (
    runtime: ProviderRuntimeEntry,
    version: ProviderRuntimeInstalledVersion,
  ) => {
    if (isBusy) return;
    const confirmed = await ensureLocalApi().dialogs.confirm(
      gt("Delete {name} v{version} and free {size}?", {
        name: runtime.displayName,
        version: version.version,
        size: formatBytes(version.sizeBytes),
      }),
      { variant: "destructive" },
    );
    if (!confirmed) return;
    const key = `${runtime.runtimeId}:${version.version}`;
    setPruningKey(key);
    const result = await pruneProviderRuntimeVersions({
      environmentId,
      input: { runtimeId: runtime.runtimeId, version: version.version },
    });
    setPruningKey(null);
    if (result._tag === "Success") {
      setInventory(result.value.inventory);
      onRuntimeChanged?.();
      if (result.value.deleted.length > 0) {
        toastManager.add({
          type: "success",
          title: gt("Deleted {name} v{version}, freed {size}", {
            name: runtime.displayName,
            version: version.version,
            size: formatBytes(result.value.reclaimedBytes),
          }),
        });
      } else if (result.value.skipped.length > 0) {
        toastManager.add({
          type: "warning",
          title: gt("Skipped {count} version(s) still in use or that could not be removed.", {
            count: result.value.skipped.length,
          }),
        });
      }
      return;
    }
    showActionError(gt("Could not delete the runtime version"), result);
  };

  const current = inventory ?? EMPTY_INVENTORY;
  const summaryDescription =
    isLoading && inventory === null
      ? gt("Scanning installed runtimes...")
      : inventory === null
        ? (errorMessage ?? gt("Could not load runtime versions."))
        : inventory.reclaimableBytes > 0
          ? gt("Managed runtimes use {total} · {count} old versions can free {reclaimable}", {
              total: formatBytes(inventory.totalSizeBytes),
              count: inventory.runtimes.reduce(
                (count, runtime) =>
                  count + runtime.versions.filter((version) => !version.isActive).length,
                0,
              ),
              reclaimable: formatBytes(inventory.reclaimableBytes),
            })
          : gt("Managed runtimes use {total} · No old versions to clean up", {
              total: formatBytes(inventory.totalSizeBytes),
            });

  const showCleanOldVersions = inventory !== null && inventory.reclaimableBytes > 0;

  const runtimeDescription = (runtime: ProviderRuntimeEntry): ReactNode => {
    if (runtime.updateAvailable && runtime.latestVersion !== null) {
      return (
        <span className="text-warning">
          {gt("Update available: v{version}", { version: runtime.latestVersion })}
        </span>
      );
    }
    if (runtime.kind === "bundledSdk") {
      return gt("Bundled with T3 Code (@cursor/sdk) · Updates with T3 Code");
    }
    if (runtime.kind === "systemCli") {
      return (
        <span>
          {gt("Runs from PATH · Update with its own CLI")}
          {runtime.updateCommand !== null ? (
            <>
              {" · "}
              <code>{runtime.updateCommand}</code>
            </>
          ) : null}
        </span>
      );
    }
    if (runtime.lastCheckedAt !== null) return gt("Up to date");
    if (runtime.activeVersion !== null) return gt("Installed");
    return gt("Not installed");
  };

  return (
    <SettingsSection
      title={gt("Runtime versions & storage")}
      headerAction={
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="outline"
            disabled={
              readOnly ||
              !canManageProviders ||
              isCheckingUpdates ||
              updatingRuntimeId !== null ||
              pruningKey !== null
            }
            onClick={() => void handleCheckUpdates()}
          >
            {isCheckingUpdates ? (
              <Spinner size="xs" />
            ) : (
              <RefreshIcon refreshing={isCheckingUpdates} />
            )}
            {gt("Check updates")}
          </Button>
          {showCleanOldVersions ? (
            <Button
              size="xs"
              variant="outline"
              disabled={readOnly || !canManageProviders || isBusy}
              onClick={() => void handleCleanOldVersions()}
            >
              {gt("Clean old versions")}
            </Button>
          ) : null}
        </div>
      }
    >
      <SettingsRow
        title={gt("Managed runtimes")}
        description={summaryDescription}
        control={
          inventory === null && !isLoading ? (
            <Button
              size="xs"
              variant="outline"
              disabled={isLoading}
              onClick={() => void loadInventory()}
            >
              {gt("Retry")}
            </Button>
          ) : null
        }
      />
      <SettingsRow
        title={gt("Auto-clean old versions after update")}
        description={gt(
          "Automatically remove previous runtime versions after a managed agent finishes updating.",
        )}
        control={
          <Switch
            checked={autoPruneOldVersions}
            disabled={readOnly || !canWriteSettings}
            onCheckedChange={(checked) => onToggleAutoPrune(Boolean(checked))}
            aria-label={gt("Auto-clean old versions after update")}
          />
        }
      />
      {current.runtimes.map((runtime) => {
        const versionsExpanded =
          expandedOverrides[runtime.runtimeId] ?? runtime.versions.length > 1;
        const runtimeUpdating = updatingRuntimeId === runtime.runtimeId;
        const updateLabel =
          runtime.updateAvailable && runtime.latestVersion !== null
            ? gt("Update to v{version}", { version: runtime.latestVersion })
            : runtime.activeVersion === null
              ? gt("Install")
              : gt("Update");
        return (
          <div key={runtime.runtimeId} data-runtime-id={runtime.runtimeId}>
            <SettingsRow
              title={
                <span className="inline-flex min-w-0 items-center gap-2">
                  <ProviderInstanceIcon
                    driverKind={runtime.driver}
                    displayName={runtime.displayName}
                    {...(runtime.agentId === undefined
                      ? {}
                      : { acpRegistryAgentId: runtime.agentId })}
                    showBadge={false}
                    className="size-5"
                    iconClassName="size-4 text-foreground/80"
                  />
                  <span className="truncate">{runtime.displayName}</span>
                  {runtime.usedByInstanceIds.length > 0 ? (
                    <span className="truncate font-mono text-xs font-normal text-muted-foreground">
                      {runtime.usedByInstanceIds.join(", ")}
                    </span>
                  ) : null}
                  {runtime.activeVersion !== null ? (
                    <Badge variant="outline" size="sm">
                      <span className="font-mono font-normal">v{runtime.activeVersion}</span>
                    </Badge>
                  ) : null}
                  {runtime.totalSizeBytes > 0 ? (
                    <span className="shrink-0 text-xs font-normal text-muted-foreground">
                      {formatBytes(runtime.totalSizeBytes)}
                    </span>
                  ) : null}
                </span>
              }
              description={runtimeDescription(runtime)}
              control={
                <div className="flex items-center gap-2">
                  {runtime.canUpdate && !readOnly && canManageProviders ? (
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={isBusy}
                      onClick={() => void handleUpdateRuntime(runtime)}
                    >
                      {runtimeUpdating ? <Spinner size="xs" /> : null}
                      {updateLabel}
                    </Button>
                  ) : null}
                  {runtime.versions.length > 0 ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-expanded={versionsExpanded}
                      aria-label={gt("Toggle versions for {name}", { name: runtime.displayName })}
                      onClick={() =>
                        setExpandedOverrides((current) => ({
                          ...current,
                          [runtime.runtimeId]: !versionsExpanded,
                        }))
                      }
                    >
                      {versionsExpanded ? (
                        <ChevronDownIcon className="size-3" aria-hidden />
                      ) : (
                        <ChevronRightIcon className="size-3" aria-hidden />
                      )}
                      {runtime.versions.length}
                    </Button>
                  ) : null}
                </div>
              }
            />
            {runtime.versions.length > 0 && versionsExpanded ? (
              <div className="border-t border-border/40 bg-background/40">
                <div className="divide-y divide-border/40">
                  {runtime.versions.map((version) => {
                    const versionPruning = pruningKey === `${runtime.runtimeId}:${version.version}`;
                    return (
                      <div
                        key={version.id}
                        data-version={`${runtime.runtimeId}:${version.version}`}
                        className="flex items-center gap-3 px-3 py-2 pl-9 text-xs sm:px-4 sm:pl-10"
                      >
                        <span className="font-mono text-xs text-foreground">
                          v{version.version}
                        </span>
                        <span className="text-muted-foreground">
                          {formatBytes(version.sizeBytes)}
                        </span>
                        <span className="ml-auto flex items-center gap-2">
                          {version.isActive ? (
                            <Badge variant="secondary">{gt("Active")}</Badge>
                          ) : (
                            <>
                              {runtime.canSwitchVersion && !readOnly && canManageProviders ? (
                                <Button
                                  size="xs"
                                  variant="ghost"
                                  disabled={isBusy}
                                  onClick={() => void handleSwitchVersion(runtime, version)}
                                >
                                  {gt("Switch")}
                                </Button>
                              ) : null}
                              {runtime.canPrune && !readOnly && canManageProviders ? (
                                <Button
                                  size="icon-xs"
                                  variant="ghost-destructive"
                                  disabled={isBusy}
                                  aria-label={gt("Delete version {version} of {name}", {
                                    version: version.version,
                                    name: runtime.displayName,
                                  })}
                                  onClick={() => void handleDeleteVersion(runtime, version)}
                                >
                                  {versionPruning ? <Spinner size="xs" /> : <Trash2Icon />}
                                </Button>
                              ) : null}
                            </>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </SettingsSection>
  );
}
