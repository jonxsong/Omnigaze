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

const EVIDENCE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_EVIDENCE_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const MAX_EVIDENCE_CITATIONS = 12;
const MIN_QUOTE_FRESHNESS_MS = 20 * 60 * 1_000;

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
  now: Date,
) {
  const publishedAt = Date.parse(item.publishedAt);
  const receivedAt = Date.parse(item.receivedAt);
  const nowMs = now.getTime();

  return (
    item.isLive &&
    item.symbolIds.includes(symbolId) &&
    Number.isFinite(publishedAt) &&
    Number.isFinite(receivedAt) &&
    publishedAt >= nowMs - EVIDENCE_LOOKBACK_MS &&
    publishedAt <= nowMs + MAX_EVIDENCE_FUTURE_SKEW_MS &&
    receivedAt <= nowMs + MAX_EVIDENCE_FUTURE_SKEW_MS
  );
}

function unavailableDecision(
  symbolId: CanonicalSymbol,
  reasons: string | string[],
): DecisionSupportResult {
  return {
    eligible: false,
    symbolId,
    suppressedReasons: Array.isArray(reasons) ? reasons : [reasons],
    tradeExecutionAllowed: false,
    modelOutputRole: "scenario_math_only",
  };
}

function holdingProvenance(
  holding: PortfolioRead["holdings"][number] | undefined,
) {
  return holding
    ? {
        symbolId: holding.symbolId,
        quantity: holding.quantity,
        averageCost: holding.averageCost,
        version: holding.version,
        quantityAsOf: holding.quantityAsOf,
      }
    : null;
}

function quoteProvenance(snapshot: NonNullable<OrchestratedSnapshot["data"]>) {
  const asOfMs = Date.parse(snapshot.asOf);
  const freshForMs = Math.max(
    MIN_QUOTE_FRESHNESS_MS,
    (snapshot.delaySeconds + 300) * 1_000,
  );

  return {
    price: snapshot.price,
    asOf: snapshot.asOf,
    freshUntil: Number.isFinite(asOfMs)
      ? new Date(asOfMs + freshForMs).toISOString()
      : null,
    provider: snapshot.provider,
    marketCoverage: snapshot.marketCoverage,
    isDelayed: snapshot.isDelayed,
    delaySeconds: snapshot.delaySeconds,
  };
}

function evidenceCitation(item: IntelligenceFeedItem) {
  return {
    id: item.id,
    headline: item.headline,
    source: item.source,
    sourceKind: item.sourceKind,
    publishedAt: item.publishedAt,
    sourceUrl: item.sourceUrl,
    materiality: item.materiality,
  };
}

export async function getPortfolioDecisionSupport(
  ownerId: string,
  request: PortfolioDecisionSupportRequest,
  dependencies: PortfolioDecisionSupportDependencies = defaultDependencies,
) {
  const instrument = await dependencies.resolveInstrument(request.symbol_id);
  const symbolId = instrument.id;
  const now = dependencies.now();
  const [portfolio, snapshotResult, feedResult] = await Promise.all([
    dependencies.getPortfolio(ownerId),
    dependencies.getSnapshot(symbolId),
    dependencies.getIntelligence({
      symbols: [symbolId],
      since: new Date(now.getTime() - EVIDENCE_LOOKBACK_MS).toISOString(),
      limit: 50,
      minimumMateriality: "low",
    }),
  ]);

  const holding = portfolio.holdings.find(
    (candidate) => candidate.symbolId === symbolId,
  );
  const holdingContext = holdingProvenance(holding);
  const snapshot = snapshotResult.data;
  if (!snapshot || !Number.isFinite(snapshot.price) || snapshot.price <= 0) {
    return {
      decision: unavailableDecision(symbolId, "market_data_unavailable"),
      context: {
        horizon: request.horizon,
        hasHolding: Boolean(holding),
        holding: holdingContext,
        quote: null,
        evidence: [],
        evidenceCount: 0,
        independentSourceCount: 0,
        providerStreamCount: 0,
        evidenceDataMode: feedResult.meta.dataMode,
        evidenceFreshness: feedResult.meta.freshness.state,
      },
    };
  }

  const evidence = Array.from(
    new Map(
      feedResult.data
        .filter((item) => isRelevantLiveEvidence(item, symbolId, now))
        .map((item) => [item.id, item]),
    ).values(),
  );
  const evidenceIds = [...new Set(evidence.map((item) => item.id))];
  const independentSourceCount = new Set(evidence.map((item) => item.source)).size;
  const citations = evidence
    .slice(0, MAX_EVIDENCE_CITATIONS)
    .map(evidenceCitation);
  const quoteContext = quoteProvenance(snapshot);
  const context = {
    horizon: request.horizon,
    hasHolding: Boolean(holding),
    holdingQuantity: holding?.quantity ?? null,
    holding: holdingContext,
    quote: quoteContext,
    evidence: citations,
    evidenceCount: evidenceIds.length,
    independentSourceCount,
    providerStreamCount: independentSourceCount,
    marketDataMode: snapshotResult.meta.dataMode,
    marketFreshness: snapshotResult.meta.freshness.state,
    evidenceDataMode: feedResult.meta.dataMode,
    evidenceFreshness: feedResult.meta.freshness.state,
  };

  const evidenceSuppressionReasons: string[] = [];
  if (feedResult.meta.dataMode !== "live") {
    evidenceSuppressionReasons.push("live_evidence_required");
  }
  if (feedResult.meta.freshness.state !== "fresh") {
    evidenceSuppressionReasons.push("fresh_evidence_required");
  }
  if (evidenceSuppressionReasons.length > 0) {
    return {
      decision: unavailableDecision(symbolId, evidenceSuppressionReasons),
      context,
    };
  }

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
    context,
  };
}
