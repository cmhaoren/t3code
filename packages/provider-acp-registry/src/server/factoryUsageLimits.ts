// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect has no AES-256-GCM cipher; SHA-256 fingerprint uses Node crypto beside it.
import * as NodeCrypto from "node:crypto";

import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import type { AcpRegistrySettings } from "../settings.ts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  clampPercent,
  makeUnavailableUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

const FACTORY_DROID_AGENT_ID = "factory-droid";
export const FACTORY_USAGE_GROUP = {
  id: "acpRegistry:factory-droid",
  label: "Factory Droid",
} as const;
export const FACTORY_BILLING_URL = "https://app.factory.ai/settings/billing";
const FACTORY_EXTERNAL_USAGE = {
  label: "Factory usage",
  url: FACTORY_BILLING_URL,
} as const;

const DEFAULT_FACTORY_API_BASE_URL = "https://api.factory.ai";
const KEYRING_SERVICE = "Factory CLI";
const KEYRING_ACCOUNT = "auth-encryption-key";
const KEYRING_COMMAND_TIMEOUT = "3 seconds";
const REQUEST_TIMEOUT = "10 seconds";
const UNLIMITED_ALLOWANCE_THRESHOLD = 1_000_000_000_000;
const UNLIMITED_REFERENCE_TOKENS = 100_000_000;
const MINUTE_MS = 60_000;
const FIVE_HOUR_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
const MONTH_MINS = 30 * 24 * 60;

type FactoryCredentialSource = "apiKey" | "keyring" | "file" | "authJson";

interface ResolvedFactoryCredentials {
  readonly token: string;
  readonly source: FactoryCredentialSource;
  readonly activeOrganizationId?: string | undefined;
}

export interface FactoryUsageLimitsResult {
  readonly usageLimits: ServerProviderUsageLimits;
  readonly auth?: {
    readonly email?: string;
    readonly label?: string;
    readonly workspaceId?: string;
  };
  readonly authRejected?: boolean;
}

const FlexibleDateValue = Schema.Union([Schema.Number, Schema.String]);

const FactoryBillingWindowSchema = Schema.Struct({
  usedPercent: Schema.optional(Schema.NullOr(Schema.Number)),
  windowEnd: Schema.optional(Schema.NullOr(FlexibleDateValue)),
  secondsRemaining: Schema.optional(Schema.NullOr(Schema.Number)),
});
type FactoryBillingWindow = typeof FactoryBillingWindowSchema.Type;

const FactoryLimitPoolSchema = Schema.Struct({
  fiveHour: Schema.optional(Schema.NullOr(FactoryBillingWindowSchema)),
  weekly: Schema.optional(Schema.NullOr(FactoryBillingWindowSchema)),
  monthly: Schema.optional(Schema.NullOr(FactoryBillingWindowSchema)),
});
type FactoryLimitPool = typeof FactoryLimitPoolSchema.Type;

const FactoryBillingLimitsSchema = Schema.Struct({
  usesTokenRateLimitsBilling: Schema.optional(Schema.Boolean),
  hasActiveSubscription: Schema.optional(Schema.Boolean),
  limits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        standard: Schema.optional(Schema.NullOr(FactoryLimitPoolSchema)),
        core: Schema.optional(Schema.NullOr(FactoryLimitPoolSchema)),
      }),
    ),
  ),
  overagePreference: Schema.optional(Schema.NullOr(Schema.String)),
});

const FactoryWorkosUserSchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.String)),
  email: Schema.optional(Schema.NullOr(Schema.String)),
});

const FactoryWorkosMembershipSchema = Schema.Struct({
  userId: Schema.optional(Schema.NullOr(Schema.String)),
  organizationId: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.optional(Schema.NullOr(FactoryWorkosUserSchema)),
});

const FactoryAuthMeSchema = Schema.Struct({
  userProfile: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.NullOr(Schema.String)),
        email: Schema.optional(Schema.NullOr(Schema.String)),
        workosUser: Schema.optional(Schema.NullOr(FactoryWorkosUserSchema)),
        workosMembership: Schema.optional(Schema.NullOr(FactoryWorkosMembershipSchema)),
      }),
    ),
  ),
  organization: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.optional(Schema.NullOr(Schema.String)),
        name: Schema.optional(Schema.NullOr(Schema.String)),
        subscription: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              factoryTier: Schema.optional(Schema.NullOr(Schema.String)),
              orbSubscription: Schema.optional(
                Schema.NullOr(
                  Schema.Struct({
                    name: Schema.optional(Schema.NullOr(Schema.String)),
                    plan: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          name: Schema.optional(Schema.NullOr(Schema.String)),
                        }),
                      ),
                    ),
                  }),
                ),
              ),
            }),
          ),
        ),
      }),
    ),
  ),
  user: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        workosUser: Schema.optional(Schema.NullOr(FactoryWorkosUserSchema)),
        workosMembership: Schema.optional(Schema.NullOr(FactoryWorkosMembershipSchema)),
      }),
    ),
  ),
});
type FactoryAuthMe = typeof FactoryAuthMeSchema.Type;

const FactoryLegacyTokenUsageSchema = Schema.Struct({
  userTokens: Schema.optional(Schema.NullOr(Schema.Number)),
  orgTotalTokensUsed: Schema.optional(Schema.NullOr(Schema.Number)),
  totalAllowance: Schema.optional(Schema.NullOr(Schema.Number)),
  usedRatio: Schema.optional(Schema.NullOr(Schema.Number)),
});
type FactoryLegacyTokenUsage = typeof FactoryLegacyTokenUsageSchema.Type;

const FactoryLegacySubscriptionUsageSchema = Schema.Struct({
  userId: Schema.optional(Schema.NullOr(Schema.String)),
  usage: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        startDate: Schema.optional(Schema.NullOr(FlexibleDateValue)),
        endDate: Schema.optional(Schema.NullOr(FlexibleDateValue)),
        standard: Schema.optional(Schema.NullOr(FactoryLegacyTokenUsageSchema)),
        premium: Schema.optional(Schema.NullOr(FactoryLegacyTokenUsageSchema)),
      }),
    ),
  ),
});

const decodeBillingLimits = Schema.decodeUnknownOption(FactoryBillingLimitsSchema);
const decodeAuthMe = Schema.decodeUnknownOption(FactoryAuthMeSchema);
const decodeLegacyUsage = Schema.decodeUnknownOption(FactoryLegacySubscriptionUsageSchema);
const decodeAuthJson = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown));

export function isFactoryDroidInstance(settings: AcpRegistrySettings): boolean {
  if (!settings.enabled) return false;
  if (settings.source === "registry") {
    return settings.agentId.trim() === FACTORY_DROID_AGENT_ID;
  }
  const executable = settings.commandPath.trim().split(/[\\/]/).pop() ?? "";
  return /^(?:factory-)?droid(?:\.exe|\.cmd|\.bat)?$/i.test(executable);
}

function decodeAesKey(keyText: string): Buffer | null {
  const trimmed = keyText.trim();
  if (!trimmed) return null;
  if (/^[A-Za-z0-9+/=]+$/.test(trimmed)) {
    const decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 32) return decoded;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }
  return null;
}

/**
 * Decrypts Factory CLI `auth.v2.keyring` / `auth.v2.file` payloads (`iv:tag:ciphertext`, AES-256-GCM).
 */
export function decryptFactoryAuthPayload(
  encryptedText: string,
  keyText: string,
): Record<string, unknown> | null {
  const parts = encryptedText.trim().split(":");
  if (parts.length !== 3) return null;
  const key = decodeAesKey(keyText);
  if (key === null) return null;
  try {
    const iv = Buffer.from(parts[0]!, "base64");
    const tag = Buffer.from(parts[1]!, "base64");
    const ciphertext = Buffer.from(parts[2]!, "base64");
    if (iv.length < 12 || tag.length !== 16) return null;
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    const parsed: unknown = JSON.parse(plaintext);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** Decodes a JWT payload segment without verifying signatures to read non-secret metadata. */
export function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segments = token.split(".");
  if (segments.length !== 3 || !segments[1]) return null;
  try {
    const decoded = Buffer.from(segments[1], "base64url").toString("utf8");
    const parsed: unknown = JSON.parse(decoded);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveFactoryDir(
  environment: NodeJS.ProcessEnv,
  homeDirectory: string,
  path: Path.Path,
): string {
  const configured = nonEmptyString(environment.FACTORY_HOME);
  if (configured) {
    return path.resolve(expandHomePath(configured, homeDirectory));
  }
  const home =
    nonEmptyString(environment.FACTORY_HOME_OVERRIDE) ??
    nonEmptyString(environment.HOME) ??
    nonEmptyString(environment.USERPROFILE) ??
    homeDirectory;
  return path.join(path.resolve(expandHomePath(home, homeDirectory)), ".factory");
}

function parseEnvApiKey(content: string): string | undefined {
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?FACTORY_API_KEY\s*=\s*(.+)$/.exec(line);
    if (!match?.[1]) continue;
    let value = match[1].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1).trim();
    }
    if (value.length > 0) return value;
  }
  return undefined;
}

const WINDOWS_CRED_READ_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class T3FactoryCred {",
  "  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]",
  "  public struct CREDENTIAL {",
  "    public uint Flags; public uint Type; public string TargetName; public string Comment;",
  "    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;",
  "    public uint CredentialBlobSize; public IntPtr CredentialBlob;",
  "    public uint Persist; public uint AttributeCount; public IntPtr Attributes;",
  "    public string TargetAlias; public string UserName;",
  "  }",
  '  [DllImport("Advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]',
  "  public static extern bool CredRead(string target, uint type, int reservedFlag, out IntPtr credentialPtr);",
  '  [DllImport("Advapi32.dll", SetLastError = true)]',
  "  public static extern bool CredFree(IntPtr cred);",
  "  public static byte[] Read(string target) {",
  "    IntPtr ptr;",
  "    if (!CredRead(target, 1, 0, out ptr)) return null;",
  "    try {",
  "      var c = Marshal.PtrToStructure<CREDENTIAL>(ptr);",
  "      if (c.CredentialBlobSize == 0) return Array.Empty<byte>();",
  "      var buf = new byte[c.CredentialBlobSize];",
  "      Marshal.Copy(c.CredentialBlob, buf, 0, (int)c.CredentialBlobSize);",
  "      return buf;",
  "    } finally { CredFree(ptr); }",
  "  }",
  "}",
  "'@",
  `$b = [T3FactoryCred]::Read("${KEYRING_SERVICE}/${KEYRING_ACCOUNT}")`,
  "if ($null -eq $b -or $b.Length -eq 0) { exit 1 }",
  "$u8 = [Text.Encoding]::UTF8.GetString($b).Trim()",
  "$u16 = [Text.Encoding]::Unicode.GetString($b).Trim()",
  'if ($u8 -match "^[A-Za-z0-9+/=]{32,}$") { [Console]::Out.Write($u8); exit 0 }',
  'if ($u16 -match "^[A-Za-z0-9+/=]{32,}$") { [Console]::Out.Write($u16); exit 0 }',
  "[Console]::Out.Write([Convert]::ToBase64String($b))",
].join("\n");

const WINDOWS_CRED_READ_ENCODED = Buffer.from(WINDOWS_CRED_READ_SCRIPT, "utf16le").toString(
  "base64",
);

const readOsKeyringEncryptionKey = Effect.fn("FactoryUsageLimits.readOsKeyringEncryptionKey")(
  function* (environment: NodeJS.ProcessEnv) {
    const platform = yield* HostProcess.Platform;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = (command: string, args: ReadonlyArray<string>) =>
      spawner
        .string(
          ChildProcess.make(command, args, {
            stdin: "ignore",
            stderr: "ignore",
            env: environment,
          }),
        )
        .pipe(
          Effect.timeout(KEYRING_COMMAND_TIMEOUT),
          Effect.map((output) => nonEmptyString(output) ?? null),
          Effect.orElseSucceed(() => null),
        );

    if (platform === "win32") {
      return yield* run("powershell.exe", [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        WINDOWS_CRED_READ_ENCODED,
      ]);
    }
    if (platform === "darwin") {
      return yield* run("security", [
        "find-generic-password",
        "-s",
        KEYRING_SERVICE,
        "-a",
        KEYRING_ACCOUNT,
        "-w",
      ]);
    }
    if (platform === "linux") {
      return yield* run("secret-tool", [
        "lookup",
        "service",
        KEYRING_SERVICE,
        "username",
        KEYRING_ACCOUNT,
      ]);
    }
    return null;
  },
);

function credentialsFromRecord(
  record: Record<string, unknown>,
  source: FactoryCredentialSource,
): ResolvedFactoryCredentials | null {
  const accessToken = nonEmptyString(record.access_token) ?? nonEmptyString(record.accessToken);
  if (accessToken) {
    return {
      token: accessToken,
      source,
      activeOrganizationId:
        nonEmptyString(record.active_organization_id) ??
        nonEmptyString(record.activeOrganizationId),
    };
  }
  if (source === "authJson") {
    const apiKey = nonEmptyString(record.api_key) ?? nonEmptyString(record.apiKey);
    if (apiKey) {
      return { token: apiKey, source: "apiKey" };
    }
  }
  return null;
}

/**
 * Resolves Factory Droid credentials from environment, `.env`, or local Droid auth files
 * without mutating or refreshing stored WorkOS tokens.
 */
export const resolveFactoryCredentials = Effect.fn("FactoryUsageLimits.resolveFactoryCredentials")(
  function* (environment: NodeJS.ProcessEnv) {
    const directApiKey = nonEmptyString(environment.FACTORY_API_KEY);
    if (directApiKey) {
      return { token: directApiKey, source: "apiKey" } satisfies ResolvedFactoryCredentials;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const factoryDir = resolveFactoryDir(environment, homeDirectory, path);

    const readText = (filePath: string) =>
      fileSystem.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));

    const envContent = yield* readText(path.join(factoryDir, ".env"));
    if (envContent !== null) {
      const envApiKey = parseEnvApiKey(envContent);
      if (envApiKey) {
        return { token: envApiKey, source: "apiKey" } satisfies ResolvedFactoryCredentials;
      }
    }

    const keyringDisabled =
      environment.FACTORY_DISABLE_KEYRING === "1" ||
      environment.FACTORY_DISABLE_KEYRING?.toLowerCase() === "true";

    if (!keyringDisabled) {
      const keyringPayload = yield* readText(path.join(factoryDir, "auth.v2.keyring"));
      if (keyringPayload !== null) {
        const keyText = yield* readOsKeyringEncryptionKey(environment);
        if (keyText !== null) {
          const decrypted = decryptFactoryAuthPayload(keyringPayload, keyText);
          if (decrypted !== null) {
            const resolved = credentialsFromRecord(decrypted, "keyring");
            if (resolved !== null) return resolved;
          }
        }
      }
    }

    const filePayload = yield* readText(path.join(factoryDir, "auth.v2.file"));
    const fileKey =
      filePayload === null ? null : yield* readText(path.join(factoryDir, "auth.v2.key"));
    if (filePayload !== null && fileKey !== null) {
      const decrypted = decryptFactoryAuthPayload(filePayload, fileKey);
      if (decrypted !== null) {
        const resolved = credentialsFromRecord(decrypted, "file");
        if (resolved !== null) return resolved;
      }
    }

    const authJsonText = yield* readText(path.join(factoryDir, "auth.json"));
    if (authJsonText !== null) {
      const parsed = Option.getOrUndefined(decodeAuthJson(authJsonText));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const resolved = credentialsFromRecord(parsed as Record<string, unknown>, "authJson");
        if (resolved !== null) return resolved;
      }
    }

    return null;
  },
);

function isoFromMs(ms: number): string | undefined {
  if (!Number.isFinite(ms)) return undefined;
  const dt = DateTime.make(ms);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function parseFlexibleDateMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1e12 ? value : value * 1000;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) {
      const numeric = Number(trimmed);
      if (Number.isFinite(numeric)) {
        return numeric > 1e12 ? numeric : numeric * 1000;
      }
    }
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function windowResetMs(window: FactoryBillingWindow, nowMs: number): number | undefined {
  const windowEndMs = parseFlexibleDateMs(window.windowEnd);
  if (windowEndMs !== undefined && windowEndMs > nowMs) return windowEndMs;
  const secondsRemaining =
    typeof window.secondsRemaining === "number" &&
    Number.isFinite(window.secondsRemaining) &&
    window.secondsRemaining > 0
      ? window.secondsRemaining
      : undefined;
  return secondsRemaining !== undefined ? nowMs + secondsRemaining * 1000 : undefined;
}

function effectiveWindowPercent(window: FactoryBillingWindow, nowMs: number): number {
  const resetMs = windowResetMs(window, nowMs);
  const hasSecondsRemaining =
    typeof window.secondsRemaining === "number" &&
    Number.isFinite(window.secondsRemaining) &&
    window.secondsRemaining > 0;
  if (resetMs === undefined && window.windowEnd != null && !hasSecondsRemaining) {
    return 0;
  }
  return clampPercent(window.usedPercent ?? 0);
}

function hasPoolUsageData(pool: FactoryLimitPool | null | undefined): boolean {
  if (!pool) return false;
  return [pool.fiveHour, pool.weekly, pool.monthly].some(
    (window) =>
      window != null &&
      ((window.usedPercent ?? 0) > 0 ||
        window.windowEnd != null ||
        (window.secondsRemaining != null && window.secondsRemaining > 0)),
  );
}

function mapBillingWindow(
  window: FactoryBillingWindow | null | undefined,
  options: {
    readonly id: string;
    readonly kind: ServerProviderUsageWindow["kind"];
    readonly label: string;
    readonly windowDurationMins: number;
    readonly blocksModel?: boolean;
  },
  nowMs: number,
): ServerProviderUsageWindow | null {
  if (!window) return null;
  const resetMs = windowResetMs(window, nowMs);
  const resetsAt = resetMs === undefined ? undefined : isoFromMs(resetMs);
  return {
    id: options.id,
    kind: options.kind,
    label: options.label,
    usedPercent: effectiveWindowPercent(window, nowMs),
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    windowDurationMins: options.windowDurationMins,
    ...(options.blocksModel === false ? { blocksModel: false } : {}),
  };
}

function computeLegacyPercent(usage: FactoryLegacyTokenUsage): number {
  const used = usage.userTokens ?? 0;
  const allowance = usage.totalAllowance ?? 0;
  const apiRatio = usage.usedRatio;
  const allowanceIsReliable = allowance > 0 && allowance <= UNLIMITED_ALLOWANCE_THRESHOLD;

  if (
    typeof apiRatio === "number" &&
    Number.isFinite(apiRatio) &&
    !(apiRatio === 0 && used > 0 && allowanceIsReliable)
  ) {
    if (apiRatio >= -0.001 && apiRatio <= 1.001) {
      return clampPercent(apiRatio * 100);
    }
    if (!allowanceIsReliable && apiRatio >= -0.1 && apiRatio <= 100.1) {
      return clampPercent(apiRatio);
    }
  }

  if (allowance > UNLIMITED_ALLOWANCE_THRESHOLD) {
    return clampPercent((used / UNLIMITED_REFERENCE_TOKENS) * 100);
  }
  if (allowance > 0) {
    return clampPercent((used / allowance) * 100);
  }
  return 0;
}

function formatFactoryTier(tier: string): string {
  return tier
    .trim()
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function extractAuthMetadata(
  authMe: FactoryAuthMe | undefined,
  jwtClaims: Record<string, unknown> | null,
  activeOrganizationId: string | undefined,
) {
  const email =
    nonEmptyString(authMe?.userProfile?.email) ??
    nonEmptyString(authMe?.userProfile?.workosUser?.email) ??
    nonEmptyString(authMe?.userProfile?.workosMembership?.user?.email) ??
    nonEmptyString(authMe?.user?.workosUser?.email) ??
    nonEmptyString(authMe?.user?.workosMembership?.user?.email) ??
    nonEmptyString(jwtClaims?.email);
  const planName =
    nonEmptyString(authMe?.organization?.subscription?.orbSubscription?.plan?.name) ??
    nonEmptyString(authMe?.organization?.subscription?.orbSubscription?.name);
  const tier = nonEmptyString(authMe?.organization?.subscription?.factoryTier);
  const label = planName ?? (tier ? formatFactoryTier(tier) : undefined);
  const workspaceId =
    nonEmptyString(authMe?.organization?.id) ??
    nonEmptyString(authMe?.userProfile?.workosMembership?.organizationId) ??
    nonEmptyString(authMe?.user?.workosMembership?.organizationId) ??
    activeOrganizationId;
  const userId =
    nonEmptyString(authMe?.userProfile?.workosUser?.id) ??
    nonEmptyString(authMe?.userProfile?.workosMembership?.userId) ??
    nonEmptyString(authMe?.userProfile?.workosMembership?.user?.id) ??
    nonEmptyString(authMe?.userProfile?.id) ??
    nonEmptyString(authMe?.user?.workosUser?.id) ??
    nonEmptyString(authMe?.user?.workosMembership?.user?.id) ??
    nonEmptyString(jwtClaims?.sub);
  return { email, label, workspaceId, userId };
}

function unavailableResult(
  checkedAt: string,
  reason: "unsupported" | "probeFailed",
  message: string,
  extra?: {
    readonly auth?: FactoryUsageLimitsResult["auth"];
    readonly authRejected?: boolean;
  },
): FactoryUsageLimitsResult {
  return {
    usageLimits: {
      ...makeUnavailableUsageLimits({ checkedAt, reason, message }),
      group: FACTORY_USAGE_GROUP,
      externalUsage: FACTORY_EXTERNAL_USAGE,
    },
    ...(extra?.auth ? { auth: extra.auth } : {}),
    ...(extra?.authRejected ? { authRejected: true } : {}),
  };
}

function factoryHeaders(token: string) {
  return {
    Accept: "application/json",
    "Content-Type": "application/json",
    Origin: "https://app.factory.ai",
    Referer: "https://app.factory.ai/",
    "x-factory-client": "web-app",
    Authorization: `Bearer ${token}`,
  };
}

function apiFingerprint(identity: string): string {
  return NodeCrypto.createHash("sha256").update(`factory:${identity}`).digest("hex").slice(0, 16);
}

/** Reads Factory Droid subscription limits and account identity for `Usage -> Limits`. */
export const readFactoryUsageLimits = Effect.fn("FactoryUsageLimits.readFactoryUsageLimits")(
  function* (
    environment: NodeJS.ProcessEnv = process.env,
  ): Effect.fn.Return<
    FactoryUsageLimitsResult,
    never,
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
  > {
    const nowMs = yield* Clock.currentTimeMillis;
    const checkedAt = isoFromMs(nowMs) ?? DateTime.formatIso(yield* DateTime.now);

    const credentials = yield* resolveFactoryCredentials(environment);
    if (credentials === null) {
      return unavailableResult(
        checkedAt,
        "unsupported",
        "Sign in to Factory Droid or set FACTORY_API_KEY to see usage limits.",
      );
    }

    const apiBase = (
      nonEmptyString(environment.FACTORY_API_BASE_URL) ?? DEFAULT_FACTORY_API_BASE_URL
    ).replace(/\/+$/, "");
    const headers = factoryHeaders(credentials.token);
    const jwtClaims = decodeJwtPayload(credentials.token);
    const client = yield* HttpClient.HttpClient;

    const executeGet = (url: string) =>
      client
        .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(headers)))
        .pipe(Effect.timeout(REQUEST_TIMEOUT));

    const fetchOutcome = yield* Effect.gen(function* () {
      const [limitsRes, authRes] = yield* Effect.all(
        [
          executeGet(`${apiBase}/api/billing/limits`).pipe(
            Effect.flatMap((response) =>
              Effect.gen(function* () {
                if (response.status === 401 || response.status === 403) {
                  return { kind: "unauthorized" as const };
                }
                if (response.status === 404) {
                  return { kind: "notFound" as const };
                }
                if (response.status < 200 || response.status >= 300) {
                  return {
                    kind: "failed" as const,
                    message: `Factory billing HTTP ${response.status}`,
                  };
                }
                const json = yield* response.json;
                const decoded = decodeBillingLimits(json);
                if (Option.isNone(decoded)) {
                  return {
                    kind: "failed" as const,
                    message: "Factory Droid returned an invalid billing limits payload.",
                  };
                }
                return { kind: "ok" as const, data: decoded.value };
              }),
            ),
          ),
          executeGet(`${apiBase}/api/app/auth/me`).pipe(
            Effect.flatMap((response) =>
              response.status >= 200 && response.status < 300
                ? response.json.pipe(
                    Effect.map((json) => Option.getOrUndefined(decodeAuthMe(json))),
                  )
                : Effect.undefined,
            ),
            Effect.orElseSucceed(() => undefined),
          ),
        ],
        { concurrency: 2 },
      );

      const metadata = extractAuthMetadata(authRes, jwtClaims, credentials.activeOrganizationId);
      const auth =
        metadata.email || metadata.label || metadata.workspaceId
          ? {
              ...(metadata.email ? { email: metadata.email } : {}),
              ...(metadata.label ? { label: metadata.label } : {}),
              ...(metadata.workspaceId ? { workspaceId: metadata.workspaceId } : {}),
            }
          : undefined;
      const credentialFingerprint = apiFingerprint(
        metadata.userId ?? metadata.email ?? credentials.token,
      );

      if (limitsRes.kind === "unauthorized") {
        const message =
          credentials.source === "apiKey"
            ? "Factory API key was rejected. Check FACTORY_API_KEY in settings."
            : "Factory Droid session expired. Start a Droid turn or sign in again to refresh limits.";
        return unavailableResult(checkedAt, "probeFailed", message, {
          ...(auth ? { auth } : {}),
          authRejected: true,
        });
      }

      if (limitsRes.kind === "failed") {
        return unavailableResult(
          checkedAt,
          "probeFailed",
          limitsRes.message,
          auth ? { auth } : undefined,
        );
      }

      if (
        limitsRes.kind === "ok" &&
        limitsRes.data.usesTokenRateLimitsBilling === true &&
        limitsRes.data.limits?.standard
      ) {
        const { standard, core } = limitsRes.data.limits;
        const overagePreference = nonEmptyString(limitsRes.data.overagePreference);
        const includeCore =
          core != null && (hasPoolUsageData(core) || overagePreference === "droidCore");
        const coreWindows = [core?.fiveHour, core?.weekly, core?.monthly].filter(
          (window): window is FactoryBillingWindow => window != null,
        );
        const standardFallbackToCore =
          includeCore &&
          overagePreference === "droidCore" &&
          coreWindows.length > 0 &&
          coreWindows.every((window) => effectiveWindowPercent(window, nowMs) < 100);

        const windows = [
          mapBillingWindow(
            standard.fiveHour,
            {
              id: "standard-5h",
              kind: "session",
              label: includeCore ? "Standard · 5h" : "Session",
              windowDurationMins: FIVE_HOUR_MINS,
              ...(standardFallbackToCore ? { blocksModel: false } : {}),
            },
            nowMs,
          ),
          mapBillingWindow(
            standard.weekly,
            {
              id: "standard-weekly",
              kind: "weekly",
              label: includeCore ? "Standard · Weekly" : "Weekly",
              windowDurationMins: WEEK_MINS,
              ...(standardFallbackToCore ? { blocksModel: false } : {}),
            },
            nowMs,
          ),
          mapBillingWindow(
            standard.monthly,
            {
              id: "standard-monthly",
              kind: "monthly",
              label: includeCore ? "Standard · Monthly" : "Monthly",
              windowDurationMins: MONTH_MINS,
              ...(standardFallbackToCore ? { blocksModel: false } : {}),
            },
            nowMs,
          ),
          ...(includeCore
            ? [
                mapBillingWindow(
                  core.fiveHour,
                  {
                    id: "core-5h",
                    kind: "session",
                    label: "Core · 5h",
                    windowDurationMins: FIVE_HOUR_MINS,
                    blocksModel: false,
                  },
                  nowMs,
                ),
                mapBillingWindow(
                  core.weekly,
                  {
                    id: "core-weekly",
                    kind: "weekly",
                    label: "Core · Weekly",
                    windowDurationMins: WEEK_MINS,
                    blocksModel: false,
                  },
                  nowMs,
                ),
                mapBillingWindow(
                  core.monthly,
                  {
                    id: "core-monthly",
                    kind: "monthly",
                    label: "Core · Monthly",
                    windowDurationMins: MONTH_MINS,
                    blocksModel: false,
                  },
                  nowMs,
                ),
              ]
            : []),
        ].filter((window): window is ServerProviderUsageWindow => window !== null);

        if (windows.length === 0) {
          return unavailableResult(
            checkedAt,
            "unsupported",
            "No active Factory subscription limits found.",
            auth ? { auth } : undefined,
          );
        }

        return {
          usageLimits: {
            checkedAt,
            windows,
            group: FACTORY_USAGE_GROUP,
            externalUsage: FACTORY_EXTERNAL_USAGE,
            credentialFingerprint,
          },
          ...(auth ? { auth } : {}),
        } satisfies FactoryUsageLimitsResult;
      }

      // Fallback for legacy Standard/Premium accounts without token rate limits.
      const legacyUrl = new URL(`${apiBase}/api/organization/subscription/usage`);
      legacyUrl.searchParams.set("useCache", "true");
      if (metadata.userId) {
        legacyUrl.searchParams.set("userId", metadata.userId);
      }

      const legacyResponse = yield* executeGet(legacyUrl.toString());
      if (legacyResponse.status === 401 || legacyResponse.status === 403) {
        const message =
          credentials.source === "apiKey"
            ? "Factory API key was rejected. Check FACTORY_API_KEY in settings."
            : "Factory Droid session expired. Start a Droid turn or sign in again to refresh limits.";
        return unavailableResult(checkedAt, "probeFailed", message, {
          ...(auth ? { auth } : {}),
          authRejected: true,
        });
      }
      if (legacyResponse.status === 404) {
        return unavailableResult(
          checkedAt,
          "unsupported",
          "No active Factory subscription limits found.",
          auth ? { auth } : undefined,
        );
      }
      const legacyBody = yield* HttpClientResponse.filterStatusOk(legacyResponse).pipe(
        Effect.flatMap((response) => response.json),
      );
      const legacy = decodeLegacyUsage(legacyBody);
      if (Option.isNone(legacy) || !legacy.value.usage) {
        return unavailableResult(
          checkedAt,
          "unsupported",
          "No active Factory subscription limits found.",
          auth ? { auth } : undefined,
        );
      }

      const { startDate, endDate, standard, premium } = legacy.value.usage;
      const startMs = parseFlexibleDateMs(startDate);
      const endMs = parseFlexibleDateMs(endDate);
      const resetsAt = endMs !== undefined ? isoFromMs(endMs) : undefined;
      const windowDurationMins =
        startMs !== undefined && endMs !== undefined && endMs > startMs
          ? Math.round((endMs - startMs) / MINUTE_MS)
          : undefined;

      const legacyWindows: ServerProviderUsageWindow[] = [];
      if (standard) {
        legacyWindows.push({
          id: "legacy-standard",
          kind: "monthly",
          label: "Standard",
          usedPercent: computeLegacyPercent(standard),
          ...(resetsAt !== undefined ? { resetsAt } : {}),
          ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
        });
      }
      if (
        premium &&
        ((premium.totalAllowance ?? 0) > 0 ||
          (premium.userTokens ?? 0) > 0 ||
          premium.usedRatio != null)
      ) {
        legacyWindows.push({
          id: "legacy-premium",
          kind: "monthly",
          label: "Premium",
          usedPercent: computeLegacyPercent(premium),
          ...(resetsAt !== undefined ? { resetsAt } : {}),
          ...(windowDurationMins !== undefined ? { windowDurationMins } : {}),
        });
      }

      if (legacyWindows.length === 0) {
        return unavailableResult(
          checkedAt,
          "unsupported",
          "No active Factory subscription limits found.",
          auth ? { auth } : undefined,
        );
      }

      return {
        usageLimits: {
          checkedAt,
          windows: legacyWindows,
          group: FACTORY_USAGE_GROUP,
          externalUsage: FACTORY_EXTERNAL_USAGE,
          credentialFingerprint,
        },
        ...(auth ? { auth } : {}),
      } satisfies FactoryUsageLimitsResult;
    }).pipe(
      Effect.orElseSucceed(() =>
        unavailableResult(checkedAt, "probeFailed", "Factory Droid could not read usage limits."),
      ),
    );

    return fetchOutcome;
  },
);
