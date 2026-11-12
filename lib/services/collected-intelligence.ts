import type { CollectedSourceEvent } from "@/lib/ingestion/contracts";
import { decodeHtmlEntities } from "@/lib/decode-html-entities";
import type { CanonicalSymbol } from "@/lib/market-types";
import { classifyPublicEvent } from "@/lib/pipeline/classify-public-event";
import type { IntelligenceFeedItem } from "@/lib/services/live-market-data";
import { readIngestionRuntimeConfig } from "@/lib/services/intelligence-ingestion";

const MAX_COLLECTED_EVENTS = 100;

export interface CollectedIntelligenceFeed {
  data: IntelligenceFeedItem[];
  hasMore: boolean;
}

function safeHttpUrl(value: string | null) {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

export function projectCollectedSourceEvent(
  event: CollectedSourceEvent,
  requestedSymbols: ReadonlySet<CanonicalSymbol>,
): IntelligenceFeedItem | null {
  if (
    event.payloadPolicy !== "minimal_redacted_v1" ||
    event.envelope.schema !== "omnigaze.provider-receipt.v1" ||
    event.sourceKind !== "licensed_news" ||
    event.sourceEventId.trim().length === 0 ||
    event.envelope.headline.trim().length === 0 ||
    !Number.isFinite(Date.parse(event.publishedAt)) ||
    !Number.isFinite(Date.parse(event.observedAt)) ||
    !Number.isFinite(Date.parse(event.effectiveAt)) ||
    (event.providerRevisionAt !== null &&
      !Number.isFinite(Date.parse(event.providerRevisionAt))) ||
    !event.envelope.contentDigest ||
    !/^[a-f0-9]{64}$/u.test(event.envelope.contentDigest)
  ) {
    return null;
  }
  const symbolIds = [
    ...new Set(
      event.symbolIds.filter((symbolId) => requestedSymbols.has(symbolId)),
    ),
  ].sort();
  if (symbolIds.length === 0) return null;

  const headline = decodeHtmlEntities(event.envelope.headline).trim();
  if (headline.length === 0) return null;
  const rawSummary = event.envelope.summary?.trim() || null;
  const decodedSummary = rawSummary
    ? decodeHtmlEntities(rawSummary).trim()
    : "";
  const summary = decodedSummary || null;
  const classification = classifyPublicEvent({
    headline,
    summary,
    sourceKind: "licensed_news",
  });
  return {
    id: `${event.provider}:${event.sourceEventId}`,
    symbolIds,
    source: event.provider,
    sourceKind: "licensed_news",
    headline,
    summary,
    publishedAt: event.publishedAt,
    receivedAt: event.observedAt,
    providerUpdatedAt: event.providerRevisionAt ?? event.observedAt,
    sourceUrl: safeHttpUrl(event.envelope.url),
    materiality: classification.materiality,
    isLive: true,
    category: classification.category,
    claimStatus: classification.claimStatus,
    causalLink: classification.causalLink,
    topicTags: classification.topicTags,
    isControversial: classification.isControversial,
  };
}

export async function getCollectedIntelligenceFeed(
  options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit?: number;
  },
  environment: Record<string, string | undefined> = process.env,
): Promise<CollectedIntelligenceFeed> {
  const config = await readIngestionRuntimeConfig(environment);
  const configured = new Set(config.symbols);
  const symbols = [
    ...new Set(options.symbols.filter((symbol) => configured.has(symbol))),
  ].sort();
  if (symbols.length === 0) return { data: [], hasMore: false };
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? MAX_COLLECTED_EVENTS), 1),
    MAX_COLLECTED_EVENTS,
  );
  const { ingestionRepository } = await import("@/lib/ingestion/repository");
  const page = await ingestionRepository.listCollectedEvents({
    provider: config.provider,
    partitionKey: config.partitionKey,
    since: options.since,
    symbolIds: symbols,
    limit,
  });
  const requested = new Set(symbols);
  return {
    data: page.items
      .map((event) => projectCollectedSourceEvent(event, requested))
      .filter((event): event is IntelligenceFeedItem => event !== null),
    hasMore: page.hasMore,
  };
}
