import type { OrchestrationV2ProviderFailure } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";

const APIGOTO_ROUTE_PROVIDER = /^apigoto(?:[-_][a-z0-9]+|\d+)?$/iu;
const CONTEXT_WINDOW_ERROR =
  /context[ _-]?(?:length|window|limit)|maximum context|too many tokens/iu;
const QUOTA_OR_AUTH_ERROR =
  /\b(?:429|402|401|403)\b|rate[ _-]?limit|too many requests|quota|insufficient|balance|credit|billing|limit exceeded|invalid api key|unauthorized|exhausted|overloaded/iu;
const AUTH_ERROR = /\b401\b|invalid api key|unauthorized/iu;
const USAGE_LIMIT_ERROR =
  /\b(?:429|402)\b|rate[ _-]?limit|too many requests|quota|insufficient|balance|credit|billing|limit exceeded|exhausted|overloaded/iu;
const CANCELLED_ERROR = /\bcancell?ed\b/iu;
const CANCELLED_CODE = /(?:^|[^\d])-?32800(?!\d)/u;

const DEFAULT_FAILOVER_COOLDOWN_MS = 5 * 60_000;

export interface DeepSeekModelValue {
  readonly provider: string;
  readonly model: string;
  readonly format: "json" | "slash";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * DeepSeek Harness exposes its model routes as a JSON pair (`["apigoto-1","deepseek-flash"]`)
 * or a slash pair (`apigoto-1/deepseek-flash`).
 */
export function parseDeepSeekModelValue(value: string): DeepSeekModelValue | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed) && parsed.length >= 2) {
        const provider = stringValue(parsed[0]);
        const model = stringValue(parsed[1]);
        if (provider !== undefined && model !== undefined) {
          return { provider, model, format: "json" };
        }
      }
      return undefined;
    } catch {
      // Not JSON after all; a slash value can still follow.
    }
  }
  const slash = trimmed.indexOf("/");
  if (slash > 0 && slash < trimmed.length - 1) {
    const provider = stringValue(trimmed.slice(0, slash));
    const model = stringValue(trimmed.slice(slash + 1));
    if (provider !== undefined && model !== undefined) {
      return { provider, model, format: "slash" };
    }
  }
  return undefined;
}

/** apigoto route providers (`apigoto-1`, `apigoto_2`, `apigoto`), never `deepseek-official`. */
export function isApigotoRouteProvider(provider: string): boolean {
  return APIGOTO_ROUTE_PROVIDER.test(provider.trim());
}

/**
 * Collects every message-like string in an error and its cause chain. ACP wraps provider
 * failures in `AcpRequestError.errorMessage` with the HTTP failure under `cause`.
 */
function errorTexts(value: unknown, seen = new Set<object>(), depth = 0): string[] {
  if (depth > 6) return [];
  if (typeof value === "string") return [value];
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return [String(value)];
  }
  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) {
    return value.flatMap((entry) => errorTexts(entry, seen, depth + 1));
  }
  const record = value as Record<string, unknown>;
  const texts: string[] = [];
  for (const field of ["errorMessage", "message", "detail", "code", "cause", "data", "error"]) {
    let entry: unknown;
    try {
      entry = record[field];
    } catch {
      continue;
    }
    if (entry === undefined || entry === null) continue;
    texts.push(...errorTexts(entry, seen, depth + 1));
  }
  return texts;
}

function errorRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function acpRequestMessage(value: unknown): string | undefined {
  const record = errorRecord(value);
  if (record?._tag !== "AcpRequestError") return undefined;
  const message = stringValue(record.errorMessage);
  const code = typeof record.code === "number" ? String(record.code) : undefined;
  return message ?? code;
}

/** Whether a prompt failure should move the next attempt to a sibling apigoto route. */
export function isApigotoFailoverError(error: unknown): boolean {
  const combined = errorTexts(error).join(" ");
  if (combined.trim().length === 0) return false;
  // A request that no longer fits is a prompt-size problem, not a route problem.
  if (CONTEXT_WINDOW_ERROR.test(combined)) return false;
  if (QUOTA_OR_AUTH_ERROR.test(combined)) return true;
  if (CANCELLED_CODE.test(combined) || CANCELLED_ERROR.test(combined)) return false;
  return false;
}

/** Classify a DeepSeek Harness prompt failure for T3's failure UI. */
export function deepseekPromptFailure(cause: unknown): OrchestrationV2ProviderFailure {
  const combined = errorTexts(cause).join(" ");
  const record = errorRecord(cause);
  const message =
    acpRequestMessage(cause) ??
    stringValue(record?.message) ??
    stringValue(record?.detail) ??
    (combined.trim().length > 0 ? combined : undefined);
  const code = typeof record?.code === "number" ? String(record.code) : null;
  if (AUTH_ERROR.test(combined)) {
    // T3's failure classes have no dedicated `auth`; permission_error keeps sign-in
    // failures distinct from transient provider errors.
    return makeProviderFailure({
      cause,
      ...(message === undefined ? {} : { message }),
      code,
      class: "permission_error",
      retryable: false,
    });
  }
  if (USAGE_LIMIT_ERROR.test(combined)) {
    return makeProviderFailure({
      cause,
      ...(message === undefined ? {} : { message }),
      code,
      class: "usage_limit",
      retryable: true,
    });
  }
  return makeProviderFailure({
    cause,
    ...(message === undefined ? {} : { message }),
    code,
    class: "provider_error",
  });
}

export interface DeepSeekApigotoFailover {
  resolvePreferredModelId(
    requestedModelId: string,
    availableModelIds: ReadonlyArray<string>,
  ): string;
  resolvePromptErrorFailoverModel(input: {
    readonly error: unknown;
    readonly currentModelId: string;
    readonly availableModelIds: ReadonlyArray<string>;
    readonly triedModelIds: ReadonlySet<string>;
  }): { readonly nextModelId: string; readonly reason: string } | undefined;
}

interface RouteCandidate {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly cooling: boolean;
}

export function createDeepSeekApigotoFailover(
  options: {
    readonly cooldownMs?: number;
    readonly now?: () => number;
  } = {},
): DeepSeekApigotoFailover {
  const cooldownMs = options.cooldownMs ?? DEFAULT_FAILOVER_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  const cooldowns = new Map<string, number>();
  let lastRequestedModel: string | undefined;

  const isCooling = (provider: string): boolean => {
    const expiresAt = cooldowns.get(provider);
    if (expiresAt === undefined) return false;
    if (expiresAt > now()) return true;
    cooldowns.delete(provider);
    return false;
  };

  const candidatesFor = (
    availableModelIds: ReadonlyArray<string>,
    excludeProvider: string,
    isExcludedId?: (id: string) => boolean,
  ): ReadonlyArray<RouteCandidate> =>
    availableModelIds.flatMap((id) => {
      if (isExcludedId?.(id) === true) return [];
      const parsed = parseDeepSeekModelValue(id);
      if (parsed === undefined || !isApigotoRouteProvider(parsed.provider)) return [];
      if (parsed.provider === excludeProvider) return [];
      return [
        {
          id,
          provider: parsed.provider,
          model: parsed.model,
          cooling: isCooling(parsed.provider),
        },
      ];
    });

  const resolvePreferredModelId = (
    requestedModelId: string,
    availableModelIds: ReadonlyArray<string>,
  ): string => {
    const previousRequested = lastRequestedModel;
    lastRequestedModel = requestedModelId;
    if (previousRequested !== undefined && previousRequested !== requestedModelId) {
      // A manual pick in the UI always wins: forget the cooldown it may have earned.
      const parsedRequested = parseDeepSeekModelValue(requestedModelId);
      if (parsedRequested !== undefined && isApigotoRouteProvider(parsedRequested.provider)) {
        cooldowns.delete(parsedRequested.provider);
      }
      return requestedModelId;
    }
    const parsed = parseDeepSeekModelValue(requestedModelId);
    if (
      parsed === undefined ||
      !isApigotoRouteProvider(parsed.provider) ||
      !isCooling(parsed.provider)
    ) {
      return requestedModelId;
    }
    const candidates = candidatesFor(availableModelIds, parsed.provider);
    const healthy = candidates.filter((candidate) => !candidate.cooling);
    const sameModel = healthy.filter((candidate) => candidate.model === parsed.model);
    return sameModel[0]?.id ?? healthy[0]?.id ?? requestedModelId;
  };

  const resolvePromptErrorFailoverModel: DeepSeekApigotoFailover["resolvePromptErrorFailoverModel"] =
    (input) => {
      if (!isApigotoFailoverError(input.error)) return undefined;
      const parsed = parseDeepSeekModelValue(input.currentModelId);
      if (parsed === undefined || !isApigotoRouteProvider(parsed.provider)) return undefined;
      const candidates = candidatesFor(
        input.availableModelIds,
        parsed.provider,
        (id) => id === input.currentModelId || input.triedModelIds.has(id),
      );
      const healthy = candidates.filter((candidate) => !candidate.cooling);
      const sameModel = healthy.filter((candidate) => candidate.model === parsed.model);
      const chosen = sameModel[0] ?? healthy[0] ?? candidates[0];
      if (chosen === undefined) return undefined;
      cooldowns.set(parsed.provider, now() + cooldownMs);
      return {
        nextModelId: chosen.id,
        reason: `Switched apigoto route from ${parsed.provider} to ${chosen.provider} after error; retrying turn.`,
      };
    };

  return { resolvePreferredModelId, resolvePromptErrorFailoverModel };
}
