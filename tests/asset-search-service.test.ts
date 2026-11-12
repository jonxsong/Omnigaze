import { describe, expect, it, vi } from "vitest";
import {
  AlpacaAssetProviderError,
  type AlpacaAssetCatalogClient,
  type AlpacaUsEquityAsset,
} from "@/lib/providers/alpaca-assets";
import {
  ASSET_CATALOG_FRESH_MS,
  ASSET_CATALOG_MAX_STALE_MS,
  AssetSearchService,
} from "@/lib/services/asset-search";

function asset(
  symbol: string,
  name: string,
  exchange = "NASDAQ",
): AlpacaUsEquityAsset {
  return {
    id: `asset-${symbol}`,
    symbolId: `${exchange}:${symbol}`,
    symbol,
    name,
    exchange,
    status: "active",
    assetClass: "us_equity",
    tradable: true,
    marginable: true,
    shortable: true,
    fractionable: true,
    borrowStatus: "easy_to_borrow",
    attributes: [],
  };
}

function client(
  listActiveUsEquities: AlpacaAssetCatalogClient["listActiveUsEquities"],
): AlpacaAssetCatalogClient {
  return {
    listActiveUsEquities,
    resolveExact: vi.fn().mockResolvedValue(null),
  };
}

describe("asset catalog search service", () => {
  it("ranks ticker matches before company-name matches and caps locally", async () => {
    const provider = client(
      vi.fn().mockResolvedValue([
        asset("FOO", "NVDA Holdings"),
        asset("XNVDA", "Unrelated Fund"),
        asset("NVDAX", "NVIDIA Index Fund"),
        asset("NVDA", "NVIDIA Corporation"),
        asset("BAR", "The NVDA Daily Basket"),
      ]),
    );
    const service = new AssetSearchService(provider, () => 1_000);

    const result = await service.search("  nvda  ", 4);

    expect(result.data.map(({ symbol }) => symbol)).toEqual([
      "NVDA",
      "NVDAX",
      "FOO",
      "BAR",
    ]);
    expect(result.meta).toMatchObject({
      source: "alpaca",
      totalMatches: 5,
      freshness: { state: "fresh", ageSeconds: 0 },
    });
    expect(result.data.every((item) => item.provider === "alpaca")).toBe(true);
  });

  it("uses a one-hour fresh cache and a bounded 24-hour stale fallback", async () => {
    let now = 0;
    const list = vi
      .fn()
      .mockResolvedValueOnce([asset("NVDA", "NVIDIA Corporation")])
      .mockRejectedValue(
        new AlpacaAssetProviderError("provider_rate_limited", 429, 30),
      );
    const service = new AssetSearchService(client(list), () => now);

    await expect(service.search("nvda")).resolves.toMatchObject({
      meta: { freshness: { state: "fresh", ageSeconds: 0 } },
    });
    now = ASSET_CATALOG_FRESH_MS;
    await service.search("nvda");
    expect(list).toHaveBeenCalledOnce();

    now = ASSET_CATALOG_FRESH_MS + 1;
    await expect(service.search("nvda")).resolves.toMatchObject({
      data: [{ symbol: "NVDA" }],
      meta: {
        freshness: { state: "stale", ageSeconds: 3_600 },
        fallbackReason: "provider_rate_limited",
      },
    });

    now = ASSET_CATALOG_MAX_STALE_MS + 1;
    await expect(service.search("nvda")).rejects.toMatchObject({
      code: "provider_rate_limited",
    });
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("coalesces concurrent cold-cache requests into one provider call", async () => {
    let release: (assets: AlpacaUsEquityAsset[]) => void = () => undefined;
    const pending = new Promise<AlpacaUsEquityAsset[]>((resolve) => {
      release = resolve;
    });
    const list = vi.fn().mockReturnValue(pending);
    const service = new AssetSearchService(client(list), () => 42_000);

    const first = service.search("nvda");
    const second = service.search("nvidia");
    expect(list).toHaveBeenCalledOnce();

    release([asset("NVDA", "NVIDIA Corporation")]);
    await expect(first).resolves.toMatchObject({ data: [{ symbol: "NVDA" }] });
    await expect(second).resolves.toMatchObject({ data: [{ symbol: "NVDA" }] });
    expect(list).toHaveBeenCalledOnce();
  });

  it("sanitizes an unknown provider failure when no catalog exists", async () => {
    const service = new AssetSearchService(
      client(vi.fn().mockRejectedValue(new Error("socket secret details"))),
    );

    const error = await service.search("nvda").catch((caught) => caught);
    expect(error).toMatchObject({ code: "provider_unavailable" });
    expect(String(error)).not.toContain("socket secret details");
  });

  it("exposes exact resolution without using demo data", async () => {
    const resolved = asset("SHOP", "Shopify Inc.", "NYSE");
    const resolveExact = vi.fn().mockResolvedValue(resolved);
    const provider: AlpacaAssetCatalogClient = {
      listActiveUsEquities: vi.fn(),
      resolveExact,
    };
    const service = new AssetSearchService(provider);

    await expect(service.resolveExact("SHOP")).resolves.toEqual(resolved);
    expect(resolveExact).toHaveBeenCalledWith("SHOP");
    expect(provider.listActiveUsEquities).not.toHaveBeenCalled();
  });
});
