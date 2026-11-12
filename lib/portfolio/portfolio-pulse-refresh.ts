import type { CanonicalSymbol } from "@/lib/market-types";
import { MAX_PORTFOLIO_PULSE_POSITIONS } from "@/lib/portfolio/portfolio-pulse";

export const PORTFOLIO_PULSE_SNAPSHOT_BATCH_SIZE = 12;
export const PORTFOLIO_PULSE_MAX_AUXILIARY_SYMBOLS = 12;
export const PORTFOLIO_PULSE_MAX_SNAPSHOT_REQUESTS = Math.ceil(
  (MAX_PORTFOLIO_PULSE_POSITIONS + PORTFOLIO_PULSE_MAX_AUXILIARY_SYMBOLS) /
    PORTFOLIO_PULSE_SNAPSHOT_BATCH_SIZE,
);

type PortfolioPulseRefreshInput = {
  holdingSymbols: readonly CanonicalSymbol[];
  selectedSymbol: CanonicalSymbol;
  visibleSymbols: readonly CanonicalSymbol[];
};

function compareSymbols(left: CanonicalSymbol, right: CanonicalSymbol) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/**
 * Builds one bounded refresh plan. Portfolio holdings are always scheduled
 * before auxiliary watchlist symbols, and every provider-facing request stays
 * within the public 12-symbol batch contract.
 */
export function buildPortfolioPulseSnapshotBatches({
  holdingSymbols,
  selectedSymbol,
  visibleSymbols,
}: PortfolioPulseRefreshInput) {
  const holdings = Array.from(new Set(holdingSymbols))
    .sort(compareSymbols)
    .slice(0, MAX_PORTFOLIO_PULSE_POSITIONS);
  const scheduled = new Set<CanonicalSymbol>(holdings);
  const auxiliary: CanonicalSymbol[] = [];

  for (const symbol of [selectedSymbol, ...visibleSymbols]) {
    if (scheduled.has(symbol)) continue;
    scheduled.add(symbol);
    auxiliary.push(symbol);
    if (auxiliary.length === PORTFOLIO_PULSE_MAX_AUXILIARY_SYMBOLS) break;
  }

  const symbols = [...holdings, ...auxiliary];
  return Array.from(
    { length: Math.ceil(symbols.length / PORTFOLIO_PULSE_SNAPSHOT_BATCH_SIZE) },
    (_, index) =>
      symbols.slice(
        index * PORTFOLIO_PULSE_SNAPSHOT_BATCH_SIZE,
        (index + 1) * PORTFOLIO_PULSE_SNAPSHOT_BATCH_SIZE,
      ),
  );
}
