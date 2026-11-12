import type { CanonicalSymbol } from "@/lib/market-types";

const BASIS_POINTS = 10_000;
const UNITS_PER_SHARE = 1_000_000;

export type ScenarioPreset = "tight" | "balanced" | "wide";

export interface DecisionEvidenceInput {
  evidenceIds: string[];
  independentSourceCount: number;
  materialEventCount: number;
  contradictorySignalCount: number;
  hasRecentFiling: boolean;
}

export interface DecisionSupportInput {
  symbolId: CanonicalSymbol;
  holdingQuantityMicros: number;
  userBudgetMicros?: number | null;
  market: {
    priceMicros: number;
    asOf: string;
    dataMode: "live" | "demo";
    freshness: "fresh" | "stale" | "unknown" | "fixture";
  };
  evidence: DecisionEvidenceInput;
  preset: ScenarioPreset;
}

export interface ScenarioPriceZone {
  kind: "pullback_review" | "strength_review" | "downside_review";
  priceMicros: number;
  distanceBps: number;
  explanation: string;
}

export interface PositionScenario {
  kind: "trim" | "add";
  label: string;
  quantityMicros: number;
  fractionBps: number;
  basis: "current_holding" | "user_budget";
}

export interface EvidenceConfidence {
  score: number;
  label: "limited" | "moderate" | "strong";
  meaning: string;
  evidenceIds: string[];
}

export type DecisionSupportResult =
  | {
      eligible: false;
      symbolId: CanonicalSymbol;
      suppressedReasons: string[];
      tradeExecutionAllowed: false;
      modelOutputRole: "scenario_math_only";
    }
  | {
      eligible: true;
      symbolId: CanonicalSymbol;
      asOf: string;
      preset: ScenarioPreset;
      zones: ScenarioPriceZone[];
      positionScenarios: PositionScenario[];
      evidenceConfidence: EvidenceConfidence;
      assumptions: string[];
      tradeExecutionAllowed: false;
      modelOutputRole: "scenario_math_only";
    };

const PRESETS: Record<
  ScenarioPreset,
  { pullbackBps: number; strengthBps: number; downsideBps: number }
> = {
  tight: { pullbackBps: 300, strengthBps: 500, downsideBps: 700 },
  balanced: { pullbackBps: 600, strengthBps: 1_000, downsideBps: 1_200 },
  wide: { pullbackBps: 1_000, strengthBps: 2_000, downsideBps: 2_000 },
};

function requireSafeNonNegativeInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${field} must be a non-negative safe integer.`);
  }
}

function safeNumberFromBigInt(value: bigint, field: string) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(field + " exceeds the supported safe-integer range.");
  }
  return Number(value);
}

function scaleByBps(value: number, bps: number) {
  requireSafeNonNegativeInteger(value, "value");
  requireSafeNonNegativeInteger(bps, "bps");
  return safeNumberFromBigInt(
    (BigInt(value) * BigInt(bps)) / BigInt(BASIS_POINTS),
    "Scaled value",
  );
}

function sharesForBudget(budgetMicros: number, priceMicros: number) {
  requireSafeNonNegativeInteger(budgetMicros, "userBudgetMicros");
  requireSafeNonNegativeInteger(priceMicros, "market.priceMicros");
  if (priceMicros === 0) throw new Error("market.priceMicros must be greater than zero.");

  const quantity =
    (BigInt(budgetMicros) * BigInt(UNITS_PER_SHARE)) / BigInt(priceMicros);
  if (quantity > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("Calculated share quantity exceeds the supported range.");
  }
  return safeNumberFromBigInt(quantity, "Calculated share quantity");
}

function confidenceFor(evidence: DecisionEvidenceInput): EvidenceConfidence {
  const evidenceIds = [...new Set(evidence.evidenceIds.filter(Boolean))];
  const sourceContribution = Math.min(0.3, evidence.independentSourceCount * 0.1);
  const evidenceContribution = Math.min(0.25, evidenceIds.length * 0.05);
  const materialContribution = Math.min(0.1, evidence.materialEventCount * 0.025);
  const filingContribution = evidence.hasRecentFiling ? 0.1 : 0;
  const contradictionPenalty = Math.min(
    0.2,
    evidence.contradictorySignalCount * 0.05,
  );
  const score = Math.max(
    0,
    Math.min(
      0.85,
      0.1 +
        sourceContribution +
        evidenceContribution +
        materialContribution +
        filingContribution -
        contradictionPenalty,
    ),
  );

  return {
    score: Number(score.toFixed(2)),
    label: score >= 0.7 ? "strong" : score >= 0.45 ? "moderate" : "limited",
    meaning:
      "Evidence coverage and source agreement only; this is not a probability of price direction or return.",
    evidenceIds,
  };
}

function suppressedReasons(input: DecisionSupportInput) {
  const reasons: string[] = [];
  if (input.market.dataMode !== "live") reasons.push("live_market_data_required");
  if (input.market.freshness !== "fresh") reasons.push("fresh_market_data_required");
  if (input.market.priceMicros <= 0) reasons.push("valid_market_price_required");
  if (new Set(input.evidence.evidenceIds.filter(Boolean)).size < 2) {
    reasons.push("insufficient_evidence");
  }
  if (input.evidence.independentSourceCount < 2) {
    reasons.push("independent_sources_required");
  }
  return reasons;
}

/**
 * Produces deterministic review scenarios from observable inputs. An AI model may
 * explain these outputs later, but it must not alter the prices, quantities, or
 * evidence-confidence score returned here.
 */
export function buildDecisionSupport(
  input: DecisionSupportInput,
): DecisionSupportResult {
  requireSafeNonNegativeInteger(
    input.holdingQuantityMicros,
    "holdingQuantityMicros",
  );
  requireSafeNonNegativeInteger(input.market.priceMicros, "market.priceMicros");
  if (input.userBudgetMicros != null) {
    requireSafeNonNegativeInteger(input.userBudgetMicros, "userBudgetMicros");
  }
  requireSafeNonNegativeInteger(
    input.evidence.independentSourceCount,
    "evidence.independentSourceCount",
  );
  requireSafeNonNegativeInteger(
    input.evidence.materialEventCount,
    "evidence.materialEventCount",
  );
  requireSafeNonNegativeInteger(
    input.evidence.contradictorySignalCount,
    "evidence.contradictorySignalCount",
  );

  const reasons = suppressedReasons(input);
  if (reasons.length > 0) {
    return {
      eligible: false,
      symbolId: input.symbolId,
      suppressedReasons: reasons,
      tradeExecutionAllowed: false,
      modelOutputRole: "scenario_math_only",
    };
  }

  const preset = PRESETS[input.preset];
  const price = input.market.priceMicros;
  const pullbackPrice = scaleByBps(price, BASIS_POINTS - preset.pullbackBps);
  const zones: ScenarioPriceZone[] = [
    {
      kind: "pullback_review",
      priceMicros: pullbackPrice,
      distanceBps: -preset.pullbackBps,
      explanation:
        "A lower-price checkpoint for reviewing whether the evidence still supports the original thesis.",
    },
    {
      kind: "strength_review",
      priceMicros: scaleByBps(price, BASIS_POINTS + preset.strengthBps),
      distanceBps: preset.strengthBps,
      explanation:
        "A higher-price checkpoint for reviewing concentration, valuation, and changed evidence.",
    },
    {
      kind: "downside_review",
      priceMicros: scaleByBps(price, BASIS_POINTS - preset.downsideBps),
      distanceBps: -preset.downsideBps,
      explanation:
        "A risk checkpoint, not an automatic stop or prediction, for reassessing the position and thesis.",
    },
  ];

  const positionScenarios: PositionScenario[] = [1_000, 2_500, 5_000]
    .filter(() => input.holdingQuantityMicros > 0)
    .map((fractionBps) => ({
      kind: "trim" as const,
      label: `${fractionBps / 100}% trim scenario`,
      quantityMicros: scaleByBps(input.holdingQuantityMicros, fractionBps),
      fractionBps,
      basis: "current_holding" as const,
    }));

  if (input.userBudgetMicros && input.userBudgetMicros > 0) {
    for (const fractionBps of [2_500, 5_000, 10_000]) {
      const allocatedBudget = scaleByBps(input.userBudgetMicros, fractionBps);
      positionScenarios.push({
        kind: "add",
        label: `${fractionBps / 100}% of entered budget`,
        quantityMicros: sharesForBudget(allocatedBudget, pullbackPrice),
        fractionBps,
        basis: "user_budget",
      });
    }
  }

  return {
    eligible: true,
    symbolId: input.symbolId,
    asOf: input.market.asOf,
    preset: input.preset,
    zones,
    positionScenarios,
    evidenceConfidence: confidenceFor(input.evidence),
    assumptions: [
      `The ${input.preset} preset is a user-selected review range, not a forecast.`,
      "Prices are calculated from the current live snapshot and do not include taxes, fees, slippage, or account-level constraints.",
      "Quantities are hypothetical scenarios and never authorize or place an order.",
    ],
    tradeExecutionAllowed: false,
    modelOutputRole: "scenario_math_only",
  };
}
