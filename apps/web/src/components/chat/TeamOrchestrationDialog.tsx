import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ProviderInstanceId,
  type TeamCommanderMode,
  type TeamImplementerMode,
  type TeamIsolationMode,
  type TeamNormCard,
  type TeamNormCardCategory,
  type TeamNormCardId,
  type TeamNormCardScope,
  type TeamOrchestrationConfig,
  type TeamOrchestrationPreset,
  type TeamPlannerMode,
  type TeamReviewAngleId,
  type TeamReviewerMode,
} from "@t3tools/contracts";
import {
  applyCommanderModeDefaults,
  buildTeamOrchestrationRetroPrompt,
  compileTeamOrchestrationInstructions,
  createDefaultTeamNormCards,
  createDefaultTeamOrchestrationConfig,
  getBuiltInTeamOrchestrationPresets,
  normalizeTeamOrchestrationConfig,
  TEAM_REVIEW_ANGLE_META,
} from "@t3tools/shared/teamOrchestration";
import { T, useGT } from "gt-react";
import {
  BookmarkPlusIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileCode2Icon,
  HistoryIcon,
  PlusIcon,
  RotateCcwIcon,
  SaveIcon,
  StarIcon,
  Trash2Icon,
  UsersIcon,
} from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "~/lib/utils";
import type { AppModelOption } from "../../modelSelection";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { TeamOrchestrationModelSlot } from "./TeamOrchestrationModelSlot";

const CARD_CATEGORY_KEYS: ReadonlyArray<TeamNormCardCategory> = [
  "commander",
  "planner",
  "implementer",
  "reviewer",
  "review-angle",
  "baseline",
];

function SegmentedButton(props: {
  readonly active: boolean;
  readonly onClick: () => void;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
        props.active
          ? "bg-primary text-primary-foreground shadow-xs"
          : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
      )}
    >
      {props.label}
    </button>
  );
}

export interface TeamOrchestrationDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly workspaceCwd: string | null;
  readonly isExistingThread: boolean;
  readonly value: TeamOrchestrationConfig | null;
  readonly fallbackSelection: ModelSelection | null;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  readonly getModelDisabledReason?: (
    instanceId: ProviderInstanceId,
    model: string,
  ) => string | null;
  readonly onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  readonly onApply: (next: TeamOrchestrationConfig | null) => Promise<void> | void;
  readonly onInsertRetroPrompt: (prompt: string) => void;
}

export function TeamOrchestrationDialog(props: TeamOrchestrationDialogProps) {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <TeamOrchestrationDialogContent {...props} /> : null}
    </Dialog>
  );
}

function TeamOrchestrationDialogContent(props: TeamOrchestrationDialogProps) {
  const gt = useGT();
  const {
    onOpenChange,
    environmentId,
    projectId,
    workspaceCwd,
    isExistingThread,
    value,
    fallbackSelection,
    instanceEntries,
    modelOptionsByInstance,
    getModelDisabledReason,
    onOpenProviderSetup,
    onApply,
    onInsertRetroPrompt,
  } = props;

  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const serverSettings = serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const updateServerSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save team orchestration presets",
    reportFailure: false,
  });
  const listCards = useAtomCommand(serverEnvironment.listOrchestrationCards, {
    label: "load team norm cards",
    reportFailure: false,
  });
  const saveCard = useAtomCommand(serverEnvironment.saveOrchestrationCard, {
    label: "save team norm card",
    reportFailure: false,
  });
  const resetCard = useAtomCommand(serverEnvironment.resetOrchestrationCard, {
    label: "reset team norm card",
    reportFailure: false,
  });

  const builtInPresets = getBuiltInTeamOrchestrationPresets();
  const customPresets = serverSettings.teamOrchestrationPresets;
  const allPresets: ReadonlyArray<TeamOrchestrationPreset> = [...builtInPresets, ...customPresets];
  const defaultPresetId = serverSettings.defaultTeamOrchestrationPresetId;

  const initialConfig = normalizeTeamOrchestrationConfig(
    value ?? createDefaultTeamOrchestrationConfig(),
  );
  const [activeTab, setActiveTab] = useState<"session" | "cards">("session");
  const [draft, setDraft] = useState<TeamOrchestrationConfig>(initialConfig);
  const [applying, setApplying] = useState(false);
  const [showAngleOverrides, setShowAngleOverrides] = useState(
    () => Object.keys(initialConfig.reviewer.angleModelOverrides).length > 0,
  );
  const [showPreview, setShowPreview] = useState(false);
  const [saveAsOpen, setSaveAsOpen] = useState(false);
  const [saveAsName, setSaveAsName] = useState("");
  const [presetBusy, setPresetBusy] = useState(false);

  const [cards, setCards] = useState<ReadonlyArray<TeamNormCard>>(() =>
    createDefaultTeamNormCards(),
  );
  const [userCardsDir, setUserCardsDir] = useState<string>("");
  const [projectCardsDir, setProjectCardsDir] = useState<string | null>(null);
  const [selectedCardId, setSelectedCardId] = useState<TeamNormCardId>("commander.grill");
  const [cardEditorText, setCardEditorText] = useState<string>(
    () => createDefaultTeamNormCards()[0]?.content ?? "",
  );
  const [cardScope, setCardScope] = useState<TeamNormCardScope>("user");
  const [cardSaving, setCardSaving] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads persisted markdown norm cards from server filesystem once when the dialog mounts
  useEffect(() => {
    let cancelled = false;
    void listCards({
      environmentId,
      input: projectId ? { projectId } : {},
    }).then((result) => {
      if (cancelled || result._tag !== "Success") return;
      setCards(result.value.cards);
      setUserCardsDir(result.value.userCardsDir);
      setProjectCardsDir(result.value.projectCardsDir);
      const current = result.value.cards.find((card) => card.id === "commander.grill");
      if (current) {
        setCardEditorText(current.content);
        setCardScope(current.source === "project" && projectId ? "project" : "user");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [environmentId, projectId, listCards]);

  const selectedCard = cards.find((card) => card.id === selectedCardId) ?? cards[0];

  const handleSelectCard = (card: TeamNormCard) => {
    setSelectedCardId(card.id);
    setCardEditorText(card.content);
    setCardScope(card.source === "project" && projectId ? "project" : "user");
  };

  const providerLabelByInstanceId = new Map<string, string>(
    instanceEntries.map((entry) => [entry.instanceId, entry.displayName]),
  );

  const compiledPreview = compileTeamOrchestrationInstructions({
    config: draft,
    cards,
    providerLabelByInstanceId,
  });

  const activePreset = allPresets.find((preset) => preset.id === draft.presetId) ?? null;

  const isPresetModified =
    activePreset !== null &&
    JSON.stringify(
      normalizeTeamOrchestrationConfig({ ...activePreset.config, enabled: draft.enabled }),
    ) !== JSON.stringify(normalizeTeamOrchestrationConfig(draft));

  const categoryLabel = (key: TeamNormCardCategory): string => {
    switch (key) {
      case "commander":
        return gt("指挥官");
      case "planner":
        return gt("方案官");
      case "implementer":
        return gt("执行官");
      case "reviewer":
        return gt("审核官");
      case "review-angle":
        return gt("审核维度");
      case "baseline":
        return gt("工程底线");
    }
  };

  const handleSelectPreset = (presetId: string) => {
    if (presetId === "__custom__") {
      setDraft((prev) => ({ ...prev, presetId: null }));
      return;
    }
    const found = allPresets.find((preset) => preset.id === presetId);
    if (!found) return;
    setDraft(
      normalizeTeamOrchestrationConfig({
        ...found.config,
        enabled: true,
        presetId: found.id,
      }),
    );
  };

  const handleSavePresetAs = async () => {
    const trimmed = saveAsName.trim();
    if (!trimmed) return;
    setPresetBusy(true);
    try {
      const newId = `preset-${Date.now()}`;
      const newPreset: TeamOrchestrationPreset = {
        id: newId,
        name: trimmed,
        config: normalizeTeamOrchestrationConfig({ ...draft, presetId: newId }),
      };
      const nextPresets = [...customPresets, newPreset];
      const result = await updateServerSettings({
        environmentId,
        input: { patch: { teamOrchestrationPresets: nextPresets } },
      });
      if (result._tag === "Success") {
        setDraft((prev) => ({ ...prev, presetId: newId }));
        setSaveAsOpen(false);
        setSaveAsName("");
        toastManager.add({
          type: "success",
          title: gt("已另存预设「{name}」", { name: trimmed }),
        });
      } else {
        toastManager.add({ type: "error", title: gt("保存预设失败") });
      }
    } finally {
      setPresetBusy(false);
    }
  };

  const handleUpdateCurrentPreset = async () => {
    if (!activePreset || activePreset.builtIn) return;
    setPresetBusy(true);
    try {
      const nextPresets = customPresets.map((preset) =>
        preset.id === activePreset.id
          ? {
              ...preset,
              config: normalizeTeamOrchestrationConfig({ ...draft, presetId: preset.id }),
            }
          : preset,
      );
      const result = await updateServerSettings({
        environmentId,
        input: { patch: { teamOrchestrationPresets: nextPresets } },
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title: gt("已更新预设「{name}」", { name: activePreset.name }),
        });
      } else {
        toastManager.add({ type: "error", title: gt("更新预设失败") });
      }
    } finally {
      setPresetBusy(false);
    }
  };

  const handleDeleteCurrentPreset = async () => {
    if (!activePreset || activePreset.builtIn) return;
    setPresetBusy(true);
    try {
      const nextPresets = customPresets.filter((preset) => preset.id !== activePreset.id);
      const result = await updateServerSettings({
        environmentId,
        input: {
          patch: {
            teamOrchestrationPresets: nextPresets,
            ...(defaultPresetId === activePreset.id
              ? { defaultTeamOrchestrationPresetId: null }
              : {}),
          },
        },
      });
      if (result._tag === "Success") {
        setDraft((prev) => ({ ...prev, presetId: null }));
        toastManager.add({
          type: "success",
          title: gt("已删除预设「{name}」", { name: activePreset.name }),
        });
      } else {
        toastManager.add({ type: "error", title: gt("删除预设失败") });
      }
    } finally {
      setPresetBusy(false);
    }
  };

  const handleToggleDefaultPreset = async () => {
    if (!activePreset) return;
    setPresetBusy(true);
    try {
      const nextDefault = defaultPresetId === activePreset.id ? null : activePreset.id;
      const result = await updateServerSettings({
        environmentId,
        input: { patch: { defaultTeamOrchestrationPresetId: nextDefault } },
      });
      if (result._tag === "Success") {
        toastManager.add({
          type: "success",
          title:
            nextDefault === null
              ? gt("已取消新会话默认编排预设")
              : gt("已将「{name}」设为新会话默认", { name: activePreset.name }),
        });
      } else {
        toastManager.add({ type: "error", title: gt("设置默认预设失败") });
      }
    } finally {
      setPresetBusy(false);
    }
  };

  const handleSaveCard = async () => {
    if (!selectedCard) return;
    setCardSaving(true);
    try {
      const result = await saveCard({
        environmentId,
        input: {
          cardId: selectedCard.id,
          content: cardEditorText,
          scope: cardScope,
          ...(projectId ? { projectId } : {}),
        },
      });
      if (result._tag === "Success") {
        const updated = result.value.card;
        setCards((prev) => prev.map((card) => (card.id === updated.id ? updated : card)));
        setCardEditorText(updated.content);
        toastManager.add({
          type: "success",
          title: gt("已保存规范卡片「{title}」", { title: updated.title }),
        });
      } else {
        toastManager.add({ type: "error", title: gt("保存规范卡片失败") });
      }
    } finally {
      setCardSaving(false);
    }
  };

  const handleResetCard = async () => {
    if (!selectedCard) return;
    setCardSaving(true);
    try {
      const result = await resetCard({
        environmentId,
        input: {
          cardId: selectedCard.id,
          scope: cardScope,
          ...(projectId ? { projectId } : {}),
        },
      });
      if (result._tag === "Success") {
        const updated = result.value.card;
        setCards((prev) => prev.map((card) => (card.id === updated.id ? updated : card)));
        setCardEditorText(updated.content);
        toastManager.add({
          type: "success",
          title: gt("已恢复规范卡片「{title}」", { title: updated.title }),
        });
      } else {
        toastManager.add({ type: "error", title: gt("恢复默认失败") });
      }
    } finally {
      setCardSaving(false);
    }
  };

  const handleCommitSession = async () => {
    setApplying(true);
    try {
      const normalized = normalizeTeamOrchestrationConfig(draft);
      await onApply(normalized);
      onOpenChange(false);
    } finally {
      setApplying(false);
    }
  };

  const handleTriggerRetro = () => {
    const prompt = buildTeamOrchestrationRetroPrompt({
      config: draft,
      ...(userCardsDir ? { userCardsDir } : {}),
      cards,
    });
    onInsertRetroPrompt(prompt);
    onOpenChange(false);
  };

  const setCommanderMode = (mode: TeamCommanderMode) => {
    setDraft((prev) => applyCommanderModeDefaults(prev, mode));
  };

  const setPlannerMode = (mode: TeamPlannerMode) => {
    setDraft((prev) => ({ ...prev, planner: { ...prev.planner, mode } }));
  };

  const setImplementerMode = (mode: TeamImplementerMode) => {
    setDraft((prev) => ({ ...prev, implementer: { ...prev.implementer, mode } }));
  };

  const setIsolationMode = (isolation: TeamIsolationMode) => {
    setDraft((prev) => ({ ...prev, implementer: { ...prev.implementer, isolation } }));
  };

  const setReviewerMode = (mode: TeamReviewerMode) => {
    setDraft((prev) => ({ ...prev, reviewer: { ...prev.reviewer, mode } }));
  };

  const toggleReviewAngle = (angleId: TeamReviewAngleId) => {
    setDraft((prev) => {
      const exists = prev.reviewer.angles.includes(angleId);
      const nextAngles = exists
        ? prev.reviewer.angles.filter((id) => id !== angleId)
        : [...prev.reviewer.angles, angleId];
      return {
        ...prev,
        reviewer: {
          ...prev.reviewer,
          angles: nextAngles.length > 0 ? nextAngles : [angleId],
        },
      };
    });
  };

  const panelTooFewModels =
    draft.enabled && draft.planner.mode === "panel" && draft.planner.panelModels.length < 2;

  const estimatedTokens = compiledPreview ? Math.ceil(compiledPreview.length / 3) : 0;

  // Build stable keys for panelModels even if two slots temporarily pick the same model.
  const panelOccurrenceCount = new Map<string, number>();
  const keyedPanelModels = draft.planner.panelModels.map((selection) => {
    const baseKey = `${selection.instanceId}:${selection.model}`;
    const seen = (panelOccurrenceCount.get(baseKey) ?? 0) + 1;
    panelOccurrenceCount.set(baseKey, seen);
    return { key: `${baseKey}#${seen}`, selection };
  });

  const overrideCount = Object.keys(draft.reviewer.angleModelOverrides).length;

  return (
    <DialogPopup className="max-w-4xl">
      <DialogHeader>
        <div className="flex flex-wrap items-center justify-between gap-3 pr-8">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <UsersIcon className="size-4" />
            </div>
            <div>
              <DialogTitle>
                <T>团队编排</T>
              </DialogTitle>
              <DialogDescription>
                <T>按阶段编排本会话的指挥、方案、执行与多维审核策略，编译为系统级协作指令。</T>
              </DialogDescription>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center rounded-lg border border-border bg-muted/40 p-0.5">
              <button
                type="button"
                onClick={() => setActiveTab("session")}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  activeTab === "session"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <T>本次会话编排</T>
              </button>
              <button
                type="button"
                onClick={() => setActiveTab("cards")}
                className={cn(
                  "rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
                  activeTab === "cards"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <T>规范卡片库</T>
              </button>
            </div>
            <label className="flex cursor-pointer items-center gap-2 text-xs font-medium">
              <Switch
                checked={draft.enabled}
                onCheckedChange={(checked) =>
                  setDraft((prev) => ({ ...prev, enabled: Boolean(checked) }))
                }
              />
              <span>{draft.enabled ? gt("已开启") : gt("未开启")}</span>
            </label>
          </div>
        </div>
      </DialogHeader>

      <DialogPanel className="max-h-[70vh]">
        {activeTab === "session" ? (
          <div className="space-y-4">
            {/* Preset Bar */}
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border/80 bg-muted/25 px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-medium text-muted-foreground">
                  <T>预设模板</T>
                </span>
                <select
                  aria-label={gt("选择团队编排预设")}
                  value={draft.presetId ?? "__custom__"}
                  onChange={(event) => handleSelectPreset(event.target.value)}
                  className="h-7 rounded-md border border-border bg-background px-2 text-xs text-foreground outline-none focus-visible:border-ring"
                >
                  <option value="__custom__">{gt("自定义配置")}</option>
                  <optgroup label={gt("内置预设")}>
                    {builtInPresets.map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {defaultPresetId === preset.id
                          ? gt("{name}（默认）", { name: preset.name })
                          : preset.name}
                      </option>
                    ))}
                  </optgroup>
                  {customPresets.length > 0 ? (
                    <optgroup label={gt("我的预设")}>
                      {customPresets.map((preset) => (
                        <option key={preset.id} value={preset.id}>
                          {defaultPresetId === preset.id
                            ? gt("{name}（默认）", { name: preset.name })
                            : preset.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null}
                </select>
                {isPresetModified ? (
                  <Badge variant="warning">
                    <T>仅本会话临时调整</T>
                  </Badge>
                ) : (
                  <span className="text-2xs text-muted-foreground">
                    <T>改动仅作用于本会话，除非主动保存为预设</T>
                  </span>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {activePreset ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    disabled={presetBusy}
                    onClick={() => void handleToggleDefaultPreset()}
                  >
                    <StarIcon
                      className={cn(
                        "size-3.5",
                        defaultPresetId === activePreset.id && "fill-warning text-warning",
                      )}
                    />
                    <span>
                      {defaultPresetId === activePreset.id ? gt("已默认") : gt("设为默认")}
                    </span>
                  </Button>
                ) : null}
                {activePreset && !activePreset.builtIn && isPresetModified ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={presetBusy}
                    onClick={() => void handleUpdateCurrentPreset()}
                  >
                    <SaveIcon className="size-3" />
                    <span>
                      <T>更新预设</T>
                    </span>
                  </Button>
                ) : null}
                {saveAsOpen ? (
                  <div className="flex items-center gap-1">
                    <Input
                      size="sm"
                      value={saveAsName}
                      onChange={(event) => setSaveAsName(event.target.value)}
                      placeholder={gt("预设名称")}
                      className="w-32"
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void handleSavePresetAs();
                        }
                      }}
                    />
                    <Button
                      type="button"
                      size="xs"
                      disabled={presetBusy || !saveAsName.trim()}
                      onClick={() => void handleSavePresetAs()}
                    >
                      <T>保存</T>
                    </Button>
                    <Button
                      type="button"
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        setSaveAsOpen(false);
                        setSaveAsName("");
                      }}
                    >
                      <T>取消</T>
                    </Button>
                  </div>
                ) : (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    disabled={presetBusy}
                    onClick={() => setSaveAsOpen(true)}
                  >
                    <BookmarkPlusIcon className="size-3" />
                    <span>
                      <T>另存预设</T>
                    </span>
                  </Button>
                )}
                {activePreset && !activePreset.builtIn ? (
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-destructive"
                    disabled={presetBusy}
                    onClick={() => void handleDeleteCurrentPreset()}
                    aria-label={gt("删除当前预设")}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                ) : null}
              </div>
            </div>

            {/* 4 Sequential Stage Cards */}
            <div className={cn("space-y-3 transition-opacity", !draft.enabled && "opacity-60")}>
              {/* Stage 1: Commander */}
              <section className="rounded-xl border border-border/80 bg-card/50 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-2xs font-semibold text-primary">
                      1
                    </span>
                    <div>
                      <div className="text-sm font-semibold">
                        <T>指挥官（主会话）</T>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        <T>决定开工前沟通深度与下游环节默认自主程度</T>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <SegmentedButton
                      active={draft.commanderMode === "grill"}
                      onClick={() => setCommanderMode("grill")}
                      label={gt("Grill 对齐")}
                    />
                    <SegmentedButton
                      active={draft.commanderMode === "autonomous"}
                      onClick={() => setCommanderMode("autonomous")}
                      label={gt("高自主")}
                    />
                  </div>
                </div>
                {draft.commanderMode === "autonomous" ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    <T>
                      已切换高自主：②③④
                      阶段默认设为「自动（指挥官自决）」，你仍可随时为单个阶段手动锁定模式或模型。
                    </T>
                  </p>
                ) : null}
              </section>

              {/* Stage 2: Planner */}
              <section className="rounded-xl border border-border/80 bg-card/50 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-2xs font-semibold text-primary">
                      2
                    </span>
                    <div>
                      <div className="text-sm font-semibold">
                        <T>方案官</T>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        <T>架构拆解、接口设计与方案比稿</T>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <SegmentedButton
                      active={draft.planner.mode === "auto"}
                      onClick={() => setPlannerMode("auto")}
                      label={gt("自动")}
                    />
                    <SegmentedButton
                      active={draft.planner.mode === "commander"}
                      onClick={() => setPlannerMode("commander")}
                      label={gt("指挥官自规划")}
                    />
                    <SegmentedButton
                      active={draft.planner.mode === "single"}
                      onClick={() => setPlannerMode("single")}
                      label={gt("单代理规划")}
                    />
                    <SegmentedButton
                      active={draft.planner.mode === "panel"}
                      onClick={() => setPlannerMode("panel")}
                      label={gt("多模型比稿")}
                    />
                  </div>
                </div>

                {draft.planner.mode === "single" ? (
                  <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border/60 pt-2.5">
                    <span className="text-xs text-muted-foreground">
                      <T>规划模型</T>
                    </span>
                    <TeamOrchestrationModelSlot
                      environmentId={environmentId}
                      workspaceCwd={workspaceCwd}
                      value={draft.planner.modelSelection}
                      fallbackSelection={fallbackSelection}
                      instanceEntries={instanceEntries}
                      modelOptionsByInstance={modelOptionsByInstance}
                      {...(getModelDisabledReason ? { getModelDisabledReason } : {})}
                      {...(onOpenProviderSetup ? { onOpenProviderSetup } : {})}
                      onChange={(next) =>
                        setDraft((prev) => ({
                          ...prev,
                          planner: { ...prev.planner, modelSelection: next },
                        }))
                      }
                    />
                  </div>
                ) : null}

                {draft.planner.mode === "panel" ? (
                  <div className="mt-3 space-y-2 border-t border-border/60 pt-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground">
                        <T>候选方案模型（并行独立出稿，指挥官评分并嫁接最优片段，建议 ≥2 个）</T>
                      </span>
                      <Button
                        type="button"
                        size="xs"
                        variant="outline"
                        disabled={fallbackSelection === null}
                        onClick={() => {
                          if (!fallbackSelection) return;
                          setDraft((prev) => ({
                            ...prev,
                            planner: {
                              ...prev.planner,
                              panelModels: [
                                ...prev.planner.panelModels,
                                {
                                  instanceId: fallbackSelection.instanceId,
                                  model: fallbackSelection.model,
                                  options: [...(fallbackSelection.options ?? [])],
                                },
                              ],
                            },
                          }));
                        }}
                      >
                        <PlusIcon className="size-3" />
                        <span>
                          <T>添加候选模型</T>
                        </span>
                      </Button>
                    </div>
                    <div className="space-y-1.5">
                      {keyedPanelModels.map(({ key, selection }, index) => (
                        <div key={key} className="flex items-center gap-2">
                          <span className="w-12 text-xs text-muted-foreground">
                            {gt("方案 {index}", { index: index + 1 })}
                          </span>
                          <TeamOrchestrationModelSlot
                            environmentId={environmentId}
                            workspaceCwd={workspaceCwd}
                            value={selection}
                            fallbackSelection={fallbackSelection}
                            instanceEntries={instanceEntries}
                            modelOptionsByInstance={modelOptionsByInstance}
                            {...(getModelDisabledReason ? { getModelDisabledReason } : {})}
                            {...(onOpenProviderSetup ? { onOpenProviderSetup } : {})}
                            onChange={(next) =>
                              setDraft((prev) => ({
                                ...prev,
                                planner: {
                                  ...prev.planner,
                                  panelModels:
                                    next === null
                                      ? prev.planner.panelModels.filter((_, idx) => idx !== index)
                                      : prev.planner.panelModels.map((item, idx) =>
                                          idx === index ? next : item,
                                        ),
                                },
                              }))
                            }
                          />
                        </div>
                      ))}
                      {panelTooFewModels ? (
                        <p className="text-xs text-warning">
                          <T>
                            多模型比稿建议至少添加 2
                            个候选模型；未填满时指挥官将按可用模型列表自主补充或向你确认。
                          </T>
                        </p>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </section>

              {/* Stage 3: Implementer */}
              <section className="rounded-xl border border-border/80 bg-card/50 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-2xs font-semibold text-primary">
                      3
                    </span>
                    <div>
                      <div className="text-sm font-semibold">
                        <T>执行官</T>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        <T>代码落地方式、工作区隔离与按复杂度路由模型</T>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <SegmentedButton
                      active={draft.implementer.mode === "auto"}
                      onClick={() => setImplementerMode("auto")}
                      label={gt("自动")}
                    />
                    <SegmentedButton
                      active={draft.implementer.mode === "direct"}
                      onClick={() => setImplementerMode("direct")}
                      label={gt("直接实现")}
                    />
                    <SegmentedButton
                      active={draft.implementer.mode === "subagent"}
                      onClick={() => setImplementerMode("subagent")}
                      label={gt("子代理实现")}
                    />
                  </div>
                </div>

                {draft.implementer.mode !== "direct" ? (
                  <div className="mt-3 space-y-3 border-t border-border/60 pt-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <span className="text-xs font-medium">
                          <T>工作区隔离</T>
                        </span>
                        <span className="ml-2 text-2xs text-muted-foreground">
                          <T>共享目录 = 同目录 + 互不重叠白名单；独立 Worktree = 独立分支副本</T>
                        </span>
                      </div>
                      <div className="flex items-center gap-1">
                        <SegmentedButton
                          active={draft.implementer.isolation === "auto"}
                          onClick={() => setIsolationMode("auto")}
                          label={gt("自动")}
                        />
                        <SegmentedButton
                          active={draft.implementer.isolation === "shared"}
                          onClick={() => setIsolationMode("shared")}
                          label={gt("共享目录")}
                        />
                        <SegmentedButton
                          active={draft.implementer.isolation === "worktree"}
                          onClick={() => setIsolationMode("worktree")}
                          label={gt("独立 Worktree")}
                        />
                      </div>
                    </div>

                    <div className="grid gap-2 sm:grid-cols-3">
                      <div className="rounded-lg border border-border/60 bg-background/40 p-2">
                        <div className="mb-1.5 text-xs font-medium">
                          <T>常规 / 机械</T>
                        </div>
                        <TeamOrchestrationModelSlot
                          environmentId={environmentId}
                          workspaceCwd={workspaceCwd}
                          value={draft.implementer.routineModel}
                          fallbackSelection={fallbackSelection}
                          instanceEntries={instanceEntries}
                          modelOptionsByInstance={modelOptionsByInstance}
                          {...(getModelDisabledReason ? { getModelDisabledReason } : {})}
                          {...(onOpenProviderSetup ? { onOpenProviderSetup } : {})}
                          emptyLabel={gt("可选绑定")}
                          onChange={(next) =>
                            setDraft((prev) => ({
                              ...prev,
                              implementer: { ...prev.implementer, routineModel: next },
                            }))
                          }
                        />
                      </div>
                      <div className="rounded-lg border border-border/60 bg-background/40 p-2">
                        <div className="mb-1.5 text-xs font-medium">
                          <T>核心功能</T>
                        </div>
                        <TeamOrchestrationModelSlot
                          environmentId={environmentId}
                          workspaceCwd={workspaceCwd}
                          value={draft.implementer.standardModel}
                          fallbackSelection={fallbackSelection}
                          instanceEntries={instanceEntries}
                          modelOptionsByInstance={modelOptionsByInstance}
                          {...(getModelDisabledReason ? { getModelDisabledReason } : {})}
                          {...(onOpenProviderSetup ? { onOpenProviderSetup } : {})}
                          emptyLabel={gt("可选绑定")}
                          onChange={(next) =>
                            setDraft((prev) => ({
                              ...prev,
                              implementer: { ...prev.implementer, standardModel: next },
                            }))
                          }
                        />
                      </div>
                      <div className="rounded-lg border border-border/60 bg-background/40 p-2">
                        <div className="mb-1.5 text-xs font-medium">
                          <T>复杂攻坚</T>
                        </div>
                        <TeamOrchestrationModelSlot
                          environmentId={environmentId}
                          workspaceCwd={workspaceCwd}
                          value={draft.implementer.complexModel}
                          fallbackSelection={fallbackSelection}
                          instanceEntries={instanceEntries}
                          modelOptionsByInstance={modelOptionsByInstance}
                          {...(getModelDisabledReason ? { getModelDisabledReason } : {})}
                          {...(onOpenProviderSetup ? { onOpenProviderSetup } : {})}
                          emptyLabel={gt("可选绑定")}
                          onChange={(next) =>
                            setDraft((prev) => ({
                              ...prev,
                              implementer: { ...prev.implementer, complexModel: next },
                            }))
                          }
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
              </section>

              {/* Stage 4: Reviewer */}
              <section className="rounded-xl border border-border/80 bg-card/50 p-3.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="flex size-5 items-center justify-center rounded-full bg-primary/15 text-2xs font-semibold text-primary">
                      4
                    </span>
                    <div>
                      <div className="text-sm font-semibold">
                        <T>审核官</T>
                      </div>
                      <div className="text-xs text-muted-foreground">
                        <T>独立只读视角验收，多维审核为每个维度派发干净上下文子代理</T>
                      </div>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1">
                    <SegmentedButton
                      active={draft.reviewer.mode === "auto"}
                      onClick={() => setReviewerMode("auto")}
                      label={gt("自动")}
                    />
                    <SegmentedButton
                      active={draft.reviewer.mode === "commander"}
                      onClick={() => setReviewerMode("commander")}
                      label={gt("指挥审核")}
                    />
                    <SegmentedButton
                      active={draft.reviewer.mode === "multi"}
                      onClick={() => setReviewerMode("multi")}
                      label={gt("多维审核")}
                    />
                  </div>
                </div>

                {draft.reviewer.mode !== "commander" ? (
                  <div className="mt-3 space-y-3 border-t border-border/60 pt-2.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-xs font-medium">
                        <T>默认审核模型（本会话可随时切换）</T>
                      </span>
                      <TeamOrchestrationModelSlot
                        environmentId={environmentId}
                        workspaceCwd={workspaceCwd}
                        value={draft.reviewer.defaultModel}
                        fallbackSelection={fallbackSelection}
                        instanceEntries={instanceEntries}
                        modelOptionsByInstance={modelOptionsByInstance}
                        {...(getModelDisabledReason ? { getModelDisabledReason } : {})}
                        {...(onOpenProviderSetup ? { onOpenProviderSetup } : {})}
                        onChange={(next) =>
                          setDraft((prev) => ({
                            ...prev,
                            reviewer: { ...prev.reviewer, defaultModel: next },
                          }))
                        }
                      />
                    </div>

                    <div className="space-y-1.5">
                      <div className="text-xs font-medium">
                        <T>启用审核维度</T>
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        {TEAM_REVIEW_ANGLE_META.map((angle) => {
                          const checked = draft.reviewer.angles.includes(angle.id);
                          return (
                            <button
                              key={angle.id}
                              type="button"
                              aria-pressed={checked}
                              onClick={() => toggleReviewAngle(angle.id)}
                              className={cn(
                                "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors",
                                checked
                                  ? "border-primary/60 bg-primary/15 text-foreground"
                                  : "border-border bg-background/40 text-muted-foreground hover:text-foreground",
                              )}
                            >
                              {checked ? <CheckIcon className="size-3 text-primary" /> : null}
                              <span>{angle.shortLabel}</span>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div>
                      <button
                        type="button"
                        onClick={() => setShowAngleOverrides((prev) => !prev)}
                        className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {showAngleOverrides ? (
                          <ChevronDownIcon className="size-3.5" />
                        ) : (
                          <ChevronRightIcon className="size-3.5" />
                        )}
                        <span>
                          {overrideCount > 0
                            ? gt("按维度单独覆盖模型（已覆盖 {count} 项）", {
                                count: overrideCount,
                              })
                            : gt("按维度单独覆盖模型（可选）")}
                        </span>
                      </button>
                      {showAngleOverrides ? (
                        <div className="mt-2 space-y-1.5 rounded-lg border border-border/60 bg-background/40 p-2.5">
                          {draft.reviewer.angles.map((angleId) => {
                            const meta = TEAM_REVIEW_ANGLE_META.find(
                              (item) => item.id === angleId,
                            )!;
                            const override = draft.reviewer.angleModelOverrides[angleId] ?? null;
                            return (
                              <div
                                key={angleId}
                                className="flex flex-wrap items-center justify-between gap-2"
                              >
                                <span className="text-xs text-muted-foreground">{meta.label}</span>
                                <TeamOrchestrationModelSlot
                                  environmentId={environmentId}
                                  workspaceCwd={workspaceCwd}
                                  value={override}
                                  fallbackSelection={
                                    draft.reviewer.defaultModel ?? fallbackSelection
                                  }
                                  instanceEntries={instanceEntries}
                                  modelOptionsByInstance={modelOptionsByInstance}
                                  {...(getModelDisabledReason ? { getModelDisabledReason } : {})}
                                  {...(onOpenProviderSetup ? { onOpenProviderSetup } : {})}
                                  emptyLabel={gt("使用默认审核模型")}
                                  onChange={(next) =>
                                    setDraft((prev) => {
                                      const nextOverrides = {
                                        ...prev.reviewer.angleModelOverrides,
                                      };
                                      if (next === null) {
                                        delete nextOverrides[angleId];
                                      } else {
                                        nextOverrides[angleId] = next;
                                      }
                                      return {
                                        ...prev,
                                        reviewer: {
                                          ...prev.reviewer,
                                          angleModelOverrides: nextOverrides,
                                        },
                                      };
                                    })
                                  }
                                />
                              </div>
                            );
                          })}
                        </div>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </section>

              {/* Global Engineering Baseline */}
              <section className="rounded-xl border border-border/80 bg-card/40 p-3.5">
                <div className="mb-2.5">
                  <div className="text-sm font-semibold">
                    <T>全局工程底线（跨模式生效）</T>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    <T>无论主会话直写还是子代理实现，默认持续生效的工程纪律</T>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-2">
                  <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-xs">
                    <span>
                      <T>TDD 测试驱动（红→绿→重构）</T>
                    </span>
                    <Switch
                      checked={draft.baseline.tdd}
                      onCheckedChange={(checked) =>
                        setDraft((prev) => ({
                          ...prev,
                          baseline: { ...prev.baseline, tdd: Boolean(checked) },
                        }))
                      }
                    />
                  </label>
                  <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-xs">
                    <span>
                      <T>实跑证据交付（禁止臆测通过）</T>
                    </span>
                    <Switch
                      checked={draft.baseline.realEvidence}
                      onCheckedChange={(checked) =>
                        setDraft((prev) => ({
                          ...prev,
                          baseline: { ...prev.baseline, realEvidence: Boolean(checked) },
                        }))
                      }
                    />
                  </label>
                  <label className="flex cursor-pointer items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-xs">
                    <span>
                      <T>写审分离（编写者不终审自己）</T>
                    </span>
                    <Switch
                      checked={draft.baseline.separateReview}
                      onCheckedChange={(checked) =>
                        setDraft((prev) => ({
                          ...prev,
                          baseline: { ...prev.baseline, separateReview: Boolean(checked) },
                        }))
                      }
                    />
                  </label>
                  <div className="flex items-center justify-between rounded-lg border border-border/60 bg-background/40 px-3 py-2 text-xs">
                    <span>
                      <T>返工止损上限（次）</T>
                    </span>
                    <div className="flex items-center gap-1">
                      {[1, 2, 3, 4, 5].map((count) => (
                        <button
                          key={count}
                          type="button"
                          onClick={() =>
                            setDraft((prev) => ({
                              ...prev,
                              baseline: { ...prev.baseline, maxReworkBeforeRethink: count },
                            }))
                          }
                          className={cn(
                            "size-6 rounded text-xs font-medium",
                            draft.baseline.maxReworkBeforeRethink === count
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted/60 text-muted-foreground hover:text-foreground",
                          )}
                        >
                          {count}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-3 space-y-1.5">
                  <label className="block text-xs font-medium text-muted-foreground">
                    <T>本会话补充约束（可选，一次性指令）</T>
                  </label>
                  <Textarea
                    size="sm"
                    rows={2}
                    value={draft.notes ?? ""}
                    onChange={(event) =>
                      setDraft((prev) => ({ ...prev, notes: event.target.value }))
                    }
                    placeholder={gt(
                      "例如：本次禁止修改数据库表结构；跨包引用必须走 package exports……",
                    )}
                  />
                </div>
              </section>

              {/* Live Compiled Prompt Preview */}
              <div className="rounded-xl border border-border/70 bg-muted/20 px-3.5 py-2.5">
                <button
                  type="button"
                  onClick={() => setShowPreview((prev) => !prev)}
                  className="flex w-full items-center justify-between text-xs font-medium text-muted-foreground hover:text-foreground"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <FileCode2Icon className="size-3.5" />
                    <span>
                      <T>预览注入给指挥官的系统指令</T>
                    </span>
                    {compiledPreview ? (
                      <Badge variant="outline" size="sm">
                        {gt("约 {tokens} tokens（仅首轮或变更时注入）", {
                          tokens: estimatedTokens,
                        })}
                      </Badge>
                    ) : (
                      <Badge variant="outline" size="sm">
                        <T>未开启 · 0 token 注入</T>
                      </Badge>
                    )}
                  </span>
                  {showPreview ? (
                    <ChevronDownIcon className="size-3.5" />
                  ) : (
                    <ChevronRightIcon className="size-3.5" />
                  )}
                </button>
                {showPreview ? (
                  <pre className="mt-2.5 max-h-60 overflow-auto rounded-lg border border-border/60 bg-background/80 p-3 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-foreground/90">
                    {compiledPreview ?? gt("团队编排未开启，当前会话不会注入任何编排提示词。")}
                  </pre>
                ) : null}
              </div>
            </div>
          </div>
        ) : (
          /* Tab 2: Norm Cards Library */
          <div className="grid min-h-[420px] gap-4 md:grid-cols-[240px_1fr]">
            <div className="space-y-3 overflow-y-auto rounded-xl border border-border/70 bg-muted/20 p-2.5">
              {CARD_CATEGORY_KEYS.map((categoryKey) => {
                const items = cards.filter((card) => card.category === categoryKey);
                if (items.length === 0) return null;
                return (
                  <div key={categoryKey} className="space-y-1">
                    <div className="px-2 text-2xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {categoryLabel(categoryKey)}
                    </div>
                    {items.map((card) => {
                      const active = selectedCard?.id === card.id;
                      return (
                        <button
                          key={card.id}
                          type="button"
                          onClick={() => handleSelectCard(card)}
                          className={cn(
                            "flex w-full items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors",
                            active
                              ? "bg-primary/15 font-medium text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                        >
                          <span className="truncate">{card.title.replace(/^.+?·\s*/, "")}</span>
                          {card.source !== "builtin" ? (
                            <span
                              className={cn(
                                "shrink-0 rounded px-1 py-0.5 text-3xs",
                                card.source === "project"
                                  ? "bg-info/15 text-info"
                                  : "bg-success/15 text-success",
                              )}
                            >
                              {card.source === "project" ? gt("项目") : gt("自定")}
                            </span>
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </div>

            {selectedCard ? (
              <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card/40 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-sm font-semibold">{selectedCard.title}</h3>
                      <Badge variant="outline" size="sm">
                        {selectedCard.id}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {selectedCard.description}
                    </p>
                  </div>
                  {projectCardsDir ? (
                    <div className="flex items-center gap-1">
                      <SegmentedButton
                        active={cardScope === "user"}
                        onClick={() => setCardScope("user")}
                        label={gt("全局 (~/.t3)")}
                      />
                      <SegmentedButton
                        active={cardScope === "project"}
                        onClick={() => setCardScope("project")}
                        label={gt("当前项目 (.t3)")}
                      />
                    </div>
                  ) : null}
                </div>

                <div className="text-2xs text-muted-foreground">
                  <T>存储位置：</T>
                  <code className="ml-1 rounded bg-muted px-1 py-0.5 font-mono">
                    {cardScope === "project" && projectCardsDir
                      ? `${projectCardsDir}/${selectedCard.id}.md`
                      : `${userCardsDir || "~/.t3/userdata/orchestration/cards"}/${selectedCard.id}.md`}
                  </code>
                </div>

                <Textarea
                  size="sm"
                  value={cardEditorText}
                  onChange={(event) => setCardEditorText(event.target.value)}
                  rows={12}
                  className="flex-1"
                />

                <div className="flex items-center justify-between gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={cardSaving}
                    onClick={() => void handleResetCard()}
                  >
                    <RotateCcwIcon className="size-3.5" />
                    <span>
                      <T>恢复默认</T>
                    </span>
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    disabled={cardSaving}
                    onClick={() => void handleSaveCard()}
                  >
                    <SaveIcon className="size-3.5" />
                    <span>{cardSaving ? gt("保存中…") : gt("保存卡片")}</span>
                  </Button>
                </div>
              </div>
            ) : null}
          </div>
        )}
      </DialogPanel>

      <DialogFooter className="justify-between">
        <div>
          {activeTab === "session" && isExistingThread ? (
            <Button type="button" size="sm" variant="outline" onClick={handleTriggerRetro}>
              <HistoryIcon className="size-3.5" />
              <span>
                <T>复盘本次编排</T>
              </span>
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
            <T>取消</T>
          </Button>
          {activeTab === "session" ? (
            <Button
              type="button"
              size="sm"
              disabled={applying}
              onClick={() => void handleCommitSession()}
            >
              {applying ? gt("应用中…") : gt("应用到本会话")}
            </Button>
          ) : null}
        </div>
      </DialogFooter>
    </DialogPopup>
  );
}
