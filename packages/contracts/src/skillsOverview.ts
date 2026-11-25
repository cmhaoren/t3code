import * as Schema from "effect/Schema";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const SkillMatrixScope = Schema.Literals(["global", "builtin", "workspace"]);
export type SkillMatrixScope = typeof SkillMatrixScope.Type;

export const SkillMatrixCellStatus = Schema.Literals([
  "active",
  "disk_only",
  "missing",
  "not_applicable",
]);
export type SkillMatrixCellStatus = typeof SkillMatrixCellStatus.Type;

export const SkillMatrixInstance = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.String,
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  status: Schema.String,
  globalSkillDirs: Schema.Array(Schema.String),
});
export type SkillMatrixInstance = typeof SkillMatrixInstance.Type;

export const SkillMatrixCell = Schema.Struct({
  status: SkillMatrixCellStatus,
  path: Schema.optional(Schema.String),
  linkTarget: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
});
export type SkillMatrixCell = typeof SkillMatrixCell.Type;

export const SkillMatrixEntry = Schema.Struct({
  name: Schema.String,
  description: Schema.optional(Schema.String),
  scope: SkillMatrixScope,
  canonicalPath: Schema.optional(Schema.String),
  coveredEnabledCount: NonNegativeInt,
  totalEnabledCount: NonNegativeInt,
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
