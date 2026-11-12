import type {
  Evidence,
  IntelligenceEvent,
  Instrument,
} from "@/lib/market-types";
import type {
  IntelligenceFeedItem,
  OrchestrationMeta,
} from "@/lib/services/live-market-data";

export interface AnalysisContext {
  instrument: Instrument;
  evidence: Evidence[];
  events: IntelligenceEvent[];
  dataCutoff: string;
  sourceMode: OrchestrationMeta["dataMode"];
  sourceMeta: OrchestrationMeta;
}

function eventCategory(
  sourceKind: IntelligenceFeedItem["sourceKind"],
): IntelligenceEvent["category"] {
  if (sourceKind === "sec_filing") return "filing";
  if (sourceKind === "macro_series") return "macro";
  return "market";
}

export function buildAnalysisContextFromFeed({
  instrument,
  items,
  meta,
}: {
  instrument: Instrument;
  items: IntelligenceFeedItem[];
  meta: OrchestrationMeta;
}): AnalysisContext {
  const relevant = items
    .filter(
      (item) =>
        item.symbolIds.length === 0 || item.symbolIds.includes(instrument.id),
    )
    .filter((item) => item.publishedAt <= meta.generatedAt);

  const evidence: Evidence[] = relevant.map((item) => ({
    id: `evidence:${item.id}`,
    classification: "fact",
    title: item.headline,
    publisher: item.source,
    publishedAt: item.publishedAt,
    url: item.sourceUrl,
    ...(item.summary ? { excerpt: item.summary.slice(0, 1_200) } : {}),
  }));

  const events: IntelligenceEvent[] = relevant.map((item) => ({
    id: `event:${item.id}`,
    symbolId: instrument.id,
    headline: item.headline,
    summary:
      item.summary ??
      "A source event was captured. Open the linked evidence for full context.",
    occurredAt: item.publishedAt,
    materiality: item.materiality,
    possibleDirection: "unclear",
    status: item.isLive ? "preliminary" : "verified",
    evidenceIds: [`evidence:${item.id}`],
    category: item.category ?? eventCategory(item.sourceKind),
    claimStatus: item.claimStatus,
    causalLink: item.causalLink,
    topicTags: item.topicTags,
    sourceCount: 1,
  }));

  return {
    instrument,
    evidence,
    events,
    dataCutoff: meta.generatedAt,
    sourceMode: meta.dataMode,
    sourceMeta: meta,
  };
}
