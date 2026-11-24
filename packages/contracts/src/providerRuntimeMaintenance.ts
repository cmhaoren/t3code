import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const ProviderRuntimeKind = Schema.Literals([
  "acpRegistry",
  "managedBinary",
  "systemCli",
  "bundledSdk",
]);
export type ProviderRuntimeKind = typeof ProviderRuntimeKind.Type;

export const ProviderRuntimeInstalledVersion = Schema.Struct({
  version: Schema.String,
  id: Schema.String,
  sizeBytes: Schema.Number,
  isActive: Schema.Boolean,
  installedAt: Schema.NullOr(Schema.String),
  path: Schema.String,
});
export type ProviderRuntimeInstalledVersion = typeof ProviderRuntimeInstalledVersion.Type;

export const ProviderRuntimeEntry = Schema.Struct({
  runtimeId: Schema.String,
  displayName: Schema.String,
  driver: ProviderDriverKind,
  kind: ProviderRuntimeKind,
  agentId: Schema.optionalKey(Schema.String),
  distribution: Schema.optionalKey(Schema.String),
  usedByInstanceIds: Schema.Array(ProviderInstanceId),
  activeVersion: Schema.NullOr(Schema.String),
  latestVersion: Schema.NullOr(Schema.String),
  updateAvailable: Schema.Boolean,
  canCheckUpdate: Schema.Boolean,
  canUpdate: Schema.Boolean,
  canSwitchVersion: Schema.Boolean,
  canPrune: Schema.Boolean,
  updateCommand: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  totalSizeBytes: Schema.Number,
  reclaimableBytes: Schema.Number,
  versions: Schema.Array(ProviderRuntimeInstalledVersion),
  lastCheckedAt: Schema.NullOr(Schema.String),
});
export type ProviderRuntimeEntry = typeof ProviderRuntimeEntry.Type;

export const ProviderRuntimeInventory = Schema.Struct({
  checkedAt: Schema.String,
  totalSizeBytes: Schema.Number,
  reclaimableBytes: Schema.Number,
  autoPruneOldVersions: Schema.Boolean,
  runtimes: Schema.Array(ProviderRuntimeEntry),
});
export type ProviderRuntimeInventory = typeof ProviderRuntimeInventory.Type;

export class ProviderRuntimeMaintenanceError extends Schema.TaggedError<ProviderRuntimeMaintenanceError>()(
  "ProviderRuntimeMaintenanceError",
  {
    operation: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ListProviderRuntimesInput = Schema.Struct({});
export type ListProviderRuntimesInput = typeof ListProviderRuntimesInput.Type;

export const CheckProviderRuntimeUpdatesInput = Schema.Struct({
  runtimeId: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CheckProviderRuntimeUpdatesInput = typeof CheckProviderRuntimeUpdatesInput.Type;

export const UpdateProviderRuntimeInput = Schema.Struct({
  runtimeId: TrimmedNonEmptyString,
  action: Schema.Literals(["update", "switch"]),
  targetVersion: Schema.optionalKey(TrimmedNonEmptyString),
  pruneOldVersions: Schema.optionalKey(Schema.Boolean),
});
export type UpdateProviderRuntimeInput = typeof UpdateProviderRuntimeInput.Type;

export const UpdateProviderRuntimeResult = Schema.Struct({
  runtimeId: Schema.String,
  previousVersion: Schema.NullOr(Schema.String),
  activeVersion: Schema.NullOr(Schema.String),
  prunedVersions: Schema.Array(Schema.String),
  reclaimedBytes: Schema.Number,
  inventory: ProviderRuntimeInventory,
});
export type UpdateProviderRuntimeResult = typeof UpdateProviderRuntimeResult.Type;

export const ProviderRuntimePruneSkipReason = Schema.Literals([
  "active",
  "in_use",
  "not_found",
  "failed",
]);
export type ProviderRuntimePruneSkipReason = typeof ProviderRuntimePruneSkipReason.Type;

export const PruneProviderRuntimeVersionsInput = Schema.Struct({
  runtimeId: Schema.optionalKey(TrimmedNonEmptyString),
  version: Schema.optionalKey(TrimmedNonEmptyString),
});
export type PruneProviderRuntimeVersionsInput = typeof PruneProviderRuntimeVersionsInput.Type;

export const PruneProviderRuntimeVersionsResult = Schema.Struct({
  deleted: Schema.Array(
    Schema.Struct({
      runtimeId: Schema.String,
      version: Schema.String,
      sizeBytes: Schema.Number,
    }),
  ),
  reclaimedBytes: Schema.Number,
  skipped: Schema.Array(
    Schema.Struct({
      runtimeId: Schema.String,
      version: Schema.String,
      reason: ProviderRuntimePruneSkipReason,
    }),
  ),
  inventory: ProviderRuntimeInventory,
});
export type PruneProviderRuntimeVersionsResult = typeof PruneProviderRuntimeVersionsResult.Type;
