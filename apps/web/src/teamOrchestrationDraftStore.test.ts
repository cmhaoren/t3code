import { describe, expect, it } from "vite-plus/test";
import { getBuiltInTeamOrchestrationPresets } from "@t3tools/shared/teamOrchestration";
import {
  resolveDraftTeamOrchestrationConfig,
  teamOrchestrationDraftKey,
  useTeamOrchestrationDraftStore,
} from "./teamOrchestrationDraftStore";

describe("teamOrchestrationDraftStore", () => {
  it("falls back to default server preset until the draft explicitly overrides it", () => {
    const draftId = "draft-test-1";
    const draftKey = teamOrchestrationDraftKey(draftId)!;
    useTeamOrchestrationDraftStore.getState().clearDraftConfig(draftKey);

    const serverSettings = {
      teamOrchestrationPresets: [],
      defaultTeamOrchestrationPresetId: "builtin-deep-craft",
    };

    const inherited = resolveDraftTeamOrchestrationConfig(draftId, serverSettings);
    expect(inherited?.enabled).toBe(true);
    expect(inherited?.presetId).toBe("builtin-deep-craft");
    expect(inherited?.commanderMode).toBe("grill");

    const custom = {
      ...getBuiltInTeamOrchestrationPresets()[1]!.config,
      enabled: false,
    };
    useTeamOrchestrationDraftStore.getState().setDraftConfig(draftKey, custom);

    const overridden = resolveDraftTeamOrchestrationConfig(draftId, serverSettings);
    expect(overridden?.enabled).toBe(false);
    expect(overridden?.commanderMode).toBe("autonomous");

    useTeamOrchestrationDraftStore.getState().clearDraftConfig(draftKey);
    const restored = resolveDraftTeamOrchestrationConfig(draftId, serverSettings);
    expect(restored?.presetId).toBe("builtin-deep-craft");
  });
});
