import { describe, expect, it } from "vitest";
import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import {
  calculatePortfolioPulse,
  MAX_PORTFOLIO_PULSE_POSITIONS,
  PortfolioPulseCalculationError,
  type PortfolioPulseHoldingInput,
  type PortfolioPulseSnapshotInput,
} from "@/lib/portfolio/portfolio-pulse";

const NOW = "2026-11-12T18:00:00.000Z";

function holding(
  symbolId: CanonicalSymbol,
  quantity: string,
  averageCost: string | null = null,
): PortfolioPulseHoldingInput {
  return {
    symbolId,
    ticker: symbolId.split(":")[1],
    exchange: symbolId.split(":")[0],
    name: `${symbolId} Incorporated`,
    quantity,
    averageCost,
    costCurrency: "USD",
  };
}

function quote(
  symbolId: CanonicalSymbol,
  price: number,
  previousClose: number,
  options: {
    asOf?: string;
    dataMode?: "live" | "demo";
    freshness?: "fresh" | "stale" | "unknown" | "fixture";
    provider?: string;
    marketCoverage?: "limited-exchange" | "consolidated" | "fixture";
    isDelayed?: boolean;
    freshnessAsOf?: string | null;
    ageSeconds?: number | null;
  } = {},
): PortfolioPulseSnapshotInput {
  const asOf = options.asOf ?? "2026-11-12T17:59:45.000Z";
  const dataMode = options.dataMode ?? "live";
  const freshness = options.freshness ?? "fresh";
  const marketCoverage = options.marketCoverage ?? "limited-exchange";
  const data: MarketSnapshot = {
    symbolId,
    asOf,
    session: "regular",
    price,
    previousClose,
    change: price - previousClose,
    changePercent: ((price - previousClose) / previousClose) * 100,
    volume: 1_000,
    marketCap: "Unavailable",
    isDelayed: options.isDelayed ?? false,
    delaySeconds: options.isDelayed ? 900 : 0,
    provider: options.provider ?? "test-provider",
    marketCoverage,
  };
  return {
    data,
    meta: {
      dataMode,
      mode: dataMode,
      providerCoverage:
        dataMode === "demo" || marketCoverage === "fixture"
          ? "demo"
          : "complete",
      coverage:
        dataMode === "demo" || marketCoverage === "fixture"
          ? "demo"
          : "complete",
      freshness: {
        state: freshness,
        asOf:
          options.freshnessAsOf === undefined ? asOf : options.freshnessAsOf,
        ageSeconds:
          options.ageSeconds === undefined
            ? freshness === "fixture"
              ? null
              : Math.max(0, Math.round((Date.parse(NOW) - Date.parse(asOf)) / 1_000))
            : options.ageSeconds,
      },
    },
  };
}

function snapshotMap(...snapshots: PortfolioPulseSnapshotInput[]) {
  return new Map(
    snapshots.map((snapshot) => [snapshot.data!.symbolId, snapshot] as const),
  );
}

function calculate(
  holdings: readonly PortfolioPulseHoldingInput[],
  snapshots: ReadonlyMap<CanonicalSymbol, PortfolioPulseSnapshotInput>,
  sourcePositionCount?: number,
  calculatedAt = NOW,
) {
  return calculatePortfolioPulse({
    holdings,
    snapshots,
    calculatedAt,
    ...(sourcePositionCount === undefined ? {} : { sourcePositionCount }),
  });
}

describe("portfolio pulse fixed-point calculator", () => {
  it("calculates exact values, daily impact, cost basis, and totals", () => {
    const result = calculate(
      [
        holding("NASDAQ:NVDA", "15", "140"),
        holding("NASDAQ:MSFT", "2.5", null),
      ],
      snapshotMap(
        quote("NASDAQ:NVDA", 160, 158, {
          asOf: "2026-11-12T17:59:45.000Z",
        }),
        quote("NASDAQ:MSFT", 500.25, 501, {
          asOf: "2026-11-12T17:59:50.000Z",
          isDelayed: true,
        }),
      ),
    );

    expect(result).toMatchObject({
      currency: "USD",
      calculatedAt: NOW,
      asOf: "2026-11-12T17:59:45.000Z",
      tradeExecutionAllowed: false,
      modelOutputRole: "portfolio_math_only",
      totals: {
        currentValue: "3650.625",
        previousCloseValue: "3622.5",
        dayPnl: "28.125",
        dayChangePercent: "0.776398",
        coveredCostBasis: "2100",
        coveredUnrealizedPnl: "300",
      },
      coverage: {
        status: "complete",
        totalPositions: 2,
        includedPositions: 2,
        excludedPositions: 0,
        delayedPositions: 1,
        costBasisPositions: 1,
        costBasisStatus: "partial",
      },
    });
    expect(result.positions).toEqual([
      expect.objectContaining({
        symbolId: "NASDAQ:MSFT",
        quantity: "2.5",
        included: true,
        currentPrice: "500.25",
        previousClosePrice: "501",
        currentValue: "1250.625",
        previousCloseValue: "1252.5",
        dayPnl: "-1.875",
        dayChangePercent: "-0.149701",
        costBasis: null,
        unrealizedPnl: null,
        quote: expect.objectContaining({
          trust: "live_fresh",
          provider: "test-provider",
          freshness: "fresh",
          isDelayed: true,
        }),
      }),
      expect.objectContaining({
        symbolId: "NASDAQ:NVDA",
        quantity: "15",
        averageCost: "140",
        currentValue: "2400",
        previousCloseValue: "2370",
        dayPnl: "30",
        dayChangePercent: "1.265823",
        costBasis: "2100",
        unrealizedPnl: "300",
      }),
    ]);
    expect(
      result.positions.reduce((sum, position) => sum + (position.weightBps ?? 0), 0),
    ).toBe(10_000);
    expect(result.contributors).toEqual({
      positive: [
        expect.objectContaining({ symbolId: "NASDAQ:NVDA", dayPnl: "30" }),
      ],
      negative: [
        expect.objectContaining({ symbolId: "NASDAQ:MSFT", dayPnl: "-1.875" }),
      ],
    });
  });

  it("keeps missing, demo, fixture, stale, and invalid-prior quotes explicit", () => {
    const holdings = [
      holding("NASDAQ:GOOD", "1", "50"),
      holding("NASDAQ:MISSING", "2", "20"),
      holding("NASDAQ:DEMO", "3", "30"),
      holding("NASDAQ:FIXTURE", "4", "40"),
      holding("NASDAQ:STALE", "5", "50"),
      holding("NASDAQ:BADPREV", "6", "60"),
    ];
    const result = calculate(
      holdings,
      snapshotMap(
        quote("NASDAQ:GOOD", 100, 90),
        quote("NASDAQ:DEMO", 30, 29, { dataMode: "demo" }),
        quote("NASDAQ:FIXTURE", 40, 39, {
          freshness: "fixture",
          marketCoverage: "fixture",
        }),
        quote("NASDAQ:STALE", 50, 49, { freshness: "stale" }),
        quote("NASDAQ:BADPREV", 60, 0),
      ),
    );

    expect(result.totals).toEqual({
      currentValue: "100",
      previousCloseValue: "90",
      dayPnl: "10",
      dayChangePercent: "11.111111",
      coveredCostBasis: "50",
      coveredUnrealizedPnl: "50",
    });
    expect(result.coverage).toMatchObject({
      status: "partial",
      totalPositions: 6,
      includedPositions: 1,
      excludedPositions: 5,
    });

    const reasons = Object.fromEntries(
      result.positions.map((position) => [
        position.symbolId,
        {
          included: position.included,
          reason: position.exclusionReason,
          trust: position.quote.trust,
          value: position.currentValue,
        },
      ]),
    );
    expect(reasons).toMatchObject({
      "NASDAQ:GOOD": {
        included: true,
        reason: null,
        trust: "live_fresh",
        value: "100",
      },
      "NASDAQ:MISSING": {
        included: false,
        reason: "missing_quote",
        trust: "missing",
        value: null,
      },
      "NASDAQ:DEMO": {
        included: false,
        reason: "demo_quote",
        trust: "demo",
        value: null,
      },
      "NASDAQ:FIXTURE": {
        included: false,
        reason: "fixture_quote",
        trust: "fixture",
        value: null,
      },
      "NASDAQ:STALE": {
        included: false,
        reason: "stale_quote",
        trust: "stale",
        value: null,
      },
      "NASDAQ:BADPREV": {
        included: false,
        reason: "invalid_previous_close",
        trust: "invalid",
        value: null,
      },
    });
  });

  it("recomputes freshness from calculatedAt instead of trusting provider metadata", () => {
    const staleAsOf = "2020-01-01T00:00:00.000Z";
    const result = calculate(
      [
        holding("NASDAQ:STALE", "1", "50"),
        holding("NASDAQ:BADAGE", "1", "50"),
        holding("NASDAQ:FUTURE", "1", "50"),
      ],
      snapshotMap(
        quote("NASDAQ:STALE", 100, 90, {
          asOf: staleAsOf,
          ageSeconds: 0,
        }),
        quote("NASDAQ:BADAGE", 100, 90, { ageSeconds: 0 }),
        quote("NASDAQ:FUTURE", 100, 90, {
          asOf: "2026-11-12T18:05:01.000Z",
          ageSeconds: 0,
        }),
      ),
    );

    expect(result.calculatedAt).toBe(NOW);
    expect(
      result.positions.map(({ symbolId, exclusionReason, quote }) => ({
        symbolId,
        exclusionReason,
        trust: quote.trust,
        freshness: quote.freshness,
        ageSeconds: quote.ageSeconds,
      })),
    ).toEqual([
      {
        symbolId: "NASDAQ:BADAGE",
        exclusionReason: "unknown_freshness",
        trust: "unknown",
        freshness: "unknown",
        ageSeconds: 15,
      },
      {
        symbolId: "NASDAQ:FUTURE",
        exclusionReason: "unknown_freshness",
        trust: "unknown",
        freshness: "unknown",
        ageSeconds: 0,
      },
      {
        symbolId: "NASDAQ:STALE",
        exclusionReason: "stale_quote",
        trust: "stale",
        freshness: "stale",
        ageSeconds: Math.round(
          (Date.parse(NOW) - Date.parse(staleAsOf)) / 1_000,
        ),
      },
    ]);
  });

  it("accepts the bounded freshness edge and five-minute future skew", () => {
    const result = calculate(
      [holding("NASDAQ:EDGE", "1"), holding("NASDAQ:SKEW", "1")],
      snapshotMap(
        quote("NASDAQ:EDGE", 10, 9, {
          asOf: "2026-11-12T17:40:00.000Z",
        }),
        quote("NASDAQ:SKEW", 10, 9, {
          asOf: "2026-11-12T18:05:00.000Z",
        }),
      ),
    );

    expect(result.coverage.status).toBe("complete");
    expect(result.positions.map(({ quote: metadata }) => metadata.ageSeconds)).toEqual([
      1_200,
      0,
    ]);
  });

  it("excludes values below one micro-dollar while retaining exact minimums", () => {
    const result = calculate(
      [
        holding("NASDAQ:MINPRICE", "1"),
        holding("NASDAQ:MINQTY", "0.000001"),
        holding("NASDAQ:PREVUNDER", "0.000001"),
        holding("NASDAQ:UNDER", "0.000001"),
      ],
      snapshotMap(
        quote("NASDAQ:MINPRICE", 0.000001, 0.000001),
        quote("NASDAQ:MINQTY", 1, 1),
        quote("NASDAQ:PREVUNDER", 1, 0.000001),
        quote("NASDAQ:UNDER", 0.000001, 0.000001),
      ),
    );

    expect(result.positions).toEqual([
      expect.objectContaining({
        symbolId: "NASDAQ:MINPRICE",
        included: true,
        currentValue: "0.000001",
        previousCloseValue: "0.000001",
      }),
      expect.objectContaining({
        symbolId: "NASDAQ:MINQTY",
        included: true,
        currentValue: "0.000001",
        previousCloseValue: "0.000001",
      }),
      expect.objectContaining({
        symbolId: "NASDAQ:PREVUNDER",
        included: false,
        exclusionReason: "value_below_minimum_precision",
        currentValue: null,
      }),
      expect.objectContaining({
        symbolId: "NASDAQ:UNDER",
        included: false,
        exclusionReason: "value_below_minimum_precision",
        currentValue: null,
      }),
    ]);
    expect(result.totals.currentValue).toBe("0.000002");
  });

  it("returns unavailable totals rather than inventing zero for no usable quotes", () => {
    const result = calculate(
      [holding("NASDAQ:NVDA", "15", "140")],
      new Map(),
    );

    expect(result.asOf).toBeNull();
    expect(result.coverage).toEqual({
      status: "none",
      totalPositions: 1,
      consideredPositions: 1,
      omittedPositions: 0,
      truncated: false,
      includedPositions: 0,
      excludedPositions: 1,
      delayedPositions: 0,
      costBasisPositions: 0,
      costBasisStatus: "none",
    });
    expect(result.totals).toEqual({
      currentValue: null,
      previousCloseValue: null,
      dayPnl: null,
      dayChangePercent: null,
      coveredCostBasis: null,
      coveredUnrealizedPnl: null,
    });
  });

  it("uses BigInt arithmetic beyond Number safe integer output ranges", () => {
    const result = calculate(
      [holding("NYSE:MAX", "1000000000", "9999999.5")],
      snapshotMap(quote("NYSE:MAX", 10_000_000, 9_999_999.999999)),
    );

    expect(result.positions[0]).toMatchObject({
      currentValue: "10000000000000000",
      previousCloseValue: "9999999999999000",
      dayPnl: "1000",
      costBasis: "9999999500000000",
      unrealizedPnl: "500000000",
      weightBps: 10_000,
    });
    expect(result.totals.currentValue).toBe("10000000000000000");
  });

  it("orders equal contributors and allocates equal weights deterministically", () => {
    const result = calculate(
      [
        holding("NASDAQ:CCC", "1"),
        holding("NASDAQ:BBB", "1"),
        holding("NASDAQ:AAA", "1"),
      ],
      snapshotMap(
        quote("NASDAQ:AAA", 101, 100),
        quote("NASDAQ:BBB", 101, 100),
        quote("NASDAQ:CCC", 99, 100),
      ),
    );

    expect(result.contributors.positive.map(({ symbolId }) => symbolId)).toEqual([
      "NASDAQ:AAA",
      "NASDAQ:BBB",
    ]);
    expect(result.contributors.negative.map(({ symbolId }) => symbolId)).toEqual([
      "NASDAQ:CCC",
    ]);
    expect(
      result.positions.map(({ symbolId, weightBps }) => ({ symbolId, weightBps })),
    ).toEqual([
      { symbolId: "NASDAQ:AAA", weightBps: 3356 },
      { symbolId: "NASDAQ:BBB", weightBps: 3355 },
      { symbolId: "NASDAQ:CCC", weightBps: 3289 },
    ]);
  });

  it("excludes invalid holding decimals and duplicate symbols", () => {
    const result = calculate(
      [
        holding("NASDAQ:BADQ", "0", "10"),
        holding("NASDAQ:BADC", "1", "1.0000001"),
        holding("NASDAQ:DUP", "1", "10"),
        holding("NASDAQ:DUP", "2", "20"),
      ],
      snapshotMap(
        quote("NASDAQ:BADQ", 10, 9),
        quote("NASDAQ:BADC", 10, 9),
        quote("NASDAQ:DUP", 10, 9),
      ),
    );

    expect(result.coverage.status).toBe("none");
    expect(result.positions.every(({ quote }) => quote.trust === "live_fresh")).toBe(
      true,
    );
    expect(result.positions.map(({ exclusionReason }) => exclusionReason)).toEqual([
      "invalid_average_cost",
      "invalid_quantity",
      "duplicate_symbol",
      "duplicate_symbol",
    ]);
  });

  it("hard-bounds the calculation to fifty positions", () => {
    const holdings = Array.from(
      { length: MAX_PORTFOLIO_PULSE_POSITIONS + 1 },
      (_, index) => holding(`NASDAQ:T${index}` as CanonicalSymbol, "1"),
    );

    expect(() => calculate(holdings, new Map())).toThrowError(
      PortfolioPulseCalculationError,
    );
    expect(() => calculate(holdings, new Map())).toThrowError(
      "too_many_positions",
    );
  });

  it("requires a canonical deterministic evaluation timestamp", () => {
    expect(() =>
      calculatePortfolioPulse({
        holdings: [],
        snapshots: new Map(),
        calculatedAt: "not-a-timestamp",
      }),
    ).toThrowError("invalid_calculated_at");
    expect(() =>
      calculatePortfolioPulse({
        holdings: [],
        snapshots: new Map(),
        calculatedAt: "2026-11-12T10:00:00.000-08:00",
      }),
    ).toThrowError("invalid_calculated_at");
  });

  it("reports caller-side truncation without claiming complete coverage", () => {
    const result = calculate(
      [holding("NASDAQ:NVDA", "15", "140")],
      snapshotMap(quote("NASDAQ:NVDA", 160, 158)),
      2,
    );

    expect(result.coverage).toMatchObject({
      status: "partial",
      totalPositions: 2,
      consideredPositions: 1,
      omittedPositions: 1,
      truncated: true,
      includedPositions: 1,
      excludedPositions: 0,
      costBasisStatus: "partial",
    });
  });
});
