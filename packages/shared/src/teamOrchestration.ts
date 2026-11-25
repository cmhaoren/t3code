import type {
  ModelSelection,
  TeamCommanderMode,
  TeamEngineeringBaseline,
  TeamImplementerMode,
  TeamIsolationMode,
  TeamNormCard,
  TeamNormCardCategory,
  TeamNormCardId,
  TeamOrchestrationConfig,
  TeamOrchestrationPreset,
  TeamOrchestrationStage,
  TeamPlannerMode,
  TeamReviewAngleId,
  TeamReviewerMode,
} from "@t3tools/contracts";
import { TEAM_REVIEW_ANGLE_IDS } from "@t3tools/contracts";

export interface TeamNormCardDefinition {
  readonly id: TeamNormCardId;
  readonly category: TeamNormCardCategory;
  readonly title: string;
  readonly description: string;
  readonly defaultContent: string;
}

export interface TeamReviewAngleMeta {
  readonly id: TeamReviewAngleId;
  readonly cardId: TeamNormCardId;
  readonly label: string;
  readonly shortLabel: string;
  readonly description: string;
}

export const TEAM_REVIEW_ANGLE_META: ReadonlyArray<TeamReviewAngleMeta> = [
  {
    id: "correctness",
    cardId: "review.correctness",
    label: "正确性与对抗复现",
    shortLabel: "正确性",
    description: "边界条件、竞态、状态覆写、异常处理与可复现缺陷",
  },
  {
    id: "blast-radius",
    cardId: "review.blast-radius",
    label: "影响范围与回归风险",
    shortLabel: "影响范围",
    description: "调用方、跨包契约、持久化兼容、默认值与潜在回归面",
  },
  {
    id: "spec-alignment",
    cardId: "review.spec-alignment",
    label: "需求与方案一致性",
    shortLabel: "需求一致",
    description: "逐条核对需求目标、边界约定、漏项与范围漂移",
  },
  {
    id: "maintainability",
    cardId: "review.maintainability",
    label: "规范与可维护性",
    shortLabel: "规范架构",
    description: "模块边界、类型安全、代码库惯例、重复逻辑与可维护度",
  },
  {
    id: "visual-ux",
    cardId: "review.visual-ux",
    label: "视觉与交互验收",
    shortLabel: "视觉交互",
    description: "信息层级、状态反馈、空态/错态、窄屏与明暗主题表现",
  },
  {
    id: "security-data",
    cardId: "review.security-data",
    label: "数据与安全",
    shortLabel: "安全数据",
    description: "权限校验、输入边界、路径安全、密钥保护与数据一致性",
  },
  {
    id: "performance",
    cardId: "review.performance",
    label: "性能基线",
    shortLabel: "性能",
    description: "热路径开销、N+1、内存/监听泄漏与渲染抖动",
  },
];

const TEAM_REVIEW_ANGLE_BY_ID: Readonly<Record<TeamReviewAngleId, TeamReviewAngleMeta>> =
  Object.fromEntries(TEAM_REVIEW_ANGLE_META.map((item) => [item.id, item])) as Record<
    TeamReviewAngleId,
    TeamReviewAngleMeta
  >;

export const BUILTIN_TEAM_NORM_CARDS: ReadonlyArray<TeamNormCardDefinition> = [
  {
    id: "commander.grill",
    category: "commander",
    title: "指挥官 · Grill 对齐",
    description: "开工前先通过精准追问消解歧义，未对齐前不动源码",
    defaultContent: [
      "- 开工前先逐一排查需求、架构边界、异常路径与取舍，直到对目标与验收口径达成共识。",
      "- 能通过读源码/配置/历史记录直接回答的问题，先自己查证，不要反问用户。",
      "- 提问要短而聚焦，每次聚焦关键决策并给出推荐选项与理由。",
      "- 在关键假设尚未对齐前，禁止直接修改项目源码。",
    ].join("\n"),
  },
  {
    id: "commander.autonomous",
    category: "commander",
    title: "指挥官 · 高自主推进",
    description: "先查一手代码自主决策推进，仅在真正阻塞或高风险处中断",
    defaultContent: [
      "- 优先读一手源码做出合理工程判断并持续推进，不因细枝末节反复打断用户。",
      "- 仅在存在不可逆破坏、外部依赖缺失、凭证/权限阻塞或关键产品歧义时向用户确认。",
      "- 对设为「自动」的下游阶段（方案/执行/审核），按任务复杂度和风险自主决定最合适模式与分工。",
    ].join("\n"),
  },
  {
    id: "planner.commander",
    category: "planner",
    title: "方案官 · 指挥官自规划",
    description: "主会话基于一手源码直接产出精炼可执行方案",
    defaultContent: [
      "- 规划前先定位真实代码接缝、公共契约与现有模式，避免拍脑袋设计。",
      "- 输出聚焦的实施清单：模块边界、关键数据结构/接口、边界条件与客观验证方式。",
    ].join("\n"),
  },
  {
    id: "planner.single",
    category: "planner",
    title: "方案官 · 单代理规划",
    description: "委派指定规划模型独立产出方案，由指挥官核对一手代码定稿",
    defaultContent: [
      '- 使用 `delegate_task`（传 `orchestrationStage: "plan"`、`role: "design"`）委派指定规划模型做只读调研并输出方案。',
      "- 要求规划子代理基于真实文件路径和现有契约写清：架构取舍、接口改动、风险与验收清单。",
      "- 规划返回后，指挥官必须抽核关键源码接缝再定稿，不盲从二手摘要。",
    ].join("\n"),
  },
  {
    id: "planner.panel",
    category: "planner",
    title: "方案官 · 多模型比稿（Arena）",
    description: "多模型并行独立出稿，指挥官按统一维度评分并嫁接最优片段",
    defaultContent: [
      "- 先写下本次方案的评估维度与约束（如可维护性、改造成本、边界完备度、风险）。",
      '- 并行调用 `delegate_task`（传 `orchestrationStage: "plan"`、`role: "design"`），给每个候选模型下发相同的一手背景，让其独立只读出稿、互不可见。',
      "- 收齐全部方案后，指挥官按维度逐项比较，执行「嫁接整合」（吸取各方案最优片段而非机械二选一），向用户简述最终合并方案及关键取舍。",
    ].join("\n"),
  },
  {
    id: "implementer.direct",
    category: "implementer",
    title: "执行官 · 直接实现",
    description: "主会话直接编写与验证代码，保持改动聚焦",
    defaultContent: [
      "- 主会话直接实现改动，优先按小步增量推进并随时做类型/单测校验。",
      "- 保持改动严格落在约定范围内，不顺带做无关重构。",
    ].join("\n"),
  },
  {
    id: "implementer.subagent",
    category: "implementer",
    title: "执行官 · 子代理实现",
    description: "指挥官拆解任务并按复杂度委派子代理，严格控白名单与亲自复核",
    defaultContent: [
      "- 委派前先解耦任务，单次委派尽量控制在 ≤10 个文件、单一清晰阶段。",
      '- 调用 `delegate_task` 时传 `orchestrationStage: "implement"`、`role: "implementation"`，并在任务书明确：可写文件白名单、关键公式/跨包导出口径、必跑验收命令，以及要求在最后一条回复自包含列出改动文件与实跑结果。',
      '- 并行委派多个执行子代理时，若采用共享目录（`isolation: "shared"`）必须确保白名单互不重叠；若存在文件交叉、分支隔离或独立构建风险，使用 `isolation: "worktree"`。',
      "- 子代理完成后，指挥官必须亲自复核 git diff、跨字段口径与关键测试，不只听子代理口头汇报。",
    ].join("\n"),
  },
  {
    id: "reviewer.commander",
    category: "reviewer",
    title: "审核官 · 指挥官审核",
    description: "主会话切入独立审视视角通读最终 diff 并核对证据",
    defaultContent: [
      "- 落地完成后切入独立审视者视角，完整通读 `git diff` 与新增测试。",
      "- 对照原始需求、边界条件与回归面逐项核验，发现问题直接修复并重跑验证。",
    ].join("\n"),
  },
  {
    id: "reviewer.multi",
    category: "reviewer",
    title: "审核官 · 多维并行审核",
    description: "按勾选维度并行派发干净上下文的只读审核子代理，分级汇总后裁决",
    defaultContent: [
      '- 对每个启用的审核维度，并行调用 `delegate_task`（传 `orchestrationStage: "review"`、`reviewAngle: "<维度id>"`、`role: "review"`），每个子代理拥有干净独立上下文且只读不改码。',
      "- 任务书只需提供变更范围（branch/diff 命令或文件清单）、原始需求摘要与验证现状，不要把主会话里的辩护推理灌给审核者。",
      "- 要求审核子代理按 P0（阻断）/ P1（高危）/ P2（建议）分级，每条必带文件路径、行号与可复现依据，禁止凑数式吹毛求疵。",
      "- 收齐结果后由指挥官统一裁决：验证每条问题是否成立，小问题主会话直接修，修后重跑验证；有争议的 P0/P1 向用户同步。",
    ].join("\n"),
  },
  {
    id: "review.correctness",
    category: "review-angle",
    title: "审核维度 · 正确性与对抗复现",
    description: "专注边界条件、竞态、状态覆写、错误处理与真实缺陷",
    defaultContent: [
      "- 重点排查边界条件、空值/未初始化态、竞态、重入、重试/中断后的状态覆写与错误吞没。",
      "- 尝试构造对抗输入或失败路径，只报告你能通过代码路径或测试推演证明的高置信度问题。",
    ].join("\n"),
  },
  {
    id: "review.blast-radius",
    category: "review-angle",
    title: "审核维度 · 影响范围与回归风险",
    description: "排查所有调用方、公共契约、持久化兼容与静默行为变化",
    defaultContent: [
      "- 追踪本次改动的全部上游调用方、下游消费者、跨包导出与公共类型/RPC 契约。",
      "- 检查旧数据/旧配置文件/旧客户端反序列化兼容性、默认值变化、关闭开关后的退化路径以及可能被误伤的邻近功能。",
    ].join("\n"),
  },
  {
    id: "review.spec-alignment",
    category: "review-angle",
    title: "审核维度 · 需求与方案一致性",
    description: "逐条对照用户目标、约定口径与边界，查漏项与范围漂移",
    defaultContent: [
      "- 逐条对照用户需求与既定方案，确认没有遗漏核心交互、配置联动或边界约定。",
      "- 检查是否存在静默降级、口径不一致或未经要求的过度设计/越界修改。",
    ].join("\n"),
  },
  {
    id: "review.maintainability",
    category: "review-angle",
    title: "审核维度 · 规范与可维护性",
    description: "检查模块边界、类型安全、代码库惯例与死代码",
    defaultContent: [
      "- 检查模块职责拆分、跨包导入规范（遵循 package exports，避免脆弱相对路径）、类型严密性与错误处理风格。",
      "- 指出明显重复逻辑、未清理的死代码/无用导出或违背当前仓库惯例的实现。",
    ].join("\n"),
  },
  {
    id: "review.visual-ux",
    category: "review-angle",
    title: "审核维度 · 视觉与交互验收",
    description: "检查 UI 信息层级、状态反馈、空态/错态与主题适配",
    defaultContent: [
      "- 检查主次层级、文案清晰度、交互状态（加载/空态/禁用/错误/已保存）、溢出截断与窄屏/明暗主题适配。",
      "- 检查表单/弹窗的可访问性（焦点、键盘关闭、清晰标签）与无多余视觉噪音。",
    ].join("\n"),
  },
  {
    id: "review.security-data",
    category: "review-angle",
    title: "审核维度 · 数据与安全",
    description: "检查权限边界、输入校验、路径安全、密钥保护与持久化一致性",
    defaultContent: [
      "- 检查权限/作用域校验、路径穿越与注入风险、敏感信息是否可能泄漏到日志/提示词/前端。",
      "- 检查文件写入原子性、并发更新覆盖与非法输入时的容错行为。",
    ].join("\n"),
  },
  {
    id: "review.performance",
    category: "review-angle",
    title: "审核维度 · 性能基线",
    description: "检查热路径开销、重复渲染、内存/订阅泄漏与无界增长",
    defaultContent: [
      "- 检查渲染热路径中的无谓重算/重渲染、事件与订阅清理、I/O 阻塞、N+1 请求以及缓存/状态无界增长。",
      "- 关注对启动耗时、提示词 Token 开销与构建产物体积的额外负担。",
    ].join("\n"),
  },
  {
    id: "baseline.tdd",
    category: "baseline",
    title: "工程底线 · TDD 测试驱动",
    description: "所有新行为与缺陷修复默认采用红→绿→重构节奏",
    defaultContent: [
      "- 所有代码落地默认遵循 TDD：先写能刻画目标行为或复现缺陷的最小失败测试（红），再写刚好通过的实现（绿），绿灯后按需重构。",
      "- 若遇纯 UI 布局或极难单测的环境边界，至少为其中的纯逻辑/状态变换补齐单测，并用真实运行校验兜底。",
    ].join("\n"),
  },
  {
    id: "baseline.real-evidence",
    category: "baseline",
    title: "工程底线 · 实跑证据交付",
    description: "交付结论必须基于本轮真实命令与测试结果，禁止臆测",
    defaultContent: [
      "- 交付前必须真实运行相关单测、类型检查、lint 或构建命令，并以实际输出结果作为验收依据。",
      "- 禁止在未重新实跑的情况下沿用旧结果或宣称“应该能过”；若有未覆盖项须如实说明。",
    ].join("\n"),
  },
  {
    id: "baseline.separate-review",
    category: "baseline",
    title: "工程底线 · 写审分离",
    description: "编写者不直接给自己的改动盖章终审，修复后复验",
    defaultContent: [
      "- 编写实现与最终审核保持职责分离：主会话编写则优先委派独立审核子代理，子代理编写则由主会话或独立审核代理核对 diff 与测试。",
      "- 审核发现的问题修复后，必须对受影响面重新执行验证。",
    ].join("\n"),
  },
  {
    id: "baseline.rework-limit",
    category: "baseline",
    title: "工程底线 · 返工止损",
    description: "同一问题连续返工超限时停下重审前提，避免死循环打补丁",
    defaultContent: [
      "- 同一问题连续返工达到上限仍未通过验收时，立即停止继续堆补丁。",
      "- 重新审视问题定义、底层假设、模块边界或拆分粒度，向用户汇报卡点与备选路径后再继续。",
    ].join("\n"),
  },
];

export const BUILTIN_TEAM_NORM_CARD_MAP: Readonly<Record<TeamNormCardId, TeamNormCardDefinition>> =
  Object.fromEntries(BUILTIN_TEAM_NORM_CARDS.map((card) => [card.id, card])) as Record<
    TeamNormCardId,
    TeamNormCardDefinition
  >;

const DEFAULT_TEAM_ENGINEERING_BASELINE: TeamEngineeringBaseline = {
  tdd: true,
  realEvidence: true,
  separateReview: true,
  maxReworkBeforeRethink: 2,
};

const DEFAULT_TEAM_REVIEW_ANGLES: ReadonlyArray<TeamReviewAngleId> = [
  "correctness",
  "blast-radius",
  "spec-alignment",
  "maintainability",
];

export function createDefaultTeamOrchestrationConfig(): TeamOrchestrationConfig {
  return {
    version: 1,
    enabled: false,
    presetId: null,
    commanderMode: "grill",
    planner: {
      mode: "commander",
      modelSelection: null,
      panelModels: [],
    },
    implementer: {
      mode: "subagent",
      isolation: "shared",
      routineModel: null,
      standardModel: null,
      complexModel: null,
    },
    reviewer: {
      mode: "multi",
      defaultModel: null,
      angles: [...DEFAULT_TEAM_REVIEW_ANGLES],
      angleModelOverrides: {},
    },
    baseline: { ...DEFAULT_TEAM_ENGINEERING_BASELINE },
    notes: "",
  };
}

export function getBuiltInTeamOrchestrationPresets(): ReadonlyArray<TeamOrchestrationPreset> {
  return [
    {
      id: "builtin-deep-craft",
      name: "深度攻坚",
      description: "Grill 对齐 + 子代理执行 + 多维并行审核（默认开启 TDD 与影响范围审核）",
      builtIn: true,
      config: {
        version: 1,
        enabled: true,
        presetId: "builtin-deep-craft",
        commanderMode: "grill",
        planner: {
          mode: "commander",
          modelSelection: null,
          panelModels: [],
        },
        implementer: {
          mode: "subagent",
          isolation: "shared",
          routineModel: null,
          standardModel: null,
          complexModel: null,
        },
        reviewer: {
          mode: "multi",
          defaultModel: null,
          angles: ["correctness", "blast-radius", "spec-alignment", "maintainability"],
          angleModelOverrides: {},
        },
        baseline: { ...DEFAULT_TEAM_ENGINEERING_BASELINE },
        notes: "",
      },
    },
    {
      id: "builtin-autonomous-fast",
      name: "高自主快推",
      description: "指挥官高自主推进，方案/执行/审核默认由指挥官按复杂度自决（可单环节锁定）",
      builtIn: true,
      config: {
        version: 1,
        enabled: true,
        presetId: "builtin-autonomous-fast",
        commanderMode: "autonomous",
        planner: {
          mode: "auto",
          modelSelection: null,
          panelModels: [],
        },
        implementer: {
          mode: "auto",
          isolation: "auto",
          routineModel: null,
          standardModel: null,
          complexModel: null,
        },
        reviewer: {
          mode: "auto",
          defaultModel: null,
          angles: ["correctness", "blast-radius"],
          angleModelOverrides: {},
        },
        baseline: { ...DEFAULT_TEAM_ENGINEERING_BASELINE },
        notes: "",
      },
    },
  ];
}

export function createDefaultTeamNormCards(): ReadonlyArray<TeamNormCard> {
  return BUILTIN_TEAM_NORM_CARDS.map((card) => ({
    id: card.id,
    category: card.category,
    title: card.title,
    description: card.description,
    content: card.defaultContent,
    defaultContent: card.defaultContent,
    source: "builtin" as const,
    filePath: null,
    updatedAt: null,
  }));
}

export function applyCommanderModeDefaults(
  config: TeamOrchestrationConfig,
  nextCommanderMode: TeamCommanderMode,
): TeamOrchestrationConfig {
  if (nextCommanderMode === config.commanderMode) {
    return config;
  }
  if (nextCommanderMode === "autonomous") {
    return {
      ...config,
      commanderMode: "autonomous",
      planner: { ...config.planner, mode: "auto" },
      implementer: { ...config.implementer, mode: "auto", isolation: "auto" },
      reviewer: { ...config.reviewer, mode: "auto" },
    };
  }
  return {
    ...config,
    commanderMode: "grill",
    planner: {
      ...config.planner,
      mode: config.planner.mode === "auto" ? "commander" : config.planner.mode,
    },
    implementer: {
      ...config.implementer,
      mode: config.implementer.mode === "auto" ? "subagent" : config.implementer.mode,
      isolation: config.implementer.isolation === "auto" ? "shared" : config.implementer.isolation,
    },
    reviewer: {
      ...config.reviewer,
      mode: config.reviewer.mode === "auto" ? "multi" : config.reviewer.mode,
    },
  };
}

export function normalizeTeamOrchestrationConfig(
  config: TeamOrchestrationConfig,
): TeamOrchestrationConfig {
  const validAngleSet = new Set<string>(TEAM_REVIEW_ANGLE_IDS);
  const dedupedAngles: Array<TeamReviewAngleId> = [];
  for (const angle of config.reviewer.angles) {
    if (validAngleSet.has(angle) && !dedupedAngles.includes(angle)) {
      dedupedAngles.push(angle);
    }
  }
  const normalizedOverrides: Record<string, ModelSelection> = {};
  for (const [angle, selection] of Object.entries(config.reviewer.angleModelOverrides)) {
    if (validAngleSet.has(angle)) {
      normalizedOverrides[angle] = selection;
    }
  }
  return {
    ...config,
    version: 1,
    presetId: config.presetId ?? null,
    reviewer: {
      ...config.reviewer,
      angles: dedupedAngles,
      angleModelOverrides: normalizedOverrides,
    },
    notes: config.notes?.trim() ?? "",
  };
}

function formatModelSelectionForPrompt(
  selection: ModelSelection | null | undefined,
  providerLabelByInstanceId?: ReadonlyMap<string, string>,
): string {
  if (!selection) {
    return "继承主会话模型";
  }
  const providerLabel = providerLabelByInstanceId?.get(selection.instanceId);
  const instancePart =
    providerLabel && providerLabel !== selection.instanceId
      ? `${providerLabel} (providerInstanceId: ${JSON.stringify(selection.instanceId)})`
      : `providerInstanceId: ${JSON.stringify(selection.instanceId)}`;
  const optionsPart =
    selection.options && selection.options.length > 0
      ? `, options: ${JSON.stringify(
          Object.fromEntries(selection.options.map((opt) => [opt.id, opt.value])),
        )}`
      : "";
  return `${instancePart}, model: ${JSON.stringify(selection.model)}${optionsPart}`;
}

export function inferTeamOrchestrationStageFromRole(
  role: string | null | undefined,
): TeamOrchestrationStage | undefined {
  switch (role) {
    case "implementation":
    case "test":
      return "implement";
    case "review":
      return "review";
    case "design":
      return "plan";
    default:
      return undefined;
  }
}

export function collectTeamOrchestrationModelSelections(
  config: TeamOrchestrationConfig | null | undefined,
): ReadonlyArray<ModelSelection> {
  if (!config || !config.enabled) {
    return [];
  }
  const selections: Array<ModelSelection> = [];
  const push = (selection: ModelSelection | null | undefined) => {
    if (selection) {
      selections.push(selection);
    }
  };
  push(config.planner.modelSelection);
  for (const selection of config.planner.panelModels) {
    push(selection);
  }
  push(config.implementer.routineModel);
  push(config.implementer.standardModel);
  push(config.implementer.complexModel);
  push(config.reviewer.defaultModel);
  for (const selection of Object.values(config.reviewer.angleModelOverrides)) {
    push(selection);
  }
  return selections;
}

function getCardBody(cardId: TeamNormCardId, cardMap: ReadonlyMap<TeamNormCardId, string>): string {
  const value = cardMap.get(cardId)?.trim();
  if (value && value.length > 0) {
    return value;
  }
  return BUILTIN_TEAM_NORM_CARD_MAP[cardId].defaultContent;
}

function buildCardContentMap(
  cards?: ReadonlyArray<Pick<TeamNormCard, "id" | "content">>,
): ReadonlyMap<TeamNormCardId, string> {
  const map = new Map<TeamNormCardId, string>();
  for (const def of BUILTIN_TEAM_NORM_CARDS) {
    map.set(def.id, def.defaultContent);
  }
  if (cards) {
    for (const card of cards) {
      map.set(card.id, card.content);
    }
  }
  return map;
}

const PLANNER_MODE_LABELS: Readonly<Record<TeamPlannerMode, string>> = {
  auto: "自动（指挥官自决）",
  commander: "指挥官自规划",
  single: "单代理规划",
  panel: "多模型出稿 · 指挥官整合（Arena）",
};

const IMPLEMENTER_MODE_LABELS: Readonly<Record<TeamImplementerMode, string>> = {
  auto: "自动（指挥官自决）",
  direct: "主会话直接实现",
  subagent: "子代理实现",
};

const ISOLATION_MODE_LABELS: Readonly<Record<TeamIsolationMode, string>> = {
  auto: "自动（指挥官按并行冲突风险选择 shared 或 worktree）",
  shared: '共享目录（isolation: "shared"，同目录协作，必须给互不重叠的文件白名单）',
  worktree: '独立 Worktree（isolation: "worktree"，独立分支副本）',
};

const REVIEWER_MODE_LABELS: Readonly<Record<TeamReviewerMode, string>> = {
  auto: "自动（指挥官自决）",
  commander: "指挥官审核",
  multi: "多维并行只读审核",
};

export interface CompileTeamOrchestrationInput {
  readonly config: TeamOrchestrationConfig;
  readonly cards?: ReadonlyArray<Pick<TeamNormCard, "id" | "content">>;
  readonly providerLabelByInstanceId?: ReadonlyMap<string, string>;
}

export function compileTeamOrchestrationInstructions(
  input: CompileTeamOrchestrationInput,
): string | null {
  const config = normalizeTeamOrchestrationConfig(input.config);
  if (!config.enabled) {
    return null;
  }
  const cardMap = buildCardContentMap(input.cards);
  const labels = input.providerLabelByInstanceId;
  const sections: Array<string> = [
    "<t3_code_team_orchestration>",
    "本会话已开启团队编排配置。你（主会话）担任【指挥官】，请严格按以下阶段顺序、模型绑定与规范卡片推进；需要委派子代理时使用 `delegate_task` 并传入对应的 `target`、`isolation`、`orchestrationStage`（及 `reviewAngle`）。",
    "【抗压缩保留】若会话中途触发上下文压缩/摘要，必须在摘要中完整保留本段团队编排的阶段模式、各档位模型绑定（`providerInstanceId`/`model`/`options`）与工程底线；如在长任务中遗忘或不确定配置，随时调用 `orchestrator_capabilities` 即可从返回值的 `teamOrchestration` 字段重新读取完整编排指令。",
  ];

  // Stage 1: Commander
  const commanderCardId: TeamNormCardId =
    config.commanderMode === "grill" ? "commander.grill" : "commander.autonomous";
  sections.push(
    "",
    `## 1. 指挥官模式：${config.commanderMode === "grill" ? "Grill 对齐模式" : "高自主模式"}`,
    getCardBody(commanderCardId, cardMap),
  );

  // Stage 2: Planner
  sections.push("", `## 2. 方案官模式：${PLANNER_MODE_LABELS[config.planner.mode]}`);
  if (config.planner.mode === "auto") {
    sections.push(
      "- 由你按任务复杂度决定：简单任务直接自规划；复杂/高分歧任务可单代理或多模型比稿。",
    );
    if (config.planner.modelSelection) {
      sections.push(
        `- 若委派单代理规划，优先使用：${formatModelSelectionForPrompt(config.planner.modelSelection, labels)}`,
      );
    }
    if (config.planner.panelModels.length >= 2) {
      sections.push("- 若启用多模型比稿，候选模型池：");
      config.planner.panelModels.forEach((selection, index) => {
        sections.push(
          `  - 方案模型 ${index + 1}：${formatModelSelectionForPrompt(selection, labels)}`,
        );
      });
    }
  } else if (config.planner.mode === "commander") {
    sections.push(getCardBody("planner.commander", cardMap));
  } else if (config.planner.mode === "single") {
    sections.push(
      `- 绑定规划模型：${formatModelSelectionForPrompt(config.planner.modelSelection, labels)}`,
      getCardBody("planner.single", cardMap),
    );
  } else {
    if (config.planner.panelModels.length > 0) {
      sections.push("- 绑定比稿模型（并行独立出稿）：");
      config.planner.panelModels.forEach((selection, index) => {
        sections.push(
          `  - 方案模型 ${index + 1}：${formatModelSelectionForPrompt(selection, labels)}`,
        );
      });
    } else {
      sections.push(
        "- 尚未指定比稿模型：请先用 `orchestrator_capabilities` 选择至少 2 个不同模型并行出稿，或与用户确认。",
      );
    }
    sections.push(getCardBody("planner.panel", cardMap));
  }

  // Stage 3: Implementer
  sections.push("", `## 3. 执行官模式：${IMPLEMENTER_MODE_LABELS[config.implementer.mode]}`);
  if (config.implementer.mode === "direct") {
    sections.push(getCardBody("implementer.direct", cardMap));
  } else {
    sections.push(`- 工作区隔离策略：${ISOLATION_MODE_LABELS[config.implementer.isolation]}`);
    const tierLines: Array<string> = [];
    if (config.implementer.routineModel) {
      tierLines.push(
        `  - 常规/机械任务（routine）：${formatModelSelectionForPrompt(config.implementer.routineModel, labels)}`,
      );
    }
    if (config.implementer.standardModel) {
      tierLines.push(
        `  - 核心功能任务（standard）：${formatModelSelectionForPrompt(config.implementer.standardModel, labels)}`,
      );
    }
    if (config.implementer.complexModel) {
      tierLines.push(
        `  - 复杂攻坚任务（complex）：${formatModelSelectionForPrompt(config.implementer.complexModel, labels)}`,
      );
    }
    if (tierLines.length > 0) {
      sections.push(
        "- 按复杂度路由子代理模型（未配置档位回退相邻档位或主会话模型）：",
        ...tierLines,
      );
    } else {
      sections.push("- 未单独绑定执行子代理模型：按需继承主会话模型或依据能力列表合理选择。");
    }
    if (config.implementer.mode === "auto") {
      sections.push("- 由你按任务体量决定直接实现还是委派子代理；一旦委派子代理，请遵守以下规范：");
    }
    sections.push(getCardBody("implementer.subagent", cardMap));
  }

  // Stage 4: Reviewer
  sections.push("", `## 4. 审核官模式：${REVIEWER_MODE_LABELS[config.reviewer.mode]}`);
  const activeAngles =
    config.reviewer.angles.length > 0 ? config.reviewer.angles : DEFAULT_TEAM_REVIEW_ANGLES;
  if (config.reviewer.mode === "commander") {
    sections.push(getCardBody("reviewer.commander", cardMap));
  } else {
    sections.push(
      `- 默认审核模型：${formatModelSelectionForPrompt(config.reviewer.defaultModel, labels)}`,
    );
    if (config.reviewer.mode === "auto") {
      sections.push(
        "- 由你按风险等级决定由指挥官自审还是多维并行审核；涉及多文件、公共契约或高风险改动时优先启动多维并行审核。",
      );
    }
    sections.push(getCardBody("reviewer.multi", cardMap));
    sections.push("- 启用审核维度：");
    for (const angleId of activeAngles) {
      const meta = TEAM_REVIEW_ANGLE_BY_ID[angleId];
      const override = config.reviewer.angleModelOverrides[angleId];
      const modelNote = override
        ? ` | 指定模型：${formatModelSelectionForPrompt(override, labels)}`
        : "";
      sections.push(`  - \`${angleId}\`（${meta.label}）${modelNote}`);
    }
  }

  // Global Baseline
  const baselineLines: Array<string> = [];
  if (config.baseline.tdd) {
    baselineLines.push("### TDD 测试驱动", getCardBody("baseline.tdd", cardMap));
  }
  if (config.baseline.realEvidence) {
    baselineLines.push("### 实跑证据交付", getCardBody("baseline.real-evidence", cardMap));
  }
  if (config.baseline.separateReview) {
    baselineLines.push("### 写审分离", getCardBody("baseline.separate-review", cardMap));
  }
  baselineLines.push(
    `### 返工止损（上限：${config.baseline.maxReworkBeforeRethink} 次）`,
    getCardBody("baseline.rework-limit", cardMap),
  );
  sections.push("", "## 5. 全局工程底线（跨模式生效）", ...baselineLines);

  if (config.notes && config.notes.length > 0) {
    sections.push("", "## 6. 本会话补充约束", config.notes);
  }

  sections.push("</t3_code_team_orchestration>");
  return sections.join("\n");
}

export function compileTeamOrchestrationDeactivatedNotice(): string {
  return [
    "<t3_code_team_orchestration_status>",
    "用户已关闭本会话的团队编排模式。后续回复不再强制执行此前注入的 `<t3_code_team_orchestration>` 流程，请按常规会话方式响应。",
    "</t3_code_team_orchestration_status>",
  ].join("\n");
}

export interface CompileSubagentNormCardInput {
  readonly stage?: TeamOrchestrationStage;
  readonly reviewAngle?: TeamReviewAngleId;
  readonly config?: TeamOrchestrationConfig | null;
  readonly cards?: ReadonlyArray<Pick<TeamNormCard, "id" | "content">>;
}

export function compileSubagentNormCardPrefix(input: CompileSubagentNormCardInput): string | null {
  const effectiveStage = input.stage ?? (input.reviewAngle ? "review" : undefined);
  if (!effectiveStage) {
    return null;
  }
  const cardMap = buildCardContentMap(input.cards);
  const baseline = input.config?.baseline ?? DEFAULT_TEAM_ENGINEERING_BASELINE;
  const lines: Array<string> = ["<t3_code_subagent_role_norm>"];

  if (effectiveStage === "plan") {
    lines.push(
      "角色：方案规划子代理（只读调研，禁止修改源码）。",
      "- 基于真实源码路径、现有契约和约束产出精炼可执行方案，明确边界、风险与验证方式。",
      "- 仅依赖一手代码事实，不要臆测未读取文件的实现。",
    );
  } else if (effectiveStage === "implement") {
    lines.push("角色：执行子代理。");
    if (baseline.tdd) {
      lines.push(getCardBody("baseline.tdd", cardMap));
    }
    if (baseline.realEvidence) {
      lines.push(getCardBody("baseline.real-evidence", cardMap));
    }
    lines.push(
      "- 严格遵守任务书给出的可写文件白名单；发现白名单外必须修改的文件时先停下回报指挥官。",
      "- 最后一条回复必须自包含：列出实际改动文件清单、关键实现要点与实跑命令/测试结果。",
    );
  } else if (effectiveStage === "review") {
    const angleMeta = input.reviewAngle ? TEAM_REVIEW_ANGLE_BY_ID[input.reviewAngle] : undefined;
    lines.push(
      angleMeta
        ? `角色：独立只读审核子代理（维度：${angleMeta.label} / \`${angleMeta.id}\`）。`
        : "角色：独立只读审核子代理。",
      "- 只读审查，禁止修改项目源码。",
    );
    if (angleMeta) {
      lines.push(getCardBody(angleMeta.cardId, cardMap));
    }
    lines.push(
      "- 输出按 P0（阻断）/ P1（高危）/ P2（建议）分级，每条包含文件路径、行号、原因与可验证依据；若无高置信度问题请明确说明「无阻断问题」。",
    );
  }

  lines.push("</t3_code_subagent_role_norm>");
  return lines.join("\n");
}

/** Deterministic FNV-1a 64-bit hex fingerprint for delta prompt injection. */
export function computeTeamOrchestrationFingerprint(compiledPrompt: string | null): string | null {
  if (compiledPrompt === null) {
    return null;
  }
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < compiledPrompt.length; i += 1) {
    hash ^= BigInt(compiledPrompt.charCodeAt(i));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}

export function summarizeTeamOrchestrationBadge(
  config: TeamOrchestrationConfig | null | undefined,
): string | null {
  if (!config || !config.enabled) {
    return null;
  }
  if (config.commanderMode === "autonomous") {
    const overrides: Array<string> = [];
    if (config.planner.mode === "panel") overrides.push("比稿");
    else if (config.planner.mode === "single") overrides.push("单规");
    if (config.implementer.mode === "subagent") overrides.push("子代理");
    else if (config.implementer.mode === "direct") overrides.push("直写");
    if (config.reviewer.mode === "multi") overrides.push("多维审");
    else if (config.reviewer.mode === "commander") overrides.push("自审");
    return overrides.length > 0 ? `高自主 · ${overrides.join("·")}` : "高自主";
  }
  const parts: Array<string> = ["Grill"];
  if (config.planner.mode === "panel") parts.push("比稿");
  else if (config.planner.mode === "single") parts.push("单规");
  if (config.implementer.mode === "subagent") parts.push("子代理");
  else if (config.implementer.mode === "direct") parts.push("直写");
  if (config.reviewer.mode === "multi") parts.push(`多维审(${config.reviewer.angles.length})`);
  else if (config.reviewer.mode === "commander") parts.push("自审");
  return parts.join(" · ");
}

export function buildTeamOrchestrationRetroPrompt(input: {
  readonly config: TeamOrchestrationConfig;
  readonly userCardsDir?: string;
}): string {
  const activeAngles =
    input.config.reviewer.angles.length > 0
      ? input.config.reviewer.angles.map((id) => `\`review.${id}\``).join("、")
      : "默认维度";
  const dirNote = input.userCardsDir
    ? `规范卡片目录位于 \`${input.userCardsDir}\`（每张卡片对应 \`<cardId>.md\`）。`
    : "规范卡片可在编排面板的「规范卡片库」中直接保存。";

  return [
    "请对本次会话的团队编排执行一次精炼复盘（Retro）：",
    "1. 回顾本次【指挥官 → 方案官 → 执行官 → 审核官】各环节中：哪些配合最有效？哪里出现返工、漏检、指令含糊或模型路由不合理？",
    "2. 对每个问题先做分流：",
    "   - 属于**当前项目代码/脚本/测试/lint**的问题 → 归为项目改进项，不要塞进通用规范卡片；",
    "   - 属于**可复用的协作方法论或提示词规范**的问题 → 精确对应到需要微调的规范卡片 ID（例如 `commander.grill`、`implementer.subagent`、`reviewer.multi` 或本次启用的审核维度 " +
      activeAngles +
      "）。",
    "3. 给出每条拟改卡片的「原句 / 拟改内容 / 原因」（保持简短、高信噪比，优先删改而非无限叠加），先列出来等我确认后再修改。",
    dirNote,
  ].join("\n");
}
