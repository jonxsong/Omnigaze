import { defaultWatchlist } from "@/lib/demo-market-data";
import type { CanonicalSymbol, Materiality } from "@/lib/market-types";
import {
  getCollectedIntelligenceFeed,
  type CollectedIntelligenceFeed,
} from "@/lib/services/collected-intelligence";
import {
  liveMarketData,
  type IntelligenceFeedItem,
  type OrchestratedIntelligenceFeed,
  type OrchestrationMeta,
} from "@/lib/services/live-market-data";

const MAX_FEED_ITEMS = 100;
const MIN_REQUEST_TIME_CANDIDATES = 50;
const FRESHNESS_WINDOW_SECONDS = 24 * 60 * 60;
const MAX_PROVIDER_CLOCK_SKEW_MS = 5 * 60 * 1_000;

const materialityRank: Record<Materiality, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export interface IntelligenceReadPlaneQuery {
  symbols?: CanonicalSymbol[];
  since: string;
  limit: number;
  minimumMateriality?: Materiality;
}

export interface IntelligenceReadPlaneMeta {
  strategy: "durable_plus_request_time";
  requestTimeFailed: boolean;
  collectedReadFailed: boolean;
  collectedTruncated: boolean;
  origins: {
    requestTime: {
      status: "live" | "demo" | "failed";
      candidateCount: number;
      selectedCount: number;
    };
    durable: {
      status: "ready" | "failed";
      candidateCount: number;
      selectedCount: number;
    };
  };
}

export interface IntelligenceReadPlaneFeed
  extends Omit<OrchestratedIntelligenceFeed, "meta"> {
  meta: OrchestrationMeta & { readPlane: IntelligenceReadPlaneMeta };
}

export interface IntelligenceReadPlaneDependencies {
  getRequestTimeFeed(
    options: IntelligenceReadPlaneQuery & { symbols: CanonicalSymbol[] },
  ): Promise<OrchestratedIntelligenceFeed>;
  getCollectedFeed(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
  }): Promise<CollectedIntelligenceFeed>;
  now(): Date;
}

export class IntelligenceReadPlaneError extends Error {
  constructor(readonly code: "intelligence_read_unavailable") {
    super("Current and collected intelligence are unavailable.");
    this.name = "IntelligenceReadPlaneError";
  }
}

type Candidate = {
  item: IntelligenceFeedItem;
  origin: "request_time" | "durable";
};

function normalizedQuery(options: IntelligenceReadPlaneQuery) {
  const sinceTimestamp = Date.parse(options.since);
  if (!Number.isFinite(sinceTimestamp)) {
    throw new Error("invalid_intelligence_read_since");
  }
  const requestedLimit = Math.trunc(options.limit);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), MAX_FEED_ITEMS)
    : 20;
  const symbols = [
    ...new Set(
      (options.symbols?.length ? options.symbols : defaultWatchlist).map(
        (symbol) => symbol.trim().toUpperCase() as CanonicalSymbol,
      ),
    ),
  ].sort();
  return {
    symbols,
    since: new Date(sinceTimestamp).toISOString(),
    limit,
    minimumMateriality: options.minimumMateriality ?? "low",
  };
}

function usableTimestamp(value: string | undefined, now: Date) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (
    !Number.isFinite(timestamp) ||
    timestamp > now.getTime() + MAX_PROVIDER_CLOCK_SKEW_MS
  ) {
    return null;
  }
  return timestamp;
}

function effectiveRevisionTime(item: IntelligenceFeedItem, now: Date) {
  const published = usableTimestamp(item.publishedAt, now);
  const revised = usableTimestamp(item.providerUpdatedAt, now);
  if (revised !== null && (published === null || revised > published)) {
    return revised;
  }
  return published;
}

function compareCandidates(left: Candidate, right: Candidate, now: Date) {
  const leftRevision =
    effectiveRevisionTime(left.item, now) ?? Number.NEGATIVE_INFINITY;
  const rightRevision =
    effectiveRevisionTime(right.item, now) ?? Number.NEGATIVE_INFINITY;
  return (
    rightRevision - leftRevision ||
    right.item.publishedAt.localeCompare(left.item.publishedAt) ||
    left.item.id.localeCompare(right.item.id) ||
    (left.origin === right.origin ? 0 : left.origin === "durable" ? -1 : 1)
  );
}

function mergeCandidates(
  requestTime: IntelligenceFeedItem[],
  durable: IntelligenceFeedItem[],
  now: Date,
) {
  const byId = new Map<string, Candidate>();
  const merge = (item: IntelligenceFeedItem, origin: Candidate["origin"]) => {
    if (!item.isLive || item.sourceKind === "demo_fixture") return;
    const candidate = { item, origin };
    const current = byId.get(item.id);
    if (!current) {
      byId.set(item.id, candidate);
      return;
    }
    const currentRevision =
      effectiveRevisionTime(current.item, now) ?? Number.NEGATIVE_INFINITY;
    const candidateRevision =
      effectiveRevisionTime(candidate.item, now) ?? Number.NEGATIVE_INFINITY;
    if (
      candidateRevision > currentRevision ||
      (candidateRevision === currentRevision && origin === "durable")
    ) {
      byId.set(item.id, candidate);
    }
  };
  requestTime.forEach((item) => merge(item, "request_time"));
  durable.forEach((item) => merge(item, "durable"));
  return [...byId.values()];
}

function freshnessFor(items: IntelligenceFeedItem[], now: Date) {
  const latest = items.reduce<number | null>((current, item) => {
    const candidate = effectiveRevisionTime(item, now);
    if (candidate === null) return current;
    return current === null || candidate > current ? candidate : current;
  }, null);
  if (latest === null) {
    return { state: "unknown" as const, asOf: null, ageSeconds: null };
  }
  const ageSeconds = Math.max(
    0,
    Math.round((now.getTime() - latest) / 1_000),
  );
  return {
    state:
      ageSeconds <= FRESHNESS_WINDOW_SECONDS
        ? ("fresh" as const)
        : ("stale" as const),
    asOf: new Date(latest).toISOString(),
    ageSeconds,
  };
}

function readPlaneMeta(options: {
  requestTime: OrchestratedIntelligenceFeed | null;
  requestTimeRejected: boolean;
  collected: CollectedIntelligenceFeed | null;
  collectedRejected: boolean;
  selected: Candidate[];
  requestTimeCandidateCount: number;
  durableCandidateCount: number;
}): IntelligenceReadPlaneMeta {
  return {
    strategy: "durable_plus_request_time",
    requestTimeFailed:
      options.requestTimeRejected ||
      options.requestTime?.meta.fallbackReason === "provider_request_failed",
    collectedReadFailed: options.collectedRejected,
    collectedTruncated: options.collected?.hasMore ?? false,
    origins: {
      requestTime: {
        status: options.requestTimeRejected
          ? "failed"
          : options.requestTime?.meta.dataMode ?? "failed",
        candidateCount: options.requestTimeCandidateCount,
        selectedCount: options.selected.filter(
          (candidate) => candidate.origin === "request_time",
        ).length,
      },
      durable: {
        status: options.collectedRejected ? "failed" : "ready",
        candidateCount: options.durableCandidateCount,
        selectedCount: options.selected.filter(
          (candidate) => candidate.origin === "durable",
        ).length,
      },
    },
  };
}

export function createIntelligenceReadPlane(
  dependencies: IntelligenceReadPlaneDependencies,
) {
  return {
    async getIntelligenceFeed(
      options: IntelligenceReadPlaneQuery,
    ): Promise<IntelligenceReadPlaneFeed> {
      const query = normalizedQuery(options);
      const now = dependencies.now();
      if (!Number.isFinite(now.getTime())) {
        throw new Error("invalid_intelligence_read_clock");
      }

      const [requestTimeResult, collectedResult] = await Promise.allSettled([
        dependencies.getRequestTimeFeed({
          ...query,
          // Keep one provider page of merge headroom for interactive reads,
          // while avoiding a second upstream page for small dashboard polls.
          // Fetch every materiality so a newer downgrade can supersede an
          // older durable version before the caller's gate is reapplied.
          limit: Math.min(
            MAX_FEED_ITEMS,
            Math.max(query.limit, MIN_REQUEST_TIME_CANDIDATES),
          ),
          minimumMateriality: "low",
        }),
        dependencies.getCollectedFeed({
          symbols: query.symbols,
          since: query.since,
          limit: MAX_FEED_ITEMS,
        }),
      ]);
      const requestTime =
        requestTimeResult.status === "fulfilled"
          ? requestTimeResult.value
          : null;
      const collected =
        collectedResult.status === "fulfilled" ? collectedResult.value : null;
      const requestTimeItems =
        requestTime?.meta.dataMode === "live" ? requestTime.data : [];
      const durableItems = collected?.data ?? [];
      const merged = mergeCandidates(requestTimeItems, durableItems, now);
      const eligible = merged
        .filter(
          ({ item }) =>
            materialityRank[item.materiality] >=
            materialityRank[query.minimumMateriality],
        )
        .sort((left, right) => compareCandidates(left, right, now));
      const selected = eligible.slice(0, query.limit);
      const readPlane = readPlaneMeta({
        requestTime,
        requestTimeRejected: requestTimeResult.status === "rejected",
        collected,
        collectedRejected: collectedResult.status === "rejected",
        selected,
        requestTimeCandidateCount: requestTimeItems.length,
        durableCandidateCount: durableItems.length,
      });

      const hasLiveRead =
        requestTime?.meta.dataMode === "live" || durableItems.length > 0;
      if (hasLiveRead) {
        const data = selected.map(({ item }) => item);
        const providerCoverage =
          requestTime?.meta.dataMode === "live" &&
          requestTime.meta.providerCoverage === "complete" &&
          !readPlane.requestTimeFailed &&
          !readPlane.collectedReadFailed &&
          !readPlane.collectedTruncated
            ? "complete"
            : "partial";
        const freshness =
          data.length > 0
            ? freshnessFor(data, now)
            : requestTime?.meta.dataMode === "live"
              ? requestTime.meta.freshness
              : freshnessFor([], now);
        return {
          data,
          meta: {
            dataMode: "live",
            mode: "live",
            providerCoverage,
            coverage: providerCoverage,
            generatedAt: now.toISOString(),
            freshness,
            providers: requestTime?.meta.providers ?? [],
            ...(readPlane.requestTimeFailed
              ? { fallbackReason: "provider_request_failed" as const }
              : requestTime?.meta.fallbackReason
                ? { fallbackReason: requestTime.meta.fallbackReason }
                : {}),
            notice: readPlane.requestTimeFailed
              ? "Durable provider receipts are shown because the request-time refresh failed."
              : requestTime?.meta.dataMode === "live" && durableItems.length > 0
                ? "Durable provider receipts and request-time live data were merged."
                : durableItems.length > 0
                  ? "Durable provider receipts are shown; request-time live data is unavailable."
                  : requestTime?.meta.notice ??
                    "Live request-time provider data is shown.",
            readPlane,
          },
        };
      }

      if (requestTime) {
        const filtered = requestTime.data
          .filter(
            (item) =>
              materialityRank[item.materiality] >=
              materialityRank[query.minimumMateriality],
          )
          .slice(0, query.limit);
        return {
          data: filtered,
          meta: { ...requestTime.meta, readPlane },
        };
      }

      throw new IntelligenceReadPlaneError("intelligence_read_unavailable");
    },
  };
}

export const intelligenceReadPlane = createIntelligenceReadPlane({
  getRequestTimeFeed: (options) =>
    liveMarketData.getIntelligenceFeed(options),
  getCollectedFeed: (options) => getCollectedIntelligenceFeed(options),
  now: () => new Date(),
});

