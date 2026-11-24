import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveProviderInstanceAcpRegistryIconUrl } from "./ProviderInstanceIcon";

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });

  it("skips synthesized registry CDN URLs for DeepSeek Harness so the local DeepSeek icon renders", () => {
    for (const agentId of ["deepseek-harness", "dsh"]) {
      expect(
        resolveProviderInstanceAcpRegistryIconUrl({
          driverKind: ProviderDriverKind.make("acpRegistry"),
          agentId,
        }),
      ).toBeNull();
      expect(
        resolveProviderInstanceAcpRegistryIconUrl({
          driverKind: ProviderDriverKind.make("acpRegistry"),
          agentId,
          iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/deepseek-harness.svg",
        }),
      ).toBe("https://cdn.agentclientprotocol.com/registry/icons/deepseek-harness.svg");
    }
  });
});
