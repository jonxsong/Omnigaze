import {
  inboxProjectionCursorRepository,
  type InboxProjectionCursorRepository,
} from "@/lib/intelligence-inbox/projection-repository";
import {
  intelligenceInboxRepository,
  MAX_INBOX_ITEMS_PER_SYNC,
  type IntelligenceInboxRepository,
} from "@/lib/intelligence-inbox/repository";
import type { ProjectionChangePage } from "@/lib/ingestion/contracts";
import type { CanonicalSymbol } from "@/lib/market-types";
import { listUserWatchlists } from "@/lib/repositories/watchlists";
import { projectCollectedSourceEvent } from "@/lib/services/collected-intelligence";
import type { IntelligenceFeedItem } from "@/lib/services/live-market-data";

const MAX_PROJECTION_CHANGES_PER_TICK = 16;

type WatchlistResult = Awaited<ReturnType<typeof listUserWatchlists>>;

export interface IntelligenceProjectionDependencies {
  cursors: Pick<
    InboxProjectionCursorRepository,
    "claimNext" | "complete" | "fail"
  >;
  inbox: IntelligenceInboxRepository;
  listWatchlists(ownerId: string): Promise<WatchlistResult>;
  listChanges(input: {
    afterSequence: number;
    limit: number;
  }): Promise<ProjectionChangePage>;
  now(): Date;
}

export interface IntelligenceProjectionTickResult {
  status: "idle" | "processed";
  scannedChangeCount: number;
  projectedItemCount: number;
  newItemCount: number;
  newDeliveryCount: number;
  hasMore: boolean;
}

export class IntelligenceProjectionTickError extends Error {
  readonly code = "intelligence_projection_failed";
  readonly stage = "owner_projection";
  readonly retryable = true;

  constructor() {
    super("The owner intelligence projection tick failed.");
    this.name = "IntelligenceProjectionTickError";
  }
}

const defaultDependencies: IntelligenceProjectionDependencies = {
  cursors: inboxProjectionCursorRepository,
  inbox: intelligenceInboxRepository,
  listWatchlists: listUserWatchlists,
  listChanges: async (input) => {
    const { ingestionRepository } = await import("@/lib/ingestion/repository");
    return ingestionRepository.listProjectionChanges(input);
  },
  now: () => new Date(),
};

function trackedSymbols(watchlists: WatchlistResult) {
  return [
    ...new Set(
      watchlists.flatMap((watchlist) =>
        watchlist.items.map((item) => item.symbolId as CanonicalSymbol),
      ),
    ),
  ].sort();
}

function newestProjectedItem(
  current: IntelligenceFeedItem | undefined,
  candidate: IntelligenceFeedItem,
) {
  if (!current) return candidate;
  const currentRevision = Date.parse(
    current.providerUpdatedAt ?? current.receivedAt,
  );
  const candidateRevision = Date.parse(
    candidate.providerUpdatedAt ?? candidate.receivedAt,
  );
  if (candidateRevision !== currentRevision) {
    return candidateRevision > currentRevision ? candidate : current;
  }
  const currentObserved = Date.parse(current.receivedAt);
  const candidateObserved = Date.parse(candidate.receivedAt);
  if (candidateObserved !== currentObserved) {
    return candidateObserved > currentObserved ? candidate : current;
  }
  return candidate;
}

export async function runIntelligenceProjectionTick(
  dependencies: IntelligenceProjectionDependencies = defaultDependencies,
): Promise<IntelligenceProjectionTickResult> {
  const requestedAt = dependencies.now().toISOString();
  const lease = await dependencies.cursors.claimNext(requestedAt);
  if (!lease) {
    return {
      status: "idle",
      scannedChangeCount: 0,
      projectedItemCount: 0,
      newItemCount: 0,
      newDeliveryCount: 0,
      hasMore: false,
    };
  }

  try {
    const [watchlists, page] = await Promise.all([
      dependencies.listWatchlists(lease.ownerId),
      dependencies.listChanges({
        afterSequence: lease.lastSequence,
        limit: MAX_PROJECTION_CHANGES_PER_TICK,
      }),
    ]);
    const requestedSymbols = new Set(trackedSymbols(watchlists));
    const projectedById = new Map<string, IntelligenceFeedItem>();
    let lastSequence = lease.lastSequence;
    let scannedChangeCount = 0;
    let stoppedAtItemLimit = false;

    for (const change of page.items) {
      const projectedSource = projectCollectedSourceEvent(
        change.event,
        requestedSymbols,
      );
      const changedAt = Date.parse(change.changedAt);
      if (!Number.isFinite(changedAt)) {
        throw new Error("invalid_projection_change_time");
      }
      const projected = projectedSource
        ? {
            ...projectedSource,
            receivedAt: new Date(changedAt).toISOString(),
          }
        : null;
      // Leave the first unmaterialized distinct event behind the durable cursor.
      // Duplicate versions of an already selected identity may still replace the
      // candidate because syncLiveItems reconciles by stable provider:event ID.
      if (
        projected &&
        !projectedById.has(projected.id) &&
        projectedById.size >= MAX_INBOX_ITEMS_PER_SYNC
      ) {
        stoppedAtItemLimit = true;
        break;
      }
      if (projected) {
        projectedById.set(
          projected.id,
          newestProjectedItem(projectedById.get(projected.id), projected),
        );
      }
      lastSequence = change.sequence;
      scannedChangeCount += 1;
    }

    const projectedItems = [...projectedById.values()];
    const hasMore = stoppedAtItemLimit || page.hasMore;
    const syncedAt = dependencies.now().toISOString();
    const sync = await dependencies.inbox.syncLiveItems(
      lease.ownerId,
      projectedItems,
      syncedAt,
      { globalCursorDrained: false },
    );
    if (sync.hasMoreCandidates) {
      throw new Error("projection_batch_exceeded_materialization_bound");
    }

    const completedAt = dependencies.now().toISOString();
    await dependencies.cursors.complete(
      lease,
      completedAt,
      lastSequence,
      hasMore,
    );
    if (!hasMore) {
      // Close baseline only after the durable cursor advancement proves that no
      // global change remains. A failed cursor CAS can therefore never mark an
      // owner baseline complete prematurely.
      await dependencies.inbox.syncLiveItems(
        lease.ownerId,
        [],
        completedAt,
        { globalCursorDrained: true },
      );
    }
    return {
      status: "processed",
      scannedChangeCount,
      projectedItemCount: projectedItems.length,
      newItemCount: sync.newItemCount,
      newDeliveryCount: sync.newDeliveryCount,
      hasMore,
    };
  } catch {
    try {
      await dependencies.cursors.fail(
        lease,
        dependencies.now().toISOString(),
      );
    } catch {
      // Preserve the original sanitized failure. An expired lease is safe
      // because its cursor was not advanced.
    }
    throw new IntelligenceProjectionTickError();
  }
}
