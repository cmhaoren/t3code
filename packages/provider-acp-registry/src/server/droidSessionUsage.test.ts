import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  diffDroidSessionUsageToTurnTokenUsage,
  droidSessionSlug,
  type DroidSessionUsageSnapshot,
  readDroidSessionUsage,
} from "./droidSessionUsage.ts";

const sessionId = "0199bf5f-8c3c-7a1e-9f5f-000000000001";

const settings = (
  overrides: {
    readonly inputTokens?: number;
    readonly outputTokens?: number;
    readonly cacheReadTokens?: number;
    readonly cacheCreationTokens?: number;
    readonly thinkingTokens?: number;
    readonly assistantActiveTimeMs?: number;
  } = {},
) => ({
  assistantActiveTimeMs: overrides.assistantActiveTimeMs ?? 197_997,
  tokenUsage: {
    inputTokens: overrides.inputTokens ?? 162_455,
    outputTokens: overrides.outputTokens ?? 23_549,
    cacheCreationTokens: overrides.cacheCreationTokens ?? 0,
    cacheReadTokens: overrides.cacheReadTokens ?? 3_223_808,
    thinkingTokens: overrides.thinkingTokens ?? 0,
  },
  lastCallTokenUsage: { inputTokens: 1_696, outputTokens: 2_828, cacheReadTokens: 97_024 },
});

const snapshot = (
  overrides: Partial<DroidSessionUsageSnapshot> = {},
): DroidSessionUsageSnapshot => ({
  uncachedInputTokens: 162_455,
  outputTokens: 23_549,
  cacheReadTokens: 3_223_808,
  cacheCreationTokens: 0,
  thinkingTokens: 0,
  assistantActiveTimeMs: 197_997,
  ...overrides,
});

const writeSettings = (directory: string, body: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFileString(path.join(directory, `${sessionId}.settings.json`), body);
  });

it.layer(Layer.mergeAll(NodeServices.layer))("readDroidSessionUsage", (it) => {
  it.effect("reads the cwd slug first and keeps uncached input separate from cache reads", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const factoryDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "droid-usage-slug-",
      });
      yield* writeSettings(
        path.join(factoryDir, "sessions", "-D-dstest"),
        JSON.stringify(settings()),
      );

      const usage = yield* readDroidSessionUsage({
        sessionId,
        cwd: "D:\\dstest",
        environment: { FACTORY_HOME: factoryDir },
      });

      expect(usage).toEqual(snapshot());
    }),
  );

  it.effect("finds the session by scanning the sessions directory when the cwd slug differs", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const factoryDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "droid-usage-scan-",
      });
      yield* writeSettings(
        path.join(factoryDir, "sessions", "-C-Users-other-project"),
        JSON.stringify(settings({ inputTokens: 10, outputTokens: 5, cacheReadTokens: 7 })),
      );

      const usage = yield* readDroidSessionUsage({
        sessionId,
        cwd: "D:\\somewhere\\else",
        environment: { FACTORY_HOME: factoryDir },
      });

      expect(usage).toEqual(
        snapshot({
          uncachedInputTokens: 10,
          outputTokens: 5,
          cacheReadTokens: 7,
          assistantActiveTimeMs: 197_997,
        }),
      );
    }),
  );

  it.effect("rejects ids that could escape the sessions directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const factoryDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "droid-usage-invalid-",
      });
      const usage = yield* readDroidSessionUsage({
        sessionId: "../escape",
        environment: { FACTORY_HOME: factoryDir },
      });
      expect(usage).toBeNull();
    }),
  );

  it.effect("reads malformed or missing settings as no usage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const factoryDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "droid-usage-malformed-",
      });
      yield* writeSettings(path.join(factoryDir, "sessions", "-D-dstest"), "{ not json");

      const malformed = yield* readDroidSessionUsage({
        sessionId,
        cwd: "D:\\dstest",
        environment: { FACTORY_HOME: factoryDir },
      });
      const missing = yield* readDroidSessionUsage({
        sessionId: "missing-session",
        cwd: "D:\\dstest",
        environment: { FACTORY_HOME: factoryDir },
      });

      expect(malformed).toBeNull();
      expect(missing).toBeNull();
    }),
  );
});

describe("droidSessionSlug", () => {
  it("encodes a Windows path the way Droid names session directories", () => {
    expect(droidSessionSlug("D:\\dstest")).toBe("-D-dstest");
    expect(droidSessionSlug("C:/Users/me/project")).toBe("-C-Users-me-project");
    expect(droidSessionSlug("relative")).toBe("-relative");
  });

  it("ignores trailing separators so the same project resolves to one directory", () => {
    expect(droidSessionSlug("D:\\dstest\\")).toBe("-D-dstest");
    expect(droidSessionSlug("D:\\dstest\\\\")).toBe("-D-dstest");
    expect(droidSessionSlug("C:/Users/me/project/")).toBe("-C-Users-me-project");
    expect(droidSessionSlug("/home/me/project/")).toBe("-home-me-project");
  });

  it("has no slug for a path made only of separators", () => {
    expect(droidSessionSlug("")).toBeNull();
    expect(droidSessionSlug("   ")).toBeNull();
    expect(droidSessionSlug("/")).toBeNull();
    expect(droidSessionSlug("\\\\")).toBeNull();
  });
});

describe("diffDroidSessionUsageToTurnTokenUsage", () => {
  it("moves cache traffic into input and clamps reasoning to output", () => {
    const usage = diffDroidSessionUsageToTurnTokenUsage(
      snapshot(),
      snapshot({
        uncachedInputTokens: 172_455,
        outputTokens: 25_549,
        cacheReadTokens: 3_223_908,
        cacheCreationTokens: 100,
        thinkingTokens: 40_000,
      }),
      { hasSubagents: false, terminalStatus: "completed" },
    );

    expect(usage).toEqual({
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 10_200,
      cachedInputTokens: 100,
      cacheCreationTokens: 100,
      outputTokens: 2_000,
      reasoningTokens: 2_000,
    });
  });

  it("treats a missing before snapshot as a session that started this turn", () => {
    const usage = diffDroidSessionUsageToTurnTokenUsage(null, snapshot(), {
      hasSubagents: true,
      terminalStatus: "interrupted",
    });

    expect(usage).toEqual({
      usageScope: "main_agent",
      usageStatus: "partial",
      hasSubagents: true,
      inputTokens: 162_455 + 3_223_808,
      cachedInputTokens: 3_223_808,
      cacheCreationTokens: 0,
      outputTokens: 23_549,
    });
  });

  it("returns undefined when the counters did not move", () => {
    expect(
      diffDroidSessionUsageToTurnTokenUsage(snapshot(), snapshot(), {
        hasSubagents: false,
        terminalStatus: "completed",
      }),
    ).toBeUndefined();
    expect(
      diffDroidSessionUsageToTurnTokenUsage(snapshot(), null, {
        hasSubagents: false,
        terminalStatus: "completed",
      }),
    ).toBeUndefined();
  });

  it("never produces negative deltas when a counter is rewritten", () => {
    const usage = diffDroidSessionUsageToTurnTokenUsage(
      snapshot({ outputTokens: 1_000 }),
      snapshot({ outputTokens: 400 }),
      { hasSubagents: false, terminalStatus: "completed" },
    );
    expect(usage).toBeUndefined();
  });
});
