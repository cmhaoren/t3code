import { ProviderOptionDescriptor, type ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type LearnedModelOptionsBySlug = Readonly<
  Record<string, ReadonlyArray<ProviderOptionDescriptor>>
>;

const AcpLearnedModelOptionsFile = Schema.Struct({
  version: Schema.Literal(1),
  byFamily: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Array(ProviderOptionDescriptor)),
  ),
});

const decodeFile = Schema.decodeUnknownEffect(Schema.fromJsonString(AcpLearnedModelOptionsFile));
const encodeFile = Schema.encodeEffect(Schema.fromJsonString(AcpLearnedModelOptionsFile));

const STORE_FILENAME = "acp-model-options.json";

export function resolveAcpRegistryFamilyKey(settings: {
  readonly source?: string | undefined;
  readonly agentId?: string | undefined;
  readonly commandPath?: string | undefined;
}): string | null {
  if (settings.source === "local") {
    const normalized = settings.commandPath?.trim().replace(/\\/g, "/").toLowerCase();
    return normalized && normalized.length > 0 ? `local:${normalized}` : null;
  }
  const agentId = settings.agentId?.trim();
  return agentId && agentId.length > 0 ? `agent:${agentId}` : null;
}

export function extractLearnedModelOptions(
  models: ReadonlyArray<ServerProviderModel>,
): LearnedModelOptionsBySlug {
  const result: Record<string, ReadonlyArray<ProviderOptionDescriptor>> = {};
  for (const model of models) {
    if (model.isCustom) continue;
    const descriptors = model.capabilities?.optionDescriptors ?? [];
    if (descriptors.length === 0) continue;
    result[model.slug] = descriptors;
  }
  return result;
}

function mergeOptionDescriptorLists(
  existing: ReadonlyArray<ProviderOptionDescriptor>,
  incoming: ReadonlyArray<ProviderOptionDescriptor>,
  options?: { readonly preferIncoming?: boolean },
): ReadonlyArray<ProviderOptionDescriptor> {
  const preferIncoming = options?.preferIncoming ?? false;
  if (existing.length === 0) return incoming;
  if (incoming.length === 0) return existing;
  const byId = new Map<string, ProviderOptionDescriptor>();
  const order: Array<string> = [];
  const push = (descriptor: ProviderOptionDescriptor, overwrite: boolean) => {
    if (!byId.has(descriptor.id)) {
      order.push(descriptor.id);
      byId.set(descriptor.id, descriptor);
    } else if (overwrite) {
      byId.set(descriptor.id, descriptor);
    }
  };
  for (const descriptor of existing) push(descriptor, false);
  for (const descriptor of incoming) push(descriptor, preferIncoming);
  return order.map((id) => byId.get(id)!);
}

export function mergeLearnedModelOptionsMaps(
  existing: LearnedModelOptionsBySlug,
  incoming: LearnedModelOptionsBySlug,
  options?: { readonly preferIncoming?: boolean },
): LearnedModelOptionsBySlug {
  const next: Record<string, ReadonlyArray<ProviderOptionDescriptor>> = { ...existing };
  for (const [slug, incomingDescriptors] of Object.entries(incoming)) {
    if (incomingDescriptors.length === 0) continue;
    const prev = next[slug] ?? [];
    next[slug] = mergeOptionDescriptorLists(prev, incomingDescriptors, options);
  }
  return next;
}

function optionDescriptorEqual(
  left: ProviderOptionDescriptor,
  right: ProviderOptionDescriptor,
): boolean {
  if (
    left.id !== right.id ||
    left.label !== right.label ||
    left.description !== right.description ||
    left.type !== right.type
  ) {
    return false;
  }
  if (left.type === "boolean" && right.type === "boolean") {
    return left.currentValue === right.currentValue;
  }
  if (left.type !== "select" || right.type !== "select") {
    return false;
  }
  if (left.currentValue !== right.currentValue || left.role !== right.role) {
    return false;
  }
  const leftInjected = left.promptInjectedValues ?? [];
  const rightInjected = right.promptInjectedValues ?? [];
  if (
    leftInjected.length !== rightInjected.length ||
    !leftInjected.every((value, index) => value === rightInjected[index])
  ) {
    return false;
  }
  if (left.options.length !== right.options.length) {
    return false;
  }
  return left.options.every((option, index) => {
    const other = right.options[index];
    return (
      other !== undefined &&
      option.id === other.id &&
      option.label === other.label &&
      option.description === other.description &&
      option.isDefault === other.isDefault
    );
  });
}

function optionDescriptorListsEqual(
  left: ReadonlyArray<ProviderOptionDescriptor>,
  right: ReadonlyArray<ProviderOptionDescriptor>,
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return other !== undefined && optionDescriptorEqual(item, other);
    })
  );
}

function learnedModelOptionsMapsEqual(
  left: LearnedModelOptionsBySlug,
  right: LearnedModelOptionsBySlug,
): boolean {
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) {
    return false;
  }
  return leftKeys.every((key) => {
    const leftList = left[key];
    const rightList = right[key];
    return (
      leftList !== undefined &&
      rightList !== undefined &&
      optionDescriptorListsEqual(leftList, rightList)
    );
  });
}

export function applyLearnedModelOptionsToModels(
  models: ReadonlyArray<ServerProviderModel>,
  learnedBySlug: LearnedModelOptionsBySlug,
  options?: { readonly preferLearned?: boolean },
): ReadonlyArray<ServerProviderModel> {
  if (Object.keys(learnedBySlug).length === 0) return models;
  let changed = false;
  const next = models.map((model) => {
    if (model.isCustom) return model;
    const learned = learnedBySlug[model.slug];
    if (!learned || learned.length === 0) return model;
    const current = model.capabilities?.optionDescriptors ?? [];
    const merged = mergeOptionDescriptorLists(current, learned, {
      preferIncoming: options?.preferLearned ?? false,
    });
    if (optionDescriptorListsEqual(merged, current)) {
      return model;
    }
    changed = true;
    return {
      ...model,
      capabilities: createModelCapabilities({ optionDescriptors: merged }),
    };
  });
  return changed ? next : models;
}

const readStoreFile = Effect.fn("AcpModelOptionsStore.readStoreFile")(function* (cacheDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(cacheDir, STORE_FILENAME);
  const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
  if (!exists) {
    return { version: 1 as const, byFamily: {} };
  }
  const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => null));
  if (raw === null) {
    return { version: 1 as const, byFamily: {} };
  }
  return yield* decodeFile(raw).pipe(
    Effect.orElseSucceed(() => ({ version: 1 as const, byFamily: {} })),
  );
});

export const readFamilyModelOptions = Effect.fn("AcpModelOptionsStore.readFamilyModelOptions")(
  function* (input: { readonly cacheDir: string; readonly familyKey: string | null }) {
    if (!input.familyKey) {
      return {} as LearnedModelOptionsBySlug;
    }
    const store = yield* readStoreFile(input.cacheDir);
    return store.byFamily[input.familyKey] ?? {};
  },
);

export const mergeFamilyModelOptions = Effect.fn("AcpModelOptionsStore.mergeFamilyModelOptions")(
  function* (input: {
    readonly cacheDir: string;
    readonly familyKey: string | null;
    readonly updates: LearnedModelOptionsBySlug;
    readonly preferIncoming?: boolean;
  }) {
    if (!input.familyKey || Object.keys(input.updates).length === 0) {
      return {} as LearnedModelOptionsBySlug;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const store = yield* readStoreFile(input.cacheDir);
    const existing = store.byFamily[input.familyKey] ?? {};
    const merged = mergeLearnedModelOptionsMaps(
      existing,
      input.updates,
      input.preferIncoming === undefined ? undefined : { preferIncoming: input.preferIncoming },
    );
    if (learnedModelOptionsMapsEqual(merged, existing)) {
      return merged;
    }
    const nextStore = {
      version: 1 as const,
      byFamily: {
        ...store.byFamily,
        [input.familyKey]: merged,
      },
    };
    const encoded = yield* encodeFile(nextStore).pipe(Effect.orElseSucceed(() => null));
    if (encoded === null) {
      return merged;
    }
    const filePath = path.join(input.cacheDir, STORE_FILENAME);
    const nowMillis = yield* Clock.currentTimeMillis;
    const tempPath = `${filePath}.tmp-${nowMillis}`;
    yield* fs.makeDirectory(input.cacheDir, { recursive: true }).pipe(Effect.ignore);
    yield* fs.writeFileString(tempPath, encoded).pipe(
      Effect.andThen(fs.rename(tempPath, filePath)),
      Effect.catch(() => fs.remove(tempPath, { force: true }).pipe(Effect.ignore)),
    );
    return merged;
  },
);
