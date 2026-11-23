import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSettings from "../serverSettings.ts";
import {
  computeThreadSessionStats,
  type ComputeThreadSessionStatsInput,
  layer as threadSessionStatsLayer,
  ThreadSessionStatsQuery,
  unionDurationMs,
} from "./ThreadSessionStatsQuery.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const THREAD_ID = ThreadId.make("thread-stats");

const utc = (iso: string) => DateTime.makeUnsafe(iso);

const providerThread = (
  id: string,
  overrides: Record<string, unknown> = {},
): OrchestrationV2ProviderThread =>
  ({
    id: ProviderThreadId.make(id),
    driver: "acpRegistry",
    providerInstanceId: ProviderInstanceId.make("acpRegistry"),
    nativeThreadRef: { nativeId: `session-${id}` },
    contextUsage: null,
    updatedAt: utc("2026-01-01T00:00:00Z"),
    ...overrides,
  }) as unknown as OrchestrationV2ProviderThread;

const turn = (
  id: string,
  providerThreadId: string,
  overrides: Record<string, unknown> = {},
): OrchestrationV2ProviderTurn =>
  ({
    id,
    providerThreadId: ProviderThreadId.make(providerThreadId),
    status: "completed",
    startedAt: utc("2026-01-01T00:00:00Z"),
    completedAt: utc("2026-01-01T00:00:05Z"),
    ...overrides,
  }) as unknown as OrchestrationV2ProviderTurn;

const item = (
  id: string,
  providerTurnId: string,
  type: string,
  overrides: Record<string, unknown> = {},
): OrchestrationV2TurnItem =>
  ({
    id,
    threadId: THREAD_ID,
    providerThreadId: ProviderThreadId.make("pt1"),
    providerTurnId,
    type,
    status: "completed",
    ordinal: 1,
    title: null,
    startedAt: utc("2026-01-01T00:00:00Z"),
    completedAt: utc("2026-01-01T00:00:01Z"),
    updatedAt: utc("2026-01-01T00:00:01Z"),
    ...overrides,
  }) as unknown as OrchestrationV2TurnItem;

const input = (
  overrides: Partial<ComputeThreadSessionStatsInput> = {},
): ComputeThreadSessionStatsInput => ({
  thread: {
    id: THREAD_ID,
    activeProviderThreadId: ProviderThreadId.make("pt1"),
  },
  providerThreads: [providerThread("pt1")],
  providerTurns: [],
  turnItems: [],
  ...overrides,
});

describe("unionDurationMs", () => {
  it("counts overlapping parallel intervals once", () => {
    expect(
      unionDurationMs([
        [0, 1_000],
        [500, 1_500],
        [2_000, 2_500],
      ]),
    ).toBe(2_000);
  });

  it("ignores inverted and non-finite intervals", () => {
    expect(
      unionDurationMs([
        [1_000, 500],
        [Number.NaN, 10],
      ]),
    ).toBe(0);
  });
});

describe("computeThreadSessionStats", () => {
  it("counts delivered turns, steps and every provider the thread used", () => {
    const result = computeThreadSessionStats(
      input({
        providerThreads: [
          providerThread("pt1"),
          providerThread("pt2", { providerInstanceId: ProviderInstanceId.make("factory-droid") }),
        ],
        providerTurns: [
          turn("turn-1", "pt1"),
          turn("turn-2", "pt2"),
          turn("turn-dropped", "pt2", { promptDropped: true }),
        ],
        turnItems: [
          item("i1", "turn-1", "user_message", { text: "hello" }),
          item("i2", "turn-1", "reasoning", { text: "thinking" }),
          item("i3", "turn-1", "assistant_message", { text: "answer" }),
          item("i4", "turn-1", "command_execution", { input: "ls" }),
          item("i5", "turn-2", "file_search", { pattern: "*.ts" }),
          item("i6", "turn-2", "todo_list"),
        ],
      }),
    );

    expect(result.turns).toBe(2);
    expect(result.steps).toBe(4);
    expect(result.providersIncluded).toEqual([
      ProviderInstanceId.make("acpRegistry"),
      ProviderInstanceId.make("factory-droid"),
    ]);
  });

  it("derives LLM time from streamed text and tool time from overlapping tool intervals", () => {
    const result = computeThreadSessionStats(
      input({
        turnItems: [
          item("i1", "turn-1", "reasoning", {
            startedAt: utc("2026-01-01T00:00:00Z"),
            completedAt: utc("2026-01-01T00:00:01Z"),
          }),
          item("i2", "turn-1", "assistant_message", {
            startedAt: utc("2026-01-01T00:00:01Z"),
            completedAt: utc("2026-01-01T00:00:03Z"),
          }),
          item("i3", "turn-1", "command_execution", {
            startedAt: utc("2026-01-01T00:00:01Z"),
            completedAt: utc("2026-01-01T00:00:02Z"),
          }),
        ],
        providerTurns: [
          turn("turn-1", "pt1", {
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: false,
              inputTokens: 1_000,
              outputTokens: 1_000,
            },
          }),
        ],
      }),
    );

    expect(result.llmDurationMs).toBe(3_000);
    expect(result.toolDurationMs).toBe(1_000);
    expect(result.decodeDurationMs).toBe(3_000);
    expect(result.decodeOutputTokens).toBe(1_000);
    expect(result.tokensPerSecond).toBe(333.3);
  });

  it("folds cache traffic into billed input and reports the hit rate", () => {
    const result = computeThreadSessionStats(
      input({
        providerTurns: [
          turn("turn-1", "pt1", {
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: false,
              inputTokens: 1_000,
              cachedInputTokens: 400,
              cacheCreationTokens: 100,
              outputTokens: 200,
              reasoningTokens: 50,
            },
          }),
        ],
      }),
    );

    expect(result.tokenUsage).toEqual({
      uncachedInputTokens: 500,
      cacheReadTokens: 400,
      cacheWriteTokens: 100,
      outputTokens: 200,
      reasoningTokens: 50,
      totalTokens: 1_200,
      cacheHitPercent: 40,
    });
  });

  it("falls back to a provider turn's context snapshot for token totals", () => {
    const result = computeThreadSessionStats(
      input({
        providerTurns: [
          turn("turn-1", "pt1", {
            tokenUsage: {
              usedTokens: 900,
              inputTokens: 1_000,
              cachedInputTokens: 250,
              outputTokens: 100,
              reasoningOutputTokens: 20,
              updatedAt: "2026-01-01T00:00:05Z",
            },
          }),
        ],
      }),
    );

    expect(result.tokenUsage).toEqual({
      uncachedInputTokens: 750,
      cacheReadTokens: 250,
      cacheWriteTokens: 0,
      outputTokens: 100,
      reasoningTokens: 20,
      totalTokens: 1_100,
      cacheHitPercent: 25,
    });
  });

  it("uses the Factory Droid ledger for a provider thread whose per-turn usage is unavailable", () => {
    const result = computeThreadSessionStats(
      input({
        providerTurns: [
          turn("turn-1", "pt1", {
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "unavailable",
              hasSubagents: false,
            },
          }),
        ],
        droidUsageFallbacks: [
          {
            providerThreadId: ProviderThreadId.make("pt1"),
            usage: {
              uncachedInputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 300,
              cacheCreationTokens: 0,
              thinkingTokens: 0,
              assistantActiveTimeMs: 2_000,
            },
          },
        ],
      }),
    );

    expect(result.tokenUsage).toEqual({
      uncachedInputTokens: 100,
      cacheReadTokens: 300,
      cacheWriteTokens: 0,
      outputTokens: 50,
      reasoningTokens: 0,
      totalTokens: 450,
      cacheHitPercent: 75,
    });
    expect(result.decodeOutputTokens).toBe(50);
    expect(result.decodeDurationMs).toBe(2_000);
    expect(result.tokensPerSecond).toBe(25);
  });

  it("reports the ledger's assistant time as model time when it exceeds the item-derived duration", () => {
    const result = computeThreadSessionStats(
      input({
        providerTurns: [
          turn("turn-1", "pt1", {
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "unavailable",
              hasSubagents: false,
            },
          }),
        ],
        turnItems: [
          item("i1", "turn-1", "assistant_message", {
            startedAt: utc("2026-01-01T00:00:00Z"),
            completedAt: utc("2026-01-01T00:00:01Z"),
          }),
        ],
        droidUsageFallbacks: [
          {
            providerThreadId: ProviderThreadId.make("pt1"),
            usage: {
              uncachedInputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 0,
              cacheCreationTokens: 0,
              thinkingTokens: 0,
              assistantActiveTimeMs: 4_000,
            },
          },
        ],
      }),
    );

    // The item stream implies 1s; the ledger's 4s is the better model duration,
    // so both the total and the TPS denominator use it.
    expect(result.llmDurationMs).toBe(4_000);
    expect(result.decodeDurationMs).toBe(4_000);
    expect(result.decodeOutputTokens).toBe(50);
    expect(result.tokensPerSecond).toBe(12.5);
  });

  it("keeps per-turn records when they already exceed the ledger total", () => {
    const result = computeThreadSessionStats(
      input({
        providerTurns: [
          turn("turn-1", "pt1", {
            turnTokenUsage: {
              usageScope: "main_agent",
              usageStatus: "complete",
              hasSubagents: false,
              inputTokens: 1_000,
              outputTokens: 500,
            },
          }),
        ],
        droidUsageFallbacks: [
          {
            providerThreadId: ProviderThreadId.make("pt1"),
            usage: {
              uncachedInputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 100,
              cacheCreationTokens: 0,
              thinkingTokens: 0,
              assistantActiveTimeMs: 2_000,
            },
          },
        ],
      }),
    );

    expect(result.tokenUsage?.outputTokens).toBe(500);
    expect(result.tokenUsage?.totalTokens).toBe(1_500);
  });

  it("splits the context window into three buckets that always sum to usedTokens", () => {
    const result = computeThreadSessionStats(
      input({
        providerThreads: [
          providerThread("pt1", {
            contextUsage: {
              usedTokens: 1_000,
              maxTokens: 200_000,
              autoCompactThreshold: 160_000,
              updatedAt: "2026-01-01T00:00:00Z",
            },
          }),
        ],
        providerTurns: [turn("turn-1", "pt1")],
        turnItems: [
          item("i1", "turn-1", "user_message", { text: "a".repeat(400) }),
          item("i2", "turn-1", "command_execution", {
            input: "b".repeat(400),
            output: "c".repeat(400),
          }),
        ],
      }),
    );

    expect(result.contextBreakdown).toEqual({
      messageTokens: 104,
      toolContextTokens: 208,
      systemAndToolsTokens: 688,
      usedTokens: 1_000,
      maxTokens: 200_000,
      autoCompactThreshold: 160_000,
    });
    const breakdown = result.contextBreakdown!;
    expect(
      breakdown.messageTokens + breakdown.toolContextTokens + breakdown.systemAndToolsTokens,
    ).toBe(breakdown.usedTokens);
  });

  it("scales an overshooting context estimate down to usedTokens", () => {
    const result = computeThreadSessionStats(
      input({
        providerThreads: [
          providerThread("pt1", {
            contextUsage: {
              usedTokens: 200,
              maxTokens: 200_000,
              updatedAt: "2026-01-01T00:00:00Z",
            },
          }),
        ],
        providerTurns: [turn("turn-1", "pt1")],
        turnItems: [
          item("i1", "turn-1", "assistant_message", { text: "a".repeat(4_000) }),
          item("i2", "turn-1", "command_execution", { input: "b".repeat(4_000) }),
        ],
      }),
    );

    const breakdown = result.contextBreakdown!;
    expect(breakdown.usedTokens).toBe(200);
    expect(breakdown.systemAndToolsTokens).toBe(0);
    expect(breakdown.messageTokens + breakdown.toolContextTokens).toBe(200);
  });

  it("starts the breakdown after the latest completed compaction", () => {
    const result = computeThreadSessionStats(
      input({
        providerThreads: [
          providerThread("pt1", {
            contextUsage: {
              usedTokens: 90_000,
              maxTokens: 200_000,
              updatedAt: "2026-01-01T00:00:00Z",
            },
          }),
        ],
        providerTurns: [turn("turn-1", "pt1")],
        turnItems: [
          item("i1", "turn-1", "assistant_message", {
            ordinal: 1,
            text: "old".repeat(10_000),
          }),
          item("compact", "turn-1", "compaction", {
            ordinal: 2,
            status: "completed",
            afterTokenCount: 500,
            completedAt: utc("2026-01-02T00:00:00Z"),
            updatedAt: utc("2026-01-02T00:00:00Z"),
          }),
          item("i2", "turn-1", "assistant_message", {
            ordinal: 3,
            text: "a".repeat(400),
          }),
        ],
      }),
    );

    expect(result.contextBreakdown).toEqual({
      messageTokens: 104,
      toolContextTokens: 0,
      systemAndToolsTokens: 396,
      usedTokens: 500,
      maxTokens: 200_000,
      autoCompactThreshold: null,
    });
  });

  it("returns empty counters for a thread with no recorded usage", () => {
    const result = computeThreadSessionStats(input());
    expect(result).toEqual({
      threadId: THREAD_ID,
      turns: 0,
      steps: 0,
      llmDurationMs: 0,
      toolDurationMs: 0,
      decodeDurationMs: 0,
      decodeOutputTokens: 0,
      tokensPerSecond: null,
      tokenUsage: null,
      contextBreakdown: null,
      providersIncluded: [ProviderInstanceId.make("acpRegistry")],
    });
  });
});

describe("ThreadSessionStatsQuery", () => {
  it.effect("enriches a Factory Droid thread from its session ledger", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const factoryDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "thread-session-stats-",
      });
      const sessionDir = path.join(factoryDir, "sessions", "-D-dstest");
      yield* fileSystem.makeDirectory(sessionDir, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(sessionDir, "droid-session-1.settings.json"),
        JSON.stringify({
          assistantActiveTimeMs: 4_000,
          tokenUsage: {
            inputTokens: 100,
            outputTokens: 50,
            cacheCreationTokens: 0,
            cacheReadTokens: 300,
            thinkingTokens: 0,
          },
        }),
      );

      const result = yield* Effect.gen(function* () {
        const query = yield* ThreadSessionStatsQuery;
        return yield* query.getThreadSessionStats({ threadId: THREAD_ID });
      }).pipe(
        Effect.provide(
          threadSessionStatsLayer.pipe(
            Layer.provide(
              Layer.mergeAll(
                NodeServices.layer,
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  getThreadRecords: () =>
                    Effect.succeed({
                      thread: {
                        id: THREAD_ID,
                        activeProviderThreadId: ProviderThreadId.make("pt1"),
                        worktreePath: null,
                      },
                      providerThreads: [
                        providerThread("pt1", {
                          nativeThreadRef: { nativeId: "droid-session-1" },
                        }),
                      ],
                      providerTurns: [
                        turn("turn-1", "pt1", {
                          turnTokenUsage: {
                            usageScope: "main_agent",
                            usageStatus: "unavailable",
                            hasSubagents: false,
                          },
                        }),
                      ],
                      turnItems: [],
                    } as never),
                }),
                Layer.mock(ServerSettings.ServerSettingsService)({
                  getSettings: Effect.succeed({
                    providerInstances: {
                      acpRegistry: {
                        driver: "acpRegistry",
                        enabled: true,
                        config: { source: "local", commandPath: "droid" },
                        environment: [{ name: "FACTORY_HOME", value: factoryDir }],
                      },
                    },
                  } as never),
                }),
              ),
            ),
          ),
        ),
      );

      expect(result.tokenUsage).toEqual({
        uncachedInputTokens: 100,
        cacheReadTokens: 300,
        cacheWriteTokens: 0,
        outputTokens: 50,
        reasoningTokens: 0,
        totalTokens: 450,
        cacheHitPercent: 75,
      });
      expect(result.tokensPerSecond).toBe(12.5);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads the whole thread's persisted records", () =>
    Effect.gen(function* () {
      const query = yield* ThreadSessionStatsQuery;
      const result = yield* query.getThreadSessionStats({ threadId: THREAD_ID });
      expect(result.threadId).toBe(THREAD_ID);
      expect(result.turns).toBe(1);
    }).pipe(
      Effect.provide(
        threadSessionStatsLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              NodeServices.layer,
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadRecords: () =>
                  Effect.succeed({
                    thread: {
                      id: THREAD_ID,
                      activeProviderThreadId: ProviderThreadId.make("pt1"),
                      worktreePath: null,
                    },
                    providerThreads: [providerThread("pt1")],
                    providerTurns: [turn("turn-1", "pt1")],
                    turnItems: [],
                  } as never),
              }),
              Layer.mock(ServerSettings.ServerSettingsService)({
                getSettings: Effect.succeed({ providerInstances: {} } as never),
              }),
            ),
          ),
        ),
      ),
    ),
  );
});
