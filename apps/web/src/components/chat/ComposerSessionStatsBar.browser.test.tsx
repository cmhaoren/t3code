import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { ComposerSessionStatsBar } from "./ComposerSessionStatsBar";
import type { ThreadSessionStatsData } from "./ComposerSessionStatsBar.logic";

const stats: ThreadSessionStatsData = {
  turns: 2,
  steps: 133,
  llmDurationMs: 86_000,
  toolDurationMs: 14_500,
  decodeDurationMs: 40_000,
  decodeOutputTokens: 7_160,
  tokensPerSecond: 179,
  tokenUsage: {
    uncachedInputTokens: 3_100,
    cacheReadTokens: 23_000_000,
    cacheWriteTokens: 4_200,
    outputTokens: 55_153,
    reasoningTokens: 12_000,
    totalTokens: 23_558_153,
    cacheHitPercent: 99,
  },
  contextBreakdown: {
    systemAndToolsTokens: 1_600,
    toolContextTokens: 10_900,
    messageTokens: 181_000,
    usedTokens: 193_500,
    maxTokens: 750_000,
    autoCompactThreshold: 600_000,
  },
};

const zeroStats: ThreadSessionStatsData = {
  turns: 0,
  steps: 0,
  llmDurationMs: 0,
  toolDurationMs: 0,
  decodeDurationMs: 0,
  decodeOutputTokens: 0,
  tokensPerSecond: null,
  tokenUsage: null,
  contextBreakdown: null,
};

describe("ComposerSessionStatsBar", () => {
  it("renders nothing when every metric is null or zero", async () => {
    await using screen = await render(<ComposerSessionStatsBar stats={null} />, { router: false });
    expect(screen.container.querySelector('[data-slot="composer-session-stats"]')).toBeNull();

    await screen.rerender(<ComposerSessionStatsBar stats={zeroStats} />);
    expect(screen.container.querySelector('[data-slot="composer-session-stats"]')).toBeNull();
  });

  it("renders the three compact pills with activity, usage, and context", async () => {
    await using screen = await render(<ComposerSessionStatsBar stats={stats} />, { router: false });

    const activity = screen.getByRole("button", { name: /2 turns 133 steps/u });
    const usage = screen.getByRole("button", { name: /23\.6M tok/u });
    const context = screen.getByRole("button", { name: /26%/u });

    await expect.element(activity).toBeVisible();
    await expect.element(screen.getByText("179 tok/s")).toBeVisible();
    await expect.element(usage).toBeVisible();
    await expect.element(screen.getByText("Cache hit 99%")).toBeVisible();
    await expect.element(context).toBeVisible();
    await expect.element(screen.getByText("26%")).toBeVisible();
  });

  it("opens each pill's popover with the full breakdown", async () => {
    const onOpenStats = vi.fn();
    await using screen = await render(
      <ComposerSessionStatsBar stats={stats} onOpenStats={onOpenStats} />,
      { router: false },
    );
    // Mounting the strip reads nothing; only opening a breakdown does.
    expect(onOpenStats).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: /2 turns 133 steps/u }));
    await expect.element(page.getByText("Session stats")).toBeVisible();
    await expect.element(page.getByText("Model time")).toBeVisible();
    await expect.element(page.getByText("1m 26s")).toBeVisible();
    await expect.element(page.getByText("Tool time")).toBeVisible();
    await expect.element(page.getByText("14.5s")).toBeVisible();
    await expect.element(page.getByText("Output speed")).toBeVisible();
    expect(onOpenStats).toHaveBeenCalledTimes(1);

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("Session stats")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /23\.6M tok/u }));
    await expect.element(page.getByText("Token usage")).toBeVisible();
    await expect.element(page.getByText("23,558,153 tok")).toBeVisible();
    await expect.element(page.getByText("Cache hit", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Uncached input")).toBeVisible();
    await expect.element(page.getByText("3,100 tok")).toBeVisible();
    await expect.element(page.getByText("Cache read")).toBeVisible();
    await expect.element(page.getByText("23,000,000 tok")).toBeVisible();
    await expect.element(page.getByText("Cache write")).toBeVisible();
    await expect.element(page.getByText("4,200 tok")).toBeVisible();
    await expect.element(page.getByText("Output", { exact: true })).toBeVisible();
    await expect.element(page.getByText("55,153 tok")).toBeVisible();
    await expect.element(page.getByText("Reasoning (in output)")).toBeVisible();
    await expect.element(page.getByText("12,000 tok")).toBeVisible();
    expect(onOpenStats).toHaveBeenCalledTimes(2);

    await userEvent.keyboard("{Escape}");
    await expect.element(page.getByText("Token usage")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /26%/u }));
    await expect.element(page.getByText("Context used")).toBeVisible();
    await expect.element(page.getByText("~194K / 750K")).toBeVisible();
    await expect.element(page.getByText("System & tool overhead")).toBeVisible();
    await expect.element(page.getByText("~1.6K")).toBeVisible();
    await expect.element(page.getByText("Tool calls & output")).toBeVisible();
    await expect.element(page.getByText("~10.9K")).toBeVisible();
    await expect.element(page.getByText("Conversation messages")).toBeVisible();
    await expect.element(page.getByText("~181K")).toBeVisible();
    await expect.element(page.getByText("Auto-compacts around ~600K")).toBeVisible();
    expect(onOpenStats).toHaveBeenCalledTimes(3);
  });

  it("renders gracefully without cache speed, cache hit, cache write, or reasoning data", async () => {
    const sparse: ThreadSessionStatsData = {
      ...stats,
      turns: 1,
      steps: 0,
      llmDurationMs: 0,
      toolDurationMs: 0,
      tokensPerSecond: null,
      tokenUsage: {
        uncachedInputTokens: 1_200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 800,
        reasoningTokens: 0,
        totalTokens: 2_000,
        cacheHitPercent: null,
      },
      contextBreakdown: {
        systemAndToolsTokens: 400,
        toolContextTokens: 0,
        messageTokens: 600,
        usedTokens: 1_000,
        maxTokens: 200_000,
        autoCompactThreshold: null,
      },
    };
    await using screen = await render(<ComposerSessionStatsBar stats={sparse} />, {
      router: false,
    });

    const activity = screen.getByRole("button", { name: /1 turns 0 steps/u });
    const usage = screen.getByRole("button", { name: /2K tok/u });
    expect(activity.element().textContent).not.toContain("tok/s");
    expect(usage.element().textContent).not.toContain("Cache hit");
    expect(usage.element().textContent).toContain("2K tok");

    await userEvent.click(activity);
    await expect
      .element(page.getByText("Timing appears after model output completes."))
      .toBeVisible();
    await expect.element(page.getByText("Model time")).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await userEvent.click(usage);
    await expect.element(page.getByText("Token usage")).toBeVisible();
    await expect.element(page.getByText("2,000 tok")).toBeVisible();
    await expect.element(page.getByText("1,200 tok")).toBeVisible();
    await expect.element(page.getByText("800 tok")).toBeVisible();
    await expect.element(page.getByText("Cache hit", { exact: true })).not.toBeInTheDocument();
    await expect.element(page.getByText("Cache write")).not.toBeInTheDocument();
    await expect.element(page.getByText("Reasoning (in output)")).not.toBeInTheDocument();

    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: /1%/u }));
    await expect.element(page.getByText("Context used")).toBeVisible();
    await expect.element(page.getByText("~1K / 200K")).toBeVisible();
    await expect.element(page.getByText(/Auto-compacts around/u)).not.toBeInTheDocument();
  });

  it("opens a breakdown from the keyboard exactly once", async () => {
    const onOpenStats = vi.fn();
    await using screen = await render(
      <ComposerSessionStatsBar stats={stats} onOpenStats={onOpenStats} />,
      { router: false },
    );

    screen
      .getByRole("button", { name: /2 turns 133 steps/u })
      .element()
      .focus();
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByText("Session stats")).toBeVisible();
    expect(onOpenStats).toHaveBeenCalledTimes(1);
  });

  it("omits zero-width context segments but keeps tiny non-zero ones visible", async () => {
    const lopsided: ThreadSessionStatsData = {
      ...stats,
      contextBreakdown: {
        systemAndToolsTokens: 100_000,
        toolContextTokens: 0,
        messageTokens: 500,
        usedTokens: 100_500,
        maxTokens: 200_000,
        autoCompactThreshold: null,
      },
    };
    await using screen = await render(<ComposerSessionStatsBar stats={lopsided} />, {
      router: false,
    });

    await userEvent.click(screen.getByRole("button", { name: /50%/u }));
    await expect.element(page.getByText("Context used")).toBeVisible();

    const rendered = [...document.querySelectorAll<HTMLElement>("[data-session-stat-segment]")];
    expect(rendered.map((bar) => bar.dataset["sessionStatSegment"])).toEqual([
      "systemAndTools",
      "messages",
    ]);
    for (const bar of rendered) expect(bar.className).toContain("min-w-0.5");
    // The 0.25% slice stays in the bar even though its width rounds to zero.
    expect(Number.parseFloat(rendered[1]!.style.width)).toBeGreaterThan(0);
  });
});
