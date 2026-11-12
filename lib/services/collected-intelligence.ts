import type {
  CollectedEventPage,
  CollectedSourceEvent,
  ListCollectedEventsInput,
} from "@/lib/ingestion/contracts";
import { decodeHtmlEntities } from "@/lib/decode-html-entities";
import type { CanonicalSymbol } from "@/lib/market-types";
import { classifyPublicEvent } from "@/lib/pipeline/classify-public-event";
import type { IntelligenceFeedItem } from "@/lib/services/live-market-data";
import { readIngestionRuntimeConfig } from "@/lib/services/intelligence-ingestion";

const MAX_COLLECTED_EVENTS = 100;
const MAX_COLLECTED_SCOPES = 32;

export interface CollectedIntelligenceScope {
  provider: string;
  /** Omit to retain visibility across historical partition configurations. */
  partitionKey?: string;
  /** Optional scope-specific allowlist, intersected with the caller's symbols. */
  symbolIds?: CanonicalSymbol[];
}

export interface CollectedIntelligenceRepositoryPort {
  listCollectedEvents(
    input: ListCollectedEventsInput,
  ): Promise<CollectedEventPage>;
}

export interface CollectedIntelligenceFeed {
  data: IntelligenceFeedItem[];
  hasMore: boolean;
}

function effectiveEventTime(event: CollectedSourceEvent) {
  return Date.parse(event.providerRevisionAt ?? event.observedAt);
}

function filingMateriality(headline: string): "high" | "medium" {
  const suffix = " filed with the SEC";
  if (!headline.toLowerCase().endsWith(suffix.toLowerCase())) return "medium";
  const form = headline.slice(0, -suffix.length).trim().toUpperCase();
  const baseForm = form.replace(/\/A$/u, "");
  return ["10-K", "10-Q", "8-K"].includes(baseForm) ? "high" : "medium";
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
    (event.sourceKind !== "licensed_news" &&
      event.sourceKind !== "sec_filing") ||
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
    sourceKind: event.sourceKind,
  });
  const filing = event.sourceKind === "sec_filing";
  const amendment = filing && /\/A\s+filed with the SEC$/iu.test(headline);
  return {
    id: `${event.provider}:${event.sourceEventId}`,
    symbolIds,
    source: event.provider,
    sourceKind: event.sourceKind,
    headline,
    summary,
    publishedAt: event.publishedAt,
    receivedAt: event.observedAt,
    providerUpdatedAt: event.providerRevisionAt ?? event.observedAt,
    sourceUrl: safeHttpUrl(event.envelope.url),
    materiality: filing
      ? filingMateriality(headline)
      : classification.materiality,
    isLive: true,
    category: filing ? "filing" : classification.category,
    claimStatus: filing ? "confirmed" : classification.claimStatus,
    causalLink: filing ? "unassessed" : classification.causalLink,
    topicTags: filing
      ? ["filing", ...(amendment ? ["amendment"] : [])]
      : classification.topicTags,
    isControversial: filing ? false : classification.isControversial,
  };
}

function newestCollectedVersion(
  current: CollectedSourceEvent | undefined,
  candidate: CollectedSourceEvent,
) {
  if (!current) return candidate;
  const currentEffectiveAt = effectiveEventTime(current);
  const candidateEffectiveAt = effectiveEventTime(candidate);
  if (candidateEffectiveAt !== currentEffectiveAt) {
    return candidateEffectiveAt > currentEffectiveAt ? candidate : current;
  }
  const currentObservedAt = Date.parse(current.observedAt);
  const candidateObservedAt = Date.parse(candidate.observedAt);
  if (candidateObservedAt !== currentObservedAt) {
    return candidateObservedAt > currentObservedAt ? candidate : current;
  }
  const currentLastSeenAt = Date.parse(current.lastSeenAt);
  const candidateLastSeenAt = Date.parse(candidate.lastSeenAt);
  if (candidateLastSeenAt !== currentLastSeenAt) {
    return candidateLastSeenAt > currentLastSeenAt ? candidate : current;
  }
  return candidate.receiptId > current.receiptId ? candidate : current;
}

/**
 * Read a bounded set of durable provider partitions and merge their latest
 * immutable versions once, after projection. This is deliberately independent
 * of provider construction, so a ledger read can never trigger provider egress.
 */
export async function getCollectedIntelligenceFeedForScopes(
  options: {
    symbols: CanonicalSymbol[];
    since: string;
    scopes: CollectedIntelligenceScope[];
    limit?: number;
  },
  repository?: CollectedIntelligenceRepositoryPort,
): Promise<CollectedIntelligenceFeed> {
  const sinceTimestamp = Date.parse(options.since);
  if (!Number.isFinite(sinceTimestamp)) {
    throw new Error("invalid_collected_intelligence_since");
  }
  const requestedSymbols = [...new Set(options.symbols)].sort();
  if (requestedSymbols.length === 0 || options.scopes.length === 0) {
    return { data: [], hasMore: false };
  }
  if (options.scopes.length > MAX_COLLECTED_SCOPES) {
    throw new Error("too_many_collected_intelligence_scopes");
  }
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? MAX_COLLECTED_EVENTS), 1),
    MAX_COLLECTED_EVENTS,
  );
  const requested = new Set(requestedSymbols);
  const scopes = new Map<string, CollectedIntelligenceScope>();
  for (const scope of options.scopes) {
    const key = `${scope.provider}\u0000${scope.partitionKey ?? "*"}`;
    const previous = scopes.get(key);
    scopes.set(key, {
      provider: scope.provider,
      partitionKey: scope.partitionKey,
      symbolIds:
        previous?.symbolIds || scope.symbolIds
          ? [
              ...new Set([
                ...(previous?.symbolIds ?? []),
                ...(scope.symbolIds ?? []),
              ]),
            ].sort()
          : undefined,
    });
  }
  const port =
    repository ??
    (await import("@/lib/ingestion/repository")).ingestionRepository;
  const pages = await Promise.all(
    [...scopes.values()].map(async (scope) => {
      const allowed = scope.symbolIds ? new Set(scope.symbolIds) : requested;
      const symbolIds = requestedSymbols.filter((symbol) => allowed.has(symbol));
      if (symbolIds.length === 0) return null;
      return port.listCollectedEvents({
        provider: scope.provider,
        ...(scope.partitionKey
          ? { partitionKey: scope.partitionKey }
          : {}),
        since: new Date(sinceTimestamp).toISOString(),
        symbolIds,
        limit,
      });
    }),
  );

  const byIdentity = new Map<string, CollectedSourceEvent>();
  let hasMore = false;
  for (const page of pages) {
    if (!page) continue;
    hasMore ||= page.hasMore;
    for (const event of page.items) {
      const identity = `${event.provider}:${event.sourceEventId}`;
      byIdentity.set(
        identity,
        newestCollectedVersion(byIdentity.get(identity), event),
      );
    }
  }
  const projected = [...byIdentity.values()]
    .map((event) => projectCollectedSourceEvent(event, requested))
    .filter((event): event is IntelligenceFeedItem => event !== null)
    .sort((left, right) => {
      const leftAt = Date.parse(left.providerUpdatedAt ?? left.receivedAt);
      const rightAt = Date.parse(right.providerUpdatedAt ?? right.receivedAt);
      return (
        rightAt - leftAt ||
        right.publishedAt.localeCompare(left.publishedAt) ||
        left.id.localeCompare(right.id)
      );
    });
  return {
    data: projected.slice(0, limit),
    hasMore: hasMore || projected.length > limit,
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
  const symbols = [...new Set(options.symbols)].sort();
  if (symbols.length === 0) return { data: [], hasMore: false };
  const limit = Math.min(
    Math.max(Math.trunc(options.limit ?? MAX_COLLECTED_EVENTS), 1),
    MAX_COLLECTED_EVENTS,
  );
  return getCollectedIntelligenceFeedForScopes({
    symbols,
    since: options.since,
    limit,
    scopes: [
      {
        provider: config.provider,
        partitionKey: config.partitionKey,
        symbolIds: config.symbols,
      },
      // Provider-wide reads preserve retained filing visibility after a symbol
      // mapping or partition version changes. This is a D1-only read and never
      // constructs the SEC adapter or performs upstream egress.
      { provider: "sec-edgar" },
    ],
  });
}
