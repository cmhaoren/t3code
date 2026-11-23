// @effect-diagnostics-next-line nodeBuiltinImport:off -- Tests encrypt Factory keyring payloads using Node AES-256-GCM.
import * as NodeCrypto from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import { AcpRegistrySettings } from "../settings.ts";
import {
  decodeJwtPayload,
  decryptFactoryAuthPayload,
  FACTORY_BILLING_URL,
  FACTORY_USAGE_GROUP,
  isFactoryDroidInstance,
  readFactoryUsageLimits,
  resolveFactoryCredentials,
} from "./factoryUsageLimits.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const decodeServerLimits = Schema.decodeUnknownSync(ServerProviderUsageLimits);
const encoder = new TextEncoder();

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function encryptFactoryPayload(payload: Record<string, unknown>, key: Buffer): string {
  const iv = NodeCrypto.randomBytes(16);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

function spawnerWithOutput(stdout: string, exitCode = 0) {
  return ChildProcessSpawner.make(() =>
    Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(exitCode)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.make(encoder.encode(stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      }),
    ),
  );
}

const baseLayer = Layer.mergeAll(
  NodeServices.layer,
  Layer.succeed(HostProcess.Platform, "linux"),
  Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawnerWithOutput("", 1)),
);

describe("isFactoryDroidInstance", () => {
  it("matches enabled factory-droid registry instances and local droid binaries", () => {
    expect(isFactoryDroidInstance(decodeSettings({ agentId: "factory-droid" }))).toBe(true);
    expect(
      isFactoryDroidInstance(decodeSettings({ enabled: false, agentId: "factory-droid" })),
    ).toBe(false);
    expect(isFactoryDroidInstance(decodeSettings({ agentId: "claude-acp" }))).toBe(false);
    expect(
      isFactoryDroidInstance(
        decodeSettings({ source: "local", commandPath: "C:\\Tools\\factory-droid.exe" }),
      ),
    ).toBe(true);
    expect(
      isFactoryDroidInstance(
        decodeSettings({ source: "local", commandPath: "/usr/local/bin/droid" }),
      ),
    ).toBe(true);
    expect(
      isFactoryDroidInstance(
        decodeSettings({ source: "local", commandPath: "/usr/local/bin/goose" }),
      ),
    ).toBe(false);
  });
});

describe("decryptFactoryAuthPayload and decodeJwtPayload", () => {
  it("decrypts AES-256-GCM iv:tag:ct payloads across key encodings and rejects tampered data", () => {
    const key = NodeCrypto.randomBytes(32);
    const encrypted = encryptFactoryPayload(
      { access_token: "tok-1", active_organization_id: "org-1" },
      key,
    );

    expect(decryptFactoryAuthPayload(encrypted, key.toString("base64"))).toEqual({
      access_token: "tok-1",
      active_organization_id: "org-1",
    });
    expect(decryptFactoryAuthPayload(encrypted, key.toString("hex"))).toEqual({
      access_token: "tok-1",
      active_organization_id: "org-1",
    });

    const parts = encrypted.split(":");
    const tampered = `${parts[0]}:${parts[1]}:${Buffer.from("tampered").toString("base64")}`;
    expect(decryptFactoryAuthPayload(tampered, key.toString("base64"))).toBeNull();
    expect(decryptFactoryAuthPayload("bad-format", key.toString("base64"))).toBeNull();
  });

  it("decodes JWT claims safely", () => {
    const jwt = makeJwt({ sub: "user_123", email: "dev@example.com" });
    expect(decodeJwtPayload(jwt)).toEqual({ sub: "user_123", email: "dev@example.com" });
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
  });
});

describe("resolveFactoryCredentials", () => {
  it.layer(baseLayer)("follows precedence env > .env > keyring > file > auth.json", (it) => {
    it.effect("prefers FACTORY_API_KEY and falls through remaining local sources", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const dir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-creds-" });
        const key = NodeCrypto.randomBytes(32);
        const keyB64 = key.toString("base64");

        expect(
          yield* resolveFactoryCredentials({
            FACTORY_HOME: dir,
            FACTORY_API_KEY: "env-key",
          }),
        ).toEqual({ token: "env-key", source: "apiKey" });

        yield* fs.writeFileString(path.join(dir, ".env"), 'export FACTORY_API_KEY="dotenv-key"\n');
        expect(yield* resolveFactoryCredentials({ FACTORY_HOME: dir })).toEqual({
          token: "dotenv-key",
          source: "apiKey",
        });

        yield* fs.remove(path.join(dir, ".env"));
        yield* fs.writeFileString(
          path.join(dir, "auth.v2.keyring"),
          encryptFactoryPayload(
            { access_token: "keyring-tok", active_organization_id: "org-kr" },
            key,
          ),
        );
        yield* fs.writeFileString(
          path.join(dir, "auth.v2.file"),
          encryptFactoryPayload(
            { access_token: "file-tok", active_organization_id: "org-file" },
            key,
          ),
        );
        yield* fs.writeFileString(path.join(dir, "auth.v2.key"), keyB64);
        yield* fs.writeFileString(
          path.join(dir, "auth.json"),
          JSON.stringify({ access_token: "json-tok", active_organization_id: "org-json" }),
        );

        const fromKeyring = yield* resolveFactoryCredentials({ FACTORY_HOME: dir }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawnerWithOutput(keyB64)),
        );
        expect(fromKeyring).toEqual({
          token: "keyring-tok",
          source: "keyring",
          activeOrganizationId: "org-kr",
        });

        // Disabling keyring falls through to auth.v2.file + auth.v2.key.
        expect(
          yield* resolveFactoryCredentials({
            FACTORY_HOME: dir,
            FACTORY_DISABLE_KEYRING: "1",
          }),
        ).toEqual({
          token: "file-tok",
          source: "file",
          activeOrganizationId: "org-file",
        });

        yield* fs.remove(path.join(dir, "auth.v2.file"));
        expect(
          yield* resolveFactoryCredentials({
            FACTORY_HOME: dir,
            FACTORY_DISABLE_KEYRING: "1",
          }),
        ).toEqual({
          token: "json-tok",
          source: "authJson",
          activeOrganizationId: "org-json",
        });

        yield* fs.writeFileString(
          path.join(dir, "auth.json"),
          JSON.stringify({ api_key: "legacy-key" }),
        );
        expect(
          yield* resolveFactoryCredentials({
            FACTORY_HOME: dir,
            FACTORY_DISABLE_KEYRING: "1",
          }),
        ).toEqual({
          token: "legacy-key",
          source: "apiKey",
        });
      }),
    );

    it.effect(
      "supports FACTORY_HOME_OVERRIDE (with ~/ expansion) below explicit FACTORY_HOME",
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const root = yield* fs.makeTempDirectoryScoped({ prefix: "factory-home-override-" });
          const key = NodeCrypto.randomBytes(32);
          const keyB64 = key.toString("base64");

          const writeAuthFile = (factoryDir: string, token: string, orgId: string) =>
            Effect.gen(function* () {
              yield* fs.makeDirectory(factoryDir, { recursive: true });
              yield* fs.writeFileString(
                path.join(factoryDir, "auth.v2.file"),
                encryptFactoryPayload({ access_token: token, active_organization_id: orgId }, key),
              );
              yield* fs.writeFileString(path.join(factoryDir, "auth.v2.key"), keyB64);
            });

          const defaultHome = path.join(root, "default-home");
          const overrideHome = path.join(root, "profile");
          const directFactoryHome = path.join(root, "direct");
          yield* writeAuthFile(path.join(defaultHome, ".factory"), "default-tok", "org-default");
          yield* writeAuthFile(path.join(overrideHome, ".factory"), "override-tok", "org-override");
          yield* writeAuthFile(directFactoryHome, "direct-tok", "org-direct");

          expect(
            yield* resolveFactoryCredentials({
              FACTORY_HOME_OVERRIDE: overrideHome,
              FACTORY_DISABLE_KEYRING: "1",
              HOME: defaultHome,
              USERPROFILE: defaultHome,
            }),
          ).toEqual({
            token: "override-tok",
            source: "file",
            activeOrganizationId: "org-override",
          });

          expect(
            yield* resolveFactoryCredentials({
              FACTORY_HOME_OVERRIDE: "~/profile",
              FACTORY_DISABLE_KEYRING: "1",
              HOME: defaultHome,
              USERPROFILE: defaultHome,
            }).pipe(Effect.provideService(HostProcess.HomeDirectory, root)),
          ).toEqual({
            token: "override-tok",
            source: "file",
            activeOrganizationId: "org-override",
          });

          expect(
            yield* resolveFactoryCredentials({
              FACTORY_HOME: directFactoryHome,
              FACTORY_HOME_OVERRIDE: overrideHome,
              FACTORY_DISABLE_KEYRING: "1",
            }),
          ).toEqual({
            token: "direct-tok",
            source: "file",
            activeOrganizationId: "org-direct",
          });
        }),
    );
  });
});

describe("readFactoryUsageLimits", () => {
  it.layer(baseLayer)(
    "maps billing limits, auth/me metadata, legacy fallback, and error states",
    (it) => {
      it.effect("maps Standard + Core token rate limits with droidCore non-blocking fallback", () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-limits-" });
          const key = NodeCrypto.randomBytes(32);
          const token = makeJwt({ sub: "jwt_user", email: "jwt@example.com" });
          yield* fs.writeFileString(
            path.join(dir, "auth.v2.file"),
            encryptFactoryPayload({ access_token: token, active_organization_id: "org_tok" }, key),
          );
          yield* fs.writeFileString(path.join(dir, "auth.v2.key"), key.toString("base64"));

          const nowMs = Date.parse("2026-11-22T08:00:00.000Z");
          yield* TestClock.setTime(nowMs);

          const httpClient = HttpClient.make((request, url) => {
            if (url.pathname === "/api/billing/limits") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    usesTokenRateLimitsBilling: true,
                    hasActiveSubscription: true,
                    limits: {
                      standard: {
                        fiveHour: {
                          usedPercent: 10,
                          windowEnd: "2026-11-22T06:00:00.000Z", // expired
                          secondsRemaining: 0,
                        },
                        weekly: {
                          usedPercent: 100,
                          windowEnd: "2026-11-23T05:00:00.000Z",
                          secondsRemaining: 75_600,
                        },
                        monthly: {
                          usedPercent: 37,
                          windowEnd: "2026-12-12T03:00:00.000Z",
                          secondsRemaining: 1_710_000,
                        },
                      },
                      core: {
                        fiveHour: {
                          usedPercent: 30,
                          windowEnd: "2026-11-22T10:53:00.000Z",
                          secondsRemaining: 10_380,
                        },
                        weekly: {
                          usedPercent: 21,
                          windowEnd: "2026-11-27T10:00:00.000Z",
                          secondsRemaining: 439_200,
                        },
                        monthly: {
                          usedPercent: 9,
                          windowEnd: "2026-12-20T10:00:00.000Z",
                          secondsRemaining: 2_426_400,
                        },
                      },
                    },
                    overagePreference: "droidCore",
                  }),
                ),
              );
            }
            if (url.pathname === "/api/app/auth/me") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    organization: {
                      id: "org_live",
                      name: "Team",
                      subscription: {
                        factoryTier: "team_annual",
                        orbSubscription: {
                          plan: { name: "Factory Pro Annual Plan" },
                        },
                      },
                    },
                    userProfile: {
                      email: "dev@example.com",
                      workosUser: { id: "user_live", email: "dev@example.com" },
                      workosMembership: { organizationId: "org_live" },
                    },
                  }),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
            );
          });

          const result = yield* readFactoryUsageLimits({
            FACTORY_HOME: dir,
            FACTORY_DISABLE_KEYRING: "1",
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

          const decoded = decodeServerLimits(result.usageLimits);
          expect(decoded.group).toEqual(FACTORY_USAGE_GROUP);
          expect(decoded.externalUsage).toEqual({
            label: "Factory usage",
            url: FACTORY_BILLING_URL,
          });
          expect(decoded.credentialFingerprint).toBeTruthy();
          expect(result.auth).toEqual({
            email: "dev@example.com",
            label: "Factory Pro Annual Plan",
            workspaceId: "org_live",
          });
          expect(
            decoded.windows.map((w) => [w.id, w.label, w.usedPercent, w.blocksModel, w.resetsAt]),
          ).toEqual([
            ["standard-5h", "Standard · 5h", 0, false, undefined],
            ["standard-weekly", "Standard · Weekly", 100, false, "2026-11-23T05:00:00.000Z"],
            ["standard-monthly", "Standard · Monthly", 37, false, "2026-12-12T03:00:00.000Z"],
            ["core-5h", "Core · 5h", 30, false, "2026-11-22T10:53:00.000Z"],
            ["core-weekly", "Core · Weekly", 21, false, "2026-11-27T10:00:00.000Z"],
            ["core-monthly", "Core · Monthly", 9, false, "2026-12-20T10:00:00.000Z"],
          ]);
        }),
      );

      it.effect("uses simple Session/Weekly/Monthly labels and blocks when Core is inactive", () =>
        Effect.gen(function* () {
          const httpClient = HttpClient.make((request, url) => {
            if (url.pathname === "/api/billing/limits") {
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    usesTokenRateLimitsBilling: true,
                    limits: {
                      standard: {
                        fiveHour: { usedPercent: 25, secondsRemaining: 3600 },
                        weekly: { usedPercent: 100, secondsRemaining: 86_400 },
                        monthly: { usedPercent: 40, secondsRemaining: 864_000 },
                      },
                      core: {
                        fiveHour: { usedPercent: 0, windowEnd: null, secondsRemaining: null },
                      },
                    },
                    overagePreference: "none",
                  }),
                ),
              );
            }
            return Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
            );
          });

          const result = yield* readFactoryUsageLimits({
            FACTORY_API_KEY: "fk-test",
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

          expect(result.usageLimits.windows.map((w) => [w.id, w.label, w.blocksModel])).toEqual([
            ["standard-5h", "Session", undefined],
            ["standard-weekly", "Weekly", undefined],
            ["standard-monthly", "Monthly", undefined],
          ]);
        }),
      );

      it.effect(
        "falls back to legacy /api/organization/subscription/usage when billing/limits is unavailable",
        () =>
          Effect.gen(function* () {
            let requestedLegacyUrl = "";
            const httpClient = HttpClient.make((request, url) => {
              if (url.pathname === "/api/billing/limits") {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
                );
              }
              if (url.pathname === "/api/app/auth/me") {
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json({
                      organization: {
                        id: "org_legacy",
                        subscription: { factoryTier: "pro_monthly" },
                      },
                      userProfile: { id: "u_legacy", email: "legacy@example.com" },
                    }),
                  ),
                );
              }
              if (url.pathname === "/api/organization/subscription/usage") {
                requestedLegacyUrl = url.toString();
                return Effect.succeed(
                  HttpClientResponse.fromWeb(
                    request,
                    Response.json({
                      usage: {
                        startDate: "2026-11-01T00:00:00.000Z",
                        endDate: "2026-12-01T00:00:00.000Z",
                        standard: { userTokens: 500, totalAllowance: 1000, usedRatio: 0.5 },
                        premium: { userTokens: 200, totalAllowance: 1000 },
                      },
                    }),
                  ),
                );
              }
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
              );
            });

            const result = yield* readFactoryUsageLimits({
              FACTORY_API_KEY: "fk-legacy",
            }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

            expect(requestedLegacyUrl).toContain("useCache=true");
            expect(requestedLegacyUrl).toContain("userId=u_legacy");
            expect(result.auth).toEqual({
              email: "legacy@example.com",
              label: "Pro Monthly",
              workspaceId: "org_legacy",
            });
            expect(
              result.usageLimits.windows.map((w) => [
                w.id,
                w.label,
                w.usedPercent,
                w.windowDurationMins,
              ]),
            ).toEqual([
              ["legacy-standard", "Standard", 50, 43_200],
              ["legacy-premium", "Premium", 20, 43_200],
            ]);
          }),
      );

      it.effect(
        "returns distinct messages for missing credentials and 401 API key vs OAuth rejections",
        () =>
          Effect.gen(function* () {
            const fs = yield* FileSystem.FileSystem;
            const dir = yield* fs.makeTempDirectoryScoped({ prefix: "factory-missing-" });
            const key = NodeCrypto.randomBytes(32);
            const path = yield* Path.Path;

            const missing = yield* readFactoryUsageLimits({ FACTORY_HOME: dir }).pipe(
              Effect.provideService(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("unexpected request")),
              ),
            );
            expect(missing.usageLimits.unavailable).toEqual({
              reason: "unsupported",
              message: "Sign in to Factory Droid or set FACTORY_API_KEY to see usage limits.",
            });

            const unauthorizedClient = HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
              ),
            );

            const apiKeyRejected = yield* readFactoryUsageLimits({
              FACTORY_API_KEY: "fk-bad",
            }).pipe(Effect.provideService(HttpClient.HttpClient, unauthorizedClient));
            expect(apiKeyRejected.authRejected).toBe(true);
            expect(apiKeyRejected.usageLimits.unavailable).toEqual({
              reason: "probeFailed",
              message: "Factory API key was rejected. Check FACTORY_API_KEY in settings.",
            });

            yield* fs.writeFileString(
              path.join(dir, "auth.v2.file"),
              encryptFactoryPayload({ access_token: "expired-tok" }, key),
            );
            yield* fs.writeFileString(path.join(dir, "auth.v2.key"), key.toString("base64"));
            const oauthRejected = yield* readFactoryUsageLimits({
              FACTORY_HOME: dir,
              FACTORY_DISABLE_KEYRING: "1",
            }).pipe(Effect.provideService(HttpClient.HttpClient, unauthorizedClient));
            expect(oauthRejected.authRejected).toBe(true);
            expect(oauthRejected.usageLimits.unavailable).toEqual({
              reason: "probeFailed",
              message:
                "Factory Droid session expired. Start a Droid turn or sign in again to refresh limits.",
            });
          }),
      );
    },
  );
});
