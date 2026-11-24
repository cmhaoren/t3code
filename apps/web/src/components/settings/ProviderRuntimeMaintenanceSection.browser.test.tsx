import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEntry,
  type ProviderRuntimeInstalledVersion,
  type ProviderRuntimeInventory,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render, type Screen } from "../../../test/render";

const state = vi.hoisted(() => ({
  listProviderRuntimes: vi.fn(),
  checkProviderRuntimeUpdates: vi.fn(),
  updateProviderRuntime: vi.fn(),
  pruneProviderRuntimeVersions: vi.fn(),
  confirm: vi.fn<() => Promise<boolean>>(),
}));

vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      listProviderRuntimes: { label: "provider-runtime:list" } as never,
      checkProviderRuntimeUpdates: { label: "provider-runtime:check" } as never,
      updateProviderRuntime: { label: "provider-runtime:update" } as never,
      pruneProviderRuntimeVersions: { label: "provider-runtime:prune" } as never,
    } as never,
  };
});
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: ((command: { label?: string }) =>
    ({
      "provider-runtime:list": state.listProviderRuntimes,
      "provider-runtime:check": state.checkProviderRuntimeUpdates,
      "provider-runtime:update": state.updateProviderRuntime,
      "provider-runtime:prune": state.pruneProviderRuntimeVersions,
    })[command.label ?? ""]) as never,
}));
vi.mock(import("~/localApi"), async (original) => ({
  ...(await original()),
  ensureLocalApi: (() => ({ dialogs: { confirm: state.confirm } })) as never,
}));
vi.mock(import("./settingsLayout"), () => ({
  SettingsSection: (({
    title,
    headerAction,
    children,
  }: {
    title: string;
    headerAction?: ReactNode;
    children?: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  )) as never,
  SettingsRow: (({
    title,
    description,
    control,
    children,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
    children?: ReactNode;
  }) => (
    <div data-slot="settings-row">
      <div>{title}</div>
      {description ? <p>{description}</p> : null}
      {control}
      {children}
    </div>
  )) as never,
}));
vi.mock(import("../chat/ProviderInstanceIcon"), () => ({
  ProviderInstanceIcon: (() => null) as never,
}));

import { ProviderRuntimeMaintenanceSection } from "./ProviderRuntimeMaintenanceSection";

const environmentId = EnvironmentId.make("remote-device");
const MB = 1_024 * 1_024;

function installedVersion(
  runtimeId: string,
  version: string,
  sizeBytes: number,
  isActive: boolean,
): ProviderRuntimeInstalledVersion {
  return {
    version,
    id: `${runtimeId}:${version}`,
    sizeBytes,
    isActive,
    installedAt: "2026-11-01T00:00:00.000Z",
    path: `/managed/${runtimeId}/${version}`,
  };
}

function factoryDroid(overrides: Partial<ProviderRuntimeEntry> = {}): ProviderRuntimeEntry {
  return {
    runtimeId: "factory-droid",
    displayName: "Factory Droid",
    driver: ProviderDriverKind.make("acpRegistry"),
    kind: "acpRegistry",
    agentId: "factory-droid",
    usedByInstanceIds: [
      ProviderInstanceId.make("W1"),
      ProviderInstanceId.make("W2"),
      ProviderInstanceId.make("W3"),
    ],
    activeVersion: "1.18.0",
    latestVersion: "1.18.0",
    updateAvailable: false,
    canCheckUpdate: true,
    canUpdate: true,
    canSwitchVersion: true,
    canPrune: true,
    updateCommand: null,
    note: null,
    totalSizeBytes: 1_792 * MB,
    reclaimableBytes: 768 * MB,
    versions: [
      installedVersion("factory-droid", "1.18.0", 1_024 * MB, true),
      installedVersion("factory-droid", "1.17.2", 512 * MB, false),
      installedVersion("factory-droid", "1.17.1", 256 * MB, false),
    ],
    lastCheckedAt: "2026-11-20T00:00:00.000Z",
    ...overrides,
  };
}

function antigravity(): ProviderRuntimeEntry {
  return {
    runtimeId: "antigravity",
    displayName: "Antigravity",
    driver: ProviderDriverKind.make("antigravity"),
    kind: "managedBinary",
    agentId: "antigravity-acp",
    usedByInstanceIds: [ProviderInstanceId.make("antigravity")],
    activeVersion: "1.5.14",
    latestVersion: "1.5.14",
    updateAvailable: false,
    canCheckUpdate: true,
    canUpdate: true,
    canSwitchVersion: false,
    canPrune: true,
    updateCommand: null,
    note: null,
    totalSizeBytes: 256 * MB,
    reclaimableBytes: 0,
    versions: [installedVersion("antigravity", "1.5.14", 256 * MB, true)],
    lastCheckedAt: "2026-11-20T00:00:00.000Z",
  };
}

function codex(): ProviderRuntimeEntry {
  return {
    runtimeId: "codex",
    displayName: "Codex",
    driver: ProviderDriverKind.make("codex"),
    kind: "systemCli",
    usedByInstanceIds: [ProviderInstanceId.make("codex")],
    activeVersion: "0.9.0",
    latestVersion: null,
    updateAvailable: false,
    canCheckUpdate: false,
    canUpdate: false,
    canSwitchVersion: false,
    canPrune: false,
    updateCommand: "npm i -g @openai/codex",
    note: "Installed globally with npm",
    totalSizeBytes: 64 * MB,
    reclaimableBytes: 0,
    versions: [installedVersion("codex", "0.9.0", 64 * MB, true)],
    lastCheckedAt: null,
  };
}

function cursor(): ProviderRuntimeEntry {
  return {
    runtimeId: "cursor",
    displayName: "Cursor",
    driver: ProviderDriverKind.make("cursor"),
    kind: "bundledSdk",
    usedByInstanceIds: [],
    activeVersion: null,
    latestVersion: null,
    updateAvailable: false,
    canCheckUpdate: false,
    canUpdate: false,
    canSwitchVersion: false,
    canPrune: false,
    updateCommand: null,
    note: "@cursor/sdk",
    totalSizeBytes: 0,
    reclaimableBytes: 0,
    versions: [],
    lastCheckedAt: null,
  };
}

function inventory(runtimes: ReadonlyArray<ProviderRuntimeEntry>): ProviderRuntimeInventory {
  return {
    checkedAt: "2026-11-24T00:00:00.000Z",
    totalSizeBytes: runtimes.reduce((total, runtime) => total + runtime.totalSizeBytes, 0),
    reclaimableBytes: runtimes.reduce((total, runtime) => total + runtime.reclaimableBytes, 0),
    autoPruneOldVersions: false,
    runtimes: [...runtimes],
  };
}

const BASE_INVENTORY = inventory([factoryDroid(), antigravity(), codex(), cursor()]);

function setup(initial: ProviderRuntimeInventory = BASE_INVENTORY) {
  state.listProviderRuntimes.mockReset().mockResolvedValue(AsyncResult.success(initial));
  state.checkProviderRuntimeUpdates.mockReset().mockResolvedValue(AsyncResult.success(initial));
  state.updateProviderRuntime.mockReset();
  state.pruneProviderRuntimeVersions.mockReset();
  state.confirm.mockReset().mockResolvedValue(false);
}

interface Rendered extends Screen {
  readonly onRuntimeChanged: ReturnType<typeof vi.fn>;
  readonly onToggleAutoPrune: ReturnType<typeof vi.fn>;
}

async function renderSection(): Promise<Rendered> {
  const onRuntimeChanged = vi.fn();
  const onToggleAutoPrune = vi.fn();
  const screen = await render(
    <ProviderRuntimeMaintenanceSection
      environmentId={environmentId}
      readOnly={false}
      canWriteSettings
      canManageProviders
      autoPruneOldVersions={false}
      onToggleAutoPrune={onToggleAutoPrune}
      onRuntimeChanged={onRuntimeChanged}
    />,
  );
  return Object.assign(screen, { onRuntimeChanged, onToggleAutoPrune });
}

function runtimeRow(screen: Screen, runtimeId: string): HTMLElement {
  const row = screen.container.querySelector<HTMLElement>(`[data-runtime-id="${runtimeId}"]`);
  expect(row, `runtime row ${runtimeId}`).not.toBeNull();
  return row!;
}

function versionRow(screen: Screen, runtimeId: string, version: string): HTMLElement {
  const row = screen.container.querySelector<HTMLElement>(
    `[data-version="${runtimeId}:${version}"]`,
  );
  expect(row, `version row ${runtimeId}:${version}`).not.toBeNull();
  return row!;
}

function buttonNamed(root: ParentNode, name: string): HTMLButtonElement {
  const button = [...root.querySelectorAll("button")].find(
    (candidate) =>
      candidate.getAttribute("aria-label") === name || candidate.textContent?.trim() === name,
  );
  expect(button, `button ${name}`).toBeDefined();
  return button!;
}

describe("ProviderRuntimeMaintenanceSection", () => {
  it("lists installed runtimes and only offers switch and delete for inactive versions", async () => {
    setup();
    await using section = await renderSection();

    await expect.element(page.getByText("Factory Droid")).toBeVisible();

    const active = page.elementLocator(versionRow(section, "factory-droid", "1.18.0"));
    await expect.element(active.getByText("Active")).toBeVisible();
    expect(active.getByRole("button").elements()).toHaveLength(0);

    const previousPatch = page.elementLocator(versionRow(section, "factory-droid", "1.17.2"));
    await expect.element(previousPatch.getByRole("button", { name: "Switch" })).toBeVisible();
    await expect
      .element(
        previousPatch.getByRole("button", { name: "Delete version 1.17.2 of Factory Droid" }),
      )
      .toBeVisible();

    expect(
      buttonNamed(versionRow(section, "factory-droid", "1.17.1"), "Switch"),
      "switch 1.17.1",
    ).toBeDefined();
    expect(
      versionRow(section, "factory-droid", "1.17.1").querySelector(
        '[aria-label="Delete version 1.17.1 of Factory Droid"]',
      ),
    ).not.toBeNull();

    // The runtime header carries the active version, shared instances, and total size.
    const factory = page.elementLocator(runtimeRow(section, "factory-droid"));
    await expect.element(factory.getByText("W1, W2, W3")).toBeVisible();
    await expect.element(factory.getByText("1.75 GB")).toBeVisible();

    const codexRow = page.elementLocator(runtimeRow(section, "codex"));
    await expect.element(codexRow.getByText("npm i -g @openai/codex")).toBeVisible();

    const cursorRow = page.elementLocator(runtimeRow(section, "cursor"));
    await expect.element(cursorRow.getByText(/@cursor\/sdk/)).toBeVisible();

    await expect.element(page.getByText(/2 old versions can free 768 MB/)).toBeVisible();
  });

  it("checks for updates, shows the new version, and updates the runtime", async () => {
    setup();
    state.checkProviderRuntimeUpdates.mockResolvedValue(
      AsyncResult.success(
        inventory([
          factoryDroid({ latestVersion: "1.19.0", updateAvailable: true }),
          antigravity(),
          codex(),
          cursor(),
        ]),
      ),
    );
    await using section = await renderSection();
    await expect.element(page.getByText("Factory Droid")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Check updates" }));
    expect(state.checkProviderRuntimeUpdates).toHaveBeenCalledWith({
      environmentId,
      input: {},
    });

    const updateButton = page.getByRole("button", { name: "Update to v1.19.0" });
    await expect.element(updateButton).toBeVisible();

    state.updateProviderRuntime.mockResolvedValue(
      AsyncResult.success({
        runtimeId: "factory-droid",
        previousVersion: "1.18.0",
        activeVersion: "1.19.0",
        prunedVersions: [],
        reclaimedBytes: 0,
        inventory: inventory([
          factoryDroid({ activeVersion: "1.19.0", latestVersion: "1.19.0" }),
          antigravity(),
          codex(),
          cursor(),
        ]),
      }),
    );
    await userEvent.click(updateButton);

    expect(state.updateProviderRuntime).toHaveBeenCalledWith({
      environmentId,
      input: { runtimeId: "factory-droid", action: "update" },
    });
    expect(section.onRuntimeChanged).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText("Factory Droid")).toBeVisible();
  });

  it("switches an inactive version", async () => {
    setup();
    await using section = await renderSection();
    await expect.element(page.getByText("Factory Droid")).toBeVisible();

    state.updateProviderRuntime.mockResolvedValue(
      AsyncResult.success({
        runtimeId: "factory-droid",
        previousVersion: "1.18.0",
        activeVersion: "1.17.2",
        prunedVersions: [],
        reclaimedBytes: 0,
        inventory: BASE_INVENTORY,
      }),
    );
    await userEvent.click(buttonNamed(versionRow(section, "factory-droid", "1.17.2"), "Switch"));

    expect(state.updateProviderRuntime).toHaveBeenCalledWith({
      environmentId,
      input: { runtimeId: "factory-droid", action: "switch", targetVersion: "1.17.2" },
    });
    expect(section.onRuntimeChanged).toHaveBeenCalledTimes(1);
  });

  it("deletes one inactive version after confirmation", async () => {
    setup();
    state.confirm.mockResolvedValue(true);
    state.pruneProviderRuntimeVersions.mockResolvedValue(
      AsyncResult.success({
        deleted: [{ runtimeId: "factory-droid", version: "1.17.1", sizeBytes: 256 * MB }],
        reclaimedBytes: 256 * MB,
        skipped: [],
        inventory: BASE_INVENTORY,
      }),
    );
    await using section = await renderSection();
    await expect.element(page.getByText("Factory Droid")).toBeVisible();

    await userEvent.click(
      page.getByRole("button", { name: "Delete version 1.17.1 of Factory Droid" }),
    );

    expect(state.confirm).toHaveBeenCalledWith("Delete Factory Droid v1.17.1 and free 256 MB?", {
      variant: "destructive",
    });
    expect(state.pruneProviderRuntimeVersions).toHaveBeenCalledWith({
      environmentId,
      input: { runtimeId: "factory-droid", version: "1.17.1" },
    });
    expect(section.onRuntimeChanged).toHaveBeenCalledTimes(1);
    await expect.element(page.getByText("Factory Droid")).toBeVisible();
  });

  it("cleans every old version after confirmation", async () => {
    setup();
    state.confirm.mockResolvedValue(true);
    state.pruneProviderRuntimeVersions.mockResolvedValue(
      AsyncResult.success({
        deleted: [
          { runtimeId: "factory-droid", version: "1.17.2", sizeBytes: 512 * MB },
          { runtimeId: "factory-droid", version: "1.17.1", sizeBytes: 256 * MB },
        ],
        reclaimedBytes: 768 * MB,
        skipped: [],
        inventory: BASE_INVENTORY,
      }),
    );
    await using section = await renderSection();
    await expect.element(page.getByText("Factory Droid")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Clean old versions" }));

    expect(state.confirm).toHaveBeenCalledWith(
      "Remove 2 old runtime versions and free 768 MB? Active versions will be kept.",
      { variant: "destructive" },
    );
    expect(state.pruneProviderRuntimeVersions).toHaveBeenCalledWith({
      environmentId,
      input: {},
    });
    expect(section.onRuntimeChanged).toHaveBeenCalledTimes(1);
  });

  it("toggles automatic cleanup of old versions", async () => {
    setup();
    await using section = await renderSection();
    await expect.element(page.getByText("Factory Droid")).toBeVisible();

    await userEvent.click(
      page.getByRole("switch", { name: "Auto-clean old versions after update" }),
    );

    expect(section.onToggleAutoPrune).toHaveBeenCalledWith(true);
  });
});
