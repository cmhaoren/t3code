import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { AcpRegistrySettings } from "../settings.ts";
import { DSH_USAGE_GROUP, readDshUsageLimits } from "./dshUsageLimits.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const decodeServerLimits = Schema.decodeUnknownSync(ServerProviderUsageLimits);

const ACP_PATCH_FIXTURE = `
- id: llm-pi-ai
  name: '@deepseek-ai/dsh-llm-pi-ai'
  config:
    providers:
      apigoto-1:
        displayName: apigoto (Key 1)
        apiKeyEnv: APIGOTO_API_KEY_1
        baseURL: https://api.apigoto.com/v1
      apigoto-2:
        displayName: apigoto (Key 2)
        apiKeyEnv: APIGOTO_API_KEY_2
        baseURL: https://api.apigoto.com/v1
      deepseek-official:
        apiKeyEnv: DEEPSEEK_API_KEY
        baseURL: https://api.deepseek.com/v1
`;

describe("readDshUsageLimits", () => {
  it.effect(
    "reads profile apigoto routes using .credentials.yaml precedence, accounts.json labels, and rolling window percentages",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-limits-" });
        const dshHome = path.join(home, ".dsh");
        const profileDir = path.join(dshHome, "profiles", "acp");
        const accountsDir = path.join(home, ".dsh-apigoto-keys");
        yield* fs.makeDirectory(profileDir, { recursive: true });
        yield* fs.makeDirectory(accountsDir, { recursive: true });

        const secret1 = "sk-apigoto-secret-one-0001";
        const secret2 = "sk-apigoto-secret-two-0002";

        yield* fs.writeFileString(path.join(profileDir, "cordis.patch.yml"), ACP_PATCH_FIXTURE);
        yield* fs.writeFileString(
          path.join(dshHome, ".credentials.yaml"),
          `version: 1\nrefs:\n  APIGOTO_API_KEY_1: "${secret1}"\n`,
        );
        yield* fs.writeFileString(path.join(dshHome, ".env"), `APIGOTO_API_KEY_2="${secret2}"\n`);
        yield* fs.writeFileString(
          path.join(accountsDir, "accounts.json"),
          JSON.stringify({
            version: 1,
            accounts: [
              { id: "a1", label: "cmhaoren 77", key: secret1 },
              { id: "a2", label: "cmhaoren88", key: secret2 },
            ],
          }),
        );

        const seenAuthHeaders: Array<string | undefined> = [];
        const httpClient = HttpClient.make((request) =>
          Effect.sync(() => {
            expect(request.url).toBe("https://api.apigoto.com/v1/usage");
            const auth = request.headers.authorization;
            seenAuthHeaders.push(auth);
            if (auth === `Bearer ${secret1}`) {
              return HttpClientResponse.fromWeb(
                request,
                new Response(
                  JSON.stringify({
                    isValid: true,
                    remaining: 14.91,
                    subscription: {
                      plan_name: "RouterCode PLUS",
                      policy_name: "APIGOTO PLUS",
                      expires_at: "2027-10-27T06:30:45Z",
                      used: 417437.98,
                      limit: 100000000,
                      window_sec: 604800,
                    },
                  }),
                  { status: 200, headers: { "content-type": "application/json" } },
                ),
              );
            }
            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  isValid: true,
                  remaining: 12.7,
                  subscription: {
                    plan_name: "RouterCode PLUS",
                    policy_name: "APIGOTO PLUS",
                    expires_at: "2027-10-27T06:38:09Z",
                    used: 15174146.04,
                    limit: 100000000,
                    window_sec: 604800,
                  },
                }),
                { status: 200, headers: { "content-type": "application/json" } },
              ),
            );
          }),
        );

        const settings = decodeSettings({
          source: "local",
          commandPath: "C:\\tools\\dsh.cmd",
          commandArgs: ["--profile", "acp"],
        });

        const result = yield* readDshUsageLimits({
          settings,
          environment: { APIGOTO_API_KEY_1: "sk-env-shadowed-should-lose" },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcess.HomeDirectory, home),
              Layer.succeed(HttpClient.HttpClient, httpClient),
            ),
          ),
        );

        expect(seenAuthHeaders).toEqual([`Bearer ${secret1}`, `Bearer ${secret2}`]);
        expect(decodeServerLimits(result.usageLimits)).toEqual(result.usageLimits);
        expect(result.auth).toEqual({ label: "RouterCode PLUS" });
        expect(result.usageLimits.group).toEqual(DSH_USAGE_GROUP);
        expect(result.usageLimits.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/u);
        expect(result.usageLimits.windows).toEqual([
          {
            id: "apigoto-rolling-apigoto-1",
            kind: "weekly",
            label: "Key 1 · cmhaoren 77 · 7d",
            usedPercent: 0.42,
            windowDurationMins: 10080,
            blocksModel: false,
          },
          {
            id: "apigoto-rolling-apigoto-2",
            kind: "weekly",
            label: "Key 2 · cmhaoren88 · 7d",
            usedPercent: 15.17,
            windowDurationMins: 10080,
            blocksModel: false,
          },
        ]);
        const serialized = JSON.stringify(result);
        expect(serialized).not.toContain(secret1);
        expect(serialized).not.toContain(secret2);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "falls back to candidate routes on unparseable YAML, deduplicates identical keys, and survives partial HTTP failure",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-limits-fallback-" });
        const profileDir = path.join(home, ".dsh", "profiles", "desktop");
        yield* fs.makeDirectory(profileDir, { recursive: true });
        yield* fs.writeFileString(
          path.join(profileDir, "cordis.patch.yml"),
          "- id: plugin\n  disabled: !!js '!ctx.get()'\n",
        );

        const httpClient = HttpClient.make((request) =>
          Effect.succeed(
            request.headers.authorization === "Bearer sk-fail"
              ? HttpClientResponse.fromWeb(request, new Response("unauthorized", { status: 401 }))
              : HttpClientResponse.fromWeb(
                  request,
                  new Response(
                    JSON.stringify({
                      subscription: { usedPercent: 42.345, windowSec: 3600 },
                    }),
                    { status: 200, headers: { "content-type": "application/json" } },
                  ),
                ),
          ),
        );

        const result = yield* readDshUsageLimits({
          settings: decodeSettings({
            source: "local",
            commandPath: "C:\\Program Files\\DeepSeek Harness\\DeepSeek Harness.exe",
            commandArgs: [
              "--expose-internals",
              "C:\\Program Files\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js",
              "--profile=desktop",
            ],
          }),
          environment: {
            APIGOTO_API_KEY_1: "sk-fail",
            APIGOTO_API_KEY_2: "sk-ok",
            APIGOTO_API_KEY: "sk-ok",
          },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcess.HomeDirectory, home),
              Layer.succeed(HttpClient.HttpClient, httpClient),
            ),
          ),
        );

        expect(result.usageLimits.unavailable).toBeUndefined();
        expect(result.usageLimits.windows).toEqual([
          {
            id: "apigoto-rolling-apigoto-2",
            kind: "session",
            label: "apigoto · Key 2 · 1h",
            usedPercent: 42.35,
            windowDurationMins: 60,
            blocksModel: false,
          },
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "returns unsupported when no apigoto keys exist and probeFailed when every route fails",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-dsh-limits-empty-" });
        const settings = decodeSettings({
          source: "local",
          commandPath: "dsh.cmd",
          commandArgs: ["--profile", "acp"],
        });

        const noKeys = yield* readDshUsageLimits({ settings, environment: {} }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcess.HomeDirectory, home),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make(() => Effect.die("unexpected HTTP call")),
              ),
            ),
          ),
        );
        expect(noKeys.usageLimits).toMatchObject({
          windows: [],
          group: DSH_USAGE_GROUP,
          unavailable: { reason: "unsupported" },
        });

        const allFailed = yield* readDshUsageLimits({
          settings,
          environment: { APIGOTO_API_KEY_1: "sk-bad-secret-value" },
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcess.HomeDirectory, home),
              Layer.succeed(
                HttpClient.HttpClient,
                HttpClient.make((request) =>
                  Effect.succeed(
                    HttpClientResponse.fromWeb(request, new Response("forbidden", { status: 403 })),
                  ),
                ),
              ),
            ),
          ),
        );
        expect(allFailed.usageLimits).toMatchObject({
          windows: [],
          group: DSH_USAGE_GROUP,
          unavailable: { reason: "probeFailed" },
        });
        expect(JSON.stringify(allFailed)).not.toContain("sk-bad-secret-value");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
