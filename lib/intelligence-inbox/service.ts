import type {
  AlertRuleMutation,
  AlertRuleMutationResponse,
  AlertRulesResponse,
  InboxFilter,
  InboxStateMutation,
  InboxStateMutationResponse,
  InboxSymbolSnapshot,
  IntelligenceInboxItemResponse,
  IntelligenceInboxResponse,
  IntelligenceInboxSyncMeta,
} from "@/lib/intelligence-inbox/contracts";
import {
  intelligenceInboxRepository,
  toAlertRuleMutationResponse,
  toInboxStateMutationResponse,
  type IntelligenceInboxRepository,
} from "@/lib/intelligence-inbox/repository";
import type { CanonicalSymbol } from "@/lib/market-types";
import { listUserWatchlists } from "@/lib/repositories/watchlists";
import {
  liveMarketData,
  type OrchestratedIntelligenceFeed,
} from "@/lib/services/live-market-data";

type WatchlistResult = Awaited<ReturnType<typeof listUserWatchlists>>;

export interface InboxServiceDependencies {
  repository: IntelligenceInboxRepository;
  listWatchlists(ownerId: string): Promise<WatchlistResult>;
  getFeed(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
    minimumMateriality: "low";
  }): Promise<OrchestratedIntelligenceFeed>;
  now(): Date;
}

const defaultDependencies: InboxServiceDependencies = {
  repository: intelligenceInboxRepository,
  listWatchlists: listUserWatchlists,
  getFeed: (options) => liveMarketData.getIntelligenceFeed(options),
  now: () => new Date(),
};

function trackedSymbolSnapshots(watchlists: WatchlistResult) {
  const byId = new Map<CanonicalSymbol, InboxSymbolSnapshot>();
  for (const watchlist of watchlists) {
    for (const item of watchlist.items) {
      const id = item.symbolId as CanonicalSymbol;
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          ticker: item.ticker,
          exchange: item.exchange,
          name: item.name,
        });
      }
    }
  }
  return [...byId.values()];
}

function baseMeta(generatedAt: string) {
  return {
    scope: "personal" as const,
    identity: "authenticated" as const,
    persistence: "server" as const,
    channel: "in_app" as const,
    generatedAt,
  };
}

const INBOX_ITEM_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const INBOX_PROVIDER_CLOCK_SKEW_MS = 5 * 60 * 1_000;

function effectiveProviderTime(item: OrchestratedIntelligenceFeed["data"][number]) {
  const timestamps = [item.publishedAt, item.providerUpdatedAt]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter(Number.isFinite);
  return timestamps.length > 0 ? Math.max(...timestamps) : null;
}

function isIndividuallyFresh(
  item: OrchestratedIntelligenceFeed["data"][number],
  now: Date,
) {
  const effectiveAt = effectiveProviderTime(item);
  return (
    effectiveAt !== null &&
    effectiveAt >= now.getTime() - INBOX_ITEM_MAX_AGE_MS &&
    effectiveAt <= now.getTime() + INBOX_PROVIDER_CLOCK_SKEW_MS
  );
}

export async function getIntelligenceInbox(
  ownerId: string,
  query: { filter: InboxFilter; limit: number },
  dependencies: InboxServiceDependencies = defaultDependencies,
): Promise<IntelligenceInboxResponse> {
  const now = dependencies.now();
  const checkedAt = now.toISOString();
  const watchlists = await dependencies.listWatchlists(ownerId);
  const trackedSymbols = trackedSymbolSnapshots(watchlists);
  const symbols = trackedSymbols.map((symbol) => symbol.id);
  let sync: IntelligenceInboxSyncMeta = {
    status: "empty_watchlist",
    checkedAt,
    dataMode: null,
    freshness: null,
    providerCoverage: null,
    baselineApplied: false,
    hasMoreCandidates: false,
    newItemCount: 0,
    newDeliveryCount: 0,
    notice: "Add a symbol to a watchlist to activate the durable intelligence inbox.",
  };

  if (symbols.length > 0) {
    const claim = await dependencies.repository.claimReconciliation(
      ownerId,
      checkedAt,
    );
    if (!claim.acquired) {
      sync = {
        status: "refresh_deferred",
        checkedAt,
        dataMode: null,
        freshness: null,
        providerCoverage: null,
        baselineApplied: false,
        hasMoreCandidates: claim.catchupPending,
        newItemCount: 0,
        newDeliveryCount: 0,
        notice:
          claim.reason === "in_flight"
            ? "A live provider refresh is already in progress. Showing persisted inbox state while that request completes."
            : "Live providers were checked recently. This read reused persisted inbox state to protect provider capacity.",
      };
    } else {
      if (!claim.token) throw new Error("inbox_sync_claim_missing_token");
      let providerSucceeded = false;
      let hasMoreCandidates = false;
      try {
        let feed: OrchestratedIntelligenceFeed | null = null;
        try {
          feed = await dependencies.getFeed({
            symbols,
            since: new Date(
              now.getTime() - 7 * 24 * 60 * 60 * 1_000,
            ).toISOString(),
            limit: 100,
            minimumMateriality: "low",
          });
          providerSucceeded = true;
        } catch {
          sync = {
            status: "provider_unavailable",
            checkedAt,
            dataMode: null,
            freshness: null,
            providerCoverage: null,
            baselineApplied: false,
            hasMoreCandidates: false,
            newItemCount: 0,
            newDeliveryCount: 0,
            notice:
              "Live providers are temporarily unavailable. Showing persisted inbox items without changing storage.",
          };
        }

        if (feed) {
          const liveFresh =
            feed.meta.dataMode === "live" &&
            feed.meta.freshness.state === "fresh";
          const liveEmpty =
            feed.meta.dataMode === "live" && feed.data.length === 0;
          const syncAllowed = liveFresh || liveEmpty;
          sync = {
            status:
              feed.meta.dataMode !== "live"
                ? "demo_suppressed"
                : !syncAllowed
                  ? "stale_suppressed"
                  : "live",
            checkedAt,
            dataMode: feed.meta.dataMode,
            freshness: feed.meta.freshness.state,
            providerCoverage: feed.meta.providerCoverage,
            baselineApplied: false,
            hasMoreCandidates: false,
            newItemCount: 0,
            newDeliveryCount: 0,
            notice: syncAllowed
              ? liveEmpty
                ? "Live providers returned no matching events. Inbox activation was recorded without persisting fixtures."
                : "Fresh live provider events were reconciled into the durable inbox."
              : feed.meta.dataMode === "live"
                ? "The live provider response was stale, so no events were persisted; inbox activation was recorded for future fresh events."
                : "Provider output was not fresh live data, so stored inbox state was left unchanged.",
          };

          if (syncAllowed) {
            const tracked = new Set(symbols);
            const eligibleItems = feed.data
              .filter(
                (item) =>
                  item.isLive &&
                  item.sourceKind !== "demo_fixture" &&
                  item.symbolIds.some((symbol) => tracked.has(symbol)) &&
                  isIndividuallyFresh(item, now),
              )
              .map((item) => ({
                ...item,
                symbolIds: item.symbolIds.filter((symbol) => tracked.has(symbol)),
              }))
              .sort(
                (left, right) =>
                  right.publishedAt.localeCompare(left.publishedAt) ||
                  left.id.localeCompare(right.id),
              );
            const result = await dependencies.repository.syncLiveItems(
              ownerId,
              eligibleItems,
              checkedAt,
            );
            sync = { ...sync, ...result };
            hasMoreCandidates = result.hasMoreCandidates;
            if (feed.data.length > 0 && eligibleItems.length === 0) {
              sync.notice =
                "The provider batch contained no individually fresh eligible events. Inbox activation was recorded without persisting stale items.";
            }
          } else if (feed.meta.dataMode === "live") {
            const result = await dependencies.repository.syncLiveItems(
              ownerId,
              [],
              checkedAt,
            );
            sync = { ...sync, ...result };
            hasMoreCandidates = result.hasMoreCandidates;
          }
        }
      } finally {
        await dependencies.repository.completeReconciliation(
          ownerId,
          claim.token,
          dependencies.now().toISOString(),
          { providerSucceeded, hasMoreCandidates },
        );
      }
    }
  }

  const [inbox, rules] = await Promise.all([
    dependencies.repository.listInbox(ownerId, query.filter, query.limit),
    dependencies.repository.listRules(ownerId, trackedSymbols),
  ]);
  return {
    data: { ...inbox, rules },
    meta: {
      ...baseMeta(checkedAt),
      filter: query.filter,
      limit: query.limit,
      sync,
    },
  };
}

export async function getAlertRules(
  ownerId: string,
  dependencies: InboxServiceDependencies = defaultDependencies,
): Promise<AlertRulesResponse> {
  const generatedAt = dependencies.now().toISOString();
  const watchlists = await dependencies.listWatchlists(ownerId);
  const rules = await dependencies.repository.listRules(
    ownerId,
    trackedSymbolSnapshots(watchlists),
  );
  return {
    data: { rules },
    meta: baseMeta(generatedAt),
  };
}

export async function getIntelligenceInboxItem(
  ownerId: string,
  eventId: string,
  dependencies: InboxServiceDependencies = defaultDependencies,
): Promise<IntelligenceInboxItemResponse> {
  const generatedAt = dependencies.now().toISOString();
  const item = await dependencies.repository.getInboxItem(ownerId, eventId);
  return {
    data: { item },
    meta: baseMeta(generatedAt),
  };
}

export async function updateIntelligenceInboxState(
  ownerId: string,
  eventId: string,
  mutation: InboxStateMutation,
  dependencies: InboxServiceDependencies = defaultDependencies,
): Promise<InboxStateMutationResponse> {
  const generatedAt = dependencies.now().toISOString();
  const result = await dependencies.repository.updateInboxState(
    ownerId,
    eventId,
    mutation,
    generatedAt,
  );
  return toInboxStateMutationResponse(result, generatedAt);
}

export async function putAlertRule(
  ownerId: string,
  symbolId: CanonicalSymbol,
  mutation: AlertRuleMutation,
  dependencies: InboxServiceDependencies = defaultDependencies,
): Promise<AlertRuleMutationResponse> {
  const generatedAt = dependencies.now().toISOString();
  const result = await dependencies.repository.putAlertRule(
    ownerId,
    symbolId,
    mutation,
    generatedAt,
  );
  return toAlertRuleMutationResponse(result, generatedAt);
}
