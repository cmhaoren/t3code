import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import type {
  EnvironmentId,
  OrchestrationV2GetThreadSessionStatsResult,
  ThreadId,
} from "@t3tools/contracts";
import { useGT, useLocale } from "gt-react";
import { DatabaseIcon, GaugeIcon } from "lucide-react";
import { memo, type ReactNode, useEffect, useRef } from "react";

import { cn } from "~/lib/utils";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  computeContextSegments,
  formatCompactTokenCount,
  formatExactTokenCount,
  formatStatDuration,
  formatTokensPerSecond,
  resolveEffectiveContextBreakdown,
  type ContextSegmentKey,
  type ThreadSessionStatsContextBreakdown,
  type ThreadSessionStatsData,
  type ThreadSessionStatsTokenUsage,
} from "./ComposerSessionStatsBar.logic";

export interface ComposerSessionStatsBarProps {
  readonly stats: ThreadSessionStatsData | null;
  readonly liveContextWindow?: ContextWindowSnapshot | null;
  readonly onOpenStats?: (() => void) | undefined;
  readonly className?: string;
}

const pillClassName =
  "inline-flex h-6 cursor-pointer items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground tabular-nums transition-colors hover:bg-accent/70 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-accent/80 data-popup-open:text-foreground";

const SEGMENT_CLASS: Record<ContextSegmentKey, string> = {
  systemAndTools: "h-full min-w-0.5 bg-muted-foreground/60",
  toolContext: "h-full min-w-0.5 bg-violet-500",
  messages: "h-full min-w-0.5 bg-blue-500",
  total: "h-full min-w-0.5 bg-foreground/70",
};

/** Re-reads the thread's counters only when a reader opens a breakdown. */
function openStatsOnOpen(onOpenStats: (() => void) | undefined): (open: boolean) => void {
  return (open) => {
    if (open) onOpenStats?.();
  };
}

const SWATCH_CLASS: Record<ContextSegmentKey, string> = {
  systemAndTools: "size-2 shrink-0 rounded-xs bg-muted-foreground/60",
  toolContext: "size-2 shrink-0 rounded-xs bg-violet-500",
  messages: "size-2 shrink-0 rounded-xs bg-blue-500",
  total: "size-2 shrink-0 rounded-xs bg-foreground/70",
};

export function ComposerSessionStatsBar({
  stats,
  liveContextWindow = null,
  onOpenStats,
  className,
}: ComposerSessionStatsBarProps) {
  const turns = stats?.turns ?? 0;
  const steps = stats?.steps ?? 0;
  const tokenUsage = stats?.tokenUsage ?? null;
  const effectiveContext = resolveEffectiveContextBreakdown(
    stats?.contextBreakdown ?? null,
    liveContextWindow,
  );
  const showActivity = turns > 0 || steps > 0;
  const showUsage = tokenUsage !== null && tokenUsage.totalTokens > 0;
  const showContext = effectiveContext !== null;
  if (!showActivity && !showUsage && !showContext) return null;

  return (
    <div
      data-slot="composer-session-stats"
      className={cn(
        "surface-glass relative flex w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 px-2 pt-1.5 text-xs text-muted-foreground",
        className,
      )}
    >
      {showActivity ? (
        <ActivityPill
          turns={turns}
          steps={steps}
          llmDurationMs={stats?.llmDurationMs ?? 0}
          toolDurationMs={stats?.toolDurationMs ?? 0}
          tokensPerSecond={stats?.tokensPerSecond ?? null}
          onOpenStats={onOpenStats}
        />
      ) : null}
      {showUsage ? <UsagePill tokenUsage={tokenUsage} onOpenStats={onOpenStats} /> : null}
      {effectiveContext !== null ? (
        <ContextPill breakdown={effectiveContext} onOpenStats={onOpenStats} />
      ) : null}
    </div>
  );
}

function ActivityPill({
  turns,
  steps,
  llmDurationMs,
  toolDurationMs,
  tokensPerSecond,
  onOpenStats,
}: {
  readonly turns: number;
  readonly steps: number;
  readonly llmDurationMs: number;
  readonly toolDurationMs: number;
  readonly tokensPerSecond: number | null;
  readonly onOpenStats?: (() => void) | undefined;
}) {
  const gt = useGT();
  const hasTiming = llmDurationMs > 0 || toolDurationMs > 0 || tokensPerSecond !== null;

  return (
    <Popover onOpenChange={openStatsOnOpen(onOpenStats)}>
      <PopoverTrigger
        data-session-stat="activity"
        render={<button className={pillClassName} type="button" />}
      >
        <GaugeIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-75" />
        <span>{gt("{turns} turns {steps} steps", { turns, steps })}</span>
        {tokensPerSecond !== null ? (
          <>
            <span aria-hidden="true" className="opacity-50">
              ·
            </span>
            <span>{gt("{tps} tok/s", { tps: formatTokensPerSecond(tokensPerSecond) })}</span>
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="start" className="min-w-60" padding="compact" side="top" sideOffset={8}>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <GaugeIcon aria-hidden="true" className="size-3.5 opacity-75" />
            {gt("Session stats")}
          </span>
          <span className="text-muted-foreground tabular-nums">
            {gt("{turns} turns {steps} steps", { turns, steps })}
          </span>
        </div>
        <div className="my-2 h-px bg-border/60" />
        {hasTiming ? (
          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-xs">
            {llmDurationMs > 0 ? (
              <StatRow label={gt("Model time")} value={<DurationValue ms={llmDurationMs} />} />
            ) : null}
            {toolDurationMs > 0 ? (
              <StatRow label={gt("Tool time")} value={<DurationValue ms={toolDurationMs} />} />
            ) : null}
            {tokensPerSecond !== null ? (
              <StatRow
                label={gt("Output speed")}
                value={gt("{tps} tok/s", { tps: formatTokensPerSecond(tokensPerSecond) })}
              />
            ) : null}
          </dl>
        ) : (
          <p className="text-muted-foreground text-xs">
            {gt("Timing appears after model output completes.")}
          </p>
        )}
      </PopoverPopup>
    </Popover>
  );
}

function UsagePill({
  tokenUsage,
  onOpenStats,
}: {
  readonly tokenUsage: ThreadSessionStatsTokenUsage;
  readonly onOpenStats?: (() => void) | undefined;
}) {
  const gt = useGT();
  const locale = useLocale();
  const exact = (tokens: number) => formatExactTokenCount(tokens, locale);

  return (
    <Popover onOpenChange={openStatsOnOpen(onOpenStats)}>
      <PopoverTrigger
        data-session-stat="usage"
        render={<button className={pillClassName} type="button" />}
      >
        <DatabaseIcon aria-hidden="true" className="size-3.5 shrink-0 opacity-75" />
        <span>{gt("{count} tok", { count: formatCompactTokenCount(tokenUsage.totalTokens) })}</span>
        {tokenUsage.cacheHitPercent !== null ? (
          <>
            <span aria-hidden="true" className="opacity-50">
              ·
            </span>
            <span>{gt("Cache hit {percent}%", { percent: tokenUsage.cacheHitPercent })}</span>
          </>
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="center" className="min-w-64" padding="compact" side="top" sideOffset={8}>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="flex items-center gap-1.5 font-medium text-foreground">
            <DatabaseIcon aria-hidden="true" className="size-3.5 opacity-75" />
            {gt("Token usage")}
          </span>
          <span className="font-semibold text-foreground tabular-nums">
            {gt("{count} tok", { count: exact(tokenUsage.totalTokens) })}
          </span>
        </div>
        <div className="my-2 h-px bg-border/60" />
        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-xs">
          {tokenUsage.cacheHitPercent !== null ? (
            <StatRow
              label={gt("Cache hit")}
              value={gt("{percent}%", { percent: tokenUsage.cacheHitPercent })}
            />
          ) : null}
          <StatRow
            label={gt("Uncached input")}
            value={gt("{count} tok", { count: exact(tokenUsage.uncachedInputTokens) })}
          />
          <StatRow
            label={gt("Cache read")}
            value={gt("{count} tok", { count: exact(tokenUsage.cacheReadTokens) })}
          />
          {tokenUsage.cacheWriteTokens > 0 ? (
            <StatRow
              label={gt("Cache write")}
              value={gt("{count} tok", { count: exact(tokenUsage.cacheWriteTokens) })}
            />
          ) : null}
          <StatRow
            label={gt("Output")}
            value={gt("{count} tok", { count: exact(tokenUsage.outputTokens) })}
          />
          {tokenUsage.reasoningTokens > 0 ? (
            <StatRow
              muted
              label={gt("Reasoning (in output)")}
              value={gt("{count} tok", { count: exact(tokenUsage.reasoningTokens) })}
            />
          ) : null}
        </dl>
      </PopoverPopup>
    </Popover>
  );
}

function ContextPill({
  breakdown,
  onOpenStats,
}: {
  readonly breakdown: ThreadSessionStatsContextBreakdown;
  readonly onOpenStats?: (() => void) | undefined;
}) {
  const gt = useGT();
  const { percent, tone, autoCompactPercent, segments } = computeContextSegments(breakdown);
  const radius = 5.5;
  const circumference = 2 * Math.PI * radius;
  const ringClassName =
    tone === "error"
      ? "stroke-error"
      : tone === "warning"
        ? "stroke-warning"
        : "stroke-foreground/75";
  const hasSegments =
    breakdown.systemAndToolsTokens + breakdown.toolContextTokens + breakdown.messageTokens > 0;

  return (
    <Popover onOpenChange={openStatsOnOpen(onOpenStats)}>
      <PopoverTrigger
        data-session-stat="context"
        render={<button className={pillClassName} type="button" />}
      >
        <svg aria-hidden="true" className="size-3.5 shrink-0" fill="none" viewBox="0 0 14 14">
          <circle className="stroke-muted-foreground/25" cx="7" cy="7" r={radius} strokeWidth={2} />
          <circle
            className={ringClassName}
            cx="7"
            cy="7"
            r={radius}
            strokeDasharray={`${(circumference * (percent ?? 0)) / 100} ${circumference}`}
            strokeLinecap="round"
            strokeWidth={2}
            transform="rotate(-90 7 7)"
          />
        </svg>
        <span>
          {percent !== null ? `${percent}%` : formatCompactTokenCount(breakdown.usedTokens)}
        </span>
      </PopoverTrigger>
      <PopoverPopup align="end" className="min-w-64" padding="compact" side="top" sideOffset={8}>
        <div className="flex items-center justify-between gap-3 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="text-muted-foreground">{gt("Context used")}</span>
            {percent !== null ? (
              <span className="font-semibold text-foreground tabular-nums">{percent}%</span>
            ) : null}
          </span>
          <span className="font-semibold text-foreground tabular-nums">
            {breakdown.maxTokens !== null
              ? gt("~{used} / {max}", {
                  used: formatCompactTokenCount(breakdown.usedTokens),
                  max: formatCompactTokenCount(breakdown.maxTokens),
                })
              : gt("~{used}", { used: formatCompactTokenCount(breakdown.usedTokens) })}
          </span>
        </div>
        <div className="relative my-2.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
          <div className="flex h-full gap-px">
            {segments
              .filter((segment) => segment.widthPercent > 0)
              .map((segment) => (
                <span
                  aria-hidden="true"
                  className={SEGMENT_CLASS[segment.key]}
                  data-session-stat-segment={segment.key}
                  key={segment.key}
                  style={{ width: `${segment.widthPercent}%` }}
                />
              ))}
          </div>
          {autoCompactPercent !== null ? (
            <span
              aria-hidden="true"
              className="absolute inset-y-0 w-px bg-foreground/40"
              style={{ left: `${autoCompactPercent}%` }}
            />
          ) : null}
        </div>
        {hasSegments ? (
          <dl className="flex flex-col gap-1.5 text-xs">
            <LegendRow
              label={gt("System & tool overhead")}
              swatch="systemAndTools"
              value={gt("~{count}", {
                count: formatCompactTokenCount(breakdown.systemAndToolsTokens),
              })}
            />
            <LegendRow
              label={gt("Tool calls & output")}
              swatch="toolContext"
              value={gt("~{count}", {
                count: formatCompactTokenCount(breakdown.toolContextTokens),
              })}
            />
            <LegendRow
              label={gt("Conversation messages")}
              swatch="messages"
              value={gt("~{count}", { count: formatCompactTokenCount(breakdown.messageTokens) })}
            />
          </dl>
        ) : null}
        {breakdown.autoCompactThreshold !== null ? (
          <p className="mt-2 text-muted-foreground text-xs">
            {gt("Auto-compacts around ~{tokens}", {
              tokens: formatCompactTokenCount(breakdown.autoCompactThreshold),
            })}
          </p>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function StatRow({
  label,
  value,
  muted = false,
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <>
      <dt className={muted ? "text-muted-foreground/70" : "text-muted-foreground"}>{label}</dt>
      <dd
        className={cn("text-end tabular-nums", muted ? "text-muted-foreground" : "text-foreground")}
      >
        {value}
      </dd>
    </>
  );
}

function LegendRow({
  swatch,
  label,
  value,
}: {
  readonly swatch: ContextSegmentKey;
  readonly label: ReactNode;
  readonly value: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden="true" className={SWATCH_CLASS[swatch]} />
      <dt className="min-w-0 flex-1 text-muted-foreground">{label}</dt>
      <dd className="text-foreground tabular-nums">{value}</dd>
    </div>
  );
}

function DurationValue({ ms }: { readonly ms: number }) {
  const gt = useGT();
  const duration = formatStatDuration(ms);
  if (duration.kind === "ms") return <>{gt("{value} ms", { value: duration.value })}</>;
  if (duration.kind === "s") return <>{gt("{seconds}s", { seconds: duration.value })}</>;
  return (
    <>
      {gt("{minutes}m {seconds}s", {
        minutes: duration.minutes,
        seconds: duration.seconds,
      })}
    </>
  );
}

/**
 * The composer's session stats strip for one thread. Reads the whole-thread
 * counters from the active environment, keeps the context pill current with the
 * live turn snapshot, and renders nothing while no counters exist.
 */
export const ThreadSessionStatsBarHost = memo(function ThreadSessionStatsBarHost(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly isWorking: boolean;
  readonly liveContextWindow?: ContextWindowSnapshot | null;
}) {
  const query = useEnvironmentQuery<OrchestrationV2GetThreadSessionStatsResult, unknown>(
    orchestrationEnvironment.threadSessionStats({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );
  const { refresh } = query;
  const wasWorking = useRef(props.isWorking);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a finished turn is when the provider writes its ledger, so the settled counters must be re-read
  useEffect(() => {
    if (wasWorking.current && !props.isWorking) refresh();
    wasWorking.current = props.isWorking;
  }, [props.isWorking, refresh]);

  if (query.data === null) return null;
  return (
    <ComposerSessionStatsBar
      liveContextWindow={props.liveContextWindow ?? null}
      onOpenStats={refresh}
      stats={query.data}
    />
  );
});
