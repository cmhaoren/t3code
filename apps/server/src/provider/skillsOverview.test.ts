// @effect-diagnostics-next-line nodeBuiltinImport:off -- Test fixture setup in temp directory.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Test fixture path assembly.
import * as NodePath from "node:path";
import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  DEFAULT_SERVER_SETTINGS,
  IsoDateTime,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";
import { buildSkillsOverview } from "./skillsOverview.ts";

function makeProvider(input: {
  readonly instanceId: string;
  readonly driver: string;
  readonly displayName: string;
  readonly enabled?: boolean;
  readonly skills?: ServerProvider["skills"];
}): ServerProvider {
  return {
    driver: ProviderDriverKind.make(input.driver),
    instanceId: ProviderInstanceId.make(input.instanceId),
    displayName: input.displayName,
    enabled: input.enabled ?? true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: IsoDateTime.make("2026-11-25T00:00:00.000Z"),
    models: [],
    slashCommands: [],
    skills: input.skills ?? [],
  };
}

async function writeSkill(rootDir: string, folderName: string, name: string, description: string) {
  const dir = NodePath.join(rootDir, folderName);
  await NodeFSP.mkdir(dir, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`,
    "utf8",
  );
  return dir;
}

describe("buildSkillsOverview", () => {
  it.effect(
    "detects global skill coverage, isolated Factory profile gaps, Antigravity skills.json entries, builtin scoping, and Windows PATH slash warnings",
    () =>
      Effect.gen(function* () {
        const tempRoot = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skills-overview-")),
        );
        return yield* Effect.ensuring(
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const w2Home = NodePath.join(tempRoot, "factory-w2");

            // Universal pool + W1 Factory Droid have ego-browser; W2 isolated profile lacks .factory/skills
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".agents", "skills"),
                "ego-browser",
                "ego-browser",
                "Browser automation skill",
              ),
            );
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".factory", "skills"),
                "ego-browser",
                "ego-browser",
                "Browser automation skill",
              ),
            );

            // Antigravity skills.json points to ~/custom-skills which contains ego-browser
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, "custom-skills"),
                "ego-browser",
                "ego-browser",
                "Browser automation skill",
              ),
            );
            const geminiConfigDir = NodePath.join(userHome, ".gemini", "config");
            yield* Effect.promise(() => NodeFSP.mkdir(geminiConfigDir, { recursive: true }));
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(geminiConfigDir, "skills.json"),
                JSON.stringify({ entries: [{ path: "~/custom-skills" }] }),
                "utf8",
              ),
            );

            const settings: ServerSettings = {
              ...DEFAULT_SERVER_SETTINGS,
              providerInstances: {
                ...DEFAULT_SERVER_SETTINGS.providerInstances,
                [ProviderInstanceId.make("W1")]: {
                  driver: ProviderDriverKind.make("acpRegistry"),
                  displayName: "W1",
                  enabled: true,
                  config: { agentId: "factory-droid" },
                },
                [ProviderInstanceId.make("W2")]: {
                  driver: ProviderDriverKind.make("acpRegistry"),
                  displayName: "W2",
                  enabled: true,
                  config: { agentId: "factory-droid" },
                  environment: [{ name: "FACTORY_HOME_OVERRIDE", value: w2Home, sensitive: false }],
                },
              } as ServerSettings["providerInstances"],
            };

            const providers: ReadonlyArray<ServerProvider> = [
              makeProvider({
                instanceId: "antigravity",
                driver: "antigravity",
                displayName: "AGY",
                skills: [
                  {
                    name: "agy-customizations",
                    description: "Built-in Antigravity guide",
                    path: "C:/agy/builtin/skills/agy-customizations/SKILL.md",
                    enabled: true,
                  },
                ],
              }),
              makeProvider({
                instanceId: "W1",
                driver: "acpRegistry",
                displayName: "W1",
              }),
              makeProvider({
                instanceId: "W2",
                driver: "acpRegistry",
                displayName: "W2",
              }),
            ];

            const overview = yield* buildSkillsOverview({
              providers,
              settings,
              stateDir,
              userHome,
              envPath: `C:\\Windows\\System32;${userHome}\\.local/share/ego\\active_version_dir`,
              platform: "win32",
            });

            const ego = overview.skills.find((entry) => entry.name === "ego-browser");
            expect(ego).toBeDefined();
            expect(ego?.scope).toBe("global");
            expect(ego?.coveredEnabledCount).toBe(2);
            expect(ego?.totalEnabledCount).toBe(3);
            expect(ego?.cells.antigravity?.status).toBe("disk_only");
            expect(ego?.cells.antigravity?.reason).toContain("skills.json");
            expect(ego?.cells.W1?.status).toBe("disk_only");
            expect(ego?.cells.W2?.status).toBe("missing");

            const agyBuiltin = overview.skills.find((entry) => entry.name === "agy-customizations");
            expect(agyBuiltin?.scope).toBe("builtin");
            expect(agyBuiltin?.cells.antigravity?.status).toBe("active");
            expect(agyBuiltin?.cells.W1?.status).toBe("not_applicable");
            expect(agyBuiltin?.cells.W2?.status).toBe("not_applicable");

            expect(overview.diagnostics.some((d) => d.code === "path_mixed_slashes")).toBe(true);
            expect(
              overview.diagnostics.some((d) => d.code === "isolated_profile_missing_skills"),
            ).toBe(true);
          }),
          Effect.promise(() => NodeFSP.rm(tempRoot, { recursive: true, force: true })),
        );
      }).pipe(
        Effect.provideService(HostProcess.Platform, "win32"),
        Effect.provideService(HostProcess.Environment, {}),
      ),
  );
});
