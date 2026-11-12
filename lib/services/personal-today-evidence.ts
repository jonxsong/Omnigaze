import type {
  CanonicalSymbol,
  CausalLink,
  ClaimStatus,
  IntelligenceEvent,
  Materiality,
} from "@/lib/market-types";
import type {
  IntelligenceFeedItem,
  OrchestratedIntelligenceFeed,
} from "@/lib/services/live-market-data";

export const DAILY_BRIEF_WINDOW_HOURS = 24;
export const DAILY_BRIEF_MAX_EVIDENCE = 12;
const MAX_TRACKED_SYMBOLS = 100;
const WINDOW_MS = DAILY_BRIEF_WINDOW_HOURS * 60 * 60 * 1_000;
const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;

const materialityRank: Record<Materiality, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export type DailyBriefEvidenceErrorCode =
  | "empty_watchlist"
  | "invalid_request"
  | "live_evidence_required"
  | "fresh_evidence_required"
  | "insufficient_evidence";

export class DailyBriefEvidenceError extends Error {
  constructor(readonly code: DailyBriefEvidenceErrorCode) {
    super(code);
    this.name = "DailyBriefEvidenceError";
  }
}

export interface DailyBriefEvidenceItem {
  id: string;
  eventId: string;
  symbolIds: CanonicalSymbol[];
  source: string;
  sourceKind: IntelligenceFeedItem["sourceKind"];
  headline: string;
  summary: string | null;
  publishedAt: string;
  providerUpdatedAt: string | null;
  sourceUrl: string | null;
  materiality: Materiality;
  category?: IntelligenceEvent["category"];
  claimStatus?: ClaimStatus;
  causalLink?: CausalLink;
  topicTags: string[];
  isControversial: boolean;
}

export interface DailyBriefEvidenceSelection {
  items: DailyBriefEvidenceItem[];
  trackedSymbols: CanonicalSymbol[];
  includedSymbols: CanonicalSymbol[];
  omittedSymbols: CanonicalSymbol[];
  omittedEventCount: number;
  window: {
    since: string;
    through: string;
  };
  meta: {
    dataMode: "live";
    providerCoverage: "complete" | "partial";
    freshness: {
      state: "fresh";
      asOf: string;
      ageSeconds: number;
    };
    generatedAt: string;
  };
}

type RankedEvidence = DailyBriefEvidenceItem & {
  publishedTime: number;
  revisionTime: number;
  stableContent: string;
};

function safeText(value: unknown, maxLength: number) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized || /[\u0000-\u001F\u007F]/.test(normalized)) return "";
  return normalized.slice(0, maxLength);
}

function safeOptionalText(value: unknown, maxLength: number) {
  const text = safeText(value, maxLength);
  return text || null;
}

function safeSourceUrl(value: unknown) {
  const text = safeOptionalText(value, 2_048);
  if (!text) return null;
  try {
    const url = new URL(text);
    if (
      (url.protocol !== "https:" && url.protocol !== "http:") ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function normalizedTrackedSymbols(symbols: readonly CanonicalSymbol[]) {
  const normalized = [
    ...new Set(symbols.map((symbol) => symbol.trim().toUpperCase())),
  ].sort();
  if (normalized.length === 0) {
    throw new DailyBriefEvidenceError("empty_watchlist");
  }
  if (
    normalized.length > MAX_TRACKED_SYMBOLS ||
    normalized.some((symbol) => !canonicalSymbolPattern.test(symbol))
  ) {
    throw new DailyBriefEvidenceError("invalid_request");
  }
  return normalized as CanonicalSymbol[];
}

function compareEvidence(left: RankedEvidence, right: RankedEvidence) {
  return (
    materialityRank[right.materiality] - materialityRank[left.materiality] ||
    right.revisionTime - left.revisionTime ||
    right.publishedTime - left.publishedTime ||
    left.eventId.localeCompare(right.eventId) ||
    left.stableContent.localeCompare(right.stableContent)
  );
}

function compareRevision(left: RankedEvidence, right: RankedEvidence) {
  return (
    right.revisionTime - left.revisionTime ||
    right.publishedTime - left.publishedTime ||
    left.stableContent.localeCompare(right.stableContent)
  );
}

function normalizeItem(
  item: IntelligenceFeedItem,
  tracked: ReadonlySet<CanonicalSymbol>,
  sinceTime: number,
  throughTime: number,
): RankedEvidence | null {
  if (
    !item.isLive ||
    item.sourceKind === "demo_fixture" ||
    !Object.hasOwn(materialityRank, item.materiality)
  ) {
    return null;
  }

  const eventId = safeText(item.id, 256);
  const source = safeText(item.source, 200);
  const headline = safeText(item.headline, 500);
  const publishedTime = Date.parse(item.publishedAt);
  const revisionTime = item.providerUpdatedAt
    ? Date.parse(item.providerUpdatedAt)
    : publishedTime;
  if (
    !eventId ||
    !source ||
    !headline ||
    !Number.isFinite(publishedTime) ||
    !Number.isFinite(revisionTime) ||
    publishedTime < sinceTime ||
    publishedTime > throughTime ||
    revisionTime > throughTime
  ) {
    return null;
  }

  const symbolIds = [
    ...new Set(
      item.symbolIds
        .map((symbol) => symbol.trim().toUpperCase() as CanonicalSymbol)
        .filter((symbol) => tracked.has(symbol)),
    ),
  ].sort();
  if (symbolIds.length === 0) return null;

  const topicTags = [
    ...new Set(
      (item.topicTags ?? [])
        .map((tag) => safeText(tag, 80))
        .filter(Boolean),
    ),
  ]
    .sort()
    .slice(0, 20);
  const summary = safeOptionalText(item.summary, 2_000);
  const sourceUrl = safeSourceUrl(item.sourceUrl);
  const providerUpdatedAt = item.providerUpdatedAt
    ? new Date(revisionTime).toISOString()
    : null;

  const normalized: DailyBriefEvidenceItem = {
    id: `evidence:${eventId}`,
    eventId,
    symbolIds,
    source,
    sourceKind: item.sourceKind,
    headline,
    summary,
    publishedAt: new Date(publishedTime).toISOString(),
    providerUpdatedAt,
    sourceUrl,
    materiality: item.materiality,
    ...(item.category ? { category: item.category } : {}),
    ...(item.claimStatus ? { claimStatus: item.claimStatus } : {}),
    ...(item.causalLink ? { causalLink: item.causalLink } : {}),
    topicTags,
    isControversial: item.isControversial === true,
  };
  return {
    ...normalized,
    publishedTime,
    revisionTime,
    stableContent: JSON.stringify(normalized),
  };
}

function deduplicateAndRank(items: RankedEvidence[]) {
  const byEventId = new Map<string, RankedEvidence>();
  for (const item of items) {
    const current = byEventId.get(item.eventId);
    if (!current || compareRevision(item, current) < 0) {
      byEventId.set(item.eventId, item);
    }
  }
  return [...byEventId.values()].sort(compareEvidence);
}

function publicEvidence(item: RankedEvidence): DailyBriefEvidenceItem {
  return {
    id: item.id,
    eventId: item.eventId,
    symbolIds: item.symbolIds,
    source: item.source,
    sourceKind: item.sourceKind,
    headline: item.headline,
    summary: item.summary,
    publishedAt: item.publishedAt,
    providerUpdatedAt: item.providerUpdatedAt,
    sourceUrl: item.sourceUrl,
    materiality: item.materiality,
    ...(item.category ? { category: item.category } : {}),
    ...(item.claimStatus ? { claimStatus: item.claimStatus } : {}),
    ...(item.causalLink ? { causalLink: item.causalLink } : {}),
    topicTags: item.topicTags,
    isControversial: item.isControversial,
  };
}

export function selectDailyBriefEvidence({
  trackedSymbols,
  feed,
  now = new Date(),
  maxEvents = DAILY_BRIEF_MAX_EVIDENCE,
}: {
  trackedSymbols: readonly CanonicalSymbol[];
  feed: OrchestratedIntelligenceFeed;
  now?: Date;
  maxEvents?: number;
}): DailyBriefEvidenceSelection {
  const canonicalSymbols = normalizedTrackedSymbols(trackedSymbols);
  if (!Number.isInteger(maxEvents) || maxEvents < 1 || maxEvents > 12) {
    throw new DailyBriefEvidenceError("invalid_request");
  }
  const throughTime = now.getTime();
  if (!Number.isFinite(throughTime)) {
    throw new DailyBriefEvidenceError("invalid_request");
  }

  if (feed.meta.dataMode !== "live") {
    throw new DailyBriefEvidenceError("live_evidence_required");
  }
  const freshness = feed.meta.freshness;
  const freshnessTime = freshness.asOf ? Date.parse(freshness.asOf) : Number.NaN;
  const generatedTime = Date.parse(feed.meta.generatedAt);
  const actualFreshnessAgeSeconds = Number.isFinite(freshnessTime)
    ? Math.max(0, Math.round((throughTime - freshnessTime) / 1_000))
    : Number.NaN;
  if (
    freshness.state !== "fresh" ||
    freshness.ageSeconds === null ||
    !Number.isFinite(freshness.ageSeconds) ||
    freshness.ageSeconds < 0 ||
    !Number.isFinite(freshnessTime) ||
    !Number.isFinite(actualFreshnessAgeSeconds) ||
    !Number.isFinite(generatedTime) ||
    freshnessTime > throughTime ||
    actualFreshnessAgeSeconds > DAILY_BRIEF_WINDOW_HOURS * 60 * 60 ||
    generatedTime > throughTime ||
    (feed.meta.providerCoverage !== "complete" &&
      feed.meta.providerCoverage !== "partial")
  ) {
    throw new DailyBriefEvidenceError("fresh_evidence_required");
  }

  const sinceTime = throughTime - WINDOW_MS;
  const tracked = new Set(canonicalSymbols);
  const ranked = deduplicateAndRank(
    feed.data.flatMap((item) => {
      const normalized = normalizeItem(item, tracked, sinceTime, throughTime);
      return normalized ? [normalized] : [];
    }),
  );
  if (ranked.length === 0) {
    throw new DailyBriefEvidenceError("insufficient_evidence");
  }

  const selected: RankedEvidence[] = [];
  const selectedIds = new Set<string>();
  const coveredSymbols = new Set<CanonicalSymbol>();

  // Prefer the strongest event that adds a not-yet-represented symbol before
  // filling remaining slots. This keeps relevance ordering deterministic while
  // preventing one busy company from crowding out the rest of a watchlist.
  for (const item of ranked) {
    if (selected.length >= maxEvents) break;
    if (!item.symbolIds.some((symbol) => !coveredSymbols.has(symbol))) continue;
    selected.push(item);
    selectedIds.add(item.eventId);
    for (const symbol of item.symbolIds) coveredSymbols.add(symbol);
  }
  for (const item of ranked) {
    if (selected.length >= maxEvents) break;
    if (selectedIds.has(item.eventId)) continue;
    selected.push(item);
    selectedIds.add(item.eventId);
  }
  selected.sort(compareEvidence);

  const included = new Set<CanonicalSymbol>(
    selected.flatMap((item) => item.symbolIds),
  );
  const includedSymbols = canonicalSymbols.filter((symbol) => included.has(symbol));
  const omittedSymbols = canonicalSymbols.filter((symbol) => !included.has(symbol));

  return {
    items: selected.map(publicEvidence),
    trackedSymbols: canonicalSymbols,
    includedSymbols,
    omittedSymbols,
    omittedEventCount: ranked.length - selected.length,
    window: {
      since: new Date(sinceTime).toISOString(),
      through: now.toISOString(),
    },
    meta: {
      dataMode: "live",
      providerCoverage: feed.meta.providerCoverage,
      freshness: {
        state: "fresh",
        asOf: new Date(freshnessTime).toISOString(),
        ageSeconds: actualFreshnessAgeSeconds,
      },
      generatedAt: new Date(generatedTime).toISOString(),
    },
  };
}

export function dailyBriefEvidenceCoverage(
  selection: Pick<
    DailyBriefEvidenceSelection,
    "items" | "trackedSymbols" | "includedSymbols"
  >,
) {
  const evidenceRatio = Math.min(selection.items.length, 8) / 8;
  const sourceRatio =
    Math.min(new Set(selection.items.map((item) => item.source)).size, 4) / 4;
  const symbolRatio =
    selection.trackedSymbols.length === 0
      ? 0
      : selection.includedSymbols.length / selection.trackedSymbols.length;
  const score =
    (Math.round(evidenceRatio * 40) +
      Math.round(sourceRatio * 25) +
      Math.round(symbolRatio * 35)) /
    100;
  return {
    score,
    label: score >= 0.75 ? "strong" : score >= 0.5 ? "moderate" : "limited",
  } as const;
}
