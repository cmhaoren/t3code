import type {
  EnvironmentId,
  SkillMatrixCell,
  SkillMatrixCellStatus,
  SkillMatrixDiagnostic,
  SkillMatrixEntry,
  SkillMatrixInstance,
  SkillMatrixScope,
  ServerGetSkillsOverviewResult,
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

export interface SkillsMatrixSectionProps {
  readonly environmentId: EnvironmentId;
  readonly refreshToken?: number;
}

type SkillsFilter = "all" | "global" | "missing";

const FILTER_VALUES: ReadonlyArray<SkillsFilter> = ["all", "global", "missing"];
// A minus sign reads as a short dash without shipping an em dash in product copy.
const MISSING_MARK = "\u2212";

function isSkillsFilter(value: string | undefined): value is SkillsFilter {
  return value !== undefined && (FILTER_VALUES as ReadonlyArray<string>).includes(value);
}

function hasMissingCell(
  entry: SkillMatrixEntry,
  instances: ReadonlyArray<SkillMatrixInstance>,
): boolean {
  return instances.some((instance) => entry.cells[instance.instanceId]?.status === "missing");
}

function SkillStatusLabel({ status }: { readonly status: SkillMatrixCellStatus }) {
  const gt = useGT();
  switch (status) {
    case "active":
      return <>{gt("运行态已生效")}</>;
    case "disk_only":
      return <>{gt("仅磁盘存在")}</>;
    case "missing":
      return <>{gt("缺失")}</>;
    case "not_applicable":
      return <>{gt("不适用")}</>;
  }
}

function statusToneClass(status: SkillMatrixCellStatus): string {
  switch (status) {
    case "active":
      return "text-success-foreground";
    case "disk_only":
      return "text-warning-foreground";
    case "missing":
      return "text-muted-foreground";
    case "not_applicable":
      return "text-muted-foreground/60";
  }
}

function coverageToneClass(entry: SkillMatrixEntry): string {
  if (entry.scope !== "global" || entry.totalEnabledCount === 0) return "text-muted-foreground";
  return entry.coveredEnabledCount < entry.totalEnabledCount ? "text-warning" : "text-success";
}

function SkillScopeBadge({ scope }: { readonly scope: SkillMatrixScope }) {
  const gt = useGT();
  const label = scope === "global" ? gt("全局") : scope === "builtin" ? gt("内置") : gt("工作区");
  return (
    <Badge variant="outline" size="sm">
      {label}
    </Badge>
  );
}

function SkillNameCell({
  entry,
  expanded,
}: {
  readonly entry: SkillMatrixEntry;
  readonly expanded: boolean;
}) {
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      {expanded ? (
        <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      ) : (
        <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden />
      )}
      <span className="min-w-0 truncate font-mono font-medium text-foreground">{entry.name}</span>
      <SkillScopeBadge scope={entry.scope} />
    </span>
  );
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
            instance.enabled ? "text-foreground/80" : "text-muted-foreground",
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
          <div className="font-medium">{instance.displayName}</div>
          <div className="font-mono text-3xs text-muted-foreground">{instance.instanceId}</div>
          <div className="font-mono text-3xs text-muted-foreground">{instance.driver}</div>
          {instance.globalSkillDirs.length > 0 ? (
            instance.globalSkillDirs.map((dir) => (
              <div key={dir} className="break-all font-mono text-3xs text-muted-foreground">
                {dir}
              </div>
            ))
          ) : (
            <div className="text-3xs text-muted-foreground">{gt("未配置全局技能目录")}</div>
          )}
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

  if (status === "active") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex size-4 items-center justify-center" />}
        >
          <span className="size-2 rounded-full bg-success" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          <div className="space-y-0.5">
            <div>{gt("运行态已生效")}</div>
            {cell?.path ? (
              <div className="break-all font-mono text-3xs text-muted-foreground">{cell.path}</div>
            ) : null}
          </div>
        </TooltipPopup>
      </Tooltip>
    );
  }

  if (status === "disk_only") {
    return (
      <Tooltip>
        <TooltipTrigger
          render={<span className="inline-flex size-4 items-center justify-center" />}
        >
          <span className="size-2 rounded-full border-2 border-warning" />
        </TooltipTrigger>
        <TooltipPopup side="top">
          <div className="space-y-0.5">
            <div>{gt("仅磁盘目录存在，运行态未上报")}</div>
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
          <span className="text-xs leading-none text-muted-foreground/50">{MISSING_MARK}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          <div className="space-y-0.5">
            <div>{gt("该实例缺失此全局技能")}</div>
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
      <TooltipPopup side="top">{gt("其他驱动私有技能，不适用")}</TooltipPopup>
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
  const rows = instances.flatMap((instance) => {
    const cell = entry.cells[instance.instanceId];
    return cell === undefined || cell.status === "not_applicable" ? [] : [{ instance, cell }];
  });

  return (
    <div className="space-y-1.5 bg-muted/10 px-3 py-2">
      {entry.description ? (
        <p className="text-xs text-muted-foreground">{entry.description}</p>
      ) : null}
      {entry.canonicalPath ? (
        <p className="break-all font-mono text-3xs text-muted-foreground">{entry.canonicalPath}</p>
      ) : null}
      {rows.length > 0 ? (
        <div className="grid gap-1 sm:grid-cols-2">
          {rows.map(({ instance, cell }) => (
            <div
              key={instance.instanceId}
              className="min-w-0 space-y-0.5 rounded-md border border-border/50 px-2 py-1"
            >
              <div className="flex min-w-0 items-center gap-1.5 text-2xs">
                <span className="min-w-0 truncate font-medium text-foreground/80">
                  {instance.displayName}
                </span>
                <span className={cn("shrink-0", statusToneClass(cell.status))}>
                  <SkillStatusLabel status={cell.status} />
                </span>
              </div>
              {cell.path ? (
                <div className="break-all font-mono text-3xs text-muted-foreground">
                  {cell.path}
                </div>
              ) : null}
              {cell.linkTarget ? (
                <div className="break-all font-mono text-3xs text-muted-foreground">
                  → {cell.linkTarget}
                </div>
              ) : null}
              {cell.reason ? (
                <div className="text-3xs text-muted-foreground">{cell.reason}</div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function DiagnosticBanner({ diagnostic }: { readonly diagnostic: SkillMatrixDiagnostic }) {
  const gt = useGT();
  const warning = diagnostic.severity === "warning";
  const Icon = warning ? TriangleAlertIcon : InfoIcon;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-md border px-2 py-1 text-xs",
              warning
                ? "border-warning/40 bg-warning/5 text-warning-foreground"
                : "border-border/60 bg-muted/20 text-muted-foreground",
            )}
          />
        }
      >
        <Icon className="size-3 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{diagnostic.message}</span>
        {diagnostic.detail ? (
          <span className="hidden max-w-[45%] min-w-0 truncate text-3xs opacity-70 sm:inline">
            {diagnostic.detail}
          </span>
        ) : null}
        <span className="sr-only">{gt("查看诊断详情")}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="space-y-0.5">
          <div>{diagnostic.message}</div>
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
  expandedSkills,
  onToggleSkill,
}: {
  readonly skills: ReadonlyArray<SkillMatrixEntry>;
  readonly instances: ReadonlyArray<SkillMatrixInstance>;
  readonly checkedAt: string;
  readonly expandedSkills: Readonly<Record<string, boolean>>;
  readonly onToggleSkill: (name: string) => void;
}) {
  const gt = useGT();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const columnCount = instances.length + 2;

  return (
    <div className="overflow-x-auto rounded-lg border border-border/60">
      <table className="w-full min-w-max border-collapse text-xs">
        <thead>
          <tr className="bg-muted/20 text-2xs text-muted-foreground">
            <th scope="col" className="min-w-[168px] px-2 py-1.5 text-left font-medium">
              {gt("技能")}
            </th>
            <th scope="col" className="w-16 px-1 py-1.5 text-center font-medium">
              {gt("覆盖")}
            </th>
            {instances.map((instance) => (
              <th
                key={instance.instanceId}
                scope="col"
                className="min-w-[54px] px-1 py-1.5 text-center align-bottom font-medium"
              >
                <InstanceColumnHeader instance={instance} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {skills.map((entry) => {
            const expanded = expandedSkills[entry.name] ?? false;
            return (
              <Fragment key={entry.name}>
                <tr
                  tabIndex={0}
                  aria-expanded={expanded}
                  className={cn(
                    "cursor-pointer border-t border-border/40 outline-none hover:bg-muted/20 focus-visible:bg-muted/30",
                    expanded && "bg-muted/10",
                  )}
                  onClick={() => onToggleSkill(entry.name)}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onToggleSkill(entry.name);
                  }}
                >
                  <td className="min-w-[168px] px-2 py-2">
                    <SkillNameCell entry={entry} expanded={expanded} />
                  </td>
                  <td
                    className={cn(
                      "w-16 px-1 py-2 text-center font-mono tabular-nums",
                      coverageToneClass(entry),
                    )}
                  >
                    {entry.coveredEnabledCount}/{entry.totalEnabledCount}
                  </td>
                  {instances.map((instance) => (
                    <td key={instance.instanceId} className="min-w-[54px] px-1 py-2 text-center">
                      <CellStatusMarker cell={entry.cells[instance.instanceId]} />
                    </td>
                  ))}
                </tr>
                {expanded ? (
                  <tr className="border-t border-border/30">
                    <td colSpan={columnCount} className="p-0">
                      <SkillDetailRow entry={entry} instances={instances} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border/50 px-2 py-1 text-3xs text-muted-foreground">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-full bg-success" aria-hidden />
            {gt("运行态生效")}
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <span className="size-2 rounded-full border-2 border-warning" aria-hidden />
            {gt("仅磁盘存在")}
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <span className="text-muted-foreground/50">{MISSING_MARK}</span>
            {gt("缺失")}
          </span>
          <span aria-hidden>·</span>
          <span className="inline-flex items-center gap-1">
            <span className="text-muted-foreground/30">·</span>
            {gt("不适用")}
          </span>
        </span>
        <span className="tabular-nums">
          {gt("最近检查：{time}", { time: formatDateTimeTimestamp(checkedAt, timestampFormat) })}
        </span>
      </div>
    </div>
  );
}

export function SkillsMatrixSection({ environmentId, refreshToken }: SkillsMatrixSectionProps) {
  const gt = useGT();
  const getSkillsOverview = useAtomCommand(serverEnvironment.getSkillsOverview, {
    reportFailure: false,
  });

  const [overview, setOverview] = useState<ServerGetSkillsOverviewResult | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<SkillsFilter>("global");
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [expandedSkills, setExpandedSkills] = useState<Readonly<Record<string, boolean>>>({});
  const loadGeneration = useRef(0);

  const errorText = useStableCallback((error: unknown) =>
    error instanceof Error
      ? (thrownErrorMessage(error, resolveNow) ?? error.message)
      : gt("无法读取技能覆盖。"),
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

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the coverage matrix from the server on mount and when the refresh token changes; the atom registry holds no such resource
  useEffect(() => {
    loadOverview();
    return () => {
      // Stale responses from a previous environment are discarded by the generation check.
      loadGeneration.current += 1;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reload on environment or refresh token changes; the stable loader reads the environment through its closure
  }, [environmentId, refreshToken, loadOverview]);

  const allSkills = overview?.skills ?? [];
  const instances = (overview?.instances ?? []).filter(
    (instance) => includeDisabled || instance.enabled,
  );
  const globalCount = allSkills.filter((skill) => skill.scope === "global").length;
  const missingCount = allSkills.filter((skill) => hasMissingCell(skill, instances)).length;
  const activeFilter: SkillsFilter = filter === "global" && globalCount === 0 ? "all" : filter;
  const normalizedSearch = search.trim().toLowerCase();
  const visibleSkills = allSkills.filter((skill) => {
    if (activeFilter === "global" && skill.scope !== "global") return false;
    if (activeFilter === "missing" && !hasMissingCell(skill, instances)) return false;
    if (normalizedSearch.length === 0) return true;
    return (
      skill.name.toLowerCase().includes(normalizedSearch) ||
      (skill.description?.toLowerCase().includes(normalizedSearch) ?? false)
    );
  });

  const diagnostics = overview?.diagnostics ?? [];

  const toggleSkill = (name: string) => {
    setExpandedSkills((current) => ({ ...current, [name]: !(current[name] ?? false) }));
  };

  const renderBody = () => {
    if (overview === null) {
      if (isLoading) {
        return (
          <div
            className="flex items-center gap-2 py-2 text-xs text-muted-foreground"
            aria-busy="true"
          >
            <Spinner size="xs" />
            {gt("正在读取技能覆盖…")}
          </div>
        );
      }
      return (
        <div className="flex flex-wrap items-center gap-2 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{errorMessage ?? gt("无法读取技能覆盖。")}</span>
          <Button size="xs" variant="outline" disabled={isLoading} onClick={() => loadOverview()}>
            {gt("重试")}
          </Button>
        </div>
      );
    }

    if (instances.length === 0) {
      return (
        <p className="py-2 text-xs text-muted-foreground">
          {gt("没有已启用的供应商实例，勾选「含已停用实例」查看全部。")}
        </p>
      );
    }

    if (visibleSkills.length === 0) {
      return (
        <p className="py-2 text-xs text-muted-foreground">
          {allSkills.length === 0 ? gt("尚未发现任何技能。") : gt("没有符合筛选条件的技能。")}
        </p>
      );
    }

    return (
      <SkillsMatrixTable
        skills={visibleSkills}
        instances={instances}
        checkedAt={overview.checkedAt}
        expandedSkills={expandedSkills}
        onToggleSkill={toggleSkill}
      />
    );
  };

  return (
    <SettingsSection
      id="provider-skills"
      title={gt("全局技能矩阵")}
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
      <div className="space-y-2 px-3 py-2 sm:px-4">
        <p className="text-pretty text-xs leading-normal text-muted-foreground">
          {gt("汇总各供应商实例的运行态加载与磁盘全局技能覆盖，一眼识别缺失或仅磁盘未生效项。")}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            size="compact"
            className="w-44"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={gt("按技能名或描述搜索")}
            aria-label={gt("搜索技能")}
            spellCheck={false}
          />
          <ToggleGroup
            aria-label={gt("技能筛选")}
            variant="segmented"
            value={[activeFilter]}
            onValueChange={(next) => {
              const selected = next[0];
              if (isSkillsFilter(selected)) setFilter(selected);
            }}
          >
            <Toggle value="all">{gt("全部 ({count})", { count: allSkills.length })}</Toggle>
            <Toggle value="global">{gt("仅全局 ({count})", { count: globalCount })}</Toggle>
            <Toggle value="missing">{gt("有缺失 ({count})", { count: missingCount })}</Toggle>
          </ToggleGroup>
          <Toggle
            variant="outline"
            size="xs"
            pressed={includeDisabled}
            onPressedChange={(pressed) => setIncludeDisabled(Boolean(pressed))}
          >
            {gt("含已停用实例")}
          </Toggle>
        </div>
      </div>

      {diagnostics.length > 0 ? (
        <div className="space-y-1 px-3 pb-2 sm:px-4">
          {diagnostics.map((diagnostic) => (
            <DiagnosticBanner
              key={`${diagnostic.code}:${diagnostic.message}`}
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
