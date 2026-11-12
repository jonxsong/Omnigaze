import { describe, expect, it } from "vitest";
import {
  buildMoveLens,
  MOVE_LENS_BENCHMARK_NOTICE,
  MOVE_LENS_CAUSATION_NOTICE,
  moveLensBenchmarkSnapshotsFromMarketContext,
  type MoveLensSnapshotInput,
} from "@/lib/move-lens";
import type { MarketContextResult } from "@/lib/market-context";
import type { CanonicalSymbol } from "@/lib/market-types";
import type { IntelligenceFeedItem } from "@/lib/services/live-market-data";

const NOW = "2026-11-12T18:00:00.000Z";
const AS_OF = "2026-11-12T17:59:00.000Z";

function snapshot(
  symbolId: CanonicalSymbol,
  price: number,
  previousClose: number,
  overrides: Partial<NonNullable<MoveLensSnapshotInput["data"]>> = {},
  metaOverrides: Partial<MoveLensSnapshotInput["meta"]> = {},
): MoveLensSnapshotInput {
  const data = {
    symbolId,
    asOf: AS_OF,
    session: "regular" as const,
    price,
    previousClose,
    isDelayed: false,
    delaySeconds: 0,
    provider: "alpaca",
    marketCoverage: "consolidated" as const,
    ...overrides,
  };
  return {
    data,
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "complete",
      coverage: "complete",
      freshness: { state: "fresh", asOf: data.asOf, ageSeconds: 60 },
      ...metaOverrides,
    },
  };
}

function build(
  selected: MoveLensSnapshotInput | undefined,
  spy: MoveLensSnapshotInput | undefined,
  qqq: MoveLensSnapshotInput | undefined,
  evidence: IntelligenceFeedItem[] = [],
) {
  const benchmarkSnapshots = new Map<
    CanonicalSymbol,
    MoveLensSnapshotInput
  >();
  if (spy) benchmarkSnapshots.set("ARCA:SPY", spy);
  if (qqq) benchmarkSnapshots.set("NASDAQ:QQQ", qqq);
  return buildMoveLens({
    selectedSymbolId: "NASDAQ:NVDA",
    selectedSnapshot: selected,
    benchmarkSnapshots,
    evidence,
    evidenceReadStatus: "verified",
    evaluatedAt: NOW,
  });
}

function event(
  options: Partial<IntelligenceFeedItem> = {},
): IntelligenceFeedItem {
  return {
    id: "alpaca:event-1",
    symbolIds: ["NASDAQ:NVDA"],
    source: "Reuters",
    sourceKind: "licensed_news",
    headline: "NVIDIA announces a product update",
    summary: "A sourced development linked to NVIDIA.",
    publishedAt: "2026-11-12T17:00:00.000Z",
    receivedAt: "2026-11-12T17:01:00.000Z",
    sourceUrl: "https://example.com/story",
    materiality: "high",
    isLive: true,
    claimStatus: "reported",
    causalLink: "unassessed",
    isControversial: false,
    ...options,
  };
}

describe("Move Lens deterministic domain", () => {
  it("keeps a negative absolute move visible while classifying relative moves", () => {
    const result = build(
      snapshot("NASDAQ:NVDA", 98, 100),
      snapshot("ARCA:SPY", 95, 100),
      snapshot("NASDAQ:QQQ", 99, 100),
    );

    expect(result.data.status).toBe("complete");
    expect(result.data.selected).toMatchObject({
      status: "available",
      observation: {
        priceChange: -2,
        absoluteMoveBps: -200,
      },
    });
    expect(result.data.benchmarks).toMatchObject([
      {
        key: "spy",
        label: "S&P 500 ETF proxy",
        assetType: "etf_proxy",
        relationship: "ahead",
        relativeMoveBps: 300,
      },
      {
        key: "qqq",
        label: "Nasdaq-100 ETF proxy",
        assetType: "etf_proxy",
        relationship: "behind",
        relativeMoveBps: -100,
      },
    ]);
    expect(result.data.aggregateRelationship).toBe("mixed");
    expect(result.meta).toMatchObject({
      comparableBenchmarkCount: 2,
      requestedBenchmarkCount: 2,
      benchmarkNotice: MOVE_LENS_BENCHMARK_NOTICE,
      causationNotice: MOVE_LENS_CAUSATION_NOTICE,
    });
    expect(result.data).toMatchObject({
      causationAssessment: "not_assessed",
      modelUsed: false,
      tradeExecutionAllowed: false,
    });
  });

  it("uses rounded fixed-point basis-point math and exact equality", () => {
    const result = build(
      snapshot("NASDAQ:NVDA", 100.005, 100),
      snapshot("ARCA:SPY", 100.005, 100),
      snapshot("NASDAQ:QQQ", 100.005, 100),
    );

    expect(result.data.selected).toMatchObject({
      status: "available",
      observation: { absoluteMoveBps: 1 },
    });
    expect(result.data.benchmarks[1]).toMatchObject({
      relationship: "equal",
      relativeMoveBps: 0,
    });
    expect(result.data.aggregateRelationship).toBe("equal");
  });

  it("preserves valid absolute observations but withholds unsafe comparisons", () => {
    const variants: Array<{
      name: string;
      spy: MoveLensSnapshotInput;
      reason: string;
    }> = [
      {
        name: "session",
        spy: snapshot("ARCA:SPY", 101, 100, { session: "after-hours" }),
        reason: "session_mismatch",
      },
      {
        name: "delay",
        spy: snapshot("ARCA:SPY", 101, 100, {
          isDelayed: true,
          delaySeconds: 900,
        }),
        reason: "delay_mismatch",
      },
      {
        name: "coverage",
        spy: snapshot("ARCA:SPY", 101, 100, {
          marketCoverage: "limited-exchange",
        }),
        reason: "coverage_mismatch",
      },
      {
        name: "skew",
        spy: snapshot("ARCA:SPY", 101, 100, {
          asOf: "2026-11-12T17:53:59.000Z",
        }),
        reason: "observation_skew",
      },
    ];

    for (const variant of variants) {
      const result = build(
        snapshot("NASDAQ:NVDA", 102, 100),
        variant.spy,
        snapshot("NASDAQ:QQQ", 101, 100),
      );
      expect(result.data.status, variant.name).toBe("partial");
      expect(result.data.selected.status, variant.name).toBe("available");
      expect(result.data.benchmarks[0], variant.name).toMatchObject({
        status: "available",
        relationship: null,
        relativeMoveBps: null,
        comparisonUnavailableReason: variant.reason,
      });
      expect(result.data.aggregateRelationship, variant.name).toBeNull();
    }
  });

  it("allows exactly five minutes of quote skew and rejects one second more", () => {
    const allowed = build(
      snapshot("NASDAQ:NVDA", 102, 100),
      snapshot("ARCA:SPY", 101, 100, {
        asOf: "2026-11-12T17:54:00.000Z",
      }),
      snapshot("NASDAQ:QQQ", 101, 100),
    );
    const rejected = build(
      snapshot("NASDAQ:NVDA", 102, 100),
      snapshot("ARCA:SPY", 101, 100, {
        asOf: "2026-11-12T17:53:59.000Z",
      }),
      snapshot("NASDAQ:QQQ", 101, 100),
    );

    expect(allowed.data.benchmarks[0].relationship).toBe("ahead");
    expect(rejected.data.benchmarks[0]).toMatchObject({
      relationship: null,
      comparisonUnavailableReason: "observation_skew",
    });
  });

  it("fails closed for demo, stale, mismatched, invalid, and missing quotes", () => {
    const demo = snapshot("ARCA:SPY", 101, 100, {}, {
      dataMode: "demo",
      mode: "demo",
      providerCoverage: "demo",
      coverage: "demo",
      freshness: { state: "fixture", asOf: AS_OF, ageSeconds: null },
    });
    const stale = snapshot("NASDAQ:QQQ", 101, 100, {}, {
      freshness: { state: "stale", asOf: AS_OF, ageSeconds: 4_000 },
    });
    const selected = snapshot("NASDAQ:NVDA", 0, 100);
    const result = build(selected, demo, stale);

    expect(result.data.status).toBe("unavailable");
    expect(result.data.selected).toMatchObject({
      status: "unavailable",
      reason: "invalid_snapshot",
      observation: null,
    });
    expect(result.data.benchmarks[0]).toMatchObject({
      status: "unavailable",
      reason: "demo_suppressed",
    });
    expect(result.data.benchmarks[1]).toMatchObject({
      status: "unavailable",
      reason: "freshness_unverified",
    });
    expect(result.data.aggregateRelationship).toBeNull();
  });

  it("selects the newest exact-symbol live event without upgrading causality", () => {
    const result = build(
      snapshot("NASDAQ:NVDA", 102, 100),
      snapshot("ARCA:SPY", 101, 100),
      snapshot("NASDAQ:QQQ", 101, 100),
      [
        event(),
        event({
          id: "alpaca:event-2",
          headline: "Newer corrected development",
          providerUpdatedAt: "2026-11-12T17:45:00.000Z",
          sourceUrl: "https://example.com/story?api_key=secret",
          claimStatus: "corrected",
          causalLink: "temporal-only",
          isControversial: true,
        }),
        event({
          id: "wrong-symbol",
          symbolIds: ["NASDAQ:MSFT"],
          providerUpdatedAt: "2026-11-12T17:50:00.000Z",
        }),
        event({
          id: "fixture",
          sourceKind: "demo_fixture",
          providerUpdatedAt: "2026-11-12T17:55:00.000Z",
        }),
      ],
    );

    expect(result.data.latestRelatedEvent).toEqual({
      id: "alpaca:event-2",
      symbolIds: ["NASDAQ:NVDA"],
      source: "Reuters",
      sourceKind: "licensed_news",
      headline: "Newer corrected development",
      summary: "A sourced development linked to NVIDIA.",
      publishedAt: "2026-11-12T17:00:00.000Z",
      providerUpdatedAt: "2026-11-12T17:45:00.000Z",
      sourceUrl: null,
      materiality: "high",
      claimStatus: "corrected",
      causalLink: "temporal-only",
      isControversial: true,
    });
    expect(result.data.causationAssessment).toBe("not_assessed");
    expect(result.meta.evidenceStatus).toBe("available");
  });

  it("downgrades stronger upstream causality before HTTP or MCP reuse", () => {
    const result = build(
      snapshot("NASDAQ:NVDA", 102, 100),
      snapshot("ARCA:SPY", 101, 100),
      snapshot("NASDAQ:QQQ", 101, 100),
      [event({ causalLink: "supported" })],
    );

    expect(result.data.latestRelatedEvent?.causalLink).toBe("unassessed");
    expect(result.data.causationAssessment).toBe("not_assessed");
  });

  it("marks an unavailable evidence read without reusing unverified events", () => {
    const result = buildMoveLens({
      selectedSymbolId: "NASDAQ:NVDA",
      selectedSnapshot: snapshot("NASDAQ:NVDA", 102, 100),
      benchmarkSnapshots: new Map([
        ["ARCA:SPY", snapshot("ARCA:SPY", 101, 100)],
        ["NASDAQ:QQQ", snapshot("NASDAQ:QQQ", 101, 100)],
      ]),
      evidence: [event()],
      evidenceReadStatus: "unavailable",
      evaluatedAt: NOW,
    });

    expect(result.data.latestRelatedEvent).toBeNull();
    expect(result.meta.evidenceStatus).toBe("unavailable");
  });

  it("adapts only exact SPY and QQQ observations from Market Context", () => {
    const context: MarketContextResult = {
      data: [
        {
          key: "us-large-cap",
          symbolId: "ARCA:SPY",
          ticker: "SPY",
          label: "S&P 500 ETF proxy",
          assetType: "etf_proxy",
          status: "live",
          snapshot: {
            ...snapshot("ARCA:SPY", 101, 100).data!,
            change: 1,
            changePercent: 1,
            volume: 1,
          },
        },
        {
          key: "us-growth",
          symbolId: "NASDAQ:QQQ",
          ticker: "QQQ",
          label: "Nasdaq-100 ETF proxy",
          assetType: "etf_proxy",
          status: "stale",
          snapshot: {
            ...snapshot("NASDAQ:QQQ", 101, 100).data!,
            change: 1,
            changePercent: 1,
            volume: 1,
          },
        },
      ] as MarketContextResult["data"],
      meta: {
        status: "partial",
        requestedCount: 6,
        liveCount: 1,
        staleCount: 1,
        demoCount: 0,
        unavailableCount: 4,
        availabilityCoverage: "partial",
        marketCoverage: "complete",
        generatedAt: NOW,
        notice:
          "Provider-backed ETF proxies. Values are not the underlying index, yield, volatility index, or spot commodity.",
      },
    };

    const adapted = moveLensBenchmarkSnapshotsFromMarketContext(context, NOW);
    expect(adapted.get("ARCA:SPY")?.meta.freshness.state).toBe("fresh");
    expect(adapted.get("NASDAQ:QQQ")?.meta.freshness.state).toBe("stale");
  });
});
