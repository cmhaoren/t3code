import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, type TeamOrchestrationConfig } from "@t3tools/contracts";
import {
  applyCommanderModeDefaults,
  buildTeamOrchestrationRetroPrompt,
  collectTeamOrchestrationModelSelections,
  compileSubagentNormCardPrefix,
  compileTeamOrchestrationDeactivatedNotice,
  compileTeamOrchestrationInstructions,
  computeTeamOrchestrationFingerprint,
  createDefaultTeamNormCards,
  createDefaultTeamOrchestrationConfig,
  getBuiltInTeamOrchestrationPresets,
  inferTeamOrchestrationStageFromRole,
  summarizeTeamOrchestrationBadge,
} from "./teamOrchestration.ts";

describe("teamOrchestration", () => {
  it("returns null when orchestration is disabled", () => {
    const config = createDefaultTeamOrchestrationConfig();
    expect(config.enabled).toBe(false);
    expect(config.baseline.tdd).toBe(true);
    expect(compileTeamOrchestrationInstructions({ config })).toBeNull();
    expect(computeTeamOrchestrationFingerprint(null)).toBeNull();
    expect(summarizeTeamOrchestrationBadge(config)).toBeNull();
  });

  it("switches downstream modes to auto when commander switches to autonomous and restores concrete defaults on grill", () => {
    const initial: TeamOrchestrationConfig = {
      ...createDefaultTeamOrchestrationConfig(),
      enabled: true,
    };
    const autoConfig = applyCommanderModeDefaults(initial, "autonomous");
    expect(autoConfig.commanderMode).toBe("autonomous");
    expect(autoConfig.planner.mode).toBe("auto");
    expect(autoConfig.implementer.mode).toBe("auto");
    expect(autoConfig.implementer.isolation).toBe("auto");
    expect(autoConfig.reviewer.mode).toBe("auto");
    expect(summarizeTeamOrchestrationBadge(autoConfig)).toBe("高自主");

    const lockedAuto: TeamOrchestrationConfig = {
      ...autoConfig,
      reviewer: { ...autoConfig.reviewer, mode: "multi" },
    };
    expect(summarizeTeamOrchestrationBadge(lockedAuto)).toBe("高自主 · 多维审");

    const backToGrill = applyCommanderModeDefaults(autoConfig, "grill");
    expect(backToGrill.commanderMode).toBe("grill");
    expect(backToGrill.planner.mode).toBe("commander");
    expect(backToGrill.implementer.mode).toBe("subagent");
    expect(backToGrill.implementer.isolation).toBe("shared");
    expect(backToGrill.reviewer.mode).toBe("multi");
  });

  it("compiles active stages, bound models, norm card overrides, and review angles without leaking inactive modes", () => {
    const dsh = ProviderInstanceId.make("dsh");
    const codex = ProviderInstanceId.make("codex");
    const config: TeamOrchestrationConfig = {
      version: 1,
      enabled: true,
      presetId: "builtin-deep-craft",
      commanderMode: "grill",
      planner: {
        mode: "panel",
        modelSelection: null,
        panelModels: [
          { instanceId: dsh, model: "DeepSeek-V4.1", options: [] },
          {
            instanceId: codex,
            model: "gpt-5.4",
            options: [{ id: "reasoningEffort", value: "high" }],
          },
        ],
      },
      implementer: {
        mode: "subagent",
        isolation: "worktree",
        routineModel: { instanceId: dsh, model: "DeepSeek-V4.1-Flash", options: [] },
        standardModel: null,
        complexModel: { instanceId: codex, model: "gpt-5.4", options: [] },
      },
      reviewer: {
        mode: "multi",
        defaultModel: { instanceId: dsh, model: "DeepSeek-V4.1-Flash", options: [] },
        angles: ["correctness", "blast-radius", "visual-ux"],
        angleModelOverrides: {
          "visual-ux": { instanceId: codex, model: "gpt-5.4", options: [] },
        },
      },
      baseline: {
        tdd: true,
        realEvidence: true,
        separateReview: true,
        maxReworkBeforeRethink: 2,
      },
      notes: "本项目跨包必须走 package exports。",
    };

    const customCards = createDefaultTeamNormCards().map((card) =>
      card.id === "commander.grill"
        ? { ...card, content: "- 自定义 Grill 规则：先核对 schema 再提问。" }
        : card,
    );

    const compiled = compileTeamOrchestrationInstructions({
      config,
      cards: customCards,
      providerLabelByInstanceId: new Map([
        ["dsh", "DSH"],
        ["codex", "Codex"],
      ]),
    });

    expect(compiled).not.toBeNull();
    expect(compiled).toContain("<t3_code_team_orchestration>");
    expect(compiled).toContain("自定义 Grill 规则：先核对 schema 再提问。");
    expect(compiled).toContain("多模型出稿 · 指挥官整合（Arena）");
    expect(compiled).toContain('DSH (providerInstanceId: "dsh"), model: "DeepSeek-V4.1"');
    expect(compiled).toContain('options: {"reasoningEffort":"high"}');
    expect(compiled).toContain('isolation: "worktree"');
    expect(compiled).toContain("routine");
    expect(compiled).toContain("complex");
    expect(compiled).toContain("`blast-radius`（影响范围与回归风险）");
    expect(compiled).toContain("`visual-ux`（视觉与交互验收） | 指定模型：Codex");
    expect(compiled).toContain("TDD 测试驱动");
    expect(compiled).toContain("本项目跨包必须走 package exports。");
    // Should not include inactive commander.autonomous or implementer.direct norm text
    expect(compiled).not.toContain("主会话直接实现改动");
  });

  it("changes fingerprint whenever compiled config or norm card content changes", () => {
    const preset = getBuiltInTeamOrchestrationPresets()[0]!;
    const a = compileTeamOrchestrationInstructions({ config: preset.config });
    const b = compileTeamOrchestrationInstructions({
      config: preset.config,
      cards: [{ id: "baseline.tdd", content: "- 修改后的 TDD 规范" }],
    });
    expect(computeTeamOrchestrationFingerprint(a)).not.toBe(computeTeamOrchestrationFingerprint(b));
  });

  it("compiles subagent norm card prefixes for plan, implement, and review angles", () => {
    const config = getBuiltInTeamOrchestrationPresets()[0]!.config;
    const planPrefix = compileSubagentNormCardPrefix({ stage: "plan", config });
    expect(planPrefix).toContain("方案规划子代理");
    expect(planPrefix).toContain("禁止修改源码");

    const implPrefix = compileSubagentNormCardPrefix({ stage: "implement", config });
    expect(implPrefix).toContain("执行子代理");
    expect(implPrefix).toContain("TDD");
    expect(implPrefix).toContain("白名单");

    const reviewPrefix = compileSubagentNormCardPrefix({
      stage: "review",
      reviewAngle: "blast-radius",
      config,
    });
    expect(reviewPrefix).toContain("影响范围与回归风险");
    expect(reviewPrefix).toContain("只读审查");
    expect(reviewPrefix).toContain("P0");
  });

  it("builds deactivation notice and retro prompt", () => {
    const notice = compileTeamOrchestrationDeactivatedNotice();
    expect(notice).toContain("<t3_code_team_orchestration_status>");

    const preset = getBuiltInTeamOrchestrationPresets()[0]!;
    const retro = buildTeamOrchestrationRetroPrompt({
      config: preset.config,
      userCardsDir: "C:/Users/demo/.t3/userdata/orchestration/cards",
    });
    expect(retro).toContain("review.blast-radius");
    expect(retro).toContain("C:/Users/demo/.t3/userdata/orchestration/cards");
  });

  it("properly JSON-escapes composite model ids, includes anti-compaction note, infers stage from role, and collects pinned models", () => {
    const dsh = ProviderInstanceId.make("dsh");
    const agy = ProviderInstanceId.make("antigravity");
    const config: TeamOrchestrationConfig = {
      ...createDefaultTeamOrchestrationConfig(),
      enabled: true,
      implementer: {
        mode: "subagent",
        isolation: "auto",
        routineModel: {
          instanceId: dsh,
          model: '["apigoto-1","deepseek-flash"]',
          options: [{ id: "reasoning_effort", value: "high" }],
        },
        standardModel: null,
        complexModel: {
          instanceId: agy,
          model: "gemini-4-neon",
          options: [{ id: "thought_level", value: "high" }],
        },
      },
    };

    const compiled = compileTeamOrchestrationInstructions({ config });
    expect(compiled).toContain('model: "[\\"apigoto-1\\",\\"deepseek-flash\\"]"');
    expect(compiled).toContain("orchestrator_capabilities");
    expect(compiled).toContain("抗压缩保留");

    expect(inferTeamOrchestrationStageFromRole("implementation")).toBe("implement");
    expect(inferTeamOrchestrationStageFromRole("test")).toBe("implement");
    expect(inferTeamOrchestrationStageFromRole("review")).toBe("review");
    expect(inferTeamOrchestrationStageFromRole("design")).toBe("plan");
    expect(inferTeamOrchestrationStageFromRole("research")).toBeUndefined();
    expect(inferTeamOrchestrationStageFromRole(undefined)).toBeUndefined();

    const pinned = collectTeamOrchestrationModelSelections(config);
    expect(pinned.map((item) => `${item.instanceId}:${item.model}`)).toEqual([
      'dsh:["apigoto-1","deepseek-flash"]',
      "antigravity:gemini-4-neon",
    ]);
    expect(collectTeamOrchestrationModelSelections({ ...config, enabled: false })).toEqual([]);
  });
});
