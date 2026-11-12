import type { CanonicalSymbol } from "@/lib/market-types";
import {
  calculatePortfolioPulse,
  MAX_PORTFOLIO_PULSE_POSITIONS,
  type PortfolioPulse,
  type PortfolioPulseHoldingInput,
  type PortfolioPulseSnapshotInput,
} from "@/lib/portfolio/portfolio-pulse";
import { getPortfolioPulseHoldings } from "@/lib/repositories/portfolio";
import { liveMarketData } from "@/lib/services/live-market-data";

type PortfolioPulseHoldingsRead = Awaited<
  ReturnType<typeof getPortfolioPulseHoldings>
>;

export interface PortfolioPulseDependencies {
  getHoldings(ownerId: string): Promise<PortfolioPulseHoldingsRead>;
  getSnapshots(
    symbols: CanonicalSymbol[],
  ): Promise<ReadonlyMap<CanonicalSymbol, PortfolioPulseSnapshotInput>>;
  calculate: typeof calculatePortfolioPulse;
  now(): Date;
}

const defaultDependencies: PortfolioPulseDependencies = {
  getHoldings: getPortfolioPulseHoldings,
  getSnapshots: (symbols) => liveMarketData.getSnapshots(symbols),
  calculate: calculatePortfolioPulse,
  now: () => new Date(),
};

function pulseHolding(
  holding: PortfolioPulseHoldingsRead["holdings"][number],
): PortfolioPulseHoldingInput {
  return {
    symbolId: holding.symbolId,
    ticker: holding.ticker,
    exchange: holding.exchange,
    name: holding.name,
    quantity: holding.quantity,
    averageCost: holding.averageCost,
    costCurrency: holding.costCurrency,
  };
}

/**
 * Builds one deterministic, non-trading pulse from durable owner holdings and
 * at most one bounded market-snapshot batch. The calculator keeps unavailable,
 * demo, fixture, and stale peers visible as explicit exclusions.
 */
export async function getPortfolioPulse(
  ownerId: string,
  dependencies: PortfolioPulseDependencies = defaultDependencies,
): Promise<PortfolioPulse> {
  const portfolio = await dependencies.getHoldings(ownerId);
  const considered = portfolio.holdings.slice(
    0,
    MAX_PORTFOLIO_PULSE_POSITIONS,
  );
  const holdings = considered.map(pulseHolding);
  const snapshots =
    holdings.length === 0
      ? new Map<CanonicalSymbol, PortfolioPulseSnapshotInput>()
      : await dependencies.getSnapshots(
          holdings.map((holding) => holding.symbolId),
        );

  return dependencies.calculate({
    holdings,
    snapshots,
    sourcePositionCount: portfolio.totalPositions,
    calculatedAt: dependencies.now().toISOString(),
  });
}
