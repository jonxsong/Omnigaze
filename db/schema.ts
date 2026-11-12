import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const instruments = sqliteTable("instruments", {
  id: text("id").primaryKey(),
  ticker: text("ticker").notNull(),
  exchange: text("exchange").notNull(),
  name: text("name").notNull(),
  sector: text("sector"),
  currency: text("currency").notNull().default("USD"),
  status: text("status").notNull().default("active"),
  updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
});

export const watchlists = sqliteTable(
  "watchlists",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("watchlists_owner_idx").on(table.ownerId),
    uniqueIndex("watchlists_owner_default_idx")
      .on(table.ownerId)
      .where(sql`${table.isDefault} = 1`),
  ],
);

export const watchlistItems = sqliteTable(
  "watchlist_items",
  {
    watchlistId: text("watchlist_id")
      .notNull()
      .references(() => watchlists.id, { onDelete: "cascade" }),
    symbolId: text("symbol_id")
      .notNull()
      .references(() => instruments.id),
    note: text("note"),
    addedAt: text("added_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    primaryKey({ columns: [table.watchlistId, table.symbolId] }),
    index("watchlist_items_symbol_idx").on(table.symbolId),
  ],
);

export const portfolioProfiles = sqliteTable(
  "portfolio_profiles",
  {
    ownerId: text("owner_id").primaryKey(),
    baseCurrency: text("base_currency").notNull().default("USD"),
    experienceLevel: text("experience_level").notNull().default("unspecified"),
    riskComfort: text("risk_comfort").notNull().default("unspecified"),
    timeHorizon: text("time_horizon").notNull().default("unspecified"),
    objective: text("objective").notNull().default("unspecified"),
    maxSinglePositionBps: integer("max_single_position_bps"),
    onboardingCompletedAt: text("onboarding_completed_at"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql.raw("CURRENT_TIMESTAMP")),
    updatedAt: text("updated_at").notNull().default(sql.raw("CURRENT_TIMESTAMP")),
  },
  () => [
    check("portfolio_profiles_base_currency_check", sql.raw("base_currency = 'USD'")),
    check(
      "portfolio_profiles_experience_level_check",
      sql.raw("experience_level IN ('unspecified', 'beginner', 'intermediate', 'advanced')"),
    ),
    check(
      "portfolio_profiles_risk_comfort_check",
      sql.raw("risk_comfort IN ('unspecified', 'low', 'medium', 'high')"),
    ),
    check(
      "portfolio_profiles_time_horizon_check",
      sql.raw("time_horizon IN ('unspecified', 'under_1y', '1_to_3y', '3_to_7y', 'over_7y')"),
    ),
    check(
      "portfolio_profiles_objective_check",
      sql.raw("objective IN ('unspecified', 'capital_preservation', 'income', 'balanced_growth', 'growth', 'learning')"),
    ),
    check(
      "portfolio_profiles_max_position_check",
      sql.raw("max_single_position_bps IS NULL OR max_single_position_bps BETWEEN 100 AND 10000"),
    ),
    check("portfolio_profiles_version_check", sql.raw("version >= 1")),
  ],
);

export const portfolioHoldings = sqliteTable(
  "portfolio_holdings",
  {
    ownerId: text("owner_id").notNull(),
    symbolId: text("symbol_id")
      .notNull()
      .references(() => instruments.id),
    quantityMicros: integer("quantity_micros").notNull(),
    averageCostMicros: integer("average_cost_micros"),
    costCurrency: text("cost_currency").notNull().default("USD"),
    quantityAsOf: text("quantity_as_of").notNull(),
    entrySource: text("entry_source").notNull().default("user_entered"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql.raw("CURRENT_TIMESTAMP")),
    updatedAt: text("updated_at").notNull().default(sql.raw("CURRENT_TIMESTAMP")),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.symbolId] }),
    index("portfolio_holdings_symbol_idx").on(table.symbolId),
    check(
      "portfolio_holdings_quantity_check",
      sql.raw("quantity_micros BETWEEN 1 AND 1000000000000000"),
    ),
    check(
      "portfolio_holdings_average_cost_check",
      sql.raw("average_cost_micros IS NULL OR average_cost_micros BETWEEN 0 AND 10000000000000"),
    ),
    check("portfolio_holdings_currency_check", sql.raw("cost_currency = 'USD'")),
    check("portfolio_holdings_source_check", sql.raw("entry_source = 'user_entered'")),
    check("portfolio_holdings_version_check", sql.raw("version >= 1")),
  ],
);

export const sourceEvents = sqliteTable(
  "source_events",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    sourceKind: text("source_kind").notNull(),
    sourceEventId: text("source_event_id").notNull(),
    symbolId: text("symbol_id"),
    publishedAt: text("published_at").notNull(),
    observedAt: text("observed_at").notNull(),
    rawPayloadHash: text("raw_payload_hash").notNull(),
    rawPayload: text("raw_payload").notNull(),
    status: text("status").notNull().default("received"),
  },
  (table) => [
    uniqueIndex("source_events_identity_idx").on(
      table.source,
      table.sourceEventId,
      table.rawPayloadHash,
    ),
    index("source_events_published_idx").on(table.publishedAt),
    index("source_events_symbol_idx").on(table.symbolId),
  ],
);

export const evidence = sqliteTable(
  "evidence",
  {
    id: text("id").primaryKey(),
    sourceEventId: text("source_event_id")
      .notNull()
      .references(() => sourceEvents.id, { onDelete: "cascade" }),
    symbolId: text("symbol_id").references(() => instruments.id),
    classification: text("classification").notNull(),
    title: text("title").notNull(),
    publisher: text("publisher").notNull(),
    sourceUrl: text("source_url"),
    locator: text("locator"),
    excerpt: text("excerpt"),
    publishedAt: text("published_at").notNull(),
    observedAt: text("observed_at").notNull(),
  },
  (table) => [
    index("evidence_symbol_published_idx").on(table.symbolId, table.publishedAt),
  ],
);

export const intelligenceEvents = sqliteTable(
  "intelligence_events",
  {
    id: text("id").primaryKey(),
    symbolId: text("symbol_id")
      .notNull()
      .references(() => instruments.id),
    headline: text("headline").notNull(),
    summary: text("summary").notNull(),
    category: text("category").notNull(),
    materiality: text("materiality").notNull(),
    possibleDirection: text("possible_direction").notNull(),
    status: text("status").notNull().default("preliminary"),
    occurredAt: text("occurred_at").notNull(),
    detectedAt: text("detected_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    correctedById: text("corrected_by_id"),
  },
  (table) => [
    index("intelligence_symbol_occurred_idx").on(table.symbolId, table.occurredAt),
    index("intelligence_materiality_idx").on(table.materiality),
  ],
);

export const eventEvidence = sqliteTable(
  "event_evidence",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => intelligenceEvents.id, { onDelete: "cascade" }),
    evidenceId: text("evidence_id")
      .notNull()
      .references(() => evidence.id, { onDelete: "cascade" }),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.evidenceId] })],
);

export const omnigazeViews = sqliteTable(
  "omnigaze_views",
  {
    id: text("id").primaryKey(),
    symbolId: text("symbol_id")
      .notNull()
      .references(() => instruments.id),
    horizon: text("horizon").notNull(),
    stance: text("stance").notNull(),
    confidence: real("confidence").notNull(),
    summary: text("summary").notNull(),
    whyNow: text("why_now").notNull(),
    driversJson: text("drivers_json").notNull(),
    unknownsJson: text("unknowns_json").notNull(),
    modelVersion: text("model_version").notNull(),
    dataCutoff: text("data_cutoff").notNull(),
    generatedAt: text("generated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => [
    index("views_symbol_generated_idx").on(table.symbolId, table.generatedAt),
  ],
);

/**
 * This cache is deliberately separate from the legacy `omnigaze_views`
 * projection. A cache entry is immutable in identity (symbol + prompt version
 * + model configuration + evidence fingerprint), short lived, and contains only the validated
 * evidence-grounded response envelope. It must never contain prompts,
 * credentials, request headers, or owner-specific portfolio context.
 */
export const aiViewCacheEntries = sqliteTable(
  "ai_view_cache_entries",
  {
    cacheKey: text("cache_key").primaryKey(),
    symbolId: text("symbol_id").notNull(),
    promptVersion: text("prompt_version").notNull(),
    modelKey: text("model_key").notNull(),
    evidenceFingerprint: text("evidence_fingerprint").notNull(),
    responseJson: text("response_json").notNull(),
    generatedAt: text("generated_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastAccessedAt: text("last_accessed_at").notNull(),
    hitCount: integer("hit_count").notNull().default(0),
  },
  (table) => [
    uniqueIndex("ai_view_cache_entries_identity_idx").on(
      table.symbolId,
      table.promptVersion,
      table.modelKey,
      table.evidenceFingerprint,
    ),
    index("ai_view_cache_entries_expiry_idx").on(table.expiresAt),
    index("ai_view_cache_entries_symbol_generated_idx").on(
      table.symbolId,
      table.generatedAt,
    ),
    check(
      "ai_view_cache_entries_bounded_identity_check",
      sql.raw(
        "length(cache_key) = 64 AND length(symbol_id) BETWEEN 3 AND 64 AND length(prompt_version) BETWEEN 1 AND 128 AND length(model_key) BETWEEN 1 AND 128 AND length(evidence_fingerprint) = 64",
      ),
    ),
    check(
      "ai_view_cache_entries_payload_check",
      sql.raw(
        "length(response_json) BETWEEN 2 AND 65536 AND json_valid(response_json)",
      ),
    ),
    check(
      "ai_view_cache_entries_time_check",
      sql.raw(
        "julianday(generated_at) IS NOT NULL AND julianday(expires_at) > julianday(generated_at) AND julianday(last_accessed_at) IS NOT NULL",
      ),
    ),
    check("ai_view_cache_entries_hit_count_check", sql.raw("hit_count >= 0")),
  ],
);

/**
 * Owner-scoped cache for the generated cross-watchlist Daily Brief. The
 * externally computed cache key commits to the prompt/model/date/watchlist/
 * evidence identity, while the composite primary key prevents one owner from
 * reading or replacing another owner's personalized entry. Only the strict
 * public response projection belongs in `response_json`.
 */
export const aiDailyBriefCacheEntries = sqliteTable(
  "ai_daily_brief_cache_entries",
  {
    ownerId: text("owner_id").notNull(),
    cacheKey: text("cache_key").notNull(),
    briefDate: text("brief_date").notNull(),
    promptVersion: text("prompt_version").notNull(),
    modelKey: text("model_key").notNull(),
    watchlistFingerprint: text("watchlist_fingerprint").notNull(),
    evidenceFingerprint: text("evidence_fingerprint").notNull(),
    responseJson: text("response_json").notNull(),
    generatedAt: text("generated_at").notNull(),
    expiresAt: text("expires_at").notNull(),
    lastAccessedAt: text("last_accessed_at").notNull(),
    hitCount: integer("hit_count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.cacheKey] }),
    uniqueIndex("ai_daily_brief_cache_entries_identity_idx").on(
      table.ownerId,
      table.briefDate,
      table.promptVersion,
      table.modelKey,
      table.watchlistFingerprint,
      table.evidenceFingerprint,
    ),
    index("ai_daily_brief_cache_entries_expiry_idx").on(table.expiresAt),
    index("ai_daily_brief_cache_entries_owner_date_idx").on(
      table.ownerId,
      table.briefDate,
      table.generatedAt,
    ),
    check(
      "ai_daily_brief_cache_entries_bounded_identity_check",
      sql.raw(
        "length(owner_id) BETWEEN 1 AND 256 AND length(cache_key) = 64 AND cache_key NOT GLOB '*[^0-9a-f]*' AND length(brief_date) = 10 AND date(brief_date) = brief_date AND length(prompt_version) BETWEEN 1 AND 128 AND length(model_key) BETWEEN 1 AND 128 AND length(watchlist_fingerprint) = 64 AND watchlist_fingerprint NOT GLOB '*[^0-9a-f]*' AND length(evidence_fingerprint) = 64 AND evidence_fingerprint NOT GLOB '*[^0-9a-f]*'",
      ),
    ),
    check(
      "ai_daily_brief_cache_entries_payload_check",
      sql.raw(
        "length(response_json) BETWEEN 2 AND 65536 AND json_valid(response_json)",
      ),
    ),
    check(
      "ai_daily_brief_cache_entries_time_check",
      sql.raw(
        "julianday(generated_at) IS NOT NULL AND julianday(expires_at) > julianday(generated_at) AND julianday(expires_at) <= julianday(generated_at) + 1 AND julianday(last_accessed_at) IS NOT NULL",
      ),
    ),
    check(
      "ai_daily_brief_cache_entries_hit_count_check",
      sql.raw("hit_count >= 0"),
    ),
  ],
);

/**
 * One row is one accepted model-generation attempt. Counting accepted rows in
 * a single INSERT ... SELECT statement makes rolling and UTC-day limits
 * atomic on SQLite/D1. Failed attempts remain in the ledger intentionally so
 * retries cannot evade a budget; exact request-key retries reuse the row.
 */
export const aiModelBudgetReservations = sqliteTable(
  "ai_model_budget_reservations",
  {
    reservationId: text("reservation_id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    requestKeyHash: text("request_key_hash").notNull(),
    operation: text("operation").notNull(),
    operationKeyHash: text("operation_key_hash").notNull(),
    cost: integer("cost").notNull().default(1),
    dayStart: text("day_start").notNull(),
    status: text("status").notNull().default("reserved"),
    reservedAt: text("reserved_at").notNull(),
    leaseExpiresAt: text("lease_expires_at").notNull(),
    completedAt: text("completed_at"),
    safeErrorCode: text("safe_error_code"),
  },
  (table) => [
    uniqueIndex("ai_model_budget_reservations_request_idx").on(
      table.ownerId,
      table.requestKeyHash,
    ),
    index("ai_model_budget_reservations_owner_day_idx").on(
      table.ownerId,
      table.dayStart,
      table.reservedAt,
    ),
    index("ai_model_budget_reservations_owner_time_idx").on(
      table.ownerId,
      table.reservedAt,
    ),
    index("ai_model_budget_reservations_active_lease_idx").on(
      table.ownerId,
      table.status,
      table.leaseExpiresAt,
    ),
    check(
      "ai_model_budget_reservations_bounded_identity_check",
      sql.raw(
        "length(reservation_id) BETWEEN 8 AND 128 AND length(owner_id) BETWEEN 1 AND 256 AND length(request_key_hash) = 64 AND operation IN ('omnigaze_view', 'daily_brief') AND length(operation_key_hash) = 64 AND cost BETWEEN 1 AND 10 AND length(day_start) = 10",
      ),
    ),
    check(
      "ai_model_budget_reservations_status_check",
      sql.raw("status IN ('reserved', 'completed', 'failed')"),
    ),
    check(
      "ai_model_budget_reservations_time_check",
      sql.raw(
        "julianday(reserved_at) IS NOT NULL AND julianday(lease_expires_at) > julianday(reserved_at) AND (completed_at IS NULL OR julianday(completed_at) >= julianday(reserved_at))",
      ),
    ),
    check(
      "ai_model_budget_reservations_terminal_check",
      sql.raw(
        "(status = 'reserved' AND completed_at IS NULL AND safe_error_code IS NULL) OR (status = 'completed' AND completed_at IS NOT NULL AND safe_error_code IS NULL) OR (status = 'failed' AND completed_at IS NOT NULL AND length(safe_error_code) BETWEEN 1 AND 64)",
      ),
    ),
  ],
);

export const inboxEvents = sqliteTable(
  "inbox_events",
  {
    id: text("id").primaryKey(),
    source: text("source").notNull(),
    providerEventKey: text("provider_event_key").notNull(),
    sourceKind: text("source_kind").notNull(),
    headline: text("headline").notNull(),
    summary: text("summary"),
    publishedAt: text("published_at").notNull(),
    receivedAt: text("received_at").notNull(),
    providerRevisionAt: text("provider_revision_at").notNull(),
    sourceUrl: text("source_url"),
    materiality: text("materiality").notNull(),
    category: text("category"),
    claimStatus: text("claim_status"),
    causalLink: text("causal_link"),
    topicTagsJson: text("topic_tags_json").notNull().default("[]"),
    isControversial: integer("is_controversial", { mode: "boolean" })
      .notNull()
      .default(false),
    contentHash: text("content_hash").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql.raw("CURRENT_TIMESTAMP")),
    updatedAt: text("updated_at").notNull().default(sql.raw("CURRENT_TIMESTAMP")),
  },
  (table) => [
    uniqueIndex("inbox_events_provider_key_idx").on(
      table.source,
      table.providerEventKey,
    ),
    index("inbox_events_published_idx").on(table.publishedAt),
    check(
      "inbox_events_materiality_check",
      sql.raw("materiality IN ('low', 'medium', 'high', 'critical')"),
    ),
    check("inbox_events_revision_check", sql.raw("revision >= 1")),
  ],
);

export const inboxEventSymbols = sqliteTable(
  "inbox_event_symbols",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => inboxEvents.id, { onDelete: "cascade" }),
    symbolId: text("symbol_id")
      .notNull()
      .references(() => instruments.id),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.symbolId] }),
    index("inbox_event_symbols_symbol_idx").on(table.symbolId),
  ],
);

export const inboxProfiles = sqliteTable("inbox_profiles", {
  ownerId: text("owner_id").primaryKey(),
  activatedAt: text("activated_at").notNull(),
  baselineCompletedAt: text("baseline_completed_at"),
  lastCheckedAt: text("last_checked_at").notNull(),
  lastSuccessfulSyncAt: text("last_successful_sync_at").notNull(),
});

export const inboxSyncGates = sqliteTable("inbox_sync_gates", {
  ownerId: text("owner_id").primaryKey(),
  claimToken: text("claim_token"),
  claimUntil: text("claim_until"),
  nextAllowedAt: text("next_allowed_at").notNull(),
  catchupPending: integer("catchup_pending", { mode: "boolean" })
    .notNull()
    .default(false),
  lastAttemptAt: text("last_attempt_at").notNull(),
  lastCompletedAt: text("last_completed_at"),
});

export const inboxEventStates = sqliteTable(
  "inbox_event_states",
  {
    ownerId: text("owner_id").notNull(),
    eventId: text("event_id")
      .notNull()
      .references(() => inboxEvents.id, { onDelete: "cascade" }),
    readAt: text("read_at"),
    readRevision: integer("read_revision").notNull().default(0),
    savedAt: text("saved_at"),
    dismissedAt: text("dismissed_at"),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.eventId] }),
    index("inbox_event_states_owner_seen_idx").on(
      table.ownerId,
      table.lastSeenAt,
    ),
    index("inbox_event_states_event_idx").on(table.eventId),
    check(
      "inbox_event_states_read_revision_check",
      sql.raw("read_revision >= 0"),
    ),
    check("inbox_event_states_version_check", sql.raw("version >= 1")),
  ],
);

export const alertRules = sqliteTable(
  "alert_rules",
  {
    ownerId: text("owner_id").notNull(),
    symbolId: text("symbol_id")
      .notNull()
      .references(() => instruments.id),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    minimumMateriality: text("minimum_materiality").notNull().default("high"),
    includeControversy: integer("include_controversy", { mode: "boolean" })
      .notNull()
      .default(false),
    channel: text("channel").notNull().default("in_app"),
    version: integer("version").notNull().default(1),
    createdAt: text("created_at").notNull().default(sql.raw("CURRENT_TIMESTAMP")),
    updatedAt: text("updated_at").notNull().default(sql.raw("CURRENT_TIMESTAMP")),
  },
  (table) => [
    primaryKey({ columns: [table.ownerId, table.symbolId] }),
    index("alert_rules_symbol_idx").on(table.symbolId),
    check(
      "alert_rules_materiality_check",
      sql.raw("minimum_materiality IN ('medium', 'high', 'critical')"),
    ),
    check("alert_rules_channel_check", sql.raw("channel = 'in_app'")),
    check("alert_rules_version_check", sql.raw("version >= 1")),
  ],
);

export const alertDeliveries = sqliteTable(
  "alert_deliveries",
  {
    ownerId: text("owner_id").notNull(),
    ruleSymbolId: text("rule_symbol_id")
      .notNull()
      .references(() => instruments.id),
    eventId: text("event_id")
      .notNull()
      .references(() => inboxEvents.id, { onDelete: "cascade" }),
    eventRevision: integer("event_revision").notNull(),
    channel: text("channel").notNull().default("in_app"),
    deliveredAt: text("delivered_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [
        table.ownerId,
        table.ruleSymbolId,
        table.eventId,
        table.eventRevision,
      ],
    }),
    index("alert_deliveries_owner_time_idx").on(
      table.ownerId,
      table.deliveredAt,
    ),
    index("alert_deliveries_event_idx").on(table.eventId),
    check(
      "alert_deliveries_revision_check",
      sql.raw("event_revision >= 1"),
    ),
    check("alert_deliveries_channel_check", sql.raw("channel = 'in_app'")),
  ],
);

/**
 * Global provider ingestion is deliberately owner-agnostic. These checkpoints
 * freeze one provider query window until every page in that window has been
 * durably received. A short token lease lets any trigger (scheduled or
 * request-driven) resume the same partition without making the cursor itself a
 * lock.
 */
export const providerIngestionCheckpoints = sqliteTable(
  "provider_ingestion_checkpoints",
  {
    provider: text("provider").notNull(),
    partitionKey: text("partition_key").notNull(),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    windowStart: text("window_start"),
    windowEnd: text("window_end"),
    windowFingerprint: text("window_fingerprint"),
    resumeCursor: text("resume_cursor"),
    highWaterMark: text("high_water_mark"),
    nextDueAt: text("next_due_at").notNull(),
    lastAttemptAt: text("last_attempt_at"),
    lastSuccessAt: text("last_success_at"),
    lastFailureAt: text("last_failure_at"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    totalSuccesses: integer("total_successes").notNull().default(0),
    totalFailures: integer("total_failures").notNull().default(0),
    createdAt: text("created_at").notNull().default(sql.raw("CURRENT_TIMESTAMP")),
    updatedAt: text("updated_at").notNull().default(sql.raw("CURRENT_TIMESTAMP")),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.partitionKey] }),
    index("provider_ingestion_checkpoints_due_idx").on(
      table.provider,
      table.nextDueAt,
    ),
    index("provider_ingestion_checkpoints_lease_idx").on(table.leaseExpiresAt),
    check(
      "provider_ingestion_checkpoints_lease_check",
      sql.raw(
        "(lease_token IS NULL AND lease_expires_at IS NULL) OR (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)",
      ),
    ),
    check(
      "provider_ingestion_checkpoints_window_check",
      sql.raw(
        "(window_start IS NULL AND window_end IS NULL AND window_fingerprint IS NULL) OR (window_start IS NOT NULL AND window_end IS NOT NULL AND window_fingerprint IS NOT NULL)",
      ),
    ),
    check(
      "provider_ingestion_checkpoints_counter_check",
      sql.raw(
        "consecutive_failures >= 0 AND total_successes >= 0 AND total_failures >= 0",
      ),
    ),
  ],
);

export const providerIngestionRuns = sqliteTable(
  "provider_ingestion_runs",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    partitionKey: text("partition_key").notNull(),
    leaseToken: text("lease_token").notNull(),
    windowStart: text("window_start").notNull(),
    windowEnd: text("window_end").notNull(),
    windowFingerprint: text("window_fingerprint").notNull(),
    resumeCursorStart: text("resume_cursor_start"),
    resumeCursorEnd: text("resume_cursor_end"),
    highWaterMark: text("high_water_mark"),
    pageFingerprint: text("page_fingerprint"),
    pagePersistedAt: text("page_persisted_at"),
    status: text("status").notNull().default("running"),
    receiptCount: integer("receipt_count").notNull().default(0),
    insertedReceiptCount: integer("inserted_receipt_count").notNull().default(0),
    symbolLinkCount: integer("symbol_link_count").notNull().default(0),
    errorCount: integer("error_count").notNull().default(0),
    startedAt: text("started_at").notNull(),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("provider_ingestion_runs_lease_idx").on(
      table.provider,
      table.partitionKey,
      table.leaseToken,
    ),
    index("provider_ingestion_runs_partition_time_idx").on(
      table.provider,
      table.partitionKey,
      table.startedAt,
    ),
    index("provider_ingestion_runs_status_time_idx").on(
      table.status,
      table.startedAt,
    ),
    check(
      "provider_ingestion_runs_status_check",
      sql.raw("status IN ('running', 'succeeded', 'failed')"),
    ),
    check(
      "provider_ingestion_runs_counter_check",
      sql.raw(
        "receipt_count >= 0 AND inserted_receipt_count >= 0 AND symbol_link_count >= 0 AND error_count >= 0",
      ),
    ),
    check(
      "provider_ingestion_runs_completion_check",
      sql.raw(
        "(status = 'running' AND completed_at IS NULL) OR (status IN ('succeeded', 'failed') AND completed_at IS NOT NULL)",
      ),
    ),
    check(
      "provider_ingestion_runs_page_check",
      sql.raw(
        "(page_fingerprint IS NULL AND page_persisted_at IS NULL) OR (page_fingerprint IS NOT NULL AND page_persisted_at IS NOT NULL)",
      ),
    ),
  ],
);

export const providerIngestionRunErrors = sqliteTable(
  "provider_ingestion_run_errors",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => providerIngestionRuns.id, { onDelete: "cascade" }),
    code: text("code").notNull(),
    stage: text("stage").notNull(),
    safeMessage: text("safe_message").notNull(),
    retryable: integer("retryable", { mode: "boolean" }).notNull().default(false),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [
    index("provider_ingestion_run_errors_run_idx").on(table.runId),
    index("provider_ingestion_run_errors_time_idx").on(table.occurredAt),
    check(
      "provider_ingestion_run_errors_bounded_text_check",
      sql.raw(
        "length(code) BETWEEN 1 AND 64 AND length(stage) BETWEEN 1 AND 64 AND length(safe_message) BETWEEN 1 AND 300",
      ),
    ),
  ],
);

/**
 * One global row gates every automated SEC request across Worker isolates.
 * D1's clock is authoritative; no owner, symbol, URL, or contact identity is
 * retained in this operational control plane.
 */
export const secFairAccessControl = sqliteTable(
  "sec_fair_access_control",
  {
    provider: text("provider").primaryKey(),
    nextAdmissionAtMs: integer("next_admission_at_ms").notNull().default(0),
    cooldownUntilMs: integer("cooldown_until_ms").notNull().default(0),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  () => [
    check(
      "sec_fair_access_control_provider_check",
      sql.raw("provider = 'sec-edgar'"),
    ),
    check(
      "sec_fair_access_control_time_check",
      sql.raw(
        "next_admission_at_ms >= 0 AND cooldown_until_ms >= 0 AND julianday(updated_at) IS NOT NULL",
      ),
    ),
  ],
);

/**
 * `source_events.symbol_id` predates multi-symbol provider events. Keep that
 * column untouched and add a monotonic many-to-many mapping for new ingestion.
 */
export const sourceEventSymbols = sqliteTable(
  "source_event_symbols",
  {
    sourceEventId: text("source_event_id")
      .notNull()
      .references(() => sourceEvents.id, { onDelete: "cascade" }),
    symbolId: text("symbol_id")
      .notNull()
      .references(() => instruments.id),
  },
  (table) => [
    primaryKey({ columns: [table.sourceEventId, table.symbolId] }),
    index("source_event_symbols_symbol_idx").on(table.symbolId),
  ],
);

/**
 * Operational receipt metadata lives beside immutable raw source-event
 * versions, avoiding an ALTER of the already-shipped source_events table.
 */
export const sourceEventIngestionMetadata = sqliteTable(
  "source_event_ingestion_metadata",
  {
    sourceEventId: text("source_event_id")
      .notNull()
      .references(() => sourceEvents.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    partitionKey: text("partition_key").notNull(),
    payloadPolicy: text("payload_policy").notNull(),
    providerRevisionAt: text("provider_revision_at"),
    firstIngestionRunId: text("first_ingestion_run_id").references(
      () => providerIngestionRuns.id,
      { onDelete: "set null" },
    ),
    lastIngestionRunId: text("last_ingestion_run_id").references(
      () => providerIngestionRuns.id,
      { onDelete: "set null" },
    ),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    seenCount: integer("seen_count").notNull().default(1),
  },
  (table) => [
    primaryKey({
      columns: [table.sourceEventId, table.provider, table.partitionKey],
    }),
    index("source_event_ingestion_metadata_partition_idx").on(
      table.provider,
      table.partitionKey,
      table.lastSeenAt,
    ),
    index("source_event_ingestion_metadata_last_run_idx").on(
      table.lastIngestionRunId,
    ),
    check(
      "source_event_ingestion_metadata_seen_count_check",
      sql.raw("seen_count >= 1"),
    ),
    check(
      "source_event_ingestion_metadata_payload_policy_check",
      sql.raw("payload_policy = 'minimal_redacted_v1'"),
    ),
  ],
);
