import { describe, expect, it, vi } from "vitest";
import { createAssetSearchHandler } from "@/app/api/assets/search/route";
import { AlpacaAssetProviderError } from "@/lib/providers/alpaca-assets";

function request(query: string) {
  return new Request(`https://omnigaze.test/api/assets/search${query}`);
}

describe("asset search API", () => {
  it("validates the query and result limit before touching the provider", async () => {
    const search = vi.fn();
    const handler = createAssetSearchHandler({ search });

    const missing = await handler(request(""));
    const blank = await handler(request("?q=%20%20"));
    const nonInteger = await handler(request("?q=nvda&limit=1.5"));
    const tooLarge = await handler(request("?q=nvda&limit=51"));

    expect([missing.status, blank.status, nonInteger.status, tooLarge.status]).toEqual([
      400, 400, 400, 400,
    ]);
    expect(await tooLarge.json()).toEqual({
      error: "limit must be an integer between 1 and 50.",
      code: "invalid_query",
    });
    expect(search).not.toHaveBeenCalled();
  });

  it("returns a stable fresh envelope, including a legitimate empty result", async () => {
    const search = vi.fn().mockResolvedValue({
      data: [],
      meta: {
        source: "alpaca",
        catalogAsOf: "2026-11-11T20:00:00.000Z",
        totalMatches: 0,
        freshness: { state: "fresh", ageSeconds: 15 },
      },
    });
    const handler = createAssetSearchHandler({ search });

    const response = await handler(request("?q=%20NoSuchCompany%20&limit=7"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      data: [],
      meta: {
        source: "alpaca",
        catalogAsOf: "2026-11-11T20:00:00.000Z",
        totalMatches: 0,
        freshness: { state: "fresh", ageSeconds: 15 },
      },
    });
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=300");
    expect(search).toHaveBeenCalledWith("NoSuchCompany", 7);
  });

  it("marks stale catalog responses and prevents downstream caching", async () => {
    const search = vi.fn().mockResolvedValue({
      data: [
        {
          id: "asset-nvda",
          symbolId: "NASDAQ:NVDA",
          symbol: "NVDA",
          name: "NVIDIA Corporation",
          exchange: "NASDAQ",
          status: "active",
          tradable: true,
          marginable: true,
          shortable: true,
          fractionable: true,
          attributes: [],
          provider: "alpaca",
        },
      ],
      meta: {
        source: "alpaca",
        catalogAsOf: "2026-11-11T19:00:00.000Z",
        totalMatches: 1,
        freshness: { state: "stale", ageSeconds: 7_200 },
        fallbackReason: "provider_unavailable",
      },
    });
    const handler = createAssetSearchHandler({ search });

    const response = await handler(request("?q=nvda"));

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      data: [{ symbolId: "NASDAQ:NVDA", provider: "alpaca" }],
      meta: {
        freshness: { state: "stale" },
        fallbackReason: "provider_unavailable",
      },
    });
  });

  it("returns a sanitized 503 with no demo fallback when no catalog is usable", async () => {
    const search = vi.fn().mockRejectedValue(
      new AlpacaAssetProviderError("provider_rate_limited", 429, 12),
    );
    const handler = createAssetSearchHandler({ search });

    const response = await handler(request("?q=nvda"));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("12");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      error: "The asset catalog is temporarily unavailable.",
      code: "asset_catalog_unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("demo");
    expect(JSON.stringify(body)).not.toContain("provider_rate_limited");
  });

  it("does not leak unexpected failure details", async () => {
    const search = vi.fn().mockRejectedValue(new Error("private upstream body"));
    const handler = createAssetSearchHandler({ search });

    const response = await handler(request("?q=nvda"));
    expect(response.status).toBe(503);
    expect(JSON.stringify(await response.json())).not.toContain("private upstream body");
  });
});
