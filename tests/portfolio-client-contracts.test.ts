import { describe, expect, it } from "vitest";
import {
  formatMicrosAsQuantity,
  formatMicrosAsUsd,
  isEligibleDecisionCurrent,
  parseDecisionSupportEnvelope,
  parseHoldingMutationEnvelope,
  PortfolioClientContractError,
  validateScenarioBudget,
  validatePositionFields,
} from "@/lib/portfolio/client-contracts";

const holding = {
  symbolId: "NASDAQ:NVDA",
  ticker: "NVDA",
  exchange: "NASDAQ",
  name: "NVIDIA Corporation",
  quantity: "15.25",
  averageCost: "140.5",
  costCurrency: "USD",
  quantityAsOf: "2026-11-12T18:00:00.000Z",
  version: 2,
};

const eligibleEnvelope = {
  data: {
    decision: {
      eligible: true,
      symbolId: "NASDAQ:NVDA",
      asOf: "2026-11-12T18:00:00.000Z",
      preset: "balanced",
      zones: [
        {
          kind: "pullback_review",
          priceMicros: 150_125_000,
          distanceBps: -600,
          explanation: "Review the evidence after a pullback.",
        },
      ],
      positionScenarios: [],
      evidenceConfidence: {
        score: 0.65,
        label: "moderate",
        meaning: "Evidence coverage, not a return probability.",
        evidenceIds: ["news-1", "filing-1"],
      },
      assumptions: ["This is a review range, not a forecast."],
      tradeExecutionAllowed: false,
      modelOutputRole: "scenario_math_only",
    },
    context: {
      horizon: "near_term",
      hasHolding: true,
      evidenceCount: 2,
      independentSourceCount: 2,
      holding: {
        symbolId: "NASDAQ:NVDA",
        quantity: "15.25",
        version: 2,
      },
      quote: {
        price: 160,
        asOf: "2026-11-12T18:00:00.000Z",
        freshUntil: "2026-11-12T18:20:00.000Z",
        provider: "Alpaca iex",
        marketCoverage: "limited-exchange",
        isDelayed: false,
        delaySeconds: 0,
      },
      evidence: [
        {
          id: "news-1",
          headline: "Material company update",
          source: "alpaca",
          sourceKind: "licensed_news",
          publishedAt: "2026-11-12T17:00:00.000Z",
          sourceUrl: "https://example.test/news-1",
          materiality: "high",
        },
        {
          id: "filing-1",
          headline: "Quarterly filing",
          source: "sec-edgar",
          sourceKind: "sec_filing",
          publishedAt: "2026-11-12T16:00:00.000Z",
          sourceUrl: "https://example.test/filing-1",
          materiality: "high",
        },
      ],
    },
  },
  meta: {
    purpose: "research_scenarios",
    tradeExecutionAllowed: false,
    generatedAt: "2026-11-12T18:00:01.000Z",
  },
};

describe("portfolio dashboard response contracts", () => {
  it("rejects holding responses for a different canonical identity", () => {
    expect(() =>
      parseHoldingMutationEnvelope(
        { data: holding },
        "NYSE:NVDA",
      ),
    ).toThrowError(PortfolioClientContractError);
  });

  it("accepts only non-executing scenario math for the requested symbol", () => {
    const result = parseDecisionSupportEnvelope(
      eligibleEnvelope,
      "NASDAQ:NVDA",
    );
    expect(result.decision.eligible).toBe(true);

    expect(() =>
      parseDecisionSupportEnvelope(
        {
          ...eligibleEnvelope,
          data: {
            ...eligibleEnvelope.data,
            decision: {
              ...eligibleEnvelope.data.decision,
              tradeExecutionAllowed: true,
            },
          },
        },
        "NASDAQ:NVDA",
      ),
    ).toThrowError(PortfolioClientContractError);
  });

  it("rejects suppressed results that retain numeric scenario fields", () => {
    expect(() =>
      parseDecisionSupportEnvelope(
        {
          ...eligibleEnvelope,
          data: {
            ...eligibleEnvelope.data,
            decision: {
              eligible: false,
              symbolId: "NASDAQ:NVDA",
              suppressedReasons: ["fresh_market_data_required"],
              zones: [],
              tradeExecutionAllowed: false,
              modelOutputRole: "scenario_math_only",
            },
          },
        },
        "NASDAQ:NVDA",
      ),
    ).toThrowError(PortfolioClientContractError);
  });

  it("validates exact-decimal editor inputs", () => {
    expect(validatePositionFields(" 15.125 ", "140.50")).toEqual({
      success: true,
      quantity: "15.125",
      averageCost: "140.50",
    });
    expect(validatePositionFields("0", "140").success).toBe(false);
    expect(validatePositionFields("1.0000001", "140").success).toBe(false);
    expect(validatePositionFields("1", "-1").success).toBe(false);
    expect(validateScenarioBudget("")).toEqual({ success: true, budget: null });
    expect(validateScenarioBudget("2500.50")).toEqual({
      success: true,
      budget: "2500.50",
    });
    expect(validateScenarioBudget("0").success).toBe(false);
  });

  it("formats micros without floating-point portfolio math", () => {
    expect(formatMicrosAsUsd(150_125_000)).toBe("$150.13");
    expect(formatMicrosAsQuantity(1_250_000)).toBe("1.25");
  });

  it("suppresses eligible numbers once quote context is stale", () => {
    const parsed = parseDecisionSupportEnvelope(
      eligibleEnvelope,
      "NASDAQ:NVDA",
    );
    if (!parsed.decision.eligible) throw new Error("expected eligible decision");

    expect(
      isEligibleDecisionCurrent(parsed.decision, {
        expectedSymbol: "NASDAQ:NVDA",
        quoteState: "fresh",
        now: Date.parse("2026-11-12T18:10:00.000Z"),
      }),
    ).toBe(true);
    expect(
      isEligibleDecisionCurrent(parsed.decision, {
        expectedSymbol: "NASDAQ:NVDA",
        quoteState: "stale",
        now: Date.parse("2026-11-12T18:10:00.000Z"),
      }),
    ).toBe(false);
    expect(
      isEligibleDecisionCurrent(parsed.decision, {
        expectedSymbol: "NASDAQ:NVDA",
        quoteState: "fresh",
        now: Date.parse("2026-11-12T18:21:00.000Z"),
      }),
    ).toBe(false);
  });
});
