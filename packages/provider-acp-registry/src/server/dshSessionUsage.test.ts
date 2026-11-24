// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  diffDshSessionUsageToTurnTokenUsage,
  dshEncodeSegment,
  dshProjectKey,
  type DshSessionUsageSnapshot,
  readDshSessionUsage,
} from "./dshSessionUsage.ts";

const sessionId = "session-0199bf5f-8c3c-7a1e-9f5f-000000000001";

const snapshot = (overrides: Partial<DshSessionUsageSnapshot> = {}): DshSessionUsageSnapshot => ({
  uncachedInputTokens: 104,
  outputTokens: 5_968,
  cacheReadTokens: 13_003,
  cacheCreationTokens: 94_425,
  thinkingTokens: 0,
  assistantActiveTimeMs: 2_500,
  ...overrides,
});

const ledgerSession = {
  type: "session",
  version: 4,
  id: sessionId,
  cwd: "D:\\dstest",
} as const;
const ledgerAssistantMessage = {
  type: "assistant/message",
  seq: 1,
  time: 1_000,
  data: {
    usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 300, totalTokens: 450 },
  },
} as const;
const ledgerCompaction = {
  type: "compaction/summary",
  seq: 2,
  data: {
    usage: {
      inputTokens: 4,
      outputTokens: 5_918,
      cacheReadTokens: 12_703,
      cacheWriteTokens: 94_425,
      totalTokens: 113_050,
    },
  },
} as const;

const frameOf = (lines: ReadonlyArray<unknown>): Buffer =>
  NodeZlib.zstdCompressSync(Buffer.from(lines.map((line) => `${JSON.stringify(line)}\n`).join("")));

/**
 * Three concatenated zstd frames, as DSH appends one frame per write.
 * Frame 2 also carries a malformed line that must be skipped.
 */
const multiFrameLedger = (): Buffer =>
  Buffer.concat([
    frameOf([ledgerSession]),
    Buffer.concat([
      frameOf([
        ledgerAssistantMessage,
        { type: "step/start", seq: 3, time: 2_000, data: { turn: 1, step: 1 } },
      ]),
      NodeZlib.zstdCompressSync(Buffer.from("{ not json\n")),
    ]),
    frameOf([
      { type: "step/end", seq: 4, time: 4_500, data: { turn: 1, step: 1 } },
      ledgerCompaction,
      // A retried write repeats a sequence number; it must not be counted twice.
      ledgerAssistantMessage,
    ]),
  ]);

const writeLedger = (directory: string, name: string, bytes: Uint8Array) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    yield* fileSystem.writeFile(path.join(directory, name), bytes);
  });

it.layer(Layer.mergeAll(NodeServices.layer))("readDshSessionUsage", (it) => {
  it.effect("reads a multi-frame ledger and keeps uncached input separate from cache traffic", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dshHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "dsh-usage-frames-" });
      const projectKey = dshProjectKey("D:\\dstest");
      expect(projectKey).not.toBeNull();
      yield* writeLedger(
        path.join(dshHome, "sessions", projectKey!, dshEncodeSegment(sessionId)),
        "session.v4.jsonl.zstd",
        multiFrameLedger(),
      );

      const usage = yield* readDshSessionUsage({
        sessionId,
        cwd: "D:\\dstest",
        environment: { DSH_HOME: dshHome },
      });

      expect(usage).toEqual(snapshot());
    }),
  );

  it.effect("recovers every complete frame when the trailing frame is truncated", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dshHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "dsh-usage-truncated-" });
      const complete = multiFrameLedger();
      const tail = NodeZlib.zstdCompressSync(
        Buffer.from('{"type":"assistant/message","seq":9,"data":{"usage":{"inputTokens":999}}}\n'),
      );
      const truncated = Buffer.concat([
        complete,
        tail.subarray(0, Math.max(1, Math.floor(tail.length / 2))),
      ]);
      const projectKey = dshProjectKey("D:\\dstest")!;
      yield* writeLedger(
        path.join(dshHome, "sessions", projectKey, dshEncodeSegment(sessionId)),
        "session.v4.jsonl.zstd",
        truncated,
      );

      const usage = yield* readDshSessionUsage({
        sessionId,
        cwd: "D:\\dstest",
        environment: { DSH_HOME: dshHome },
      });

      expect(usage).toEqual(snapshot());
    }),
  );

  it.effect("finds the ledger by scanning the sessions directory when cwd is omitted", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dshHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "dsh-usage-scan-" });
      yield* writeLedger(
        path.join(dshHome, "sessions", "--D-somewhere-else--", dshEncodeSegment(sessionId)),
        "session.v4.jsonl.zstd",
        multiFrameLedger(),
      );

      const usage = yield* readDshSessionUsage({
        sessionId,
        environment: { DSH_HOME: dshHome },
      });

      expect(usage).toEqual(snapshot());
    }),
  );

  it.effect("reads the uncompressed jsonl ledger when no zstd file exists", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dshHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "dsh-usage-jsonl-" });
      yield* writeLedger(
        path.join(dshHome, "sessions", "_no-cwd", dshEncodeSegment(sessionId)),
        "session.v4.jsonl",
        Buffer.from(
          [ledgerSession, ledgerAssistantMessage, ledgerCompaction]
            .map((line) => `${JSON.stringify(line)}\n`)
            .join(""),
        ),
      );

      const usage = yield* readDshSessionUsage({
        sessionId,
        environment: { DSH_HOME: dshHome },
      });

      expect(usage).toEqual(snapshot({ assistantActiveTimeMs: 0 }));
    }),
  );

  it.effect("rejects ids that could escape the sessions directory", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const dshHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "dsh-usage-invalid-" });
      const escaped = yield* readDshSessionUsage({
        sessionId: "../escape",
        environment: { DSH_HOME: dshHome },
      });
      const dotDot = yield* readDshSessionUsage({
        sessionId: "..",
        environment: { DSH_HOME: dshHome },
      });
      expect(escaped).toBeNull();
      expect(dotDot).toBeNull();
    }),
  );

  it.effect("reads a missing or malformed ledger as no usage", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dshHome = yield* fileSystem.makeTempDirectoryScoped({ prefix: "dsh-usage-malformed-" });
      yield* writeLedger(
        path.join(dshHome, "sessions", "_no-cwd", dshEncodeSegment(sessionId)),
        "session.v4.jsonl.zstd",
        NodeZlib.zstdCompressSync(Buffer.from("not json at all\n")),
      );

      const malformed = yield* readDshSessionUsage({
        sessionId,
        environment: { DSH_HOME: dshHome },
      });
      const missing = yield* readDshSessionUsage({
        sessionId: "session-missing",
        environment: { DSH_HOME: dshHome },
      });

      expect(malformed).toBeNull();
      expect(missing).toBeNull();
    }),
  );
});

describe("dshProjectKey", () => {
  it("encodes a Windows path the way DSH names session directories", () => {
    expect(dshProjectKey("C:\\Users\\老张\\Desktop\\huibao")).toBe(
      "--C-Users-~8001~5F20-Desktop-huibao--",
    );
    expect(dshProjectKey("D:\\dstest")).toBe("--D-dstest--");
    expect(dshProjectKey("D:\\新建文件夹")).toBe("--D-~65B0~5EFA~6587~4EF6~5939--");
  });

  it("collapses separator runs before encoding", () => {
    expect(dshProjectKey("D:\\\\a//b")).toBe("--D-a-b--");
    expect(dshProjectKey("///")).toBe("--root--");
  });
});

describe("dshEncodeSegment", () => {
  it("escapes dot segments and non-ASCII code units", () => {
    expect(dshEncodeSegment("")).toBe("");
    expect(dshEncodeSegment(".")).toBe("~002E");
    expect(dshEncodeSegment("..")).toBe("~002E~002E");
    expect(dshEncodeSegment("session-abc_1.2")).toBe("session-abc_1.2");
    expect(dshEncodeSegment("老张")).toBe("~8001~5F20");
  });
});

describe("diffDshSessionUsageToTurnTokenUsage", () => {
  it("moves cache traffic into input and clamps reasoning to output", () => {
    const usage = diffDshSessionUsageToTurnTokenUsage(null, snapshot({ thinkingTokens: 40 }), {
      hasSubagents: false,
      terminalStatus: "completed",
    });
    expect(usage).toEqual({
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 104 + 13_003 + 94_425,
      cachedInputTokens: 13_003,
      cacheCreationTokens: 94_425,
      outputTokens: 5_968,
      reasoningTokens: 40,
    });
  });

  it("subtracts the before snapshot when the session spanned several turns", () => {
    const usage = diffDshSessionUsageToTurnTokenUsage(
      snapshot(),
      snapshot({
        uncachedInputTokens: 154,
        outputTokens: 6_018,
        cacheReadTokens: 13_053,
        cacheCreationTokens: 94_425,
        thinkingTokens: 0,
      }),
      { hasSubagents: false, terminalStatus: "interrupted" },
    );
    expect(usage).toEqual({
      usageScope: "main_agent",
      usageStatus: "partial",
      hasSubagents: false,
      inputTokens: 50 + 50,
      cachedInputTokens: 50,
      cacheCreationTokens: 0,
      outputTokens: 50,
    });
  });

  it("returns undefined when the counters did not move", () => {
    expect(
      diffDshSessionUsageToTurnTokenUsage(snapshot(), snapshot(), {
        hasSubagents: false,
        terminalStatus: "completed",
      }),
    ).toBeUndefined();
    expect(
      diffDshSessionUsageToTurnTokenUsage(null, null, {
        hasSubagents: false,
        terminalStatus: "completed",
      }),
    ).toBeUndefined();
  });

  it("never produces negative deltas when a counter is rewritten", () => {
    const usage = diffDshSessionUsageToTurnTokenUsage(
      snapshot({ uncachedInputTokens: 1_000, cacheReadTokens: 5_000, outputTokens: 10 }),
      snapshot({ uncachedInputTokens: 10, cacheReadTokens: 10, outputTokens: 20 }),
      { hasSubagents: true, terminalStatus: "completed" },
    );
    expect(usage).toEqual({
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: true,
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 10,
    });
  });
});
