import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import {
  decimalToMicros,
  MAX_AVERAGE_COST_MICROS,
  MAX_QUANTITY_MICROS,
  PORTFOLIO_MICRO_SCALE,
} from "@/lib/portfolio/decimal";
export const MAX_PORTFOLIO_PULSE_POSITIONS = 50;
export const PORTFOLIO_PULSE_MAX_QUOTE_AGE_SECONDS = 1_200;
export const PORTFOLIO_PULSE_MAX_FUTURE_SKEW_SECONDS = 5 * 60;
export const PORTFOLIO_PULSE_MAX_AGE_DRIFT_SECONDS = 5;

const MICRO_SCALE = BigInt(PORTFOLIO_MICRO_SCALE);
const BASIS_POINTS = BigInt(10_000);

export type PortfolioPulseExclusionReason =
  | "invalid_quantity"
  | "invalid_average_cost"
  | "unsupported_currency"
  | "duplicate_symbol"
  | "missing_quote"
  | "symbol_mismatch"
  | "demo_quote"
  | "fixture_quote"
  | "stale_quote"
  | "unknown_freshness"
  | "invalid_quote_timestamp"
  | "invalid_provider"
  | "invalid_current_price"
  | "invalid_previous_close"
  | "value_below_minimum_precision";

export type PortfolioPulseQuoteTrust =
  | "live_fresh"
  | "missing"
  | "demo"
  | "fixture"
  | "stale"
  | "unknown"
  | "invalid";

export type PortfolioPulseDataMode = "live" | "demo";
export type PortfolioPulseFreshnessState =
  | "fresh"
  | "stale"
  | "unknown"
  | "fixture";

export interface PortfolioPulseHoldingInput {
  symbolId: CanonicalSymbol;
  ticker?: string;
  exchange?: string;
  name?: string;
  quantity: string;
  averageCost: string | null;
  costCurrency?: string;
}

/** A client-safe structural subset of an orchestrated market snapshot. */
export interface PortfolioPulseSnapshotInput {
  data: MarketSnapshot | null;
  meta: {
    dataMode: PortfolioPulseDataMode;
    mode: PortfolioPulseDataMode;
    providerCoverage: "complete" | "partial" | "demo";
    coverage: "complete" | "partial" | "demo";
    freshness: {
      state: PortfolioPulseFreshnessState;
      asOf: string | null;
      ageSeconds: number | null;
    };
  };
}

export interface PortfolioPulseInput {
  /** Holdings already bounded by the caller before quote/provider I/O. */
  holdings: readonly PortfolioPulseHoldingInput[];
  snapshots: ReadonlyMap<CanonicalSymbol, PortfolioPulseSnapshotInput>;
  /** Deterministic UTC evaluation time for quote freshness checks. */
  calculatedAt: string;
  /** Total durable holdings before the caller applied the 50-position bound. */
  sourcePositionCount?: number;
}

export interface PortfolioPulseQuoteMetadata {
  trust: PortfolioPulseQuoteTrust;
  dataMode: PortfolioPulseDataMode | null;
  freshness: PortfolioPulseFreshnessState | "missing";
  provider: string | null;
  asOf: string | null;
  freshnessAsOf: string | null;
  ageSeconds: number | null;
  marketCoverage:
    | "limited-exchange"
    | "consolidated"
    | "fixture"
    | null;
  isDelayed: boolean | null;
  delaySeconds: number | null;
}

export interface PortfolioPulsePosition {
  symbolId: CanonicalSymbol;
  ticker: string;
  exchange: string;
  name: string | null;
  quantity: string;
  averageCost: string | null;
  costCurrency: "USD";
  included: boolean;
  exclusionReason: PortfolioPulseExclusionReason | null;
  currentPrice: string | null;
  previousClosePrice: string | null;
  currentValue: string | null;
  previousCloseValue: string | null;
  dayPnl: string | null;
  dayChangePercent: string | null;
  costBasis: string | null;
  unrealizedPnl: string | null;
  weightBps: number | null;
  quote: PortfolioPulseQuoteMetadata;
}

export interface PortfolioPulseContributor {
  symbolId: CanonicalSymbol;
  ticker: string;
  dayPnl: string;
  currentValue: string;
  weightBps: number;
}

export interface PortfolioPulse {
  currency: "USD";
  calculatedAt: string;
  asOf: string | null;
  tradeExecutionAllowed: false;
  modelOutputRole: "portfolio_math_only";
  totals: {
    currentValue: string | null;
    previousCloseValue: string | null;
    dayPnl: string | null;
    dayChangePercent: string | null;
    coveredCostBasis: string | null;
    coveredUnrealizedPnl: string | null;
  };
  coverage: {
    status: "none" | "partial" | "complete";
    totalPositions: number;
    consideredPositions: number;
    omittedPositions: number;
    truncated: boolean;
    includedPositions: number;
    excludedPositions: number;
    delayedPositions: number;
    costBasisPositions: number;
    costBasisStatus: "none" | "partial" | "complete";
  };
  positions: PortfolioPulsePosition[];
  contributors: {
    positive: PortfolioPulseContributor[];
    negative: PortfolioPulseContributor[];
  };
}

export class PortfolioPulseCalculationError extends Error {
  constructor(
    readonly code:
      | "too_many_positions"
      | "invalid_source_position_count"
      | "invalid_calculated_at",
  ) {
    super(code);
    this.name = "PortfolioPulseCalculationError";
  }
}

type WorkingPosition = PortfolioPulsePosition & {
  currentValueMicros: bigint | null;
  previousCloseValueMicros: bigint | null;
  dayPnlMicros: bigint | null;
  costBasisMicros: bigint | null;
  unrealizedPnlMicros: bigint | null;
  weightRemainder: bigint;
};

type EvaluatedFreshness = {
  state: PortfolioPulseFreshnessState;
  asOf: string | null;
  ageSeconds: number | null;
};

function compareSymbols(left: CanonicalSymbol, right: CanonicalSymbol) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function canonicalUtcTimestamp(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Date(timestamp).toISOString() === value ? timestamp : null;
}

function formatMicros(value: bigint) {
  if (value === BigInt(0)) return "0";

  const sign = value < BigInt(0) ? "-" : "";
  const absolute = value < BigInt(0) ? -value : value;
  const whole = absolute / MICRO_SCALE;
  const remainder = absolute % MICRO_SCALE;
  if (remainder === BigInt(0)) return sign + whole.toString();

  const fraction = remainder
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return `${sign}${whole.toString()}.${fraction}`;
}

function roundDivide(numerator: bigint, denominator: bigint) {
  if (denominator <= BigInt(0)) throw new RangeError("invalid denominator");
  const sign = numerator < BigInt(0) ? -BigInt(1) : BigInt(1);
  const absolute = numerator < BigInt(0) ? -numerator : numerator;
  return sign * ((absolute + denominator / BigInt(2)) / denominator);
}

function multiplyMicros(left: bigint, right: bigint) {
  return roundDivide(left * right, MICRO_SCALE);
}

function percentFromRatio(numerator: bigint, denominator: bigint) {
  if (denominator <= BigInt(0)) return null;
  return formatMicros(
    roundDivide(numerator * BigInt(100) * MICRO_SCALE, denominator),
  );
}

function parseHoldingDecimal(
  value: string,
  options: { allowZero: boolean; maxMicros: number },
) {
  try {
    return BigInt(decimalToMicros(value, options));
  } catch {
    return null;
  }
}

function parseQuotePrice(value: number) {
  if (!Number.isFinite(value) || value <= 0) return null;
  try {
    return BigInt(
      decimalToMicros(value.toFixed(6), {
        allowZero: false,
        maxMicros: MAX_AVERAGE_COST_MICROS,
      }),
    );
  } catch {
    return null;
  }
}

function tickerFromSymbol(symbolId: CanonicalSymbol) {
  return symbolId.split(":")[1] ?? symbolId;
}

function exchangeFromSymbol(symbolId: CanonicalSymbol) {
  return symbolId.split(":")[0] ?? "";
}

function quoteMetadata(
  snapshot: PortfolioPulseSnapshotInput | undefined,
  trust: PortfolioPulseQuoteTrust,
  evaluatedFreshness?: EvaluatedFreshness,
): PortfolioPulseQuoteMetadata {
  const data = snapshot?.data ?? null;
  return {
    trust,
    dataMode: snapshot?.meta.dataMode ?? null,
    freshness:
      evaluatedFreshness?.state ??
      snapshot?.meta.freshness.state ??
      "missing",
    provider: data?.provider?.trim() || null,
    asOf: data?.asOf ?? null,
    freshnessAsOf:
      evaluatedFreshness === undefined
        ? snapshot?.meta.freshness.asOf ?? null
        : evaluatedFreshness.asOf,
    ageSeconds:
      evaluatedFreshness === undefined
        ? snapshot?.meta.freshness.ageSeconds ?? null
        : evaluatedFreshness.ageSeconds,
    marketCoverage: data?.marketCoverage ?? null,
    isDelayed: data?.isDelayed ?? null,
    delaySeconds: data?.delaySeconds ?? null,
  };
}

function excludedPosition(
  holding: PortfolioPulseHoldingInput,
  reason: PortfolioPulseExclusionReason,
  snapshot: PortfolioPulseSnapshotInput | undefined,
  trust: PortfolioPulseQuoteTrust,
  evaluatedFreshness?: EvaluatedFreshness,
): WorkingPosition {
  return {
    symbolId: holding.symbolId,
    ticker: holding.ticker ?? tickerFromSymbol(holding.symbolId),
    exchange: holding.exchange ?? exchangeFromSymbol(holding.symbolId),
    name: holding.name ?? null,
    quantity: holding.quantity,
    averageCost: holding.averageCost,
    costCurrency: "USD",
    included: false,
    exclusionReason: reason,
    currentPrice: null,
    previousClosePrice: null,
    currentValue: null,
    previousCloseValue: null,
    dayPnl: null,
    dayChangePercent: null,
    costBasis: null,
    unrealizedPnl: null,
    weightBps: null,
    quote: quoteMetadata(snapshot, trust, evaluatedFreshness),
    currentValueMicros: null,
    previousCloseValueMicros: null,
    dayPnlMicros: null,
    costBasisMicros: null,
    unrealizedPnlMicros: null,
    weightRemainder: BigInt(0),
  };
}

function evaluateQuote(
  holding: PortfolioPulseHoldingInput,
  snapshot: PortfolioPulseSnapshotInput | undefined,
  calculatedAtTimestamp: number,
):
  | {
      eligible: true;
      currentPriceMicros: bigint;
      previousClosePriceMicros: bigint;
      freshness: EvaluatedFreshness;
    }
  | {
      eligible: false;
      reason: PortfolioPulseExclusionReason;
      trust: PortfolioPulseQuoteTrust;
      freshness?: EvaluatedFreshness;
    } {
  if (!snapshot?.data) {
    return { eligible: false, reason: "missing_quote", trust: "missing" };
  }

  const { data, meta } = snapshot;
  if (data.symbolId !== holding.symbolId) {
    return { eligible: false, reason: "symbol_mismatch", trust: "invalid" };
  }
  if (meta.dataMode !== "live" || meta.mode !== "live") {
    return { eligible: false, reason: "demo_quote", trust: "demo" };
  }
  if (
    meta.freshness.state === "fixture" ||
    meta.providerCoverage === "demo" ||
    meta.coverage === "demo" ||
    data.marketCoverage === "fixture"
  ) {
    return { eligible: false, reason: "fixture_quote", trust: "fixture" };
  }
  const quoteTimestamp = Date.parse(data.asOf);
  if (!Number.isFinite(quoteTimestamp)) {
    return {
      eligible: false,
      reason: "invalid_quote_timestamp",
      trust: "invalid",
    };
  }
  const actualAgeSeconds = Math.max(
    0,
    Math.round((calculatedAtTimestamp - quoteTimestamp) / 1_000),
  );
  const normalizedFreshness = {
    state: meta.freshness.state,
    asOf: data.asOf,
    ageSeconds: actualAgeSeconds,
  } satisfies EvaluatedFreshness;
  if (
    quoteTimestamp >
    calculatedAtTimestamp + PORTFOLIO_PULSE_MAX_FUTURE_SKEW_SECONDS * 1_000
  ) {
    return {
      eligible: false,
      reason: "unknown_freshness",
      trust: "unknown",
      freshness: { ...normalizedFreshness, state: "unknown" },
    };
  }
  if (actualAgeSeconds > PORTFOLIO_PULSE_MAX_QUOTE_AGE_SECONDS) {
    return {
      eligible: false,
      reason: "stale_quote",
      trust: "stale",
      freshness: { ...normalizedFreshness, state: "stale" },
    };
  }
  if (meta.freshness.state === "stale") {
    return {
      eligible: false,
      reason: "stale_quote",
      trust: "stale",
      freshness: { ...normalizedFreshness, state: "stale" },
    };
  }
  if (
    meta.freshness.state !== "fresh" ||
    meta.freshness.asOf !== data.asOf ||
    meta.freshness.ageSeconds === null ||
    !Number.isSafeInteger(meta.freshness.ageSeconds) ||
    meta.freshness.ageSeconds < 0 ||
    Math.abs(meta.freshness.ageSeconds - actualAgeSeconds) >
      PORTFOLIO_PULSE_MAX_AGE_DRIFT_SECONDS
  ) {
    return {
      eligible: false,
      reason: "unknown_freshness",
      trust: "unknown",
      freshness: { ...normalizedFreshness, state: "unknown" },
    };
  }
  if (!data.provider.trim()) {
    return {
      eligible: false,
      reason: "invalid_provider",
      trust: "invalid",
      freshness: normalizedFreshness,
    };
  }

  const currentPriceMicros = parseQuotePrice(data.price);
  if (currentPriceMicros === null) {
    return {
      eligible: false,
      reason: "invalid_current_price",
      trust: "invalid",
      freshness: normalizedFreshness,
    };
  }
  const previousClosePriceMicros = parseQuotePrice(data.previousClose);
  if (previousClosePriceMicros === null) {
    return {
      eligible: false,
      reason: "invalid_previous_close",
      trust: "invalid",
      freshness: normalizedFreshness,
    };
  }

  return {
    eligible: true,
    currentPriceMicros,
    previousClosePriceMicros,
    freshness: normalizedFreshness,
  };
}

function includedPosition(
  holding: PortfolioPulseHoldingInput,
  snapshot: PortfolioPulseSnapshotInput,
  quantityMicros: bigint,
  averageCostMicros: bigint | null,
  currentPriceMicros: bigint,
  previousClosePriceMicros: bigint,
  freshness: EvaluatedFreshness,
): WorkingPosition {
  const currentValueMicros = multiplyMicros(
    quantityMicros,
    currentPriceMicros,
  );
  const previousCloseValueMicros = multiplyMicros(
    quantityMicros,
    previousClosePriceMicros,
  );
  const dayPnlMicros = currentValueMicros - previousCloseValueMicros;
  const costBasisMicros =
    averageCostMicros === null
      ? null
      : multiplyMicros(quantityMicros, averageCostMicros);
  const unrealizedPnlMicros =
    costBasisMicros === null ? null : currentValueMicros - costBasisMicros;

  return {
    symbolId: holding.symbolId,
    ticker: holding.ticker ?? tickerFromSymbol(holding.symbolId),
    exchange: holding.exchange ?? exchangeFromSymbol(holding.symbolId),
    name: holding.name ?? null,
    quantity: formatMicros(quantityMicros),
    averageCost:
      averageCostMicros === null ? null : formatMicros(averageCostMicros),
    costCurrency: "USD",
    included: true,
    exclusionReason: null,
    currentPrice: formatMicros(currentPriceMicros),
    previousClosePrice: formatMicros(previousClosePriceMicros),
    currentValue: formatMicros(currentValueMicros),
    previousCloseValue: formatMicros(previousCloseValueMicros),
    dayPnl: formatMicros(dayPnlMicros),
    dayChangePercent: percentFromRatio(
      dayPnlMicros,
      previousCloseValueMicros,
    ),
    costBasis:
      costBasisMicros === null ? null : formatMicros(costBasisMicros),
    unrealizedPnl:
      unrealizedPnlMicros === null
        ? null
        : formatMicros(unrealizedPnlMicros),
    weightBps: null,
    quote: quoteMetadata(snapshot, "live_fresh", freshness),
    currentValueMicros,
    previousCloseValueMicros,
    dayPnlMicros,
    costBasisMicros,
    unrealizedPnlMicros,
    weightRemainder: BigInt(0),
  };
}

function allocateWeights(positions: WorkingPosition[], totalValue: bigint) {
  const included = positions.filter(
    (position) => position.currentValueMicros !== null,
  );
  let allocated = 0;

  for (const position of included) {
    const scaled = position.currentValueMicros! * BASIS_POINTS;
    position.weightBps = Number(scaled / totalValue);
    position.weightRemainder = scaled % totalValue;
    allocated += position.weightBps;
  }

  const remainderOrder = [...included].sort((left, right) => {
    if (left.weightRemainder > right.weightRemainder) return -1;
    if (left.weightRemainder < right.weightRemainder) return 1;
    return compareSymbols(left.symbolId, right.symbolId);
  });
  for (let index = 0; index < 10_000 - allocated; index += 1) {
    const position = remainderOrder[index];
    if (!position) break;
    position.weightBps = (position.weightBps ?? 0) + 1;
  }
}

function contributorFrom(position: WorkingPosition): PortfolioPulseContributor {
  return {
    symbolId: position.symbolId,
    ticker: position.ticker,
    dayPnl: position.dayPnl!,
    currentValue: position.currentValue!,
    weightBps: position.weightBps!,
  };
}

function publicPosition(position: WorkingPosition): PortfolioPulsePosition {
  return {
    symbolId: position.symbolId,
    ticker: position.ticker,
    exchange: position.exchange,
    name: position.name,
    quantity: position.quantity,
    averageCost: position.averageCost,
    costCurrency: position.costCurrency,
    included: position.included,
    exclusionReason: position.exclusionReason,
    currentPrice: position.currentPrice,
    previousClosePrice: position.previousClosePrice,
    currentValue: position.currentValue,
    previousCloseValue: position.previousCloseValue,
    dayPnl: position.dayPnl,
    dayChangePercent: position.dayChangePercent,
    costBasis: position.costBasis,
    unrealizedPnl: position.unrealizedPnl,
    weightBps: position.weightBps,
    quote: position.quote,
  };
}

/**
 * Produces deterministic portfolio arithmetic only. It never emits advice or
 * authorizes an order. Quotes that are missing, non-live, non-fresh, or
 * numerically invalid remain visible as explicitly excluded positions.
 */
export function calculatePortfolioPulse(
  input: PortfolioPulseInput,
): PortfolioPulse {
  const { holdings, snapshots } = input;
  const calculatedAtTimestamp = canonicalUtcTimestamp(input.calculatedAt);
  if (calculatedAtTimestamp === null) {
    throw new PortfolioPulseCalculationError("invalid_calculated_at");
  }
  if (holdings.length > MAX_PORTFOLIO_PULSE_POSITIONS) {
    throw new PortfolioPulseCalculationError("too_many_positions");
  }
  const sourcePositionCount = input.sourcePositionCount ?? holdings.length;
  if (
    !Number.isSafeInteger(sourcePositionCount) ||
    sourcePositionCount < holdings.length
  ) {
    throw new PortfolioPulseCalculationError("invalid_source_position_count");
  }
  const omittedPositions = sourcePositionCount - holdings.length;

  const symbolCounts = new Map<CanonicalSymbol, number>();
  for (const holding of holdings) {
    symbolCounts.set(
      holding.symbolId,
      (symbolCounts.get(holding.symbolId) ?? 0) + 1,
    );
  }

  const positions = [...holdings]
    .sort((left, right) => compareSymbols(left.symbolId, right.symbolId))
    .map((holding): WorkingPosition => {
      const snapshot = snapshots.get(holding.symbolId);
      const quote = evaluateQuote(
        holding,
        snapshot,
        calculatedAtTimestamp,
      );
      const quoteTrust = quote.eligible ? "live_fresh" : quote.trust;
      if ((symbolCounts.get(holding.symbolId) ?? 0) > 1) {
        return excludedPosition(
          holding,
          "duplicate_symbol",
          snapshot,
          quoteTrust,
          quote.freshness,
        );
      }
      if (holding.costCurrency !== undefined && holding.costCurrency !== "USD") {
        return excludedPosition(
          holding,
          "unsupported_currency",
          snapshot,
          quoteTrust,
          quote.freshness,
        );
      }

      const quantityMicros = parseHoldingDecimal(holding.quantity, {
        allowZero: false,
        maxMicros: MAX_QUANTITY_MICROS,
      });
      if (quantityMicros === null) {
        return excludedPosition(
          holding,
          "invalid_quantity",
          snapshot,
          quoteTrust,
          quote.freshness,
        );
      }

      const averageCostMicros =
        holding.averageCost === null
          ? null
          : parseHoldingDecimal(holding.averageCost, {
              allowZero: true,
              maxMicros: MAX_AVERAGE_COST_MICROS,
            });
      if (holding.averageCost !== null && averageCostMicros === null) {
        return excludedPosition(
          holding,
          "invalid_average_cost",
          snapshot,
          quoteTrust,
          quote.freshness,
        );
      }

      if (!quote.eligible) {
        return excludedPosition(
          holding,
          quote.reason,
          snapshot,
          quote.trust,
          quote.freshness,
        );
      }

      if (
        multiplyMicros(quantityMicros, quote.currentPriceMicros) < BigInt(1) ||
        multiplyMicros(quantityMicros, quote.previousClosePriceMicros) <
          BigInt(1)
      ) {
        return excludedPosition(
          holding,
          "value_below_minimum_precision",
          snapshot,
          "live_fresh",
          quote.freshness,
        );
      }

      return includedPosition(
        holding,
        snapshot!,
        quantityMicros,
        averageCostMicros,
        quote.currentPriceMicros,
        quote.previousClosePriceMicros,
        quote.freshness,
      );
    });

  const included = positions.filter(
    (position) => position.currentValueMicros !== null,
  );
  const totalCurrentValue = included.reduce(
    (sum, position) => sum + position.currentValueMicros!,
    BigInt(0),
  );
  const totalPreviousCloseValue = included.reduce(
    (sum, position) => sum + position.previousCloseValueMicros!,
    BigInt(0),
  );
  const totalDayPnl = included.reduce(
    (sum, position) => sum + position.dayPnlMicros!,
    BigInt(0),
  );
  const costBasisPositions = included.filter(
    (position) => position.costBasisMicros !== null,
  );
  const totalCostBasis = costBasisPositions.reduce(
    (sum, position) => sum + position.costBasisMicros!,
    BigInt(0),
  );
  const totalUnrealizedPnl = costBasisPositions.reduce(
    (sum, position) => sum + position.unrealizedPnlMicros!,
    BigInt(0),
  );

  if (totalCurrentValue > BigInt(0)) {
    allocateWeights(positions, totalCurrentValue);
  }

  const positive = included
    .filter((position) => position.dayPnlMicros! > BigInt(0))
    .sort((left, right) => {
      if (left.dayPnlMicros! > right.dayPnlMicros!) return -1;
      if (left.dayPnlMicros! < right.dayPnlMicros!) return 1;
      return compareSymbols(left.symbolId, right.symbolId);
    })
    .map(contributorFrom);
  const negative = included
    .filter((position) => position.dayPnlMicros! < BigInt(0))
    .sort((left, right) => {
      if (left.dayPnlMicros! < right.dayPnlMicros!) return -1;
      if (left.dayPnlMicros! > right.dayPnlMicros!) return 1;
      return compareSymbols(left.symbolId, right.symbolId);
    })
    .map(contributorFrom);

  const oldestAsOf = included.reduce<
    { value: string; timestamp: number } | null
  >((oldest, position) => {
    const value = position.quote.asOf!;
    const timestamp = Date.parse(value);
    if (
      oldest === null ||
      timestamp < oldest.timestamp ||
      (timestamp === oldest.timestamp && value < oldest.value)
    ) {
      return { value, timestamp };
    }
    return oldest;
  }, null);

  const coverageStatus =
    included.length === 0
      ? "none"
      : included.length === positions.length && omittedPositions === 0
        ? "complete"
        : "partial";
  const costBasisStatus =
    costBasisPositions.length === 0
      ? "none"
      : costBasisPositions.length === included.length && omittedPositions === 0
        ? "complete"
        : "partial";

  return {
    currency: "USD",
    calculatedAt: input.calculatedAt,
    asOf: oldestAsOf?.value ?? null,
    tradeExecutionAllowed: false,
    modelOutputRole: "portfolio_math_only",
    totals: {
      currentValue:
        included.length === 0 ? null : formatMicros(totalCurrentValue),
      previousCloseValue:
        included.length === 0
          ? null
          : formatMicros(totalPreviousCloseValue),
      dayPnl: included.length === 0 ? null : formatMicros(totalDayPnl),
      dayChangePercent:
        included.length === 0
          ? null
          : percentFromRatio(totalDayPnl, totalPreviousCloseValue),
      coveredCostBasis:
        costBasisPositions.length === 0 ? null : formatMicros(totalCostBasis),
      coveredUnrealizedPnl:
        costBasisPositions.length === 0
          ? null
          : formatMicros(totalUnrealizedPnl),
    },
    coverage: {
      status: coverageStatus,
      totalPositions: sourcePositionCount,
      consideredPositions: positions.length,
      omittedPositions,
      truncated: omittedPositions > 0,
      includedPositions: included.length,
      excludedPositions: positions.length - included.length,
      delayedPositions: included.filter(
        (position) => position.quote.isDelayed === true,
      ).length,
      costBasisPositions: costBasisPositions.length,
      costBasisStatus,
    },
    positions: positions.map(publicPosition),
    contributors: { positive, negative },
  };
}
