import type { CanonicalSymbol } from "@/lib/market-types";
import type { PortfolioDecisionSupportRequest } from "@/lib/portfolio/contracts";
import {
  decimalToMicros,
  MAX_AVERAGE_COST_MICROS,
  MAX_QUANTITY_MICROS,
} from "@/lib/portfolio/decimal";
import {
  buildDecisionSupport,
  type DecisionSupportResult,
} from "@/lib/portfolio/decision-support";
import { getUserPortfolio } from "@/lib/repositories/portfolio";
import {
  liveMarketData,
  type IntelligenceFeedItem,
  type OrchestratedIntelligenceFeed,
  type OrchestratedSnapshot,
} from "@/lib/services/live-market-data";
import {
  resolveCanonicalInstrument,
  type ResolvedInstrument,
} from "@/lib/services/instrument-resolution";

type PortfolioRead = Awaited<ReturnType<typeof getUserPortfolio>>;

export interface PortfolioDecisionSupportDependencies {
  resolveInstrument(symbolId: CanonicalSymbol): Promise<ResolvedInstrument>;
  getPortfolio(ownerId: string): Promise<PortfolioRead>;
  getSnapshot(symbolId: CanonicalSymbol): Promise<OrchestratedSnapshot>;
  getIntelligence(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
    minimumMateriality: "low";
  }): Promise<OrchestratedIntelligenceFeed>;
  now(): Date;
}

const defaultDependencies: PortfolioDecisionSupportDependencies = {
  resolveInstrument: resolveCanonicalInstrument,
  getPortfolio: getUserPortfolio,
  getSnapshot: (symbolId) => liveMarketData.getSnapshot(symbolId),
  getIntelligence: (options) => liveMarketData.getIntelligenceFeed(options),
  now: () => new Date(),
};

function isRelevantLiveEvidence(
  item: IntelligenceFeedItem,
  symbolId: CanonicalSymbol,
) {
  return item.isLive && item.symbolIds.includes(symbolId);
}

function unavailableDecision(
  symbolId: CanonicalSymbol,
  reason: string,
): DecisionSupportResult {
  return {
    eligible: false,
    symbolId,
    suppressedReasons: [reason],
    tradeExecutionAllowed: false,
    modelOutputRole: "scenario_math_only",
  };
}

export async function getPortfolioDecisionSupport(
  ownerId: string,
  request: PortfolioDecisionSupportRequest,
  dependencies: PortfolioDecisionSupportDependencies = defaultDependencies,
) {
  const instrument = await dependencies.resolveInstrument(request.symbol_id);
  const symbolId = instrument.id;
  const [portfolio, snapshotResult, feedResult] = await Promise.all([
    dependencies.getPortfolio(ownerId),
    dependencies.getSnapshot(symbolId),
    dependencies.getIntelligence({
      symbols: [symbolId],
      since: new Date(
        dependencies.now().getTime() - 7 * 24 * 60 * 60 * 1_000,
      ).toISOString(),
      limit: 50,
      minimumMateriality: "low",
    }),
  ]);

  const holding = portfolio.holdings.find(
    (candidate) => candidate.symbolId === symbolId,
  );
  const snapshot = snapshotResult.data;
  if (!snapshot || !Number.isFinite(snapshot.price) || snapshot.price <= 0) {
    return {
      decision: unavailableDecision(symbolId, "market_data_unavailable"),
      context: {
        horizon: request.horizon,
        hasHolding: Boolean(holding),
        evidenceCount: 0,
        independentSourceCount: 0,
      },
    };
  }

  const evidence = feedResult.data.filter((item) =>
    isRelevantLiveEvidence(item, symbolId),
  );
  const evidenceIds = [...new Set(evidence.map((item) => item.id))];
  const independentSourceCount = new Set(evidence.map((item) => item.source)).size;
  const holdingQuantityMicros = holding
    ? decimalToMicros(holding.quantity, {
        allowZero: false,
        maxMicros: MAX_QUANTITY_MICROS,
      })
    : 0;
  const userBudgetMicros = request.budget
    ? decimalToMicros(request.budget, {
        allowZero: false,
        maxMicros: MAX_AVERAGE_COST_MICROS,
      })
    : null;
  const priceMicros = decimalToMicros(snapshot.price.toFixed(6), {
    allowZero: false,
    maxMicros: MAX_AVERAGE_COST_MICROS,
  });

  const decision = buildDecisionSupport({
    symbolId,
    holdingQuantityMicros,
    userBudgetMicros,
    market: {
      priceMicros,
      asOf: snapshot.asOf,
      dataMode: snapshotResult.meta.dataMode,
      freshness: snapshotResult.meta.freshness.state,
    },
    evidence: {
      evidenceIds,
      independentSourceCount,
      materialEventCount: evidence.filter((item) =>
        item.materiality === "high" || item.materiality === "critical",
      ).length,
      contradictorySignalCount: 0,
      hasRecentFiling: evidence.some((item) => item.sourceKind === "sec_filing"),
    },
    preset: request.preset,
  });

  return {
    decision,
    context: {
      horizon: request.horizon,
      hasHolding: Boolean(holding),
      holdingQuantity: holding?.quantity ?? null,
      evidenceCount: evidenceIds.length,
      independentSourceCount,
      marketDataMode: snapshotResult.meta.dataMode,
      marketFreshness: snapshotResult.meta.freshness.state,
      evidenceDataMode: feedResult.meta.dataMode,
    },
  };
}
