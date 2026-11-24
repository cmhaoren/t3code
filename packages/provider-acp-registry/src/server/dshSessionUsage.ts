import type { OrchestrationV2ProviderTurn, TurnTokenUsage } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { decompressZstdFrames } from "@t3tools/shared/zstdFrames";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * Reads a DeepSeek Harness session ledger at
 * `<dshHome>/sessions/<projectKey>/<segment>/session.v4.jsonl.zstd`.
 *
 * DSH appends one zstd frame per write, so frames are decompressed separately;
 * `data.usage.inputTokens` counts uncached input only.
 */
const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const DshSessionUsageSnapshot = Schema.Struct({
  uncachedInputTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
  cacheReadTokens: NonNegativeInt,
  cacheCreationTokens: NonNegativeInt,
  thinkingTokens: NonNegativeInt,
  assistantActiveTimeMs: NonNegativeInt,
});
export type DshSessionUsageSnapshot = typeof DshSessionUsageSnapshot.Type;

const DSH_SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const MAX_PROJECT_DIRECTORIES = 512;
const MAX_STEP_INTERVALS = 4_096;
const NO_CWD_PROJECT_KEY = "_no-cwd";
const LEDGER_FILES = [
  { name: "session.v4.jsonl.zstd", compressed: true },
  { name: "session.v4.jsonl", compressed: false },
] as const;

const decodeSnapshot = Schema.decodeUnknownOption(DshSessionUsageSnapshot);

const utf8Decoder = new TextDecoder();

const clampCount = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Encodes one path segment the way DSH names session directories. */
export function dshEncodeSegment(raw: string): string {
  if (raw.length === 0) return "";
  if (raw === ".") return "~002E";
  if (raw === "..") return "~002E~002E";
  let encoded = "";
  for (let index = 0; index < raw.length; index += 1) {
    const character = raw[index]!;
    if (character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)) {
      encoded += character;
    } else {
      encoded += `~${raw.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  return encoded;
}

/**
 * DSH names a project's session directory after its cwd, so
 * `C:\Users\老张\Desktop\huibao` becomes `--C-Users-~8001~5F20-Desktop-huibao--`.
 *
 * Separator runs collapse to one `-`; a cwd with no surviving characters is `null`.
 */
export function dshProjectKey(cwd: string): string | null {
  const collapsed = cwd.trim().replace(/[:\\/]+/gu, "-");
  if (collapsed.length === 0) return null;
  let encoded = "";
  for (let index = 0; index < collapsed.length; index += 1) {
    const character = collapsed[index]!;
    if (character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)) {
      encoded += character;
    } else {
      encoded += `~${collapsed.charCodeAt(index).toString(16).toUpperCase().padStart(4, "0")}`;
    }
  }
  const trimmed = encoded.replace(/^-+/u, "");
  const key = trimmed.length === 0 ? "root" : trimmed.slice(0, 251);
  return `--${key}--`;
}

function resolveDshHome(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  path: Path.Path,
): string {
  const configured = nonEmptyString(environment.DSH_HOME);
  if (configured !== undefined) {
    return path.resolve(expandHomePath(configured, homeDirectory));
  }
  return path.join(homeDirectory, ".dsh");
}

/**
 * DSH keeps the `session-` prefix on its directory, but an ACP native id may be
 * the bare session id; try both spellings.
 */
function sessionSegments(sessionId: string): ReadonlyArray<string> {
  const encoded = dshEncodeSegment(sessionId);
  if (sessionId.startsWith("session-")) return [encoded];
  return [encoded, dshEncodeSegment(`session-${sessionId}`)];
}

function decodeLedger(bytes: Uint8Array, compressed: boolean): string | null {
  try {
    if (!compressed) return utf8Decoder.decode(bytes);
    return decompressZstdFrames(bytes).toString("utf8");
  } catch {
    return null;
  }
}

function unionIntervalsMs(intervals: ReadonlyArray<readonly [number, number]>): number {
  if (intervals.length === 0) return 0;
  const sorted = [...intervals].sort((left, right) => left[0] - right[0]);
  let total = 0;
  let start = sorted[0]![0];
  let end = sorted[0]![1];
  for (const [nextStart, nextEnd] of sorted.slice(1)) {
    if (nextStart > end) {
      total += end - start;
      start = nextStart;
      end = nextEnd;
    } else if (nextEnd > end) {
      end = nextEnd;
    }
  }
  total += end - start;
  return Math.max(0, total);
}

interface LedgerTotals {
  uncachedInputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  thinkingTokens: number;
}

/**
 * Sums every `data.usage` record in one ledger. Malformed lines and duplicate
 * `seq` records are skipped; a ledger with no usage record reads as `null`.
 */
function parseSessionLedger(text: string | null): DshSessionUsageSnapshot | null {
  if (text === null) return null;
  const seenSeqs = new Set<number>();
  const pendingSteps = new Map<string, number>();
  const stepIntervals: Array<readonly [number, number]> = [];
  const totals: LedgerTotals = {
    uncachedInputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    thinkingTokens: 0,
  };
  let hasUsage = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event === null || typeof event !== "object") continue;
    const record = event as {
      readonly type?: unknown;
      readonly seq?: unknown;
      readonly time?: unknown;
      readonly data?: unknown;
    };
    if (typeof record.seq === "number" && Number.isFinite(record.seq)) {
      if (seenSeqs.has(record.seq)) continue;
      seenSeqs.add(record.seq);
    }

    const data =
      record.data !== null && typeof record.data === "object"
        ? (record.data as Record<string, unknown>)
        : undefined;
    const time =
      typeof record.time === "number" && Number.isFinite(record.time) ? record.time : null;

    if (record.type === "step/start" || record.type === "step/end") {
      const turn = data?.turn;
      const step = data?.step;
      if (
        typeof turn === "number" &&
        typeof step === "number" &&
        time !== null &&
        stepIntervals.length < MAX_STEP_INTERVALS
      ) {
        const key = `${turn}:${step}`;
        if (record.type === "step/start") {
          pendingSteps.set(key, time);
        } else {
          const startedAt = pendingSteps.get(key);
          if (startedAt !== undefined) {
            pendingSteps.delete(key);
            if (time >= startedAt) stepIntervals.push([startedAt, time] as const);
          }
        }
      }
    }

    const usage = data?.usage;
    if (usage === null || typeof usage !== "object") continue;
    hasUsage = true;
    const counters = usage as Record<string, unknown>;
    totals.uncachedInputTokens += clampCount(counters.inputTokens);
    totals.outputTokens += clampCount(counters.outputTokens);
    totals.cacheReadTokens += clampCount(counters.cacheReadTokens);
    totals.cacheCreationTokens += clampCount(counters.cacheWriteTokens);
    totals.thinkingTokens += clampCount(counters.reasoningTokens);
  }

  if (!hasUsage) return null;
  const snapshot = decodeSnapshot({
    ...totals,
    assistantActiveTimeMs: unionIntervalsMs(stepIntervals),
  });
  return Option.isSome(snapshot) ? snapshot.value : null;
}

const readLedgerSnapshot = Effect.fn("readLedgerSnapshot")(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  segmentDirectory: string,
) {
  for (const ledger of LEDGER_FILES) {
    const bytes = yield* fileSystem
      .readFile(path.join(segmentDirectory, ledger.name))
      .pipe(Effect.orElseSucceed(() => null));
    if (bytes === null) continue;
    const snapshot = parseSessionLedger(decodeLedger(bytes, ledger.compressed));
    if (snapshot !== null) return snapshot;
  }
  return null;
});

/**
 * Reads one DeepSeek Harness session's cumulative counters.
 *
 * A missing, unreadable or malformed ledger reads as `null`; callers treat that
 * as "no usage", never as an error.
 */
export const readDshSessionUsage = Effect.fn("readDshSessionUsage")(function* (input: {
  readonly sessionId: string;
  readonly cwd?: string | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
}): Effect.fn.Return<DshSessionUsageSnapshot | null, never, FileSystem.FileSystem | Path.Path> {
  const sessionId = input.sessionId.trim();
  if (
    !DSH_SESSION_ID_PATTERN.test(sessionId) ||
    sessionId === "." ||
    sessionId === ".." ||
    sessionId.includes("..")
  ) {
    return null;
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeDirectory = yield* HostProcess.HomeDirectory;
  const dshHome = resolveDshHome(input.environment ?? process.env, homeDirectory, path);
  const sessionsDir = path.join(dshHome, "sessions");
  const segments = sessionSegments(sessionId);

  const cwd = input.cwd?.trim();
  if (cwd !== undefined && cwd.length > 0) {
    const projectKey = dshProjectKey(cwd);
    if (projectKey !== null) {
      for (const segment of segments) {
        const snapshot = yield* readLedgerSnapshot(
          fileSystem,
          path,
          path.join(sessionsDir, projectKey, segment),
        );
        if (snapshot !== null) return snapshot;
      }
    }
  }

  for (const segment of segments) {
    const snapshot = yield* readLedgerSnapshot(
      fileSystem,
      path,
      path.join(sessionsDir, NO_CWD_PROJECT_KEY, segment),
    );
    if (snapshot !== null) return snapshot;
  }

  const entries = yield* fileSystem
    .readDirectoryEntries(sessionsDir)
    .pipe(Effect.orElseSucceed(() => []));
  const projectDirectories = entries
    .filter((entry) => entry.type === "Directory")
    .slice(0, MAX_PROJECT_DIRECTORIES);
  for (const entry of projectDirectories) {
    for (const segment of segments) {
      const snapshot = yield* readLedgerSnapshot(
        fileSystem,
        path,
        path.join(sessionsDir, entry.name, segment),
      );
      if (snapshot !== null) return snapshot;
    }
  }
  return null;
});

/**
 * Turns a before/after pair of cumulative DSH counters into one turn's usage.
 *
 * `before` is the snapshot taken just before `session/prompt`; a missing one
 * means the session started during this turn. Deltas are clamped at zero so a
 * counter rewrite never produces negative usage.
 */
export function diffDshSessionUsageToTurnTokenUsage(
  before: DshSessionUsageSnapshot | null | undefined,
  after: DshSessionUsageSnapshot | null | undefined,
  input: {
    readonly hasSubagents: boolean;
    readonly terminalStatus: OrchestrationV2ProviderTurn["status"];
  },
): TurnTokenUsage | undefined {
  if (after == null) return undefined;
  const delta = (pick: (snapshot: DshSessionUsageSnapshot) => number): number =>
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
