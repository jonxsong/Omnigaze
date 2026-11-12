import { z } from "zod";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  isPortfolioDecimal,
  MAX_AVERAGE_COST_MICROS,
  MAX_QUANTITY_MICROS,
  microsToDecimal,
} from "@/lib/portfolio/decimal";

const canonicalSymbolSchema = z
  .string()
  .regex(/^[A-Z0-9._-]+:[A-Z0-9._-]+$/)
  .transform((value) => value as CanonicalSymbol);

const positiveDecimalSchema = z.string().refine((value) =>
  isPortfolioDecimal(value, {
    allowZero: false,
    maxMicros: MAX_QUANTITY_MICROS,
  }),
);

const averageCostSchema = z.string().refine((value) =>
  isPortfolioDecimal(value, {
    allowZero: true,
    maxMicros: MAX_AVERAGE_COST_MICROS,
  }),
);

export const clientPortfolioHoldingSchema = z.object({
  symbolId: canonicalSymbolSchema,
  ticker: z.string().min(1).optional(),
  exchange: z.string().min(1).optional(),
  name: z.string().min(1).optional(),
  quantity: positiveDecimalSchema,
  averageCost: averageCostSchema.nullable(),
  totalCostBasis: z.string().nullable().optional(),
  costCurrency: z.literal("USD").optional(),
  quantityAsOf: z.string().datetime({ offset: true }).optional(),
  entrySource: z.string().optional(),
  version: z.number().int().positive(),
  createdAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});

export type ClientPortfolioHolding = z.infer<typeof clientPortfolioHoldingSchema>;

const scenarioPriceZoneSchema = z.object({
  kind: z.enum(["pullback_review", "strength_review", "downside_review"]),
  priceMicros: z.number().int().nonnegative().safe(),
  distanceBps: z.number().int().min(-10_000).max(10_000),
  explanation: z.string().min(1),
});

const positionScenarioSchema = z.object({
  kind: z.enum(["trim", "add"]),
  label: z.string().min(1),
  quantityMicros: z.number().int().nonnegative().safe(),
  fractionBps: z.number().int().min(0).max(10_000),
  basis: z.enum(["current_holding", "user_budget"]),
});

const decisionBase = {
  symbolId: canonicalSymbolSchema,
  tradeExecutionAllowed: z.literal(false),
  modelOutputRole: z.literal("scenario_math_only"),
};

const eligibleDecisionSchema = z.object({
  ...decisionBase,
  eligible: z.literal(true),
  asOf: z.string().datetime({ offset: true }),
  preset: z.enum(["tight", "balanced", "wide"]),
  zones: z.array(scenarioPriceZoneSchema).min(1),
  positionScenarios: z.array(positionScenarioSchema),
  evidenceConfidence: z.object({
    score: z.number().min(0).max(1),
    label: z.enum(["limited", "moderate", "strong"]),
    meaning: z.string().min(1),
    evidenceIds: z.array(z.string().min(1)),
  }),
  assumptions: z.array(z.string().min(1)).min(1),
});

const ineligibleDecisionSchema = z.object({
  ...decisionBase,
  eligible: z.literal(false),
  suppressedReasons: z.array(z.string().min(1)).min(1),
});

const evidenceCitationSchema = z.object({
  id: z.string().min(1),
  headline: z.string().min(1),
  source: z.string().min(1),
  sourceKind: z.string().min(1),
  publishedAt: z.string().datetime({ offset: true }),
  sourceUrl: z.string().url().nullable().optional(),
  materiality: z.string().min(1),
});

const decisionSupportEnvelopeSchema = z.object({
  data: z.object({
    decision: z.discriminatedUnion("eligible", [
      eligibleDecisionSchema,
      ineligibleDecisionSchema,
    ]),
    context: z
      .object({
        horizon: z.enum(["near_term", "long_term"]),
        hasHolding: z.boolean(),
        holdingQuantity: z.string().nullable().optional(),
        holding: z
          .object({
            symbolId: canonicalSymbolSchema,
            quantity: z.string(),
            averageCost: z.string().nullable().optional(),
            version: z.number().int().positive(),
            quantityAsOf: z.string().datetime({ offset: true }).optional(),
          })
          .nullable()
          .optional(),
        evidenceCount: z.number().int().nonnegative(),
        independentSourceCount: z.number().int().nonnegative(),
        providerStreamCount: z.number().int().nonnegative().optional(),
        marketDataMode: z.string().optional(),
        marketFreshness: z.string().optional(),
        evidenceDataMode: z.string().optional(),
        evidenceFreshness: z.string().optional(),
        evidence: z.array(evidenceCitationSchema).max(12).optional(),
        quote: z
          .object({
            price: z.number().positive(),
            asOf: z.string().datetime({ offset: true }),
            freshUntil: z.string().datetime({ offset: true }).nullable().optional(),
            provider: z.string().min(1),
            marketCoverage: z.string().min(1),
            isDelayed: z.boolean(),
            delaySeconds: z.number().int().nonnegative(),
          })
          .nullable()
          .optional(),
      })
      .passthrough(),
  }),
  meta: z.object({
    purpose: z.literal("research_scenarios"),
    tradeExecutionAllowed: z.literal(false),
    generatedAt: z.string().datetime({ offset: true }),
  }),
});

type DecisionSupportResponse = z.infer<typeof decisionSupportEnvelopeSchema>;
export type DecisionSupportEnvelope = DecisionSupportResponse["data"];
export type EligibleDecision = Extract<
  DecisionSupportEnvelope["decision"],
  { eligible: true }
>;

export class PortfolioClientContractError extends Error {
  constructor(
    readonly code:
      | "invalid_response"
      | "identity_mismatch"
      | "unsafe_response",
  ) {
    super(code);
    this.name = "PortfolioClientContractError";
  }
}

function requireExpectedSymbol(
  actual: CanonicalSymbol,
  expected: CanonicalSymbol,
) {
  if (actual !== expected) {
    throw new PortfolioClientContractError("identity_mismatch");
  }
}

export function parseHoldingMutationEnvelope(
  input: unknown,
  expectedSymbol: CanonicalSymbol,
) {
  const parsed = z
    .object({ data: clientPortfolioHoldingSchema })
    .safeParse(input);
  if (!parsed.success) {
    throw new PortfolioClientContractError("invalid_response");
  }
  requireExpectedSymbol(parsed.data.data.symbolId, expectedSymbol);
  return parsed.data.data;
}

export function parsePortfolioReadEnvelope(input: unknown) {
  const parsed = z
    .object({
      data: z.object({ holdings: z.array(clientPortfolioHoldingSchema) }),
    })
    .safeParse(input);
  if (!parsed.success) {
    throw new PortfolioClientContractError("invalid_response");
  }
  return parsed.data.data.holdings;
}

export function parseDecisionSupportEnvelope(
  input: unknown,
  expectedSymbol: CanonicalSymbol,
) {
  const candidate = input as {
    data?: { decision?: Record<string, unknown> };
  } | null;
  const rawDecision = candidate?.data?.decision;
  if (
    rawDecision?.eligible === false &&
    ("zones" in rawDecision ||
      "positionScenarios" in rawDecision ||
      "evidenceConfidence" in rawDecision)
  ) {
    throw new PortfolioClientContractError("unsafe_response");
  }

  const parsed = decisionSupportEnvelopeSchema.safeParse(input);
  if (!parsed.success) {
    throw new PortfolioClientContractError("invalid_response");
  }
  const envelope = parsed.data.data;
  requireExpectedSymbol(envelope.decision.symbolId, expectedSymbol);
  if (envelope.context.holding) {
    requireExpectedSymbol(envelope.context.holding.symbolId, expectedSymbol);
  }
  if (envelope.decision.eligible) {
    const quote = envelope.context.quote;
    const citations = envelope.context.evidence ?? [];
    const evidenceIds = new Set(envelope.decision.evidenceConfidence.evidenceIds);
    if (
      !quote?.freshUntil ||
      quote.asOf !== envelope.decision.asOf ||
      citations.length < 2 ||
      citations.some((citation) => !evidenceIds.has(citation.id))
    ) {
      throw new PortfolioClientContractError("unsafe_response");
    }
  }
  return envelope;
}

export function validatePositionFields(quantity: string, averageCost: string) {
  const normalizedQuantity = quantity.trim();
  const normalizedAverageCost = averageCost.trim();
  if (
    !isPortfolioDecimal(normalizedQuantity, {
      allowZero: false,
      maxMicros: MAX_QUANTITY_MICROS,
    })
  ) {
    return {
      success: false as const,
      error: "Enter a positive share quantity with up to six decimal places.",
    };
  }
  if (
    normalizedAverageCost &&
    !isPortfolioDecimal(normalizedAverageCost, {
      allowZero: true,
      maxMicros: MAX_AVERAGE_COST_MICROS,
    })
  ) {
    return {
      success: false as const,
      error: "Enter a non-negative average cost with up to six decimal places.",
    };
  }
  return {
    success: true as const,
    quantity: normalizedQuantity,
    averageCost: normalizedAverageCost || null,
  };
}

export function validateScenarioBudget(value: string) {
  const normalized = value.trim();
  if (!normalized) return { success: true as const, budget: null };
  if (
    !isPortfolioDecimal(normalized, {
      allowZero: false,
      maxMicros: MAX_AVERAGE_COST_MICROS,
    })
  ) {
    return {
      success: false as const,
      error: "Enter a positive USD budget with up to six decimal places.",
    };
  }
  return { success: true as const, budget: normalized };
}

export function formatMicrosAsUsd(value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new PortfolioClientContractError("invalid_response");
  }
  const cents = (BigInt(value) + BigInt(5_000)) / BigInt(10_000);
  const dollars = cents / BigInt(100);
  const remainder = (cents % BigInt(100)).toString().padStart(2, "0");
  return `$${dollars.toLocaleString("en-US")}.${remainder}`;
}

export function formatMicrosAsQuantity(value: number) {
  return microsToDecimal(value);
}

export function isEligibleDecisionCurrent(
  decision: EligibleDecision,
  options: {
    expectedSymbol: CanonicalSymbol;
    quoteState: "fresh" | "stale" | "fixture" | "unavailable" | "loading";
    now?: number;
    maxAgeMs?: number;
  },
) {
  if (
    decision.symbolId !== options.expectedSymbol ||
    options.quoteState !== "fresh"
  ) {
    return false;
  }
  const timestamp = Date.parse(decision.asOf);
  if (!Number.isFinite(timestamp)) return false;
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? 20 * 60 * 1_000;
  return timestamp <= now + 5 * 60 * 1_000 && now - timestamp <= maxAgeMs;
}
