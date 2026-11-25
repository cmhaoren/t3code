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
    "separates universal pool vs agent-specific global vs builtin, flags non-absolute Windows skills.json, and ignores backup dirs",
    () =>
      Effect.gen(function* () {
        const tempRoot = yield* Effect.promise(() =>
          NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-skills-overview-v2-")),
        );
        return yield* Effect.ensuring(
          Effect.gen(function* () {
            const userHome = NodePath.join(tempRoot, "home");
            const stateDir = NodePath.join(tempRoot, "state");
            const w2Home = NodePath.join(tempRoot, "factory-w2");

            // 1. Universal pool: ego-browser + tdd + ignored backup dir
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
                NodePath.join(userHome, ".agents", "skills"),
                "tdd",
                "tdd",
                "Test-driven development",
              ),
            );
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".agents", "skills"),
                "old.backup-2026",
                "old-backup",
                "Should be ignored",
              ),
            );

            // 2. Factory W1 has ego-browser in .factory/skills (plus reads ~/.agents/skills for tdd)
            //    W2 has FACTORY_HOME_OVERRIDE with no .factory/skills and no .agents/skills
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".factory", "skills"),
                "ego-browser",
                "ego-browser",
                "Browser automation skill",
              ),
            );

            // 3. Codex-only agent_global skill: should NOT mark AGY/W1/W2 as missing!
            yield* Effect.promise(() =>
              writeSkill(
                NodePath.join(userHome, ".codex", "skills"),
                "codex-only",
                "codex-only",
                "Codex specific skill",
              ),
            );

            // 4. Antigravity skills.json with absolute path for ego-browser AND non-absolute ~/ for broken-dir
            const absCustomDir = NodePath.join(userHome, "abs-ego-skills");
            yield* Effect.promise(() =>
              writeSkill(absCustomDir, "ego-browser", "ego-browser", "Browser automation skill"),
            );
            const tildeCustomDir = NodePath.join(userHome, "tilde-skills");
            yield* Effect.promise(() =>
              writeSkill(tildeCustomDir, "tilde-only", "tilde-only", "Tilde registered skill"),
            );
            const geminiConfigDir = NodePath.join(userHome, ".gemini", "config");
            yield* Effect.promise(() => NodeFSP.mkdir(geminiConfigDir, { recursive: true }));
            yield* Effect.promise(() =>
              NodeFSP.writeFile(
                NodePath.join(geminiConfigDir, "skills.json"),
                JSON.stringify({
                  entries: [{ path: absCustomDir }, { path: "~/tilde-skills" }],
                }),
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
              makeProvider({
                instanceId: "codex",
                driver: "codex",
                displayName: "Codex",
                skills: [
                  {
                    name: "codex-only",
                    description: "Codex specific skill",
                    path: NodePath.join(userHome, ".codex", "skills", "codex-only", "SKILL.md"),
                    enabled: true,
                  },
                ],
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

            // Ignored backup dir must not appear
            expect(overview.skills.find((entry) => entry.name === "old-backup")).toBeUndefined();

            // Universal skill: ego-browser (AGY via abs skills.json, W1 via .factory/skills, Codex via ~/.agents/skills; W2 missing)
            const ego = overview.skills.find((entry) => entry.name === "ego-browser");
            expect(ego?.scope).toBe("universal");
            expect(ego?.coveredEnabledCount).toBe(3);
            expect(ego?.expectedEnabledCount).toBe(4);
            expect(ego?.cells.antigravity?.status).toBe("declared_disk");
            expect(ego?.cells.W1?.status).toBe("declared_disk");
            expect(ego?.cells.codex?.status).toBe("declared_disk");
            expect(ego?.cells.W2?.status).toBe("missing");

            // Universal skill: tdd (W1 & Codex read ~/.agents/skills; AGY & isolated W2 do not!)
            const tdd = overview.skills.find((entry) => entry.name === "tdd");
            expect(tdd?.scope).toBe("universal");
            expect(tdd?.cells.W1?.status).toBe("declared_disk");
            expect(tdd?.cells.codex?.status).toBe("declared_disk");
            expect(tdd?.cells.antigravity?.status).toBe("missing");
            expect(tdd?.cells.W2?.status).toBe("missing");

            // Agent-specific global skill: codex-only (only Codex expects it; AGY/W1/W2 are not_applicable!)
            const codexOnly = overview.skills.find((entry) => entry.name === "codex-only");
            expect(codexOnly?.scope).toBe("agent_global");
            expect(codexOnly?.ownerGroupLabels).toEqual(["Codex"]);
            expect(codexOnly?.coveredEnabledCount).toBe(1);
            expect(codexOnly?.expectedEnabledCount).toBe(1);
            expect(codexOnly?.cells.codex?.status).toBe("declared_runtime");
            expect(codexOnly?.cells.antigravity?.status).toBe("not_applicable");
            expect(codexOnly?.cells.W1?.status).toBe("not_applicable");
            expect(codexOnly?.cells.W2?.status).toBe("not_applicable");

            // Non-absolute ~/ path in Windows Antigravity skills.json -> disk_warning + diagnostic!
            const tildeOnly = overview.skills.find((entry) => entry.name === "tilde-only");
            expect(tildeOnly?.scope).toBe("agent_global");
            expect(tildeOnly?.cells.antigravity?.status).toBe("disk_warning");
            expect(tildeOnly?.cells.antigravity?.reason).toContain("绝对路径");

            // Builtin skill
            const agyBuiltin = overview.skills.find((entry) => entry.name === "agy-customizations");
            expect(agyBuiltin?.scope).toBe("builtin");
            expect(agyBuiltin?.cells.antigravity?.status).toBe("declared_runtime");
            expect(agyBuiltin?.cells.W1?.status).toBe("not_applicable");

            // Diagnostics
            expect(overview.diagnostics.some((d) => d.code === "path_mixed_slashes")).toBe(true);
            expect(
              overview.diagnostics.some((d) => d.code === "isolated_profile_missing_skills"),
            ).toBe(true);
            expect(
              overview.diagnostics.some((d) => d.code === "isolated_profile_no_universal_pool"),
            ).toBe(true);
            expect(
              overview.diagnostics.some((d) => d.code === "antigravity_skills_json_non_absolute"),
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
