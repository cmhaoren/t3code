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
  readonly skillMdPath: string;
  readonly dirPath: string;
  readonly linkTarget?: string;
  readonly fromSkillsJson?: boolean;
}

interface InstanceSkillDirsInfo {
  readonly dirs: ReadonlyArray<string>;
  readonly manifestEntryDirs: ReadonlyArray<string>;
  readonly factoryHomeOverride?: string;
  readonly isFactoryDroid: boolean;
  readonly antigravityConfigSkillsDirs: ReadonlyArray<string>;
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
} {
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!match) return {};
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
  options?: { readonly fromSkillsJson?: boolean },
): Promise<ReadonlyArray<DiscoveredDiskSkill>> {
  let entries: ReadonlyArray<string>;
  try {
    entries = await NodeFSP.readdir(rootDir);
  } catch {
    return [];
  }
  const results: Array<DiscoveredDiskSkill> = [];
  for (const entryName of entries) {
    if (entryName.startsWith(".")) continue;
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
      skillMdPath,
      dirPath: entryPath,
      ...(linkTarget !== undefined ? { linkTarget } : {}),
      ...(options?.fromSkillsJson ? { fromSkillsJson: true } : {}),
    });
  }
  return results;
}

async function readAntigravitySkillsJsonEntries(
  skillsJsonPath: string,
  userHome: string,
): Promise<ReadonlyArray<string>> {
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
  const resolved: Array<string> = [];
  for (const entry of decoded.value.entries ?? []) {
    const trimmed = entry.path.trim();
    if (trimmed.length === 0) continue;
    resolved.push(NodePath.resolve(expandHome(trimmed, userHome)));
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

async function resolveInstanceSkillDirs(input: {
  readonly provider: ServerProvider;
  readonly settings: ServerSettings;
  readonly stateDir: string;
  readonly userHome: string;
}): Promise<InstanceSkillDirsInfo> {
  const { provider, settings, stateDir, userHome } = input;
  const dirs: Array<string> = [];
  const manifestEntryDirs: Array<string> = [];
  const antigravityConfigSkillsDirs: Array<string> = [];
  let factoryHomeOverride: string | undefined;
  let isFactoryDroid = false;

  const pushUnique = (list: Array<string>, dir: string) => {
    const normalized = NodePath.resolve(dir);
    if (!list.some((existing) => existing.toLowerCase() === normalized.toLowerCase())) {
      list.push(normalized);
    }
  };

  if (provider.driver === "antigravity") {
    const key = NodeCrypto.createHash("sha256").update(provider.instanceId).digest("hex");
    const profileDir = NodePath.join(stateDir, "providers", "antigravity", key);
    const profileSkillsDir = NodePath.join(profileDir, "config", "skills");
    const globalSkillsDir = NodePath.join(userHome, ".gemini", "config", "skills");
    pushUnique(dirs, profileSkillsDir);
    pushUnique(dirs, globalSkillsDir);
    pushUnique(antigravityConfigSkillsDirs, profileSkillsDir);
    pushUnique(antigravityConfigSkillsDirs, globalSkillsDir);

    const profileManifest = await readAntigravitySkillsJsonEntries(
      NodePath.join(profileDir, "config", "skills.json"),
      userHome,
    );
    const globalManifest = await readAntigravitySkillsJsonEntries(
      NodePath.join(userHome, ".gemini", "config", "skills.json"),
      userHome,
    );
    for (const entryDir of [...profileManifest, ...globalManifest]) {
      pushUnique(manifestEntryDirs, entryDir);
      pushUnique(dirs, entryDir);
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
      const factoryHome = factoryHomeOverride ?? userHome;
      pushUnique(dirs, NodePath.join(factoryHome, ".factory", "skills"));
    } else if (
      provider.instanceId.toLowerCase() === "dsh" ||
      meta.commandPath?.toLowerCase().includes("dsh") === true
    ) {
      pushUnique(dirs, NodePath.join(userHome, ".dsh", "skills"));
      pushUnique(dirs, NodePath.join(userHome, ".agents", "skills"));
    } else {
      pushUnique(dirs, NodePath.join(userHome, ".agents", "skills"));
    }
  } else if (provider.driver === "codex") {
    pushUnique(dirs, NodePath.join(userHome, ".codex", "skills"));
  } else if (provider.driver === "claudeAgent") {
    pushUnique(dirs, NodePath.join(userHome, ".claude", "skills"));
  } else if (provider.driver === "cursor") {
    pushUnique(dirs, NodePath.join(userHome, ".cursor", "skills"));
  } else if (provider.driver === "opencode") {
    pushUnique(dirs, NodePath.join(userHome, ".config", "opencode", "skills"));
  } else if (provider.driver === "pi") {
    pushUnique(dirs, NodePath.join(userHome, ".pi", "agent", "skills"));
  } else {
    pushUnique(dirs, NodePath.join(userHome, ".agents", "skills"));
  }

  return {
    dirs,
    manifestEntryDirs,
    ...(factoryHomeOverride !== undefined ? { factoryHomeOverride } : {}),
    isFactoryDroid,
    antigravityConfigSkillsDirs,
  };
}

function runtimeSkillsForProvider(
  provider: ServerProvider,
  cwd?: string,
): ReadonlyArray<{ readonly skill: ServerProviderSkill; readonly fromWorkspace: boolean }> {
  const byName = new Map<
    string,
    { readonly skill: ServerProviderSkill; readonly fromWorkspace: boolean }
  >();
  for (const skill of provider.skills) {
    byName.set(skill.name, { skill, fromWorkspace: false });
  }
  if (cwd) {
    const normalizedCwd = NodePath.resolve(cwd).toLowerCase();
    const workspace = provider.workspaceSnapshots?.find(
      (snapshot) => NodePath.resolve(snapshot.cwd).toLowerCase() === normalizedCwd,
    );
    for (const skill of workspace?.skills ?? []) {
      if (!byName.has(skill.name)) {
        byName.set(skill.name, { skill, fromWorkspace: true });
      }
    }
  }
  return [...byName.values()];
}

function isPathInside(candidatePath: string, rootDir: string): boolean {
  const normalizedCandidate = NodePath.resolve(candidatePath).toLowerCase();
  const normalizedRoot = NodePath.resolve(rootDir).toLowerCase();
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${NodePath.sep}`)
  );
}

const SCOPE_ORDER: Readonly<Record<SkillMatrixScope, number>> = {
  global: 0,
  workspace: 1,
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

      // Diagnostic 1: Windows PATH entries mixing forward/back slashes (e.g. ego-browser installer bug)
      if (platform === "win32" && envPath) {
        const seenBad = new Set<string>();
        for (const rawEntry of envPath.split(";")) {
          const entry = rawEntry.trim();
          if (entry.length === 0) continue;
          if (entry.includes("/") && entry.includes("\\") && !seenBad.has(entry)) {
            seenBad.add(entry);
            diagnostics.push({
              severity: "warning",
              code: "path_mixed_slashes",
              message: "环境变量 PATH 中存在正反斜杠混用路径，可能导致 CLI 技能命令无法识别",
              detail: entry,
            });
          }
        }
      }

      // Scan universal ~/.agents/skills pool
      const universalPoolDir = NodePath.join(userHome, ".agents", "skills");
      const universalSkills = await scanSkillsDirectory(universalPoolDir);

      // Scan default ~/.factory/skills once for Factory isolated profile diagnostic
      const defaultFactorySkillsDir = NodePath.join(userHome, ".factory", "skills");
      const defaultFactorySkills = await scanSkillsDirectory(defaultFactorySkillsDir);

      const instances: Array<SkillMatrixInstance> = [];
      const diskSkillsByInstance = new Map<string, Map<string, DiscoveredDiskSkill>>();
      const runtimeSkillsByInstance = new Map<
        string,
        Map<string, { readonly skill: ServerProviderSkill; readonly fromWorkspace: boolean }>
      >();
      const instanceDirInfoById = new Map<string, InstanceSkillDirsInfo>();

      const allGlobalSkillNames = new Set<string>(universalSkills.map((skill) => skill.name));
      const allSkillMeta = new Map<
        string,
        { description?: string; canonicalPath?: string; fromWorkspace?: boolean }
      >();

      for (const skill of universalSkills) {
        allSkillMeta.set(skill.name, {
          ...(skill.description ? { description: skill.description } : {}),
          canonicalPath: skill.linkTarget ?? skill.dirPath,
        });
      }

      const sortedProviders = [...input.providers].toSorted((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return (a.displayName ?? a.instanceId).localeCompare(b.displayName ?? b.instanceId);
      });

      for (const provider of sortedProviders) {
        const dirInfo = await resolveInstanceSkillDirs({
          provider,
          settings: input.settings,
          stateDir: input.stateDir,
          userHome,
        });
        instanceDirInfoById.set(provider.instanceId, dirInfo);

        instances.push({
          instanceId: provider.instanceId,
          driver: provider.driver,
          displayName: provider.displayName?.trim() || provider.instanceId,
          enabled: provider.enabled,
          installed: provider.installed,
          status: provider.status,
          globalSkillDirs: [...dirInfo.dirs],
        });

        const diskMap = new Map<string, DiscoveredDiskSkill>();
        const manifestDirSet = new Set(dirInfo.manifestEntryDirs.map((dir) => dir.toLowerCase()));
        for (const dir of dirInfo.dirs) {
          const fromSkillsJson = manifestDirSet.has(dir.toLowerCase());
          const scanned = await scanSkillsDirectory(dir, { fromSkillsJson });
          for (const skill of scanned) {
            allGlobalSkillNames.add(skill.name);
            const existing = diskMap.get(skill.name);
            // Prefer entries coming from explicit skills.json over bare junctions
            if (!existing || (!existing.fromSkillsJson && skill.fromSkillsJson)) {
              diskMap.set(skill.name, skill);
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

        const runtimeList = runtimeSkillsForProvider(provider, input.cwd);
        const runtimeMap = new Map<
          string,
          { readonly skill: ServerProviderSkill; readonly fromWorkspace: boolean }
        >();
        for (const item of runtimeList) {
          runtimeMap.set(item.skill.name, item);
          const meta = allSkillMeta.get(item.skill.name) ?? {};
          if (!meta.description && item.skill.description) {
            meta.description = item.skill.description;
          }
          if (!meta.canonicalPath && item.skill.path) {
            meta.canonicalPath = item.skill.path;
          }
          if (item.fromWorkspace && input.cwd && isPathInside(item.skill.path, input.cwd)) {
            meta.fromWorkspace = true;
          }
          allSkillMeta.set(item.skill.name, meta);
        }
        runtimeSkillsByInstance.set(provider.instanceId, runtimeMap);

        // Diagnostic 2: Factory Droid isolated profile missing .factory/skills
        if (
          provider.enabled &&
          dirInfo.isFactoryDroid &&
          dirInfo.factoryHomeOverride !== undefined &&
          defaultFactorySkills.length > 0
        ) {
          const isolatedSkillsDir = NodePath.join(
            dirInfo.factoryHomeOverride,
            ".factory",
            "skills",
          );
          if (!(await pathExists(isolatedSkillsDir))) {
            diagnostics.push({
              severity: "warning",
              code: "isolated_profile_missing_skills",
              message: `隔离实例 ${provider.displayName ?? provider.instanceId} 缺少全局技能目录`,
              detail: `${isolatedSkillsDir} 不存在（默认目录 ${defaultFactorySkillsDir} 含 ${defaultFactorySkills.length} 个技能）`,
            });
          }
        }

        // Diagnostic 3: Antigravity junction inside config/skills without skills.json entry
        if (provider.enabled && provider.driver === "antigravity") {
          for (const [skillName, diskSkill] of diskMap.entries()) {
            const runtimeEntry = runtimeMap.get(skillName);
            const isActiveRuntime = runtimeEntry !== undefined && runtimeEntry.skill.enabled;
            if (isActiveRuntime || diskSkill.fromSkillsJson) continue;
            if (diskSkill.linkTarget !== undefined) {
              diagnostics.push({
                severity: "warning",
                code: "antigravity_junction_without_manifest",
                message: `Antigravity 实例 ${provider.displayName ?? provider.instanceId} 的技能 ${skillName} 通过目录联接挂载，可能未被加载`,
                detail: `建议在 ~/.gemini/config/skills.json 的 entries 中显式指向其真实父目录（当前联接目标：${diskSkill.linkTarget}）`,
              });
            }
          }
        }
      }

      const enabledInstanceIds = instances
        .filter((instance) => instance.enabled)
        .map((instance) => instance.instanceId);
      const totalEnabledCount = NonNegativeInt.make(enabledInstanceIds.length);

      const skills: Array<SkillMatrixEntry> = [];
      for (const [skillName, meta] of allSkillMeta.entries()) {
        const scope: SkillMatrixScope = allGlobalSkillNames.has(skillName)
          ? "global"
          : meta.fromWorkspace
            ? "workspace"
            : "builtin";

        const cells: Record<string, SkillMatrixCell> = {};
        let coveredEnabled = 0;

        for (const instance of instances) {
          const runtimeEntry = runtimeSkillsByInstance.get(instance.instanceId)?.get(skillName);
          const diskEntry = diskSkillsByInstance.get(instance.instanceId)?.get(skillName);
          const dirInfo = instanceDirInfoById.get(instance.instanceId);

          let cell: SkillMatrixCell;
          if (runtimeEntry !== undefined && runtimeEntry.skill.enabled) {
            cell = {
              status: "active",
              path: runtimeEntry.skill.path,
              ...(diskEntry?.linkTarget !== undefined ? { linkTarget: diskEntry.linkTarget } : {}),
            };
          } else if (diskEntry !== undefined) {
            let reason: string;
            if (instance.driver === "antigravity" && diskEntry.fromSkillsJson) {
              reason = "已通过 skills.json 显式注册（重启或新建会话后在运行态生效）";
            } else if (instance.driver === "antigravity" && diskEntry.linkTarget !== undefined) {
              reason = "通过目录联接挂载，建议在 skills.json 中声明以确保 Antigravity 加载";
            } else if (instance.driver === "acpRegistry") {
              reason = "磁盘目录存在（该驱动未在状态快照中上报技能列表）";
            } else {
              reason = "磁盘目录存在（未在当前运行态快照中上报）";
            }
            cell = {
              status: "disk_only",
              path: diskEntry.skillMdPath,
              ...(diskEntry.linkTarget !== undefined ? { linkTarget: diskEntry.linkTarget } : {}),
              reason,
            };
          } else if (scope === "global") {
            const expectedDir = dirInfo?.dirs[0];
            cell = {
              status: "missing",
              ...(expectedDir !== undefined ? { reason: `未在 ${expectedDir} 中找到` } : {}),
            };
          } else {
            cell = {
              status: "not_applicable",
              reason: "其他驱动或工作区私有技能",
            };
          }

          cells[instance.instanceId] = cell;
          if (instance.enabled && (cell.status === "active" || cell.status === "disk_only")) {
            coveredEnabled += 1;
          }
        }

        skills.push({
          name: skillName,
          ...(meta.description !== undefined ? { description: meta.description } : {}),
          scope,
          ...(meta.canonicalPath !== undefined ? { canonicalPath: meta.canonicalPath } : {}),
          coveredEnabledCount: NonNegativeInt.make(coveredEnabled),
          totalEnabledCount,
          cells,
        });
      }

      skills.sort((a, b) => {
        const scopeDiff = SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope];
        if (scopeDiff !== 0) return scopeDiff;
        if (a.scope === "global") {
          const missingA = a.totalEnabledCount - a.coveredEnabledCount;
          const missingB = b.totalEnabledCount - b.coveredEnabledCount;
          if (missingA !== missingB) return missingB - missingA;
        }
        return a.name.localeCompare(b.name);
      });

      return {
        checkedAt,
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
