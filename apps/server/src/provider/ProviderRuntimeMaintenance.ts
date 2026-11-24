import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeMaintenanceError,
  type CheckProviderRuntimeUpdatesInput,
  type PruneProviderRuntimeVersionsInput,
  type PruneProviderRuntimeVersionsResult,
  type ProviderRuntimeEntry,
  type ProviderRuntimeInstalledVersion,
  type ProviderRuntimeInventory,
  type ProviderRuntimeKind,
  type ProviderRuntimePruneSkipReason,
  type ServerProvider,
  type UpdateProviderRuntimeInput,
  type UpdateProviderRuntimeResult,
} from "@t3tools/contracts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as NodeModule from "node:module";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");
const ANTIGRAVITY_DRIVER = ProviderDriverKind.make("antigravity");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CURSOR_DRIVER = ProviderDriverKind.make("cursor");

const FACTORY_DROID_AGENT_ID = "factory-droid";
const CURSOR_SDK_FALLBACK_VERSION = "1.4.2";
const CURSOR_SDK_NOTE = "Bundled with T3 Code (@cursor/sdk); updates together with T3 Code.";
const CODEX_SYSTEM_CLI_NOTE =
  "Codex runs from your PATH; update it with its own CLI or package manager.";
// Tool directories owned by other runtimes, or by no runtime at all.
const ACP_TOOLS_DIRECTORY_SKIP = new Set(["antigravity-acp", "codex", "chrome-headless-shell"]);
const PLATFORM_TARGET_DIRECTORY = /^(?:darwin|linux|windows)-(?:aarch64|x86_64)$/u;
const SEMVER_DIRECTORY = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const PACKAGE_RECEIPT_FILE = /^(.+)-[0-9a-f]{16}\.json$/u;

const decodeJsonUnknown = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const requireForSdk = NodeModule.createRequire(import.meta.url);

function readBundledCursorSdkVersion(): string {
  try {
    const manifest = requireForSdk("@cursor/sdk/package.json") as { readonly version?: unknown };
    return typeof manifest.version === "string" && manifest.version.trim().length > 0
      ? manifest.version.trim()
      : CURSOR_SDK_FALLBACK_VERSION;
  } catch {
    return CURSOR_SDK_FALLBACK_VERSION;
  }
}

const CURSOR_SDK_VERSION = readBundledCursorSdkVersion();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "string" && field.trim().length > 0 ? field.trim() : undefined;
}

function titleCaseIdentifier(identifier: string): string {
  const words = identifier.split(/[._-]+/u).filter((word) => word.length > 0);
  if (words.length === 0) return identifier;
  return words.map((word) => `${word[0]!.toUpperCase()}${word.slice(1)}`).join(" ");
}

const maintenanceError = (operation: string, detail: string, cause?: unknown) =>
  cause === undefined
    ? new ProviderRuntimeMaintenanceError({ operation, detail })
    : new ProviderRuntimeMaintenanceError({ operation, detail, cause });

interface InstanceReference {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly config: Record<string, unknown> | undefined;
}

interface ManagedRuntimeVersion {
  readonly id: string;
  readonly version: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly isActive: boolean;
  readonly installedAt: string | null;
}

const pruneFailureReason = (error: unknown): ProviderRuntimePruneSkipReason => {
  const record = error as {
    readonly code?: unknown;
    readonly reason?: { readonly _tag?: unknown };
  } | null;
  const reasonTag = record?.reason?._tag;
  const code = record?.code;
  return reasonTag === "PermissionDenied" ||
    reasonTag === "Busy" ||
    code === "EBUSY" ||
    code === "EPERM"
    ? "in_use"
    : "failed";
};

const sumBytes = (versions: ReadonlyArray<{ readonly sizeBytes: number }>): number =>
  versions.reduce((total, version) => total + version.sizeBytes, 0);

const runtimeEntryBase = (input: {
  readonly runtimeId: string;
  readonly displayName: string;
  readonly driver: ProviderDriverKind;
  readonly kind: ProviderRuntimeKind;
  readonly usedByInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly activeVersion: string | null;
  readonly latestVersion: string | null;
  readonly totalSizeBytes: number;
  readonly reclaimableBytes: number;
  readonly versions: ReadonlyArray<ProviderRuntimeInstalledVersion>;
  readonly lastCheckedAt: string | null;
  readonly agentId?: string;
  readonly distribution?: string;
  readonly updateCommand?: string | null;
  readonly note?: string | null;
}): ProviderRuntimeEntry => {
  const updateAvailable = Boolean(
    input.latestVersion !== null &&
    input.activeVersion !== null &&
    compareSemverVersions(input.latestVersion, input.activeVersion) > 0,
  );
  return {
    runtimeId: input.runtimeId,
    displayName: input.displayName,
    driver: input.driver,
    kind: input.kind,
    ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
    ...(input.distribution === undefined ? {} : { distribution: input.distribution }),
    usedByInstanceIds: [...input.usedByInstanceIds],
    activeVersion: input.activeVersion,
    latestVersion: input.latestVersion,
    updateAvailable,
    canCheckUpdate: true,
    canUpdate: Boolean(updateAvailable || input.activeVersion === null),
    canSwitchVersion: input.versions.length > 1,
    canPrune: input.versions.some((version) => !version.isActive),
    updateCommand: input.updateCommand ?? null,
    note: input.note ?? null,
    totalSizeBytes: input.totalSizeBytes,
    reclaimableBytes: input.reclaimableBytes,
    versions: [...input.versions],
    lastCheckedAt: input.lastCheckedAt,
  };
};

export class ProviderRuntimeMaintenance extends Context.Service<
  ProviderRuntimeMaintenance,
  {
    readonly listRuntimes: () => Effect.Effect<
      ProviderRuntimeInventory,
      ProviderRuntimeMaintenanceError
    >;
    readonly checkUpdates: (
      input: CheckProviderRuntimeUpdatesInput,
    ) => Effect.Effect<ProviderRuntimeInventory, ProviderRuntimeMaintenanceError>;
    readonly updateRuntime: (
      input: UpdateProviderRuntimeInput,
    ) => Effect.Effect<UpdateProviderRuntimeResult, ProviderRuntimeMaintenanceError>;
    readonly pruneVersions: (
      input: PruneProviderRuntimeVersionsInput,
    ) => Effect.Effect<PruneProviderRuntimeVersionsResult, ProviderRuntimeMaintenanceError>;
  }
>()("t3/provider/ProviderRuntimeMaintenance") {
  static readonly layer = Layer.effect(
    ProviderRuntimeMaintenance,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const serverSettings = yield* ServerSettings.ServerSettingsService;
      const providers = yield* ProviderRegistry.ProviderRegistry;
      const acpRegistryCatalog = yield* AcpRegistrySupport.AcpRegistryCatalog;
      const antigravityInstallation = yield* AntigravityInstallation.AntigravityInstallation;
      const codexInstallation = yield* CodexInstallation.CodexInstallation;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const toolsDirectory = path.join(config.baseDir, "tools");
      const acpRegistryCacheDirectory = path.join(config.providerStatusCacheDir, "acp-registry");

      const readSettings = serverSettings.getSettings.pipe(
        Effect.mapError((cause) =>
          maintenanceError("settings", "Could not read server settings.", cause),
        ),
      );

      const readOptionalJson = (filePath: string) =>
        fileSystem.readFileString(filePath).pipe(
          Effect.flatMap(decodeJsonUnknown),
          Effect.orElseSucceed((): unknown => undefined),
        );

      const pathExists = (candidate: string) =>
        fileSystem.exists(candidate).pipe(Effect.orElseSucceed(() => false));

      const readDirectoryNames = (directory: string) =>
        fileSystem
          .readDirectory(directory)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

      const fileInfo = (filePath: string) => fileSystem.stat(filePath).pipe(Effect.option);

      const directorySizeBytes = Effect.fn("ProviderRuntimeMaintenance.directorySizeBytes")(
        function* (directory: string): Effect.fn.Return<number, never, never> {
          const info = yield* fileInfo(directory);
          if (Option.isNone(info)) return 0;
          if (info.value.type === "File") return Number(info.value.size);
          if (info.value.type !== "Directory") return 0;
          let total = 0;
          for (const entry of yield* readDirectoryNames(directory)) {
            total += yield* directorySizeBytes(path.join(directory, entry));
          }
          return total;
        },
      );

      const readInstanceReferences = Effect.fn("ProviderRuntimeMaintenance.readInstanceReferences")(
        function* () {
          const settings = yield* readSettings;
          const references: Array<InstanceReference> = [];
          for (const [rawInstanceId, instance] of Object.entries(settings.providerInstances)) {
            references.push({
              instanceId: ProviderInstanceId.make(rawInstanceId),
              driver: instance.driver,
              config: isRecord(instance.config) ? instance.config : undefined,
            });
          }
          return references;
        },
      );

      const instancesForDriver = (
        references: ReadonlyArray<InstanceReference>,
        driver: ProviderDriverKind,
      ): ReadonlyArray<ProviderInstanceId> =>
        references.filter((reference) => reference.driver === driver).map((r) => r.instanceId);

      const readKnownAcpAgentIds = Effect.fn("ProviderRuntimeMaintenance.readKnownAcpAgentIds")(
        function* () {
          const configured = new Map<string, Array<ProviderInstanceId>>();
          for (const reference of yield* readInstanceReferences()) {
            if (reference.driver !== ACP_REGISTRY_DRIVER) continue;
            if (reference.config?.source === "local") continue;
            const agentId = stringField(reference.config, "agentId");
            if (agentId === undefined) continue;
            const group = configured.get(agentId) ?? [];
            group.push(reference.instanceId);
            configured.set(agentId, group);
          }

          const known = new Set(configured.keys());
          const registryNames = new Map<string, string>();
          const cachedRegistry = yield* readOptionalJson(
            path.join(acpRegistryCacheDirectory, "registry.json"),
          );
          if (isRecord(cachedRegistry) && Array.isArray(cachedRegistry.agents)) {
            for (const agent of cachedRegistry.agents) {
              if (!isRecord(agent)) continue;
              const agentId = stringField(agent, "id");
              if (agentId === undefined) continue;
              const name = stringField(agent, "name");
              if (name !== undefined) registryNames.set(agentId, name);
            }
          }

          for (const file of yield* readDirectoryNames(
            path.join(acpRegistryCacheDirectory, "package-installs"),
          )) {
            const match = PACKAGE_RECEIPT_FILE.exec(file);
            const agentId = match?.[1]?.trim();
            if (agentId !== undefined && agentId.length > 0) known.add(agentId);
          }

          for (const directoryName of yield* readDirectoryNames(toolsDirectory)) {
            if (directoryName.startsWith(".") || ACP_TOOLS_DIRECTORY_SKIP.has(directoryName)) {
              continue;
            }
            if (known.has(directoryName)) continue;
            const agentRoot = path.join(toolsDirectory, directoryName);
            for (const versionName of yield* readDirectoryNames(agentRoot)) {
              const children = yield* readDirectoryNames(path.join(agentRoot, versionName));
              if (
                children.includes("npm") ||
                children.includes("python") ||
                children.some((child) => PLATFORM_TARGET_DIRECTORY.test(child))
              ) {
                known.add(directoryName);
                break;
              }
            }
          }
          return { configured, known, registryNames };
        },
      );

      const listAcpRuntimes = Effect.fn("ProviderRuntimeMaintenance.listAcpRuntimes")(function* () {
        const { configured, known, registryNames } = yield* readKnownAcpAgentIds();
        const listManagedVersions = acpRegistryCatalog.listManagedVersions;
        if (listManagedVersions === undefined) return [];

        const entries: Array<ProviderRuntimeEntry> = [];
        for (const agentId of [...known].toSorted()) {
          const managed = yield* listManagedVersions(agentId).pipe(Effect.option);
          if (Option.isNone(managed)) continue;
          const versions: Array<ProviderRuntimeInstalledVersion> = managed.value.versions.map(
            (version) => ({
              version: version.version,
              id: version.id,
              sizeBytes: version.sizeBytes,
              isActive: version.isActive,
              installedAt: version.installedAt,
              path: version.path,
            }),
          );
          const inactive = versions.filter((version) => !version.isActive);
          const displayName =
            agentId === FACTORY_DROID_AGENT_ID
              ? "Factory Droid"
              : (registryNames.get(agentId) ?? titleCaseIdentifier(agentId));
          entries.push(
            runtimeEntryBase({
              runtimeId: `acp:${agentId}`,
              displayName,
              driver: ACP_REGISTRY_DRIVER,
              kind: "acpRegistry",
              agentId,
              ...(managed.value.distribution === null
                ? {}
                : { distribution: managed.value.distribution }),
              usedByInstanceIds: configured.get(agentId) ?? [],
              activeVersion: managed.value.activeVersion,
              latestVersion: managed.value.latestVersion,
              totalSizeBytes: sumBytes(versions),
              reclaimableBytes: sumBytes(inactive),
              versions,
              lastCheckedAt: managed.value.lastCheckedAt,
            }),
          );
        }
        return entries;
      });

      const listManagedRuntimeVersions = Effect.fn(
        "ProviderRuntimeMaintenance.listManagedRuntimeVersions",
      )(function* (input: {
        readonly managedDirectory: string;
        readonly activeId: string | undefined;
        readonly recordVersion: (record: unknown) => string | undefined;
        readonly isVersionDirectory: (directoryName: string) => boolean;
      }) {
        const versions: Array<ManagedRuntimeVersion> = [];
        for (const directoryName of yield* readDirectoryNames(input.managedDirectory)) {
          if (!input.isVersionDirectory(directoryName)) continue;
          const directory = path.join(input.managedDirectory, directoryName);
          const info = yield* fileInfo(directory);
          if (Option.isNone(info) || info.value.type !== "Directory") continue;
          const record = yield* readOptionalJson(path.join(directory, ".install-complete.json"));
          const version =
            input.recordVersion(record) ??
            (SEMVER_DIRECTORY.test(directoryName) ? directoryName : undefined);
          if (version === undefined) continue;
          versions.push({
            id: directoryName,
            version,
            path: directory,
            sizeBytes: yield* directorySizeBytes(directory),
            isActive: input.activeId === directoryName || input.activeId === version,
            installedAt: Option.isSome(info.value.mtime)
              ? info.value.mtime.value.toISOString()
              : null,
          });
        }
        versions.sort((left, right) => compareSemverVersions(right.version, left.version));
        return versions;
      });

      const listAntigravityRuntime = Effect.fn("ProviderRuntimeMaintenance.listAntigravityRuntime")(
        function* (references: ReadonlyArray<InstanceReference>) {
          const usedBy = instancesForDriver(references, ANTIGRAVITY_DRIVER);
          const managedRoot = path.join(toolsDirectory, "antigravity-acp");
          if (usedBy.length === 0 && !(yield* pathExists(managedRoot))) return undefined;

          const state = yield* antigravityInstallation.state;
          const activeRecord = yield* readOptionalJson(
            path.join(antigravityInstallation.managedDirectory, "active.json"),
          );
          const activeReleaseId = stringField(activeRecord, "releaseId");
          const versions = yield* listManagedRuntimeVersions({
            managedDirectory: path.join(antigravityInstallation.managedDirectory, "versions"),
            activeId: activeReleaseId,
            recordVersion: (record) => stringField(record, "version"),
            isVersionDirectory: () => true,
          });
          const activeVersion =
            versions.find((version) => version.isActive)?.version ?? state.installedVersion ?? null;
          const latestVersion = state.version ?? null;
          const installedVersions: ReadonlyArray<ProviderRuntimeInstalledVersion> = versions.map(
            (version) => ({
              version: version.version,
              id: version.id,
              sizeBytes: version.sizeBytes,
              isActive: version.isActive,
              installedAt: version.installedAt,
              path: version.path,
            }),
          );
          return {
            ...runtimeEntryBase({
              runtimeId: "antigravity",
              displayName: "Antigravity",
              driver: ANTIGRAVITY_DRIVER,
              kind: "managedBinary",
              usedByInstanceIds: usedBy,
              activeVersion,
              latestVersion,
              totalSizeBytes: sumBytes(installedVersions),
              reclaimableBytes: sumBytes(installedVersions.filter((version) => !version.isActive)),
              versions: installedVersions,
              lastCheckedAt: null,
            }),
            canSwitchVersion: false,
          } satisfies ProviderRuntimeEntry;
        },
      );

      const listCodexRuntime = Effect.fn("ProviderRuntimeMaintenance.listCodexRuntime")(function* (
        references: ReadonlyArray<InstanceReference>,
        liveProviders: ReadonlyArray<ServerProvider>,
      ) {
        const usedBy = instancesForDriver(references, CODEX_DRIVER);
        const managedRoot = path.join(toolsDirectory, "codex");
        const managedConfigured = references.some(
          (reference) =>
            reference.driver === CODEX_DRIVER && reference.config?.setupMode === "managed",
        );
        const managedExists = yield* pathExists(managedRoot);
        if (usedBy.length === 0 && !managedExists) return undefined;

        const liveCodex = liveProviders.find((provider) => provider.driver === CODEX_DRIVER);
        const activeRecord = yield* readOptionalJson(
          path.join(codexInstallation.managedDirectory, "active.json"),
        );
        const activeVersionFromDisk = stringField(activeRecord, "version");
        const state = yield* codexInstallation.state;
        const versions = yield* listManagedRuntimeVersions({
          managedDirectory: codexInstallation.managedDirectory,
          activeId: activeVersionFromDisk,
          recordVersion: (record) => stringField(record, "version"),
          isVersionDirectory: (directoryName) => SEMVER_DIRECTORY.test(directoryName),
        });

        if (versions.length === 0 && !managedConfigured) {
          const advisory = liveCodex?.versionAdvisory;
          const activeVersion = liveCodex?.installedVersion ?? liveCodex?.version ?? null;
          return {
            ...runtimeEntryBase({
              runtimeId: "codex",
              displayName: "Codex",
              driver: CODEX_DRIVER,
              kind: "systemCli",
              usedByInstanceIds: usedBy,
              activeVersion,
              latestVersion: advisory?.latestVersion ?? null,
              updateCommand: advisory?.updateCommand ?? null,
              totalSizeBytes: 0,
              reclaimableBytes: 0,
              versions: [],
              lastCheckedAt: advisory?.checkedAt ?? null,
              note: CODEX_SYSTEM_CLI_NOTE,
            }),
            canUpdate: advisory?.canUpdate ?? false,
            canPrune: false,
            canSwitchVersion: false,
          } satisfies ProviderRuntimeEntry;
        }

        const installedVersions: ReadonlyArray<ProviderRuntimeInstalledVersion> = versions.map(
          (version) => ({
            version: version.version,
            id: version.id,
            sizeBytes: version.sizeBytes,
            isActive: version.isActive,
            installedAt: version.installedAt,
            path: version.path,
          }),
        );
        const activeVersion =
          installedVersions.find((version) => version.isActive)?.version ??
          state.installedVersion ??
          activeVersionFromDisk ??
          null;
        return {
          ...runtimeEntryBase({
            runtimeId: "codex",
            displayName: "Codex",
            driver: CODEX_DRIVER,
            kind: "managedBinary",
            usedByInstanceIds: usedBy,
            activeVersion,
            latestVersion:
              state.version ??
              liveCodex?.versionAdvisory?.latestVersion ??
              activeVersionFromDisk ??
              null,
            totalSizeBytes: sumBytes(installedVersions),
            reclaimableBytes: sumBytes(installedVersions.filter((version) => !version.isActive)),
            versions: installedVersions,
            lastCheckedAt: liveCodex?.versionAdvisory?.checkedAt ?? null,
          }),
          canSwitchVersion: false,
        } satisfies ProviderRuntimeEntry;
      });

      const listCursorRuntime = (
        references: ReadonlyArray<InstanceReference>,
        liveProviders: ReadonlyArray<ServerProvider>,
      ): ProviderRuntimeEntry | undefined => {
        const usedBy = instancesForDriver(references, CURSOR_DRIVER);
        const liveCursor = liveProviders.find((provider) => provider.driver === CURSOR_DRIVER);
        if (usedBy.length === 0 && liveCursor === undefined) return undefined;
        return {
          ...runtimeEntryBase({
            runtimeId: "cursor",
            displayName: "Cursor",
            driver: CURSOR_DRIVER,
            kind: "bundledSdk",
            usedByInstanceIds: usedBy,
            activeVersion: CURSOR_SDK_VERSION,
            latestVersion: null,
            totalSizeBytes: 0,
            reclaimableBytes: 0,
            versions: [],
            lastCheckedAt: null,
            note: CURSOR_SDK_NOTE,
          }),
          canCheckUpdate: false,
          canUpdate: false,
          canPrune: false,
          canSwitchVersion: false,
        } satisfies ProviderRuntimeEntry;
      };

      const listRuntimes = Effect.fn("ProviderRuntimeMaintenance.listRuntimes")(function* () {
        const settings = yield* readSettings;
        const references = yield* readInstanceReferences();
        const liveProviders = yield* providers.getProviders;
        const runtimes: Array<ProviderRuntimeEntry> = [];
        runtimes.push(...(yield* listAcpRuntimes()));
        const antigravity = yield* listAntigravityRuntime(references);
        if (antigravity !== undefined) runtimes.push(antigravity);
        const codex = yield* listCodexRuntime(references, liveProviders);
        if (codex !== undefined) runtimes.push(codex);
        const cursor = listCursorRuntime(references, liveProviders);
        if (cursor !== undefined) runtimes.push(cursor);
        runtimes.sort((left, right) => left.runtimeId.localeCompare(right.runtimeId));
        return {
          checkedAt: yield* Effect.map(DateTime.now, DateTime.formatIso),
          totalSizeBytes: runtimes.reduce((total, runtime) => total + runtime.totalSizeBytes, 0),
          reclaimableBytes: runtimes.reduce(
            (total, runtime) => total + runtime.reclaimableBytes,
            0,
          ),
          autoPruneOldVersions: settings.autoPruneProviderRuntimeVersions,
          runtimes,
        } satisfies ProviderRuntimeInventory;
      });

      const refreshInstancesForAgent = Effect.fn(
        "ProviderRuntimeMaintenance.refreshInstancesForAgent",
      )(function* (agentId: string) {
        for (const reference of yield* readInstanceReferences()) {
          if (reference.driver !== ACP_REGISTRY_DRIVER) continue;
          if (stringField(reference.config, "agentId") !== agentId) continue;
          yield* providers.refreshInstance(reference.instanceId).pipe(Effect.ignore);
        }
      });

      const checkUpdates = Effect.fn("ProviderRuntimeMaintenance.checkUpdates")(function* (
        input: CheckProviderRuntimeUpdatesInput,
      ) {
        const runtimeId = input.runtimeId;
        const targetsAcp = runtimeId === undefined || runtimeId.startsWith("acp:");
        const targetsAntigravity = runtimeId === undefined || runtimeId === "antigravity";
        const targetsCodex = runtimeId === undefined || runtimeId === "codex";

        if (targetsAcp) {
          const checkRemoteUpdates = acpRegistryCatalog.checkRemoteUpdates;
          if (checkRemoteUpdates !== undefined) {
            yield* checkRemoteUpdates().pipe(
              Effect.mapError((error) =>
                maintenanceError(
                  "check",
                  `Could not check ACP Registry updates: ${error.message}`,
                  error,
                ),
              ),
            );
          }
        }
        if (targetsAntigravity) {
          yield* antigravityInstallation.checkForUpdate;
        }
        if (targetsCodex) {
          yield* codexInstallation.checkForUpdate;
          yield* providers.refresh(CODEX_DRIVER).pipe(Effect.ignore);
        }
        return yield* listRuntimes();
      });

      const updateAcpRuntime = Effect.fn("ProviderRuntimeMaintenance.updateAcpRuntime")(function* (
        agentId: string,
        input: UpdateProviderRuntimeInput,
        shouldPrune: boolean,
      ) {
        if (input.action === "switch") {
          const switchAgentVersion = acpRegistryCatalog.switchAgentVersion;
          if (switchAgentVersion === undefined) {
            return yield* maintenanceError(
              "switch",
              "ACP Registry version switching is not available in this server.",
            );
          }
          if (input.targetVersion === undefined) {
            return yield* maintenanceError(
              "switch",
              `Choosing a version for ${agentId} requires a target version.`,
            );
          }
          const switched = yield* switchAgentVersion({
            agentId,
            version: input.targetVersion,
          }).pipe(
            Effect.mapError((error) =>
              maintenanceError("switch", `Could not switch ${agentId}: ${error.message}`, error),
            ),
          );
          yield* refreshInstancesForAgent(agentId);
          return {
            runtimeId: input.runtimeId,
            previousVersion: switched.previousVersion,
            activeVersion: switched.activeVersion,
            prunedVersions: [],
            reclaimedBytes: 0,
            inventory: yield* listRuntimes(),
          } satisfies UpdateProviderRuntimeResult;
        }

        const updateAgentToLatest = acpRegistryCatalog.updateAgentToLatest;
        if (updateAgentToLatest === undefined) {
          return yield* maintenanceError(
            "update",
            "ACP Registry updates are not available in this server.",
          );
        }
        const updated = yield* updateAgentToLatest({
          agentId,
          pruneOldVersions: shouldPrune,
        }).pipe(
          Effect.mapError((error) =>
            maintenanceError("update", `Could not update ${agentId}: ${error.message}`, error),
          ),
        );
        yield* refreshInstancesForAgent(agentId);
        return {
          runtimeId: input.runtimeId,
          previousVersion: updated.previousVersion,
          activeVersion: updated.activeVersion,
          prunedVersions: [...updated.prunedVersions],
          reclaimedBytes: updated.reclaimedBytes,
          inventory: yield* listRuntimes(),
        } satisfies UpdateProviderRuntimeResult;
      });

      const managedRuntimeRoot = (runtimeId: string) =>
        runtimeId === "antigravity"
          ? path.join(antigravityInstallation.managedDirectory, "versions")
          : codexInstallation.managedDirectory;

      const pruneVersionDirectories = Effect.fn(
        "ProviderRuntimeMaintenance.pruneVersionDirectories",
      )(function* (input: {
        readonly runtimeId: string;
        readonly managedDirectory: string;
        readonly versions: ReadonlyArray<ProviderRuntimeInstalledVersion>;
        readonly requestedVersion: string | undefined;
      }) {
        const deleted: Array<{ runtimeId: string; version: string; sizeBytes: number }> = [];
        const skipped: Array<{
          runtimeId: string;
          version: string;
          reason: ProviderRuntimePruneSkipReason;
        }> = [];
        let reclaimedBytes = 0;

        const activeVersion = input.versions.find((version) => version.isActive)?.version;
        if (input.requestedVersion !== undefined && input.requestedVersion === activeVersion) {
          return {
            deleted,
            reclaimedBytes: 0,
            skipped: [
              {
                runtimeId: input.runtimeId,
                version: input.requestedVersion,
                reason: "active" as const,
              },
            ],
          };
        }
        if (
          input.requestedVersion !== undefined &&
          !input.versions.some((version) => version.version === input.requestedVersion)
        ) {
          return {
            deleted,
            reclaimedBytes: 0,
            skipped: [
              {
                runtimeId: input.runtimeId,
                version: input.requestedVersion,
                reason: "not_found" as const,
              },
            ],
          };
        }

        const candidates =
          input.requestedVersion === undefined
            ? input.versions.filter((version) => !version.isActive)
            : input.versions.filter((version) => version.version === input.requestedVersion);
        const rootIsSymlink = Option.isSome(
          yield* fileSystem.readLink(input.managedDirectory).pipe(Effect.option),
        );
        if (rootIsSymlink) {
          return {
            deleted,
            reclaimedBytes: 0,
            skipped: candidates.map((candidate) => ({
              runtimeId: input.runtimeId,
              version: candidate.version,
              reason: "failed" as const,
            })),
          };
        }
        const realRoot = yield* fileSystem
          .realPath(input.managedDirectory)
          .pipe(Effect.orElseSucceed(() => input.managedDirectory));
        for (const candidate of candidates) {
          const targetIsSymlink = Option.isSome(
            yield* fileSystem.readLink(candidate.path).pipe(Effect.option),
          );
          const realTarget = yield* fileSystem.realPath(candidate.path).pipe(Effect.option);
          if (
            targetIsSymlink ||
            Option.isNone(realTarget) ||
            realTarget.value === realRoot ||
            !realTarget.value.startsWith(`${realRoot}${path.sep}`)
          ) {
            skipped.push({
              runtimeId: input.runtimeId,
              version: candidate.version,
              reason: "failed",
            });
            continue;
          }
          const removed = yield* fileSystem
            .remove(candidate.path, { recursive: true, force: true })
            .pipe(
              Effect.as(true),
              Effect.catch((error) => {
                skipped.push({
                  runtimeId: input.runtimeId,
                  version: candidate.version,
                  reason: pruneFailureReason(error),
                });
                return Effect.succeed(false);
              }),
            );
          if (!removed) continue;
          deleted.push({
            runtimeId: input.runtimeId,
            version: candidate.version,
            sizeBytes: candidate.sizeBytes,
          });
          reclaimedBytes += candidate.sizeBytes;
        }
        return { deleted, reclaimedBytes, skipped };
      });

      const pruneVersions = Effect.fn("ProviderRuntimeMaintenance.pruneVersions")(function* (
        input: PruneProviderRuntimeVersionsInput,
      ) {
        const inventory = yield* listRuntimes();
        const targets =
          input.runtimeId === undefined
            ? inventory.runtimes
                .filter(
                  (runtime) =>
                    runtime.kind === "acpRegistry" ||
                    runtime.runtimeId === "antigravity" ||
                    runtime.runtimeId === "codex",
                )
                .map((runtime) => runtime.runtimeId)
            : [input.runtimeId];

        const deleted: Array<{ runtimeId: string; version: string; sizeBytes: number }> = [];
        const skipped: Array<{
          runtimeId: string;
          version: string;
          reason: ProviderRuntimePruneSkipReason;
        }> = [];
        let reclaimedBytes = 0;

        for (const runtimeId of targets) {
          if (runtimeId.startsWith("acp:")) {
            const agentId = runtimeId.slice("acp:".length);
            const pruneManagedVersions = acpRegistryCatalog.pruneManagedVersions;
            if (pruneManagedVersions === undefined) {
              return yield* maintenanceError(
                "prune",
                "ACP Registry version pruning is not available in this server.",
              );
            }
            const pruned = yield* pruneManagedVersions({
              agentId,
              ...(input.version === undefined ? {} : { version: input.version }),
            }).pipe(
              Effect.mapError((error) =>
                maintenanceError("prune", `Could not prune ${agentId}: ${error.message}`, error),
              ),
            );
            for (const version of pruned.deleted) {
              deleted.push({ runtimeId, version: version.version, sizeBytes: version.sizeBytes });
            }
            for (const entry of pruned.skipped) {
              skipped.push({ runtimeId, version: entry.version, reason: entry.reason });
            }
            reclaimedBytes += pruned.reclaimedBytes;
            continue;
          }

          if (runtimeId === "antigravity" || runtimeId === "codex") {
            const entry = inventory.runtimes.find((runtime) => runtime.runtimeId === runtimeId);
            if (entry === undefined) continue;
            const pruned = yield* pruneVersionDirectories({
              runtimeId,
              managedDirectory: managedRuntimeRoot(runtimeId),
              versions: entry.versions,
              requestedVersion: input.version,
            });
            deleted.push(...pruned.deleted);
            skipped.push(...pruned.skipped);
            reclaimedBytes += pruned.reclaimedBytes;
            continue;
          }

          return yield* maintenanceError(
            "prune",
            `Provider runtime '${runtimeId}' cannot be pruned.`,
          );
        }

        return {
          deleted,
          reclaimedBytes,
          skipped,
          inventory: yield* listRuntimes(),
        } satisfies PruneProviderRuntimeVersionsResult;
      });

      const updateRuntime = Effect.fn("ProviderRuntimeMaintenance.updateRuntime")(function* (
        input: UpdateProviderRuntimeInput,
      ) {
        const settings = yield* readSettings;
        const shouldPrune = input.pruneOldVersions ?? settings.autoPruneProviderRuntimeVersions;

        if (input.runtimeId.startsWith("acp:")) {
          const agentId = input.runtimeId.slice("acp:".length).trim();
          if (agentId.length === 0) {
            return yield* maintenanceError(
              "update",
              "ACP Registry runtime is missing an agent ID.",
            );
          }
          return yield* updateAcpRuntime(agentId, input, shouldPrune);
        }

        if (input.runtimeId === "antigravity") {
          if (input.action === "switch") {
            return yield* maintenanceError(
              "switch",
              "Antigravity only runs the version it last installed.",
            );
          }
          const started = yield* antigravityInstallation.start.pipe(
            Effect.mapError((error) =>
              maintenanceError("update", `Could not update Antigravity: ${error.message}`, error),
            ),
          );
          return {
            runtimeId: input.runtimeId,
            previousVersion: null,
            activeVersion: started.installedVersion,
            prunedVersions: [],
            reclaimedBytes: 0,
            inventory: yield* listRuntimes(),
          } satisfies UpdateProviderRuntimeResult;
        }

        if (input.runtimeId === "codex") {
          const inventory = yield* listRuntimes();
          const entry = inventory.runtimes.find((runtime) => runtime.runtimeId === "codex");
          if (entry === undefined) {
            return yield* maintenanceError(
              "update",
              "Codex is not configured in this environment.",
            );
          }
          if (entry.kind === "systemCli") {
            if (input.action === "switch") {
              return yield* maintenanceError(
                "switch",
                "Codex runs from your PATH and does not manage installed versions here.",
              );
            }
            yield* providers.refresh(CODEX_DRIVER).pipe(Effect.ignore);
            const refreshed = yield* listRuntimes();
            const updatedEntry = refreshed.runtimes.find(
              (runtime) => runtime.runtimeId === "codex",
            );
            if (updatedEntry?.updateAvailable === true) {
              return yield* maintenanceError(
                "update",
                updatedEntry.updateCommand === null
                  ? "Codex must be updated with its own CLI or package manager."
                  : `Codex must be updated outside T3 Code: ${updatedEntry.updateCommand}`,
              );
            }
            return {
              runtimeId: input.runtimeId,
              previousVersion: entry.activeVersion,
              activeVersion: updatedEntry?.activeVersion ?? entry.activeVersion,
              prunedVersions: [],
              reclaimedBytes: 0,
              inventory: refreshed,
            } satisfies UpdateProviderRuntimeResult;
          }
          if (input.action === "switch") {
            return yield* maintenanceError("switch", "Codex version switching is not supported.");
          }
          const started = yield* codexInstallation.start.pipe(
            Effect.mapError((error) =>
              maintenanceError("update", `Could not update Codex: ${error.message}`, error),
            ),
          );
          return {
            runtimeId: input.runtimeId,
            previousVersion: entry.activeVersion,
            activeVersion: started.installedVersion,
            prunedVersions: [],
            reclaimedBytes: 0,
            inventory: yield* listRuntimes(),
          } satisfies UpdateProviderRuntimeResult;
        }

        return yield* maintenanceError(
          "update",
          `Provider runtime '${input.runtimeId}' does not support updates.`,
        );
      });

      return ProviderRuntimeMaintenance.of({
        listRuntimes,
        checkUpdates,
        updateRuntime,
        pruneVersions,
      });
    }),
  );
}
