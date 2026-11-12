import { describe, expect, it } from "vitest";
import type { CanonicalSymbol } from "@/lib/market-types";
import { MAX_PORTFOLIO_PULSE_POSITIONS } from "@/lib/portfolio/portfolio-pulse";
import {
  buildPortfolioPulseSnapshotBatches,
  PORTFOLIO_PULSE_MAX_AUXILIARY_SYMBOLS,
  PORTFOLIO_PULSE_MAX_SNAPSHOT_REQUESTS,
  PORTFOLIO_PULSE_SNAPSHOT_BATCH_SIZE,
} from "@/lib/portfolio/portfolio-pulse-refresh";

function symbol(prefix: string, index: number) {
  return `NASDAQ:${prefix}${index.toString().padStart(2, "0")}` as CanonicalSymbol;
}

describe("Portfolio Pulse snapshot refresh plan", () => {
  it("covers fifty holdings before auxiliary watchlist symbols", () => {
    const holdings = Array.from({ length: 55 }, (_, index) =>
      symbol("H", 54 - index),
    );
    const visible = Array.from({ length: 30 }, (_, index) => symbol("W", index));
    const selected = symbol("SELECTED", 0);

    const batches = buildPortfolioPulseSnapshotBatches({
      holdingSymbols: holdings,
      selectedSymbol: selected,
      visibleSymbols: visible,
    });
    const flattened = batches.flat();
    const expectedHoldings = [...holdings].sort().slice(
      0,
      MAX_PORTFOLIO_PULSE_POSITIONS,
    );

    expect(flattened.slice(0, MAX_PORTFOLIO_PULSE_POSITIONS)).toEqual(
      expectedHoldings,
    );
    expect(flattened).toContain(selected);
    expect(flattened).toHaveLength(
      MAX_PORTFOLIO_PULSE_POSITIONS +
        PORTFOLIO_PULSE_MAX_AUXILIARY_SYMBOLS,
    );
    expect(new Set(flattened).size).toBe(flattened.length);
  });

  it("keeps every request and the total fanout bounded", () => {
    const batches = buildPortfolioPulseSnapshotBatches({
      holdingSymbols: Array.from({ length: 50 }, (_, index) => symbol("H", index)),
      selectedSymbol: symbol("S", 0),
      visibleSymbols: Array.from({ length: 100 }, (_, index) => symbol("W", index)),
    });

    expect(batches.length).toBeLessThanOrEqual(
      PORTFOLIO_PULSE_MAX_SNAPSHOT_REQUESTS,
    );
    expect(
      batches.every(
        (batch) =>
          batch.length > 0 && batch.length <= PORTFOLIO_PULSE_SNAPSHOT_BATCH_SIZE,
      ),
    ).toBe(true);
  });

  it("deduplicates a selected or visible symbol already held", () => {
    const held = symbol("H", 0);
    const batches = buildPortfolioPulseSnapshotBatches({
      holdingSymbols: [held, held],
      selectedSymbol: held,
      visibleSymbols: [held, symbol("W", 0), symbol("W", 0)],
    });

    expect(batches.flat()).toEqual([held, symbol("W", 0)]);
  });
});
