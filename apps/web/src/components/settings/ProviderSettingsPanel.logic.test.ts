import {
  AuthProvidersManageScope,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildProviderInstanceOverridePatch,
  buildProviderInstanceTree,
  isProviderGroupExpanded,
  resolveProviderGroupIdentity,
  resolveRemoteOperateAccess,
  type ProviderInstanceTreeItem,
} from "./ProviderSettingsPanel.logic";

describe("buildProviderInstanceOverridePatch", () => {
  const projectId = ProjectId.make("project-a");
  const instanceId = ProviderInstanceId.make("codex_work");

  it("writes the same choice to every checkout of the project", () => {
    const siblingId = ProjectId.make("project-a-worktree");
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [siblingId]: { newWorktreesStartFromOrigin: true },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId, siblingId], instanceId, false),
    ).toEqual({
      [projectId]: { providerInstances: { [instanceId]: { enabled: false } } },
      [siblingId]: {
        newWorktreesStartFromOrigin: true,
        providerInstances: { [instanceId]: { enabled: false } },
      },
    });
  });

  it("resets the only override by clearing the whole project entry", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: { providerInstances: { [instanceId]: { enabled: true } } },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({ [projectId]: null });
  });

  it("sends providerInstances: {} explicitly when clearing the last instance override leaves other keys", () => {
    const settings: Pick<ServerSettings, "projectSettingsOverrides"> = {
      projectSettingsOverrides: {
        [projectId]: {
          newWorktreesStartFromOrigin: true,
          providerInstances: { [instanceId]: { enabled: true } },
        },
      },
    };

    expect(
      buildProviderInstanceOverridePatch(settings, [projectId], instanceId, undefined),
    ).toEqual({
      [projectId]: { newWorktreesStartFromOrigin: true, providerInstances: {} },
    });
  });
});

describe("remote operate access", () => {
  it("does not treat the old orchestration grant as provider management", () => {
    expect(
      resolveRemoteOperateAccess({
        session: {
          authenticated: true,
          scopes: ["orchestration:operate"],
          auth: { serverUpdateScope: "environment:maintain" },
        },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });

  it("accepts the orchestration grant from a server that predates providers:manage", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:operate"], auth: {} },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
  });
  it("derives access from the environment session's granted scopes", () => {
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: [AuthProvidersManageScope] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("granted");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: true, scopes: ["orchestration:read"] },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
    expect(
      resolveRemoteOperateAccess({
        session: { authenticated: false },
        isPending: false,
        hasError: false,
      }),
    ).toBe("denied");
  });
});

const acpDriver = ProviderDriverKind.make("acpRegistry");
const codexDriver = ProviderDriverKind.make("codex");
const antigravityDriver = ProviderDriverKind.make("antigravity");

describe("resolveProviderGroupIdentity", () => {
  it("keys non-ACP drivers by their driver kind", () => {
    expect(
      resolveProviderGroupIdentity({
        driver: codexDriver,
        config: undefined,
        driverLabel: "Codex",
      }),
    ).toEqual({ groupKey: "driver:codex", groupLabel: "Codex" });
    expect(
      resolveProviderGroupIdentity({
        driver: antigravityDriver,
        config: { agentId: "factory-droid" },
        driverLabel: "Antigravity",
      }),
    ).toEqual({ groupKey: "driver:antigravity", groupLabel: "Antigravity" });
  });

  it("keeps local ACP instances together without registry identity", () => {
    expect(
      resolveProviderGroupIdentity({
        driver: acpDriver,
        config: { source: "local", agentId: "factory-droid" },
        driverLabel: "ACP Registry",
      }),
    ).toEqual({ groupKey: "acp:local", groupLabel: "Local ACP" });
  });

  it("groups local DeepSeek Harness commands under their own brand group", () => {
    const args = [
      "--expose-internals",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js",
      "--profile",
      "acp",
    ];
    for (const commandPath of [
      "dsh.cmd",
      "C:\\Users\\me\\AppData\\Roaming\\npm\\dsh",
      "C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe",
    ]) {
      expect(
        resolveProviderGroupIdentity({
          driver: acpDriver,
          config: { source: "local", commandPath, commandArgs: args },
          driverLabel: "ACP Registry",
        }),
      ).toEqual({
        groupKey: "acp:deepseek-harness",
        groupLabel: "DeepSeek Harness",
        acpRegistryAgentId: "deepseek-harness",
      });
    }
  });

  it("detects a local DeepSeek Harness launch from its entrypoint args and keeps the icon", () => {
    expect(
      resolveProviderGroupIdentity({
        driver: acpDriver,
        config: {
          source: "local",
          commandPath: "C:\\Program Files\\Custom\\node.exe",
          commandArgs: ["/app/node_modules/@deepseek-ai/dsh/lib/cli.js", "--profile", "acp"],
          registryIconUrl: "https://example.com/dsh.svg",
        },
        driverLabel: "ACP Registry",
      }),
    ).toEqual({
      groupKey: "acp:deepseek-harness",
      groupLabel: "DeepSeek Harness",
      acpRegistryAgentId: "deepseek-harness",
      acpRegistryIconUrl: "https://example.com/dsh.svg",
    });
  });

  it("does not treat other local ACP commands as DeepSeek Harness", () => {
    expect(
      resolveProviderGroupIdentity({
        driver: acpDriver,
        config: {
          source: "local",
          agentId: "custom-agent",
          commandPath: "C:\\tools\\my-agent.cmd",
          commandArgs: ["--expose-internals", "/app/node_modules/@example/agent/lib/cli.js"],
        },
        driverLabel: "ACP Registry",
      }),
    ).toEqual({ groupKey: "acp:local", groupLabel: "Local ACP" });
  });

  it("groups registry DeepSeek Harness agent ids under the brand group", () => {
    for (const agentId of ["deepseek-harness", "dsh"]) {
      expect(
        resolveProviderGroupIdentity({
          driver: acpDriver,
          config: { agentId },
          driverLabel: "ACP Registry",
        }),
      ).toEqual({
        groupKey: "acp:deepseek-harness",
        groupLabel: "DeepSeek Harness",
        acpRegistryAgentId: agentId,
      });
    }
  });

  it("names the factory-droid agent and carries its registry icon", () => {
    expect(
      resolveProviderGroupIdentity({
        driver: acpDriver,
        config: { agentId: "factory-droid", registryIconUrl: "https://example.com/droid.svg" },
        driverLabel: "ACP Registry",
      }),
    ).toEqual({
      groupKey: "acp:factory-droid",
      groupLabel: "Factory Droid",
      acpRegistryAgentId: "factory-droid",
      acpRegistryIconUrl: "https://example.com/droid.svg",
    });
  });

  it("title-cases other agent ids and trims them", () => {
    expect(
      resolveProviderGroupIdentity({
        driver: acpDriver,
        config: { agentId: "  swe_agent-v2 " },
        driverLabel: "ACP Registry",
      }),
    ).toEqual({
      groupKey: "acp:swe_agent-v2",
      groupLabel: "Swe Agent V2",
      acpRegistryAgentId: "swe_agent-v2",
    });
  });

  it("falls back to the live icon, then to no icon, then to the driver label", () => {
    expect(
      resolveProviderGroupIdentity({
        driver: acpDriver,
        config: { agentId: "qwen-code" },
        driverLabel: "ACP Registry",
        liveIconUrl: "https://example.com/live.svg",
      }),
    ).toEqual({
      groupKey: "acp:qwen-code",
      groupLabel: "Qwen Code",
      acpRegistryAgentId: "qwen-code",
      acpRegistryIconUrl: "https://example.com/live.svg",
    });
    expect(
      resolveProviderGroupIdentity({
        driver: acpDriver,
        config: null,
        driverLabel: "ACP Registry",
      }),
    ).toEqual({ groupKey: "acp:unconfigured", groupLabel: "ACP Registry" });
    expect(
      resolveProviderGroupIdentity({
        driver: acpDriver,
        config: { agentId: "   " },
        driverLabel: "ACP Registry",
        liveIconUrl: "   ",
      }),
    ).toEqual({ groupKey: "acp:unconfigured", groupLabel: "ACP Registry" });
  });
});

function treeItem(input: {
  readonly instanceId: string;
  readonly enabled: boolean;
  readonly groupKey: string;
  readonly originalIndex: number;
  readonly driver?: ProviderDriverKind;
  readonly isDefault?: boolean;
  readonly groupLabel?: string;
  readonly versionLabel?: string | null;
  readonly acpRegistryAgentId?: string;
  readonly acpRegistryIconUrl?: string;
}): ProviderInstanceTreeItem<string> {
  return {
    row: input.instanceId,
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: input.driver ?? codexDriver,
    isDefault: input.isDefault ?? false,
    enabled: input.enabled,
    groupKey: input.groupKey,
    groupLabel: input.groupLabel ?? input.groupKey,
    originalIndex: input.originalIndex,
    ...(input.versionLabel !== undefined ? { versionLabel: input.versionLabel } : {}),
    ...(input.acpRegistryAgentId !== undefined
      ? { acpRegistryAgentId: input.acpRegistryAgentId }
      : {}),
    ...(input.acpRegistryIconUrl !== undefined
      ? { acpRegistryIconUrl: input.acpRegistryIconUrl }
      : {}),
  };
}

describe("buildProviderInstanceTree", () => {
  it("sorts enabled groups above disabled groups", () => {
    const groups = buildProviderInstanceTree([
      treeItem({ instanceId: "codex", enabled: false, groupKey: "driver:codex", originalIndex: 0 }),
      treeItem({
        instanceId: "claudeAgent",
        enabled: true,
        groupKey: "driver:claudeAgent",
        originalIndex: 1,
      }),
    ]);

    expect(groups.map((group) => group.groupKey)).toEqual(["driver:claudeAgent", "driver:codex"]);
    expect(groups.map((group) => group.hasEnabled)).toEqual([true, false]);
  });

  it("sorts enabled, then default, then input order within a group", () => {
    const [group] = buildProviderInstanceTree([
      treeItem({
        instanceId: "disabled-default",
        enabled: false,
        isDefault: true,
        groupKey: "driver:antigravity",
        originalIndex: 0,
      }),
      treeItem({
        instanceId: "enabled-custom",
        enabled: true,
        groupKey: "driver:antigravity",
        originalIndex: 1,
      }),
      treeItem({
        instanceId: "enabled-default",
        enabled: true,
        isDefault: true,
        groupKey: "driver:antigravity",
        originalIndex: 2,
      }),
    ]);

    expect(group).toBeDefined();
    expect(group!.items.map((item) => item.instanceId)).toEqual([
      ProviderInstanceId.make("enabled-default"),
      ProviderInstanceId.make("enabled-custom"),
      ProviderInstanceId.make("disabled-default"),
    ]);
    expect(group!.enabledCount).toBe(2);
    expect(group!.totalCount).toBe(3);
  });

  it("groups multiple antigravity instances and keeps project-override ordering", () => {
    const [group] = buildProviderInstanceTree([
      treeItem({
        instanceId: "antigravity",
        enabled: false,
        isDefault: true,
        groupKey: "driver:antigravity",
        originalIndex: 0,
      }),
      treeItem({
        instanceId: "antigravity_work",
        enabled: true,
        groupKey: "driver:antigravity",
        originalIndex: 1,
      }),
    ]);

    expect(group).toMatchObject({
      groupKey: "driver:antigravity",
      enabledCount: 1,
      totalCount: 2,
      hasEnabled: true,
      firstOriginalIndex: 0,
    });
    expect(group!.items.map((item) => item.enabled)).toEqual([true, false]);
  });

  it("groups ACP instances by agent id and prefixes local ACP with the shared key", () => {
    const groups = buildProviderInstanceTree([
      treeItem({
        instanceId: "droid-a",
        enabled: true,
        groupKey: "acp:factory-droid",
        groupLabel: "Factory Droid",
        driver: acpDriver,
        originalIndex: 0,
        acpRegistryAgentId: "factory-droid",
        acpRegistryIconUrl: "https://example.com/droid.svg",
      }),
      treeItem({
        instanceId: "droid-b",
        enabled: true,
        groupKey: "acp:factory-droid",
        groupLabel: "Factory Droid",
        driver: acpDriver,
        originalIndex: 1,
      }),
      treeItem({
        instanceId: "local-a",
        enabled: true,
        groupKey: "acp:local",
        groupLabel: "Local ACP",
        driver: acpDriver,
        originalIndex: 2,
      }),
      treeItem({
        instanceId: "local-b",
        enabled: false,
        groupKey: "acp:local",
        groupLabel: "Local ACP",
        driver: acpDriver,
        originalIndex: 3,
      }),
    ]);

    expect(groups.map((group) => group.groupKey)).toEqual(["acp:factory-droid", "acp:local"]);
    expect(groups[0]?.items).toHaveLength(2);
    expect(groups[0]?.totalCount).toBe(2);
    expect(groups[0]?.acpRegistryAgentId).toBe("factory-droid");
    expect(groups[0]?.acpRegistryIconUrl).toBe("https://example.com/droid.svg");
    expect(groups[1]?.enabledCount).toBe(1);
    expect(groups[1]?.totalCount).toBe(2);
  });

  it("groups two DeepSeek Harness instances under one brand group", () => {
    const configs = [
      { source: "local", commandPath: "dsh.cmd", commandArgs: ["--profile", "acp"] },
      { source: "local", commandPath: "C:\\Tools\\dsh", commandArgs: ["--profile", "acp"] },
    ];
    const items = configs.map((config, index) => {
      const identity = resolveProviderGroupIdentity({
        driver: acpDriver,
        config,
        driverLabel: "ACP Registry",
        liveIconUrl: index === 0 ? "https://example.com/dsh.svg" : null,
      });
      return treeItem({
        instanceId: `dsh-${String(index)}`,
        enabled: true,
        driver: acpDriver,
        groupKey: identity.groupKey,
        groupLabel: identity.groupLabel,
        originalIndex: index,
        ...(identity.acpRegistryAgentId !== undefined
          ? { acpRegistryAgentId: identity.acpRegistryAgentId }
          : {}),
        ...(identity.acpRegistryIconUrl !== undefined
          ? { acpRegistryIconUrl: identity.acpRegistryIconUrl }
          : {}),
      });
    });

    const groups = buildProviderInstanceTree(items);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      groupKey: "acp:deepseek-harness",
      groupLabel: "DeepSeek Harness",
      acpRegistryAgentId: "deepseek-harness",
      acpRegistryIconUrl: "https://example.com/dsh.svg",
      enabledCount: 2,
      totalCount: 2,
    });
  });

  it("keeps single-instance providers as one-item groups", () => {
    const groups = buildProviderInstanceTree([
      treeItem({
        instanceId: "cursor",
        enabled: true,
        groupKey: "driver:cursor",
        originalIndex: 0,
      }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]?.items).toHaveLength(1);
  });

  it("uses the first enabled version, then the first version, else null", () => {
    const [enabledGroup] = buildProviderInstanceTree([
      treeItem({
        instanceId: "disabled-first",
        enabled: false,
        groupKey: "driver:antigravity",
        originalIndex: 0,
        versionLabel: "v1",
      }),
      treeItem({
        instanceId: "enabled-second",
        enabled: true,
        groupKey: "driver:antigravity",
        originalIndex: 1,
        versionLabel: "v2",
      }),
    ]);
    expect(enabledGroup?.sharedVersionLabel).toBe("v2");

    const [disabledGroup] = buildProviderInstanceTree([
      treeItem({
        instanceId: "disabled-first",
        enabled: false,
        groupKey: "driver:antigravity",
        originalIndex: 0,
      }),
      treeItem({
        instanceId: "disabled-second",
        enabled: false,
        groupKey: "driver:antigravity",
        originalIndex: 1,
        versionLabel: "v3",
      }),
    ]);
    expect(disabledGroup?.sharedVersionLabel).toBe("v3");

    const [emptyGroup] = buildProviderInstanceTree([
      treeItem({
        instanceId: "codex",
        enabled: false,
        groupKey: "driver:codex",
        originalIndex: 0,
        versionLabel: null,
      }),
    ]);
    expect(emptyGroup?.sharedVersionLabel).toBeNull();
  });

  it("keeps the first-seen original index for a re-encountered group", () => {
    const groups = buildProviderInstanceTree([
      treeItem({ instanceId: "a-1", enabled: true, groupKey: "driver:a", originalIndex: 8 }),
      treeItem({ instanceId: "b", enabled: true, groupKey: "driver:b", originalIndex: 2 }),
      treeItem({ instanceId: "a-2", enabled: true, groupKey: "driver:a", originalIndex: 5 }),
    ]);

    expect(groups.map((group) => group.groupKey)).toEqual(["driver:b", "driver:a"]);
    expect(groups[1]?.firstOriginalIndex).toBe(8);
  });
});

describe("isProviderGroupExpanded", () => {
  const group = (
    overrides: { readonly hasEnabled?: boolean; readonly items?: Array<{ enabled: boolean }> } = {},
  ) => ({
    groupKey: "driver:antigravity",
    hasEnabled: overrides.hasEnabled ?? true,
    items: overrides.items?.map((item, index) =>
      treeItem({
        instanceId: `antigravity-${index}`,
        enabled: item.enabled,
        groupKey: "driver:antigravity",
        originalIndex: index,
      }),
    ) ?? [
      treeItem({
        instanceId: "antigravity-0",
        enabled: true,
        groupKey: "driver:antigravity",
        originalIndex: 0,
      }),
      treeItem({
        instanceId: "antigravity-1",
        enabled: false,
        groupKey: "driver:antigravity",
        originalIndex: 1,
      }),
    ],
  });

  it("never treats a single instance as collapsible", () => {
    expect(
      isProviderGroupExpanded({
        group: { ...group(), items: group().items.slice(0, 1) },
        overrides: {},
      }),
    ).toBe(false);
  });

  it("defaults to open for enabled groups and closed otherwise", () => {
    expect(isProviderGroupExpanded({ group: group(), overrides: {} })).toBe(true);
    expect(
      isProviderGroupExpanded({
        group: group({ hasEnabled: false, items: [{ enabled: false }, { enabled: false }] }),
        overrides: {},
      }),
    ).toBe(false);
  });

  it("opens for the selected or targeted instance", () => {
    const disabledGroup = group({
      hasEnabled: false,
      items: [{ enabled: false }, { enabled: false }],
    });
    expect(
      isProviderGroupExpanded({
        group: disabledGroup,
        selectedInstanceId: ProviderInstanceId.make("antigravity-1"),
        overrides: {},
      }),
    ).toBe(true);
    expect(
      isProviderGroupExpanded({
        group: disabledGroup,
        targetInstanceId: ProviderInstanceId.make("antigravity-0"),
        overrides: {},
      }),
    ).toBe(true);
  });

  it("lets explicit overrides win", () => {
    expect(
      isProviderGroupExpanded({
        group: group(),
        overrides: { "driver:antigravity": false },
      }),
    ).toBe(false);
    expect(
      isProviderGroupExpanded({
        group: group({ hasEnabled: false, items: [{ enabled: false }, { enabled: false }] }),
        overrides: { "driver:antigravity": true },
      }),
    ).toBe(true);
  });
});
