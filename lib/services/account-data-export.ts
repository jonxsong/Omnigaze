import { ACCOUNT_DATA_EXPORT_SCHEMA_VERSION } from "@/lib/account-data-export";
import { microsToDecimal } from "@/lib/portfolio/decimal";
import {
  ACCOUNT_DATA_EXPORT_LIMITS,
  readOwnerSavedData,
  type AccountSavedDataSource,
  type ExportInstrumentRow,
  type ExportRows,
} from "@/lib/repositories/account-data-export";
import { isCredentialFreePublicHttpUrl } from "@/lib/security/public-http-url";

type AccountDataExportDependencies = {
  readOwnerSavedData(ownerId: string): Promise<AccountSavedDataSource>;
  now(): Date;
};

const defaultDependencies: AccountDataExportDependencies = {
  readOwnerSavedData,
  now: () => new Date(),
};

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function text(value: unknown, maximum: number) {
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function stringList(value: unknown, maximumItems: number, maximumLength: number) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, maximumItems)
    .filter(
      (item): item is string =>
        typeof item === "string" && item.length <= maximumLength,
    );
}

function safeSourceUrl(value: string | null) {
  if (!value || !isCredentialFreePublicHttpUrl(value)) return null;
  return new URL(value).toString();
}

/**
 * Daily Brief cache payloads are projected through an allowlist. This keeps
 * the useful brief prose while ensuring cache identities, evidence records,
 * prompts, model configuration and provider payloads can never enter an
 * account export.
 */
function projectDailyBriefContent(responseJson: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseJson) as unknown;
  } catch {
    throw new Error("Invalid Daily Brief record.");
  }
  const envelope = asObject(parsed);
  const candidate = asObject(envelope?.data) ?? envelope;
  if (!candidate) throw new Error("Invalid Daily Brief record.");

  const headline = text(candidate.headline, 180);
  const summary = text(candidate.summary, 1_200);
  if (!headline || !summary) throw new Error("Invalid Daily Brief record.");

  const developments = Array.isArray(candidate.developments)
    ? candidate.developments.slice(0, 3).flatMap((entry) => {
        const item = asObject(entry);
        const title = text(item?.title, 180);
        const whyItMatters = text(item?.whyItMatters, 700);
        const direction = text(item?.direction, 16);
        if (!title || !whyItMatters || !direction) return [];
        return [{
          title,
          whyItMatters,
          direction,
          instrumentIds: stringList(item?.symbolIds, 12, 100).sort(),
        }];
      })
    : [];

  const window = asObject(candidate.window);
  return {
    headline,
    summary,
    briefDate: text(candidate.briefDate, 10),
    window: window
      ? {
          since: text(window.since, 40),
          through: text(window.through, 40),
        }
      : null,
    developments,
    watchNext: stringList(candidate.watchNext, 6, 300),
    unknowns: stringList(candidate.unknowns, 6, 300),
  };
}

function instrument(row: ExportInstrumentRow) {
  return {
    id: row.instrumentId,
    ticker: row.ticker,
    exchange: row.exchange,
    name: row.instrumentName,
    sector: row.sector,
    currency: row.currency,
    status: row.instrumentStatus,
  };
}

function compareText(...pairs: Array<[string, string]>) {
  for (const [left, right] of pairs) {
    const order = left.localeCompare(right, "en", { sensitivity: "base" });
    if (order !== 0) return order;
  }
  return 0;
}

function section<T>(source: ExportRows<unknown>, limit: number, records: T[]) {
  if (
    !Number.isSafeInteger(source.total) ||
    source.total < 0 ||
    records.length > limit ||
    records.length > source.total
  ) {
    throw new Error("Invalid saved-data section.");
  }
  return {
    meta: {
      total: source.total,
      exported: records.length,
      truncated: source.total > records.length,
      limit,
    },
    records,
  };
}

function singletonSection<T>(record: T | null) {
  const records = record === null ? [] : [record];
  return {
    meta: {
      total: records.length,
      exported: records.length,
      truncated: false,
      limit: 1,
    },
    records,
  };
}

function assertSafeAggregateCounts(values: readonly number[]) {
  if (values.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error("Invalid saved-data aggregate.");
  }
}

export async function buildAccountSavedDataSnapshot(
  ownerId: string,
  dependencies: AccountDataExportDependencies = defaultDependencies,
) {
  const [source, exportedAt] = await Promise.all([
    dependencies.readOwnerSavedData(ownerId),
    Promise.resolve(dependencies.now().toISOString()),
  ]);

  const watchlists = [...source.watchlists.rows]
    .sort((left, right) =>
      right.isDefault - left.isDefault ||
      compareText([left.name, right.name], [left.watchlistId, right.watchlistId]),
    )
    .map((row) => ({
      id: row.watchlistId,
      name: row.name,
      isDefault: Boolean(row.isDefault),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

  const watchlistItems = [...source.watchlistItems.rows]
    .sort((left, right) =>
      compareText(
        [left.watchlistName, right.watchlistName],
        [left.watchlistId, right.watchlistId],
        [left.exchange, right.exchange],
        [left.ticker, right.ticker],
        [left.instrumentId, right.instrumentId],
      ),
    )
    .map((row) => ({
      watchlist: { id: row.watchlistId, name: row.watchlistName },
      instrument: instrument(row),
      note: row.note,
      addedAt: row.addedAt,
    }));

  const portfolioProfile = source.portfolioProfile
    ? {
        baseCurrency: source.portfolioProfile.baseCurrency,
        experienceLevel: source.portfolioProfile.experienceLevel,
        riskComfort: source.portfolioProfile.riskComfort,
        timeHorizon: source.portfolioProfile.timeHorizon,
        objective: source.portfolioProfile.objective,
        maxSinglePositionBps: source.portfolioProfile.maxSinglePositionBps,
        onboardingCompletedAt: source.portfolioProfile.onboardingCompletedAt,
        version: source.portfolioProfile.version,
        createdAt: source.portfolioProfile.createdAt,
        updatedAt: source.portfolioProfile.updatedAt,
      }
    : null;

  const portfolioHoldings = [...source.portfolioHoldings.rows]
    .sort((left, right) =>
      compareText(
        [left.exchange, right.exchange],
        [left.ticker, right.ticker],
        [left.instrumentId, right.instrumentId],
      ),
    )
    .map((row) => ({
      instrument: instrument(row),
      quantity: microsToDecimal(row.quantityMicros),
      averageCost:
        row.averageCostMicros === null
          ? null
          : microsToDecimal(row.averageCostMicros),
      costCurrency: row.costCurrency,
      quantityAsOf: row.quantityAsOf,
      entrySource: row.entrySource,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

  const inboxStates = [...source.inboxStates.rows]
    .sort(
      (left, right) =>
        compareText([right.lastSeenAt, left.lastSeenAt]) ||
        compareText([left.eventId, right.eventId]),
    )
    .map((row) => {
      let topicTags: string[] = [];
      try {
        topicTags = stringList(JSON.parse(row.topicTagsJson) as unknown, 24, 80).sort();
      } catch {
        throw new Error("Invalid inbox event record.");
      }
      return {
        event: {
          id: row.eventId,
          source: row.source,
          kind: row.sourceKind,
          headline: row.headline,
          summary: row.summary,
          publishedAt: row.publishedAt,
          receivedAt: row.receivedAt,
          sourceUrl: safeSourceUrl(row.sourceUrl),
          materiality: row.materiality,
          category: row.category,
          claimStatus: row.claimStatus,
          causalLink: row.causalLink,
          topicTags,
          isControversial: Boolean(row.isControversial),
          revision: row.eventRevision,
        },
        state: {
          readAt: row.readAt,
          readRevision: row.readRevision,
          savedAt: row.savedAt,
          dismissedAt: row.dismissedAt,
          firstSeenAt: row.firstSeenAt,
          lastSeenAt: row.lastSeenAt,
          version: row.stateVersion,
        },
      };
    });

  const alertRules = [...source.alertRules.rows]
    .sort((left, right) =>
      compareText(
        [left.exchange, right.exchange],
        [left.ticker, right.ticker],
        [left.instrumentId, right.instrumentId],
      ),
    )
    .map((row) => ({
      instrument: instrument(row),
      enabled: Boolean(row.enabled),
      minimumMateriality: row.minimumMateriality,
      includeControversy: Boolean(row.includeControversy),
      channel: row.channel,
      version: row.version,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));

  const alertDeliveries = [...source.alertDeliveries.rows]
    .sort(
      (left, right) =>
        compareText([right.deliveredAt, left.deliveredAt]) ||
        compareText(
          [left.eventId, right.eventId],
          [left.instrumentId, right.instrumentId],
        ),
    )
    .map((row) => ({
      instrument: instrument(row),
      channel: row.channel,
      deliveredAt: row.deliveredAt,
      event: {
        id: row.eventId,
        revision: row.eventRevision,
        headline: row.eventHeadline,
        source: row.eventSource,
        kind: row.eventSourceKind,
        publishedAt: row.eventPublishedAt,
        materiality: row.eventMateriality,
        isControversial: Boolean(row.eventIsControversial),
      },
    }));

  const dailyBriefs = [...source.dailyBriefs.rows]
    .sort(
      (left, right) =>
        compareText([right.briefDate, left.briefDate]) ||
        compareText([right.generatedAt, left.generatedAt]),
    )
    .map((row) => ({
      briefDate: row.briefDate,
      generatedAt: row.generatedAt,
      expiresAt: row.expiresAt,
      lastAccessedAt: row.lastAccessedAt,
      hitCount: row.hitCount,
      content: projectDailyBriefContent(row.responseJson),
    }));

  assertSafeAggregateCounts([
    source.aiUsage.reservationCount,
    source.aiUsage.consumedUnits,
    source.aiUsage.completedCount,
    source.aiUsage.failedCount,
    source.aiUsage.reservedCount,
  ]);
  if (
    source.aiUsage.completedCount +
      source.aiUsage.failedCount +
      source.aiUsage.reservedCount !==
    source.aiUsage.reservationCount
  ) {
    throw new Error("Invalid saved-data aggregate.");
  }
  const aiUsage = {
    reservationCount: source.aiUsage.reservationCount,
    consumedUnits: source.aiUsage.consumedUnits,
    completedCount: source.aiUsage.completedCount,
    failedCount: source.aiUsage.failedCount,
    inProgressCount: source.aiUsage.reservedCount,
    firstDay: source.aiUsage.firstDay,
    lastDay: source.aiUsage.lastDay,
  };
  const aiUsagePresent = source.aiUsage.reservationCount > 0;

  const sync = {
    profile: source.syncProfile
      ? {
          activatedAt: source.syncProfile.activatedAt,
          baselineCompletedAt: source.syncProfile.baselineCompletedAt,
          lastCheckedAt: source.syncProfile.lastCheckedAt,
          lastSuccessfulSyncAt: source.syncProfile.lastSuccessfulSyncAt,
        }
      : null,
    gate: source.syncGate
      ? {
          catchupPending: Boolean(source.syncGate.catchupPending),
          nextAllowedAt: source.syncGate.nextAllowedAt,
          lastAttemptAt: source.syncGate.lastAttemptAt,
          lastCompletedAt: source.syncGate.lastCompletedAt,
        }
      : null,
    projection: source.projection
      ? {
          nextAllowedAt: source.projection.nextAllowedAt,
          lastAttemptAt: source.projection.lastAttemptAt,
          lastCompletedAt: source.projection.lastCompletedAt,
          consecutiveFailures: source.projection.consecutiveFailures,
          updatedAt: source.projection.updatedAt,
        }
      : null,
  };
  const syncRecordCount = [source.syncProfile, source.syncGate, source.projection]
    .filter(Boolean).length;
  const syncPresent = syncRecordCount > 0;

  return {
    schemaVersion: ACCOUNT_DATA_EXPORT_SCHEMA_VERSION,
    snapshotType: "omnigaze-saved-data-snapshot" as const,
    exportedAt,
    scope: {
      identity: "authenticated-owner" as const,
      bounded: true,
      description:
        "A bounded snapshot of personal data currently saved by Omnigaze. It excludes account identity, credentials, prompts, raw provider payloads, shared evidence, and logs.",
    },
    sections: {
      watchlists: section(
        source.watchlists,
        ACCOUNT_DATA_EXPORT_LIMITS.watchlists,
        watchlists,
      ),
      watchlistItems: section(
        source.watchlistItems,
        ACCOUNT_DATA_EXPORT_LIMITS.watchlistItems,
        watchlistItems,
      ),
      portfolioProfile: singletonSection(portfolioProfile),
      portfolioHoldings: section(
        source.portfolioHoldings,
        ACCOUNT_DATA_EXPORT_LIMITS.portfolioHoldings,
        portfolioHoldings,
      ),
      inboxStates: section(
        source.inboxStates,
        ACCOUNT_DATA_EXPORT_LIMITS.inboxStates,
        inboxStates,
      ),
      alertRules: section(
        source.alertRules,
        ACCOUNT_DATA_EXPORT_LIMITS.alertRules,
        alertRules,
      ),
      alertDeliveries: section(
        source.alertDeliveries,
        ACCOUNT_DATA_EXPORT_LIMITS.alertDeliveries,
        alertDeliveries,
      ),
      dailyBriefs: section(
        source.dailyBriefs,
        ACCOUNT_DATA_EXPORT_LIMITS.dailyBriefs,
        dailyBriefs,
      ),
      aiUsageSummary: {
        meta: {
          total: aiUsagePresent ? 1 : 0,
          exported: aiUsagePresent ? 1 : 0,
          truncated: false,
          limit: 1,
        },
        records: aiUsagePresent ? [aiUsage] : [],
      },
      syncSummary: {
        meta: {
          total: syncPresent ? 1 : 0,
          exported: syncPresent ? 1 : 0,
          truncated: false,
          limit: 1,
        },
        records: syncPresent ? [{ sourceRecordCount: syncRecordCount, ...sync }] : [],
      },
    },
  };
}

export type AccountSavedDataSnapshot = Awaited<
  ReturnType<typeof buildAccountSavedDataSnapshot>
>;
