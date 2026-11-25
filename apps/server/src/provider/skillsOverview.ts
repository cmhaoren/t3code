// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous sha256 for Antigravity profile directory lookup.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Uses lstat/readlink to inspect Windows junctions and symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Pure synchronous path normalization inside async fs scanner.
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  IsoDateTime,
  NonNegativeInt,
  PROVIDER_DISPLAY_NAMES,
  type ProviderInstanceId,
  SkillsOverviewError,
  type ServerGetSkillsOverviewResult,
  type ServerProvider,
  type ServerProviderSkill,
  type ServerSettings,
  type SkillMatrixCell,
  type SkillMatrixDiagnostic,
  type SkillMatrixEntry,
  type SkillMatrixInstance,
  type SkillMatrixScope,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const AntigravitySkillsJsonSchema = Schema.Struct({
  entries: Schema.optional(
    Schema.Array(
      Schema.Struct({
        path: Schema.String,
      }),
    ),
  ),
});
const decodeAntigravitySkillsJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(AntigravitySkillsJsonSchema),
);

interface DiscoveredDiskSkill {
  readonly name: string;
  readonly description?: string;
  readonly hasValidFrontmatter: boolean;
  readonly skillMdPath: string;
  readonly dirPath: string;
  readonly sourceDir: string;
  readonly linkTarget?: string;
  readonly fromSkillsJson?: boolean;
  readonly manifestPathNonAbsolute?: boolean;
}

interface ManifestEntryScan {
  readonly rawPath: string;
  readonly resolvedDir: string;
  readonly nonAbsoluteOnWindows: boolean;
}

interface InstanceSkillSpec {
  readonly driverGroupKey: string;
  readonly driverGroupLabel: string;
  readonly dirs: ReadonlyArray<string>;
  readonly writableGlobalSkillDir: string;
  readonly readsUniversalPool: boolean;
  readonly manifestEntries: ReadonlyArray<ManifestEntryScan>;
  readonly factoryHomeOverride?: string;
  readonly isFactoryDroid: boolean;
}

function isIgnoredSkillDirName(entryName: string): boolean {
  const lower = entryName.toLowerCase();
  return (
    entryName.startsWith(".") ||
    entryName.startsWith("_") ||
    lower.includes(".backup") ||
    lower.includes(".disabled") ||
    lower.endsWith(".bak")
  );
}

function expandHome(rawPath: string, userHome: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return userHome;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return NodePath.join(userHome, trimmed.slice(2));
  }
  return trimmed;
}

function parseSkillFrontmatter(content: string): {
  readonly name?: string;
  readonly description?: string;
  readonly hasValidFrontmatter: boolean;
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return { hasValidFrontmatter: false };
  const body = match[1] ?? "";
  let name: string | undefined;
  let description: string | undefined;
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const nameMatch = /^name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      const value = (nameMatch[1] ?? "").trim().replace(/^["']|["']$/g, "");
      if (value.length > 0) name = value;
      continue;
    }
    const descMatch = /^description:\s*(.*)$/.exec(line);
    if (descMatch) {
      const raw = (descMatch[1] ?? "").trim();
      if (raw === ">" || raw === ">-" || raw === "|" || raw === "|-") {
        const folded: Array<string> = [];
        for (let j = i + 1; j < lines.length; j += 1) {
          const nextLine = lines[j] ?? "";
          if (/^\s+/.test(nextLine)) {
            folded.push(nextLine.trim());
            i = j;
          } else {
            break;
          }
        }
        const joined = folded.join(" ").trim();
        if (joined.length > 0) description = joined;
      } else {
        const unquoted = raw.replace(/^["']|["']$/g, "");
        if (unquoted.length > 0) description = unquoted;
      }
    }
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    hasValidFrontmatter: name !== undefined && description !== undefined,
  };
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await NodeFSP.stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function scanSkillsDirectory(
  rootDir: string,
  options?: { readonly fromSkillsJson?: boolean; readonly manifestPathNonAbsolute?: boolean },
): Promise<ReadonlyArray<DiscoveredDiskSkill>> {
  let entries: ReadonlyArray<string>;
  try {
    entries = await NodeFSP.readdir(rootDir);
  } catch {
    return [];
  }
  const results: Array<DiscoveredDiskSkill> = [];
  for (const entryName of entries) {
    if (isIgnoredSkillDirName(entryName)) continue;
    const entryPath = NodePath.join(rootDir, entryName);
    let linkTarget: string | undefined;
    try {
      const lstat = await NodeFSP.lstat(entryPath);
      if (lstat.isSymbolicLink()) {
        try {
          linkTarget = await NodeFSP.readlink(entryPath);
        } catch {
          linkTarget = undefined;
        }
      }
      const stat = await NodeFSP.stat(entryPath);
      if (!stat.isDirectory()) continue;
    } catch {
      continue;
    }
    const skillMdPath = NodePath.join(entryPath, "SKILL.md");
    let rawContent: string;
    try {
      rawContent = await NodeFSP.readFile(skillMdPath, "utf8");
    } catch {
      continue;
    }
    const meta = parseSkillFrontmatter(rawContent);
    const name = meta.name ?? entryName;
    results.push({
      name,
      ...(meta.description !== undefined ? { description: meta.description } : {}),
      hasValidFrontmatter: meta.hasValidFrontmatter,
      skillMdPath,
      dirPath: entryPath,
      sourceDir: rootDir,
      ...(linkTarget !== undefined ? { linkTarget } : {}),
      ...(options?.fromSkillsJson ? { fromSkillsJson: true } : {}),
      ...(options?.manifestPathNonAbsolute ? { manifestPathNonAbsolute: true } : {}),
    });
  }
  return results;
}

async function readAntigravitySkillsJsonEntries(
  skillsJsonPath: string,
  userHome: string,
  platform: NodeJS.Platform,
): Promise<ReadonlyArray<ManifestEntryScan>> {
  let raw: string;
  try {
    raw = await NodeFSP.readFile(skillsJsonPath, "utf8");
  } catch {
    return [];
  }
  const decoded = decodeAntigravitySkillsJson(raw);
  if (Option.isNone(decoded)) {
    return [];
  }
  const resolved: Array<ManifestEntryScan> = [];
  for (const entry of decoded.value.entries ?? []) {
    const trimmed = entry.path.trim();
    if (trimmed.length === 0) continue;
    // Antigravity's Windows Go binary calls filepath.IsAbs without expanding "~/" first.
    const nonAbsoluteOnWindows =
      platform === "win32" &&
      (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\"));
    resolved.push({
      rawPath: trimmed,
      resolvedDir: NodePath.resolve(expandHome(trimmed, userHome)),
      nonAbsoluteOnWindows,
    });
  }
  return resolved;
}

function readInstanceEnvValue(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
  envName: string,
): string | undefined {
  const instance = settings.providerInstances[instanceId] as
    | {
        readonly environment?: ReadonlyArray<{ readonly name: string; readonly value?: string }>;
      }
    | undefined;
  const match = instance?.environment?.find(
    (entry) => entry.name.toUpperCase() === envName.toUpperCase(),
  );
  const value = match?.value?.trim();
  return value && value.length > 0 ? value : undefined;
}

function readAcpInstanceMeta(
  settings: ServerSettings,
  instanceId: ProviderInstanceId,
): { readonly agentId?: string; readonly commandPath?: string } {
  const instance = settings.providerInstances[instanceId] as
    | {
        readonly config?: {
          readonly agentId?: unknown;
          readonly commandPath?: unknown;
        };
      }
    | undefined;
  const agentId =
    typeof instance?.config?.agentId === "string" ? instance.config.agentId.trim() : undefined;
  const commandPath =
    typeof instance?.config?.commandPath === "string"
      ? instance.config.commandPath.trim()
      : undefined;
  return {
    ...(agentId ? { agentId } : {}),
    ...(commandPath ? { commandPath } : {}),
  };
}

/**
 * Resolve each provider instance's real global skill discovery specification.
 * Grounded in actual CLI behavior on this machine (ignores single-project workspace skills).
 */
async function resolveInstanceSkillSpec(input: {
  readonly provider: ServerProvider;
  readonly settings: ServerSettings;
  readonly stateDir: string;
  readonly userHome: string;
  readonly platform: NodeJS.Platform;
}): Promise<InstanceSkillSpec> {
  const { provider, settings, stateDir, userHome, platform } = input;
  const dirs: Array<string> = [];
  const manifestEntries: Array<ManifestEntryScan> = [];
  let factoryHomeOverride: string | undefined;
  let isFactoryDroid = false;
  let readsUniversalPool = false;

  const pushUnique = (list: Array<string>, dir: string) => {
    const normalized = NodePath.resolve(dir);
    if (!list.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) {
      list.push(normalized);
    }
  };

  const universalPoolDir = NodePath.join(userHome, ".agents", "skills");
  let driverGroupKey: string = provider.driver;
  let driverGroupLabel: string =
    PROVIDER_DISPLAY_NAMES[provider.driver as keyof typeof PROVIDER_DISPLAY_NAMES] ??
    provider.driver;
  let writableGlobalSkillDir = universalPoolDir;

  if (provider.driver === "antigravity") {
    driverGroupKey = "antigravity";
    driverGroupLabel = "Antigravity";
    readsUniversalPool = false;
    const key = NodeCrypto.createHash("sha256").update(provider.instanceId).digest("hex");
    const profileDir = NodePath.join(stateDir, "providers", "antigravity", key);
    const profileSkillsDir = NodePath.join(profileDir, "config", "skills");
    const globalSkillsDir = NodePath.join(userHome, ".gemini", "config", "skills");
    writableGlobalSkillDir = globalSkillsDir;
    pushUnique(dirs, profileSkillsDir);
    pushUnique(dirs, globalSkillsDir);

    const profileManifest = await readAntigravitySkillsJsonEntries(
      NodePath.join(profileDir, "config", "skills.json"),
      userHome,
      platform,
    );
    const globalManifest = await readAntigravitySkillsJsonEntries(
      NodePath.join(userHome, ".gemini", "config", "skills.json"),
      userHome,
      platform,
    );
    for (const entry of [...profileManifest, ...globalManifest]) {
      if (
        !manifestEntries.some(
          (existing) => existing.resolvedDir.toLowerCase() === entry.resolvedDir.toLowerCase(),
        )
      ) {
        manifestEntries.push(entry);
      }
      pushUnique(dirs, entry.resolvedDir);
    }
  } else if (provider.driver === "acpRegistry") {
    const meta = readAcpInstanceMeta(settings, provider.instanceId);
    factoryHomeOverride = readInstanceEnvValue(
      settings,
      provider.instanceId,
      "FACTORY_HOME_OVERRIDE",
    );
    if (meta.agentId === "factory-droid" || factoryHomeOverride !== undefined) {
      isFactoryDroid = true;
      driverGroupKey = "acpRegistry:factory-droid";
      driverGroupLabel = "Factory Droid";
      const factoryHome = factoryHomeOverride ?? userHome;
      const factorySkillsDir = NodePath.join(factoryHome, ".factory", "skills");
      const factoryAgentsDir = NodePath.join(factoryHome, ".agents", "skills");
      writableGlobalSkillDir = factorySkillsDir;
      // Factory Droid reads <FACTORY_HOME>/.factory/skills and <FACTORY_HOME>/.agents/skills.
      // When FACTORY_HOME_OVERRIDE is set, it reads the override home's .agents/skills, NOT the user's ~/.agents/skills!
      readsUniversalPool = factoryHomeOverride === undefined;
      pushUnique(dirs, factorySkillsDir);
      pushUnique(dirs, factoryAgentsDir);
    } else if (
      provider.instanceId.toLowerCase() === "dsh" ||
      meta.commandPath?.toLowerCase().includes("dsh") === true
    ) {
      driverGroupKey = "acpRegistry:dsh";
      driverGroupLabel = "DeepSeek Harness";
      readsUniversalPool = true;
      writableGlobalSkillDir = NodePath.join(userHome, ".dsh", "skills");
      pushUnique(dirs, NodePath.join(userHome, ".dsh", "skills"));
      pushUnique(dirs, universalPoolDir);
    } else {
      driverGroupKey = meta.agentId ? `acpRegistry:${meta.agentId}` : "acpRegistry";
      driverGroupLabel = meta.agentId ?? "ACP";
      readsUniversalPool = true;
      writableGlobalSkillDir = universalPoolDir;
      pushUnique(dirs, universalPoolDir);
    }
  } else if (provider.driver === "codex") {
    driverGroupKey = "codex";
    driverGroupLabel = "Codex";
    readsUniversalPool = true;
    writableGlobalSkillDir = NodePath.join(userHome, ".codex", "skills");
    pushUnique(dirs, NodePath.join(userHome, ".codex", "skills"));
    pushUnique(dirs, universalPoolDir);
  } else if (provider.driver === "claudeAgent") {
    driverGroupKey = "claudeAgent";
    driverGroupLabel = "Claude";
    readsUniversalPool = false;
    writableGlobalSkillDir = NodePath.join(userHome, ".claude", "skills");
    pushUnique(dirs, NodePath.join(userHome, ".claude", "skills"));
  } else if (provider.driver === "cursor") {
    driverGroupKey = "cursor";
    driverGroupLabel = "Cursor";
    readsUniversalPool = false;
    writableGlobalSkillDir = NodePath.join(userHome, ".cursor", "skills");
    pushUnique(dirs, NodePath.join(userHome, ".cursor", "skills"));
  } else if (provider.driver === "opencode") {
    driverGroupKey = "opencode";
    driverGroupLabel = "OpenCode";
    readsUniversalPool = true;
    writableGlobalSkillDir = NodePath.join(userHome, ".config", "opencode", "skills");
    pushUnique(dirs, NodePath.join(userHome, ".config", "opencode", "skills"));
    pushUnique(dirs, universalPoolDir);
  } else if (provider.driver === "pi") {
    driverGroupKey = "pi";
    driverGroupLabel = "Pi";
    readsUniversalPool = true;
    writableGlobalSkillDir = NodePath.join(userHome, ".pi", "agent", "skills");
    pushUnique(dirs, NodePath.join(userHome, ".pi", "agent", "skills"));
    pushUnique(dirs, universalPoolDir);
  } else {
    readsUniversalPool = true;
    writableGlobalSkillDir = universalPoolDir;
    pushUnique(dirs, universalPoolDir);
  }

  return {
    driverGroupKey,
    driverGroupLabel,
    dirs,
    writableGlobalSkillDir,
    readsUniversalPool,
    manifestEntries,
    ...(factoryHomeOverride !== undefined ? { factoryHomeOverride } : {}),
    isFactoryDroid,
  };
}

function isBetterDiskCandidate(
  existing: DiscoveredDiskSkill | undefined,
  incoming: DiscoveredDiskSkill,
): boolean {
  if (!existing) return true;
  // Prefer valid absolute skills.json entry over non-absolute or bare junction.
  const score = (skill: DiscoveredDiskSkill): number => {
    if (skill.fromSkillsJson && !skill.manifestPathNonAbsolute) return 4;
    if (!skill.linkTarget && !skill.manifestPathNonAbsolute) return 3;
    if (skill.fromSkillsJson) return 2;
    return 1;
  };
  return score(incoming) > score(existing);
}

const SCOPE_ORDER: Readonly<Record<SkillMatrixScope, number>> = {
  universal: 0,
  agent_global: 1,
  builtin: 2,
};

export interface BuildSkillsOverviewInput {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings: ServerSettings;
  readonly stateDir: string;
  readonly userHome?: string | undefined;
  readonly envPath?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly cwd?: string | undefined;
}

export const buildSkillsOverview = Effect.fn("SkillsOverview.build")(function* (
  input: BuildSkillsOverviewInput,
) {
  const checkedAt = IsoDateTime.make(DateTime.formatIso(yield* DateTime.now));
  const userHome = input.userHome ?? NodeOS.homedir();
  const hostEnv = yield* HostProcess.Environment;
  const envPath = input.envPath ?? hostEnv.PATH ?? hostEnv.Path;
  const platform = input.platform ?? (yield* HostProcess.Platform);

  return yield* Effect.tryPromise({
    try: async (): Promise<ServerGetSkillsOverviewResult> => {
      const diagnostics: Array<SkillMatrixDiagnostic> = [];
      const seenDiagnostics = new Set<string>();
      const pushDiagnostic = (diagnostic: SkillMatrixDiagnostic) => {
        const key = `${diagnostic.code}:${diagnostic.message}:${diagnostic.detail ?? ""}`;
        if (seenDiagnostics.has(key)) return;
        seenDiagnostics.add(key);
        diagnostics.push(diagnostic);
      };

      // Diagnostic 1: Windows PATH entries mixing forward/back slashes (e.g. ego-browser installer bug)
      if (platform === "win32" && envPath) {
        for (const rawEntry of envPath.split(";")) {
          const entry = rawEntry.trim();
          if (entry.length === 0) continue;
          if (entry.includes("/") && entry.includes("\\")) {
            pushDiagnostic({
              severity: "warning",
              code: "path_mixed_slashes",
              message: "环境变量 PATH 中存在正反斜杠混用路径，可能导致 CLI 技能命令无法识别",
              detail: entry,
            });
          }
        }
      }

      // Scan universal ~/.agents/skills pool (true cross-agent global layer)
      const universalPoolDir = NodePath.resolve(NodePath.join(userHome, ".agents", "skills"));
      const universalSkills = await scanSkillsDirectory(universalPoolDir);
      const universalSkillNames = new Set<string>(universalSkills.map((skill) => skill.name));

      // Scan default ~/.factory/skills once for Factory isolated profile diagnostic
      const defaultFactorySkillsDir = NodePath.join(userHome, ".factory", "skills");
      const defaultFactorySkills = await scanSkillsDirectory(defaultFactorySkillsDir);

      const specsByInstanceId = new Map<string, InstanceSkillSpec>();
      for (const provider of input.providers) {
        const spec = await resolveInstanceSkillSpec({
          provider,
          settings: input.settings,
          stateDir: input.stateDir,
          userHome,
          platform,
        });
        specsByInstanceId.set(provider.instanceId, spec);
      }

      // Sort instances: enabled first, grouped by driverGroupLabel, then displayName
      const sortedProviders = [...input.providers].toSorted((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        const groupA = specsByInstanceId.get(a.instanceId)?.driverGroupLabel ?? a.driver;
        const groupB = specsByInstanceId.get(b.instanceId)?.driverGroupLabel ?? b.driver;
        const groupCmp = groupA.localeCompare(groupB);
        if (groupCmp !== 0) return groupCmp;
        return (a.displayName ?? a.instanceId).localeCompare(b.displayName ?? b.instanceId);
      });

      const instances: Array<SkillMatrixInstance> = [];
      const diskSkillsByInstance = new Map<string, Map<string, DiscoveredDiskSkill>>();
      const runtimeSkillsByInstance = new Map<string, Map<string, ServerProviderSkill>>();

      const agentGlobalOwnerGroups = new Map<string, Set<string>>();
      const builtinOwnerGroups = new Map<string, Set<string>>();
      const groupLabelByKey = new Map<string, string>();
      const allSkillMeta = new Map<string, { description?: string; canonicalPath?: string }>();

      for (const skill of universalSkills) {
        allSkillMeta.set(skill.name, {
          ...(skill.description ? { description: skill.description } : {}),
          canonicalPath: skill.linkTarget ?? skill.dirPath,
        });
      }

      for (const provider of sortedProviders) {
        const spec = specsByInstanceId.get(provider.instanceId)!;
        groupLabelByKey.set(spec.driverGroupKey, spec.driverGroupLabel);

        instances.push({
          instanceId: provider.instanceId,
          driver: provider.driver,
          driverGroupKey: spec.driverGroupKey,
          driverGroupLabel: spec.driverGroupLabel,
          displayName: provider.displayName?.trim() || provider.instanceId,
          enabled: provider.enabled,
          installed: provider.installed,
          status: provider.status,
          readsUniversalPool: spec.readsUniversalPool,
          globalSkillDirs: [...spec.dirs],
          writableGlobalSkillDir: spec.writableGlobalSkillDir,
        });

        const manifestByDir = new Map<string, ManifestEntryScan>(
          spec.manifestEntries.map((entry) => [entry.resolvedDir.toLowerCase(), entry]),
        );

        // Diagnostic: Antigravity skills.json with non-absolute ~/ path on Windows
        if (provider.enabled && provider.driver === "antigravity") {
          for (const entry of spec.manifestEntries) {
            if (entry.nonAbsoluteOnWindows) {
              pushDiagnostic({
                severity: "warning",
                code: "antigravity_skills_json_non_absolute",
                message: "Antigravity 的 skills.json 在 Windows 上不支持 ~/ 写法，必须使用绝对路径",
                detail: `当前配置 "${entry.rawPath}" 会被底层拒绝；请改为 "${entry.resolvedDir.replace(/\\/g, "/")}"`,
              });
            }
          }
        }

        const diskMap = new Map<string, DiscoveredDiskSkill>();
        for (const dir of spec.dirs) {
          const manifestEntry = manifestByDir.get(dir.toLowerCase());
          const scanned = await scanSkillsDirectory(dir, {
            ...(manifestEntry ? { fromSkillsJson: true } : {}),
            ...(manifestEntry?.nonAbsoluteOnWindows ? { manifestPathNonAbsolute: true } : {}),
          });
          for (const skill of scanned) {
            const existing = diskMap.get(skill.name);
            if (isBetterDiskCandidate(existing, skill)) {
              diskMap.set(skill.name, skill);
            }
            // If this skill is NOT in ~/.agents/skills, record it as owned by this driver group.
            if (!universalSkillNames.has(skill.name)) {
              const owners = agentGlobalOwnerGroups.get(skill.name) ?? new Set<string>();
              owners.add(spec.driverGroupKey);
              agentGlobalOwnerGroups.set(skill.name, owners);
            }
            const meta = allSkillMeta.get(skill.name) ?? {};
            if (!meta.description && skill.description) {
              meta.description = skill.description;
            }
            if (!meta.canonicalPath) {
              meta.canonicalPath = skill.linkTarget ?? skill.dirPath;
            }
            allSkillMeta.set(skill.name, meta);
          }
        }
        diskSkillsByInstance.set(provider.instanceId, diskMap);

        // Runtime skills (global only — deliberately ignore workspaceSnapshots to stay focused on global layer)
        const runtimeMap = new Map<string, ServerProviderSkill>();
        for (const skill of provider.skills) {
          runtimeMap.set(skill.name, skill);
          if (!universalSkillNames.has(skill.name) && !agentGlobalOwnerGroups.has(skill.name)) {
            const owners = builtinOwnerGroups.get(skill.name) ?? new Set<string>();
            owners.add(spec.driverGroupKey);
            builtinOwnerGroups.set(skill.name, owners);
          }
          const meta = allSkillMeta.get(skill.name) ?? {};
          if (!meta.description && skill.description) {
            meta.description = skill.description;
          }
          if (!meta.canonicalPath && skill.path) {
            meta.canonicalPath = skill.path;
          }
          allSkillMeta.set(skill.name, meta);
        }
        runtimeSkillsByInstance.set(provider.instanceId, runtimeMap);

        // Diagnostic 2: Factory Droid isolated profile missing .factory/skills or .agents/skills
        if (provider.enabled && spec.isFactoryDroid && spec.factoryHomeOverride !== undefined) {
          const isolatedFactorySkills = NodePath.join(
            spec.factoryHomeOverride,
            ".factory",
            "skills",
          );
          if (defaultFactorySkills.length > 0 && !(await pathExists(isolatedFactorySkills))) {
            pushDiagnostic({
              severity: "warning",
              code: "isolated_profile_missing_skills",
              message: `隔离实例 ${provider.displayName ?? provider.instanceId} 缺少 .factory/skills 目录`,
              detail: `${isolatedFactorySkills} 不存在（默认目录 ${defaultFactorySkillsDir} 含 ${defaultFactorySkills.length} 个技能）`,
            });
          }
          const isolatedAgentsSkills = NodePath.join(spec.factoryHomeOverride, ".agents", "skills");
          if (universalSkills.length > 0 && !(await pathExists(isolatedAgentsSkills))) {
            pushDiagnostic({
              severity: "info",
              code: "isolated_profile_no_universal_pool",
              message: `隔离实例 ${provider.displayName ?? provider.instanceId} 未联接真全局池 ~/.agents/skills`,
              detail: `设置了 FACTORY_HOME_OVERRIDE 后 Droid 会扫描 ${isolatedAgentsSkills} 而非 ${universalPoolDir}`,
            });
          }
        }

        // Diagnostic 3: Antigravity Windows junction inside config/skills without valid absolute skills.json entry
        if (provider.enabled && provider.driver === "antigravity" && platform === "win32") {
          for (const [skillName, diskSkill] of diskMap.entries()) {
            const runtimeEntry = runtimeMap.get(skillName);
            const isActiveRuntime = runtimeEntry !== undefined && runtimeEntry.enabled;
            if (isActiveRuntime) continue;
            if (diskSkill.fromSkillsJson && !diskSkill.manifestPathNonAbsolute) continue;
            if (diskSkill.linkTarget !== undefined) {
              pushDiagnostic({
                severity: "warning",
                code: "antigravity_junction_without_manifest",
                message: `Antigravity 实例 ${provider.displayName ?? provider.instanceId} 的技能 ${skillName} 通过目录联接挂载，Windows 扫描会跳过`,
                detail: `请在 ~/.gemini/config/skills.json 的 entries 中使用绝对路径指向其真实父目录（当前联接目标：${diskSkill.linkTarget}）`,
              });
            }
          }
        }
      }

      const skills: Array<SkillMatrixEntry> = [];
      for (const [skillName, meta] of allSkillMeta.entries()) {
        const isUniversal = universalSkillNames.has(skillName);
        const agentOwners = agentGlobalOwnerGroups.get(skillName);
        const builtinOwners = builtinOwnerGroups.get(skillName);

        const scope: SkillMatrixScope = isUniversal
          ? "universal"
          : agentOwners && agentOwners.size > 0
            ? "agent_global"
            : "builtin";

        const ownerGroupKeys =
          scope === "universal"
            ? null
            : scope === "agent_global"
              ? (agentOwners ?? new Set<string>())
              : (builtinOwners ?? new Set<string>());
        const ownerGroupLabels =
          ownerGroupKeys === null
            ? []
            : [...ownerGroupKeys]
                .map((key) => groupLabelByKey.get(key) ?? key)
                .toSorted((a, b) => a.localeCompare(b));

        const cells: Record<string, SkillMatrixCell> = {};
        let coveredEnabled = 0;
        let expectedEnabled = 0;

        for (const instance of instances) {
          const spec = specsByInstanceId.get(instance.instanceId)!;
          const runtimeEntry = runtimeSkillsByInstance.get(instance.instanceId)?.get(skillName);
          const diskEntry = diskSkillsByInstance.get(instance.instanceId)?.get(skillName);

          const isExpectedHere =
            scope === "universal" ||
            (ownerGroupKeys !== null && ownerGroupKeys.has(spec.driverGroupKey));

          let cell: SkillMatrixCell;
          if (runtimeEntry !== undefined && runtimeEntry.enabled) {
            cell = {
              status: "declared_runtime",
              path: runtimeEntry.path,
              ...(diskEntry?.sourceDir ? { sourceDir: diskEntry.sourceDir } : {}),
              ...(diskEntry?.linkTarget ? { linkTarget: diskEntry.linkTarget } : {}),
            };
          } else if (diskEntry !== undefined) {
            const hasWindowsAgyJunctionCaveat =
              instance.driver === "antigravity" &&
              platform === "win32" &&
              diskEntry.linkTarget !== undefined &&
              (!diskEntry.fromSkillsJson || diskEntry.manifestPathNonAbsolute === true);
            const hasNonAbsoluteManifest =
              instance.driver === "antigravity" && diskEntry.manifestPathNonAbsolute === true;
            const missingFrontmatter = !diskEntry.hasValidFrontmatter;

            if (hasNonAbsoluteManifest) {
              cell = {
                status: "disk_warning",
                path: diskEntry.skillMdPath,
                sourceDir: diskEntry.sourceDir,
                ...(diskEntry.linkTarget ? { linkTarget: diskEntry.linkTarget } : {}),
                reason: "skills.json 使用了 ~/ 路径，Windows 版 Antigravity 要求绝对路径",
              };
            } else if (hasWindowsAgyJunctionCaveat) {
              cell = {
                status: "disk_warning",
                path: diskEntry.skillMdPath,
                sourceDir: diskEntry.sourceDir,
                ...(diskEntry.linkTarget ? { linkTarget: diskEntry.linkTarget } : {}),
                reason: "Windows 目录联接会被 Antigravity 跳过，需通过 skills.json 绝对路径注册",
              };
            } else if (missingFrontmatter) {
              cell = {
                status: "disk_warning",
                path: diskEntry.skillMdPath,
                sourceDir: diskEntry.sourceDir,
                ...(diskEntry.linkTarget ? { linkTarget: diskEntry.linkTarget } : {}),
                reason: "SKILL.md 缺少合法 YAML frontmatter（name / description）",
              };
            } else {
              const reason =
                instance.driver === "antigravity" && diskEntry.fromSkillsJson
                  ? "已通过 skills.json 绝对路径注册（新建会话后生效）"
                  : `已位于扫描目录 ${diskEntry.sourceDir}（该驱动快照未上报技能列表）`;
              cell = {
                status: "declared_disk",
                path: diskEntry.skillMdPath,
                sourceDir: diskEntry.sourceDir,
                ...(diskEntry.linkTarget ? { linkTarget: diskEntry.linkTarget } : {}),
                reason,
              };
            }
          } else if (isExpectedHere) {
            const reason =
              scope === "universal" && !spec.readsUniversalPool
                ? `该实例不自动扫描 ~/.agents/skills，且未挂载到 ${spec.writableGlobalSkillDir}`
                : `未在 ${spec.dirs.join(" 或 ")} 中找到`;
            cell = {
              status: "missing",
              reason,
            };
          } else {
            cell = {
              status: "not_applicable",
              reason:
                ownerGroupLabels.length > 0
                  ? `仅归属 ${ownerGroupLabels.join(" / ")}，本驱动不适用`
                  : "其他驱动专属技能",
            };
          }

          cells[instance.instanceId] = cell;
          if (instance.enabled && isExpectedHere) {
            expectedEnabled += 1;
            if (cell.status === "declared_runtime" || cell.status === "declared_disk") {
              coveredEnabled += 1;
            }
          }
        }

        skills.push({
          name: skillName,
          ...(meta.description !== undefined ? { description: meta.description } : {}),
          scope,
          ownerGroupLabels,
          ...(meta.canonicalPath !== undefined ? { canonicalPath: meta.canonicalPath } : {}),
          coveredEnabledCount: NonNegativeInt.make(coveredEnabled),
          expectedEnabledCount: NonNegativeInt.make(expectedEnabled),
          cells,
        });
      }

      skills.sort((a, b) => {
        const scopeDiff = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
        if (scopeDiff !== 0) return scopeDiff;
        const missingA = a.expectedEnabledCount - a.coveredEnabledCount;
        const missingB = b.expectedEnabledCount - b.coveredEnabledCount;
        if (missingA !== missingB) return missingB - missingA;
        return a.name.localeCompare(b.name);
      });

      return {
        checkedAt,
        universalPoolDir,
        instances,
        skills,
        diagnostics,
      };
    },
    catch: (cause) =>
      new SkillsOverviewError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
});
