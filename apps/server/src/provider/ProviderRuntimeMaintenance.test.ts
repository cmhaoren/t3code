import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
} from "@t3tools/contracts";
import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AntigravityInstallation from "./AntigravityInstallation.ts";
import * as CodexInstallation from "./CodexInstallation.ts";
import * as ProviderRegistry from "./ProviderRegistry.ts";
import * as ProviderRuntimeMaintenance from "./ProviderRuntimeMaintenance.ts";

const registryUrl = "https://registry.test/registry.json";
const agentId = "factory-droid";
const runtimeId = `acp:${agentId}`;

const registryJson = (version: string) =>
  JSON.stringify({
    version: "1.0.0",
    agents: [
      {
        id: agentId,
        name: "Factory Droid",
        version,
        description: "Factory Droid ACP agent",
        distribution: {
          npx: { package: `@factory/droid@${version}`, args: ["--stdio"] },
        },
      },
    ],
  });

const RemoteUpdateState = Schema.Struct({
  agents: Schema.Record(
    Schema.String,
    Schema.Struct({ latestVersion: Schema.String, distribution: Schema.String }),
  ),
});
const decodeRemoteUpdateState = Schema.decodeUnknownSync(Schema.fromJsonString(RemoteUpdateState));

const installState = (driver: string, installedVersion: string | null): ProviderInstallState => ({
  driver: ProviderDriverKind.make(driver),
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: null,
  installedVersion,
  canRemove: false,
  message: null,
});

const registryStub = {
  getProviders: Effect.succeed([]),
  refresh: () => Effect.succeed([]),
  refreshInstance: () => Effect.succeed([]),
} as unknown as ProviderRegistry.ProviderRegistry["Service"];

const harness = (options: {
  readonly settings?: Parameters<typeof ServerSettings.ServerSettingsService.layerTest>[0];
  readonly registry?: string;
  readonly providers?: ProviderRegistry.ProviderRegistry["Service"];
}) =>
  Layer.mergeAll(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-runtime-" }),
    ServerSettings.ServerSettingsService.layerTest(options.settings ?? {}),
    TestProviderHost.layer({ runBackgroundWork: false }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, new Response(options.registry ?? "{}"))),
      ),
    ),
    Layer.succeed(ProviderRegistry.ProviderRegistry, options.providers ?? registryStub),
  ).pipe(Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)));

const writeNpmVersion = Effect.fn("ProviderRuntimeMaintenance.test.writeNpmVersion")(function* (
  toolsDirectory: string,
  version: string,
  bytes: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(toolsDirectory, agentId, version, "npm");
  yield* fileSystem.makeDirectory(directory, { recursive: true });
  yield* fileSystem.writeFileString(path.join(directory, "package.json"), "x".repeat(bytes));
});

const makeCatalog = Effect.fn("ProviderRuntimeMaintenance.test.makeCatalog")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return yield* AcpRegistrySupport.makeAcpRegistryCatalog({
    cacheDir: config.providerStatusCacheDir,
    toolsDir: path.join(config.baseDir, "tools"),
    registryUrl,
  });
});

const makeMaintenance = (catalog: AcpRegistrySupport.AcpRegistryCatalog["Service"]) =>
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const antigravity = {
      managedDirectory: path.join(config.baseDir, "tools", "antigravity-acp", "test-target"),
      state: Effect.succeed(installState("antigravity", null)),
      checkForUpdate: Effect.void,
      start: Effect.die("unexpected Antigravity install"),
      cancel: () => Effect.die("unexpected Antigravity cancel"),
      changes: Stream.empty,
      remove: () => Effect.die("unexpected Antigravity remove"),
    } as unknown as AntigravityInstallation.AntigravityInstallation["Service"];
    const codex = {
      managedDirectory: path.join(config.baseDir, "tools", "codex"),
      state: Effect.succeed(installState("codex", null)),
      checkForUpdate: Effect.void,
      start: Effect.die("unexpected Codex install"),
      cancel: () => Effect.die("unexpected Codex cancel"),
      changes: Stream.empty,
      remove: () => Effect.die("unexpected Codex remove"),
    } as unknown as CodexInstallation.CodexInstallation["Service"];
    return yield* ProviderRuntimeMaintenance.ProviderRuntimeMaintenance.pipe(
      Effect.provide(
        ProviderRuntimeMaintenance.ProviderRuntimeMaintenance.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(AcpRegistrySupport.AcpRegistryCatalog, catalog),
              Layer.succeed(AntigravityInstallation.AntigravityInstallation, antigravity),
              Layer.succeed(CodexInstallation.CodexInstallation, codex),
            ),
          ),
        ),
      ),
    );
  });

const acpInstanceSettings = (): Parameters<
  typeof ServerSettings.ServerSettingsService.layerTest
>[0] => ({
  providerInstances: {
    [ProviderInstanceId.make(`${agentId}-instance`)]: {
      driver: ProviderDriverKind.make("acpRegistry"),
      config: { agentId, source: "registry" },
    },
  },
});

describe("ProviderRuntimeMaintenance", () => {
  it.effect("checks remote ACP updates without rewriting the registry cache or installing", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const toolsDirectory = path.join(config.baseDir, "tools");
      const registryPath = path.join(
        config.providerStatusCacheDir,
        "acp-registry",
        "registry.json",
      );
      yield* writeNpmVersion(toolsDirectory, "1.17.1", 64);
      yield* fileSystem.makeDirectory(path.dirname(registryPath), { recursive: true });
      const cachedRegistry = registryJson("1.17.1");
      yield* fileSystem.writeFileString(registryPath, cachedRegistry);

      const catalog = yield* makeCatalog();
      yield* catalog.switchAgentVersion!({ agentId, version: "1.17.1" });
      const maintenance = yield* makeMaintenance(catalog);

      const inventory = yield* maintenance.checkUpdates({ runtimeId });

      expect(yield* fileSystem.readFileString(registryPath)).toBe(cachedRegistry);
      expect(yield* fileSystem.exists(path.join(toolsDirectory, agentId, "1.18.0"))).toBe(false);
      const runtime = inventory.runtimes.find((entry) => entry.runtimeId === runtimeId);
      expect(runtime).toMatchObject({
        activeVersion: "1.17.1",
        latestVersion: "1.18.0",
        updateAvailable: true,
        canUpdate: true,
      });
      expect(runtime?.versions.map((version) => version.version)).toEqual(["1.17.1"]);
      expect(
        decodeRemoteUpdateState(
          yield* fileSystem.readFileString(
            path.join(config.providerStatusCacheDir, "acp-registry", "remote-updates.json"),
          ),
        ).agents[agentId]?.latestVersion,
      ).toBe("1.18.0");
    }).pipe(Effect.scoped, Effect.provide(harness({ registry: registryJson("1.18.0") }))),
  );

  it.effect("summarizes every managed ACP version and ignores unrelated tool directories", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const toolsDirectory = path.join(config.baseDir, "tools");
      yield* writeNpmVersion(toolsDirectory, "1.17.1", 100);
      yield* writeNpmVersion(toolsDirectory, "1.17.2", 100);
      yield* writeNpmVersion(toolsDirectory, "1.18.0", 100);
      yield* fileSystem.makeDirectory(path.join(toolsDirectory, "chrome-headless-shell"));
      const chromeDirectory = path.join(toolsDirectory, "chrome-headless-shell", "1.18.0", "npm");
      yield* fileSystem.makeDirectory(chromeDirectory, { recursive: true });
      yield* fileSystem.writeFileString(path.join(chromeDirectory, "package.json"), "x".repeat(50));

      const catalog = yield* makeCatalog();
      yield* catalog.switchAgentVersion!({ agentId, version: "1.18.0" });
      const maintenance = yield* makeMaintenance(catalog);

      const inventory = yield* maintenance.listRuntimes();
      const runtime = inventory.runtimes.find((entry) => entry.runtimeId === runtimeId);

      expect(inventory.runtimes.map((entry) => entry.runtimeId)).toEqual([runtimeId]);
      expect(runtime?.versions.map((version) => version.version)).toEqual([
        "1.18.0",
        "1.17.2",
        "1.17.1",
      ]);
      expect(
        runtime?.versions.filter((version) => version.isActive).map((version) => version.version),
      ).toEqual(["1.18.0"]);
      expect(runtime?.totalSizeBytes).toBe(300);
      expect(runtime?.reclaimableBytes).toBe(200);
      expect(inventory.totalSizeBytes).toBe(300);
      expect(inventory.reclaimableBytes).toBe(200);
      expect(inventory.autoPruneOldVersions).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(harness({ registry: registryJson("1.18.0") }))),
  );

  it.effect("switches the active ACP version to an installed one", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const toolsDirectory = path.join(config.baseDir, "tools");
      yield* writeNpmVersion(toolsDirectory, "1.17.2", 80);
      yield* writeNpmVersion(toolsDirectory, "1.18.0", 90);

      const catalog = yield* makeCatalog();
      yield* catalog.switchAgentVersion!({ agentId, version: "1.18.0" });
      const maintenance = yield* makeMaintenance(catalog);

      const result = yield* maintenance.updateRuntime({
        runtimeId,
        action: "switch",
        targetVersion: "1.17.2",
      });

      expect(result).toMatchObject({
        runtimeId,
        previousVersion: "1.18.0",
        activeVersion: "1.17.2",
        prunedVersions: [],
        reclaimedBytes: 0,
      });
      const runtime = result.inventory.runtimes.find((entry) => entry.runtimeId === runtimeId);
      expect(runtime?.activeVersion).toBe("1.17.2");
      expect(
        runtime?.versions.filter((version) => version.isActive).map((version) => version.version),
      ).toEqual(["1.17.2"]);
    }).pipe(Effect.scoped, Effect.provide(harness({ registry: registryJson("1.18.0") }))),
  );

  it.effect("prunes inactive ACP versions, keeps the active one, and rejects traversal", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const toolsDirectory = path.join(config.baseDir, "tools");
      for (const version of ["1.17.1", "1.17.2", "1.18.0"]) {
        yield* writeNpmVersion(toolsDirectory, version, 120);
      }
      const outside = path.join(toolsDirectory, "evil");
      yield* fileSystem.makeDirectory(outside, { recursive: true });
      yield* fileSystem.writeFileString(path.join(outside, "keep.txt"), "keep");

      const catalog = yield* makeCatalog();
      yield* catalog.switchAgentVersion!({ agentId, version: "1.18.0" });
      const maintenance = yield* makeMaintenance(catalog);

      const pruned = yield* maintenance.pruneVersions({ runtimeId });
      expect(pruned.deleted.map((entry) => entry.version).toSorted()).toEqual(["1.17.1", "1.17.2"]);
      expect(pruned.skipped).toEqual([]);
      expect(pruned.reclaimedBytes).toBe(240);
      expect(yield* fileSystem.exists(path.join(toolsDirectory, agentId, "1.17.1"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(toolsDirectory, agentId, "1.17.2"))).toBe(false);
      expect(yield* fileSystem.exists(path.join(toolsDirectory, agentId, "1.18.0"))).toBe(true);

      const activeAttempt = yield* maintenance.pruneVersions({
        runtimeId,
        version: "1.18.0",
      });
      expect(activeAttempt.deleted).toEqual([]);
      expect(activeAttempt.skipped).toEqual([{ runtimeId, version: "1.18.0", reason: "active" }]);
      expect(yield* fileSystem.exists(path.join(toolsDirectory, agentId, "1.18.0"))).toBe(true);

      const traversal = yield* maintenance
        .pruneVersions({ runtimeId, version: "../evil" })
        .pipe(Effect.flip);
      expect(traversal.operation).toBe("prune");
      expect(yield* fileSystem.readFileString(path.join(outside, "keep.txt"))).toBe("keep");
      expect(yield* fileSystem.exists(path.join(toolsDirectory, agentId, "1.18.0"))).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(harness({ registry: registryJson("1.18.0") }))),
  );

  it.effect("defaults auto pruning off and forwards the setting to updates", () =>
    Effect.gen(function* () {
      expect(DEFAULT_SERVER_SETTINGS.autoPruneProviderRuntimeVersions).toBe(false);
      const updates: Array<{ readonly pruneOldVersions?: boolean }> = [];
      const fakeCatalog = {
        checkRemoteUpdates: () => Effect.succeed({ checkedAt: "", agents: [] }),
        listManagedVersions: (requestedAgentId: string) =>
          Effect.succeed({
            agentId: requestedAgentId,
            activeVersion: "1.18.0",
            latestVersion: "1.18.0",
            lastCheckedAt: null,
            distribution: "npx" as const,
            versions: [
              {
                id: "1.18.0",
                version: "1.18.0",
                sizeBytes: 10,
                isActive: true,
                installedAt: null,
                path: "/managed/1.18.0",
                distribution: "npx" as const,
              },
            ],
          }),
        updateAgentToLatest: (input: { readonly pruneOldVersions?: boolean }) => {
          updates.push(input);
          return Effect.succeed({
            previousVersion: "1.18.0",
            activeVersion: "1.18.0",
            prunedVersions: [],
            reclaimedBytes: 0,
          });
        },
      } as unknown as AcpRegistrySupport.AcpRegistryCatalog["Service"];

      const maintenance = yield* makeMaintenance(fakeCatalog);
      const settings = yield* ServerSettings.ServerSettingsService;

      const before = yield* maintenance.listRuntimes();
      expect(before.autoPruneOldVersions).toBe(false);

      yield* settings.updateSettings({ autoPruneProviderRuntimeVersions: true });
      const after = yield* maintenance.listRuntimes();
      expect(after.autoPruneOldVersions).toBe(true);

      yield* maintenance.updateRuntime({ runtimeId, action: "update" });
      expect(updates.at(-1)?.pruneOldVersions).toBe(true);

      yield* maintenance.updateRuntime({ runtimeId, action: "update", pruneOldVersions: false });
      expect(updates.at(-1)?.pruneOldVersions).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        harness({ settings: acpInstanceSettings(), registry: registryJson("1.18.0") }),
      ),
    ),
  );

  it.effect(
    "detects real Windows npm prefix layout and excludes unconfigured registry catalog agents",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const toolsDirectory = path.join(config.baseDir, "tools");
        const pkgDir = path.join(toolsDirectory, agentId, "1.18.0", "npm", "node_modules", "droid");
        yield* fileSystem.makeDirectory(pkgDir, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(pkgDir, "package.json"),
          JSON.stringify({ name: "droid", version: "1.18.0" }),
        );
        yield* fileSystem.writeFileString(
          path.join(toolsDirectory, agentId, "1.18.0", "npm", "droid.CMD"),
          "@ECHO off\r\n",
        );

        const registryPath = path.join(
          config.providerStatusCacheDir,
          "acp-registry",
          "registry.json",
        );
        yield* fileSystem.makeDirectory(path.dirname(registryPath), { recursive: true });
        yield* fileSystem.writeFileString(
          registryPath,
          JSON.stringify({
            version: "1.0.0",
            agents: [
              {
                id: agentId,
                name: "Factory Droid",
                version: "1.19.0",
                description: "Factory Droid ACP agent",
                distribution: {
                  npx: { package: "droid@1.19.0", args: ["--stdio"] },
                },
              },
              {
                id: "devin",
                name: "Devin",
                version: "2.0.0",
                description: "Unconfigured agent in registry",
                distribution: {
                  npx: { package: "devin@2.0.0", args: [] },
                },
              },
            ],
          }),
        );

        const catalog = yield* makeCatalog();
        const maintenance = yield* makeMaintenance(catalog);

        const inventory = yield* maintenance.listRuntimes();
        expect(inventory.runtimes.map((entry) => entry.runtimeId)).toEqual([runtimeId]);
        const runtime = inventory.runtimes[0];
        expect(runtime?.displayName).toBe("Factory Droid");
        expect(runtime?.activeVersion).toBe("1.18.0");
        expect(runtime?.versions.map((v) => v.version)).toEqual(["1.18.0"]);
      }).pipe(Effect.scoped, Effect.provide(harness({ registry: registryJson("1.19.0") }))),
  );
});
