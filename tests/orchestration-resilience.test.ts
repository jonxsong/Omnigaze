import { describe, expect, it } from "vitest";
import type { MarketSnapshot } from "@/lib/market-types";
import type { ProviderHealth, RawSourceEvent } from "@/lib/pipeline/contracts";
import type {
  IntelligenceSourceProvider,
  MarketDataProvider,
} from "@/lib/providers/contracts";
import { LiveMarketDataOrchestrator } from "@/lib/services/live-market-data";

const now = new Date("2026-11-11T18:45:00.000Z");

function health(provider: string, status: ProviderHealth["status"] = "healthy") {
  return {
    provider,
    status,
    checkedAt: now.toISOString(),
    latestObservedAt: null,
  } satisfies ProviderHealth;
}

const liveSnapshot: MarketSnapshot = {
  symbolId: "NASDAQ:NVDA",
  asOf: "2026-11-11T18:00:00.000Z",
  session: "regular",
  price: 201.25,
  previousClose: 198.5,
  change: 2.75,
  changePercent: 1.385,
  volume: 42_000_000,
  marketCap: "Unavailable",
  isDelayed: false,
  delaySeconds: 0,
  provider: "test-live-provider",
  marketCoverage: "consolidated",
};

function marketProvider(overrides: Partial<MarketDataProvider> = {}): MarketDataProvider {
  return {
    name: "quotes-test",
    getHealth: async () => health("quotes-test"),
    getSnapshot: async () => liveSnapshot,
    ...overrides,
  };
}

function intelligenceProvider(
  name: string,
  events: RawSourceEvent[] | Error,
): IntelligenceSourceProvider {
  return {
    name,
    getHealth: async () => health(name),
    getLatestEvents: async () => {
      if (events instanceof Error) throw events;
      return events;
    },
  };
}

describe("live market orchestration resilience", () => {
  it("marks an old live quote stale without relabeling it as demo data", async () => {
    const orchestrator = new LiveMarketDataOrchestrator({
      marketProvider: marketProvider(),
      intelligenceProviders: [],
      getDemoSnapshot: () => null,
      getDemoEvents: () => [],
      now: () => now,
    });

    const result = await orchestrator.getSnapshot("NASDAQ:NVDA");

    expect(result.data).toEqual(liveSnapshot);
    expect(result.meta).toMatchObject({
      dataMode: "live",
      providerCoverage: "complete",
      freshness: {
        state: "stale",
        asOf: liveSnapshot.asOf,
        ageSeconds: 2_700,
      },
      providers: [{ status: "healthy", attempted: true }],
    });
  });

  it("falls back to an explicitly labeled fixture when a healthy provider request fails", async () => {
    const fixture = { ...liveSnapshot, provider: "fixture", marketCoverage: "fixture" as const };
    const orchestrator = new LiveMarketDataOrchestrator({
      marketProvider: marketProvider({
        getSnapshot: async () => {
          throw new Error("upstream credential=must-not-escape");
        },
      }),
      intelligenceProviders: [],
      getDemoSnapshot: () => fixture,
      getDemoEvents: () => [],
      now: () => now,
    });

    const result = await orchestrator.getSnapshot("NASDAQ:NVDA");
    const serialized = JSON.stringify(result);

    expect(result.data).toEqual(fixture);
    expect(result.meta).toMatchObject({
      dataMode: "demo",
      providerCoverage: "demo",
      fallbackReason: "provider_request_failed",
      freshness: { state: "fixture", ageSeconds: null },
      providers: [{ status: "degraded", attempted: true }],
    });
    expect(serialized).not.toContain("must-not-escape");
  });

  it("preserves partial live intelligence when a second provider is unavailable", async () => {
    const liveEvent: RawSourceEvent = {
      source: "news-test",
      sourceKind: "licensed_news",
      sourceEventId: "event-1",
      receivedAt: "2026-11-11T18:43:05.000Z",
      publishedAt: "2026-11-11T18:43:00.000Z",
      payload: {
        headline: "A material company update",
        summary: "Evidence-backed provider fixture",
        symbols: ["NVDA"],
        url: "https://example.test/event-1",
      },
    };
    const orchestrator = new LiveMarketDataOrchestrator({
      marketProvider: marketProvider(),
      intelligenceProviders: [
        {
          provider: intelligenceProvider("news-test", [liveEvent]),
          capabilities: ["market-news"],
        },
        {
          provider: intelligenceProvider("filings-test", new Error("outage")),
          capabilities: ["sec-filings"],
        },
      ],
      getDemoSnapshot: () => null,
      getDemoEvents: () => [],
      now: () => now,
    });

    const result = await orchestrator.getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-11-11T00:00:00.000Z",
      limit: 10,
    });

    expect(result.data).toHaveLength(1);
    expect(result.data[0]).toMatchObject({
      id: "news-test:event-1",
      symbolIds: ["NASDAQ:NVDA"],
      isLive: true,
    });
    expect(result.meta).toMatchObject({
      dataMode: "live",
      providerCoverage: "partial",
      freshness: { state: "fresh", ageSeconds: 120 },
      providers: [
        { provider: "news-test", status: "healthy", attempted: true },
        { provider: "filings-test", status: "degraded", attempted: true },
      ],
    });
  });
});
