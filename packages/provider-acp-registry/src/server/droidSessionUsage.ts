import type { OrchestrationV2ProviderTurn, TurnTokenUsage } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveFactoryDir } from "./factoryUsageLimits.ts";

/**
 * Reads `<factoryDir>/sessions/<slug>/<sessionId>.settings.json`.
 *
 * Its `tokenUsage.inputTokens` is uncached input; cache reads and writes are
 * counted separately, while T3's `TurnTokenUsage.inputTokens` includes all three.
 */
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DroidSessionUsageSnapshot = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  thinkingTokens: NonNegativeInt,
  assistantActiveTimeMs: NonNegativeInt,
});
export type DroidSessionUsageSnapshot = typeof DroidSessionUsageSnapshot.Type;

const DROID_SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_SESSION_DIRECTORIES = 256;

const optionalCount = Schema.optional(Schema.NullOr(Schema.Number));
const DroidUsageCountersFile = Schema.Struct({
  inputTokens: optionalCount,
  outputTokens: optionalCount,
  cacheCreationTokens: optionalCount,
  cacheReadTokens: optionalCount,
  thinkingTokens: optionalCount,
});
const DroidSessionSettingsFile = Schema.Struct({
  assistantActiveTimeMs: optionalCount,
  tokenUsage: Schema.optional(Schema.NullOr(DroidUsageCountersFile)),
});

const decodeSettingsFile = Schema.decodeUnknownOption(DroidSessionSettingsFile);
const decodeSnapshot = Schema.decodeUnknownOption(DroidSessionUsageSnapshot);

const clampCount = (value: number | null | undefined): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

/**
 * Droid names a session's directory after its cwd: `D:\dstest` becomes `-D-dstest`.
 *
 * Trailing separators are dropped first, so a project opened as `D:\dstest\`
 * resolves to the same directory as `D:\dstest`. A path that is only separators
 * (`/`, `\`) has no project component and reads as `null`.
 */
export function droidSessionSlug(cwd: string): string | null {
  const normalized = cwd
    .trim()
    .replace(/[\\/]+$/g, "")
    .replace(/[:\\/]+/g, "-");
  if (normalized.length === 0) return null;
  return normalized.startsWith("-") ? normalized : `-${normalized}`;
}

function parseSnapshot(text: string | null): DroidSessionUsageSnapshot | null {
  if (text === null) return null;
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const decoded = decodeSettingsFile(json);
  if (Option.isNone(decoded)) return null;
  const counters = decoded.value.tokenUsage ?? {};
  const snapshot = decodeSnapshot({
    uncachedInputTokens: clampCount(counters.inputTokens),
    outputTokens: clampCount(counters.outputTokens),
    cacheReadTokens: clampCount(counters.cacheReadTokens),
    cacheCreationTokens: clampCount(counters.cacheCreationTokens),
    thinkingTokens: clampCount(counters.thinkingTokens),
    assistantActiveTimeMs: clampCount(decoded.value.assistantActiveTimeMs),
  });
  return Option.isSome(snapshot) ? snapshot.value : null;
}

/**
 * Reads one Factory Droid session's cumulative counters.
 *
 * A missing, unreadable or malformed file reads as `null`; callers treat that as
 * "no usage", never as an error.
 */
export const readDroidSessionUsage = Effect.fn("readDroidSessionUsage")(function* (input: {
  readonly sessionId: string;
  readonly cwd?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): Effect.fn.Return<DroidSessionUsageSnapshot | null, never, FileSystem.FileSystem | Path.Path> {
  if (!DROID_SESSION_ID_PATTERN.test(input.sessionId)) return null;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const factoryDir = resolveFactoryDir(input.environment ?? process.env, homeDirectory, path);
  const sessionsDir = path.join(factoryDir, "sessions");
  const readSnapshot = (directory: string) =>
    fileSystem.readFileString(path.join(directory, `${input.sessionId}.settings.json`)).pipe(
      Effect.orElseSucceed(() => null),
      Effect.map(parseSnapshot),
    );

  const cwd = input.cwd?.trim();
  if (cwd !== undefined && cwd.length > 0) {
    const slug = droidSessionSlug(cwd);
    if (slug !== null) {
      const snapshot = yield* readSnapshot(path.join(sessionsDir, slug));
      if (snapshot !== null) return snapshot;
    }
  }

  const entries = yield* fileSystem
    .readDirectoryEntries(sessionsDir)
    .pipe(Effect.orElseSucceed(() => []));
  const directories = entries
    .filter((entry) => entry.type === "Directory")
    .slice(0, MAX_SESSION_DIRECTORIES);
  for (const entry of directories) {
    const snapshot = yield* readSnapshot(path.join(sessionsDir, entry.name));
    if (snapshot !== null) return snapshot;
  }
  return null;
});

/**
 * Turns a before/after pair of cumulative Droid counters into one turn's usage.
 *
 * `before` is the snapshot taken just before `session/prompt`; a missing one
 * means the session started during this turn. Deltas are clamped at zero so a
 * counter rewrite never produces negative usage.
 */
export function diffDroidSessionUsageToTurnTokenUsage(
  before: DroidSessionUsageSnapshot | null | undefined,
  after: DroidSessionUsageSnapshot | null | undefined,
  input: {
    readonly hasSubagents: boolean;
    readonly terminalStatus: OrchestrationV2ProviderTurn["status"];
  },
): TurnTokenUsage | undefined {
  if (after == null) return undefined;
  const delta = (pick: (snapshot: DroidSessionUsageSnapshot) => number): number =>
    Math.max(0, pick(after) - (before == null ? 0 : pick(before)));

  const uncachedInputTokens = delta((snapshot) => snapshot.uncachedInputTokens);
  const cacheReadTokens = delta((snapshot) => snapshot.cacheReadTokens);
  const cacheCreationTokens = delta((snapshot) => snapshot.cacheCreationTokens);
  const outputTokens = delta((snapshot) => snapshot.outputTokens);
  const thinkingTokens = delta((snapshot) => snapshot.thinkingTokens);
  if (
    uncachedInputTokens === 0 &&
    cacheReadTokens === 0 &&
    cacheCreationTokens === 0 &&
    outputTokens === 0 &&
    thinkingTokens === 0
  ) {
    return undefined;
  }

  return {
    usageScope: "main_agent",
    usageStatus: input.terminalStatus === "completed" ? "complete" : "partial",
    hasSubagents: input.hasSubagents,
    inputTokens: uncachedInputTokens + cacheReadTokens + cacheCreationTokens,
    cachedInputTokens: cacheReadTokens,
    cacheCreationTokens,
    outputTokens,
    ...(thinkingTokens > 0 ? { reasoningTokens: Math.min(outputTokens, thinkingTokens) } : {}),
  };
}
