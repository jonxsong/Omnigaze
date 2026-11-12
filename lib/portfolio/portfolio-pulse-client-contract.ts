import { z } from "zod";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  PORTFOLIO_PULSE_MAX_AGE_DRIFT_SECONDS,
  PORTFOLIO_PULSE_MAX_FUTURE_SKEW_SECONDS,
  PORTFOLIO_PULSE_MAX_QUOTE_AGE_SECONDS,
  type PortfolioPulse,
  type PortfolioPulsePosition,
  type PortfolioPulseQuoteTrust,
} from "@/lib/portfolio/portfolio-pulse";

const MICRO_SCALE = BigInt(1_000_000);
const BASIS_POINTS = BigInt(10_000);
const MAX_DECIMAL_LENGTH = 40;
export const PORTFOLIO_PULSE_MAX_RESPONSE_AGE_SECONDS =
  PORTFOLIO_PULSE_MAX_QUOTE_AGE_SECONDS;
const CANONICAL_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d{0,5}[1-9])?$/;
const NONNEGATIVE_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d{0,5}[1-9])?$/;
const CANONICAL_SYMBOL = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;
const SYMBOL_PART = /^[A-Z0-9._-]+$/;

const exclusionReasons = [
  "invalid_quantity",
  "invalid_average_cost",
  "unsupported_currency",
  "duplicate_symbol",
  "missing_quote",
  "symbol_mismatch",
  "demo_quote",
  "fixture_quote",
  "stale_quote",
  "unknown_freshness",
  "invalid_quote_timestamp",
  "invalid_provider",
  "invalid_current_price",
  "invalid_previous_close",
  "value_below_minimum_precision",
] as const;

const quoteTrustValues = [
  "live_fresh",
  "missing",
  "demo",
  "fixture",
  "stale",
  "unknown",
  "invalid",
] as const;

const canonicalSymbolSchema = z
  .string()
  .min(3)
  .max(64)
  .regex(CANONICAL_SYMBOL)
  .transform((value) => value as CanonicalSymbol);

const canonicalDecimalSchema = z
  .string()
  .min(1)
  .max(MAX_DECIMAL_LENGTH)
  .regex(CANONICAL_DECIMAL)
  .refine((value) => value !== "-0");

const nonnegativeDecimalSchema = z
  .string()
  .min(1)
  .max(MAX_DECIMAL_LENGTH)
  .regex(NONNEGATIVE_DECIMAL);

const positiveDecimalSchema = nonnegativeDecimalSchema.refine(
  (value) =>
    NONNEGATIVE_DECIMAL.test(value) && decimalToMicros(value) > BigInt(0),
);

const identifierSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(SYMBOL_PART);

const trimmedTextSchema = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine((value) => value === value.trim());

const safeCountSchema = z.number().int().safe().nonnegative();
const basisPointsSchema = z.number().int().safe().min(0).max(10_000);
const isoTimestampSchema = z.string().datetime({ offset: true });
const canonicalUtcTimestampSchema = isoTimestampSchema.refine((value) => {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
});

const quoteSchema = z
  .object({
    trust: z.enum(quoteTrustValues),
    dataMode: z.enum(["live", "demo"]).nullable(),
    freshness: z.enum(["fresh", "stale", "unknown", "fixture", "missing"]),
    provider: trimmedTextSchema(128).nullable(),
    asOf: isoTimestampSchema.nullable(),
    freshnessAsOf: isoTimestampSchema.nullable(),
    ageSeconds: safeCountSchema.nullable(),
    marketCoverage: z
      .enum(["limited-exchange", "consolidated", "fixture"])
      .nullable(),
    isDelayed: z.boolean().nullable(),
    delaySeconds: safeCountSchema.nullable(),
  })
  .strict();

const positionSchema = z
  .object({
    symbolId: canonicalSymbolSchema,
    ticker: identifierSchema,
    exchange: identifierSchema,
    name: trimmedTextSchema(256).nullable(),
    quantity: positiveDecimalSchema,
    averageCost: nonnegativeDecimalSchema.nullable(),
    costCurrency: z.literal("USD"),
    included: z.boolean(),
    exclusionReason: z.enum(exclusionReasons).nullable(),
    currentPrice: positiveDecimalSchema.nullable(),
    previousClosePrice: positiveDecimalSchema.nullable(),
    currentValue: positiveDecimalSchema.nullable(),
    previousCloseValue: positiveDecimalSchema.nullable(),
    dayPnl: canonicalDecimalSchema.nullable(),
    dayChangePercent: canonicalDecimalSchema.nullable(),
    costBasis: nonnegativeDecimalSchema.nullable(),
    unrealizedPnl: canonicalDecimalSchema.nullable(),
    weightBps: basisPointsSchema.nullable(),
    quote: quoteSchema,
  })
  .strict();

const contributorSchema = z
  .object({
    symbolId: canonicalSymbolSchema,
    ticker: identifierSchema,
    dayPnl: canonicalDecimalSchema,
    currentValue: positiveDecimalSchema,
    weightBps: basisPointsSchema,
  })
  .strict();

const portfolioPulseSchema = z
  .object({
    currency: z.literal("USD"),
    calculatedAt: canonicalUtcTimestampSchema,
    asOf: isoTimestampSchema.nullable(),
    tradeExecutionAllowed: z.literal(false),
    modelOutputRole: z.literal("portfolio_math_only"),
    totals: z
      .object({
        currentValue: positiveDecimalSchema.nullable(),
        previousCloseValue: positiveDecimalSchema.nullable(),
        dayPnl: canonicalDecimalSchema.nullable(),
        dayChangePercent: canonicalDecimalSchema.nullable(),
        coveredCostBasis: nonnegativeDecimalSchema.nullable(),
        coveredUnrealizedPnl: canonicalDecimalSchema.nullable(),
      })
      .strict(),
    coverage: z
      .object({
        status: z.enum(["none", "partial", "complete"]),
        totalPositions: safeCountSchema,
        consideredPositions: safeCountSchema.max(50),
        omittedPositions: safeCountSchema,
        truncated: z.boolean(),
        includedPositions: safeCountSchema.max(50),
        excludedPositions: safeCountSchema.max(50),
        delayedPositions: safeCountSchema.max(50),
        costBasisPositions: safeCountSchema.max(50),
        costBasisStatus: z.enum(["none", "partial", "complete"]),
      })
      .strict(),
    positions: z.array(positionSchema).max(50),
    contributors: z
      .object({
        positive: z.array(contributorSchema).max(50),
        negative: z.array(contributorSchema).max(50),
      })
      .strict(),
  })
  .strict();

export class PortfolioPulseClientContractError extends Error {
  constructor(
    readonly code:
      | "invalid_response"
      | "identity_mismatch"
      | "unsafe_response",
  ) {
    super(code);
    this.name = "PortfolioPulseClientContractError";
  }
}

function reject(code: PortfolioPulseClientContractError["code"]): never {
  throw new PortfolioPulseClientContractError(code);
}

function requireSafe(condition: boolean) {
  if (!condition) reject("unsafe_response");
}

function decimalToMicros(value: string) {
  const negative = value.startsWith("-");
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ""] = unsigned.split(".");
  const micros =
    BigInt(whole) * MICRO_SCALE +
    BigInt(fraction.padEnd(6, "0") || "0");
  return negative ? -micros : micros;
}

function formatMicros(value: bigint) {
  if (value === BigInt(0)) return "0";
  const negative = value < BigInt(0);
  const absolute = negative ? -value : value;
  const whole = absolute / MICRO_SCALE;
  const remainder = absolute % MICRO_SCALE;
  const sign = negative ? "-" : "";
  if (remainder === BigInt(0)) return sign + whole.toString();
  return (
    sign +
    whole.toString() +
    "." +
    remainder.toString().padStart(6, "0").replace(/0+$/, "")
  );
}

function roundDivide(numerator: bigint, denominator: bigint) {
  requireSafe(denominator > BigInt(0));
  const negative = numerator < BigInt(0);
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + denominator / BigInt(2)) / denominator;
  return negative ? -rounded : rounded;
}

function multiplyMicros(left: bigint, right: bigint) {
  return roundDivide(left * right, MICRO_SCALE);
}

function percentFromRatio(numerator: bigint, denominator: bigint) {
  requireSafe(denominator > BigInt(0));
  return formatMicros(
    roundDivide(numerator * BigInt(100) * MICRO_SCALE, denominator),
  );
}

function compareSymbols(left: CanonicalSymbol, right: CanonicalSymbol) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function validateQuote(
  position: PortfolioPulsePosition,
  calculatedAtTimestamp: number,
  trustedNowTimestamp: number,
) {
  const quote = position.quote;
  const quoteFieldsPresent =
    quote.provider !== null &&
    quote.asOf !== null &&
    quote.marketCoverage !== null &&
    quote.isDelayed !== null &&
    quote.delaySeconds !== null;

  if (quote.trust === "missing") {
    requireSafe(
      quote.provider === null &&
        quote.asOf === null &&
        quote.freshnessAsOf === null &&
        quote.ageSeconds === null &&
        quote.marketCoverage === null &&
        quote.isDelayed === null &&
        quote.delaySeconds === null,
    );
  } else if (quote.trust === "live_fresh") {
    const quoteTimestamp = Date.parse(quote.asOf ?? "");
    const actualAgeSeconds = Math.max(
      0,
      Math.round((calculatedAtTimestamp - quoteTimestamp) / 1_000),
    );
    const trustedAgeSeconds = Math.max(
      0,
      Math.round((trustedNowTimestamp - quoteTimestamp) / 1_000),
    );
    requireSafe(
      quoteFieldsPresent &&
        quote.dataMode === "live" &&
        quote.freshness === "fresh" &&
        quote.marketCoverage !== "fixture" &&
        quote.ageSeconds !== null &&
        quote.freshnessAsOf === quote.asOf &&
        Number.isFinite(quoteTimestamp) &&
        quoteTimestamp <=
          calculatedAtTimestamp +
            PORTFOLIO_PULSE_MAX_FUTURE_SKEW_SECONDS * 1_000 &&
        quoteTimestamp <=
          trustedNowTimestamp +
            PORTFOLIO_PULSE_MAX_FUTURE_SKEW_SECONDS * 1_000 &&
        actualAgeSeconds <= PORTFOLIO_PULSE_MAX_QUOTE_AGE_SECONDS &&
        trustedAgeSeconds <= PORTFOLIO_PULSE_MAX_QUOTE_AGE_SECONDS &&
        Math.abs(quote.ageSeconds - actualAgeSeconds) <=
          PORTFOLIO_PULSE_MAX_AGE_DRIFT_SECONDS,
    );
  } else if (quote.trust === "demo") {
    requireSafe(quoteFieldsPresent && quote.dataMode === "demo");
  } else if (quote.trust === "fixture") {
    requireSafe(
      quoteFieldsPresent &&
        (quote.freshness === "fixture" ||
          quote.marketCoverage === "fixture"),
    );
  } else if (quote.trust === "stale") {
    requireSafe(
      quoteFieldsPresent &&
        quote.dataMode === "live" &&
        quote.freshness === "stale",
    );
  } else if (quote.trust === "unknown") {
    requireSafe(
      quoteFieldsPresent &&
        quote.dataMode === "live" &&
        quote.freshness === "unknown",
    );
  }

  if (quote.trust !== "missing") requireSafe(quote.dataMode !== null);

  if (quote.freshness === "fresh" || quote.freshness === "stale") {
    requireSafe(quote.ageSeconds !== null);
  }
  if (quote.isDelayed === true) requireSafe((quote.delaySeconds ?? 0) > 0);
  if (quote.isDelayed === false) requireSafe(quote.delaySeconds === 0);

  const expectedTrust: Partial<
    Record<NonNullable<PortfolioPulsePosition["exclusionReason"]>, PortfolioPulseQuoteTrust>
  > = {
    missing_quote: "missing",
    symbol_mismatch: "invalid",
    demo_quote: "demo",
    fixture_quote: "fixture",
    stale_quote: "stale",
    unknown_freshness: "unknown",
    invalid_quote_timestamp: "invalid",
    invalid_provider: "invalid",
    invalid_current_price: "invalid",
    invalid_previous_close: "invalid",
  };
  if (position.exclusionReason && expectedTrust[position.exclusionReason]) {
    requireSafe(quote.trust === expectedTrust[position.exclusionReason]);
  }
}

function validatePosition(
  position: PortfolioPulsePosition,
  calculatedAtTimestamp: number,
  trustedNowTimestamp: number,
) {
  const [exchange, ticker] = position.symbolId.split(":");
  if (position.exchange !== exchange || position.ticker !== ticker) {
    reject("identity_mismatch");
  }
  validateQuote(position, calculatedAtTimestamp, trustedNowTimestamp);

  const calculatedFields = [
    position.currentPrice,
    position.previousClosePrice,
    position.currentValue,
    position.previousCloseValue,
    position.dayPnl,
    position.dayChangePercent,
    position.weightBps,
  ];
  if (!position.included) {
    requireSafe(
      position.exclusionReason !== null &&
        calculatedFields.every((value) => value === null) &&
        position.costBasis === null &&
        position.unrealizedPnl === null,
    );
    return;
  }

  requireSafe(
    position.exclusionReason === null &&
      calculatedFields.every((value) => value !== null) &&
      position.quote.trust === "live_fresh",
  );

  const quantity = decimalToMicros(position.quantity);
  const currentPrice = decimalToMicros(position.currentPrice!);
  const previousClosePrice = decimalToMicros(position.previousClosePrice!);
  const currentValue = multiplyMicros(quantity, currentPrice);
  const previousCloseValue = multiplyMicros(quantity, previousClosePrice);
  const dayPnl = currentValue - previousCloseValue;

  requireSafe(
    position.currentValue === formatMicros(currentValue) &&
      position.previousCloseValue === formatMicros(previousCloseValue) &&
      position.dayPnl === formatMicros(dayPnl) &&
      position.dayChangePercent ===
        percentFromRatio(dayPnl, previousCloseValue),
  );

  if (position.averageCost === null) {
    requireSafe(position.costBasis === null && position.unrealizedPnl === null);
  } else {
    requireSafe(position.costBasis !== null && position.unrealizedPnl !== null);
    const costBasis = multiplyMicros(
      quantity,
      decimalToMicros(position.averageCost),
    );
    requireSafe(
      position.costBasis === formatMicros(costBasis) &&
        position.unrealizedPnl === formatMicros(currentValue - costBasis),
    );
  }
}

function expectedWeights(positions: PortfolioPulsePosition[]) {
  const values = positions.map((position) => ({
    symbolId: position.symbolId,
    value: decimalToMicros(position.currentValue!),
  }));
  const total = values.reduce((sum, position) => sum + position.value, BigInt(0));
  const weights = new Map<CanonicalSymbol, number>();
  const remainders = values.map((position) => {
    const scaled = position.value * BASIS_POINTS;
    const weight = Number(scaled / total);
    weights.set(position.symbolId, weight);
    return {
      symbolId: position.symbolId,
      remainder: scaled % total,
    };
  });
  const allocated = [...weights.values()].reduce((sum, value) => sum + value, 0);
  remainders.sort((left, right) => {
    if (left.remainder > right.remainder) return -1;
    if (left.remainder < right.remainder) return 1;
    return compareSymbols(left.symbolId, right.symbolId);
  });
  for (let index = 0; index < 10_000 - allocated; index += 1) {
    const symbolId = remainders[index]?.symbolId;
    requireSafe(symbolId !== undefined);
    weights.set(symbolId, (weights.get(symbolId) ?? 0) + 1);
  }
  return weights;
}

function validateCoverage(pulse: PortfolioPulse) {
  const { coverage, positions } = pulse;
  const included = positions.filter((position) => position.included);
  const costBasisPositions = included.filter(
    (position) => position.costBasis !== null,
  );
  const expectedStatus =
    included.length === 0
      ? "none"
      : included.length === positions.length && coverage.omittedPositions === 0
        ? "complete"
        : "partial";
  const expectedCostBasisStatus =
    costBasisPositions.length === 0
      ? "none"
      : costBasisPositions.length === included.length &&
          coverage.omittedPositions === 0
        ? "complete"
        : "partial";

  requireSafe(
    coverage.totalPositions ===
      coverage.consideredPositions + coverage.omittedPositions &&
      coverage.consideredPositions === positions.length &&
      coverage.includedPositions === included.length &&
      coverage.excludedPositions === positions.length - included.length &&
      coverage.delayedPositions ===
        included.filter((position) => position.quote.isDelayed === true).length &&
      coverage.costBasisPositions === costBasisPositions.length &&
      coverage.truncated === (coverage.omittedPositions > 0) &&
      coverage.status === expectedStatus &&
      coverage.costBasisStatus === expectedCostBasisStatus,
  );
}

function validatePositionsAndTotals(
  pulse: PortfolioPulse,
  calculatedAtTimestamp: number,
  trustedNowTimestamp: number,
) {
  const seen = new Set<CanonicalSymbol>();
  for (let index = 0; index < pulse.positions.length; index += 1) {
    const position = pulse.positions[index]!;
    if (seen.has(position.symbolId)) reject("identity_mismatch");
    seen.add(position.symbolId);
    if (
      index > 0 &&
      compareSymbols(pulse.positions[index - 1]!.symbolId, position.symbolId) >= 0
    ) {
      reject("identity_mismatch");
    }
    validatePosition(position, calculatedAtTimestamp, trustedNowTimestamp);
  }

  const included = pulse.positions.filter((position) => position.included);
  if (included.length === 0) {
    requireSafe(
      pulse.asOf === null &&
        Object.values(pulse.totals).every((value) => value === null) &&
        pulse.contributors.positive.length === 0 &&
        pulse.contributors.negative.length === 0,
    );
    return;
  }

  const weights = expectedWeights(included);
  requireSafe(
    included.reduce((sum, position) => sum + position.weightBps!, 0) === 10_000,
  );
  for (const position of included) {
    requireSafe(position.weightBps === weights.get(position.symbolId));
  }

  const totalCurrentValue = included.reduce(
    (sum, position) => sum + decimalToMicros(position.currentValue!),
    BigInt(0),
  );
  const totalPreviousCloseValue = included.reduce(
    (sum, position) => sum + decimalToMicros(position.previousCloseValue!),
    BigInt(0),
  );
  const totalDayPnl = included.reduce(
    (sum, position) => sum + decimalToMicros(position.dayPnl!),
    BigInt(0),
  );
  const withCostBasis = included.filter(
    (position) => position.costBasis !== null,
  );
  const totalCostBasis = withCostBasis.reduce(
    (sum, position) => sum + decimalToMicros(position.costBasis!),
    BigInt(0),
  );
  const totalUnrealized = withCostBasis.reduce(
    (sum, position) => sum + decimalToMicros(position.unrealizedPnl!),
    BigInt(0),
  );

  requireSafe(
    pulse.totals.currentValue === formatMicros(totalCurrentValue) &&
      pulse.totals.previousCloseValue ===
        formatMicros(totalPreviousCloseValue) &&
      pulse.totals.dayPnl === formatMicros(totalDayPnl) &&
      pulse.totals.dayChangePercent ===
        percentFromRatio(totalDayPnl, totalPreviousCloseValue),
  );
  if (withCostBasis.length === 0) {
    requireSafe(
      pulse.totals.coveredCostBasis === null &&
        pulse.totals.coveredUnrealizedPnl === null,
    );
  } else {
    requireSafe(
      pulse.totals.coveredCostBasis === formatMicros(totalCostBasis) &&
        pulse.totals.coveredUnrealizedPnl === formatMicros(totalUnrealized),
    );
  }

  const oldest = included
    .map((position) => position.quote.asOf!)
    .sort((left, right) => {
      const difference = Date.parse(left) - Date.parse(right);
      return difference === 0 ? left.localeCompare(right) : difference;
    })[0];
  requireSafe(pulse.asOf === oldest);
}

function matchesContributor(
  contributor: PortfolioPulse["contributors"]["positive"][number],
  position: PortfolioPulsePosition,
) {
  return (
    contributor.symbolId === position.symbolId &&
    contributor.ticker === position.ticker &&
    contributor.dayPnl === position.dayPnl &&
    contributor.currentValue === position.currentValue &&
    contributor.weightBps === position.weightBps
  );
}

function validateContributors(pulse: PortfolioPulse) {
  const included = pulse.positions.filter((position) => position.included);
  const expectedPositive = included
    .filter((position) => decimalToMicros(position.dayPnl!) > BigInt(0))
    .sort((left, right) => {
      const leftPnl = decimalToMicros(left.dayPnl!);
      const rightPnl = decimalToMicros(right.dayPnl!);
      if (leftPnl > rightPnl) return -1;
      if (leftPnl < rightPnl) return 1;
      return compareSymbols(left.symbolId, right.symbolId);
    });
  const expectedNegative = included
    .filter((position) => decimalToMicros(position.dayPnl!) < BigInt(0))
    .sort((left, right) => {
      const leftPnl = decimalToMicros(left.dayPnl!);
      const rightPnl = decimalToMicros(right.dayPnl!);
      if (leftPnl < rightPnl) return -1;
      if (leftPnl > rightPnl) return 1;
      return compareSymbols(left.symbolId, right.symbolId);
    });

  requireSafe(
    pulse.contributors.positive.length === expectedPositive.length &&
      pulse.contributors.negative.length === expectedNegative.length &&
      pulse.contributors.positive.every((contributor, index) =>
        matchesContributor(contributor, expectedPositive[index]!),
      ) &&
      pulse.contributors.negative.every((contributor, index) =>
        matchesContributor(contributor, expectedNegative[index]!),
      ),
  );
}

/** Parses an untrusted Portfolio Pulse payload and rejects semantic drift. */
export function parsePortfolioPulse(
  input: unknown,
  now: Date = new Date(),
): PortfolioPulse {
  const parsed = portfolioPulseSchema.safeParse(input);
  if (!parsed.success) reject("invalid_response");
  const pulse = parsed.data as PortfolioPulse;
  const calculatedAtTimestamp = Date.parse(pulse.calculatedAt);
  const trustedNowTimestamp = now.getTime();
  requireSafe(
    Number.isFinite(trustedNowTimestamp) &&
      calculatedAtTimestamp <=
        trustedNowTimestamp +
          PORTFOLIO_PULSE_MAX_FUTURE_SKEW_SECONDS * 1_000 &&
      calculatedAtTimestamp >=
        trustedNowTimestamp -
          PORTFOLIO_PULSE_MAX_RESPONSE_AGE_SECONDS * 1_000,
  );

  validateCoverage(pulse);
  validatePositionsAndTotals(
    pulse,
    calculatedAtTimestamp,
    trustedNowTimestamp,
  );
  validateContributors(pulse);
  return pulse;
}
