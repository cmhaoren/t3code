import type { AcpRegistrySettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isDeepSeekHarnessInstance } from "./deepseekIdentity.ts";

const TokenCount = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * DSH writes one `session.v4.jsonl.zstd` per session. Model selections and the
 * session header carry the context later usage events rely on, so the scan
 * state follows the transcript rather than each line standing alone.
 */
export const DshUsageState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  model: Schema.mutableKey(Schema.String),
  malformedRecords: Schema.mutableKey(TokenCount),
});
export type DshUsageState = typeof DshUsageState.Type;

export function initialDshUsageState(): DshUsageState {
  return { sessionId: "", model: "", malformedRecords: 0 };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * DSH stamps usage events with numeric epoch milliseconds in `time`; older
 * records may carry an ISO `timestamp` instead.
 */
function readTimestampMs(record: Record<string, unknown>): number | null {
  const time = record["time"];
  if (typeof time === "number" && Number.isFinite(time) && time > 0) return Math.trunc(time);
  return parseTimestampMs(record["timestamp"]);
}

/**
 * Model resolution runs from the assistant message's source (which can carry
 * gateway prefixes such as `magpie/apigoto/deepseek-flash`), to the event's own
 * model, to the most recent `model/selection`.
 */
function readModel(data: Record<string, unknown>, state: DshUsageState): string {
  const message = data["message"];
  if (isObject(message)) {
    const source = message["source"];
    if (isObject(source)) {
      const model = source["model"];
      if (typeof model === "string" && model.trim().length > 0) return model.trim();
    }
  }
  const direct = data["model"];
  if (typeof direct === "string" && direct.trim().length > 0) return direct.trim();
  return state.model;
}

export function parseDshLine(line: string, state: DshUsageState): readonly UsageRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // The reader only hands over lines matching a marker, so a broken line that
    // still names usage is one we cannot attribute.
    if (line.includes('"usage"')) state.malformedRecords += 1;
    return [];
  }
  return parseDshRecord(parsed, state);
}

function parseDshRecord(parsed: unknown, state: DshUsageState): readonly UsageRecord[] {
  if (!isObject(parsed)) return [];

  const type = parsed["type"];
  if (type === "session") {
    const id = parsed["id"];
    if (typeof id === "string" && id.length > 0) state.sessionId = id;
    return [];
  }

  const data = parsed["data"];
  if (!isObject(data)) return [];

  if (type === "model/selection") {
    const model = data["model"];
    if (typeof model === "string" && model.trim().length > 0) state.model = model.trim();
  }

  const usage = data["usage"];
  if (usage === undefined) return [];
  // The line gate cannot tell a usage-bearing line's shape; a value that cannot
  // be counted is a malformed usage record, not a plain event.
  if (!isObject(usage)) {
    state.malformedRecords += 1;
    return [];
  }

  const timestampMs = readTimestampMs(parsed);
  const model = readModel(data, state);
  if (timestampMs === null || model.length === 0) {
    state.malformedRecords += 1;
    return [];
  }

  const uncachedInputTokens = tokenCount(usage["inputTokens"]);
  const cachedInputTokens = tokenCount(usage["cacheReadTokens"]);
  const cacheCreationTokens = tokenCount(usage["cacheWriteTokens"]);
  const outputTokens = tokenCount(usage["outputTokens"]);
  const reasoningTokens = tokenCount(usage["reasoningTokens"]);
  if (
    uncachedInputTokens === 0 &&
    cachedInputTokens === 0 &&
    cacheCreationTokens === 0 &&
    outputTokens === 0 &&
    reasoningTokens === 0
  ) {
    return [];
  }

  const seq = parsed["seq"];
  const dedupeKey =
    typeof seq === "number" && Number.isFinite(seq) && state.sessionId.length > 0
      ? `${state.sessionId}:${seq}`
      : null;

  return [
    {
      provider: "dsh",
      timestampMs,
      model,
      // Gateway prefixes and harness aliases resolve to a LiteLLM rate key.
      rateModel: dshRateModel(model),
      sessionId: state.sessionId,
      totals: {
        // DSH's `inputTokens` counts uncached input only.
        uncachedInputTokens,
        cachedInputTokens,
        cacheCreationTokens,
        outputTokens,
        reasoningTokens,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey,
    },
  ];
}

export const dshUsageFormat: TranscriptUsageFormat<DshUsageState> = {
  selectFields: {
    type: true,
    id: true,
    time: true,
    timestamp: true,
    seq: true,
    data: {
      usage: true,
      model: true,
      message: { source: { model: true } },
    },
  },
  // State-only lines (session header, model selection) carry no usage.
  usageMarkers: ['"session"', '"model/selection"', '"usage"'],
  parseLine: parseDshLine,
  parseProjected: parseDshRecord,
  state: { initial: initialDshUsageState, schema: DshUsageState },
  readMalformedRecords: (state) => state.malformedRecords,
};

/**
 * Gateways and routes that prefix the underlying model ID in DSH session logs.
 * Names such as `deepseek/` or `anthropic/` are real provider prefixes and stay.
 */
const ROUTE_PREFIXES = new Set([
  "magpie",
  "magpie-anthropic",
  "magpie-openai",
  "apigoto",
  "apigoto-1",
  "apigoto-2",
  "opencode-go",
  "factory",
  "factory-a",
  "factory-g",
  "factory-o",
  "super5",
  "supergpt",
  "claudezz",
  "wokey",
  "xcli",
]);

const DEEPSEEK_FLASH_ALIAS = /^deepseek-(?:v\d+(?:\.\d+)*?-)?flash(?:-\d{4,8})?$/u;
const DEEPSEEK_PRO_ALIAS = /^deepseek-(?:v\d+(?:\.\d+)*?-)?pro(?:-\d{4,8})?$/u;

/**
 * Turns a DSH model ID into the rate-table name. Harness aliases such as
 * `deepseek-v4.1-flash` price as DeepSeek's chat/reasoner models, and gateway
 * prefixes are dropped so the bare model remains.
 */
export function dshRateModel(model: string): string {
  const segments = model
    .trim()
    .split("/")
    .filter((segment) => segment.length > 0);
  while (segments.length > 1 && ROUTE_PREFIXES.has(segments[0]!.toLowerCase())) {
    segments.shift();
  }
  const bare = segments.join("/");
  const alias = bare.toLowerCase();
  if (DEEPSEEK_FLASH_ALIAS.test(alias)) return "deepseek/deepseek-chat";
  if (DEEPSEEK_PRO_ALIAS.test(alias)) return "deepseek/deepseek-reasoner";
  return bare;
}

export const dshUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "dsh",
  format: dshUsageFormat,
  rateModel: dshRateModel,
  directories: Effect.fn("dshUsageReader.directories")(function* ({
    config,
    configured,
    environment,
  }) {
    // Other ACP agents keep their own history; only DSH instances own `~/.dsh`.
    if (configured && config !== undefined && !isDeepSeekHarnessInstance(config)) return [];
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const configuredHome = environment["DSH_HOME"]?.trim();
    const dshHome = configuredHome
      ? expandHomePath(configuredHome, homeDirectory)
      : path.join(homeDirectory, ".dsh");
    return [{ dir: path.join(dshHome, "sessions"), fileName: "session.v4.jsonl.zstd" }];
  }),
};
