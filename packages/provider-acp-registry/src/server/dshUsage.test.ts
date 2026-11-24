// @effect-diagnostics nodeBuiltinImport:off - expectations mirror this host's path separators.
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodePath from "node:path";

import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { ProviderUsageInstance } from "@t3tools/provider-core/server/usage";

import type { AcpRegistrySettings } from "../settings.ts";

import {
  dshRateModel,
  dshUsageFormat,
  dshUsageReader,
  initialDshUsageState,
  parseDshLine,
  type DshUsageState,
} from "./dshUsage.ts";

const sessionLine = JSON.stringify({
  type: "session",
  version: 4,
  id: "session-abc",
  createdAt: 1_700_000_000_000,
});

const modelSelectionLine = JSON.stringify({
  type: "model/selection",
  seq: 1,
  time: 1_700_000_000_001,
  data: { provider: "apigoto", model: "apigoto/deepseek-v4.1-flash" },
});

function usageLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "assistant/message",
    seq: 2,
    time: 1_700_000_000_002,
    data: {
      usage: {
        inputTokens: 11,
        cacheReadTokens: 22,
        cacheWriteTokens: 33,
        outputTokens: 44,
        reasoningTokens: 5,
      },
      message: { source: { model: "apigoto/deepseek-flash" } },
    },
    ...overrides,
  });
}

const settings = (overrides: Partial<AcpRegistrySettings> = {}): AcpRegistrySettings => ({
  source: "registry",
  enabled: true,
  agentId: "",
  commandPath: "",
  commandArgs: [],
  authMethodId: "",
  distribution: "auto",
  customModels: [],
  ...overrides,
});

const instance = (
  config: AcpRegistrySettings | undefined,
  environment: NodeJS.ProcessEnv = {},
  configured = true,
): ProviderUsageInstance<AcpRegistrySettings> => ({
  instanceId: ProviderInstanceId.make("acp-1"),
  configured,
  config,
  environment,
});

const transcriptsReader = (() => {
  const reader = dshUsageReader;
  if (reader.kind !== "transcripts") throw new Error("dshUsageReader must read transcripts");
  return reader;
})();

const dshStateCodec = dshUsageFormat.state;
if (dshStateCodec === undefined) throw new Error("dsh usage format must persist state");
const encodeDshUsageState = Schema.encodeSync(dshStateCodec.schema);
const decodeDshUsageState = Schema.decodeUnknownSync(dshStateCodec.schema);

describe("dshUsageFormat", () => {
  it("carries session id and model into usage events and maps every token channel", () => {
    const state = initialDshUsageState();
    expect(parseDshLine(sessionLine, state)).toEqual([]);
    expect(parseDshLine(modelSelectionLine, state)).toEqual([]);
    expect(state).toEqual({
      sessionId: "session-abc",
      model: "apigoto/deepseek-v4.1-flash",
      malformedRecords: 0,
    });

    const records = parseDshLine(usageLine(), state);
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      provider: "dsh",
      timestampMs: 1_700_000_000_002,
      model: "apigoto/deepseek-flash",
      rateModel: "deepseek/deepseek-chat",
      sessionId: "session-abc",
      totals: {
        uncachedInputTokens: 11,
        cachedInputTokens: 22,
        cacheCreationTokens: 33,
        outputTokens: 44,
        reasoningTokens: 5,
      },
      reportedCostUsd: null,
      speed: "standard",
      dedupeKey: "session-abc:2",
    });
  });

  it("falls back from the message source model to the event model to the carried model", () => {
    const state: DshUsageState = {
      sessionId: "session-1",
      model: "carried-model",
      malformedRecords: 0,
    };

    const fromEvent = JSON.parse(usageLine());
    fromEvent.data.message = {};
    fromEvent.data.model = "event-model";
    expect(parseDshLine(JSON.stringify(fromEvent), state)[0]?.model).toBe("event-model");

    const carried = JSON.parse(usageLine());
    carried.data.message = {};
    expect(parseDshLine(JSON.stringify(carried), state)[0]?.model).toBe("carried-model");
  });

  it("falls back to an ISO timestamp and counts usage without a usable time as malformed", () => {
    const state = initialDshUsageState();
    const iso = JSON.stringify({
      type: "session/title-llm-request",
      seq: 4,
      timestamp: "2026-08-01T10:00:00Z",
      data: { model: "deepseek-v4-pro", usage: { inputTokens: 3, outputTokens: 4 } },
    });
    const records = parseDshLine(iso, state);
    expect(records).toHaveLength(1);
    expect(records[0]?.timestampMs).toBe(Date.parse("2026-08-01T10:00:00Z"));
    expect(records[0]?.totals.uncachedInputTokens).toBe(3);
    expect(records[0]?.dedupeKey).toBeNull();

    const noTime = JSON.stringify({
      type: "web/deepseek-search-llm-request",
      data: { model: "deepseek-flash", usage: { inputTokens: 1 } },
    });
    expect(parseDshLine(noTime, state)).toEqual([]);
    expect(state.malformedRecords).toBe(1);
  });

  it("skips events without usage and counts corrupt or unusable usage lines once", () => {
    const state = initialDshUsageState();
    expect(
      parseDshLine(JSON.stringify({ type: "user/message", time: 1, data: {} }), state),
    ).toEqual([]);
    expect(state.malformedRecords).toBe(0);

    // A corrupt line only counts when it still names usage.
    expect(parseDshLine('{"type":"session","version":4', state)).toEqual([]);
    expect(state.malformedRecords).toBe(0);
    expect(parseDshLine('{"type":"assistant/message","data":{"usage":', state)).toEqual([]);
    expect(state.malformedRecords).toBe(1);

    const nonObjectUsage = JSON.stringify({
      type: "assistant/message",
      time: 1_700_000_000_000,
      data: { model: "deepseek-flash", usage: "invalid" },
    });
    expect(parseDshLine(nonObjectUsage, state)).toEqual([]);
    expect(state.malformedRecords).toBe(2);
    expect(dshUsageFormat.readMalformedRecords?.(state)).toBe(2);
  });

  it("round-trips its scan state through the cache codec", () => {
    const state = initialDshUsageState();
    parseDshLine(sessionLine, state);
    parseDshLine('{"type":"compaction/summary","data":{"usage":', state);
    const encoded = encodeDshUsageState(state);
    expect(decodeDshUsageState(encoded)).toEqual(state);
  });

  it("declares session, model selection and usage markers", () => {
    expect(dshUsageFormat.usageMarkers).toEqual(['"session"', '"model/selection"', '"usage"']);
  });
});

describe("dshRateModel", () => {
  it.each([
    ["deepseek-flash", "deepseek/deepseek-chat"],
    ["deepseek-v4-flash", "deepseek/deepseek-chat"],
    ["deepseek-v4.1-flash", "deepseek/deepseek-chat"],
    ["deepseek-v4.1-flash-1017", "deepseek/deepseek-chat"],
    ["deepseek-v4-pro", "deepseek/deepseek-reasoner"],
    ["deepseek-v4-pro-20261017", "deepseek/deepseek-reasoner"],
    ["apigoto/deepseek-flash", "deepseek/deepseek-chat"],
    ["magpie/apigoto/deepseek-flash", "deepseek/deepseek-chat"],
    ["opencode-go/deepseek-v4.1-flash", "deepseek/deepseek-chat"],
    ["factory-a/deepseek-v4-pro", "deepseek/deepseek-reasoner"],
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["wokey/claude-opus-5-5", "claude-opus-5-5"],
    ["magpie-anthropic/supergpt/claude-opus-5-5", "claude-opus-5-5"],
    ["deepseek/deepseek-chat", "deepseek/deepseek-chat"],
    ["  apigoto/gpt-image-2.5-flare  ", "gpt-image-2.5-flare"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(dshRateModel(input)).toBe(expected);
  });
});

describe("dshUsageReader", () => {
  it("is a transcript reader for the dsh provider", () => {
    expect(transcriptsReader.provider).toBe("dsh");
    expect(transcriptsReader.format).toBe(dshUsageFormat);
    expect(transcriptsReader.rateModel).toBe(dshRateModel);
  });

  it.effect("reads DSH home only for DSH or unconfigured instances", () => {
    const home = "C:\\Users\\tester";
    return Effect.gen(function* () {
      const localDsh = yield* transcriptsReader.directories(
        instance(settings({ source: "local", commandPath: "dsh" }), {
          DSH_HOME: "~/custom-dsh",
        }),
        { awaitRefresh: false },
      );
      expect(localDsh).toEqual([
        {
          dir: NodePath.join(home, "custom-dsh", "sessions"),
          fileName: "session.v4.jsonl.zstd",
        },
      ]);

      const registryDsh = yield* transcriptsReader.directories(
        instance(settings({ agentId: "deepseek-harness" })),
        { awaitRefresh: false },
      );
      expect(registryDsh).toEqual([
        { dir: NodePath.join(home, ".dsh", "sessions"), fileName: "session.v4.jsonl.zstd" },
      ]);

      const unconfigured = yield* transcriptsReader.directories(instance(undefined, {}, false), {
        awaitRefresh: false,
      });
      expect(unconfigured).toEqual([
        { dir: NodePath.join(home, ".dsh", "sessions"), fileName: "session.v4.jsonl.zstd" },
      ]);

      const otherAgent = yield* transcriptsReader.directories(
        instance(settings({ agentId: "devin" }), { DSH_HOME: "~/ignored" }),
        { awaitRefresh: false },
      );
      expect(otherAgent).toEqual([]);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.HomeDirectory, home),
    );
  });
});
