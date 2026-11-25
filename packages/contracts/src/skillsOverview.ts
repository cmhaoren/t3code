import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const SkillMatrixScope = Schema.Literals(["universal", "agent_global", "builtin"]);
export type SkillMatrixScope = typeof SkillMatrixScope.Type;

export const SkillMatrixCellStatus = Schema.Literals([
  "declared_runtime",
  "declared_disk",
  "disk_warning",
  "missing",
  "not_applicable",
]);
export type SkillMatrixCellStatus = typeof SkillMatrixCellStatus.Type;

export const SkillMatrixInstance = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  driverGroupKey: Schema.String,
  driverGroupLabel: Schema.String,
  displayName: Schema.String,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  status: Schema.String,
  readsUniversalPool: Schema.Boolean,
  globalSkillDirs: Schema.Array(Schema.String),
  writableGlobalSkillDir: Schema.optional(Schema.String),
});
export type SkillMatrixInstance = typeof SkillMatrixInstance.Type;

export const SkillMatrixCell = Schema.Struct({
  status: SkillMatrixCellStatus,
  path: Schema.optional(Schema.String),
  linkTarget: Schema.optional(Schema.String),
  sourceDir: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
export type SkillMatrixCell = typeof SkillMatrixCell.Type;

export const SkillMatrixEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  scope: SkillMatrixScope,
  ownerGroupLabels: Schema.Array(Schema.String),
  canonicalPath: Schema.optional(Schema.String),
  coveredEnabledCount: NonNegativeInt,
  expectedEnabledCount: NonNegativeInt,
  cells: Schema.Record(Schema.String, SkillMatrixCell),
});
export type SkillMatrixEntry = typeof SkillMatrixEntry.Type;

export const SkillMatrixDiagnostic = Schema.Struct({
  severity: Schema.Literals(["warning", "info"]),
  code: Schema.String,
  message: Schema.String,
  detail: Schema.optional(Schema.String),
});
export type SkillMatrixDiagnostic = typeof SkillMatrixDiagnostic.Type;

export const ServerGetSkillsOverviewInput = Schema.Struct({
  cwd: Schema.optional(TrimmedNonEmptyString),
});
export type ServerGetSkillsOverviewInput = typeof ServerGetSkillsOverviewInput.Type;

export const ServerGetSkillsOverviewResult = Schema.Struct({
  checkedAt: IsoDateTime,
  universalPoolDir: Schema.String,
  instances: Schema.Array(SkillMatrixInstance),
  skills: Schema.Array(SkillMatrixEntry),
  diagnostics: Schema.Array(SkillMatrixDiagnostic),
});
export type ServerGetSkillsOverviewResult = typeof ServerGetSkillsOverviewResult.Type;

export class SkillsOverviewError extends Schema.TaggedError<SkillsOverviewError>()(
  "SkillsOverviewError",
  {
    message: Schema.String,
  },
) {}
