import { describe, expect, it, vi } from "vitest";
import {
  resolveCanonicalInstrument,
} from "@/lib/services/instrument-resolution";
import { AlpacaAssetProviderError } from "@/lib/providers/alpaca-assets";

function resolvedAsset(overrides: Record<string, unknown> = {}) {
  return {
    id: "alpaca-ibm",
    symbolId: "NYSE:IBM" as const,
    symbol: "IBM",
    name: "International Business Machines Corporation",
    exchange: "NYSE",
    status: "active" as const,
    assetClass: "us_equity" as const,
    tradable: true,
    marginable: true,
    shortable: true,
    fractionable: true,
    borrowStatus: "easy_to_borrow" as const,
    attributes: [],
    ...overrides,
  };
}

describe("canonical instrument resolution", () => {
  it("resolves bundled symbols without a provider request", async () => {
    const resolveExact = vi.fn();

    await expect(
      resolveCanonicalInstrument("NASDAQ:NVDA", { resolveExact }),
    ).resolves.toMatchObject({
      id: "NASDAQ:NVDA",
      ticker: "NVDA",
      exchange: "NASDAQ",
      currency: "USD",
      status: "active",
    });
    expect(resolveExact).not.toHaveBeenCalled();
  });

  it("verifies an arbitrary canonical symbol against Alpaca", async () => {
    const resolveExact = vi.fn().mockResolvedValue(resolvedAsset());

    await expect(
      resolveCanonicalInstrument("NYSE:IBM", { resolveExact }),
    ).resolves.toEqual({
      id: "NYSE:IBM",
      ticker: "IBM",
      exchange: "NYSE",
      name: "International Business Machines Corporation",
      sector: null,
      currency: "USD",
      status: "active",
    });
    expect(resolveExact).toHaveBeenCalledWith("IBM");
  });

  it("rejects exchange mismatches instead of persisting caller metadata", async () => {
    const resolveExact = vi
      .fn()
      .mockResolvedValue(resolvedAsset({ symbolId: "NASDAQ:IBM", exchange: "NASDAQ" }));

    await expect(
      resolveCanonicalInstrument("NYSE:IBM", { resolveExact }),
    ).rejects.toMatchObject({
      code: "symbol_not_supported",
    });
  });

  it("sanitizes provider failures into a stable catalog error", async () => {
    const resolveExact = vi
      .fn()
      .mockRejectedValue(new AlpacaAssetProviderError("provider_auth_failed", 401));

    await expect(
      resolveCanonicalInstrument("NYSE:IBM", { resolveExact }),
    ).rejects.toMatchObject({
      code: "asset_catalog_unavailable",
    });
  });
});
