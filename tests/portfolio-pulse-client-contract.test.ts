import { describe, expect, it } from "vitest";
import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import {
  parsePortfolioPulse as parsePortfolioPulseWithClock,
  PortfolioPulseClientContractError,
} from "@/lib/portfolio/portfolio-pulse-client-contract";
import {
  calculatePortfolioPulse,
  type PortfolioPulse,
  type PortfolioPulseHoldingInput,
  type PortfolioPulseSnapshotInput,
} from "@/lib/portfolio/portfolio-pulse";

const CALCULATED_AT = "2026-11-12T18:00:00.000Z";
const QUOTE_AS_OF = "2026-11-12T17:59:45.000Z";

function parsePortfolioPulse(input: unknown) {
  return parsePortfolioPulseWithClock(input, new Date(CALCULATED_AT));
}

function holding(
  symbolId: CanonicalSymbol,
  quantity: string,
  averageCost: string | null,
): PortfolioPulseHoldingInput {
  const [exchange, ticker] = symbolId.split(":");
  return {
    symbolId,
    ticker,
    exchange,
    name: `${ticker} Incorporated`,
    quantity,
    averageCost,
    costCurrency: "USD",
  };
}

function snapshot(
  symbolId: CanonicalSymbol,
  price: number,
  previousClose: number,
  asOf = QUOTE_AS_OF,
): PortfolioPulseSnapshotInput {
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
    isDelayed: false,
    delaySeconds: 0,
    provider: "test-provider",
    marketCoverage: "limited-exchange",
  };
  return {
    data,
    meta: {
      dataMode: "live",
      mode: "live",
      providerCoverage: "complete",
      coverage: "complete",
      freshness: { state: "fresh", asOf, ageSeconds: 15 },
    },
  };
}

function validPulse(
  calculatedAt = CALCULATED_AT,
  asOf = QUOTE_AS_OF,
): PortfolioPulse {
  const holdings = [
    holding("NASDAQ:AAA", "2", "90"),
    holding("NASDAQ:BBB", "1", null),
    holding("NASDAQ:CCC", "1", "105"),
  ];
  const snapshots = new Map<CanonicalSymbol, PortfolioPulseSnapshotInput>([
    ["NASDAQ:AAA", snapshot("NASDAQ:AAA", 110, 100, asOf)],
    ["NASDAQ:BBB", snapshot("NASDAQ:BBB", 110, 100, asOf)],
    ["NASDAQ:CCC", snapshot("NASDAQ:CCC", 99.5, 100, asOf)],
  ]);
  return calculatePortfolioPulse({
    holdings,
    snapshots,
    calculatedAt,
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function expectContractError(
  callback: () => unknown,
  code: PortfolioPulseClientContractError["code"],
) {
  expect(callback).toThrowError(PortfolioPulseClientContractError);
  expect(callback).toThrowError(code);
}

describe("Portfolio Pulse client contract", () => {
  it("accepts the complete fixed-point calculator output", () => {
    const pulse = validPulse();

    expect(parsePortfolioPulse(pulse)).toEqual(pulse);
  });

  it("rejects non-canonical decimals and unknown response fields", () => {
    const exponent = clone(validPulse());
    exponent.positions[0]!.currentValue = "2.2e2";
    expectContractError(() => parsePortfolioPulse(exponent), "invalid_response");

    const negativeZero = clone(validPulse());
    negativeZero.positions[0]!.dayPnl = "-0";
    expectContractError(
      () => parsePortfolioPulse(negativeZero),
      "invalid_response",
    );

    const extra = { ...validPulse(), ownerId: "someone-else" };
    expectContractError(() => parsePortfolioPulse(extra), "invalid_response");
  });

  it("rejects canonical symbol, ticker, exchange, duplicate, and order drift", () => {
    const tickerMismatch = clone(validPulse());
    tickerMismatch.positions[0]!.ticker = "WRONG";
    expectContractError(
      () => parsePortfolioPulse(tickerMismatch),
      "identity_mismatch",
    );

    const lowercase = clone(validPulse());
    lowercase.positions[0]!.symbolId = "nasdaq:aaa" as CanonicalSymbol;
    expectContractError(() => parsePortfolioPulse(lowercase), "invalid_response");

    const duplicate = clone(validPulse());
    duplicate.positions[1]!.symbolId = duplicate.positions[0]!.symbolId;
    duplicate.positions[1]!.ticker = duplicate.positions[0]!.ticker;
    expectContractError(
      () => parsePortfolioPulse(duplicate),
      "identity_mismatch",
    );

    const reordered = clone(validPulse());
    [reordered.positions[0], reordered.positions[1]] = [
      reordered.positions[1]!,
      reordered.positions[0]!,
    ];
    expectContractError(
      () => parsePortfolioPulse(reordered),
      "identity_mismatch",
    );
  });

  it("rejects inconsistent coverage, count, truncation, and cost coverage", () => {
    for (const mutate of [
      (pulse: PortfolioPulse) => (pulse.coverage.totalPositions += 1),
      (pulse: PortfolioPulse) => (pulse.coverage.includedPositions -= 1),
      (pulse: PortfolioPulse) => (pulse.coverage.truncated = true),
      (pulse: PortfolioPulse) => (pulse.coverage.costBasisPositions = 3),
      (pulse: PortfolioPulse) => (pulse.coverage.status = "partial"),
    ]) {
      const pulse = clone(validPulse());
      mutate(pulse);
      expectContractError(() => parsePortfolioPulse(pulse), "unsafe_response");
    }
  });

  it("rejects incorrect weights even when their sum remains 10,000 bps", () => {
    const wrongSum = clone(validPulse());
    wrongSum.positions[0]!.weightBps! -= 1;
    expectContractError(() => parsePortfolioPulse(wrongSum), "unsafe_response");

    const wrongAllocation = clone(validPulse());
    wrongAllocation.positions[0]!.weightBps! -= 1;
    wrongAllocation.positions[1]!.weightBps! += 1;
    const first = wrongAllocation.contributors.positive.find(
      ({ symbolId }) => symbolId === wrongAllocation.positions[0]!.symbolId,
    )!;
    const second = wrongAllocation.contributors.positive.find(
      ({ symbolId }) => symbolId === wrongAllocation.positions[1]!.symbolId,
    )!;
    first.weightBps -= 1;
    second.weightBps += 1;
    expectContractError(
      () => parsePortfolioPulse(wrongAllocation),
      "unsafe_response",
    );
  });

  it("rejects mismatched position and aggregate fixed-point arithmetic", () => {
    const positionValue = clone(validPulse());
    positionValue.positions[0]!.currentValue = "219";
    expectContractError(
      () => parsePortfolioPulse(positionValue),
      "unsafe_response",
    );

    const aggregate = clone(validPulse());
    aggregate.totals.dayPnl = "999";
    expectContractError(() => parsePortfolioPulse(aggregate), "unsafe_response");
  });

  it("rejects included positions without trustworthy fresh-live quote metadata", () => {
    const stale = clone(validPulse());
    stale.positions[0]!.quote.trust = "stale";
    stale.positions[0]!.quote.freshness = "stale";
    expectContractError(() => parsePortfolioPulse(stale), "unsafe_response");

    const fixture = clone(validPulse());
    fixture.positions[0]!.quote.marketCoverage = "fixture";
    expectContractError(() => parsePortfolioPulse(fixture), "unsafe_response");

    const unsafeDelay = clone(validPulse());
    unsafeDelay.positions[0]!.quote.isDelayed = true;
    expectContractError(
      () => parsePortfolioPulse(unsafeDelay),
      "unsafe_response",
    );
  });

  it("revalidates fresh quote age and future skew from calculatedAt", () => {
    const forgedOldQuote = clone(validPulse());
    const oldAsOf = "2020-01-01T00:00:00.000Z";
    forgedOldQuote.positions[0]!.quote.asOf = oldAsOf;
    forgedOldQuote.positions[0]!.quote.freshnessAsOf = oldAsOf;
    forgedOldQuote.positions[0]!.quote.ageSeconds = 0;
    expectContractError(
      () => parsePortfolioPulse(forgedOldQuote),
      "unsafe_response",
    );

    const forgedFutureQuote = clone(validPulse());
    const futureAsOf = "2026-11-12T18:05:01.000Z";
    forgedFutureQuote.positions[0]!.quote.asOf = futureAsOf;
    forgedFutureQuote.positions[0]!.quote.freshnessAsOf = futureAsOf;
    forgedFutureQuote.positions[0]!.quote.ageSeconds = 0;
    expectContractError(
      () => parsePortfolioPulse(forgedFutureQuote),
      "unsafe_response",
    );

    const invalidEvaluationTime = clone(validPulse()) as unknown as {
      calculatedAt: string;
    };
    invalidEvaluationTime.calculatedAt = "2026-11-12 18:00:00";
    expectContractError(
      () => parsePortfolioPulse(invalidEvaluationTime),
      "invalid_response",
    );
  });

  it("rejects replayed or future-dated evaluation times against a trusted clock", () => {
    const replayed = validPulse(
      "2026-11-12T17:39:59.000Z",
      "2026-11-12T17:39:44.000Z",
    );
    expectContractError(
      () => parsePortfolioPulse(replayed),
      "unsafe_response",
    );

    const futureDated = validPulse(
      "2026-11-12T18:05:01.000Z",
      "2026-11-12T18:04:46.000Z",
    );
    expectContractError(
      () => parsePortfolioPulse(futureDated),
      "unsafe_response",
    );
  });

  it("expires quotes against trusted now even when they were fresh at calculation", () => {
    const expired = validPulse(
      "2026-11-12T17:40:00.000Z",
      "2026-11-12T17:39:45.000Z",
    );

    expectContractError(
      () => parsePortfolioPulse(expired),
      "unsafe_response",
    );
  });

  it("enforces excluded-position nullability and reason-to-trust mapping", () => {
    const pulse = calculatePortfolioPulse({
      holdings: [holding("NASDAQ:MISSING", "2", "90")],
      snapshots: new Map(),
      calculatedAt: CALCULATED_AT,
    });
    expect(parsePortfolioPulse(pulse)).toEqual(pulse);

    const inventedZero = clone(pulse);
    inventedZero.positions[0]!.currentValue = "0";
    expectContractError(
      () => parsePortfolioPulse(inventedZero),
      "invalid_response",
    );

    const noReason = clone(pulse);
    noReason.positions[0]!.exclusionReason = null;
    expectContractError(() => parsePortfolioPulse(noReason), "unsafe_response");

    const falseTrust = clone(pulse);
    falseTrust.positions[0]!.quote.trust = "live_fresh";
    expectContractError(
      () => parsePortfolioPulse(falseTrust),
      "unsafe_response",
    );
  });

  it("accepts an explicit below-minimum-precision exclusion", () => {
    const pulse = calculatePortfolioPulse({
      holdings: [holding("NASDAQ:MICRO", "0.000001", null)],
      snapshots: new Map([
        ["NASDAQ:MICRO", snapshot("NASDAQ:MICRO", 0.000001, 0.000001)],
      ]),
      calculatedAt: CALCULATED_AT,
    });

    expect(pulse.positions[0]).toMatchObject({
      included: false,
      exclusionReason: "value_below_minimum_precision",
      currentValue: null,
      quote: { trust: "live_fresh", ageSeconds: 15 },
    });
    expect(parsePortfolioPulse(pulse)).toEqual(pulse);
  });

  it("requires contributors to be exhaustive, matching, signed, and ordered", () => {
    const mismatch = clone(validPulse());
    mismatch.contributors.positive[0]!.currentValue = "1";
    expectContractError(() => parsePortfolioPulse(mismatch), "unsafe_response");

    const wrongSign = clone(validPulse());
    wrongSign.contributors.positive[0]!.dayPnl = "-20";
    expectContractError(() => parsePortfolioPulse(wrongSign), "unsafe_response");

    const reordered = clone(validPulse());
    reordered.contributors.positive.reverse();
    expectContractError(
      () => parsePortfolioPulse(reordered),
      "unsafe_response",
    );

    const omitted = clone(validPulse());
    omitted.contributors.negative = [];
    expectContractError(() => parsePortfolioPulse(omitted), "unsafe_response");
  });

  it("rejects any attempt to enable execution or change the math-only role", () => {
    const execution = clone(validPulse()) as unknown as {
      tradeExecutionAllowed: boolean;
    };
    execution.tradeExecutionAllowed = true;
    expectContractError(() => parsePortfolioPulse(execution), "invalid_response");

    const role = clone(validPulse()) as unknown as { modelOutputRole: string };
    role.modelOutputRole = "trade_advice";
    expectContractError(() => parsePortfolioPulse(role), "invalid_response");
  });
});
