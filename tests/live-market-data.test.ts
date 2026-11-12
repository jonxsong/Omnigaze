import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import type { ProviderHealth, RawSourceEvent } from "@/lib/pipeline/contracts";
import type {
  IntelligenceSourceProvider,
  MarketDataProvider,
} from "@/lib/providers/contracts";
import {
  createLiveMarketDataOrchestrator,
  LiveMarketDataOrchestrator,
  type ProviderCapability,
} from "@/lib/services/live-market-data";
import { getIntelligenceFeed, getMarketSnapshot } from "@/lib/services/market-intelligence";

const NOW = new Date("2026-11-11T19:00:00.000Z");

afterEach(() => {
  vi.unstubAllGlobals();
});

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
  it("keeps production SEC egress dormant when only a valid user agent is present", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const service = createLiveMarketDataOrchestrator({
      SEC_USER_AGENT: "Omnigaze tests test@example.com",
    });

    const status = await service.getProviderStatus();
    expect(status.providers.find((report) => report.provider === "sec-edgar")).toMatchObject({
      status: "unconfigured",
    });

    await service.getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-11T00:00:00.000Z",
      limit: 5,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires the exact SEC activation flag and a ready distributed coordinator", async () => {
    const coordinator = {
      acquire: vi.fn(async () => undefined),
      imposeCooldown: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({
        status: "ready" as const,
        retryAfterSeconds: null,
      })),
    };
    const dependencies = {
      createSecFairAccessCoordinator: () => coordinator,
    };

    const caseVariant = createLiveMarketDataOrchestrator(
      {
        SEC_EDGAR_ENABLED: "TRUE",
        SEC_USER_AGENT: "Omnigaze tests test@example.com",
      },
      dependencies,
    );
    const disabledStatus = await caseVariant.getProviderStatus();
    expect(
      disabledStatus.providers.find((report) => report.provider === "sec-edgar"),
    ).toMatchObject({ status: "unconfigured" });
    expect(coordinator.getStatus).not.toHaveBeenCalled();

    const activated = createLiveMarketDataOrchestrator(
      {
        SEC_EDGAR_ENABLED: "true",
        SEC_USER_AGENT: "Omnigaze tests test@example.com",
      },
      dependencies,
    );
    const activeStatus = await activated.getProviderStatus();
    expect(
      activeStatus.providers.find((report) => report.provider === "sec-edgar"),
    ).toMatchObject({ status: "healthy" });
    expect(activeStatus.liveCapabilities).toContain("sec-filings");
    expect(coordinator.getStatus).toHaveBeenCalledOnce();
  });

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

  it("decodes provider entities before classification and display without mutating the receipt", async () => {
    const rawPayload = {
      headline: "CEO&#39;s board investigati&#111;n &amp; review",
      summary:
        "Management &amp;amp; directors opened an independent investigation.",
      symbols: ["NVDA"],
      url: "https://example.test/news/encoded-42",
    };
    const sourceEvent: RawSourceEvent = {
      source: "alpaca",
      sourceKind: "licensed_news",
      sourceEventId: "encoded-42",
      publishedAt: "2026-11-11T18:58:00.000Z",
      receivedAt: "2026-11-11T18:58:01.000Z",
      payload: rawPayload,
    };
    const result = await orchestrator({
      intelligence: [
        {
          provider: intelligenceProvider({ events: [sourceEvent] }),
          capabilities: ["market-news"],
        },
      ],
    }).getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-11T00:00:00.000Z",
      limit: 20,
    });

    expect(result.data[0]).toMatchObject({
      headline: "CEO's board investigation & review",
      summary: "Management & directors opened an independent investigation.",
      category: "governance",
      claimStatus: "official-investigation",
    });
    expect(sourceEvent.payload).toBe(rawPayload);
    expect(rawPayload.headline).toContain("&#39;");
    expect(rawPayload.summary).toContain("&amp;amp;");
  });

  it("falls back safely when decoded provider display text is blank", async () => {
    const result = await orchestrator({
      intelligence: [
        {
          provider: intelligenceProvider({
            events: [
              {
                source: "alpaca",
                sourceKind: "licensed_news",
                sourceEventId: "blank-entity",
                publishedAt: "2026-11-12T07:49:00.000Z",
                receivedAt: "2026-11-12T07:50:00.000Z",
                payload: {
                  headline: "&nbsp;",
                  summary: "&#160;",
                  symbols: ["NVDA"],
                },
              },
            ],
          }),
          capabilities: ["market-news"],
        },
      ],
    }).getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-11T00:00:00.000Z",
      limit: 20,
    });

    expect(result.data[0]).toMatchObject({
      headline: "Market intelligence update",
      summary: null,
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
