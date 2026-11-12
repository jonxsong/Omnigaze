import { getDb } from "@/db";

export const ACCOUNT_DATA_EXPORT_LIMITS = Object.freeze({
  watchlists: 50,
  watchlistItems: 500,
  portfolioHoldings: 250,
  inboxStates: 1_000,
  alertRules: 250,
  alertDeliveries: 1_000,
  dailyBriefs: 30,
});

type ExportDatabase = Pick<D1Database, "prepare">;
export type AccountDataExportDatabaseFactory = () => ExportDatabase;

export type ExportInstrumentRow = {
  instrumentId: string;
  ticker: string;
  exchange: string;
  instrumentName: string;
  sector: string | null;
  currency: string;
  instrumentStatus: string;
};

export type ExportWatchlistRow = {
  watchlistId: string;
  name: string;
  isDefault: number;
  createdAt: string;
  updatedAt: string;
};

export type ExportWatchlistItemRow = ExportInstrumentRow & {
  watchlistId: string;
  watchlistName: string;
  note: string | null;
  addedAt: string;
};

export type ExportPortfolioProfileRow = {
  baseCurrency: string;
  experienceLevel: string;
  riskComfort: string;
  timeHorizon: string;
  objective: string;
  maxSinglePositionBps: number | null;
  onboardingCompletedAt: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ExportPortfolioHoldingRow = ExportInstrumentRow & {
  quantityMicros: number;
  averageCostMicros: number | null;
  costCurrency: string;
  quantityAsOf: string;
  entrySource: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ExportInboxStateRow = {
  eventId: string;
  source: string;
  sourceKind: string;
  headline: string;
  summary: string | null;
  publishedAt: string;
  receivedAt: string;
  sourceUrl: string | null;
  materiality: string;
  category: string | null;
  claimStatus: string | null;
  causalLink: string | null;
  topicTagsJson: string;
  isControversial: number;
  eventRevision: number;
  readAt: string | null;
  readRevision: number;
  savedAt: string | null;
  dismissedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  stateVersion: number;
};

export type ExportAlertRuleRow = ExportInstrumentRow & {
  enabled: number;
  minimumMateriality: string;
  includeControversy: number;
  channel: string;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ExportAlertDeliveryRow = ExportInstrumentRow & {
  eventId: string;
  eventRevision: number;
  channel: string;
  deliveredAt: string;
  eventHeadline: string;
  eventSource: string;
  eventSourceKind: string;
  eventPublishedAt: string;
  eventMateriality: string;
  eventIsControversial: number;
};

export type ExportDailyBriefRow = {
  briefDate: string;
  responseJson: string;
  generatedAt: string;
  expiresAt: string;
  lastAccessedAt: string;
  hitCount: number;
};

export type ExportAiUsageRow = {
  reservationCount: number;
  consumedUnits: number;
  completedCount: number;
  failedCount: number;
  reservedCount: number;
  firstDay: string | null;
  lastDay: string | null;
};

export type ExportSyncProfileRow = {
  activatedAt: string;
  baselineCompletedAt: string | null;
  lastCheckedAt: string;
  lastSuccessfulSyncAt: string;
};

export type ExportSyncGateRow = {
  catchupPending: number;
  nextAllowedAt: string;
  lastAttemptAt: string;
  lastCompletedAt: string | null;
};

export type ExportProjectionRow = {
  nextAllowedAt: string;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
  consecutiveFailures: number;
  updatedAt: string;
};

export type ExportRows<T> = { total: number; rows: T[] };

export type AccountSavedDataSource = {
  watchlists: ExportRows<ExportWatchlistRow>;
  watchlistItems: ExportRows<ExportWatchlistItemRow>;
  portfolioProfile: ExportPortfolioProfileRow | null;
  portfolioHoldings: ExportRows<ExportPortfolioHoldingRow>;
  inboxStates: ExportRows<ExportInboxStateRow>;
  alertRules: ExportRows<ExportAlertRuleRow>;
  alertDeliveries: ExportRows<ExportAlertDeliveryRow>;
  dailyBriefs: ExportRows<ExportDailyBriefRow>;
  aiUsage: ExportAiUsageRow;
  syncProfile: ExportSyncProfileRow | null;
  syncGate: ExportSyncGateRow | null;
  projection: ExportProjectionRow | null;
};

function runtimeDatabase(): ExportDatabase {
  return getDb().$client;
}

function assertOwnerId(ownerId: string) {
  if (ownerId.length < 1 || ownerId.length > 256) {
    throw new Error("Invalid owner identity.");
  }
}

async function totalFor(
  database: ExportDatabase,
  statement: string,
  ownerId: string,
) {
  const row = await database
    .prepare(statement)
    .bind(ownerId)
    .first<{ total: number }>();
  const total = row?.total ?? 0;
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("Invalid saved-data count.");
  }
  return total;
}

async function limitedRows<T>(
  database: ExportDatabase,
  statement: string,
  ownerId: string,
  limit: number,
) {
  const result = await database
    .prepare(statement)
    .bind(ownerId, limit)
    .all<T>();
  return result.results ?? [];
}

async function firstRow<T>(
  database: ExportDatabase,
  statement: string,
  ownerId: string,
) {
  return database.prepare(statement).bind(ownerId).first<T>();
}

export async function readOwnerSavedData(
  ownerId: string,
  databaseFactory: AccountDataExportDatabaseFactory = runtimeDatabase,
): Promise<AccountSavedDataSource> {
  assertOwnerId(ownerId);
  const database = databaseFactory();

  const [
    watchlistTotal,
    watchlistRows,
    watchlistItemTotal,
    watchlistItemRows,
    portfolioProfile,
    holdingTotal,
    holdingRows,
    inboxStateTotal,
    inboxStateRows,
    alertRuleTotal,
    alertRuleRows,
    alertDeliveryTotal,
    alertDeliveryRows,
    dailyBriefTotal,
    dailyBriefRows,
    aiUsage,
    syncProfile,
    syncGate,
    projection,
  ] = await Promise.all([
    totalFor(database, "SELECT COUNT(*) AS total FROM watchlists WHERE owner_id = ?1", ownerId),
    limitedRows<ExportWatchlistRow>(
      database,
      `SELECT id AS watchlistId, name, is_default AS isDefault,
              created_at AS createdAt, updated_at AS updatedAt
         FROM watchlists
        WHERE owner_id = ?1
        ORDER BY is_default DESC, name COLLATE NOCASE ASC, id ASC
        LIMIT ?2`,
      ownerId,
      ACCOUNT_DATA_EXPORT_LIMITS.watchlists,
    ),
    totalFor(
      database,
      `SELECT COUNT(*) AS total
         FROM watchlist_items wi
         JOIN watchlists w ON w.id = wi.watchlist_id
        WHERE w.owner_id = ?1`,
      ownerId,
    ),
    limitedRows<ExportWatchlistItemRow>(
      database,
      `SELECT wi.watchlist_id AS watchlistId, w.name AS watchlistName,
              wi.note, wi.added_at AS addedAt,
              i.id AS instrumentId, i.ticker, i.exchange,
              i.name AS instrumentName, i.sector, i.currency,
              i.status AS instrumentStatus
         FROM watchlist_items wi
         JOIN watchlists w ON w.id = wi.watchlist_id
         JOIN instruments i ON i.id = wi.symbol_id
        WHERE w.owner_id = ?1
        ORDER BY w.name COLLATE NOCASE ASC, w.id ASC,
                 i.exchange ASC, i.ticker ASC, i.id ASC
        LIMIT ?2`,
      ownerId,
      ACCOUNT_DATA_EXPORT_LIMITS.watchlistItems,
    ),
    firstRow<ExportPortfolioProfileRow>(
      database,
      `SELECT base_currency AS baseCurrency,
              experience_level AS experienceLevel,
              risk_comfort AS riskComfort, time_horizon AS timeHorizon,
              objective, max_single_position_bps AS maxSinglePositionBps,
              onboarding_completed_at AS onboardingCompletedAt,
              version, created_at AS createdAt, updated_at AS updatedAt
         FROM portfolio_profiles WHERE owner_id = ?1`,
      ownerId,
    ),
    totalFor(database, "SELECT COUNT(*) AS total FROM portfolio_holdings WHERE owner_id = ?1", ownerId),
    limitedRows<ExportPortfolioHoldingRow>(
      database,
      `SELECT ph.quantity_micros AS quantityMicros,
              ph.average_cost_micros AS averageCostMicros,
              ph.cost_currency AS costCurrency,
              ph.quantity_as_of AS quantityAsOf,
              ph.entry_source AS entrySource, ph.version,
              ph.created_at AS createdAt, ph.updated_at AS updatedAt,
              i.id AS instrumentId, i.ticker, i.exchange,
              i.name AS instrumentName, i.sector, i.currency,
              i.status AS instrumentStatus
         FROM portfolio_holdings ph
         JOIN instruments i ON i.id = ph.symbol_id
        WHERE ph.owner_id = ?1
        ORDER BY i.exchange ASC, i.ticker ASC, i.id ASC
        LIMIT ?2`,
      ownerId,
      ACCOUNT_DATA_EXPORT_LIMITS.portfolioHoldings,
    ),
    totalFor(database, "SELECT COUNT(*) AS total FROM inbox_event_states WHERE owner_id = ?1", ownerId),
    limitedRows<ExportInboxStateRow>(
      database,
      `SELECT ies.event_id AS eventId, ie.source, ie.source_kind AS sourceKind,
              ie.headline, ie.summary, ie.published_at AS publishedAt,
              ie.received_at AS receivedAt, ie.source_url AS sourceUrl,
              ie.materiality, ie.category, ie.claim_status AS claimStatus,
              ie.causal_link AS causalLink, ie.topic_tags_json AS topicTagsJson,
              ie.is_controversial AS isControversial,
              ie.revision AS eventRevision, ies.read_at AS readAt,
              ies.read_revision AS readRevision, ies.saved_at AS savedAt,
              ies.dismissed_at AS dismissedAt,
              ies.first_seen_at AS firstSeenAt, ies.last_seen_at AS lastSeenAt,
              ies.version AS stateVersion
         FROM inbox_event_states ies
         JOIN inbox_events ie ON ie.id = ies.event_id
        WHERE ies.owner_id = ?1
        ORDER BY ies.last_seen_at DESC, ies.event_id ASC
        LIMIT ?2`,
      ownerId,
      ACCOUNT_DATA_EXPORT_LIMITS.inboxStates,
    ),
    totalFor(database, "SELECT COUNT(*) AS total FROM alert_rules WHERE owner_id = ?1", ownerId),
    limitedRows<ExportAlertRuleRow>(
      database,
      `SELECT ar.enabled, ar.minimum_materiality AS minimumMateriality,
              ar.include_controversy AS includeControversy, ar.channel,
              ar.version, ar.created_at AS createdAt, ar.updated_at AS updatedAt,
              i.id AS instrumentId, i.ticker, i.exchange,
              i.name AS instrumentName, i.sector, i.currency,
              i.status AS instrumentStatus
         FROM alert_rules ar
         JOIN instruments i ON i.id = ar.symbol_id
        WHERE ar.owner_id = ?1
        ORDER BY i.exchange ASC, i.ticker ASC, i.id ASC
        LIMIT ?2`,
      ownerId,
      ACCOUNT_DATA_EXPORT_LIMITS.alertRules,
    ),
    totalFor(database, "SELECT COUNT(*) AS total FROM alert_deliveries WHERE owner_id = ?1", ownerId),
    limitedRows<ExportAlertDeliveryRow>(
      database,
      `SELECT ad.event_id AS eventId, ad.event_revision AS eventRevision,
              ad.channel, ad.delivered_at AS deliveredAt,
              i.id AS instrumentId, i.ticker, i.exchange,
              i.name AS instrumentName, i.sector, i.currency,
              i.status AS instrumentStatus,
              ie.headline AS eventHeadline, ie.source AS eventSource,
              ie.source_kind AS eventSourceKind,
              ie.published_at AS eventPublishedAt,
              ie.materiality AS eventMateriality,
              ie.is_controversial AS eventIsControversial
         FROM alert_deliveries ad
         JOIN instruments i ON i.id = ad.rule_symbol_id
         JOIN inbox_events ie ON ie.id = ad.event_id
        WHERE ad.owner_id = ?1
        ORDER BY ad.delivered_at DESC, ad.event_id ASC,
                 i.exchange ASC, i.ticker ASC
        LIMIT ?2`,
      ownerId,
      ACCOUNT_DATA_EXPORT_LIMITS.alertDeliveries,
    ),
    totalFor(database, "SELECT COUNT(*) AS total FROM ai_daily_brief_cache_entries WHERE owner_id = ?1", ownerId),
    limitedRows<ExportDailyBriefRow>(
      database,
      `SELECT brief_date AS briefDate, response_json AS responseJson,
              generated_at AS generatedAt, expires_at AS expiresAt,
              last_accessed_at AS lastAccessedAt, hit_count AS hitCount
         FROM ai_daily_brief_cache_entries
        WHERE owner_id = ?1
        ORDER BY brief_date DESC, generated_at DESC, cache_key ASC
        LIMIT ?2`,
      ownerId,
      ACCOUNT_DATA_EXPORT_LIMITS.dailyBriefs,
    ),
    firstRow<ExportAiUsageRow>(
      database,
      `SELECT COUNT(*) AS reservationCount,
              COALESCE(SUM(cost), 0) AS consumedUnits,
              COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completedCount,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failedCount,
              COALESCE(SUM(CASE WHEN status = 'reserved' THEN 1 ELSE 0 END), 0) AS reservedCount,
              MIN(day_start) AS firstDay, MAX(day_start) AS lastDay
         FROM ai_model_budget_reservations
        WHERE owner_id = ?1`,
      ownerId,
    ),
    firstRow<ExportSyncProfileRow>(
      database,
      `SELECT activated_at AS activatedAt,
              baseline_completed_at AS baselineCompletedAt,
              last_checked_at AS lastCheckedAt,
              last_successful_sync_at AS lastSuccessfulSyncAt
         FROM inbox_profiles WHERE owner_id = ?1`,
      ownerId,
    ),
    firstRow<ExportSyncGateRow>(
      database,
      `SELECT catchup_pending AS catchupPending,
              next_allowed_at AS nextAllowedAt,
              last_attempt_at AS lastAttemptAt,
              last_completed_at AS lastCompletedAt
         FROM inbox_sync_gates WHERE owner_id = ?1`,
      ownerId,
    ),
    firstRow<ExportProjectionRow>(
      database,
      `SELECT next_allowed_at AS nextAllowedAt,
              last_attempt_at AS lastAttemptAt,
              last_completed_at AS lastCompletedAt,
              consecutive_failures AS consecutiveFailures,
              updated_at AS updatedAt
         FROM inbox_projection_cursors WHERE owner_id = ?1`,
      ownerId,
    ),
  ]);

  return {
    watchlists: { total: watchlistTotal, rows: watchlistRows },
    watchlistItems: { total: watchlistItemTotal, rows: watchlistItemRows },
    portfolioProfile,
    portfolioHoldings: { total: holdingTotal, rows: holdingRows },
    inboxStates: { total: inboxStateTotal, rows: inboxStateRows },
    alertRules: { total: alertRuleTotal, rows: alertRuleRows },
    alertDeliveries: { total: alertDeliveryTotal, rows: alertDeliveryRows },
    dailyBriefs: { total: dailyBriefTotal, rows: dailyBriefRows },
    aiUsage: aiUsage ?? {
      reservationCount: 0,
      consumedUnits: 0,
      completedCount: 0,
      failedCount: 0,
      reservedCount: 0,
      firstDay: null,
      lastDay: null,
    },
    syncProfile,
    syncGate,
    projection,
  };
}
