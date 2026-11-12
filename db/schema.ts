import { sql } from "drizzle-orm";
import {
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
