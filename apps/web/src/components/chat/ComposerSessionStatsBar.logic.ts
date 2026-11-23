import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

export interface ThreadSessionStatsTokenUsage {
  readonly uncachedInputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly outputTokens: number;
  readonly reasoningTokens: number;
  readonly totalTokens: number;
  readonly cacheHitPercent: number | null;
}

export interface ThreadSessionStatsContextBreakdown {
  readonly systemAndToolsTokens: number;
  readonly toolContextTokens: number;
  readonly messageTokens: number;
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly autoCompactThreshold: number | null;
}

export interface ThreadSessionStatsData {
  readonly turns: number;
  readonly steps: number;
  readonly llmDurationMs: number;
  readonly toolDurationMs: number;
  readonly decodeDurationMs: number;
  readonly decodeOutputTokens: number;
  readonly tokensPerSecond: number | null;
  readonly tokenUsage: ThreadSessionStatsTokenUsage | null;
  readonly contextBreakdown: ThreadSessionStatsContextBreakdown | null;
}

export type ContextTone = "normal" | "warning" | "error";

export type ContextSegmentKey = "systemAndTools" | "toolContext" | "messages" | "total";

export interface ContextSegment {
  readonly key: ContextSegmentKey;
  readonly widthPercent: number;
}

export interface ContextSegments {
  readonly percent: number | null;
  readonly tone: ContextTone;
  readonly autoCompactPercent: number | null;
  readonly segments: readonly ContextSegment[];
}

export type StatDuration =
  | { readonly kind: "ms"; readonly value: number }
  | { readonly kind: "s"; readonly value: number }
  | { readonly kind: "ms_min"; readonly minutes: number; readonly seconds: number };

const THOUSAND = 1_000;
const HUNDRED_THOUSAND = 100_000;
const MILLION = 1_000_000;
const THOUSAND_ROUNDING_CEILING = 999_500;
const HUNDRED_MILLION = 100_000_000;

function trimTrailingZero(value: string): string {
  return value.replace(/\.0$/u, "");
}

function nonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

export function formatCompactTokenCount(value: number): string {
  const safe = nonNegative(value);
  if (safe < THOUSAND) return `${Math.round(safe)}`;
  if (safe < HUNDRED_THOUSAND) return `${trimTrailingZero((safe / THOUSAND).toFixed(1))}K`;
  if (safe < THOUSAND_ROUNDING_CEILING) return `${Math.round(safe / THOUSAND)}K`;
  const millions = safe / MILLION;
  return `${safe < HUNDRED_MILLION ? trimTrailingZero(millions.toFixed(1)) : Math.round(millions)}M`;
}

export function formatExactTokenCount(value: number, locale?: string): string {
  return Math.round(nonNegative(value)).toLocaleString(locale);
}

export function formatTokensPerSecond(tps: number): string {
  const safe = nonNegative(tps);
  if (safe >= 100) return `${Math.round(safe)}`;
  if (safe >= 10) return trimTrailingZero((Math.round(safe * 10) / 10).toFixed(1));
  return (Math.round(safe * 10) / 10).toFixed(1);
}

export function formatStatDuration(ms: number): StatDuration {
  const safe = nonNegative(ms);
  if (safe < 1_000) return { kind: "ms", value: Math.round(safe) };
  if (safe < 60_000) return { kind: "s", value: Math.round(safe / 100) / 10 };
  const totalSeconds = Math.round(safe / 1_000);
  return {
    kind: "ms_min",
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60,
  };
}

function scaleSegments(
  breakdown: ThreadSessionStatsContextBreakdown,
  targetTokens: number,
): Pick<
  ThreadSessionStatsContextBreakdown,
  "systemAndToolsTokens" | "toolContextTokens" | "messageTokens"
> {
  const counts = [
    breakdown.systemAndToolsTokens,
    breakdown.toolContextTokens,
    breakdown.messageTokens,
  ].map(nonNegative);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (total <= 0) {
    return { systemAndToolsTokens: 0, toolContextTokens: 0, messageTokens: 0 };
  }
  const target = Math.round(nonNegative(targetTokens));
  const exact = counts.map((count) => (count / total) * target);
  const scaled = exact.map((amount) => Math.floor(amount));
  let remainder = target - scaled.reduce((sum, amount) => sum + amount, 0);
  const byFraction = exact
    .map((amount, index) => ({ index, fraction: amount - (scaled[index] ?? 0) }))
    .sort((left, right) => right.fraction - left.fraction);
  while (remainder > 0) {
    for (const { index } of byFraction) {
      if (remainder === 0) break;
      scaled[index] = (scaled[index] ?? 0) + 1;
      remainder -= 1;
    }
  }
  return {
    systemAndToolsTokens: scaled[0] ?? 0,
    toolContextTokens: scaled[1] ?? 0,
    messageTokens: scaled[2] ?? 0,
  };
}

/** Prefers the live context snapshot mid-turn, keeping the three segments summing to its used total. */
export function resolveEffectiveContextBreakdown(
  statsBreakdown: ThreadSessionStatsContextBreakdown | null,
  liveContextWindow: ContextWindowSnapshot | null,
): ThreadSessionStatsContextBreakdown | null {
  if (liveContextWindow === null) return statsBreakdown;
  const liveUsedTokens = Math.round(nonNegative(liveContextWindow.usedTokens));
  const maxTokens = liveContextWindow.maxTokens ?? statsBreakdown?.maxTokens ?? null;
  const autoCompactThreshold =
    liveContextWindow.autoCompactThreshold ?? statsBreakdown?.autoCompactThreshold ?? null;
  if (statsBreakdown === null) {
    return {
      systemAndToolsTokens: 0,
      toolContextTokens: 0,
      messageTokens: 0,
      usedTokens: liveUsedTokens,
      maxTokens,
      autoCompactThreshold,
    };
  }
  if (liveUsedTokens === statsBreakdown.usedTokens) return statsBreakdown;
  return {
    ...scaleSegments(statsBreakdown, liveUsedTokens),
    usedTokens: liveUsedTokens,
    maxTokens,
    autoCompactThreshold,
  };
}

export function computeContextSegments(
  breakdown: ThreadSessionStatsContextBreakdown,
): ContextSegments {
  const usedTokens = nonNegative(breakdown.usedTokens);
  const maxTokens = breakdown.maxTokens;
  const percent =
    maxTokens !== null && maxTokens > 0
      ? Math.round(Math.min(100, Math.max(0, (usedTokens / maxTokens) * 100)))
      : null;
  const tone: ContextTone =
    percent === null ? "normal" : percent >= 90 ? "error" : percent >= 80 ? "warning" : "normal";
  const autoCompactThreshold = breakdown.autoCompactThreshold;
  const autoCompactPercent =
    autoCompactThreshold !== null && maxTokens !== null && maxTokens > 0
      ? autoCompactThreshold < maxTokens
        ? (autoCompactThreshold / maxTokens) * 100
        : null
      : null;

  const counts = [
    nonNegative(breakdown.systemAndToolsTokens),
    nonNegative(breakdown.toolContextTokens),
    nonNegative(breakdown.messageTokens),
  ] as const;
  const total = counts[0] + counts[1] + counts[2];
  const coloredPercent = percent ?? 0;
  let segments: readonly ContextSegment[];
  if (total > 0) {
    segments = [
      { key: "systemAndTools", widthPercent: (coloredPercent * counts[0]) / total },
      { key: "toolContext", widthPercent: (coloredPercent * counts[1]) / total },
      { key: "messages", widthPercent: (coloredPercent * counts[2]) / total },
    ];
  } else if (usedTokens > 0) {
    segments = [{ key: "total", widthPercent: coloredPercent }];
  } else {
    segments = [
      { key: "systemAndTools", widthPercent: 0 },
      { key: "toolContext", widthPercent: 0 },
      { key: "messages", widthPercent: 0 },
    ];
  }
  return { percent, tone, autoCompactPercent, segments };
}
