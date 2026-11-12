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
      publishedAt: "2026-11-01T18:43:00.000Z",
      providerUpdatedAt: "2026-11-11T18:44:00.000Z",
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
      providerUpdatedAt: "2026-11-11T18:44:00.000Z",
      sourceUrl: "https://example.test/event-1",
    });
    expect(result.meta).toMatchObject({
      dataMode: "live",
      providerCoverage: "partial",
      freshness: {
        state: "fresh",
        asOf: "2026-11-11T18:44:00.000Z",
        ageSeconds: 60,
      },
      providers: [
        {
          provider: "news-test",
          status: "healthy",
          attempted: true,
          latestObservedAt: "2026-11-11T18:44:00.000Z",
        },
        { provider: "filings-test", status: "degraded", attempted: true },
      ],
    });
  });

  it("keeps a fresh correction when merged provider results exceed the feed limit", async () => {
    const ordinaryEvents: RawSourceEvent[] = Array.from(
      { length: 100 },
      (_, index) => {
        const publishedAt = new Date(
          now.getTime() - (index + 10) * 60_000,
        ).toISOString();
        return {
          source: "news-test",
          sourceKind: "licensed_news",
          sourceEventId: `ordinary-${index}`,
          receivedAt: publishedAt,
          publishedAt,
          payload: {
            headline: `Company publishes routine update ${index}`,
            symbols: ["NVDA"],
          },
        };
      },
    );
    const correction: RawSourceEvent = {
      source: "corrections-test",
      sourceKind: "licensed_news",
      sourceEventId: "old-article-corrected-now",
      receivedAt: "2026-11-11T18:44:40.000Z",
      publishedAt: "2026-10-01T12:00:00.000Z",
      providerUpdatedAt: "2026-11-11T18:44:30.000Z",
      payload: {
        headline: "Company materially corrects an earlier announcement",
        symbols: ["NVDA"],
      },
    };
    const orchestrator = new LiveMarketDataOrchestrator({
      marketProvider: marketProvider(),
      intelligenceProviders: [
        {
          provider: intelligenceProvider("news-test", ordinaryEvents),
          capabilities: ["market-news"],
        },
        {
          provider: intelligenceProvider("corrections-test", [correction]),
          capabilities: ["market-news"],
        },
      ],
      getDemoSnapshot: () => null,
      getDemoEvents: () => [],
      now: () => now,
    });

    const result = await orchestrator.getIntelligenceFeed({
      symbols: ["NASDAQ:NVDA"],
      since: "2026-10-01T00:00:00.000Z",
      limit: 100,
    });

    expect(result.data).toHaveLength(100);
    expect(result.data[0]?.id).toBe(
      "corrections-test:old-article-corrected-now",
    );
    expect(
      result.data.some(
        (item) => item.id === "corrections-test:old-article-corrected-now",
      ),
    ).toBe(true);
    expect(
      result.data.some((item) => item.id === "news-test:ordinary-99"),
    ).toBe(false);
  });

  it("filters live events by minimum materiality and rejects unsafe source URLs", async () => {
    const events: RawSourceEvent[] = [
      {
        source: "news-test",
        sourceKind: "licensed_news",
        sourceEventId: "medium-event",
        receivedAt: "2026-11-11T18:43:05.000Z",
        publishedAt: "2026-11-11T18:43:00.000Z",
        payload: {
          headline: "Company schedules a product briefing",
          symbols: ["NVDA"],
          url: "https://example.test/medium-event",
        },
      },
      {
        source: "news-test",
        sourceKind: "licensed_news",
        sourceEventId: "high-event",
        receivedAt: "2026-11-11T18:44:05.000Z",
        publishedAt: "2026-11-11T18:44:00.000Z",
        payload: {
          headline: "Regulator launches antitrust enforcement action",
          symbols: ["NVDA"],
          url: "javascript:alert(document.domain)",
        },
      },
      {
        source: "news-test",
        sourceKind: "licensed_news",
        sourceEventId: "high-relative-url",
        receivedAt: "2026-11-11T18:42:05.000Z",
        publishedAt: "2026-11-11T18:42:00.000Z",
        payload: {
          headline: "Company receives a civil complaint in court",
          symbols: ["NVDA"],
          url: "/not-an-absolute-provider-url",
        },
      },
    ];
    const orchestrator = new LiveMarketDataOrchestrator({
      marketProvider: marketProvider(),
      intelligenceProviders: [
        {
          provider: intelligenceProvider("news-test", events),
          capabilities: ["market-news"],
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
      minimumMateriality: "high",
    });

    expect(result.data.map((item) => item.id)).toEqual([
      "news-test:high-event",
      "news-test:high-relative-url",
    ]);
    expect(result.data.every((item) => item.materiality === "high")).toBe(true);
    expect(result.data.every((item) => item.sourceUrl === null)).toBe(true);
  });

  it("does not let an implausibly future provider correction claim fresh data", async () => {
    const event: RawSourceEvent = {
      source: "news-test",
      sourceKind: "licensed_news",
      sourceEventId: "future-correction",
      receivedAt: "2026-11-11T18:43:05.000Z",
      publishedAt: "2026-11-11T18:43:00.000Z",
      providerUpdatedAt: "2026-11-11T19:30:00.000Z",
      payload: {
        headline: "Company publishes an update",
        symbols: ["NVDA"],
      },
    };
    const orchestrator = new LiveMarketDataOrchestrator({
      marketProvider: marketProvider(),
      intelligenceProviders: [
        {
          provider: intelligenceProvider("news-test", [event]),
          capabilities: ["market-news"],
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

    expect(result.meta.freshness).toEqual({
      state: "fresh",
      asOf: "2026-11-11T18:43:00.000Z",
      ageSeconds: 120,
    });
    expect(result.meta.providers[0]?.latestObservedAt).toBe(
      "2026-11-11T18:43:00.000Z",
    );
  });
});
