import { describe, expect, it } from "vitest";
import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import type { ProviderHealth, RawSourceEvent } from "@/lib/pipeline/contracts";
import type {
  IntelligenceSourceProvider,
  MarketDataProvider,
} from "@/lib/providers/contracts";
import {
  LiveMarketDataOrchestrator,
  type ProviderCapability,
} from "@/lib/services/live-market-data";
import { getIntelligenceFeed, getMarketSnapshot } from "@/lib/services/market-intelligence";

const NOW = new Date("2026-11-11T19:00:00.000Z");

function health(
  provider: string,
  status: ProviderHealth["status"] = "healthy",
): ProviderHealth {
  return {
    provider,
    status,
    checkedAt: NOW.toISOString(),
    latestObservedAt: null,
  };
}

function liveSnapshot(
  marketCoverage: MarketSnapshot["marketCoverage"] = "limited-exchange",
): MarketSnapshot {
  return {
    symbolId: "NASDAQ:NVDA",
    asOf: "2026-11-11T18:59:30.000Z",
    session: "regular",
    price: 190,
    previousClose: 185,
    change: 5,
    changePercent: 2.7,
    volume: 1_000,
    marketCap: "Unavailable",
    isDelayed: false,
    delaySeconds: 0,
    provider: "Alpaca iex",
    marketCoverage,
  };
}

function marketProvider(options: {
  status?: ProviderHealth["status"];
  snapshot?: MarketSnapshot;
  error?: boolean;
} = {}): MarketDataProvider {
  return {
    name: "market-test",
    getHealth: async () => health("market-test", options.status),
    getSnapshot: async () => {
      if (options.error) throw new Error("upstream unavailable");
      return options.snapshot ?? liveSnapshot();
    },
  };
}

function intelligenceProvider(options: {
  status?: ProviderHealth["status"];
  events?: RawSourceEvent[];
  error?: boolean;
} = {}): IntelligenceSourceProvider {
  return {
    name: "intelligence-test",
    getHealth: async () => health("intelligence-test", options.status),
    getLatestEvents: async () => {
      if (options.error) throw new Error("upstream unavailable");
      return options.events ?? [];
    },
  };
}

function orchestrator(options: {
  market?: MarketDataProvider;
  intelligence?: Array<{
    provider: IntelligenceSourceProvider;
    capabilities: ProviderCapability[];
  }>;
} = {}) {
  return new LiveMarketDataOrchestrator({
    marketProvider: options.market ?? marketProvider(),
    intelligenceProviders:
      options.intelligence ?? [
        { provider: intelligenceProvider(), capabilities: ["market-news"] },
      ],
    getDemoSnapshot: getMarketSnapshot,
    getDemoEvents: getIntelligenceFeed,
    now: () => NOW,
  });
}

describe("live market data orchestration", () => {
  it("uses a successful live snapshot and reports IEX-style limited coverage", async () => {
    const result = await orchestrator().getSnapshot("NASDAQ:NVDA");

    expect(result.data?.provider).toBe("Alpaca iex");
    expect(result.meta).toMatchObject({
      dataMode: "live",
      mode: "live",
      coverage: "partial",
      providerCoverage: "partial",
      freshness: { state: "fresh", ageSeconds: 30 },
    });
    expect(result.meta.fallbackReason).toBeUndefined();
  });

  it("marks materially future provider timestamps unknown instead of fresh", async () => {
    const result = await orchestrator({
      market: marketProvider({
        snapshot: {
          ...liveSnapshot(),
          asOf: "2026-11-11T20:00:00.000Z",
        },
      }),
    }).getSnapshot("NASDAQ:NVDA");

    expect(result.meta.freshness).toEqual({
      state: "unknown",
      asOf: "2026-11-11T20:00:00.000Z",
      ageSeconds: null,
    });
  });

  it("labels fallback snapshots as demo when the live provider is unconfigured", async () => {
    const result = await orchestrator({
      market: marketProvider({ status: "unconfigured" }),
    }).getSnapshot("NASDAQ:NVDA");

    expect(result.data?.provider).toBe("Omnigaze demo fixture");
    expect(result.data?.marketCoverage).toBe("fixture");
    expect(result.meta).toMatchObject({
      dataMode: "demo",
      coverage: "demo",
      fallbackReason: "provider_unconfigured",
      freshness: { state: "fixture", ageSeconds: null },
    });
    expect(result.meta.notice).toContain("not current market data");
  });

  it("degrades provider health after a failed live snapshot request", async () => {
    const result = await orchestrator({
      market: marketProvider({ error: true }),
    }).getSnapshot("NASDAQ:NVDA");

    expect(result.meta.dataMode).toBe("demo");
    expect(result.meta.fallbackReason).toBe("provider_request_failed");
    expect(result.meta.providers[0]).toMatchObject({
      status: "degraded",
      attempted: true,
    });
  });

  it("keeps valid batch quotes live while degrading only unavailable symbols", async () => {
    let batchCalls = 0;
    const provider = marketProvider();
    provider.getSnapshots = async () => {
      batchCalls += 1;
      return new Map([["NASDAQ:NVDA", liveSnapshot()]]);
    };
    const service = new LiveMarketDataOrchestrator({
      marketProvider: provider,
      intelligenceProviders: [],
      getDemoSnapshot: (symbol) => ({
        ...liveSnapshot(),
        symbolId: symbol,
        provider: "fixture",
        marketCoverage: "fixture",
      }),
      getDemoEvents: () => [],
      now: () => NOW,
    });

    const results = await service.getSnapshots([
      "NASDAQ:NVDA",
      "NASDAQ:MSFT",
    ]);

    expect(batchCalls).toBe(1);
    expect(results.get("NASDAQ:NVDA")).toMatchObject({
      data: { symbolId: "NASDAQ:NVDA", provider: "Alpaca iex" },
      meta: {
        dataMode: "live",
        providers: [{ status: "healthy", attempted: true }],
      },
    });
    expect(results.get("NASDAQ:MSFT")).toMatchObject({
      data: {
        symbolId: "NASDAQ:MSFT",
        provider: "fixture",
        marketCoverage: "fixture",
      },
      meta: {
        dataMode: "demo",
        fallbackReason: "provider_request_failed",
        providers: [{ status: "degraded", attempted: true }],
      },
    });
  });

  it("preserves a valid empty live feed instead of injecting demo events", async () => {
    const result = await orchestrator().getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-11T00:00:00.000Z",
      limit: 20,
    });

    expect(result.data).toEqual([]);
    expect(result.meta).toMatchObject({
      dataMode: "live",
      coverage: "complete",
    });
  });

  it("uses explicitly marked fixture events only when no live feed is available", async () => {
    const result = await orchestrator({
      intelligence: [
        {
          provider: intelligenceProvider({ status: "unconfigured" }),
          capabilities: ["market-news"],
        },
      ],
    }).getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA" as CanonicalSymbol],
      since: "2026-11-11T00:00:00.000Z",
      limit: 5,
      minimumMateriality: "low",
    });

    expect(result.data.length).toBeGreaterThan(0);
    expect(result.data.every((item) => item.isLive === false)).toBe(true);
    expect(result.data.every((item) => item.sourceKind === "demo_fixture")).toBe(true);
    expect(result.meta).toMatchObject({
      dataMode: "demo",
      coverage: "demo",
      fallbackReason: "provider_unconfigured",
    });
  });
});
