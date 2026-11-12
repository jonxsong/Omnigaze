import { describe, expect, it } from "vitest";
import { buildDecisionSupport } from "@/lib/portfolio/decision-support";

const baseInput = {
  symbolId: "NASDAQ:NVDA" as const,
  holdingQuantityMicros: 15_000_000,
  userBudgetMicros: 1_000_000_000,
  market: {
    priceMicros: 160_000_000,
    asOf: "2026-11-12T18:00:00.000Z",
    dataMode: "live" as const,
    freshness: "fresh" as const,
  },
  evidence: {
    evidenceIds: ["filing-1", "news-1", "news-2"],
    independentSourceCount: 3,
    materialEventCount: 2,
    contradictorySignalCount: 1,
    hasRecentFiling: true,
  },
  preset: "balanced" as const,
};

describe("deterministic decision support", () => {
  it("calculates review zones and position scenarios without delegating math to AI", () => {
    const result = buildDecisionSupport(baseInput);

    expect(result.eligible).toBe(true);
    if (!result.eligible) return;

    expect(result.zones).toEqual([
      expect.objectContaining({
        kind: "pullback_review",
        priceMicros: 150_400_000,
        distanceBps: -600,
      }),
      expect.objectContaining({
        kind: "strength_review",
        priceMicros: 176_000_000,
        distanceBps: 1_000,
      }),
      expect.objectContaining({
        kind: "downside_review",
        priceMicros: 140_800_000,
        distanceBps: -1_200,
      }),
    ]);
    expect(result.positionScenarios).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "trim",
          quantityMicros: 1_500_000,
          fractionBps: 1_000,
        }),
        expect.objectContaining({
          kind: "add",
          quantityMicros: 6_648_936,
          fractionBps: 10_000,
        }),
      ]),
    );
    expect(result.tradeExecutionAllowed).toBe(false);
    expect(result.modelOutputRole).toBe("scenario_math_only");
  });

  it("defines confidence as evidence coverage rather than return probability", () => {
    const result = buildDecisionSupport(baseInput);

    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.evidenceConfidence.score).toBeLessThanOrEqual(0.85);
    expect(result.evidenceConfidence.meaning).toContain("not a probability");
    expect(result.evidenceConfidence.meaning).not.toContain("agreement");
    expect(result.evidenceConfidence.sourceDiversity).toEqual({
      independentSourceCount: 3,
      label: "multiple_streams",
      meaning:
        "Evidence spans multiple provider streams. Omnigaze has not measured whether those sources agree.",
    });
    expect(result.evidenceConfidence.evidenceIds).toEqual([
      "filing-1",
      "news-1",
      "news-2",
    ]);
  });

  it.each([
    {
      market: { ...baseInput.market, dataMode: "demo" as const },
      reason: "live_market_data_required",
    },
    {
      market: { ...baseInput.market, freshness: "stale" as const },
      reason: "fresh_market_data_required",
    },
  ])("suppresses numeric scenarios for $reason", ({ market, reason }) => {
    const result = buildDecisionSupport({ ...baseInput, market });

    expect(result).toMatchObject({
      eligible: false,
      suppressedReasons: expect.arrayContaining([reason]),
      tradeExecutionAllowed: false,
    });
    expect("zones" in result).toBe(false);
  });

  it("requires at least two attributable evidence items before showing numeric scenarios", () => {
    const result = buildDecisionSupport({
      ...baseInput,
      evidence: {
        ...baseInput.evidence,
        evidenceIds: ["one-source"],
        independentSourceCount: 1,
      },
    });

    expect(result).toMatchObject({
      eligible: false,
      suppressedReasons: ["insufficient_evidence"],
    });
  });

  it("allows one provider stream but caps evidence confidence at limited", () => {
    const result = buildDecisionSupport({
      ...baseInput,
      evidence: {
        ...baseInput.evidence,
        evidenceIds: ["news-1", "news-2", "news-3", "news-4", "filing-1"],
        independentSourceCount: 1,
        materialEventCount: 4,
        contradictorySignalCount: 0,
        hasRecentFiling: true,
      },
    });

    expect(result.eligible).toBe(true);
    if (!result.eligible) return;
    expect(result.evidenceConfidence).toMatchObject({
      score: 0.44,
      label: "limited",
      meaning:
        "Evidence coverage only; this is not a probability of price direction or return.",
      sourceDiversity: {
        independentSourceCount: 1,
        label: "single_stream",
      },
    });
    expect(result.evidenceConfidence.score).toBeLessThan(0.45);
    expect(result.evidenceConfidence.sourceDiversity.meaning).toContain(
      "has not measured source agreement",
    );
  });

  it("rejects unsafe numeric inputs at the deterministic boundary", () => {
    expect(() =>
      buildDecisionSupport({ ...baseInput, holdingQuantityMicros: 1.5 }),
    ).toThrow(/non-negative safe integer/);

    expect(() =>
      buildDecisionSupport({
        ...baseInput,
        market: {
          ...baseInput.market,
          priceMicros: Number.MAX_SAFE_INTEGER,
        },
      }),
    ).toThrow(/safe-integer range/);

    expect(() =>
      buildDecisionSupport({
        ...baseInput,
        evidence: {
          ...baseInput.evidence,
          independentSourceCount: -1,
        },
      }),
    ).toThrow(/non-negative safe integer/);
  });
});
