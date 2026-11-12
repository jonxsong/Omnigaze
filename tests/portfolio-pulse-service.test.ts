import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/repositories/portfolio", () => ({
  getPortfolioPulseHoldings: vi.fn(),
}));

vi.mock("@/lib/services/live-market-data", () => ({
  liveMarketData: { getSnapshots: vi.fn() },
}));

import type { CanonicalSymbol } from "@/lib/market-types";
import {
  calculatePortfolioPulse,
  type PortfolioPulseHoldingInput,
  type PortfolioPulseSnapshotInput,
} from "@/lib/portfolio/portfolio-pulse";
import {
  getPortfolioPulse,
  type PortfolioPulseDependencies,
} from "@/lib/services/portfolio-pulse";

function holding(
  symbolId: CanonicalSymbol,
  overrides: Partial<PortfolioPulseHoldingInput> = {},
) {
  const [exchange, ticker] = symbolId.split(":");
  return {
    symbolId,
    ticker,
    exchange,
    name: `${ticker} Incorporated`,
    quantity: "2",
    averageCost: "90",
    totalCostBasis: "180",
    costCurrency: "USD",
    quantityAsOf: "2026-11-01T12:00:00.000Z",
    entrySource: "user_entered",
    version: 1,
    createdAt: "2026-11-01T12:00:00.000Z",
    updatedAt: "2026-11-01T12:00:00.000Z",
    ...overrides,
  };
}

function snapshot(
  symbolId: CanonicalSymbol,
  options: {
    dataMode?: "live" | "demo";
    freshness?: "fresh" | "stale" | "unknown" | "fixture";
    marketCoverage?: "limited-exchange" | "consolidated" | "fixture";
    price?: number;
    previousClose?: number;
  } = {},
): PortfolioPulseSnapshotInput {
  const dataMode = options.dataMode ?? "live";
  const freshness = options.freshness ?? "fresh";
  const marketCoverage = options.marketCoverage ?? "limited-exchange";
  const coverage =
    dataMode === "demo" || freshness === "fixture" || marketCoverage === "fixture"
      ? "demo"
      : "partial";
  return {
    data: {
      symbolId,
      asOf: "2026-11-12T16:59:45.000Z",
      session: "regular",
      price: options.price ?? 100,
      previousClose: options.previousClose ?? 95,
      change: 5,
      changePercent: 5.26,
      volume: 1_000,
      marketCap: "Unavailable",
      isDelayed: false,
      delaySeconds: 0,
      provider: dataMode === "live" ? "test-provider" : "demo-fixture",
      marketCoverage,
    },
    meta: {
      dataMode,
      mode: dataMode,
      providerCoverage: coverage,
      coverage,
      freshness: {
        state: freshness,
        asOf: "2026-11-12T16:59:45.000Z",
        ageSeconds: 15,
      },
    },
  };
}

function dependencies(
  holdings: ReturnType<typeof holding>[],
  snapshots: ReadonlyMap<CanonicalSymbol, PortfolioPulseSnapshotInput>,
  totalPositions = holdings.length,
) {
  return {
    getHoldings: vi.fn(async () => ({ holdings, totalPositions })),
    getSnapshots: vi.fn(async (symbols: CanonicalSymbol[]) => {
      void symbols;
      return snapshots;
    }),
    calculate: calculatePortfolioPulse,
    now: () => new Date("2026-11-12T17:00:00.000Z"),
  } satisfies PortfolioPulseDependencies;
}

describe("portfolio pulse service", () => {
  it("reads only the authenticated owner's durable holdings and makes one snapshot batch", async () => {
    const ownerHoldings = [
      holding("NASDAQ:NVDA"),
      holding("NASDAQ:MSFT", { quantity: "3", averageCost: "80" }),
    ];
    const deps = dependencies(
      ownerHoldings,
      new Map([
        ["NASDAQ:NVDA", snapshot("NASDAQ:NVDA")],
        ["NASDAQ:MSFT", snapshot("NASDAQ:MSFT", { price: 120, previousClose: 100 })],
      ]),
    );

    const result = await getPortfolioPulse("owner-a", deps);

    expect(deps.getHoldings).toHaveBeenCalledOnce();
    expect(deps.getHoldings).toHaveBeenCalledWith("owner-a");
    expect(deps.getSnapshots).toHaveBeenCalledOnce();
    expect(deps.getSnapshots).toHaveBeenCalledWith([
      "NASDAQ:NVDA",
      "NASDAQ:MSFT",
    ]);
    expect(result).toMatchObject({
      calculatedAt: "2026-11-12T17:00:00.000Z",
      tradeExecutionAllowed: false,
      modelOutputRole: "portfolio_math_only",
      coverage: {
        status: "complete",
        totalPositions: 2,
        consideredPositions: 2,
        omittedPositions: 0,
        truncated: false,
        includedPositions: 2,
      },
    });
  });

  it("skips provider work for an empty portfolio", async () => {
    const deps = dependencies([], new Map());

    const result = await getPortfolioPulse("owner-empty", deps);

    expect(deps.getSnapshots).not.toHaveBeenCalled();
    expect(result.coverage).toMatchObject({
      status: "none",
      totalPositions: 0,
      consideredPositions: 0,
      omittedPositions: 0,
      includedPositions: 0,
    });
    expect(result.positions).toEqual([]);
  });

  it("uses the repository's first 50 holdings and reports truthful truncation", async () => {
    const ownerHoldings = Array.from({ length: 50 }, (_, index) =>
      holding(`NASDAQ:T${index.toString().padStart(2, "0")}` as CanonicalSymbol),
    );
    const deps = dependencies(ownerHoldings, new Map(), 52);

    const result = await getPortfolioPulse("owner-large", deps);

    expect(deps.getSnapshots).toHaveBeenCalledOnce();
    const requested = deps.getSnapshots.mock.calls[0]?.[0];
    expect(requested).toHaveLength(50);
    expect(requested?.[0]).toBe("NASDAQ:T00");
    expect(requested?.[49]).toBe("NASDAQ:T49");
    expect(requested).not.toContain("NASDAQ:T50");
    expect(result.coverage).toMatchObject({
      status: "none",
      totalPositions: 52,
      consideredPositions: 50,
      omittedPositions: 2,
      truncated: true,
      includedPositions: 0,
      excludedPositions: 50,
    });
  });

  it("keeps a fresh live peer when demo, stale, and missing peers are excluded", async () => {
    const ownerHoldings = [
      holding("NASDAQ:LIVE"),
      holding("NASDAQ:DEMO"),
      holding("NASDAQ:STALE"),
      holding("NASDAQ:MISSING"),
    ];
    const deps = dependencies(
      ownerHoldings,
      new Map([
        ["NASDAQ:LIVE", snapshot("NASDAQ:LIVE")],
        [
          "NASDAQ:DEMO",
          snapshot("NASDAQ:DEMO", {
            dataMode: "demo",
            freshness: "fixture",
            marketCoverage: "fixture",
          }),
        ],
        [
          "NASDAQ:STALE",
          snapshot("NASDAQ:STALE", { freshness: "stale" }),
        ],
      ]),
    );

    const result = await getPortfolioPulse("owner-partial", deps);

    expect(result.coverage).toMatchObject({
      status: "partial",
      includedPositions: 1,
      excludedPositions: 3,
    });
    expect(result.positions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ symbolId: "NASDAQ:LIVE", included: true }),
        expect.objectContaining({
          symbolId: "NASDAQ:DEMO",
          included: false,
          exclusionReason: "demo_quote",
        }),
        expect.objectContaining({
          symbolId: "NASDAQ:STALE",
          included: false,
          exclusionReason: "stale_quote",
        }),
        expect.objectContaining({
          symbolId: "NASDAQ:MISSING",
          included: false,
          exclusionReason: "missing_quote",
        }),
      ]),
    );
    expect(result.totals.currentValue).toBe("200");
  });

  it("propagates an exceptional batch failure instead of relabeling an outage as missing quotes", async () => {
    const failure = new Error("batch binding unavailable");
    const deps = {
      getHoldings: vi.fn(async () => ({
        holdings: [holding("NASDAQ:NVDA")],
        totalPositions: 1,
      })),
      getSnapshots: vi.fn(async () => {
        throw failure;
      }),
      calculate: calculatePortfolioPulse,
      now: () => new Date("2026-11-12T17:00:00.000Z"),
    } satisfies PortfolioPulseDependencies;

    await expect(getPortfolioPulse("owner-a", deps)).rejects.toBe(failure);
    expect(deps.getSnapshots).toHaveBeenCalledOnce();
  });
});
