import { describe, expect, it, vi } from "vitest";
import {
  MARKET_CONTEXT_NOTICE,
  marketContextProxies,
  marketContextProxySymbols,
} from "@/lib/market-context";
import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import { getMarketContext } from "@/lib/services/market-context";
import type {
  FreshnessState,
  OrchestratedSnapshot,
} from "@/lib/services/live-market-data";

const NOW = "2026-11-12T20:00:00.000Z";

function snapshot(
  symbolId: CanonicalSymbol,
  marketCoverage: MarketSnapshot["marketCoverage"] = "limited-exchange",
): MarketSnapshot {
  return {
    symbolId,
    asOf: "2026-11-12T19:59:30.000Z",
    session: "regular",
    price: 250,
    previousClose: 245,
    change: 5,
    changePercent: 2.040816,
    volume: 123_456,
    marketCap: "Unavailable",
    isDelayed: false,
    delaySeconds: 0,
    provider: "Alpaca iex",
    marketCoverage,
  };
}

function liveResult(
  symbolId: CanonicalSymbol,
  freshness: Extract<FreshnessState, "fresh" | "stale" | "unknown"> = "fresh",
  marketCoverage: Extract<
    MarketSnapshot["marketCoverage"],
    "limited-exchange" | "consolidated"
  > = "limited-exchange",
): OrchestratedSnapshot {
  const data = snapshot(symbolId, marketCoverage);
  return {
    data,
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage:
        marketCoverage === "consolidated" ? "complete" : "partial",
      coverage: marketCoverage === "consolidated" ? "complete" : "partial",
      generatedAt: NOW,
      freshness: {
        state: freshness,
        asOf: freshness === "unknown" ? null : data.asOf,
        ageSeconds: freshness === "unknown" ? null : 30,
      },
      providers: [],
      notice: "provider notice",
    },
  };
}

function demoResult(symbolId: CanonicalSymbol): OrchestratedSnapshot {
  return {
    data: snapshot(symbolId, "fixture"),
    meta: {
      dataMode: "demo",
      mode: "demo",
      providerCoverage: "demo",
      coverage: "demo",
      generatedAt: NOW,
      freshness: {
        state: "fixture",
        asOf: "2026-11-01T12:00:00.000Z",
        ageSeconds: null,
      },
      providers: [],
      fallbackReason: "provider_request_failed",
      notice: "raw demo provider notice",
    },
  };
}

describe("market context domain service", () => {
  it("uses one ordered batch and returns only honestly labeled ETF proxies", async () => {
    const getSnapshots = vi.fn(async (symbols: CanonicalSymbol[]) =>
      new Map(
        symbols.map((symbol) => [symbol, liveResult(symbol)] as const),
      ),
    );

    const result = await getMarketContext({
      getSnapshots,
      now: () => new Date(NOW),
    });

    expect(getSnapshots).toHaveBeenCalledOnce();
    expect(getSnapshots).toHaveBeenCalledWith(marketContextProxySymbols());
    expect(result.data.map((item) => item.symbolId)).toEqual(
      marketContextProxies.map((proxy) => proxy.symbolId),
    );
    expect(result.data.every((item) => item.assetType === "etf_proxy")).toBe(true);
    expect(result.data.map((item) => item.label)).toEqual([
      "S&P 500 ETF proxy",
      "Nasdaq-100 ETF proxy",
      "Russell 2000 ETF proxy",
      "20+ year Treasury ETF proxy",
      "Oil ETF proxy",
      "Gold ETF proxy",
    ]);
    expect(result.meta).toEqual({
      status: "live",
      requestedCount: 6,
      liveCount: 6,
      staleCount: 0,
      demoCount: 0,
      unavailableCount: 0,
      availabilityCoverage: "complete",
      marketCoverage: "partial",
      generatedAt: NOW,
      notice: MARKET_CONTEXT_NOTICE,
    });
  });

  it("preserves valid peers and suppresses demo, mismatched, and unverified data", async () => {
    const symbols = marketContextProxySymbols();
    const results = new Map<CanonicalSymbol, OrchestratedSnapshot>([
      [symbols[0], liveResult(symbols[0])],
      [symbols[1], liveResult(symbols[1], "stale")],
      [symbols[2], demoResult(symbols[2])],
      [symbols[4], liveResult(symbols[5])],
      [symbols[5], liveResult(symbols[5], "unknown")],
    ]);

    const result = await getMarketContext({
      getSnapshots: async () => results,
      now: () => new Date(NOW),
    });

    expect(result.data.map((item) => item.status)).toEqual([
      "live",
      "stale",
      "demo",
      "unavailable",
      "unavailable",
      "unavailable",
    ]);
    expect(result.data[2]).toEqual(
      expect.objectContaining({ status: "demo", reason: "demo_suppressed" }),
    );
    expect(result.data[3]).toEqual(
      expect.objectContaining({
        status: "unavailable",
        reason: "snapshot_unavailable",
      }),
    );
    expect(result.data[4]).toEqual(
      expect.objectContaining({
        status: "unavailable",
        reason: "identity_mismatch",
      }),
    );
    expect(result.data[5]).toEqual(
      expect.objectContaining({
        status: "unavailable",
        reason: "freshness_unverified",
      }),
    );
    expect(JSON.stringify(result.data[2])).not.toContain("250");
    expect(JSON.stringify(result)).not.toContain("raw demo provider notice");
    expect(result.meta).toMatchObject({
      status: "partial",
      liveCount: 1,
      staleCount: 1,
      demoCount: 1,
      unavailableCount: 3,
      availabilityCoverage: "partial",
    });
  });

  it("distinguishes all-stale, demo-suppressed, and provider-unavailable states", async () => {
    const symbols = marketContextProxySymbols();
    const stale = await getMarketContext({
      getSnapshots: async () =>
        new Map(symbols.map((symbol) => [symbol, liveResult(symbol, "stale")])),
      now: () => new Date(NOW),
    });
    const demo = await getMarketContext({
      getSnapshots: async () =>
        new Map(symbols.map((symbol) => [symbol, demoResult(symbol)])),
      now: () => new Date(NOW),
    });
    const unavailable = await getMarketContext({
      getSnapshots: async () => {
        throw new Error("credential-bearing provider failure that must not escape");
      },
      now: () => new Date(NOW),
    });

    expect(stale.meta).toMatchObject({
      status: "stale",
      staleCount: 6,
      availabilityCoverage: "complete",
    });
    expect(demo.meta).toMatchObject({
      status: "demo",
      demoCount: 6,
      availabilityCoverage: "none",
      marketCoverage: "none",
    });
    expect(unavailable.meta).toMatchObject({
      status: "unavailable",
      unavailableCount: 6,
      availabilityCoverage: "none",
      marketCoverage: "none",
    });
    expect(
      unavailable.data.every(
        (item) =>
          item.status === "unavailable" &&
          item.reason === "provider_unavailable",
      ),
    ).toBe(true);
    expect(JSON.stringify(unavailable)).not.toContain("credential-bearing");
  });

  it("reports complete consolidated market coverage independently from availability", async () => {
    const symbols = marketContextProxySymbols();
    const result = await getMarketContext({
      getSnapshots: async () =>
        new Map(
          symbols.map((symbol) => [
            symbol,
            liveResult(symbol, "fresh", "consolidated"),
          ]),
        ),
      now: () => new Date(NOW),
    });

    expect(result.meta).toMatchObject({
      status: "live",
      availabilityCoverage: "complete",
      marketCoverage: "complete",
    });
  });
});

