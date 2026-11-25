import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import {
  OrchestrationCardsError,
  type OrchestrationCardsListResult,
  type TeamNormCard,
  type TeamNormCardId,
  type TeamNormCardScope,
} from "@t3tools/contracts";
import {
  BUILTIN_TEAM_NORM_CARD_MAP,
  BUILTIN_TEAM_NORM_CARDS,
  createDefaultTeamNormCards,
} from "@t3tools/shared/teamOrchestration";
import * as ServerConfig from "../config.ts";

function resolveUserCardsDir(path: Path.Path, stateDir: string): string {
  return path.join(stateDir, "orchestration", "cards");
}

function resolveProjectCardsDir(
  path: Path.Path,
  projectWorkspaceRoot: string | null | undefined,
): string | null {
  if (!projectWorkspaceRoot || projectWorkspaceRoot.trim().length === 0) {
    return null;
  }
  return path.join(projectWorkspaceRoot, ".t3", "orchestration", "cards");
}

function cardFilePath(path: Path.Path, dir: string, cardId: TeamNormCardId): string {
  // cardId is schema-validated against TEAM_NORM_CARD_IDS; double-check map membership for defense in depth.
  if (!(cardId in BUILTIN_TEAM_NORM_CARD_MAP)) {
    throw new Error(`Unknown team norm card id: ${String(cardId)}`);
  }
  return path.join(dir, `${cardId}.md`);
}

interface StoredCardFile {
  readonly content: string;
  readonly filePath: string;
  readonly updatedAt: string | null;
}

const readStoredCardFile = Effect.fn("TeamNormCardStore.readStoredCardFile")(function* (
  filePath: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return null;
  }
  const content = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));
  if (content === null) {
    return null;
  }
  const stat = yield* fs.stat(filePath).pipe(Effect.orElseSucceed(() => null));
  const mtime = stat?.mtime;
  const updatedAt =
    mtime && mtime._tag === "Some"
      ? DateTime.formatIso(DateTime.fromDateUnsafe(mtime.value))
      : null;
  return {
    content,
    filePath,
    updatedAt,
  } satisfies StoredCardFile;
});

const resolveCard = Effect.fn("TeamNormCardStore.resolveCard")(function* (input: {
  readonly cardId: TeamNormCardId;
  readonly userCardsDir: string;
  readonly projectCardsDir: string | null;
}) {
  const path = yield* Path.Path;
  const def = BUILTIN_TEAM_NORM_CARD_MAP[input.cardId];
  if (input.projectCardsDir !== null) {
    const projectFile = yield* readStoredCardFile(
      cardFilePath(path, input.projectCardsDir, input.cardId),
    );
    if (projectFile !== null) {
      return {
        id: def.id,
        category: def.category,
        title: def.title,
        description: def.description,
        content: projectFile.content,
        defaultContent: def.defaultContent,
        source: "project" as const,
        filePath: projectFile.filePath,
        updatedAt: projectFile.updatedAt,
      } satisfies TeamNormCard;
    }
  }
  const userFile = yield* readStoredCardFile(cardFilePath(path, input.userCardsDir, input.cardId));
  if (userFile !== null) {
    return {
      id: def.id,
      category: def.category,
      title: def.title,
      description: def.description,
      content: userFile.content,
      defaultContent: def.defaultContent,
      source: "user" as const,
      filePath: userFile.filePath,
      updatedAt: userFile.updatedAt,
    } satisfies TeamNormCard;
  }
  return {
    id: def.id,
    category: def.category,
    title: def.title,
    description: def.description,
    content: def.defaultContent,
    defaultContent: def.defaultContent,
    source: "builtin" as const,
    filePath: null,
    updatedAt: null,
  } satisfies TeamNormCard;
});

export const listTeamNormCards = Effect.fn("TeamNormCardStore.listTeamNormCards")(
  function* (input?: { readonly projectWorkspaceRoot?: string | null }) {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const userCardsDir = resolveUserCardsDir(path, config.stateDir);
    const projectCardsDir = resolveProjectCardsDir(path, input?.projectWorkspaceRoot);
    const cards = yield* Effect.forEach(BUILTIN_TEAM_NORM_CARDS, (def) =>
      resolveCard({
        cardId: def.id,
        userCardsDir,
        projectCardsDir,
      }),
    );
    return {
      cards,
      userCardsDir,
      projectCardsDir,
    } satisfies OrchestrationCardsListResult;
  },
);

export const loadEffectiveTeamNormCards = Effect.fn("TeamNormCardStore.loadEffectiveTeamNormCards")(
  function* (input?: { readonly projectWorkspaceRoot?: string | null }) {
    const result = yield* listTeamNormCards(input);
    return result.cards;
  },
);

export const loadEffectiveTeamNormCardsOptional = Effect.fn(
  "TeamNormCardStore.loadEffectiveTeamNormCardsOptional",
)(function* (input?: { readonly projectWorkspaceRoot?: string | null }) {
  const [serverConfig, fs, path] = yield* Effect.all([
    Effect.serviceOption(ServerConfig.ServerConfig),
    Effect.serviceOption(FileSystem.FileSystem),
    Effect.serviceOption(Path.Path),
  ]);
  if (Option.isNone(serverConfig) || Option.isNone(fs) || Option.isNone(path)) {
    return createDefaultTeamNormCards();
  }
  return yield* loadEffectiveTeamNormCards(input).pipe(
    Effect.provideService(ServerConfig.ServerConfig, serverConfig.value),
    Effect.provideService(FileSystem.FileSystem, fs.value),
    Effect.provideService(Path.Path, path.value),
    Effect.orElseSucceed(() => createDefaultTeamNormCards()),
  );
});

export const saveTeamNormCard = Effect.fn("TeamNormCardStore.saveTeamNormCard")(function* (input: {
  readonly cardId: TeamNormCardId;
  readonly content: string;
  readonly scope?: TeamNormCardScope;
  readonly projectWorkspaceRoot?: string | null;
}) {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const userCardsDir = resolveUserCardsDir(path, config.stateDir);
  const projectCardsDir = resolveProjectCardsDir(path, input.projectWorkspaceRoot);
  const scope = input.scope ?? "user";
  const targetDir = scope === "project" ? projectCardsDir : userCardsDir;
  if (targetDir === null) {
    return yield* new OrchestrationCardsError({
      message: "Project scope requires a valid project workspace.",
    });
  }
  const targetPath = cardFilePath(path, targetDir, input.cardId);
  const nowMillis = yield* Clock.currentTimeMillis;
  const tempPath = `${targetPath}.tmp-${nowMillis}`;
  yield* fs.makeDirectory(targetDir, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new OrchestrationCardsError({
          message: `Failed to create norm cards directory: ${String(cause)}`,
        }),
    ),
  );
  const normalized = input.content.replace(/\r\n/g, "\n");
  yield* fs.writeFileString(tempPath, normalized).pipe(
    Effect.andThen(fs.rename(tempPath, targetPath)),
    Effect.catch((cause) =>
      fs.remove(tempPath, { force: true }).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.fail(
            new OrchestrationCardsError({
              message: `Failed to write norm card ${input.cardId}: ${String(cause)}`,
            }),
          ),
        ),
      ),
    ),
  );
  return yield* resolveCard({
    cardId: input.cardId,
    userCardsDir,
    projectCardsDir,
  });
});

export const resetTeamNormCard = Effect.fn("TeamNormCardStore.resetTeamNormCard")(
  function* (input: {
    readonly cardId: TeamNormCardId;
    readonly scope?: TeamNormCardScope;
    readonly projectWorkspaceRoot?: string | null;
  }) {
    const config = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const userCardsDir = resolveUserCardsDir(path, config.stateDir);
    const projectCardsDir = resolveProjectCardsDir(path, input.projectWorkspaceRoot);
    const scope = input.scope ?? "user";
    const targetDir = scope === "project" ? projectCardsDir : userCardsDir;
    if (targetDir === null) {
      return yield* new OrchestrationCardsError({
        message: "Project scope requires a valid project workspace.",
      });
    }
    const targetPath = cardFilePath(path, targetDir, input.cardId);
    yield* fs.remove(targetPath, { force: true }).pipe(
      Effect.mapError(
        (cause) =>
          new OrchestrationCardsError({
            message: `Failed to reset norm card ${input.cardId}: ${String(cause)}`,
          }),
      ),
    );
    return yield* resolveCard({
      cardId: input.cardId,
      userCardsDir,
      projectCardsDir,
    });
  },
);
