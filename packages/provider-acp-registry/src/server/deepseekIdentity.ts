import type { AcpRegistrySettings } from "../settings.ts";

const DSH_BINARY_NAME = /^dsh(?:\.cmd|\.exe)?$/iu;
const DSH_DESKTOP_EXE_NAME = /^deepseek harness(?:\.exe)?$/iu;
const DSH_ENTRYPOINT_ARG = /(?:^|[\\/])@deepseek-ai[\\/]dsh(?:-desktop-host)?[\\/]/iu;
const DSH_REGISTRY_AGENT_ID = /^(?:deepseek-harness|dsh)$/iu;

function executableBasename(command: string): string {
  return command.trim().split(/[\\/]/u).pop() ?? "";
}

/**
 * Identify DeepSeek Harness (`dsh` CLI or unwrapped Electron-as-Node
 * `DeepSeek Harness.exe` + `@deepseek-ai/dsh-desktop-host` CLI entrypoint).
 */
export function isDeepSeekHarnessCommand(
  commandPath: string,
  resolvedCommand?: string,
  args?: ReadonlyArray<string>,
): boolean {
  for (const candidate of [commandPath, resolvedCommand]) {
    if (!candidate) continue;
    const base = executableBasename(candidate);
    if (DSH_BINARY_NAME.test(base)) return true;
    if (
      DSH_DESKTOP_EXE_NAME.test(base) &&
      (args?.some((arg) => DSH_ENTRYPOINT_ARG.test(arg)) ?? false)
    ) {
      return true;
    }
  }
  return args?.some((arg) => DSH_ENTRYPOINT_ARG.test(arg)) ?? false;
}

/** Identify an ACP Registry configuration targeting DeepSeek Harness. */
export function isDeepSeekHarnessInstance(
  settings: Pick<AcpRegistrySettings, "source" | "agentId" | "commandPath" | "commandArgs">,
): boolean {
  if (settings.source === "local") {
    return isDeepSeekHarnessCommand(settings.commandPath, undefined, settings.commandArgs);
  }
  return DSH_REGISTRY_AGENT_ID.test(settings.agentId.trim());
}
