import {
  isDeliveredProviderTurn,
  OrchestrationV2GetThreadSessionStatsError,
  type OrchestrationV2GetThreadSessionStatsInput,
  type OrchestrationV2GetThreadSessionStatsResult,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ThreadSessionContextBreakdown,
  type OrchestrationV2ThreadSessionTokenUsage,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ProviderThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { AcpRegistrySettings } from "@t3tools/provider-acp-registry/settings";
import { isDeepSeekHarnessInstance } from "@t3tools/provider-acp-registry/server/deepseekIdentity";
import {
  readDroidSessionUsage,
  type DroidSessionUsageSnapshot,
} from "@t3tools/provider-acp-registry/server/droidSessionUsage";
import { readDshSessionUsage } from "@t3tools/provider-acp-registry/server/dshSessionUsage";
import { isFactoryDroidInstance } from "@t3tools/provider-acp-registry/server/factoryUsageLimits";
import * as ServerSettings from "../serverSettings.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const STREAM_ITEM_TYPES: ReadonlySet<string> = new Set(["reasoning", "assistant_message"]);
const MESSAGE_ITEM_TYPES: ReadonlySet<string> = new Set([
  "user_message",
  "assistant_message",
  "reasoning",
]);
const TOOL_ITEM_TYPES: ReadonlySet<string> = new Set([
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "mcp_tool_call",
  "web_search",
  "image_view",
  "subagent",
]);
const STEP_ITEM_TYPES: ReadonlySet<string> = new Set([
  "reasoning",
  "assistant_message",
  "command_execution",
  "dynamic_tool",
  "file_change",
  "file_search",
  "mcp_tool_call",
  "web_search",
  "image_view",
  "subagent",
]);

const CHARS_PER_TOKEN = 4;
const MAX_ITEM_CHARS = 100_000;
const decodeAcpRegistrySettings = Schema.decodeUnknownOption(AcpRegistrySettings);

/**
 * Usage a provider session ledger reports for one provider thread. Factory
 * Droid and DeepSeek Harness ledgers share the same cumulative counters.
 */
export interface ThreadSessionDroidUsageFallback {
  readonly providerThreadId: ProviderThreadId;
  readonly usage: DroidSessionUsageSnapshot;
}

export interface ComputeThreadSessionStatsInput {
  readonly thread: {
    readonly id: ThreadId;
    readonly activeProviderThreadId: ProviderThreadId | null;
  };
  readonly providerThreads: ReadonlyArray<OrchestrationV2ProviderThread>;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly droidUsageFallbacks?: ReadonlyArray<ThreadSessionDroidUsageFallback> | undefined;
}

interface TokenTotals {
  uncachedInputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

const emptyTokenTotals = (): TokenTotals => ({
  uncachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

const addTokenTotals = (target: TokenTotals, source: TokenTotals): void => {
  target.uncachedInputTokens += source.uncachedInputTokens;
  target.cacheReadTokens += source.cacheReadTokens;
  target.cacheWriteTokens += source.cacheWriteTokens;
  target.outputTokens += source.outputTokens;
  target.reasoningTokens += source.reasoningTokens;
};

const nonNegativeInt = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;

const positiveIntOrNull = (value: number | null | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null;

const epochMillis = (value: DateTime.Utc | null): number | null => {
  if (value === null) return null;
  const millis = DateTime.toEpochMillis(value);
  return Number.isFinite(millis) ? millis : null;
};

/**
 * Total covered length of a set of half-open intervals. Parallel tool calls
 * overlap in wall time but must not count twice.
 */
export function unionDurationMs(intervals: ReadonlyArray<readonly [number, number]>): number {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of intervals) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    merged.push([start, end]);
  }
  if (merged.length === 0) return 0;
  merged.sort((left, right) => left[0] - right[0]);
  let covered = 0;
  let [currentStart, currentEnd] = merged[0]!;
  for (let index = 1; index < merged.length; index += 1) {
    const [start, end] = merged[index]!;
    if (start > currentEnd) {
      covered += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    } else if (end > currentEnd) {
      currentEnd = end;
    }
  }
  covered += currentEnd - currentStart;
  return nonNegativeInt(covered);
}

const itemInterval = (item: OrchestrationV2TurnItem): readonly [number, number] | null => {
  const start = epochMillis(item.startedAt);
  const end = epochMillis(item.completedAt);
  if (start === null || end === null || end <= start) return null;
  return [start, end];
};

function turnTokenContribution(turn: OrchestrationV2ProviderTurn): TokenTotals | null {
  const perTurn = turn.turnTokenUsage;
  if (
    perTurn !== undefined &&
    perTurn.usageStatus !== "unavailable" &&
    perTurn.inputTokens !== undefined &&
    perTurn.outputTokens !== undefined
  ) {
    const cacheRead = perTurn.cachedInputTokens ?? 0;
    const cacheWrite = perTurn.cacheCreationTokens ?? 0;
    return {
      uncachedInputTokens: Math.max(0, perTurn.inputTokens - cacheRead - cacheWrite),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      outputTokens: perTurn.outputTokens,
      reasoningTokens: perTurn.reasoningTokens ?? 0,
    };
  }
  // Providers without TurnTokenUsage (for example Pi) still report a context
  // snapshot per turn.
  if (
    turn.tokenUsage !== undefined &&
    (turn.tokenUsage.inputTokens !== undefined || turn.tokenUsage.outputTokens !== undefined)
  ) {
    const cacheRead = turn.tokenUsage.cachedInputTokens ?? 0;
    return {
      uncachedInputTokens: Math.max(0, (turn.tokenUsage.inputTokens ?? 0) - cacheRead),
      cacheReadTokens: cacheRead,
      cacheWriteTokens: 0,
      outputTokens: turn.tokenUsage.outputTokens ?? 0,
      reasoningTokens: turn.tokenUsage.reasoningOutputTokens ?? 0,
    };
  }
  return null;
}

function turnOutputTokens(turn: OrchestrationV2ProviderTurn): number {
  const perTurn = turn.turnTokenUsage;
  if (
    perTurn !== undefined &&
    perTurn.usageStatus !== "unavailable" &&
    perTurn.outputTokens !== undefined
  ) {
    return perTurn.outputTokens;
  }
  return turn.tokenUsage?.outputTokens ?? 0;
}

const droidUsageTotals = (usage: DroidSessionUsageSnapshot): TokenTotals => ({
  uncachedInputTokens: usage.uncachedInputTokens,
  cacheReadTokens: usage.cacheReadTokens,
  cacheWriteTokens: usage.cacheCreationTokens,
  outputTokens: usage.outputTokens,
  reasoningTokens: usage.thinkingTokens,
});

const tokenTotal = (totals: TokenTotals): number =>
  totals.uncachedInputTokens +
  totals.cacheReadTokens +
  totals.cacheWriteTokens +
  totals.outputTokens;

const asNullableTokens = (totals: TokenTotals): OrchestrationV2ThreadSessionTokenUsage | null => {
  const billedInput = totals.uncachedInputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  const totalTokens = billedInput + totals.outputTokens;
  if (totalTokens === 0) return null;
  return {
    uncachedInputTokens: nonNegativeInt(totals.uncachedInputTokens),
    cacheReadTokens: nonNegativeInt(totals.cacheReadTokens),
    cacheWriteTokens: nonNegativeInt(totals.cacheWriteTokens),
    outputTokens: nonNegativeInt(totals.outputTokens),
    reasoningTokens: nonNegativeInt(totals.reasoningTokens),
    totalTokens: nonNegativeInt(totalTokens),
    cacheHitPercent:
      billedInput > 0 ? Math.round((totals.cacheReadTokens / billedInput) * 100) : null,
  };
};

function countChars(value: unknown): number {
  if (typeof value === "string") return Math.min(value.length, MAX_ITEM_CHARS);
  if (Array.isArray(value)) {
    let chars = 0;
    for (const entry of value) {
      chars += countChars(entry);
      if (chars >= MAX_ITEM_CHARS) return MAX_ITEM_CHARS;
    }
    return chars;
  }
  if (value !== null && typeof value === "object") {
    try {
      return Math.min(JSON.stringify(value)?.length ?? 0, MAX_ITEM_CHARS);
    } catch {
      return 0;
    }
  }
  return 0;
}

const TEXT_FIELD_NAMES = [
  "title",
  "text",
  "command",
  "input",
  "output",
  "detail",
  "prompt",
  "result",
  "summary",
  "progress",
  "fileName",
  "toolName",
  "diffStr",
  "markdown",
  "message",
  "pattern",
  "patterns",
  "results",
  "changes",
] as const;

function itemTextChars(item: OrchestrationV2TurnItem): number {
  const record = item as unknown as Record<string, unknown>;
  let chars = 0;
  for (const key of TEXT_FIELD_NAMES) {
    chars += countChars(record[key]);
    if (chars >= MAX_ITEM_CHARS) return MAX_ITEM_CHARS;
  }
  return chars;
}

interface ContextUsageSnapshot {
  readonly usedTokens: number;
  readonly maxTokens: number | null;
  readonly autoCompactThreshold: number | null;
  readonly compactionOrdinal: number | null;
}

function isRetiredProviderThreadItem(
  item: OrchestrationV2TurnItem,
  providerThread: OrchestrationV2ProviderThread | undefined,
): boolean {
  return (
    providerThread !== undefined &&
    item.providerThreadId !== null &&
    item.providerThreadId !== providerThread.id
  );
}

function resolveContextUsage(
  input: ComputeThreadSessionStatsInput,
  activeProviderThread: OrchestrationV2ProviderThread | undefined,
  latestTurnUsage: OrchestrationV2ProviderTurn["tokenUsage"] | null,
): ContextUsageSnapshot | null {
  const compactionItems = input.turnItems.filter(
    (item) =>
      item.type === "compaction" &&
      !isRetiredProviderThreadItem(item, activeProviderThread) &&
      (item.afterTokenCount ?? -1) >= 0,
  );
  const latestCompletedCompaction = compactionItems
    .filter((item) => item.type === "compaction" && item.status === "completed")
    .reduce<OrchestrationV2TurnItem | null>(
      (latest, item) => (latest === null || item.ordinal >= latest.ordinal ? item : latest),
      null,
    );
  const latestAnyCompaction = compactionItems.reduce<OrchestrationV2TurnItem | null>(
    (latest, item) => (latest === null || item.ordinal >= latest.ordinal ? item : latest),
    null,
  );
  const contextUsage = activeProviderThread?.contextUsage ?? null;
  const usageUpdatedAt =
    latestTurnUsage?.updatedAt ??
    (contextUsage !== null && activeProviderThread !== undefined
      ? DateTime.formatIso(activeProviderThread.updatedAt)
      : null);
  const compactionUpdatedAt =
    latestCompletedCompaction !== null && latestCompletedCompaction.type === "compaction"
      ? DateTime.formatIso(
          latestCompletedCompaction.completedAt ?? latestCompletedCompaction.updatedAt,
        )
      : null;

  if (
    latestCompletedCompaction !== null &&
    latestCompletedCompaction.type === "compaction" &&
    (usageUpdatedAt === null ||
      (compactionUpdatedAt !== null &&
        Date.parse(compactionUpdatedAt) > Date.parse(usageUpdatedAt)))
  ) {
    const usedTokens = latestCompletedCompaction.afterTokenCount;
    if (usedTokens === undefined || usedTokens < 0) return null;
    return {
      usedTokens,
      maxTokens: positiveIntOrNull(latestTurnUsage?.maxTokens ?? contextUsage?.maxTokens),
      autoCompactThreshold: null,
      compactionOrdinal: latestCompletedCompaction.ordinal,
    };
  }

  if (latestTurnUsage != null) {
    return {
      usedTokens: nonNegativeInt(latestTurnUsage.usedTokens),
      maxTokens: positiveIntOrNull(latestTurnUsage.maxTokens),
      autoCompactThreshold: positiveIntOrNull(latestTurnUsage.autoCompactThreshold),
      compactionOrdinal: latestCompletedCompaction?.ordinal ?? null,
    };
  }

  if (contextUsage !== null) {
    return {
      usedTokens: nonNegativeInt(contextUsage.usedTokens),
      maxTokens: positiveIntOrNull(contextUsage.maxTokens),
      autoCompactThreshold: positiveIntOrNull(contextUsage.autoCompactThreshold),
      compactionOrdinal: latestCompletedCompaction?.ordinal ?? null,
    };
  }

  if (latestAnyCompaction !== null && latestAnyCompaction.type === "compaction") {
    const usedTokens = latestAnyCompaction.afterTokenCount;
    if (usedTokens === undefined || usedTokens < 0) return null;
    return {
      usedTokens,
      maxTokens: null,
      autoCompactThreshold: null,
      compactionOrdinal: latestAnyCompaction.ordinal,
    };
  }
  return null;
}

function contextBreakdown(
  input: ComputeThreadSessionStatsInput,
): OrchestrationV2ThreadSessionContextBreakdown | null {
  const activeProviderThread =
    input.providerThreads.find(
      (providerThread) => providerThread.id === input.thread.activeProviderThreadId,
    ) ?? input.providerThreads.at(-1);
  if (activeProviderThread === undefined) return null;

  let latestTurnUsage: OrchestrationV2ProviderTurn["tokenUsage"] | null = null;
  for (const turn of input.providerTurns) {
    if (turn.providerThreadId !== activeProviderThread.id) continue;
    if (turn.tokenUsage === undefined) continue;
    if (
      latestTurnUsage === null ||
      Date.parse(turn.tokenUsage.updatedAt) >= Date.parse(latestTurnUsage.updatedAt)
    ) {
      latestTurnUsage = turn.tokenUsage;
    }
  }

  const usage = resolveContextUsage(input, activeProviderThread, latestTurnUsage);
  if (usage === null) return null;

  const cutoff = usage.compactionOrdinal ?? -1;
  const activeItems = input.turnItems.filter(
    (item) =>
      (item.providerThreadId === activeProviderThread.id || item.providerThreadId === null) &&
      item.ordinal > cutoff,
  );

  let rawMessageTokens = 0;
  let rawToolTokens = 0;
  for (const item of activeItems) {
    if (MESSAGE_ITEM_TYPES.has(item.type)) {
      rawMessageTokens += Math.ceil(itemTextChars(item) / CHARS_PER_TOKEN) + 4;
    } else if (TOOL_ITEM_TYPES.has(item.type)) {
      rawToolTokens += Math.ceil(itemTextChars(item) / CHARS_PER_TOKEN) + 8;
    }
  }

  const usedTokens = usage.usedTokens;
  let messageTokens: number;
  let toolContextTokens: number;
  let systemAndToolsTokens: number;
  const rawSum = rawMessageTokens + rawToolTokens;
  if (rawSum <= usedTokens) {
    messageTokens = rawMessageTokens;
    toolContextTokens = rawToolTokens;
    systemAndToolsTokens = usedTokens - messageTokens - toolContextTokens;
  } else {
    const overheadFloor = usedTokens >= 1_000 ? Math.round(usedTokens * 0.05) : 0;
    const remaining = Math.max(0, usedTokens - overheadFloor);
    messageTokens = rawSum > 0 ? Math.round((rawMessageTokens / rawSum) * remaining) : 0;
    toolContextTokens = Math.max(0, remaining - messageTokens);
    systemAndToolsTokens = Math.max(0, usedTokens - messageTokens - toolContextTokens);
  }

  return {
    systemAndToolsTokens: nonNegativeInt(systemAndToolsTokens),
    toolContextTokens: nonNegativeInt(toolContextTokens),
    messageTokens: nonNegativeInt(messageTokens),
    usedTokens: nonNegativeInt(usedTokens),
    maxTokens: usage.maxTokens,
    autoCompactThreshold: usage.autoCompactThreshold,
  };
}

/**
 * Whole-thread totals across every provider thread, so a thread that switched
 * providers mid-flight keeps one set of counters. Pure: the caller resolves the
 * Factory Droid ledger snapshots first.
 */
export function computeThreadSessionStats(
  input: ComputeThreadSessionStatsInput,
): OrchestrationV2GetThreadSessionStatsResult {
  const deliveredTurns = input.providerTurns.filter(isDeliveredProviderTurn);
  const itemsByProviderTurn = new Map<string, Array<OrchestrationV2TurnItem>>();
  for (const item of input.turnItems) {
    if (item.providerTurnId === null) continue;
    const key = String(item.providerTurnId);
    const items = itemsByProviderTurn.get(key);
    if (items === undefined) itemsByProviderTurn.set(key, [item]);
    else items.push(item);
  }

  const llmMsByProviderThread = new Map<string, number>();
  let llmDurationMs = 0;
  let toolDurationMs = 0;
  let decodeDurationMs = 0;
  let decodeOutputTokens = 0;

  const turnLlmMs = new Map<string, number>();
  for (const turn of deliveredTurns) {
    const items = itemsByProviderTurn.get(String(turn.id)) ?? [];
    const streamMs = unionDurationMs(
      items
        .filter((item) => STREAM_ITEM_TYPES.has(item.type))
        .flatMap((item) => {
          const interval = itemInterval(item);
          return interval === null ? [] : [interval];
        }),
    );
    const toolMs = unionDurationMs(
      items
        .filter((item) => TOOL_ITEM_TYPES.has(item.type))
        .flatMap((item) => {
          const interval = itemInterval(item);
          return interval === null ? [] : [interval];
        }),
    );
    const startedMs = epochMillis(turn.startedAt);
    const completedMs = epochMillis(turn.completedAt);
    const wallMs =
      startedMs !== null && completedMs !== null ? Math.max(0, completedMs - startedMs) : 0;
    const turnLlm = streamMs > 0 ? streamMs : wallMs > toolMs ? wallMs - toolMs : 0;

    llmDurationMs += turnLlm;
    toolDurationMs += toolMs;
    turnLlmMs.set(String(turn.id), turnLlm);
    const providerThreadKey = String(turn.providerThreadId);
    llmMsByProviderThread.set(
      providerThreadKey,
      (llmMsByProviderThread.get(providerThreadKey) ?? 0) + turnLlm,
    );
  }

  const recordedByProviderThread = new Map<string, TokenTotals>();
  for (const turn of deliveredTurns) {
    const contribution = turnTokenContribution(turn);
    if (contribution === null) continue;
    const key = String(turn.providerThreadId);
    const totals = recordedByProviderThread.get(key) ?? emptyTokenTotals();
    addTokenTotals(totals, contribution);
    recordedByProviderThread.set(key, totals);
  }

  const fallbacks = new Map(
    (input.droidUsageFallbacks ?? []).map((fallback) => [
      String(fallback.providerThreadId),
      fallback.usage,
    ]),
  );
  const appliedFallbacks = new Map<string, DroidSessionUsageSnapshot>();
  for (const providerThread of input.providerThreads) {
    const key = String(providerThread.id);
    const fallback = fallbacks.get(key);
    if (fallback === undefined) continue;
    const recorded = recordedByProviderThread.get(key) ?? emptyTokenTotals();
    if (tokenTotal(droidUsageTotals(fallback)) >= tokenTotal(recorded)) {
      appliedFallbacks.set(key, fallback);
    }
  }

  const tokenUsageTotals = emptyTokenTotals();
  for (const providerThread of input.providerThreads) {
    const key = String(providerThread.id);
    const fallback = appliedFallbacks.get(key);
    if (fallback !== undefined) {
      addTokenTotals(tokenUsageTotals, droidUsageTotals(fallback));
    } else {
      addTokenTotals(tokenUsageTotals, recordedByProviderThread.get(key) ?? emptyTokenTotals());
    }
  }

  for (const turn of deliveredTurns) {
    const providerThreadKey = String(turn.providerThreadId);
    if (appliedFallbacks.has(providerThreadKey)) continue;
    const outputTokens = turnOutputTokens(turn);
    const turnLlm = turnLlmMs.get(String(turn.id)) ?? 0;
    if (outputTokens > 0 && turnLlm > 0) {
      decodeOutputTokens += outputTokens;
      decodeDurationMs += turnLlm;
    }
  }
  for (const [key, usage] of appliedFallbacks) {
    const providerThreadLlmMs = llmMsByProviderThread.get(key) ?? 0;
    // The ledger's assistant time can exceed the time implied by the items, and
    // then it is the better model duration: report it in the total too, so
    // `llmDurationMs` and the TPS denominator name the same measurement.
    if (usage.assistantActiveTimeMs > providerThreadLlmMs) {
      llmDurationMs += usage.assistantActiveTimeMs - providerThreadLlmMs;
      llmMsByProviderThread.set(key, usage.assistantActiveTimeMs);
    }
    if (usage.outputTokens <= 0) continue;
    const duration =
      usage.assistantActiveTimeMs > 0
        ? usage.assistantActiveTimeMs
        : (llmMsByProviderThread.get(key) ?? 0);
    if (duration > 0) {
      decodeOutputTokens += usage.outputTokens;
      decodeDurationMs += duration;
    }
  }

  const tokensPerSecond =
    decodeDurationMs >= 200 && decodeOutputTokens > 0
      ? Math.round((decodeOutputTokens / (decodeDurationMs / 1_000)) * 10) / 10
      : null;

  const providersIncluded: Array<ProviderInstanceId> = [];
  for (const providerThread of input.providerThreads) {
    if (!providersIncluded.includes(providerThread.providerInstanceId)) {
      providersIncluded.push(providerThread.providerInstanceId);
    }
  }

  return {
    threadId: input.thread.id,
    turns: deliveredTurns.length,
    steps: input.turnItems.filter((item) => STEP_ITEM_TYPES.has(item.type)).length,
    llmDurationMs: nonNegativeInt(llmDurationMs),
    toolDurationMs: nonNegativeInt(toolDurationMs),
    decodeDurationMs: nonNegativeInt(decodeDurationMs),
    decodeOutputTokens: nonNegativeInt(decodeOutputTokens),
    tokensPerSecond,
    tokenUsage: asNullableTokens(tokenUsageTotals),
    contextBreakdown: contextBreakdown(input),
    providersIncluded,
  };
}

/** Reads whole-thread counters from persisted records, not the paginated client view. */
export class ThreadSessionStatsQuery extends Context.Service<
  ThreadSessionStatsQuery,
  {
    readonly getThreadSessionStats: (
      input: OrchestrationV2GetThreadSessionStatsInput,
    ) => Effect.Effect<
      OrchestrationV2GetThreadSessionStatsResult,
      OrchestrationV2GetThreadSessionStatsError
    >;
  }
>()("t3/orchestration-v2/ThreadSessionStatsQuery") {}

function mergeInstanceEnvironment(environment: unknown): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  if (!Array.isArray(environment)) return merged;
  for (const variable of environment) {
    if (variable === null || typeof variable !== "object") continue;
    const name = (variable as { readonly name?: unknown }).name;
    const value = (variable as { readonly value?: unknown }).value;
    if (typeof name !== "string" || name.length === 0 || typeof value !== "string") continue;
    merged[name] = value;
  }
  return merged;
}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const getThreadSessionStats = Effect.fn("ThreadSessionStatsQuery.getThreadSessionStats")(
    function* (input: OrchestrationV2GetThreadSessionStatsInput) {
      const records = yield* threads.getThreadRecords(input.threadId, [
        "providerThreads",
        "providerTurns",
        "turnItems",
      ]);
      const settings = yield* settingsService.getSettings;
      const fallbacks: Array<ThreadSessionDroidUsageFallback> = [];
      for (const providerThread of records.providerThreads) {
        const sessionId = providerThread.nativeThreadRef?.nativeId;
        if (!sessionId) continue;
        const needsLedger = records.providerTurns.some(
          (turn) =>
            turn.providerThreadId === providerThread.id &&
            isDeliveredProviderTurn(turn) &&
            (turn.status === "completed" || turn.status === "interrupted") &&
            (turn.turnTokenUsage === undefined ||
              turn.turnTokenUsage.usageStatus === "unavailable"),
        );
        if (!needsLedger) continue;
        const instance = settings.providerInstances[providerThread.providerInstanceId];
        if (instance === undefined || instance.driver !== "acpRegistry") continue;
        const rawConfig =
          instance.config !== null && typeof instance.config === "object"
            ? (instance.config as Record<string, unknown>)
            : {};
        const decodedSettings = decodeAcpRegistrySettings({
          ...rawConfig,
          enabled: instance.enabled ?? true,
        } as unknown);
        if (Option.isNone(decodedSettings)) continue;
        const isDroid = isFactoryDroidInstance(decodedSettings.value);
        const isDsh = !isDroid && isDeepSeekHarnessInstance(decodedSettings.value);
        if (!isDroid && !isDsh) continue;
        const environment = mergeInstanceEnvironment(instance.environment);
        const usage = yield* (
          isDroid
            ? readDroidSessionUsage({
                sessionId,
                cwd: records.thread.worktreePath ?? undefined,
                environment,
              })
            : readDshSessionUsage({
                sessionId,
                cwd: records.thread.worktreePath ?? undefined,
                environment,
              })
        ).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        );
        if (usage !== null) fallbacks.push({ providerThreadId: providerThread.id, usage });
      }

      return computeThreadSessionStats({
        thread: records.thread,
        providerThreads: records.providerThreads,
        providerTurns: records.providerTurns,
        turnItems: records.turnItems,
        droidUsageFallbacks: fallbacks,
      });
    },
    (effect, input) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new OrchestrationV2GetThreadSessionStatsError({
              threadId: input.threadId,
              cause,
            }),
        ),
      ),
  );

  return ThreadSessionStatsQuery.of({ getThreadSessionStats });
});

export const layer = Layer.effect(ThreadSessionStatsQuery, make);
