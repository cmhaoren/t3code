import type { ServerSettings, TeamOrchestrationConfig } from "@t3tools/contracts";
import { getBuiltInTeamOrchestrationPresets } from "@t3tools/shared/teamOrchestration";
import { create } from "zustand";

interface TeamOrchestrationDraftStoreState {
  readonly byDraftKey: Readonly<Record<string, TeamOrchestrationConfig | null>>;
  readonly setDraftConfig: (draftKey: string, config: TeamOrchestrationConfig | null) => void;
  readonly clearDraftConfig: (draftKey: string) => void;
}

export const useTeamOrchestrationDraftStore = create<TeamOrchestrationDraftStoreState>((set) => ({
  byDraftKey: {},
  setDraftConfig: (draftKey, config) =>
    set((state) => ({
      byDraftKey: {
        ...state.byDraftKey,
        [draftKey]: config,
      },
    })),
  clearDraftConfig: (draftKey) =>
    set((state) => {
      if (!(draftKey in state.byDraftKey)) {
        return state;
      }
      const next = { ...state.byDraftKey };
      delete next[draftKey];
      return { byDraftKey: next };
    }),
}));

export function teamOrchestrationDraftKey(draftId: string | null): string | null {
  return draftId ? `draft:${draftId}` : null;
}

function resolveDefaultPresetConfig(
  serverSettings:
    | Pick<ServerSettings, "teamOrchestrationPresets" | "defaultTeamOrchestrationPresetId">
    | null
    | undefined,
): TeamOrchestrationConfig | null {
  const defaultId = serverSettings?.defaultTeamOrchestrationPresetId;
  if (!defaultId) {
    return null;
  }
  const presets = [
    ...getBuiltInTeamOrchestrationPresets(),
    ...(serverSettings?.teamOrchestrationPresets ?? []),
  ];
  const preset = presets.find((candidate) => candidate.id === defaultId);
  if (!preset) {
    return null;
  }
  return {
    ...preset.config,
    enabled: true,
    presetId: preset.id,
  };
}

export function resolveDraftTeamOrchestrationConfig(
  draftId: string | null,
  serverSettings:
    | Pick<ServerSettings, "teamOrchestrationPresets" | "defaultTeamOrchestrationPresetId">
    | null
    | undefined,
  byDraftKey: Readonly<
    Record<string, TeamOrchestrationConfig | null>
  > = useTeamOrchestrationDraftStore.getState().byDraftKey,
): TeamOrchestrationConfig | null {
  const key = teamOrchestrationDraftKey(draftId);
  if (key && Object.hasOwn(byDraftKey, key)) {
    return byDraftKey[key] ?? null;
  }
  return resolveDefaultPresetConfig(serverSettings);
}
