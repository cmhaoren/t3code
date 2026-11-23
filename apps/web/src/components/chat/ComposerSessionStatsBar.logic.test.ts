import { describe, expect, it } from "vite-plus/test";

import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

import {
  computeContextSegments,
  formatCompactTokenCount,
  formatExactTokenCount,
  formatStatDuration,
  formatTokensPerSecond,
  resolveEffectiveContextBreakdown,
  type ThreadSessionStatsContextBreakdown,
} from "./ComposerSessionStatsBar.logic";

function breakdown(
  overrides: Partial<ThreadSessionStatsContextBreakdown> = {},
): ThreadSessionStatsContextBreakdown {
  return {
    systemAndToolsTokens: 1_600,
    toolContextTokens: 10_900,
    messageTokens: 181_000,
    usedTokens: 193_500,
    maxTokens: 750_000,
    autoCompactThreshold: 600_000,
    ...overrides,
  };
}

function liveContext(overrides: Partial<ContextWindowSnapshot> = {}): ContextWindowSnapshot {
  return {
    usedTokens: 193_500,
    maxTokens: 750_000,
    autoCompactThreshold: 600_000,
    remainingTokens: null,
    usedPercentage: null,
    remainingPercentage: null,
    updatedAt: "2026-11-23T00:00:00.000Z",
    ...overrides,
  } as ContextWindowSnapshot;
}

describe("formatCompactTokenCount", () => {
  it("keeps small counts exact and compacts thousands", () => {
    expect(formatCompactTokenCount(0)).toBe("0");
    expect(formatCompactTokenCount(-42)).toBe("0");
    expect(formatCompactTokenCount(850)).toBe("850");
    expect(formatCompactTokenCount(1_600)).toBe("1.6K");
    expect(formatCompactTokenCount(10_900)).toBe("10.9K");
    expect(formatCompactTokenCount(99_500)).toBe("99.5K");
  });

  it("rounds whole thousands below one million and compacts millions", () => {
    expect(formatCompactTokenCount(100_000)).toBe("100K");
    expect(formatCompactTokenCount(181_000)).toBe("181K");
    expect(formatCompactTokenCount(260_000)).toBe("260K");
    expect(formatCompactTokenCount(999_500)).toBe("1M");
    expect(formatCompactTokenCount(1_000_000)).toBe("1M");
    expect(formatCompactTokenCount(1_048_576)).toBe("1M");
    expect(formatCompactTokenCount(23_558_153)).toBe("23.6M");
    expect(formatCompactTokenCount(123_456_789)).toBe("123M");
  });
});

describe("formatExactTokenCount", () => {
  it("groups digits with the requested locale", () => {
    expect(formatExactTokenCount(23_558_153, "en-US")).toBe("23,558,153");
    expect(formatExactTokenCount(0, "en-US")).toBe("0");
    expect(formatExactTokenCount(-1, "en-US")).toBe("0");
  });
});

describe("formatTokensPerSecond", () => {
  it("drops decimals for three digits and trims whole tenths above ten", () => {
    expect(formatTokensPerSecond(179)).toBe("179");
    expect(formatTokensPerSecond(100)).toBe("100");
    expect(formatTokensPerSecond(93.44)).toBe("93.4");
    expect(formatTokensPerSecond(10)).toBe("10");
    expect(formatTokensPerSecond(8.5)).toBe("8.5");
    expect(formatTokensPerSecond(0)).toBe("0.0");
  });
});

describe("formatStatDuration", () => {
  it("chooses milliseconds, seconds, or minutes and seconds", () => {
    expect(formatStatDuration(850)).toEqual({ kind: "ms", value: 850 });
    expect(formatStatDuration(8_500)).toEqual({ kind: "s", value: 8.5 });
    expect(formatStatDuration(60_000)).toEqual({ kind: "ms_min", minutes: 1, seconds: 0 });
    expect(formatStatDuration(90_000)).toEqual({ kind: "ms_min", minutes: 1, seconds: 30 });
    expect(formatStatDuration(-5)).toEqual({ kind: "ms", value: 0 });
  });
});

describe("resolveEffectiveContextBreakdown", () => {
  it("returns the stats breakdown when no live snapshot exists", () => {
    const statsBreakdown = breakdown();
    expect(resolveEffectiveContextBreakdown(statsBreakdown, null)).toBe(statsBreakdown);
  });

  it("builds a single-segment fallback from a live snapshot with no breakdown", () => {
    expect(resolveEffectiveContextBreakdown(null, liveContext({ usedTokens: 42_000 }))).toEqual({
      systemAndToolsTokens: 0,
      toolContextTokens: 0,
      messageTokens: 0,
      usedTokens: 42_000,
      maxTokens: 750_000,
      autoCompactThreshold: 600_000,
    });
  });

  it("scales the three segments to the live total without losing a token", () => {
    const resolved = resolveEffectiveContextBreakdown(
      breakdown({
        systemAndToolsTokens: 100,
        toolContextTokens: 200,
        messageTokens: 300,
        usedTokens: 600,
      }),
      liveContext({ usedTokens: 500 }),
    );
    expect(resolved).not.toBeNull();
    expect(resolved?.systemAndToolsTokens).toBe(83);
    expect(resolved?.toolContextTokens).toBe(167);
    expect(resolved?.messageTokens).toBe(250);
    expect(
      (resolved?.systemAndToolsTokens ?? 0) +
        (resolved?.toolContextTokens ?? 0) +
        (resolved?.messageTokens ?? 0),
    ).toBe(500);
    expect(resolved?.usedTokens).toBe(500);
  });

  it("keeps the stats breakdown untouched when the live total already matches", () => {
    const statsBreakdown = breakdown();
    expect(resolveEffectiveContextBreakdown(statsBreakdown, liveContext())).toBe(statsBreakdown);
  });

  it("prefers live context limits over the stats snapshot", () => {
    const resolved = resolveEffectiveContextBreakdown(
      breakdown(),
      liveContext({ usedTokens: 100_000, maxTokens: 1_000_000, autoCompactThreshold: 800_000 }),
    );
    expect(resolved?.usedTokens).toBe(100_000);
    expect(resolved?.maxTokens).toBe(1_000_000);
    expect(resolved?.autoCompactThreshold).toBe(800_000);
  });
});

describe("computeContextSegments", () => {
  it("reports percent, tone, and widths that sum to the colored percent", () => {
    const segments = computeContextSegments(breakdown());
    expect(segments.percent).toBe(26);
    expect(segments.tone).toBe("normal");
    expect(segments.autoCompactPercent).toBe(80);
    expect(segments.segments.map((segment) => segment.key)).toEqual([
      "systemAndTools",
      "toolContext",
      "messages",
    ]);
    const totalWidth = segments.segments.reduce((sum, segment) => sum + segment.widthPercent, 0);
    expect(totalWidth).toBeCloseTo(26, 6);
  });

  it("turns warning at 80 percent and error at 90 percent", () => {
    expect(computeContextSegments(breakdown({ usedTokens: 600_000 })).tone).toBe("warning");
    expect(computeContextSegments(breakdown({ usedTokens: 675_000 })).tone).toBe("error");
  });

  it("falls back to one total segment when the breakdown has no slice counts", () => {
    const segments = computeContextSegments(
      breakdown({
        systemAndToolsTokens: 0,
        toolContextTokens: 0,
        messageTokens: 0,
        usedTokens: 195_000,
      }),
    );
    expect(segments.segments).toEqual([{ key: "total", widthPercent: 26 }]);
  });

  it("has no percent or auto-compact mark without a max", () => {
    const segments = computeContextSegments(
      breakdown({ maxTokens: null, autoCompactThreshold: null }),
    );
    expect(segments.percent).toBeNull();
    expect(segments.tone).toBe("normal");
    expect(segments.autoCompactPercent).toBeNull();
    expect(segments.segments.every((segment) => segment.widthPercent === 0)).toBe(true);
  });
});
