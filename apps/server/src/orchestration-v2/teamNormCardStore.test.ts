import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";
import * as ServerConfig from "../config.ts";
import { listTeamNormCards, resetTeamNormCard, saveTeamNormCard } from "./teamNormCardStore.ts";

describe("teamNormCardStore", () => {
  it.effect("lists built-in cards, overlays user and project overrides, and resets cleanly", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const projectDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-norm-project-" });

      const initial = yield* listTeamNormCards({ projectWorkspaceRoot: projectDir });
      expect(initial.cards.length).toBeGreaterThanOrEqual(20);
      const grillInitial = initial.cards.find((card) => card.id === "commander.grill");
      expect(grillInitial?.source).toBe("builtin");
      expect(grillInitial?.filePath).toBeNull();

      const savedUser = yield* saveTeamNormCard({
        cardId: "commander.grill",
        content: "- 用户级 Grill 自定义规范",
        scope: "user",
        projectWorkspaceRoot: projectDir,
      });
      expect(savedUser.source).toBe("user");
      expect(savedUser.content).toBe("- 用户级 Grill 自定义规范");
      expect(savedUser.filePath).toContain("commander.grill.md");

      const savedProject = yield* saveTeamNormCard({
        cardId: "commander.grill",
        content: "- 项目级 Grill 覆盖规范",
        scope: "project",
        projectWorkspaceRoot: projectDir,
      });
      expect(savedProject.source).toBe("project");
      expect(savedProject.content).toBe("- 项目级 Grill 覆盖规范");

      const resetProject = yield* resetTeamNormCard({
        cardId: "commander.grill",
        scope: "project",
        projectWorkspaceRoot: projectDir,
      });
      expect(resetProject.source).toBe("user");
      expect(resetProject.content).toBe("- 用户级 Grill 自定义规范");

      const resetUser = yield* resetTeamNormCard({
        cardId: "commander.grill",
        scope: "user",
        projectWorkspaceRoot: projectDir,
      });
      expect(resetUser.source).toBe("builtin");
      expect(resetUser.content).toBe(resetUser.defaultContent);
    }).pipe(
      Effect.provide(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-norm-store-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
