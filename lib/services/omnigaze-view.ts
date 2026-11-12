import {
  OMNIGAZE_ANALYSIS_PROMPT_VERSION,
  type OmnigazeAnalysis,
} from "@/lib/ai/analysis-contract";
import { buildAnalysisContextFromFeed } from "@/lib/ai/build-analysis-context";
import type { CanonicalSymbol, Evidence, Instrument } from "@/lib/market-types";
import type {
  IntelligenceFeedItem,
  OrchestratedIntelligenceFeed,
} from "@/lib/services/live-market-data";
import { liveMarketData } from "@/lib/services/live-market-data";
import {
  InstrumentResolutionError,
  resolveCanonicalInstrument,
  type ResolvedInstrument,
} from "@/lib/services/instrument-resolution";

export type OmnigazeViewErrorCode =
  | "ai_unconfigured"
  | "symbol_not_supported"
  | "asset_catalog_unavailable"
  | "live_evidence_required"
  | "fresh_evidence_required"
  | "insufficient_evidence";

const errorContract: Record<
  OmnigazeViewErrorCode,
  { status: number; message: string }
> = {
  ai_unconfigured: {
    status: 503,
    message: "AI analysis is not configured in this environment.",
  },
  symbol_not_supported: {
    status: 404,
    message: "Symbol not found.",
  },
  asset_catalog_unavailable: {
    status: 503,
    message: "The asset catalog is temporarily unavailable.",
  },
  live_evidence_required: {
    status: 422,
    message: "Live provider evidence is required for an Omnigaze View.",
  },
  fresh_evidence_required: {
    status: 422,
    message: "Fresh provider evidence is required for an Omnigaze View.",
  },
  insufficient_evidence: {
    status: 422,
    message: "No recent evidence is available for analysis.",
  },
};

export class OmnigazeViewError extends Error {
  readonly status: number;

  constructor(readonly code: OmnigazeViewErrorCode) {
    const contract = errorContract[code];
    super(contract.message);
    this.name = "OmnigazeViewError";
    this.status = contract.status;
  }
}

export interface OmnigazeViewCitation {
  id: string;
  title: string;
  publisher: string;
  publishedAt: string;
  url: string | null;
  classification: Evidence["classification"];
}

export interface OmnigazeEvidenceCoverage {
  score: number;
  label: "limited" | "moderate" | "strong";
  evidenceCount: number;
  sourceCount: number;
}

export interface GeneratedOmnigazeView {
  data: OmnigazeAnalysis;
  meta: {
    symbolId: CanonicalSymbol;
    dataCutoff: string;
    generatedAt: string;
    promptVersion: string;
    dataMode: "live";
    providerCoverage: "complete" | "partial";
    freshness: {
      state: "fresh";
      asOf: string;
      ageSeconds: number;
    };
    evidenceCount: number;
    eventCount: number;
    sources: string[];
    evidenceCoverage: OmnigazeEvidenceCoverage;
    citations: OmnigazeViewCitation[];
    confidenceMeaning: "evidence_interpretation_not_return_probability";
    disclaimer: string;
  };
}

type OmnigazeViewDependencies = {
  resolveInstrument(symbolId: CanonicalSymbol): Promise<ResolvedInstrument>;
  getIntelligenceFeed(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
  }): Promise<OrchestratedIntelligenceFeed>;
  analyze(input: {
    instrument: Instrument;
    evidence: Evidence[];
    events: ReturnType<typeof buildAnalysisContextFromFeed>["events"];
    dataCutoff: string;
  }): Promise<OmnigazeAnalysis>;
  now(): Date;
  isAiConfigured(): boolean;
};

const defaultDependencies: OmnigazeViewDependencies = {
  resolveInstrument: resolveCanonicalInstrument,
  getIntelligenceFeed: (options) => liveMarketData.getIntelligenceFeed(options),
  analyze: async (input) => {
    const { analyzeEvidence } = await import("@/lib/ai/analyze-evidence");
    return analyzeEvidence(input);
  },
  now: () => new Date(),
  isAiConfigured: () => Boolean(process.env.OPENAI_API_KEY),
};

function instrumentFromResolved(resolved: ResolvedInstrument): Instrument {
  return {
    id: resolved.id,
    ticker: resolved.ticker,
    exchange: resolved.exchange,
    name: resolved.name,
    sector: resolved.sector ?? "Unclassified",
    currency: resolved.currency,
  };
}

function coverageFor(evidence: Evidence[]) {
  const sourceCount = new Set(evidence.map((item) => item.publisher)).size;
  const evidenceScore = Math.min(evidence.length, 5) / 5;
  const sourceScore = Math.min(sourceCount, 3) / 3;
  const score = Math.round((0.2 + evidenceScore * 0.5 + sourceScore * 0.3) * 100) / 100;
  const label: OmnigazeEvidenceCoverage["label"] =
    score >= 0.75 ? "strong" : score >= 0.5 ? "moderate" : "limited";
  return {
    score,
    label,
    evidenceCount: evidence.length,
    sourceCount,
  } satisfies OmnigazeEvidenceCoverage;
}

function citationsFor(evidence: Evidence[]): OmnigazeViewCitation[] {
  return evidence.map((item) => ({
    id: item.id,
    title: item.title,
    publisher: item.publisher,
    publishedAt: item.publishedAt,
    url: item.url,
    classification: item.classification,
  }));
}

function liveItemsFor(
  items: IntelligenceFeedItem[],
  symbolId: CanonicalSymbol,
) {
  return items.filter(
    (item) =>
      item.isLive &&
      (item.symbolIds.length === 0 || item.symbolIds.includes(symbolId)),
  );
}

export async function generateOmnigazeView(
  symbolId: CanonicalSymbol,
  dependencies: Partial<OmnigazeViewDependencies> = {},
): Promise<GeneratedOmnigazeView> {
  const deps = { ...defaultDependencies, ...dependencies };
  if (!deps.isAiConfigured()) throw new OmnigazeViewError("ai_unconfigured");

  let resolved: ResolvedInstrument;
  try {
    resolved = await deps.resolveInstrument(symbolId);
  } catch (error) {
    if (error instanceof InstrumentResolutionError) {
      throw new OmnigazeViewError(error.code);
    }
    throw error;
  }

  const now = deps.now();
  const feed = await deps.getIntelligenceFeed({
    symbols: [resolved.id],
    since: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1_000).toISOString(),
    limit: 30,
  });

  if (feed.meta.dataMode !== "live") {
    throw new OmnigazeViewError("live_evidence_required");
  }
  if (
    feed.meta.freshness.state !== "fresh" ||
    !feed.meta.freshness.asOf ||
    feed.meta.freshness.ageSeconds === null
  ) {
    throw new OmnigazeViewError("fresh_evidence_required");
  }

  const liveItems = liveItemsFor(feed.data, resolved.id);
  const instrument = instrumentFromResolved(resolved);
  const context = buildAnalysisContextFromFeed({
    instrument,
    items: liveItems,
    meta: feed.meta,
  });
  if (context.evidence.length === 0) {
    throw new OmnigazeViewError("insufficient_evidence");
  }

  const analysis = await deps.analyze(context);
  const sources = [...new Set(context.evidence.map((item) => item.publisher))].sort();
  const generatedAt = deps.now().toISOString();

  return {
    data: analysis,
    meta: {
      symbolId: resolved.id,
      dataCutoff: context.dataCutoff,
      generatedAt,
      promptVersion: OMNIGAZE_ANALYSIS_PROMPT_VERSION,
      dataMode: "live",
      providerCoverage: context.sourceMeta.providerCoverage as
        | "complete"
        | "partial",
      freshness: {
        state: "fresh",
        asOf: feed.meta.freshness.asOf,
        ageSeconds: feed.meta.freshness.ageSeconds,
      },
      evidenceCount: context.evidence.length,
      eventCount: context.events.length,
      sources,
      evidenceCoverage: coverageFor(context.evidence),
      citations: citationsFor(context.evidence),
      confidenceMeaning: "evidence_interpretation_not_return_probability",
      disclaimer: "Research support only. This is not investment advice.",
    },
  };
}
