import { describe, expect, it } from "@effect/vitest";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  createDeepSeekApigotoFailover,
  deepseekPromptFailure,
  isApigotoFailoverError,
  isApigotoRouteProvider,
  parseDeepSeekModelValue,
} from "./deepseekAcp.ts";

const requestError = (code: number, errorMessage: string, cause?: unknown) =>
  new EffectAcpErrors.AcpRequestError({
    code,
    errorMessage,
    ...(cause === undefined ? {} : { cause }),
  });

const apigoto1 = '["apigoto-1","deepseek-flash"]';
const apigoto2 = '["apigoto-2","deepseek-flash"]';
const apigoto3 = '["apigoto-3","deepseek-pro"]';
const official = '["deepseek-official","deepseek-flash"]';

describe("parseDeepSeekModelValue", () => {
  it("reads the JSON route pair DeepSeek Harness stores in the model option", () => {
    expect(parseDeepSeekModelValue(' ["apigoto-1", "deepseek-flash"] ')).toEqual({
      provider: "apigoto-1",
      model: "deepseek-flash",
      format: "json",
    });
    expect(parseDeepSeekModelValue('["apigoto-2","deepseek-flash","extra"]')).toEqual({
      provider: "apigoto-2",
      model: "deepseek-flash",
      format: "json",
    });
  });

  it("reads slash route pairs", () => {
    expect(parseDeepSeekModelValue("apigoto_1/deepseek-flash")).toEqual({
      provider: "apigoto_1",
      model: "deepseek-flash",
      format: "slash",
    });
    expect(parseDeepSeekModelValue("deepseek-official/deepseek-pro")).toEqual({
      provider: "deepseek-official",
      model: "deepseek-pro",
      format: "slash",
    });
  });

  it("rejects values that carry no distinct provider and model", () => {
    expect(parseDeepSeekModelValue("")).toBeUndefined();
    expect(parseDeepSeekModelValue("deepseek-flash")).toBeUndefined();
    expect(parseDeepSeekModelValue("/deepseek-flash")).toBeUndefined();
    expect(parseDeepSeekModelValue("apigoto-1/")).toBeUndefined();
    expect(parseDeepSeekModelValue('["apigoto-1"]')).toBeUndefined();
    expect(parseDeepSeekModelValue('["apigoto-1", 2]')).toBeUndefined();
    expect(parseDeepSeekModelValue("[not json")).toBeUndefined();
  });
});

describe("isApigotoRouteProvider", () => {
  it("matches numbered and named apigoto routes", () => {
    for (const provider of ["apigoto", "apigoto-1", "apigoto-2", "apigoto_1", "APIGOTO-ROUTE"]) {
      expect(isApigotoRouteProvider(provider)).toBe(true);
    }
  });

  it("rejects the official DeepSeek routes and unrelated providers", () => {
    for (const provider of [
      "deepseek-official",
      "deepseek-account",
      "apigoto-",
      "apigoto route",
      "xapigoto-1",
    ]) {
      expect(isApigotoRouteProvider(provider)).toBe(false);
    }
  });
});

describe("isApigotoFailoverError", () => {
  it("treats provider quota, rate-limit, auth and balance failures as failover signals", () => {
    expect(isApigotoFailoverError(requestError(-32603, "Internal error: turn failed: 401"))).toBe(
      true,
    );
    expect(
      isApigotoFailoverError(
        requestError(-32603, "Internal error", "429 rate limit exceeded for apigoto-1"),
      ),
    ).toBe(true);
    expect(isApigotoFailoverError(new Error("Insufficient balance"))).toBe(true);
    expect(isApigotoFailoverError("quota exhausted")).toBe(true);
    expect(isApigotoFailoverError({ message: "invalid api key" })).toBe(true);
  });

  it("does not fail over on cancellation", () => {
    expect(isApigotoFailoverError(requestError(-32800, "Request cancelled"))).toBe(false);
    expect(isApigotoFailoverError(new Error("The turn was cancelled by the client"))).toBe(false);
    expect(
      isApigotoFailoverError(
        requestError(-32603, "Internal error", { message: "canceled by the user" }),
      ),
    ).toBe(false);
  });

  it("does not fail over on context-window overflow", () => {
    expect(isApigotoFailoverError(new Error("maximum context length exceeded"))).toBe(false);
    expect(
      isApigotoFailoverError(requestError(-32603, "context window limit", "too many tokens")),
    ).toBe(false);
  });

  it("ignores unrelated provider errors and empty values", () => {
    expect(isApigotoFailoverError(undefined)).toBe(false);
    expect(isApigotoFailoverError(null)).toBe(false);
    expect(isApigotoFailoverError({})).toBe(false);
    expect(isApigotoFailoverError(new Error("tool crashed"))).toBe(false);
  });
});

describe("deepseekPromptFailure", () => {
  it("classifies usage-limit failures with the ACP message and code", () => {
    const failure = deepseekPromptFailure(requestError(-32603, "turn failed: 429 rate limit"));
    expect(failure.class).toBe("usage_limit");
    expect(failure.message).toBe("turn failed: 429 rate limit");
    expect(failure.code).toBe("-32603");
    expect(failure.retryable).toBe(true);
  });

  it("classifies auth failures separately", () => {
    const failure = deepseekPromptFailure(requestError(-32603, "turn failed: 401 invalid api key"));
    expect(failure.class).toBe("permission_error");
    expect(failure.message).toBe("turn failed: 401 invalid api key");
    expect(failure.retryable).toBe(false);
  });

  it("falls back to provider_error for other failures", () => {
    const failure = deepseekPromptFailure(new Error("the agent crashed"));
    expect(failure.class).toBe("provider_error");
    expect(failure.message).toContain("the agent crashed");
    expect(failure.code).toBeNull();
  });

  it("reads the cause chain when the wrapper carries no message", () => {
    const failure = deepseekPromptFailure(
      requestError(-32603, "Internal error", "402 balance insufficient"),
    );
    expect(failure.class).toBe("usage_limit");
    expect(failure.message).toBe("Internal error");
  });
});

describe("createDeepSeekApigotoFailover", () => {
  it("keeps the requested route on a fresh manual selection", () => {
    const failover = createDeepSeekApigotoFailover();
    expect(failover.resolvePreferredModelId(apigoto1, [apigoto1, apigoto2])).toBe(apigoto1);
  });

  it("moves a cooled route to a healthy sibling with the same model", () => {
    let now = 1_000;
    const failover = createDeepSeekApigotoFailover({ cooldownMs: 5_000, now: () => now });
    expect(failover.resolvePreferredModelId(apigoto1, [apigoto1, apigoto2, apigoto3])).toBe(
      apigoto1,
    );
    expect(
      failover.resolvePromptErrorFailoverModel({
        error: requestError(-32603, "429 rate limit"),
        currentModelId: apigoto1,
        availableModelIds: [apigoto1, apigoto2, apigoto3],
        triedModelIds: new Set([apigoto1]),
      }),
    ).toEqual({
      nextModelId: apigoto2,
      reason: "Switched apigoto route from apigoto-1 to apigoto-2 after error; retrying turn.",
    });
    // apigoto-1 stays lastRequested, so the next turn picks the same-model healthy sibling.
    expect(failover.resolvePreferredModelId(apigoto1, [apigoto1, apigoto2, apigoto3])).toBe(
      apigoto2,
    );
    now += 6_000;
    expect(failover.resolvePreferredModelId(apigoto1, [apigoto1, apigoto2, apigoto3])).toBe(
      apigoto1,
    );
  });

  it("keeps cooldown on initial resolvePreferredModelId after an error-driven failover, until manually switched", () => {
    let now = 1_000;
    const failover = createDeepSeekApigotoFailover({ cooldownMs: 5_000, now: () => now });
    // First-turn error triggers failover before resolvePreferredModelId has seen a requested model.
    expect(
      failover.resolvePromptErrorFailoverModel({
        error: requestError(-32603, "429 rate limit"),
        currentModelId: apigoto1,
        availableModelIds: [apigoto1, apigoto2],
        triedModelIds: new Set([apigoto1]),
      })?.nextModelId,
    ).toBe(apigoto2);
    expect(failover.resolvePreferredModelId(apigoto1, [apigoto1, apigoto2])).toBe(apigoto2);
    // An explicit UI switch to another model and back still overrides cooldown.
    expect(failover.resolvePreferredModelId(apigoto2, [apigoto1, apigoto2])).toBe(apigoto2);
    expect(failover.resolvePreferredModelId(apigoto1, [apigoto1, apigoto2])).toBe(apigoto1);
  });

  it("lets a manual switch to the cooled route win over the cooldown", () => {
    const failover = createDeepSeekApigotoFailover({ now: () => 1_000 });
    failover.resolvePreferredModelId(apigoto1, [apigoto1, apigoto2]);
    failover.resolvePromptErrorFailoverModel({
      error: requestError(-32603, "429 rate limit"),
      currentModelId: apigoto1,
      availableModelIds: [apigoto1, apigoto2],
      triedModelIds: new Set([apigoto1]),
    });
    // The user now picks apigoto-2, then goes back to apigoto-1 while it is still cooling.
    expect(failover.resolvePreferredModelId(apigoto2, [apigoto1, apigoto2])).toBe(apigoto2);
    expect(failover.resolvePreferredModelId(apigoto1, [apigoto1, apigoto2])).toBe(apigoto1);
  });

  it("never crosses between apigoto routes and the official DeepSeek route", () => {
    const failover = createDeepSeekApigotoFailover();
    expect(
      failover.resolvePromptErrorFailoverModel({
        error: requestError(-32603, "429 rate limit"),
        currentModelId: official,
        availableModelIds: [official, apigoto1, apigoto2],
        triedModelIds: new Set([official]),
      }),
    ).toBeUndefined();
    expect(
      failover.resolvePromptErrorFailoverModel({
        error: requestError(-32603, "429 rate limit"),
        currentModelId: "unparseable-model",
        availableModelIds: ["unparseable-model", apigoto1],
        triedModelIds: new Set(["unparseable-model"]),
      }),
    ).toBeUndefined();
  });

  it("skips tried routes and reports no candidate when every sibling was tried", () => {
    const failover = createDeepSeekApigotoFailover();
    expect(
      failover.resolvePromptErrorFailoverModel({
        error: new Error("429 rate limit"),
        currentModelId: apigoto1,
        availableModelIds: [apigoto1, apigoto2, apigoto3],
        triedModelIds: new Set([apigoto1, apigoto2, apigoto3]),
      }),
    ).toBeUndefined();
    expect(
      failover.resolvePromptErrorFailoverModel({
        error: new Error("429 rate limit"),
        currentModelId: apigoto1,
        availableModelIds: [apigoto1],
        triedModelIds: new Set([apigoto1]),
      }),
    ).toBeUndefined();
  });

  it("ignores failures that are not apigoto failover signals", () => {
    const failover = createDeepSeekApigotoFailover();
    expect(
      failover.resolvePromptErrorFailoverModel({
        error: new Error("tool crashed"),
        currentModelId: apigoto1,
        availableModelIds: [apigoto1, apigoto2],
        triedModelIds: new Set([apigoto1]),
      }),
    ).toBeUndefined();
  });

  it("prefers a same-model sibling over a different model route", () => {
    const failover = createDeepSeekApigotoFailover();
    expect(
      failover.resolvePromptErrorFailoverModel({
        error: new Error("429 rate limit"),
        currentModelId: apigoto1,
        availableModelIds: [apigoto1, apigoto3, apigoto2],
        triedModelIds: new Set([apigoto1]),
      })?.nextModelId,
    ).toBe(apigoto2);
  });

  it("falls through to a cooling sibling when no healthy one remains", () => {
    const failover = createDeepSeekApigotoFailover({ now: () => 1_000 });
    for (const current of [apigoto2]) {
      expect(
        failover.resolvePromptErrorFailoverModel({
          error: new Error("429 rate limit"),
          currentModelId: current,
          availableModelIds: [apigoto1, apigoto2],
          triedModelIds: new Set([apigoto2]),
        })?.nextModelId,
      ).toBe(apigoto1);
    }
    expect(
      failover.resolvePromptErrorFailoverModel({
        error: new Error("429 rate limit"),
        currentModelId: apigoto2,
        availableModelIds: [apigoto1, apigoto2],
        triedModelIds: new Set([apigoto2, apigoto1]),
      }),
    ).toBeUndefined();
  });
});
