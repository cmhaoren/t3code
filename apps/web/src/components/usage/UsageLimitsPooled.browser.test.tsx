import "~/index.css";

import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { UsageLimitsPooled } from "./UsageLimitsPooled";

const checkedAt = "2026-10-25T16:00:00.000Z";

function managedChatGpt(instanceId: string, displayName: string): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: ProviderDriverKind.make("codex"),
    displayName,
    enabled: true,
    installed: true,
    version: "0.164.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt,
      windows: [],
      unavailable: { reason: "unsupported", message: "Track usage in ChatGPT." },
      externalUsage: { label: "ChatGPT usage", url: CHATGPT_USAGE_URL },
    },
  };
}

function usageWindow(
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  usedPercent: number,
): ServerProviderUsageWindow {
  return {
    id,
    kind,
    label,
    usedPercent,
    resetsAt: "2026-11-24T12:00:00.000Z",
    windowDurationMins: kind === "session" ? 300 : kind === "weekly" ? 10_080 : 43_200,
  };
}

function provider(
  overrides: Omit<Partial<ServerProvider>, "instanceId"> & { readonly instanceId: string },
) {
  return {
    driver: ProviderDriverKind.make("cursor"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready" as const,
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
    instanceId: ProviderInstanceId.make(overrides.instanceId),
    // Limits pool per login, so every fixture instance needs its own identity.
    auth: overrides.auth ?? {
      status: "authenticated" as const,
      email: `${overrides.instanceId}@example.com`,
    },
  } satisfies ServerProvider;
}

function cursor(displayName: string, autoPercentUsed: number, apiPercentUsed: number) {
  return provider({
    instanceId: "cursor",
    driver: ProviderDriverKind.make("cursor"),
    displayName,
    usageLimits: {
      checkedAt,
      windows: [
        usageWindow("autoPercentUsed", "monthly", "Cursor Models", autoPercentUsed),
        usageWindow("apiPercentUsed", "monthly", "Other Models", apiPercentUsed),
      ],
    },
  });
}

function antigravity(instanceId: string, displayName: string, usedPercent: number) {
  return provider({
    instanceId,
    driver: ProviderDriverKind.make("antigravity"),
    displayName,
    usageLimits: {
      checkedAt,
      windows: [
        usageWindow("gemini-5h", "session", "Gemini · 5-hour", usedPercent),
        usageWindow("gemini-weekly", "weekly", "Gemini · Weekly", usedPercent + 10),
        usageWindow("3p-5h", "session", "3P · 5-hour", usedPercent + 20),
      ],
    },
  });
}

function factoryDroid(instanceId: string, displayName: string, usedPercent: number) {
  return provider({
    instanceId,
    driver: ProviderDriverKind.make("acpRegistry"),
    displayName,
    usageLimits: {
      checkedAt,
      group: { id: "acpRegistry:factory-droid", label: "Factory Droid" },
      windows: [
        usageWindow("standard-5h", "session", "Standard · 5h", usedPercent),
        usageWindow("standard-weekly", "weekly", "Standard · Weekly", usedPercent + 5),
        usageWindow("core-5h", "session", "Core · 5h", usedPercent + 15),
      ],
    },
  });
}

function pooledProviders(): ServerProvider[] {
  return [
    cursor("Cursor", 42, 70),
    antigravity("antigravity_personal", "Antigravity Personal", 25),
    antigravity("antigravity_work", "Antigravity Work", 55),
    factoryDroid("factory_personal", "Factory Personal", 20),
    factoryDroid("factory_work", "Factory Work", 45),
    factoryDroid("factory_team", "Factory Team", 80),
  ];
}

describe("UsageLimitsPooled ChatGPT usage card", () => {
  it("names the managed connections it covers", async () => {
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: {
            providers: [
              managedChatGpt("chatgpt_work", "ChatGPT Work"),
              managedChatGpt("chatgpt_personal", "ChatGPT Personal"),
            ],
          },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByText("ChatGPT Work on Desk, ChatGPT Personal on Desk"))
      .toBeVisible();
    await expect
      .element(screen.getByText("View usage in ChatGPT with your connected account."))
      .toBeVisible();
  });
});

describe("UsageLimitsPooled grouped limits", () => {
  it("renders each provider as one compact section with every window row", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 900);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: { providers: pooledProviders() },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    for (const name of ["Cursor", "Antigravity", "Factory Droid"]) {
      await expect.element(screen.getByRole("heading", { name })).toBeVisible();
    }

    const sections = screen.container.querySelectorAll('[data-slot="usage-limit-pool"]');
    expect(sections).toHaveLength(3);

    const rows = screen.container.querySelectorAll('[data-slot="usage-limit-window"]');
    expect(rows).toHaveLength(8);

    for (const label of [
      "Cursor Models",
      "Other Models",
      "Gemini · 5-hour",
      "Gemini · Weekly",
      "3P · 5-hour",
      "Standard · 5h",
      "Standard · Weekly",
      "Core · 5h",
    ]) {
      await expect.element(screen.getByText(label, { exact: true })).toBeVisible();
    }

    // Every pooled instance keeps a visible segment bar at the desktop width.
    const segments = screen.container.querySelectorAll<HTMLElement>(
      '[data-slot="usage-limit-window"] button[aria-label*="left"]',
    );
    expect(segments).toHaveLength(17);
    for (const segment of segments) {
      expect(segment.getBoundingClientRect().height).toBe(24);
    }

    // The single-account Cursor pool still yields compact rows, not the old tall cards.
    const cursorRow = screen
      .getByText("Cursor Models", { exact: true })
      .element()
      .closest<HTMLElement>('[data-slot="usage-limit-window"]');
    expect(cursorRow).not.toBeNull();
    const cursorRowHeight = cursorRow!.getBoundingClientRect().height;
    expect(cursorRowHeight).toBeGreaterThan(0);
    expect(cursorRowHeight).toBeLessThan(60);
  });

  it("keeps Cursor window descriptions reachable from the compact row", async () => {
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(1280, 900);
    await using _viewport = {
      [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
    };
    const presentations = new Map([
      [
        EnvironmentId.make("desk"),
        {
          entry: { target: { label: "Desk" } },
          serverConfig: { providers: [cursor("Cursor", 42, 70)] },
        },
      ],
    ]);
    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(checkedAt)} />,
    );

    await expect
      .element(screen.getByRole("img", { name: "Grok, Composer, and Auto use this allowance." }))
      .toBeVisible();
    await expect
      .element(
        screen.getByRole("img", {
          name: "Usage allowance for third-party models such as Claude, GPT, and Gemini.",
        }),
      )
      .toBeVisible();
  });
});
