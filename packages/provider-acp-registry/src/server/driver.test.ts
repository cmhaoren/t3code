import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  AcpRegistryOperationError,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { toCustomModelSetting } from "@t3tools/shared/model";
import { AcpRegistrySettings } from "../settings.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import * as AcpRegistryRuntimeCoordinator from "./AcpRegistryRuntimeCoordinator.ts";
import * as AcpRegistrySupport from "./AcpRegistrySupport.ts";
import {
  AcpRegistryDriver,
  applyAcpRegistryAvailableCommands,
  applyAcpRegistryLiveConfiguration,
  buildCheckedAcpRegistrySnapshot,
  checkAcpRegistryProviderReadiness,
  checkAcpRegistryProviderStatus,
  isAcpRegistryCacheValid,
  updateAcpRegistryEnrichmentCache,
} from "./driver.ts";
import {
  acpRegistryAdvertisesModelCatalog,
  acpRegistryProbeResult,
  normalizeAcpRegistryLiveConfiguration,
} from "./probe.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const identity = {
  instanceId: ProviderInstanceId.make("acpRegistry_test"),
  displayName: "Test ACP",
  accentColor: undefined,
  continuationKey: "acpRegistry:instance:acpRegistry_test",
};
const noSessionManagement = {
  canList: false,
  canLoad: false,
  canResume: false,
  canLogout: false,
  canDelete: false,
  canConfigureProviders: false,
} as const;

function catalogWithInspection(
  inspection: AcpRegistrySupport.AcpRegistryInspection,
): AcpRegistrySupport.AcpRegistryCatalog["Service"] {
  return {
    search: () => Effect.die("unused search"),
    prepare: () => Effect.die("unused prepare"),
    inspect: () => Effect.succeed(inspection),
    resolve: () => Effect.die("unused resolve"),
    uninstallManagedBinary: () => Effect.die("unused uninstall"),
  };
}

function providerWithModels(
  models: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly description: string | null;
  }>,
  currentModelId: string | null,
): ReturnType<typeof buildCheckedAcpRegistrySnapshot> {
  return buildCheckedAcpRegistrySnapshot({
    ...identity,
    settings: decodeSettings({ agentId: "test-agent" }),
    checkedAt: "2026-08-13T10:00:00.000Z",
    inspection: {
      status: "ready",
      agentId: "test-agent",
      version: "1.0.0",
      distribution: "npx",
    },
    probe: {
      probe: {
        instanceId: identity.instanceId,
        ready: true,
        icon: null,
        authMethods: [],
        models,
        currentModelId,
        configOptions: [],
        sessionManagement: noSessionManagement,
      },
      slashCommands: [],
      skills: [],
    },
  });
}

describe("acpRegistrySnapshotReadiness", () => {
  it("keeps the custom model display name and options saved by the Settings editor", () => {
    const fastMode = { id: "fast", label: "Fast mode", type: "boolean" } as const;
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [
          toCustomModelSetting({
            slug: "gateway/my-model",
            name: "My model",
            capabilities: { optionDescriptors: [fastMode] },
          }),
        ],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: { status: "ready", agentId: "test-agent", version: "1.0.0", distribution: "npx" },
    });
    const model = snapshot.models.find((entry) => entry.slug === "gateway/my-model");
    expect(model?.name).toBe("My model");
    expect(model?.capabilities?.optionDescriptors).toEqual([fastMode]);
  });

  it("shows the version reported by a local ACP agent", () => {
    const probe = acpRegistryProbeResult(identity.instanceId, {
      sessionId: "test-session",
      initializeResult: {
        protocolVersion: 1,
        agentInfo: { name: "Example agent", version: "1.5.9" },
      },
      sessionSetupResult: {},
      modelConfigId: undefined,
    });
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ source: "local", commandPath: "example" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: { status: "ready", agentId: "example", version: null, distribution: "local" },
      probe: { probe, slashCommands: [], skills: [] },
    });
    expect(snapshot.version).toBe("1.5.9");
    const withoutVersion = acpRegistryProbeResult(identity.instanceId, {
      sessionId: "test-session",
      initializeResult: { protocolVersion: 1 },
      sessionSetupResult: {},
      modelConfigId: undefined,
    });
    expect(
      buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({ source: "local", commandPath: "example" }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: { status: "ready", agentId: "example", version: null, distribution: "local" },
        probe: { probe: withoutVersion, slashCommands: [], skills: [] },
      }).version,
    ).toBeNull();
  });

  it("treats a live empty command advertisement as an authoritative replacement", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
        documentationUrl: "https://example.test/agent/setup",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "stale" }],
        skills: [{ name: "stale-skill", path: "stale", enabled: true }],
      },
    });

    const replaced = applyAcpRegistryAvailableCommands(
      provider,
      Option.some({ slashCommands: [], skills: [] }),
    );
    expect(replaced.slashCommands).toEqual([]);
    expect(replaced.skills).toEqual([]);
    expect(applyAcpRegistryAvailableCommands(provider, Option.none()).slashCommands).toEqual([
      { name: "stale" },
    ]);
    expect(provider.iconUrl).toBe(
      "https://cdn.agentclientprotocol.com/registry/v1/latest/test-agent.svg",
    );
    expect(provider.setup).toMatchObject({
      canAuthenticate: false,
      documentationUrl: "https://example.test/agent/setup",
    });
  });

  it("keeps authentication unknown when an agent permits a discovery session before sign-in", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [{ id: "browser", name: "Browser", description: null, type: "agent" }],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    expect(snapshot.auth.status).toBe("unknown");
    expect(snapshot.setup?.canAuthenticate).toBe(true);
    expect(
      applyAcpRegistryLiveConfiguration(
        snapshot,
        { models: [], currentModelId: null, configOptions: [], modelsFromModelSelect: false },
        [],
      ).auth.status,
    ).toBe("unknown");
  });

  it("overlays live configuration without dropping probe-owned session capabilities", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "probe-model", name: "Probe model", description: null }],
          currentModelId: "probe-model",
          configOptions: [],
          sessionManagement: {
            canList: true,
            canLoad: true,
            canResume: true,
            canLogout: true,
            canDelete: true,
            canConfigureProviders: true,
          },
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        {
          models: [{ id: "live-model", name: "Live model", description: null }],
          currentModelId: "live-model",
          configOptions: [],
          modelsFromModelSelect: false,
        },
        [],
      ),
    ).toMatchObject({
      auth: { status: "unknown", canLogout: true },
      nativeSessions: { canList: true, canLoad: true, canResume: true },
      models: [{ slug: "live-model", isDefault: true }],
    });

    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        { models: [], currentModelId: null, configOptions: [], modelsFromModelSelect: false },
        [],
      ).models,
    ).toEqual(provider.models);

    const liveOptions = [
      {
        id: "effort",
        label: "Effort",
        type: "select" as const,
        options: [{ id: "high", label: "High" }],
        currentValue: "high",
      },
    ];
    expect(
      applyAcpRegistryLiveConfiguration(
        provider,
        {
          models: [],
          currentModelId: null,
          configOptions: liveOptions,
          modelsFromModelSelect: false,
        },
        [],
      ).models,
    ).toMatchObject([
      {
        slug: "probe-model",
        isDefault: true,
        capabilities: { optionDescriptors: [{ id: "effort", currentValue: "high" }] },
      },
    ]);

    // Session configOptions describe the current model only.
    const sharedMode = {
      id: "mode",
      label: "Mode",
      type: "select" as const,
      options: [{ id: "ask", label: "Ask" }],
      currentValue: "ask",
    };
    const twoModelList = [
      { id: "glm", name: "GLM", description: null },
      { id: "opus", name: "Opus", description: null },
    ];
    const afterGlm = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: twoModelList,
        currentModelId: "glm",
        configOptions: [...liveOptions, sharedMode],
        modelOptionIds: ["effort"],
      },
      [],
    );
    const twoModels = afterGlm.models;
    expect(twoModels.find((model) => model.slug === "glm")).toMatchObject({
      capabilities: { optionDescriptors: [{ id: "effort" }, { id: "mode" }] },
    });
    expect(
      twoModels.find((model) => model.slug === "opus")?.capabilities?.optionDescriptors ?? [],
    ).toEqual([sharedMode]);
    // A later session on another model keeps the options learned for this one.
    const afterOpus = applyAcpRegistryLiveConfiguration(
      afterGlm,
      {
        models: twoModelList,
        currentModelId: "opus",
        configOptions: [{ ...liveOptions[0]!, id: "thinking" }, sharedMode],
        modelOptionIds: ["thinking"],
      },
      [],
    ).models;
    expect(afterOpus.find((model) => model.slug === "glm")).toMatchObject({
      capabilities: { optionDescriptors: [{ id: "mode" }, { id: "effort" }] },
    });
    expect(afterOpus.find((model) => model.slug === "opus")).toMatchObject({
      capabilities: { optionDescriptors: [{ id: "thinking" }, { id: "mode" }] },
    });

    // Other models take the levels they advertise in `_meta`.
    const effort = {
      id: "effort",
      name: "Effort",
      category: "thought_level",
      type: "select" as const,
      currentValue: "high",
      options: [{ value: "high", name: "High" }],
    };
    const advertised = applyAcpRegistryLiveConfiguration(
      provider,
      normalizeAcpRegistryLiveConfiguration([effort], undefined, {
        currentModelId: "opus",
        availableModels: [
          { modelId: "opus", name: "Opus" },
          {
            modelId: "haiku",
            name: "Haiku",
            _meta: { reasoningEfforts: [{ value: "low", label: "Low" }], reasoningEffort: "low" },
          },
          { modelId: "glm", name: "GLM", _meta: { supportsReasoningEffort: false } },
        ],
      }),
      [],
    ).models.map((model) => model.capabilities?.optionDescriptors ?? []);
    expect(advertised).toEqual([
      [{ ...liveOptions[0]!, role: "reasoning" }],
      [
        {
          ...liveOptions[0]!,
          role: "reasoning",
          options: [{ id: "low", label: "Low" }],
          currentValue: "low",
        },
      ],
      [],
    ]);
  });

  it("keeps each Mistral Vibe model's own thinking levels", () => {
    const provider = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "mistral-vibe" }),
      checkedAt: "2026-11-18T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "mistral-vibe",
        version: "3.1.1",
        distribution: "binary",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });
    // Mistral Vibe 3.1.1 sends its levels under category "thinking", for the session's model only.
    const vibeSession = (model: string, levels: ReadonlyArray<string>) =>
      normalizeAcpRegistryLiveConfiguration([
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: model,
          options: ["mistral-large-4-0-3", "mistral-medium-3.5"].map((value) => ({
            value,
            name: value,
          })),
        },
        {
          id: "thinking",
          name: "Thinking",
          category: "thinking",
          type: "select",
          currentValue: "high",
          options: levels.map((value) => ({ value, name: value })),
        },
      ]);
    const thinking = (levels: ReadonlyArray<string>) => ({
      id: "thinking",
      label: "Thinking",
      type: "select",
      options: levels.map((id) => ({ id, label: id })),
      currentValue: "high",
      role: "reasoning",
    });
    const descriptors = (snapshot: typeof provider) =>
      snapshot.models.map((model) => [model.slug, model.capabilities?.optionDescriptors ?? []]);

    const onLarge = applyAcpRegistryLiveConfiguration(
      provider,
      vibeSession("mistral-large-4-0-3", ["low", "medium", "high"]),
      [],
    );
    expect(descriptors(onLarge)).toEqual([
      ["mistral-large-4-0-3", [thinking(["low", "medium", "high"])]],
      ["mistral-medium-3.5", []],
    ]);
    const onMedium = applyAcpRegistryLiveConfiguration(
      onLarge,
      vibeSession("mistral-medium-3.5", ["off", "high"]),
      [],
    );
    expect(descriptors(onMedium)).toEqual([
      ["mistral-large-4-0-3", [thinking(["low", "medium", "high"])]],
      ["mistral-medium-3.5", [thinking(["off", "high"])]],
    ]);
  });

  it("projects discovery without claiming authentication when no login methods are advertised", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({
        agentId: "test-agent",
        customModels: [" custom-model ", "gpt-discovered"],
      }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "npx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [{ id: "gpt-discovered", name: "GPT Discovered", description: null }],
          currentModelId: "gpt-discovered",
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [{ name: "plan", description: "Create a plan", input: { hint: "topic" } }],
        skills: [{ name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true }],
      },
    });

    expect(snapshot.auth).toEqual({ status: "unknown", canLogout: false });
    expect(snapshot.supportsTextGeneration).toBe(false);
    expect(
      snapshot.models.map(({ slug, name, isCustom, isDefault }) => ({
        slug,
        name,
        isCustom,
        isDefault,
      })),
    ).toEqual([
      {
        slug: "gpt-discovered",
        name: "GPT Discovered",
        isCustom: false,
        isDefault: true,
      },
      {
        slug: "custom-model",
        name: "custom-model",
        isCustom: true,
        isDefault: undefined,
      },
    ]);
    expect(snapshot.slashCommands).toEqual([
      { name: "plan", description: "Create a plan", input: { hint: "topic" } },
    ]);
    expect(snapshot.skills).toEqual([
      { name: "workspace-skill", path: "acp://skill/workspace-skill", enabled: true },
    ]);
  });

  it("keeps a default model only when the agent advertises none", () => {
    const snapshot = buildCheckedAcpRegistrySnapshot({
      ...identity,
      settings: decodeSettings({ agentId: "test-agent" }),
      checkedAt: "2026-08-13T10:00:00.000Z",
      inspection: {
        status: "ready",
        agentId: "test-agent",
        version: "1.0.0",
        distribution: "uvx",
      },
      probe: {
        probe: {
          instanceId: identity.instanceId,
          ready: true,
          icon: null,
          authMethods: [],
          models: [],
          currentModelId: null,
          configOptions: [],
          sessionManagement: noSessionManagement,
        },
        slashCommands: [],
        skills: [],
      },
    });

    expect(snapshot.models.map((model) => model.slug)).toEqual(["default"]);
    expect(snapshot.models[0]?.isDefault).toBe(true);
  });

  it.each(["registry", "local"] as const)(
    "reports failed authentication after successful %s inspection",
    (source) => {
      const snapshot = buildCheckedAcpRegistrySnapshot({
        ...identity,
        settings: decodeSettings({
          source,
          ...(source === "local" ? { commandPath: "test-agent" } : { agentId: "test-agent" }),
          authMethodId: "grok-login",
        }),
        checkedAt: "2026-08-13T10:00:00.000Z",
        inspection: {
          status: "ready",
          agentId: "test-agent",
          version: source === "local" ? null : "1.0.0",
          distribution: source === "local" ? "local" : "binary",
        },
        probeError: new AcpRegistryOperationError({
          reason: "authentication_failed",
          message: "Login required.",
          authMethods: [
            {
              id: "api-key",
              name: "API key",
              description: null,
              type: "env_var",
            },
            {
              id: "grok-login",
              name: "Log in with Grok",
              description: null,
              type: "agent",
            },
          ],
        }),
      });

      expect(snapshot).toMatchObject({
        installed: true,
        version: source === "local" ? null : "1.0.0",
        status: "warning",
        setup: { canAuthenticate: true },
        auth: {
          status: "unauthenticated",
          type: "agent",
          label: "Log in with Grok",
        },
        message: 'Sign in in provider settings using "Log in with Grok".',
      });
    },
  );

  it.effect("runs the disposable probe only after local inspection is ready", () =>
    Effect.gen(function* () {
      const settings = decodeSettings({ agentId: "test-agent" });
      const environment = { PATH: "/provider/bin" };
      let receivedEnvironment: NodeJS.ProcessEnv | undefined;
      const snapshot = yield* checkAcpRegistryProviderStatus(
        {
          ...identity,
          settings,
          cwd: "/workspace",
          environment,
        },
        (input) =>
          Effect.sync(() => {
            receivedEnvironment = input.environment;
            return {
              probe: {
                instanceId: identity.instanceId,
                ready: true as const,
                icon: null,
                authMethods: [],
                models: [{ id: "agent-model", name: "Agent Model", description: null }],
                currentModelId: "agent-model",
                configOptions: [],
                sessionManagement: noSessionManagement,
              },
              slashCommands: [{ name: "review" }],
              skills: [],
            };
          }),
      ).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(receivedEnvironment).toEqual({ ...environment, MISE_OFFLINE: "1" });
      expect(snapshot).toMatchObject({
        auth: { status: "unknown" },
        models: [{ slug: "agent-model" }],
        slashCommands: [{ name: "review" }],
        skills: [],
      });
    }),
  );

  it.effect("publishes concrete local readiness before background ACP discovery", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkAcpRegistryProviderReadiness({
        ...identity,
        settings: decodeSettings({ agentId: "test-agent" }),
        environment: { PATH: "/provider/bin" },
      }).pipe(
        Effect.provideService(
          AcpRegistrySupport.AcpRegistryCatalog,
          catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
        ),
      );

      expect(snapshot).toMatchObject({
        installed: true,
        status: "ready",
        version: "1.0.0",
        auth: { status: "unknown" },
        message: "Checking ACP authentication, models, and commands in the background...",
      });
    }),
  );

  it("keeps a richer probed catalog when a live session reports one provisional model", () => {
    const provider = providerWithModels(
      [
        { id: "auto", name: "Auto", description: null },
        { id: "qmodel", name: "Qwen", description: null },
        { id: "kmodel", name: "Kimi", description: null },
      ],
      "auto",
    );

    const fallbackSelected = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: [{ id: "smodel", name: "Default", description: null }],
        currentModelId: "smodel",
        configOptions: [],
        modelsFromModelSelect: false,
      },
      [],
    );
    expect(fallbackSelected.models.map((m) => m.slug)).toEqual(["auto", "qmodel", "kmodel"]);
    expect(fallbackSelected.models.find((m) => m.slug === "auto")?.isDefault).toBe(true);

    const liveSelected = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: [{ id: "auto", name: "Auto", description: null }],
        currentModelId: "qmodel",
        configOptions: [],
        modelsFromModelSelect: false,
      },
      [],
    );
    expect(liveSelected.models.map((m) => m.slug)).toEqual(["auto", "qmodel", "kmodel"]);
    expect(liveSelected.models.find((m) => m.slug === "qmodel")?.isDefault).toBe(true);
    expect(liveSelected.models.find((m) => m.slug === "auto")?.isDefault).not.toBe(true);
  });

  it("honors an explicit single-model select even when it is absent from the probe catalog", () => {
    const provider = providerWithModels(
      [
        { id: "auto", name: "Auto", description: null },
        { id: "qmodel", name: "Qwen", description: null },
        { id: "kmodel", name: "Kimi", description: null },
      ],
      "auto",
    );

    const entitled = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: [{ id: "gmodel", name: "GPT-Pro", description: null }],
        currentModelId: "gmodel",
        configOptions: [],
        modelsFromModelSelect: true,
      },
      [],
    );
    expect(entitled.models.map((m) => m.slug)).toEqual(["gmodel"]);
    expect(entitled.models.find((m) => m.slug === "gmodel")?.isDefault).toBe(true);

    const narrowed = applyAcpRegistryLiveConfiguration(
      provider,
      {
        models: [{ id: "qmodel", name: "Qwen", description: null }],
        currentModelId: "qmodel",
        configOptions: [],
        modelsFromModelSelect: true,
      },
      [],
    );
    expect(narrowed.models.map((m) => m.slug)).toEqual(["qmodel"]);
    expect(narrowed.models.find((m) => m.slug === "qmodel")?.isDefault).toBe(true);
  });
});

describe("acpRegistryEnrichmentCache", () => {
  it("reuses a local probe until expiry even when inspection has no version", () => {
    const entry = { provider: providerWithModels([], null), expiresAt: 1_000 };
    expect(isAcpRegistryCacheValid(entry, null, true, 999)).toBe(true);
    expect(isAcpRegistryCacheValid(entry, null, true, 1_000)).toBe(false);
    expect(isAcpRegistryCacheValid(entry, "2.0.0", false, 999)).toBe(false);
    expect(isAcpRegistryCacheValid(entry, "1.0.0", false, 999)).toBe(true);
  });
  const settledConfiguration = {
    models: [
      { id: "auto", name: "Auto", description: null },
      { id: "qmodel", name: "Qwen", description: null },
      { id: "kmodel", name: "Kimi", description: null },
    ],
    currentModelId: "auto",
    configOptions: [],
    modelsFromModelSelect: true,
  };

  it("does not renew the cache deadline when live configuration is replayed unchanged", () => {
    const provider = providerWithModels(settledConfiguration.models, "auto");
    const cache = { generation: 1, entry: { provider, expiresAt: 1_000 } };

    const replayed = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: settledConfiguration,
      customModels: [],
      now: 2_000,
    });

    expect(replayed).toBe(cache);
    expect(replayed.entry?.expiresAt).toBe(1_000);
  });

  it("updates the cache and promotes the expiry when live configuration discovers a catalog", () => {
    const provider = providerWithModels(
      [{ id: "smodel", name: "Default", description: null }],
      "smodel",
    );
    const cache = { generation: 1, entry: { provider, expiresAt: 1_000 } };

    const updated = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: settledConfiguration,
      customModels: [],
      now: 5_000,
    });

    expect(updated.entry?.provider.models.map((m) => m.slug)).toEqual(["auto", "qmodel", "kmodel"]);
    expect((updated.entry?.expiresAt ?? 0) - 5_000).toBe(15 * 60 * 1_000);
    expect(updated.generation).toBe(2);
  });

  it("advances the cache epoch when a live update arrives before any probe lands", () => {
    const cache = { generation: 4, entry: null };

    const updated = updateAcpRegistryEnrichmentCache({
      cache,
      configuration: settledConfiguration,
      customModels: [],
      now: 5_000,
    });

    expect(updated.generation).toBe(5);
    expect(updated.entry).toBeNull();
  });
});

describe("acpRegistryAdvertisesModelCatalog", () => {
  it("counts choices inside option groups and available model state", () => {
    expect(
      acpRegistryAdvertisesModelCatalog([
        {
          id: "model",
          name: "Model",
          type: "select" as const,
          category: "model" as const,
          currentValue: "auto",
          options: [
            {
              groupId: "qwen",
              name: "Qwen",
              options: [
                { value: "auto", name: "Auto" },
                { value: "qmodel", name: "Qwen3.8-Max" },
              ],
            },
          ],
        },
      ]),
    ).toBe(true);
    expect(
      acpRegistryAdvertisesModelCatalog([
        {
          id: "model",
          name: "Model",
          type: "select" as const,
          category: "model" as const,
          currentValue: "smodel",
          options: [{ value: "smodel", name: "Sonus" }],
        },
      ]),
    ).toBe(false);
    expect(acpRegistryAdvertisesModelCatalog(undefined)).toBe(false);
    expect(
      acpRegistryAdvertisesModelCatalog(undefined, {
        availableModels: [
          { modelId: "auto", name: "Auto", description: null },
          { modelId: "qmodel", name: "Qwen", description: null },
        ],
        currentModelId: "auto",
      }),
    ).toBe(true);
  });
});

const fakeAgentSource = `
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    send({
      id,
      result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [], agentInfo: { name: "fake", version: "1.5.9" } },
    });
  } else if (method === "session/new") {
    const modelIds = JSON.parse(readFileSync(process.argv[2], "utf8"));
    send({
      id,
      result: {
        sessionId: "probe-session",
        models: {
          currentModelId: modelIds[0],
          availableModels: modelIds.map((modelId) => ({ modelId, name: modelId })),
        },
      },
    });
    send({
      method: "session/update",
      params: {
        sessionId: "probe-session",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      },
    });
  } else {
    send({ id, result: {} });
  }
});
`;

const driverLayer = TestProviderHost.layer({ runBackgroundWork: false }).pipe(
  Layer.provideMerge(AcpRegistryRuntimeCoordinator.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(
    Layer.succeed(
      ProviderEventLoggers.ProviderEventLoggers,
      ProviderEventLoggers.NoOpProviderEventLoggers,
    ),
  ),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, FetchHttpClient.layer)),
);

it.layer(driverLayer, { excludeTestServices: true })("AcpRegistryDriver", (it) => {
  it.effect("creates without inspecting the agent, which may fetch the registry", () =>
    Effect.gen(function* () {
      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({ status: "unconfigured" }),
          inspect: () => Effect.die("inspected during creation"),
        }),
      );
      expect(yield* instance.snapshot.getSnapshot).toMatchObject({
        installed: false,
        message: "Checking ACP Registry agent readiness...",
      });
    }),
  );

  it.effect("drops cached and session-reported models when its caches are invalidated", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-driver-" });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-model", "other-model"]));
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;

      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "npx" as const,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            }),
        }),
      );
      const modelSlugs = instance.snapshot.streamChanges.pipe(
        Stream.map((snapshot) => snapshot.models.map((model) => model.slug)),
      );
      const waitForModels = (expected: ReadonlyArray<string>) =>
        modelSlugs.pipe(
          Stream.filter((slugs) => slugs.join() === expected.join()),
          Stream.runHead,
        );

      const probed = yield* waitForModels(["old-model", "other-model"]).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);
      yield* coordinator.publishLiveConfiguration(
        identity.instanceId,
        normalizeAcpRegistryLiveConfiguration([], undefined, {
          currentModelId: "old-model",
          availableModels: [
            { modelId: "old-model", name: "old-model" },
            { modelId: "session-model", name: "session-model" },
          ],
        }),
      );
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["old-model", "new-model"]));

      const refreshed = yield* waitForModels(["old-model", "new-model"]).pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.invalidateCaches ?? Effect.void;
      yield* instance.snapshot.refresh;
      expect(Option.isSome(yield* Fiber.join(refreshed))).toBe(true);
    }),
  );

  it.effect("keeps a local agent's reported version through the next readiness check", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-driver-" });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["model-a"]));

      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ source: "local", commandPath: "agent" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "agent",
            version: null,
            distribution: "local",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "local" as const,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            }),
        }),
      );
      const probed = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.version === "1.5.9"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);

      const nextPublished = yield* instance.snapshot.streamChanges.pipe(
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.invalidateCaches ?? Effect.void;
      yield* instance.snapshot.refresh;
      const next = yield* Fiber.join(nextPublished);
      expect(Option.map(next, (snapshot) => snapshot.version)).toEqual(Option.some("1.5.9"));
    }),
  );

  it.effect("keeps options learned for each model across a refresh", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-driver-" });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["model-a", "model-b"]));
      const coordinator = yield* AcpRegistryRuntimeCoordinator.AcpRegistryRuntimeCoordinator;

      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: identity.displayName,
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "test-agent" }),
      }).pipe(
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "test-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "npx" as const,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            }),
        }),
      );
      const effortBySlug = (snapshot: ServerProvider) =>
        snapshot.models
          .map(
            (model) =>
              `${model.slug}:${(model.capabilities?.optionDescriptors ?? []).map((option) => option.id).join("+")}`,
          )
          .join();
      const waitFor = (expected: string) =>
        instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) => effortBySlug(snapshot) === expected),
          Stream.runHead,
        );
      const session = (currentModelId: string) =>
        normalizeAcpRegistryLiveConfiguration(
          [
            {
              id: "effort",
              name: "Effort",
              category: "thought_level",
              type: "select",
              currentValue: "high",
              options: [
                { value: "low", name: "Low" },
                { value: "high", name: "High" },
              ],
            },
          ],
          undefined,
          {
            currentModelId,
            availableModels: [
              { modelId: "model-a", name: "model-a" },
              { modelId: "model-b", name: "model-b" },
            ],
          },
        );

      const probed = yield* waitFor("model-a:,model-b:").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      yield* Fiber.join(probed);
      const learned = yield* waitFor("model-a:effort,model-b:effort").pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* coordinator.publishLiveConfiguration(identity.instanceId, session("model-b"));
      yield* coordinator.publishLiveConfiguration(identity.instanceId, session("model-a"));
      yield* Fiber.join(learned);

      yield* instance.snapshot.refresh;
      expect(effortBySlug(yield* instance.snapshot.getSnapshot)).toBe(
        "model-a:effort,model-b:effort",
      );
    }),
  );

  it.effect(
    "publishes ordered Factory Droid limits via applyUsageLimits and keeps last known bars on refresh error",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-droid-" });
        const agentPath = path.join(directory, "agent.mjs");
        const modelsPath = path.join(directory, "models.json");
        yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
        yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["claude-opus-4-6"]));
        yield* fileSystem.writeFileString(
          path.join(directory, "auth.json"),
          JSON.stringify({ access_token: "good-tok", active_organization_id: "org_1" }),
        );

        let mode: "initial" | "error" | "updated" = "initial";
        const errorProbeCalled = yield* Deferred.make<void>();
        const mockHttpClient = HttpClient.make((request, url) => {
          if (url.pathname === "/api/billing/limits") {
            if (mode === "error") {
              return Deferred.succeed(errorProbeCalled, undefined).pipe(
                Effect.ignore,
                Effect.as(HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }))),
              );
            }
            const core5hPercent = mode === "updated" ? 55 : 30;
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  usesTokenRateLimitsBilling: true,
                  hasActiveSubscription: true,
                  overagePreference: "droidCore",
                  limits: {
                    standard: {
                      fiveHour: { usedPercent: 10, secondsRemaining: 3_600 },
                      weekly: { usedPercent: 100, secondsRemaining: 72_000 },
                    },
                    core: {
                      fiveHour: { usedPercent: core5hPercent, secondsRemaining: 9_600 },
                    },
                  },
                }),
              ),
            );
          }
          if (url.pathname === "/api/app/auth/me") {
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  organization: {
                    id: "org_1",
                    subscription: {
                      orbSubscription: { plan: { name: "Factory Pro Annual Plan" } },
                    },
                  },
                  userProfile: {
                    email: "dev@example.com",
                    workosUser: { id: "user_1", email: "dev@example.com" },
                  },
                }),
              ),
            );
          }
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
          );
        });

        const instance = yield* AcpRegistryDriver.create({
          instanceId: identity.instanceId,
          displayName: "Factory Droid",
          enabled: true,
          environment: [
            { name: "FACTORY_HOME", value: directory, sensitive: false },
            { name: "FACTORY_DISABLE_KEYRING", value: "1", sensitive: false },
          ],
          config: decodeSettings({ agentId: "factory-droid" }),
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, mockHttpClient),
          Effect.provideService(HostProcess.Environment, {}),
          Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
            ...catalogWithInspection({
              status: "ready",
              agentId: "factory-droid",
              version: "1.0.0",
              distribution: "npx",
            }),
            resolve: () =>
              Effect.succeed({
                distribution: "npx" as const,
                spawn: { command: process.execPath, args: [agentPath, modelsPath] },
              }),
          }),
        );

        const initialReady = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter(
            (snapshot) =>
              snapshot.status === "ready" &&
              (snapshot.usageLimits?.windows.length ?? 0) === 3 &&
              snapshot.auth.status === "authenticated",
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refresh;
        const firstSnapshot = Option.getOrThrow(yield* Fiber.join(initialReady));
        expect(firstSnapshot.usageLimits?.windows.map((w) => w.id)).toEqual([
          "standard-5h",
          "standard-weekly",
          "core-5h",
        ]);
        expect(firstSnapshot.usageLimits?.group).toEqual({
          id: "acpRegistry:factory-droid",
          label: "Factory Droid",
        });
        expect(firstSnapshot.auth.email).toBe("dev@example.com");
        expect(firstSnapshot.auth.label).toBe("Factory Pro Annual Plan");
        expect(firstSnapshot.auth.workspaceId).toBe("org_1");

        // A transient HTTP 500 during refreshUsage keeps the previously published bars and plan.
        mode = "error";
        yield* instance.snapshot.refreshUsage!;
        yield* Deferred.await(errorProbeCalled);
        yield* Effect.yieldNow;
        const afterError = yield* instance.snapshot.getSnapshot;
        expect(afterError.usageLimits?.windows.map((w) => [w.id, w.usedPercent])).toEqual([
          ["standard-5h", 10],
          ["standard-weekly", 100],
          ["core-5h", 30],
        ]);
        expect(afterError.auth.label).toBe("Factory Pro Annual Plan");

        // Next refresh recovers cleanly with updated values.
        mode = "updated";
        const updatedStream = yield* instance.snapshot.streamChanges.pipe(
          Stream.filter((snapshot) =>
            Boolean(
              snapshot.usageLimits?.windows.some((w) => w.id === "core-5h" && w.usedPercent === 55),
            ),
          ),
          Stream.runHead,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* instance.snapshot.refreshUsage!;
        expect(Option.isSome(yield* Fiber.join(updatedStream))).toBe(true);
      }),
  );

  it.effect("retries Factory limits once after ACP probe refreshes an expired token", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-droid-retry-" });
      const agentPath = path.join(directory, "refreshing-agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      const authPath = path.join(directory, "auth.json");
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["claude-opus-4-6"]));
      yield* fileSystem.writeFileString(authPath, JSON.stringify({ access_token: "expired-tok" }));
      yield* fileSystem.writeFileString(
        agentPath,
        `
import { readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const { id, method } = JSON.parse(line);
  if (id === undefined) return;
  if (method === "initialize") {
    send({ id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
  } else if (method === "session/new") {
    writeFileSync(process.argv[3], JSON.stringify({ access_token: "refreshed-tok" }));
    const modelIds = JSON.parse(readFileSync(process.argv[2], "utf8"));
    send({
      id,
      result: {
        sessionId: "probe-session",
        models: { currentModelId: modelIds[0], availableModels: modelIds.map((id) => ({ modelId: id, name: id })) },
      },
    });
  } else {
    send({ id, result: {} });
  }
});
`,
      );

      let expiredCalls = 0;
      const mockHttpClient = HttpClient.make((request, url) => {
        if (request.headers.authorization === "Bearer expired-tok") {
          expiredCalls += 1;
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
          );
        }
        if (url.pathname === "/api/billing/limits") {
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({
                usesTokenRateLimitsBilling: true,
                limits: {
                  standard: {
                    weekly: { usedPercent: 25, secondsRemaining: 10_000 },
                  },
                },
              }),
            ),
          );
        }
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
        );
      });

      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: "Factory Droid",
        enabled: true,
        environment: [
          { name: "FACTORY_HOME", value: directory, sensitive: false },
          { name: "FACTORY_DISABLE_KEYRING", value: "1", sensitive: false },
        ],
        config: decodeSettings({ agentId: "factory-droid" }),
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, mockHttpClient),
        Effect.provideService(HostProcess.Environment, {}),
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "factory-droid",
            version: "1.0.0",
            distribution: "npx",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "npx" as const,
              spawn: { command: process.execPath, args: [agentPath, modelsPath, authPath] },
            }),
        }),
      );

      const recovered = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter(
          (snapshot) =>
            snapshot.usageLimits?.unavailable === undefined &&
            snapshot.usageLimits?.windows.some((w) => w.usedPercent === 25) === true,
        ),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      expect(Option.isSome(yield* Fiber.join(recovered))).toBe(true);
      expect(expiredCalls).toBeGreaterThanOrEqual(1);
    }),
  );

  it.effect("does not probe Factory limits for non-Droid ACP Registry agents", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "acp-other-" });
      const agentPath = path.join(directory, "agent.mjs");
      const modelsPath = path.join(directory, "models.json");
      yield* fileSystem.writeFileString(agentPath, fakeAgentSource);
      yield* fileSystem.writeFileString(modelsPath, JSON.stringify(["other-model"]));

      const failingHttpClient = HttpClient.make(() =>
        Effect.die(new Error("Factory HTTP must not be called for non-Droid agents")),
      );
      const instance = yield* AcpRegistryDriver.create({
        instanceId: identity.instanceId,
        displayName: "Other Agent",
        enabled: true,
        environment: [],
        config: decodeSettings({ agentId: "other-agent" }),
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, failingHttpClient),
        Effect.provideService(AcpRegistrySupport.AcpRegistryCatalog, {
          ...catalogWithInspection({
            status: "ready",
            agentId: "other-agent",
            version: "1.0.0",
            distribution: "npx",
          }),
          resolve: () =>
            Effect.succeed({
              distribution: "npx" as const,
              spawn: { command: process.execPath, args: [agentPath, modelsPath] },
            }),
        }),
      );
      const ready = yield* instance.snapshot.streamChanges.pipe(
        Stream.filter((snapshot) => snapshot.status === "ready"),
        Stream.runHead,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* instance.snapshot.refresh;
      const snapshot = Option.getOrThrow(yield* Fiber.join(ready));
      expect(snapshot.usageLimits).toBeUndefined();
    }),
  );
});
