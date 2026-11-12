import { describe, expect, it, vi } from "vitest";
import type { IntelligenceFeedItem } from "@/lib/services/live-market-data";

vi.mock("@/lib/repositories/portfolio", () => ({
  getUserPortfolio: vi.fn(),
}));

import { getPortfolioDecisionSupport } from "@/lib/services/portfolio-decision-support";

const snapshot = {
  symbolId: "NASDAQ:NVDA" as const,
  asOf: "2026-11-12T18:00:00.000Z",
  session: "regular" as const,
  price: 160,
  previousClose: 158,
  change: 2,
  changePercent: 1.27,
  volume: 1_000,
  marketCap: "Unavailable",
  isDelayed: false,
  delaySeconds: 0,
  provider: "Alpaca iex",
  marketCoverage: "limited-exchange" as const,
};

const freshMeta = {
  dataMode: "live" as const,
  mode: "live" as const,
  providerCoverage: "partial" as const,
  coverage: "partial" as const,
  generatedAt: "2026-11-12T18:00:01.000Z",
  freshness: {
    state: "fresh" as const,
    asOf: snapshot.asOf,
    ageSeconds: 1,
  },
  providers: [],
  notice: "Live provider data.",
};

function evidence(
  id: string,
  source: string,
  sourceKind: IntelligenceFeedItem["sourceKind"] = "licensed_news",
) {
  return {
    id,
    symbolIds: ["NASDAQ:NVDA" as const],
    source,
    sourceKind,
    headline: "Material update",
    summary: "Evidence summary",
    publishedAt: "2026-11-12T17:00:00.000Z",
    receivedAt: "2026-11-12T17:00:01.000Z",
    sourceUrl: "https://example.test/evidence",
    materiality: "high" as const,
    isLive: true,
  };
}

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    resolveInstrument: vi.fn().mockResolvedValue({
      id: "NASDAQ:NVDA",
      ticker: "NVDA",
      exchange: "NASDAQ",
      name: "NVIDIA Corporation",
      sector: "Technology",
      currency: "USD",
      status: "active",
    }),
    getPortfolio: vi.fn().mockResolvedValue({
      profile: null,
      holdings: [
        {
          symbolId: "NASDAQ:NVDA",
          quantity: "15",
          averageCost: "140",
          quantityAsOf: "2026-11-10T18:00:00.000Z",
          version: 1,
        },
      ],
    }),
    getSnapshot: vi.fn().mockResolvedValue({ data: snapshot, meta: freshMeta }),
    getIntelligence: vi.fn().mockResolvedValue({
      data: [evidence("news-1", "alpaca"), evidence("filing-1", "sec-edgar", "sec_filing")],
      meta: freshMeta,
    }),
    now: () => new Date("2026-11-12T18:00:00.000Z"),
    ...overrides,
  };
}

const request = {
  symbol_id: "NASDAQ:NVDA" as const,
  horizon: "near_term" as const,
  preset: "balanced" as const,
  budget: "1000",
};

describe("portfolio decision-support orchestration", () => {
  it("joins the authenticated holding, live quote, and corroborated evidence", async () => {
    const result = await getPortfolioDecisionSupport(
      "owner-a",
      request,
      dependencies(),
    );

    expect(result.context).toMatchObject({
      hasHolding: true,
      holdingQuantity: "15",
      holding: {
        symbolId: "NASDAQ:NVDA",
        quantity: "15",
        averageCost: "140",
        quantityAsOf: "2026-11-10T18:00:00.000Z",
        version: 1,
      },
      quote: {
        price: 160,
        asOf: snapshot.asOf,
        freshUntil: "2026-11-12T18:20:00.000Z",
        provider: "Alpaca iex",
        marketCoverage: "limited-exchange",
        isDelayed: false,
        delaySeconds: 0,
      },
      evidenceCount: 2,
      independentSourceCount: 2,
      providerStreamCount: 2,
      marketDataMode: "live",
      evidenceDataMode: "live",
      evidenceFreshness: "fresh",
    });
    expect(result.context.evidence).toEqual([
      expect.objectContaining({
        id: "news-1",
        headline: "Material update",
        source: "alpaca",
        sourceKind: "licensed_news",
        sourceUrl: "https://example.test/evidence",
        materiality: "high",
      }),
      expect.objectContaining({
        id: "filing-1",
        source: "sec-edgar",
        sourceKind: "sec_filing",
      }),
    ]);
    expect(result.decision).toMatchObject({
      eligible: true,
      symbolId: "NASDAQ:NVDA",
      tradeExecutionAllowed: false,
      modelOutputRole: "scenario_math_only",
    });
    if (result.decision.eligible) {
      expect(result.decision.positionScenarios).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "trim", quantityMicros: 1_500_000 }),
          expect.objectContaining({ kind: "add", basis: "user_budget" }),
        ]),
      );
    }
  });

  it("suppresses numeric output when the quote is demo data", async () => {
    const demoMeta = {
      ...freshMeta,
      dataMode: "demo" as const,
      mode: "demo" as const,
      freshness: { state: "fixture" as const, asOf: snapshot.asOf, ageSeconds: null },
    };
    const result = await getPortfolioDecisionSupport(
      "owner-a",
      request,
      dependencies({
        getSnapshot: vi.fn().mockResolvedValue({ data: snapshot, meta: demoMeta }),
      }),
    );

    expect(result.decision).toMatchObject({
      eligible: false,
      suppressedReasons: expect.arrayContaining([
        "live_market_data_required",
        "fresh_market_data_required",
      ]),
    });
    expect("zones" in result.decision).toBe(false);
  });

  it("suppresses numeric output when a live quote is stale", async () => {
    const staleLiveMeta = {
      ...freshMeta,
      freshness: {
        state: "stale" as const,
        asOf: "2026-11-12T17:00:00.000Z",
        ageSeconds: 3_600,
      },
    };
    const result = await getPortfolioDecisionSupport(
      "owner-a",
      request,
      dependencies({
        getSnapshot: vi.fn().mockResolvedValue({
          data: { ...snapshot, asOf: "2026-11-12T17:00:00.000Z" },
          meta: staleLiveMeta,
        }),
      }),
    );

    expect(result.decision).toMatchObject({
      eligible: false,
      suppressedReasons: ["fresh_market_data_required"],
    });
    expect("zones" in result.decision).toBe(false);
    expect("positionScenarios" in result.decision).toBe(false);
  });

  it("suppresses numeric output when the intelligence feed is not live and fresh", async () => {
    const staleDemoMeta = {
      ...freshMeta,
      dataMode: "demo" as const,
      mode: "demo" as const,
      freshness: {
        state: "stale" as const,
        asOf: "2026-11-11T12:00:00.000Z",
        ageSeconds: 108_000,
      },
    };
    const result = await getPortfolioDecisionSupport(
      "owner-a",
      request,
      dependencies({
        getIntelligence: vi.fn().mockResolvedValue({
          data: [
            evidence("news-1", "alpaca"),
            evidence("filing-1", "sec-edgar", "sec_filing"),
          ],
          meta: staleDemoMeta,
        }),
      }),
    );

    expect(result.decision).toEqual({
      eligible: false,
      symbolId: "NASDAQ:NVDA",
      suppressedReasons: ["live_evidence_required", "fresh_evidence_required"],
      tradeExecutionAllowed: false,
      modelOutputRole: "scenario_math_only",
    });
    expect("zones" in result.decision).toBe(false);
    expect(result.context).toMatchObject({
      evidenceDataMode: "demo",
      evidenceFreshness: "stale",
    });
  });

  it("excludes invalid, future, and out-of-window evidence and bounds citations", async () => {
    const validEvidence = Array.from({ length: 14 }, (_, index) =>
      evidence(`valid-${index}`, `provider-${index}`),
    );
    const invalidPublished = {
      ...evidence("invalid", "invalid-provider"),
      publishedAt: "not-a-date",
    };
    const futureReceived = {
      ...evidence("future", "future-provider"),
      receivedAt: "2026-11-12T18:06:00.000Z",
    };
    const tooOld = {
      ...evidence("old", "old-provider"),
      publishedAt: "2026-11-05T17:59:59.999Z",
    };
    const result = await getPortfolioDecisionSupport(
      "owner-a",
      request,
      dependencies({
        getIntelligence: vi.fn().mockResolvedValue({
          data: [...validEvidence, invalidPublished, futureReceived, tooOld],
          meta: freshMeta,
        }),
      }),
    );

    expect(result.context.evidenceCount).toBe(14);
    expect(result.context.providerStreamCount).toBe(14);
    expect(result.context.evidence).toHaveLength(12);
    expect(result.context.evidence.map(({ id }) => id)).not.toEqual(
      expect.arrayContaining(["invalid", "future", "old"]),
    );
  });

  it("returns an explicit unavailable result rather than inventing a price", async () => {
    const result = await getPortfolioDecisionSupport(
      "owner-a",
      request,
      dependencies({
        getSnapshot: vi.fn().mockResolvedValue({ data: null, meta: freshMeta }),
      }),
    );

    expect(result.decision).toEqual({
      eligible: false,
      symbolId: "NASDAQ:NVDA",
      suppressedReasons: ["market_data_unavailable"],
      tradeExecutionAllowed: false,
      modelOutputRole: "scenario_math_only",
    });
    expect(result.context).toMatchObject({
      hasHolding: true,
      holding: { symbolId: "NASDAQ:NVDA", version: 1 },
      quote: null,
      evidence: [],
    });
  });

  it("verifies canonical exchange identity before requesting market data", async () => {
    const getSnapshot = vi.fn();
    const getIntelligence = vi.fn();
    const resolveInstrument = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error("unsupported"), {
        code: "symbol_not_supported",
      }));

    await expect(
      getPortfolioDecisionSupport(
        "owner-a",
        { ...request, symbol_id: "FAKE:NVDA" },
        dependencies({
          resolveInstrument,
          getSnapshot,
          getIntelligence,
        }),
      ),
    ).rejects.toMatchObject({ code: "symbol_not_supported" });
    expect(resolveInstrument).toHaveBeenCalledWith("FAKE:NVDA");
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(getIntelligence).not.toHaveBeenCalled();
  });
});
