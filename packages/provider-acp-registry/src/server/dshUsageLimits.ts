import { sha256 } from "@noble/hashes/sha2";
import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  clampPercent,
  makeUnavailableUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import { fromYaml } from "@t3tools/shared/schemaYaml";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import type { AcpRegistrySettings } from "../settings.ts";
import { isApigotoRouteProvider } from "./deepseekAcp.ts";
import { isDeepSeekHarnessInstance } from "./deepseekIdentity.ts";

export const DSH_USAGE_GROUP = {
  id: "acpRegistry:deepseek-harness",
  label: "DeepSeek Harness",
} as const;

const DEFAULT_APIGOTO_BASE_URL = "https://api.apigoto.com/v1";
const APIGOTO_USAGE_PATH = "/v1/usage";
const REQUEST_TIMEOUT = "10 seconds";
const DAY_SECONDS = 24 * 60 * 60;
const HOUR_SECONDS = 60 * 60;
const WEEK_SECONDS = 7 * DAY_SECONDS;
const MINUTE_SECONDS = 60;
const PROFILE_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/iu;

const decodeYaml = Schema.decodeUnknownOption(fromYaml(Schema.Unknown));
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const textEncoder = new TextEncoder();

export interface DshUsageLimitsResult {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly auth?: {
    readonly email?: string;
    readonly label?: string;
    readonly workspaceId?: string;
  };
  readonly authRejected?: boolean;
}

interface ApigotoRouteConfig {
  readonly id: string;
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  readonly displayName?: string;
}

interface ResolvedApigotoRoute extends ApigotoRouteConfig {
  readonly apiKey: string;
  readonly accountLabel?: string;
}

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function sanitizeBaseUrl(rawUrl: string): string | undefined {
  const trimmed = rawUrl.trim();
  if (!trimmed || !URL.canParse(trimmed)) return undefined;
  const url = new URL(trimmed);
  if (url.protocol === "https:") return url.origin;
  if (url.protocol === "http:" && isLocalLoopbackHost(url.hostname)) return url.origin;
  return undefined;
}

function isApigotoBaseUrl(rawUrl: string | undefined): boolean {
  if (!rawUrl || !URL.canParse(rawUrl)) return false;
  return new URL(rawUrl).hostname.toLowerCase() === "api.apigoto.com";
}

function readProfileName(commandArgs: ReadonlyArray<string>): string | undefined {
  for (let index = 0; index < commandArgs.length; index += 1) {
    const arg = commandArgs[index];
    if (arg === "--profile") {
      const next = commandArgs[index + 1]?.trim();
      if (next && PROFILE_NAME_PATTERN.test(next)) return next;
    } else if (arg?.startsWith("--profile=")) {
      const inline = arg.slice("--profile=".length).trim();
      if (inline && PROFILE_NAME_PATTERN.test(inline)) return inline;
    }
  }
  return undefined;
}

function extractApigotoRoutes(document: unknown): ReadonlyArray<ApigotoRouteConfig> {
  if (!Array.isArray(document)) return [];
  const routes: ApigotoRouteConfig[] = [];
  const seenIds = new Set<string>();
  for (const entry of document) {
    if (!isObject(entry)) continue;
    const config = entry["config"];
    if (!isObject(config)) continue;
    const providers = config["providers"];
    if (!isObject(providers)) continue;
    for (const [providerId, rawRoute] of Object.entries(providers)) {
      if (!isObject(rawRoute)) continue;
      const baseUrl = readString(rawRoute, "baseURL") ?? DEFAULT_APIGOTO_BASE_URL;
      if (!isApigotoRouteProvider(providerId) && !isApigotoBaseUrl(baseUrl)) continue;
      const apiKeyEnv = readString(rawRoute, "apiKeyEnv");
      if (!apiKeyEnv || seenIds.has(providerId)) continue;
      seenIds.add(providerId);
      const displayName = readString(rawRoute, "displayName");
      routes.push({
        id: providerId,
        apiKeyEnv,
        baseUrl,
        ...(displayName !== undefined ? { displayName } : {}),
      });
    }
  }
  return routes;
}

const DEFAULT_FALLBACK_ROUTES: ReadonlyArray<ApigotoRouteConfig> = [
  { id: "apigoto-1", apiKeyEnv: "APIGOTO_API_KEY_1", baseUrl: DEFAULT_APIGOTO_BASE_URL },
  { id: "apigoto-2", apiKeyEnv: "APIGOTO_API_KEY_2", baseUrl: DEFAULT_APIGOTO_BASE_URL },
  { id: "apigoto", apiKeyEnv: "APIGOTO_API_KEY", baseUrl: DEFAULT_APIGOTO_BASE_URL },
];

function parseDotEnv(content: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const withoutExport = trimmed.startsWith("export ") ? trimmed.slice("export ".length) : trimmed;
    const equalsIndex = withoutExport.indexOf("=");
    if (equalsIndex <= 0) continue;
    const key = withoutExport.slice(0, equalsIndex).trim();
    let value = withoutExport.slice(equalsIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0 && value.length > 0) entries.set(key, value);
  }
  return entries;
}

function readCredentialsYamlRefs(content: string): ReadonlyMap<string, string> {
  const parsed = decodeYaml(content);
  if (Option.isNone(parsed) || !isObject(parsed.value)) return new Map();
  const refs = parsed.value["refs"];
  if (!isObject(refs)) return new Map();
  const resolved = new Map<string, string>();
  for (const [key, value] of Object.entries(refs)) {
    if (typeof value === "string" && value.length > 0) {
      resolved.set(key, value);
    }
  }
  return resolved;
}

function readApigotoAccountLabels(content: string): ReadonlyMap<string, string> {
  const parsed = decodeJson(content);
  if (Option.isNone(parsed) || !isObject(parsed.value)) return new Map();
  const accounts = parsed.value["accounts"];
  if (!Array.isArray(accounts)) return new Map();
  const labels = new Map<string, string>();
  for (const account of accounts) {
    if (!isObject(account)) continue;
    const key = readString(account, "key");
    const label = readString(account, "label") ?? readString(account, "name");
    if (key && label && !labels.has(key)) {
      labels.set(key, label);
    }
  }
  return labels;
}

function formatDurationTag(windowSec: number): string {
  if (windowSec >= DAY_SECONDS && windowSec % DAY_SECONDS === 0) {
    return `${windowSec / DAY_SECONDS}d`;
  }
  if (windowSec >= HOUR_SECONDS && windowSec % HOUR_SECONDS === 0) {
    return `${windowSec / HOUR_SECONDS}h`;
  }
  return `${Math.max(1, Math.round(windowSec / MINUTE_SECONDS))}m`;
}

function usageWindowKind(windowSec: number): ServerProviderUsageWindow["kind"] {
  if (windowSec <= DAY_SECONDS) return "session";
  if (windowSec <= 14 * DAY_SECONDS) return "weekly";
  if (windowSec >= 28 * DAY_SECONDS) return "monthly";
  return "other";
}

function routeSlotLabel(routeId: string): string | undefined {
  const match = /[-_](\d+)$/u.exec(routeId.trim());
  return match !== null ? `Key ${match[1]!}` : undefined;
}

function formatWindowLabel(route: ResolvedApigotoRoute, windowSec: number): string {
  const durationTag = formatDurationTag(windowSec);
  const slot = routeSlotLabel(route.id);
  const account = route.accountLabel?.trim();
  if (slot && account) return `${slot} · ${account} · ${durationTag}`;
  if (slot) return `apigoto · ${slot} · ${durationTag}`;
  if (account) return `apigoto · ${account} · ${durationTag}`;
  return `apigoto · ${durationTag}`;
}

function extractRollingWindowFromPayload(body: unknown): {
  readonly usedPercent: number;
  readonly windowSec: number;
  readonly plan?: string;
} | null {
  if (!isObject(body)) return null;
  const sub = isObject(body["subscription"]) ? body["subscription"] : undefined;
  const plan =
    (sub ? (readString(sub, "plan_name") ?? readString(sub, "policy_name")) : undefined) ??
    readString(body, "plan_name");

  const candidates: Array<Readonly<Record<string, unknown>>> = [];
  if (sub) candidates.push(sub);
  if (Array.isArray(body["windows"])) {
    for (const item of body["windows"]) {
      if (isObject(item)) candidates.push(item);
    }
  }
  candidates.push(body);

  for (const candidate of candidates) {
    const explicitPercent =
      readNumber(candidate["used_percent"]) ??
      readNumber(candidate["usedPercent"]) ??
      readNumber(candidate["usage_percent"]) ??
      readNumber(candidate["usagePercent"]) ??
      readNumber(candidate["utilization"]);
    const used =
      readNumber(candidate["used"]) ??
      readNumber(candidate["usage"]) ??
      readNumber(candidate["used_credits"]) ??
      readNumber(candidate["usedCredits"]);
    const limit =
      readNumber(candidate["limit"]) ??
      readNumber(candidate["quota"]) ??
      readNumber(candidate["max"]) ??
      readNumber(candidate["total"]);

    let rawPercent: number | undefined;
    if (explicitPercent !== undefined) {
      rawPercent = explicitPercent;
    } else if (used !== undefined && limit !== undefined && limit > 0) {
      rawPercent = (used / limit) * 100;
    }
    if (rawPercent === undefined) continue;

    const windowSec =
      readNumber(candidate["window_sec"]) ??
      readNumber(candidate["windowSec"]) ??
      readNumber(candidate["window_seconds"]) ??
      WEEK_SECONDS;
    const normalizedWindowSec = windowSec > 0 ? Math.trunc(windowSec) : WEEK_SECONDS;
    const usedPercent = Math.round(clampPercent(rawPercent) * 100) / 100;

    return {
      usedPercent,
      windowSec: normalizedWindowSec,
      ...(plan !== undefined ? { plan } : {}),
    };
  }
  return null;
}

function unavailableResult(
  checkedAt: string,
  reason: "unsupported" | "probeFailed",
  message: string,
  credentialFingerprint?: string,
): DshUsageLimitsResult {
  return {
    usageLimits: {
      ...makeUnavailableUsageLimits({ checkedAt, reason, message }),
      group: DSH_USAGE_GROUP,
      ...(credentialFingerprint !== undefined ? { credentialFingerprint } : {}),
    },
  };
}

function computeCredentialFingerprint(routes: ReadonlyArray<ResolvedApigotoRoute>): string {
  const uniqueSorted = [...new Set(routes.map((route) => route.apiKey))].sort();
  return Hex.encode(
    textEncoder.encode(`dsh-apigoto:${uniqueSorted.join("\n")}`).length > 0
      ? sha256(textEncoder.encode(`dsh-apigoto:${uniqueSorted.join("\n")}`))
      : new Uint8Array(),
  );
}

/**
 * Query rolling apigoto usage limits for an enabled DeepSeek Harness ACP instance.
 * Reads DSH's profile routes and resolves keys in DSH's precedence order without
 * exposing or persisting raw API keys.
 */
export const readDshUsageLimits = Effect.fn("DshUsageLimits.read")(function* (input: {
  readonly settings: AcpRegistrySettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!input.settings.enabled || !isDeepSeekHarnessInstance(input.settings)) {
    return unavailableResult(checkedAt, "unsupported", "Not a DeepSeek Harness instance.");
  }

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const homeDirectory = yield* HostProcess.HomeDirectory;

  const configuredHome = input.environment["DSH_HOME"]?.trim();
  const dshHome = configuredHome
    ? expandHomePath(configuredHome, homeDirectory)
    : path.join(homeDirectory, ".dsh");

  const profileName = readProfileName(input.settings.commandArgs);
  const patchPath = profileName
    ? path.join(dshHome, "profiles", profileName, "cordis.patch.yml")
    : path.join(dshHome, "cordis.patch.yml");

  const patchContent = yield* fileSystem
    .readFileString(patchPath)
    .pipe(Effect.orElseSucceed(() => ""));
  const parsedPatch = patchContent ? decodeYaml(patchContent) : Option.none();
  const discoveredRoutes = Option.isSome(parsedPatch)
    ? extractApigotoRoutes(parsedPatch.value)
    : [];
  const candidateRoutes = discoveredRoutes.length > 0 ? discoveredRoutes : DEFAULT_FALLBACK_ROUTES;

  const [credentialsContent, dotEnvContent, accountsContent] = yield* Effect.all(
    [
      fileSystem
        .readFileString(path.join(dshHome, ".credentials.yaml"))
        .pipe(Effect.orElseSucceed(() => "")),
      fileSystem.readFileString(path.join(dshHome, ".env")).pipe(Effect.orElseSucceed(() => "")),
      fileSystem
        .readFileString(path.join(homeDirectory, ".dsh-apigoto-keys", "accounts.json"))
        .pipe(Effect.orElseSucceed(() => "")),
    ],
    { concurrency: "unbounded" },
  );

  const credentialRefs = credentialsContent
    ? readCredentialsYamlRefs(credentialsContent)
    : new Map<string, string>();
  const dotEnv = dotEnvContent ? parseDotEnv(dotEnvContent) : new Map<string, string>();
  const accountLabels = accountsContent
    ? readApigotoAccountLabels(accountsContent)
    : new Map<string, string>();

  const resolvedRoutes: ResolvedApigotoRoute[] = [];
  const seenKeys = new Set<string>();
  for (const route of candidateRoutes) {
    const key =
      credentialRefs.get(route.apiKeyEnv) ??
      (input.environment[route.apiKeyEnv]?.trim() || undefined) ??
      dotEnv.get(route.apiKeyEnv);
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    const accountLabel = accountLabels.get(key);
    resolvedRoutes.push({
      ...route,
      apiKey: key,
      ...(accountLabel !== undefined ? { accountLabel } : {}),
    });
  }

  if (resolvedRoutes.length === 0) {
    return unavailableResult(checkedAt, "unsupported", "No apigoto API keys configured.");
  }

  const credentialFingerprint = computeCredentialFingerprint(resolvedRoutes);

  const probeRoute = Effect.fn("DshUsageLimits.probeRoute")(function* (
    route: ResolvedApigotoRoute,
  ) {
    const origin = sanitizeBaseUrl(route.baseUrl);
    if (!origin) return null;
    const request = HttpClientRequest.get(`${origin}${APIGOTO_USAGE_PATH}`).pipe(
      HttpClientRequest.setHeader("authorization", `Bearer ${route.apiKey}`),
      HttpClientRequest.setHeader("accept", "application/json"),
    );
    const response = yield* httpClient.execute(request).pipe(Effect.timeoutOption(REQUEST_TIMEOUT));
    if (Option.isNone(response)) return null;
    const body = yield* HttpClientResponse.filterStatusOk(response.value).pipe(
      Effect.flatMap((okResponse) => okResponse.json),
      Effect.orElseSucceed(() => null),
    );
    const parsed = extractRollingWindowFromPayload(body);
    if (!parsed) return null;

    const window: ServerProviderUsageWindow = {
      id: `apigoto-rolling-${route.id}`,
      kind: usageWindowKind(parsed.windowSec),
      label: formatWindowLabel(route, parsed.windowSec),
      usedPercent: parsed.usedPercent,
      windowDurationMins: Math.max(1, Math.round(parsed.windowSec / MINUTE_SECONDS)),
      blocksModel: false,
    };
    return { window, plan: parsed.plan };
  });

  const results = yield* Effect.forEach(
    resolvedRoutes,
    (route) => probeRoute(route).pipe(Effect.orElseSucceed(() => null)),
    { concurrency: "unbounded" },
  );
  const windows: ServerProviderUsageWindow[] = [];
  let plan: string | undefined;
  for (const item of results) {
    if (!item) continue;
    windows.push(item.window);
    if (!plan && item.plan) plan = item.plan;
  }

  if (windows.length === 0) {
    return unavailableResult(
      checkedAt,
      "probeFailed",
      "Could not read apigoto usage limits.",
      credentialFingerprint,
    );
  }

  return {
    usageLimits: {
      checkedAt,
      windows,
      group: DSH_USAGE_GROUP,
      credentialFingerprint,
    },
    ...(plan !== undefined ? { auth: { label: plan } } : {}),
  } satisfies DshUsageLimitsResult;
});
