import * as Schema from "effect/Schema";
import { IsoDateTime, ProjectId, TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

export const TeamCommanderMode = Schema.Literals(["grill", "autonomous"]);
export type TeamCommanderMode = typeof TeamCommanderMode.Type;

export const TeamPlannerMode = Schema.Literals(["auto", "commander", "single", "panel"]);
export type TeamPlannerMode = typeof TeamPlannerMode.Type;

export const TeamImplementerMode = Schema.Literals(["auto", "direct", "subagent"]);
export type TeamImplementerMode = typeof TeamImplementerMode.Type;

export const TeamIsolationMode = Schema.Literals(["auto", "shared", "worktree"]);
export type TeamIsolationMode = typeof TeamIsolationMode.Type;

export const TeamReviewerMode = Schema.Literals(["auto", "commander", "multi"]);
export type TeamReviewerMode = typeof TeamReviewerMode.Type;

export const TEAM_REVIEW_ANGLE_IDS = [
  "correctness",
  "blast-radius",
  "spec-alignment",
  "maintainability",
  "visual-ux",
  "security-data",
  "performance",
] as const;

export const TeamReviewAngleId = Schema.Literals(TEAM_REVIEW_ANGLE_IDS);
export type TeamReviewAngleId = typeof TeamReviewAngleId.Type;

export const TeamOrchestrationStage = Schema.Literals(["plan", "implement", "review"]);
export type TeamOrchestrationStage = typeof TeamOrchestrationStage.Type;

export const TeamEngineeringBaseline = Schema.Struct({
  tdd: Schema.Boolean,
  realEvidence: Schema.Boolean,
  separateReview: Schema.Boolean,
  maxReworkBeforeRethink: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 5 }),
  ),
});
export type TeamEngineeringBaseline = typeof TeamEngineeringBaseline.Type;

export const TeamPlannerConfig = Schema.Struct({
  mode: TeamPlannerMode,
  modelSelection: Schema.NullOr(ModelSelection),
  panelModels: Schema.Array(ModelSelection),
});
export type TeamPlannerConfig = typeof TeamPlannerConfig.Type;

export const TeamImplementerConfig = Schema.Struct({
  mode: TeamImplementerMode,
  isolation: TeamIsolationMode,
  routineModel: Schema.NullOr(ModelSelection),
  standardModel: Schema.NullOr(ModelSelection),
  complexModel: Schema.NullOr(ModelSelection),
});
export type TeamImplementerConfig = typeof TeamImplementerConfig.Type;

export const TeamReviewerConfig = Schema.Struct({
  mode: TeamReviewerMode,
  defaultModel: Schema.NullOr(ModelSelection),
  angles: Schema.Array(TeamReviewAngleId),
  angleModelOverrides: Schema.Record(Schema.String, ModelSelection),
});
export type TeamReviewerConfig = typeof TeamReviewerConfig.Type;

export const TeamOrchestrationConfig = Schema.Struct({
  version: Schema.Literal(1),
  enabled: Schema.Boolean,
  presetId: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  commanderMode: TeamCommanderMode,
  planner: TeamPlannerConfig,
  implementer: TeamImplementerConfig,
  reviewer: TeamReviewerConfig,
  baseline: TeamEngineeringBaseline,
  notes: Schema.optional(TrimmedString),
});
export type TeamOrchestrationConfig = typeof TeamOrchestrationConfig.Type;

export const TeamOrchestrationPreset = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedString),
  builtIn: Schema.optional(Schema.Boolean),
  config: TeamOrchestrationConfig,
});
export type TeamOrchestrationPreset = typeof TeamOrchestrationPreset.Type;

const TEAM_NORM_CARD_IDS = [
  "commander.grill",
  "commander.autonomous",
  "planner.commander",
  "planner.single",
  "planner.panel",
  "implementer.direct",
  "implementer.subagent",
  "reviewer.commander",
  "reviewer.multi",
  "review.correctness",
  "review.blast-radius",
  "review.spec-alignment",
  "review.maintainability",
  "review.visual-ux",
  "review.security-data",
  "review.performance",
  "baseline.tdd",
  "baseline.real-evidence",
  "baseline.separate-review",
  "baseline.rework-limit",
] as const;

export const TeamNormCardId = Schema.Literals(TEAM_NORM_CARD_IDS);
export type TeamNormCardId = typeof TeamNormCardId.Type;

export const TeamNormCardCategory = Schema.Literals([
  "commander",
  "planner",
  "implementer",
  "reviewer",
  "review-angle",
  "baseline",
]);
export type TeamNormCardCategory = typeof TeamNormCardCategory.Type;

export const TeamNormCardSource = Schema.Literals(["builtin", "user", "project"]);
export type TeamNormCardSource = typeof TeamNormCardSource.Type;

export const TeamNormCardScope = Schema.Literals(["user", "project"]);
export type TeamNormCardScope = typeof TeamNormCardScope.Type;

export const TeamNormCard = Schema.Struct({
  id: TeamNormCardId,
  category: TeamNormCardCategory,
  title: TrimmedNonEmptyString,
  description: TrimmedString,
  content: Schema.String,
  defaultContent: Schema.String,
  source: TeamNormCardSource,
  filePath: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type TeamNormCard = typeof TeamNormCard.Type;

export const OrchestrationCardsListInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type OrchestrationCardsListInput = typeof OrchestrationCardsListInput.Type;

export const OrchestrationCardsListResult = Schema.Struct({
  cards: Schema.Array(TeamNormCard),
  userCardsDir: TrimmedNonEmptyString,
  projectCardsDir: Schema.NullOr(TrimmedNonEmptyString),
});
export type OrchestrationCardsListResult = typeof OrchestrationCardsListResult.Type;

export const OrchestrationCardsSaveInput = Schema.Struct({
  cardId: TeamNormCardId,
  content: Schema.String,
  scope: Schema.optional(TeamNormCardScope),
  projectId: Schema.optional(ProjectId),
});
export type OrchestrationCardsSaveInput = typeof OrchestrationCardsSaveInput.Type;

export const OrchestrationCardsResetInput = Schema.Struct({
  cardId: TeamNormCardId,
  scope: Schema.optional(TeamNormCardScope),
  projectId: Schema.optional(ProjectId),
});
export type OrchestrationCardsResetInput = typeof OrchestrationCardsResetInput.Type;

export const OrchestrationCardsMutationResult = Schema.Struct({
  card: TeamNormCard,
});
export type OrchestrationCardsMutationResult = typeof OrchestrationCardsMutationResult.Type;

export class OrchestrationCardsError extends Schema.TaggedError<OrchestrationCardsError>()(
  "OrchestrationCardsError",
  {
    message: Schema.String,
  },
) {}
