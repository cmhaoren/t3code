import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { ProviderOptionDescriptor, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { describe, expect } from "vite-plus/test";
import {
  applyLearnedModelOptionsToModels,
  mergeFamilyModelOptions,
  readFamilyModelOptions,
  resolveAcpRegistryFamilyKey,
} from "./modelOptionsStore.ts";

const REASONING_OPTION: ProviderOptionDescriptor = {
  id: "reasoning_effort",
  label: "Reasoning Effort",
  type: "select",
  options: [
    { id: "off", label: "Off" },
    { id: "high", label: "High" },
    { id: "max", label: "Max" },
  ],
  currentValue: "high",
  role: "reasoning",
};

const AUTONOMY_OPTION: ProviderOptionDescriptor = {
  id: "autonomy_level",
  label: "Autonomy Level",
  type: "select",
  options: [{ id: "auto-low", label: "Auto (Low)" }],
  currentValue: "auto-low",
};

describe("modelOptionsStore", () => {
  it("computes shared family keys for sibling registry and local instances", () => {
    expect(resolveAcpRegistryFamilyKey({ source: "registry", agentId: "factory-droid" })).toBe(
      "agent:factory-droid",
    );
    expect(
      resolveAcpRegistryFamilyKey({
        source: "local",
        commandPath: "C:\\Program Files\\DSH\\dsh.exe",
      }),
    ).toBe("local:c:/program files/dsh/dsh.exe");
  });

  it.effect("persists learned model options across restarts and merges across sibling models", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cacheDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-acp-model-opts-" });
      const familyKey = "agent:factory-droid";

      yield* mergeFamilyModelOptions({
        cacheDir,
        familyKey,
        updates: {
          "custom:qwen": [AUTONOMY_OPTION, REASONING_OPTION],
        },
      });

      const reloaded = yield* readFamilyModelOptions({ cacheDir, familyKey });
      expect(reloaded["custom:qwen"]?.map((item) => item.id)).toEqual([
        "autonomy_level",
        "reasoning_effort",
      ]);

      const siblingModels: ReadonlyArray<ServerProviderModel> = [
        {
          slug: "custom:qwen",
          name: "Qwen",
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [AUTONOMY_OPTION] }),
        },
        {
          slug: "other",
          name: "Other",
          isCustom: false,
          capabilities: createModelCapabilities({ optionDescriptors: [] }),
        },
      ];

      const merged = applyLearnedModelOptionsToModels(siblingModels, reloaded);
      expect(merged[0]?.capabilities?.optionDescriptors?.map((item) => item.id)).toEqual([
        "autonomy_level",
        "reasoning_effort",
      ]);
      expect(merged[1]?.capabilities?.optionDescriptors).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
