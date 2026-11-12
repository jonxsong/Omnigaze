import { describe, expect, it, vi } from "vitest";
import {
  createMarketSnapshotsHandler,
  type MarketSnapshotBatchResponse,
} from "@/app/api/market/snapshots/route";
import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import type {
  AlpacaAssetCatalogClient,
  AlpacaUsEquityAsset,
} from "@/lib/providers/alpaca-assets";
import { AssetSearchService } from "@/lib/services/asset-search";
import {
  InstrumentResolutionError,
  resolveCanonicalInstrument,
} from "@/lib/services/instrument-resolution";
import type { OrchestratedSnapshot } from "@/lib/services/live-market-data";

const NOW = "2026-11-12T12:00:00.000Z";

function snapshot(symbolId: CanonicalSymbol): MarketSnapshot {
  return {
    symbolId,
    asOf: "2026-11-12T11:59:45.000Z",
    session: "regular",
    price: 200,
    previousClose: 195,
    change: 5,
    changePercent: 2.56,
    volume: 1_000,
    marketCap: "Unavailable",
    isDelayed: false,
    delaySeconds: 0,
    provider: "test-provider",
    marketCoverage: "limited-exchange",
  };
}

function result(symbolId: CanonicalSymbol): OrchestratedSnapshot {
  return {
    data: snapshot(symbolId),
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "partial",
      coverage: "partial",
      generatedAt: NOW,
      freshness: {
        state: "fresh",
        asOf: "2026-11-12T11:59:45.000Z",
        ageSeconds: 15,
      },
      providers: [],
      notice: "Live provider data.",
    },
  };
}

function resolver(symbolId: CanonicalSymbol) {
  const [exchange, ticker] = symbolId.split(":");
  return Promise.resolve({
    id: symbolId,
    ticker,
    exchange,
    name: ticker,
    sector: null,
    currency: "USD" as const,
    status: "active" as const,
  });
}

function catalogAsset(
  exchange: string,
  ticker: string,
): AlpacaUsEquityAsset {
  return {
    id: `asset-${ticker.toLowerCase()}`,
    symbolId: `${exchange}:${ticker}` as CanonicalSymbol,
    symbol: ticker,
    name: `${ticker} Incorporated`,
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

describe("batched market snapshot API", () => {
  it("rejects malformed and oversized batches before provider work", async () => {
    const getSnapshots = vi.fn();
    const handler = createMarketSnapshotsHandler({
      resolveInstrument: resolver,
      getSnapshots,
      now: () => new Date(NOW),
    });
    const tooMany = Array.from(
      { length: 13 },
      (_, index) => `NASDAQ:T${index}`,
    ).join(",");

    const malformed = await handler(
      new Request("https://omnigaze.test/api/market/snapshots?symbols=NVDA"),
    );
    const oversized = await handler(
      new Request(
        `https://omnigaze.test/api/market/snapshots?symbols=${encodeURIComponent(tooMany)}`,
      ),
    );

    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(getSnapshots).not.toHaveBeenCalled();
  });

  it("returns ordered partial results without discarding a valid peer", async () => {
    const getSnapshots = vi.fn(async () =>
      new Map<CanonicalSymbol, OrchestratedSnapshot>([
        ["NASDAQ:NVDA", result("NASDAQ:NVDA")],
      ]),
    );
    const handler = createMarketSnapshotsHandler({
      resolveInstrument: resolver,
      getSnapshots,
      now: () => new Date(NOW),
    });

    const response = await handler(
      new Request(
        "https://omnigaze.test/api/market/snapshots?symbols=nasdaq:nvda,nasdaq:msft",
      ),
    );
    const body = (await response.json()) as MarketSnapshotBatchResponse;

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(getSnapshots).toHaveBeenCalledOnce();
    expect(getSnapshots).toHaveBeenCalledWith([
      "NASDAQ:NVDA",
      "NASDAQ:MSFT",
    ]);
    expect(body).toMatchObject({
      data: [
        {
          symbolId: "NASDAQ:NVDA",
          status: "ready",
          data: { symbolId: "NASDAQ:NVDA" },
        },
        {
          symbolId: "NASDAQ:MSFT",
          status: "error",
          code: "market_data_unavailable",
        },
      ],
      meta: {
        requestedCount: 2,
        readyCount: 1,
        errorCount: 1,
        partial: true,
        generatedAt: NOW,
      },
    });
  });

  it("fails a mismatched provider identity instead of relabeling the quote", async () => {
    const handler = createMarketSnapshotsHandler({
      resolveInstrument: resolver,
      getSnapshots: async () =>
        new Map([
          ["NASDAQ:MSFT", result("NASDAQ:NVDA")],
        ] as const),
      now: () => new Date(NOW),
    });

    const response = await handler(
      new Request(
        "https://omnigaze.test/api/market/snapshots?symbols=NASDAQ:MSFT",
      ),
    );

    expect(await response.json()).toMatchObject({
      data: [
        {
          symbolId: "NASDAQ:MSFT",
          status: "error",
          code: "market_data_unavailable",
        },
      ],
    });
  });

  it("preserves per-symbol catalog failures while serving verified symbols", async () => {
    const handler = createMarketSnapshotsHandler({
      resolveInstrument: async (symbolId) => {
        if (symbolId === "NYSE:UNKNOWN") {
          throw new InstrumentResolutionError("symbol_not_supported");
        }
        return resolver(symbolId);
      },
      getSnapshots: async (symbols) =>
        new Map(symbols.map((symbolId) => [symbolId, result(symbolId)])),
      now: () => new Date(NOW),
    });

    const response = await handler(
      new Request(
        "https://omnigaze.test/api/market/snapshots?symbols=NASDAQ:NVDA,NYSE:UNKNOWN",
      ),
    );
    const body = (await response.json()) as MarketSnapshotBatchResponse;

    expect(body.data).toEqual([
      expect.objectContaining({ symbolId: "NASDAQ:NVDA", status: "ready" }),
      expect.objectContaining({
        symbolId: "NYSE:UNKNOWN",
        status: "error",
        code: "symbol_not_supported",
      }),
    ]);
    expect(body.meta).toMatchObject({ readyCount: 1, errorCount: 1, partial: true });
  });

  it("reuses one fresh catalog across repeated arbitrary-symbol batches", async () => {
    const listActiveUsEquities = vi.fn().mockResolvedValue([
      catalogAsset("NYSE", "IBM"),
      catalogAsset("NYSE", "SHOP"),
    ]);
    const resolveExact = vi.fn().mockResolvedValue(null);
    const provider: AlpacaAssetCatalogClient = {
      listActiveUsEquities,
      resolveExact,
    };
    const assetSearch = new AssetSearchService(provider, () => Date.parse(NOW));
    const getSnapshots = vi.fn(async (symbols: CanonicalSymbol[]) =>
      new Map(symbols.map((symbolId) => [symbolId, result(symbolId)])),
    );
    const handler = createMarketSnapshotsHandler({
      resolveInstrument: (symbolId) =>
        resolveCanonicalInstrument(symbolId, {
          resolveExact: (identifier) => assetSearch.resolveExact(identifier),
        }),
      getSnapshots,
      now: () => new Date(NOW),
    });
    const requestUrl =
      "https://omnigaze.test/api/market/snapshots?symbols=NYSE:IBM,NYSE:SHOP";

    const first = await handler(new Request(requestUrl));
    const second = await handler(new Request(requestUrl));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(listActiveUsEquities).toHaveBeenCalledOnce();
    expect(resolveExact).not.toHaveBeenCalled();
    expect(getSnapshots).toHaveBeenCalledTimes(2);
  });
});
