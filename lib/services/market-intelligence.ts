import {
  allEvents,
  defaultWatchlist,
  stockWorkspaces,
  workspaceBySymbol,
} from "@/lib/demo-market-data";
import type { CanonicalSymbol, Materiality } from "@/lib/market-types";

const materialityRank: Record<Materiality, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function searchSymbols(query: string) {
  const normalized = query.trim().toLowerCase();

  return stockWorkspaces
    .filter(
      ({ instrument }) =>
        !normalized ||
        instrument.ticker.toLowerCase().includes(normalized) ||
        instrument.name.toLowerCase().includes(normalized),
    )
    .map(({ instrument, snapshot }) => ({ instrument, snapshot }))
    .slice(0, 20);
}

export function getMarketSnapshot(symbolId: CanonicalSymbol) {
  return workspaceBySymbol.get(symbolId)?.snapshot ?? null;
}

export function getOmnigazeView(symbolId: CanonicalSymbol) {
  const workspace = workspaceBySymbol.get(symbolId);
  if (!workspace) return null;

  return {
    instrument: workspace.instrument,
    view: workspace.view,
    evidence: workspace.evidence,
  };
}

export function getIntelligenceFeed({
  symbolId,
  minimumMateriality = "low",
  limit = 20,
}: {
  symbolId?: CanonicalSymbol;
  minimumMateriality?: Materiality;
  limit?: number;
}) {
  return allEvents
    .filter((event) => !symbolId || event.symbolId === symbolId)
    .filter(
      (event) =>
        materialityRank[event.materiality] >= materialityRank[minimumMateriality],
    )
    .slice(0, Math.max(1, Math.min(limit, 100)));
}

export function getDefaultWatchlistDashboard() {
  const items = defaultWatchlist
    .map((symbolId) => workspaceBySymbol.get(symbolId))
    .filter(Boolean)
    .map((workspace) => ({
      instrument: workspace!.instrument,
      snapshot: workspace!.snapshot,
      latestEvent: workspace!.events[0],
      view: workspace!.view,
    }));

  return {
    watchlist: {
      id: "demo-core-holdings",
      name: "Core holdings",
      items,
    },
    summary: {
      materialEvents: allEvents.filter((event) =>
        ["high", "critical"].includes(event.materiality),
      ).length,
      positiveMovers: items.filter((item) => item.snapshot.change > 0).length,
      negativeMovers: items.filter((item) => item.snapshot.change < 0).length,
    },
  };
}

export const serviceMeta = {
  mode: "demo" as const,
  asOf: "2026-11-11T18:43:00.000Z",
  isDelayed: true,
  provider: "Omnigaze fixture provider",
  notice:
    "Foundation data only. Live providers will replace this adapter without changing the contract.",
};
