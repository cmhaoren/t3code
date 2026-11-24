import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  AuthProvidersManageScope,
  type EnvironmentId,
  type ProjectId,
  type ProjectSettingsOverrides,
  type ProviderDriverKind,
  type ProviderInstanceId,
  sessionGrantsScope,
  type ServerSettings,
  type SessionGrantInput,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";

export interface ProviderEnvironmentOptionLike {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function isProviderSettingsEnvironmentAvailable(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
}): boolean {
  return input.connectionPhase === "connected" && input.hasServerConfig;
}

export function buildProviderEnvironmentOptions<T extends ProviderEnvironmentOptionLike>(
  environments: ReadonlyArray<T>,
  primaryEnvironmentId: EnvironmentId | null,
  environmentIds?: readonly EnvironmentId[],
): ReadonlyArray<T> {
  const allowed = environmentIds ? new Set(environmentIds) : null;
  return environments
    .filter((environment) => !allowed || allowed.has(environment.environmentId))
    .toSorted((left, right) => {
      const leftIsPrimary = left.environmentId === primaryEnvironmentId;
      const rightIsPrimary = right.environmentId === primaryEnvironmentId;
      if (leftIsPrimary !== rightIsPrimary) {
        return leftIsPrimary ? -1 : 1;
      }
      return (
        left.label.localeCompare(right.label) ||
        String(left.environmentId).localeCompare(String(right.environmentId))
      );
    });
}

export function resolveSelectedProviderEnvironmentId(
  environments: ReadonlyArray<ProviderEnvironmentOptionLike>,
  selectedEnvironmentId: EnvironmentId | null,
  primaryEnvironmentId: EnvironmentId | null,
): EnvironmentId | null {
  if (
    selectedEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === selectedEnvironmentId)
  ) {
    return selectedEnvironmentId;
  }
  if (
    primaryEnvironmentId !== null &&
    environments.some((environment) => environment.environmentId === primaryEnvironmentId)
  ) {
    return primaryEnvironmentId;
  }
  return environments[0]?.environmentId ?? null;
}

export type ProviderEnvironmentAccess =
  | { readonly kind: "editable" }
  | { readonly kind: "loading"; readonly reason: "config" | "permissions" }
  | { readonly kind: "read-only" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "error" };

export type ProviderOperateAccess = "granted" | "denied" | "pending";

export function resolveRemoteOperateAccess(input: {
  readonly session: SessionGrantInput | null;
  readonly isPending: boolean;
  readonly hasError: boolean;
}): ProviderOperateAccess {
  if (input.hasError) return "denied";
  if (input.session === null) return input.isPending ? "pending" : "denied";
  return sessionGrantsScope(input.session, AuthProvidersManageScope) ? "granted" : "denied";
}

/** Send providerInstances even when empty; omission preserves the stored map for older clients. */

export function buildProviderInstanceOverridePatch(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectIds: readonly ProjectId[],
  instanceId: ProviderInstanceId,
  value: boolean | undefined,
): Record<ProjectId, ProjectSettingsOverrides | null> {
  const patch: Record<ProjectId, ProjectSettingsOverrides | null> = {};
  for (const projectId of projectIds) {
    const current = settings.projectSettingsOverrides[projectId];
    const instances = { ...current?.providerInstances };
    const instance = { ...instances[instanceId] };
    if (value === undefined) delete instance.enabled;
    else instance.enabled = value;
    if (Object.keys(instance).length > 0) instances[instanceId] = instance;
    else delete instances[instanceId];

    const { providerInstances: _omit, ...rest } = current ?? {};
    const nextEntry: ProjectSettingsOverrides = { ...rest, providerInstances: instances };
    patch[projectId] =
      Object.keys(rest).length === 0 && Object.keys(instances).length === 0 ? null : nextEntry;
  }
  return patch;
}

export function classifyProviderEnvironmentAccess(input: {
  readonly connectionPhase: EnvironmentConnectionPhase;
  readonly hasServerConfig: boolean;
  readonly operateAccess: ProviderOperateAccess;
}): ProviderEnvironmentAccess {
  if (input.connectionPhase === "error") {
    return { kind: "error" };
  }
  if (input.connectionPhase !== "connected") {
    return { kind: "unavailable" };
  }
  if (!input.hasServerConfig) {
    return { kind: "loading", reason: "config" };
  }
  if (input.operateAccess === "pending") {
    return { kind: "loading", reason: "permissions" };
  }
  if (input.operateAccess === "denied") {
    return { kind: "read-only" };
  }
  return { kind: "editable" };
}

export interface ProviderGroupIdentity {
  readonly groupKey: string;
  readonly groupLabel: string;
  readonly acpRegistryAgentId?: string | undefined;
  readonly acpRegistryIconUrl?: string | undefined;
}

function configText(config: unknown, key: string): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function titleCaseAgentId(agentId: string): string {
  const words = agentId
    .split(/[-_]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`);
  return words.length > 0 ? words.join(" ") : agentId;
}

export function resolveProviderGroupIdentity(input: {
  readonly driver: ProviderDriverKind;
  readonly config: unknown;
  readonly driverLabel: string;
  readonly liveIconUrl?: string | null | undefined;
}): ProviderGroupIdentity {
  if (input.driver === "acpRegistry") {
    const source = configText(input.config, "source");
    const agentId = configText(input.config, "agentId");
    const iconUrl =
      configText(input.config, "registryIconUrl") ??
      (typeof input.liveIconUrl === "string" && input.liveIconUrl.trim().length > 0
        ? input.liveIconUrl.trim()
        : null);
    if (source === "local") {
      return { groupKey: "acp:local", groupLabel: m(msg("Local ACP")) };
    }
    if (agentId !== null) {
      return {
        groupKey: `acp:${agentId}`,
        groupLabel:
          agentId === "factory-droid" ? m(msg("Factory Droid")) : titleCaseAgentId(agentId),
        acpRegistryAgentId: agentId,
        ...(iconUrl !== null ? { acpRegistryIconUrl: iconUrl } : {}),
      };
    }
    return { groupKey: "acp:unconfigured", groupLabel: input.driverLabel };
  }
  return { groupKey: `driver:${String(input.driver)}`, groupLabel: input.driverLabel };
}

export interface ProviderInstanceTreeItem<TRow> {
  readonly row: TRow;
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly enabled: boolean;
  readonly groupKey: string;
  readonly groupLabel: string;
  readonly acpRegistryAgentId?: string | undefined;
  readonly acpRegistryIconUrl?: string | undefined;
  readonly versionLabel?: string | null | undefined;
  readonly originalIndex: number;
}

export interface ProviderInstanceTreeGroup<TRow> {
  readonly groupKey: string;
  readonly groupLabel: string;
  readonly driver: ProviderDriverKind;
  readonly items: ReadonlyArray<ProviderInstanceTreeItem<TRow>>;
  readonly enabledCount: number;
  readonly totalCount: number;
  readonly hasEnabled: boolean;
  readonly sharedVersionLabel: string | null;
  readonly acpRegistryAgentId?: string | undefined;
  readonly acpRegistryIconUrl?: string | undefined;
  readonly firstOriginalIndex: number;
}

interface MutableProviderInstanceTreeGroup<TRow> {
  readonly groupKey: string;
  readonly groupLabel: string;
  readonly driver: ProviderDriverKind;
  readonly items: Array<ProviderInstanceTreeItem<TRow>>;
  readonly firstOriginalIndex: number;
}

function compareProviderInstanceTreeItems<TRow>(
  left: ProviderInstanceTreeItem<TRow>,
  right: ProviderInstanceTreeItem<TRow>,
): number {
  if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
  if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
  return left.originalIndex - right.originalIndex;
}

export function buildProviderInstanceTree<TRow>(
  items: ReadonlyArray<ProviderInstanceTreeItem<TRow>>,
): ReadonlyArray<ProviderInstanceTreeGroup<TRow>> {
  const grouped = new Map<string, MutableProviderInstanceTreeGroup<TRow>>();
  for (const item of items) {
    const existing = grouped.get(item.groupKey);
    if (existing !== undefined) {
      existing.items.push(item);
      continue;
    }
    grouped.set(item.groupKey, {
      groupKey: item.groupKey,
      groupLabel: item.groupLabel,
      driver: item.driver,
      items: [item],
      firstOriginalIndex: item.originalIndex,
    });
  }

  const groups: ProviderInstanceTreeGroup<TRow>[] = [];
  for (const mutable of grouped.values()) {
    const sortedItems = mutable.items.toSorted(compareProviderInstanceTreeItems);
    const enabledCount = sortedItems.filter((item) => item.enabled).length;
    const sharedVersionLabel =
      sortedItems.find((item) => item.enabled && Boolean(item.versionLabel))?.versionLabel ??
      sortedItems.find((item) => Boolean(item.versionLabel))?.versionLabel ??
      null;
    const acpItem = sortedItems.find(
      (item) => item.acpRegistryAgentId !== undefined || item.acpRegistryIconUrl !== undefined,
    );
    groups.push({
      groupKey: mutable.groupKey,
      groupLabel: mutable.groupLabel,
      driver: mutable.driver,
      items: sortedItems,
      enabledCount,
      totalCount: sortedItems.length,
      hasEnabled: enabledCount > 0,
      sharedVersionLabel,
      ...(acpItem?.acpRegistryAgentId !== undefined
        ? { acpRegistryAgentId: acpItem.acpRegistryAgentId }
        : {}),
      ...(acpItem?.acpRegistryIconUrl !== undefined
        ? { acpRegistryIconUrl: acpItem.acpRegistryIconUrl }
        : {}),
      firstOriginalIndex: mutable.firstOriginalIndex,
    });
  }

  return groups.toSorted((left, right) => {
    if (left.hasEnabled !== right.hasEnabled) return left.hasEnabled ? -1 : 1;
    return left.firstOriginalIndex - right.firstOriginalIndex;
  });
}

export function isProviderGroupExpanded(input: {
  readonly group: Pick<ProviderInstanceTreeGroup<unknown>, "groupKey" | "hasEnabled" | "items">;
  readonly selectedInstanceId?: ProviderInstanceId | null | undefined;
  readonly targetInstanceId?: ProviderInstanceId | null | undefined;
  readonly overrides: Readonly<Record<string, boolean>>;
}): boolean {
  if (input.group.items.length < 2) return false;
  if (Object.hasOwn(input.overrides, input.group.groupKey)) {
    return Boolean(input.overrides[input.group.groupKey]);
  }
  return (
    input.group.hasEnabled ||
    input.group.items.some(
      (item) =>
        item.instanceId === input.selectedInstanceId || item.instanceId === input.targetInstanceId,
    )
  );
}
