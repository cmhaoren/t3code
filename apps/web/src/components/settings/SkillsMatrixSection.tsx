import type {
  EnvironmentId,
  ServerGetSkillsOverviewResult,
  SkillMatrixCell,
  SkillMatrixCellStatus,
  SkillMatrixDiagnostic,
  SkillMatrixEntry,
  SkillMatrixInstance,
  SkillMatrixScope,
} from "@t3tools/contracts";
import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useGT } from "gt-react";
import { ChevronDownIcon, ChevronRightIcon, InfoIcon, TriangleAlertIcon } from "lucide-react";
import { Fragment, useEffect, useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useStableCallback } from "../../hooks/useStableCallback";
import { m as resolveNow } from "../../i18n/messages";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatDateTimeTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { RefreshIcon } from "../ui/refresh-icon";
import { Spinner } from "../ui/spinner";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsSection } from "./settingsLayout";

interface SkillsMatrixSectionProps {
  readonly environmentId: EnvironmentId;
}

const SCOPE_TABS: ReadonlyArray<SkillMatrixScope> = ["universal", "agent_global", "builtin"];
// Minus sign avoids shipping an em dash in UI copy.
const MISSING_MARK = "\u2212";

interface DriverColumnGroup {
  readonly key: string;
  readonly label: string;
  readonly instances: ReadonlyArray<SkillMatrixInstance>;
}

function isSkillMatrixScope(value: string | undefined): value is SkillMatrixScope {
  return value !== undefined && (SCOPE_TABS as ReadonlyArray<string>).includes(value);
}

function groupInstancesByDriver(
  instances: ReadonlyArray<SkillMatrixInstance>,
): ReadonlyArray<DriverColumnGroup> {
  const groups: Array<{
    readonly key: string;
    readonly label: string;
    readonly instances: Array<SkillMatrixInstance>;
  }> = [];
  const byKey = new Map<
    string,
    {
      readonly key: string;
      readonly label: string;
      readonly instances: Array<SkillMatrixInstance>;
    }
  >();
  for (const instance of instances) {
    let group = byKey.get(instance.driverGroupKey);
    if (!group) {
      group = {
        key: instance.driverGroupKey,
        label: instance.driverGroupLabel,
        instances: [],
      };
      byKey.set(instance.driverGroupKey, group);
      groups.push(group);
    }
    group.instances.push(instance);
  }
  return groups;
}

function hasIssueInDisplayedInstances(
  entry: SkillMatrixEntry,
  instances: ReadonlyArray<SkillMatrixInstance>,
): boolean {
  return instances.some((instance) => {
    const status = entry.cells[instance.instanceId]?.status;
    return status === "missing" || status === "disk_warning";
  });
}

function SkillStatusLabel({ status }: { readonly status: SkillMatrixCellStatus }) {
  const gt = useGT();
  switch (status) {
    case "declared_runtime":
      return <>{gt("运行态已声明")}</>;
    case "declared_disk":
      return <>{gt("目录就绪")}</>;
    case "disk_warning":
      return <>{gt("磁盘异常")}</>;
    case "missing":
      return <>{gt("未挂载 / 声明不到")}</>;
    case "not_applicable":
      return <>{gt("不适用")}</>;
  }
}

function statusToneClass(status: SkillMatrixCellStatus): string {
  switch (status) {
    case "declared_runtime":
      return "text-success-foreground";
    case "declared_disk":
      return "text-info-foreground";
    case "disk_warning":
      return "text-warning-foreground";
    case "missing":
      return "text-muted-foreground";
    case "not_applicable":
      return "text-muted-foreground/60";
  }
}

function coverageToneClass(entry: SkillMatrixEntry): string {
  if (entry.expectedEnabledCount === 0) return "text-muted-foreground";
  if (entry.coveredEnabledCount < entry.expectedEnabledCount) return "text-warning";
  return "text-success";
}

function InstanceColumnHeader({ instance }: { readonly instance: SkillMatrixInstance }) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="inline-flex min-w-0 flex-col items-center gap-0.5" />}
      >
        <span
          className={cn(
            "max-w-[68px] truncate text-2xs font-medium",
            instance.enabled ? "text-foreground/85" : "text-muted-foreground",
          )}
        >
          {instance.displayName}
        </span>
        {instance.enabled ? null : (
          <span className="text-4xs leading-none text-muted-foreground">{gt("已停用")}</span>
        )}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="space-y-0.5">
          <div className="font-medium">
            {instance.displayName} ({instance.driverGroupLabel})
          </div>
          <div className="font-mono text-3xs text-muted-foreground">{instance.instanceId}</div>
          <div className="text-3xs text-muted-foreground">
            {instance.readsUniversalPool
              ? gt("原生扫描 ~/.agents/skills 真全局池")
              : gt("不自动扫描 ~/.agents/skills（需显式挂载）")}
          </div>
          {instance.globalSkillDirs.length > 0 ? (
            <div className="pt-0.5">
              <div className="text-3xs font-medium text-foreground/80">{gt("实际扫描目录：")}</div>
              {instance.globalSkillDirs.map((dir) => (
                <div key={dir} className="break-all font-mono text-3xs text-muted-foreground">
                  {dir}
                </div>
              ))}
            </div>
          ) : null}
          {instance.enabled ? null : (
            <div className="text-3xs text-warning">{gt("该实例已停用")}</div>
          )}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function CellStatusMarker({ cell }: { readonly cell: SkillMatrixCell | undefined }) {
  const gt = useGT();
  const status = cell?.status ?? "not_applicable";

  if (status === "declared_runtime") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex size-4 items-center justify-center" />}
        >
          <span className="size-2 rounded-full bg-success" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          <div className="space-y-0.5">
            <div className="font-medium">{gt("运行态已声明")}</div>
            {cell?.path ? (
              <div className="break-all font-mono text-3xs text-muted-foreground">{cell.path}</div>
            ) : null}
          </div>
        </TooltipPopup>
      </Tooltip>
    );
  }

  if (status === "declared_disk") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex size-4 items-center justify-center" />}
        >
          <span className="inline-flex size-2.5 items-center justify-center rounded-full border border-info">
            <span className="size-1 rounded-full bg-info" />
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          <div className="space-y-0.5">
            <div className="font-medium">{gt("目录就绪（按驱动规则可声明）")}</div>
            {cell?.reason ? <div className="text-muted-foreground">{cell.reason}</div> : null}
            {cell?.path ? (
              <div className="break-all font-mono text-3xs text-muted-foreground">{cell.path}</div>
            ) : null}
            {cell?.linkTarget ? (
              <div className="break-all font-mono text-3xs text-muted-foreground">
                → {cell.linkTarget}
              </div>
            ) : null}
          </div>
        </TooltipPopup>
      </Tooltip>
    );
  }

  if (status === "disk_warning") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex size-4 items-center justify-center" />}
        >
          <TriangleAlertIcon className="size-3 text-warning" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          <div className="space-y-0.5">
            <div className="font-medium text-warning">{gt("磁盘存在但可能未被声明")}</div>
            {cell?.reason ? <div className="text-muted-foreground">{cell.reason}</div> : null}
            {cell?.path ? (
              <div className="break-all font-mono text-3xs text-muted-foreground">{cell.path}</div>
            ) : null}
            {cell?.linkTarget ? (
              <div className="break-all font-mono text-3xs text-muted-foreground">
                → {cell.linkTarget}
              </div>
            ) : null}
          </div>
        </TooltipPopup>
      </Tooltip>
    );
  }

  if (status === "missing") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex size-4 items-center justify-center" />}
        >
          <span className="text-xs leading-none text-muted-foreground/55">{MISSING_MARK}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          <div className="space-y-0.5">
            <div className="font-medium">{gt("未挂载 / 声明不到")}</div>
            {cell?.reason ? <div className="text-muted-foreground">{cell.reason}</div> : null}
          </div>
        </TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex size-4 items-center justify-center" />}>
        <span className="text-3xs leading-none text-muted-foreground/30">·</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="space-y-0.5">
          <div>{gt("不适用")}</div>
          {cell?.reason ? <div className="text-muted-foreground">{cell.reason}</div> : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function SkillDetailRow({
  entry,
  instances,
}: {
  readonly entry: SkillMatrixEntry;
  readonly instances: ReadonlyArray<SkillMatrixInstance>;
}) {
  const gt = useGT();
  const rows = instances.flatMap((instance) => {
    const cell = entry.cells[instance.instanceId];
    return cell === undefined || cell.status === "not_applicable" ? [] : [{ instance, cell }];
  });

  return (
    <div className="space-y-2 border-t bg-muted/20 px-3 py-2.5 text-xs">
      {entry.description ? (
        <p className="text-pretty leading-relaxed text-muted-foreground">{entry.description}</p>
      ) : null}
      {entry.canonicalPath ? (
        <div className="flex flex-wrap items-baseline gap-1.5 text-2xs">
          <span className="shrink-0 font-medium text-foreground/75">{gt("源路径：")}</span>
          <span className="break-all font-mono text-muted-foreground">{entry.canonicalPath}</span>
        </div>
      ) : null}
      {rows.length > 0 ? (
        <div className="divide-y divide-border/50 rounded-md border bg-background/70">
          {rows.map(({ instance, cell }) => (
            <div
              key={instance.instanceId}
              className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 px-2.5 py-1.5 text-2xs"
            >
              <span className="min-w-28 shrink-0 font-medium text-foreground">
                {instance.driverGroupLabel} · {instance.displayName}
              </span>
              <span className={cn("shrink-0 font-medium", statusToneClass(cell.status))}>
                <SkillStatusLabel status={cell.status} />
              </span>
              {cell.path ? (
                <span className="min-w-0 break-all font-mono text-muted-foreground">
                  {cell.path}
                  {cell.linkTarget ? ` → ${cell.linkTarget}` : ""}
                </span>
              ) : null}
              {cell.reason ? (
                <span className="min-w-0 text-muted-foreground">{cell.reason}</span>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DiagnosticBanner({ diagnostic }: { readonly diagnostic: SkillMatrixDiagnostic }) {
  const isWarning = diagnostic.severity === "warning";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
              isWarning
                ? "border-warning/40 bg-warning/5 text-warning-foreground"
                : "border-border bg-muted/40 text-muted-foreground",
            )}
          />
        }
      >
        {isWarning ? (
          <TriangleAlertIcon className="size-3.5 shrink-0 text-warning" aria-hidden />
        ) : (
          <InfoIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        )}
        <span className="min-w-0 flex-1 truncate">{diagnostic.message}</span>
        {diagnostic.detail ? (
          <span className="hidden max-w-64 shrink-0 truncate font-mono text-2xs opacity-80 sm:inline">
            {diagnostic.detail}
          </span>
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="max-w-96 space-y-1">
          <div className="font-medium">{diagnostic.message}</div>
          {diagnostic.detail ? (
            <div className="break-all font-mono text-3xs text-muted-foreground">
              {diagnostic.detail}
            </div>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

function SkillsMatrixTable({
  skills,
  instances,
  checkedAt,
  showOwnerBadges,
  expandedSkills,
  onToggleSkill,
}: {
  readonly skills: ReadonlyArray<SkillMatrixEntry>;
  readonly instances: ReadonlyArray<SkillMatrixInstance>;
  readonly checkedAt: string;
  readonly showOwnerBadges: boolean;
  readonly expandedSkills: Readonly<Record<string, boolean>>;
  readonly onToggleSkill: (name: string) => void;
}) {
  const gt = useGT();
  const timestampFormat = useClientSettings().timestampFormat;
  const checkedLabel = formatDateTimeTimestamp(checkedAt, timestampFormat);
  const groups = groupInstancesByDriver(instances);
  const totalColumns = instances.length + 2;

  return (
    <div className="overflow-hidden rounded-lg border">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b bg-muted/40 text-2xs font-medium text-muted-foreground">
              <th rowSpan={2} className="min-w-[180px] px-3 py-1.5 text-left align-bottom">
                {gt("技能")}
              </th>
              <th rowSpan={2} className="w-16 px-2 py-1.5 text-center align-bottom">
                {gt("覆盖")}
              </th>
              {groups.map((group) => (
                <th
                  key={group.key}
                  colSpan={group.instances.length}
                  className="border-l border-border/60 px-2 py-1 text-center text-3xs font-semibold text-foreground/75"
                >
                  {group.label}
                </th>
              ))}
            </tr>
            <tr className="border-b bg-muted/25 text-2xs font-medium text-muted-foreground">
              {groups.flatMap((group) =>
                group.instances.map((instance, idx) => (
                  <th
                    key={instance.instanceId}
                    className={cn(
                      "min-w-[56px] px-1.5 py-1 text-center font-normal",
                      idx === 0 && "border-l border-border/60",
                    )}
                  >
                    <InstanceColumnHeader instance={instance} />
                  </th>
                )),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {skills.map((entry) => {
              const expanded = expandedSkills[entry.name] === true;
              return (
                <Fragment key={entry.name}>
                  <tr
                    tabIndex={0}
                    aria-expanded={expanded}
                    onClick={() => onToggleSkill(entry.name)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        onToggleSkill(entry.name);
                      }
                    }}
                    className={cn(
                      "cursor-pointer transition-colors hover:bg-muted/35 focus-visible:bg-muted/35 focus-visible:outline-none",
                      expanded && "bg-muted/25",
                    )}
                  >
                    <td className="px-3 py-2 align-middle">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {expanded ? (
                          <ChevronDownIcon
                            className="size-3 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                        ) : (
                          <ChevronRightIcon
                            className="size-3 shrink-0 text-muted-foreground"
                            aria-hidden
                          />
                        )}
                        <span className="min-w-0 truncate font-mono font-medium text-foreground">
                          {entry.name}
                        </span>
                        {showOwnerBadges
                          ? entry.ownerGroupLabels.map((label) => (
                              <Badge key={label} variant="outline" size="sm">
                                {label}
                              </Badge>
                            ))
                          : null}
                      </span>
                    </td>
                    <td
                      className={cn(
                        "px-2 py-2 text-center align-middle font-mono text-2xs tabular-nums",
                        coverageToneClass(entry),
                      )}
                    >
                      {entry.coveredEnabledCount}/{entry.expectedEnabledCount}
                    </td>
                    {groups.flatMap((group) =>
                      group.instances.map((instance, idx) => (
                        <td
                          key={instance.instanceId}
                          className={cn(
                            "px-1.5 py-2 text-center align-middle",
                            idx === 0 && "border-l border-border/40",
                          )}
                        >
                          <CellStatusMarker cell={entry.cells[instance.instanceId]} />
                        </td>
                      )),
                    )}
                  </tr>
                  {expanded ? (
                    <tr>
                      <td colSpan={totalColumns} className="p-0">
                        <SkillDetailRow entry={entry} instances={instances} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-3 py-1.5 text-3xs text-muted-foreground">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
          <span className="inline-flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-success" />
            {gt("运行态已声明")}
          </span>
          <span className="inline-flex items-center gap-1">
            <span className="inline-flex size-2 items-center justify-center rounded-full border border-info">
              <span className="size-0.5 rounded-full bg-info" />
            </span>
            {gt("目录就绪")}
          </span>
          <span className="inline-flex items-center gap-1">
            <TriangleAlertIcon className="size-2.5 text-warning" aria-hidden />
            {gt("磁盘异常")}
          </span>
          <span>
            {MISSING_MARK} {gt("缺失")}
          </span>
          <span>· {gt("不适用")}</span>
        </div>
        <span className="tabular-nums">{gt("最近检查：{time}", { time: checkedLabel })}</span>
      </div>
    </div>
  );
}

export function SkillsMatrixSection({ environmentId }: SkillsMatrixSectionProps) {
  const gt = useGT();
  const getSkillsOverview = useAtomCommand(serverEnvironment.getSkillsOverview, {
    reportFailure: false,
  });

  const [overview, setOverview] = useState<ServerGetSkillsOverviewResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [activeScopeTab, setActiveScopeTab] = useState<SkillMatrixScope>("universal");
  const [search, setSearch] = useState("");
  const [issuesOnly, setIssuesOnly] = useState(false);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [expandedSkills, setExpandedSkills] = useState<Readonly<Record<string, boolean>>>({});
  const loadGeneration = useRef(0);

  const errorText = useStableCallback((error: unknown) =>
    error instanceof Error
      ? (thrownErrorMessage(error, resolveNow) ?? error.message)
      : gt("无法读取技能声明状态。"),
  );

  const loadOverview = useStableCallback(() => {
    const generation = ++loadGeneration.current;
    setIsLoading(true);
    setErrorMessage(null);
    void getSkillsOverview({ environmentId, input: {} }).then((result) => {
      if (loadGeneration.current !== generation) return;
      setIsLoading(false);
      if (result._tag === "Success") {
        setOverview(result.value);
        return;
      }
      if (isAtomCommandInterrupted(result)) return;
      setErrorMessage(errorText(squashAtomCommandFailure(result)));
    });
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the global skills overview from the server on mount and environment switch; no reactive atom backs this scan
  useEffect(() => {
    loadOverview();
    return () => {
      loadGeneration.current += 1;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reload only when environmentId changes; loadOverview is a stable callback
  }, [environmentId, loadOverview]);

  const allSkills = overview?.skills ?? [];
  const instances = (overview?.instances ?? []).filter(
    (instance) => includeDisabled || instance.enabled,
  );
  const universalSkills = allSkills.filter((skill) => skill.scope === "universal");
  const agentGlobalSkills = allSkills.filter((skill) => skill.scope === "agent_global");
  const builtinSkills = allSkills.filter((skill) => skill.scope === "builtin");

  const effectiveTab: SkillMatrixScope =
    activeScopeTab === "universal" && universalSkills.length === 0 && agentGlobalSkills.length > 0
      ? "agent_global"
      : activeScopeTab;

  const scopedSkills =
    effectiveTab === "universal"
      ? universalSkills
      : effectiveTab === "agent_global"
        ? agentGlobalSkills
        : builtinSkills;

  const issueCountInTab = scopedSkills.filter((skill) =>
    hasIssueInDisplayedInstances(skill, instances),
  ).length;

  const normalizedSearch = search.trim().toLowerCase();
  const visibleSkills = scopedSkills.filter((skill) => {
    if (issuesOnly && !hasIssueInDisplayedInstances(skill, instances)) return false;
    if (normalizedSearch.length === 0) return true;
    return (
      skill.name.toLowerCase().includes(normalizedSearch) ||
      (skill.description?.toLowerCase().includes(normalizedSearch) ?? false) ||
      skill.ownerGroupLabels.some((label) => label.toLowerCase().includes(normalizedSearch))
    );
  });

  const diagnostics = overview?.diagnostics ?? [];

  const toggleSkill = (name: string) => {
    setExpandedSkills((current) => ({ ...current, [name]: !(current[name] ?? false) }));
  };

  const tabHint =
    effectiveTab === "universal"
      ? gt("来源：{dir}（跨 Agent 通用池，预期所有已启用实例都应声明到）", {
          dir: overview?.universalPoolDir ?? "~/.agents/skills",
        })
      : effectiveTab === "agent_global"
        ? gt("仅位于某类 Agent 专属全局目录的技能，只校验同驱动各实例覆盖，其他驱动标记为不适用。")
        : gt("各驱动自带的内置技能，仅在该驱动下声明。");

  const renderBody = () => {
    if (overview === null) {
      if (isLoading) {
        return (
          <div
            className="flex items-center gap-2 py-4 text-xs text-muted-foreground"
            aria-busy="true"
          >
            <Spinner size="xs" />
            {gt("正在扫描各 Agent 全局技能目录…")}
          </div>
        );
      }
      return (
        <div className="flex flex-wrap items-center gap-2 py-4 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{errorMessage ?? gt("无法读取技能声明状态。")}</span>
          <Button size="xs" variant="outline" disabled={isLoading} onClick={() => loadOverview()}>
            {gt("重试")}
          </Button>
        </div>
      );
    }

    if (instances.length === 0) {
      return (
        <p className="py-4 text-xs text-muted-foreground">
          {gt("没有已启用的智能体实例，打开「含已停用实例」查看全部。")}
        </p>
      );
    }

    if (visibleSkills.length === 0) {
      return (
        <p className="py-4 text-xs text-muted-foreground">
          {scopedSkills.length === 0
            ? gt("当前分层下暂无技能。")
            : gt("当前筛选条件下没有匹配的技能。")}
        </p>
      );
    }

    return (
      <SkillsMatrixTable
        skills={visibleSkills}
        instances={instances}
        checkedAt={overview.checkedAt}
        showOwnerBadges={effectiveTab === "agent_global"}
        expandedSkills={expandedSkills}
        onToggleSkill={toggleSkill}
      />
    );
  };

  return (
    <SettingsSection
      id="skills-overview"
      title={gt("全局技能覆盖")}
      headerAction={
        <Button
          size="xs"
          variant="outline"
          disabled={isLoading}
          aria-busy={isLoading}
          onClick={() => loadOverview()}
        >
          <RefreshIcon refreshing={isLoading} />
          {gt("刷新")}
        </Button>
      }
    >
      <div className="space-y-2.5 px-3 py-2.5 sm:px-4">
        <p className="text-pretty text-xs leading-normal text-muted-foreground">
          {gt(
            "按「真全局池 / Agent 专属全局 / 驱动内置」分层展示每个技能在各 Agent 实例中的真实声明状态（不统计单项目技能）。",
          )}
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup
            aria-label={gt("技能分层")}
            variant="segmented"
            value={[effectiveTab]}
            onValueChange={(next) => {
              const selected = next[0];
              if (isSkillMatrixScope(selected)) setActiveScopeTab(selected);
            }}
          >
            <Toggle value="universal">
              {gt("真全局 ({count})", { count: universalSkills.length })}
            </Toggle>
            <Toggle value="agent_global">
              {gt("Agent 专属 ({count})", { count: agentGlobalSkills.length })}
            </Toggle>
            <Toggle value="builtin">
              {gt("驱动内置 ({count})", { count: builtinSkills.length })}
            </Toggle>
          </ToggleGroup>

          <Input
            size="compact"
            className="w-44"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={gt("搜索技能或驱动")}
            aria-label={gt("搜索技能")}
            spellCheck={false}
          />

          <Toggle
            variant="outline"
            size="xs"
            pressed={issuesOnly}
            onPressedChange={(pressed) => setIssuesOnly(Boolean(pressed))}
          >
            {gt("仅看缺失/异常 ({count})", { count: issueCountInTab })}
          </Toggle>

          <Toggle
            variant="outline"
            size="xs"
            pressed={includeDisabled}
            onPressedChange={(pressed) => setIncludeDisabled(Boolean(pressed))}
          >
            {gt("含已停用实例")}
          </Toggle>
        </div>

        <p className="font-mono text-3xs text-muted-foreground">{tabHint}</p>
      </div>

      {diagnostics.length > 0 ? (
        <div className="space-y-1 px-3 pb-2.5 sm:px-4">
          {diagnostics.map((diagnostic) => (
            <DiagnosticBanner
              key={`${diagnostic.code}:${diagnostic.message}:${diagnostic.detail ?? ""}`}
              diagnostic={diagnostic}
            />
          ))}
        </div>
      ) : null}

      {overview !== null && errorMessage !== null ? (
        <div className="flex flex-wrap items-center gap-2 px-3 pb-2 text-xs text-warning sm:px-4">
          <span className="min-w-0 flex-1">{errorMessage}</span>
          <Button size="xs" variant="outline" disabled={isLoading} onClick={() => loadOverview()}>
            {gt("重试")}
          </Button>
        </div>
      ) : null}

      <div className="px-3 pb-3 sm:px-4">{renderBody()}</div>
    </SettingsSection>
  );
}
