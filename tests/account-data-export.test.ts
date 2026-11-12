import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  ACCOUNT_DATA_EXPORT_SCHEMA_VERSION,
  parseAccountDataExportRequest,
} from "@/lib/account-data-export";
import {
  readOwnerSavedData,
  type AccountSavedDataSource,
} from "@/lib/repositories/account-data-export";
import { buildAccountSavedDataSnapshot } from "@/lib/services/account-data-export";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const NOW = "2026-11-12T20:30:00.000Z";

function emptySource(
  overrides: Partial<AccountSavedDataSource> = {},
): AccountSavedDataSource {
  return {
    watchlists: { total: 0, rows: [] },
    watchlistItems: { total: 0, rows: [] },
    portfolioProfile: null,
    portfolioHoldings: { total: 0, rows: [] },
    inboxStates: { total: 0, rows: [] },
    alertRules: { total: 0, rows: [] },
    alertDeliveries: { total: 0, rows: [] },
    dailyBriefs: { total: 0, rows: [] },
    aiUsage: {
      reservationCount: 0,
      consumedUnits: 0,
      completedCount: 0,
      failedCount: 0,
      reservedCount: 0,
      firstDay: null,
      lastDay: null,
    },
    syncProfile: null,
    syncGate: null,
    projection: null,
    ...overrides,
  };
}

const nvda = {
  instrumentId: "NASDAQ:NVDA",
  ticker: "NVDA",
  exchange: "NASDAQ",
  instrumentName: "NVIDIA Corporation",
  sector: "Technology",
  currency: "USD",
  instrumentStatus: "active",
};

const aapl = {
  instrumentId: "NASDAQ:AAPL",
  ticker: "AAPL",
  exchange: "NASDAQ",
  instrumentName: "Apple Inc.",
  sector: "Technology",
  currency: "USD",
  instrumentStatus: "active",
};

function permuted<T>(rows: T[], reverse: boolean) {
  return reverse ? [...rows].reverse() : rows;
}

function dailyBriefResponse(
  briefDate: string,
  headline: string,
  instrumentId: string,
) {
  return JSON.stringify({
    data: {
      headline,
      summary: `${headline} summary`,
      briefDate,
      window: {
        since: `${briefDate}T00:00:00.000Z`,
        through: `${briefDate}T20:00:00.000Z`,
      },
      developments: [{
        title: `${headline} development`,
        whyItMatters: `${headline} matters`,
        direction: "mixed",
        symbolIds: [instrumentId],
      }],
      watchNext: [`${headline} next`],
      unknowns: [`${headline} unknown`],
    },
  });
}

function deterministicSource(reverse: boolean): AccountSavedDataSource {
  const watchlists = [
    {
      watchlistId: "watchlist-z",
      name: "Zulu",
      isDefault: 0,
      createdAt: "2026-11-10T00:00:00.000Z",
      updatedAt: "2026-11-10T00:00:00.000Z",
    },
    {
      watchlistId: "watchlist-a",
      name: "Alpha",
      isDefault: 1,
      createdAt: "2026-11-11T00:00:00.000Z",
      updatedAt: "2026-11-11T00:00:00.000Z",
    },
  ];
  const watchlistItems = [
    {
      ...nvda,
      watchlistId: "watchlist-z",
      watchlistName: "Zulu",
      note: "NVDA note",
      addedAt: "2026-11-10T01:00:00.000Z",
    },
    {
      ...aapl,
      watchlistId: "watchlist-a",
      watchlistName: "Alpha",
      note: "AAPL note",
      addedAt: "2026-11-11T01:00:00.000Z",
    },
  ];
  const holdings = [
    {
      ...nvda,
      quantityMicros: 2_000_000,
      averageCostMicros: 120_000_000,
      costCurrency: "USD",
      quantityAsOf: "2026-11-12T10:00:00.000Z",
      entrySource: "user_entered",
      version: 1,
      createdAt: "2026-11-10T02:00:00.000Z",
      updatedAt: "2026-11-10T02:00:00.000Z",
    },
    {
      ...aapl,
      quantityMicros: 3_500_000,
      averageCostMicros: 200_250_000,
      costCurrency: "USD",
      quantityAsOf: "2026-11-12T11:00:00.000Z",
      entrySource: "user_entered",
      version: 2,
      createdAt: "2026-11-11T02:00:00.000Z",
      updatedAt: "2026-11-11T02:00:00.000Z",
    },
  ];
  const inboxStates = [
    {
      eventId: "event-old",
      source: "source-old",
      sourceKind: "news",
      headline: "Older event",
      summary: "Older summary",
      publishedAt: "2026-11-11T08:00:00.000Z",
      receivedAt: "2026-11-11T08:01:00.000Z",
      sourceUrl: "https://example.test/old",
      materiality: "medium",
      category: "earnings",
      claimStatus: "confirmed",
      causalLink: "direct",
      topicTagsJson: '["zeta","alpha"]',
      isControversial: 0,
      eventRevision: 1,
      readAt: null,
      readRevision: 0,
      savedAt: null,
      dismissedAt: null,
      firstSeenAt: "2026-11-11T08:01:00.000Z",
      lastSeenAt: "2026-11-11T08:02:00.000Z",
      stateVersion: 1,
    },
    {
      eventId: "event-new",
      source: "source-new",
      sourceKind: "filing",
      headline: "Newer event",
      summary: "Newer summary",
      publishedAt: "2026-11-12T08:00:00.000Z",
      receivedAt: "2026-11-12T08:01:00.000Z",
      sourceUrl: "https://example.test/new",
      materiality: "high",
      category: "legal",
      claimStatus: "reported",
      causalLink: "possible",
      topicTagsJson: '["beta","alpha"]',
      isControversial: 1,
      eventRevision: 2,
      readAt: "2026-11-12T08:03:00.000Z",
      readRevision: 2,
      savedAt: "2026-11-12T08:04:00.000Z",
      dismissedAt: null,
      firstSeenAt: "2026-11-12T08:01:00.000Z",
      lastSeenAt: "2026-11-12T08:05:00.000Z",
      stateVersion: 2,
    },
  ];
  const alertRules = [
    {
      ...nvda,
      enabled: 1,
      minimumMateriality: "high",
      includeControversy: 1,
      channel: "in_app",
      version: 2,
      createdAt: "2026-11-10T03:00:00.000Z",
      updatedAt: "2026-11-10T03:00:00.000Z",
    },
    {
      ...aapl,
      enabled: 0,
      minimumMateriality: "critical",
      includeControversy: 0,
      channel: "in_app",
      version: 1,
      createdAt: "2026-11-11T03:00:00.000Z",
      updatedAt: "2026-11-11T03:00:00.000Z",
    },
  ];
  const deliveries = [
    {
      ...nvda,
      eventId: "event-old",
      eventRevision: 1,
      channel: "in_app",
      deliveredAt: "2026-11-11T09:00:00.000Z",
      eventHeadline: "Older event",
      eventSource: "source-old",
      eventSourceKind: "news",
      eventPublishedAt: "2026-11-11T08:00:00.000Z",
      eventMateriality: "medium",
      eventIsControversial: 0,
    },
    {
      ...aapl,
      eventId: "event-new",
      eventRevision: 2,
      channel: "in_app",
      deliveredAt: "2026-11-12T09:00:00.000Z",
      eventHeadline: "Newer event",
      eventSource: "source-new",
      eventSourceKind: "filing",
      eventPublishedAt: "2026-11-12T08:00:00.000Z",
      eventMateriality: "high",
      eventIsControversial: 1,
    },
  ];
  const dailyBriefs = [
    {
      briefDate: "2026-11-11",
      responseJson: dailyBriefResponse(
        "2026-11-11",
        "Older brief",
        nvda.instrumentId,
      ),
      generatedAt: "2026-11-11T20:00:00.000Z",
      expiresAt: "2026-11-12T00:00:00.000Z",
      lastAccessedAt: "2026-11-11T20:01:00.000Z",
      hitCount: 1,
    },
    {
      briefDate: "2026-11-12",
      responseJson: dailyBriefResponse(
        "2026-11-12",
        "Newer brief",
        aapl.instrumentId,
      ),
      generatedAt: "2026-11-12T20:00:00.000Z",
      expiresAt: "2026-11-13T00:00:00.000Z",
      lastAccessedAt: "2026-11-12T20:01:00.000Z",
      hitCount: 2,
    },
  ];

  return emptySource({
    watchlists: { total: 2, rows: permuted(watchlists, reverse) },
    watchlistItems: { total: 2, rows: permuted(watchlistItems, reverse) },
    portfolioProfile: {
      baseCurrency: "USD",
      experienceLevel: "advanced",
      riskComfort: "medium",
      timeHorizon: "3_to_7y",
      objective: "growth",
      maxSinglePositionBps: 2_500,
      onboardingCompletedAt: "2026-11-01T00:00:00.000Z",
      version: 2,
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-02T00:00:00.000Z",
    },
    portfolioHoldings: { total: 2, rows: permuted(holdings, reverse) },
    inboxStates: { total: 2, rows: permuted(inboxStates, reverse) },
    alertRules: { total: 2, rows: permuted(alertRules, reverse) },
    alertDeliveries: { total: 2, rows: permuted(deliveries, reverse) },
    dailyBriefs: { total: 2, rows: permuted(dailyBriefs, reverse) },
    aiUsage: {
      reservationCount: 2,
      consumedUnits: 3,
      completedCount: 1,
      failedCount: 1,
      reservedCount: 0,
      firstDay: "2026-11-11",
      lastDay: "2026-11-12",
    },
    syncProfile: {
      activatedAt: "2026-11-01T00:00:00.000Z",
      baselineCompletedAt: "2026-11-01T00:05:00.000Z",
      lastCheckedAt: "2026-11-12T19:00:00.000Z",
      lastSuccessfulSyncAt: "2026-11-12T18:59:00.000Z",
    },
    syncGate: {
      catchupPending: 0,
      nextAllowedAt: "2026-11-12T19:10:00.000Z",
      lastAttemptAt: "2026-11-12T19:00:00.000Z",
      lastCompletedAt: "2026-11-12T19:01:00.000Z",
    },
    projection: {
      nextAllowedAt: "2026-11-12T19:20:00.000Z",
      lastAttemptAt: "2026-11-12T19:10:00.000Z",
      lastCompletedAt: "2026-11-12T19:11:00.000Z",
      consecutiveFailures: 0,
      updatedAt: "2026-11-12T19:12:00.000Z",
    },
  });
}

describe("saved-data snapshot contract and service", () => {
  it("accepts only the exact dependency-free JSON request contract", () => {
    expect(parseAccountDataExportRequest({ format: "json" })).toEqual({
      success: true,
      data: { format: "json" },
    });
    for (const value of [
      null,
      [],
      {},
      { format: "csv" },
      { format: "json", ownerId: "owner-b" },
      { format: "json", includeRawPayloads: true },
    ]) {
      expect(parseAccountDataExportRequest(value)).toEqual({ success: false });
    }
  });

  it("projects a deterministic, redacted, bounded snapshot with decimal strings", async () => {
    const read = vi.fn(async () =>
      emptySource({
        watchlists: {
          total: 3,
          rows: [
            {
              watchlistId: "wl-z",
              name: "Zulu",
              isDefault: 0,
              createdAt: NOW,
              updatedAt: NOW,
            },
            {
              watchlistId: "wl-a",
              name: "Alpha",
              isDefault: 1,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
        },
        watchlistItems: {
          total: 1,
          rows: [{
            ...nvda,
            watchlistId: "wl-a",
            watchlistName: "Alpha",
            note: "Core holding",
            addedAt: NOW,
          }],
        },
        portfolioHoldings: {
          total: 1,
          rows: [{
            ...nvda,
            quantityMicros: 15_250_000,
            averageCostMicros: 123_456_789,
            costCurrency: "USD",
            quantityAsOf: NOW,
            entrySource: "user_entered",
            version: 2,
            createdAt: NOW,
            updatedAt: NOW,
          }],
        },
        dailyBriefs: {
          total: 1,
          rows: [{
            briefDate: "2026-11-12",
            responseJson: JSON.stringify({
              data: {
                headline: "Semiconductors in focus",
                summary: "A concise owner-facing summary.",
                briefDate: "2026-11-12",
                window: {
                  since: "2026-11-11T20:30:00.000Z",
                  through: NOW,
                },
                developments: [{
                  title: "NVIDIA update",
                  whyItMatters: "It may affect sentiment.",
                  direction: "mixed",
                  symbolIds: ["NASDAQ:NVDA"],
                  evidenceIds: ["shared-evidence-secret"],
                }],
                watchNext: ["Watch the filing."],
                unknowns: ["Timing remains uncertain."],
              },
              meta: {
                prompt: "never export this prompt",
                rawProviderPayload: "never export this payload",
                evidenceFingerprint: "never-export-this-hash",
              },
            }),
            generatedAt: NOW,
            expiresAt: "2026-11-13T00:30:00.000Z",
            lastAccessedAt: NOW,
            hitCount: 2,
          }],
        },
        aiUsage: {
          reservationCount: 4,
          consumedUnits: 5,
          completedCount: 3,
          failedCount: 1,
          reservedCount: 0,
          firstDay: "2026-11-10",
          lastDay: "2026-11-12",
        },
      }),
    );

    const snapshot = await buildAccountSavedDataSnapshot("owner-a", {
      readOwnerSavedData: read,
      now: () => new Date(NOW),
    });
    const serialized = JSON.stringify(snapshot);

    expect(read).toHaveBeenCalledWith("owner-a");
    expect(snapshot.schemaVersion).toBe(ACCOUNT_DATA_EXPORT_SCHEMA_VERSION);
    expect(snapshot.snapshotType).toBe("omnigaze-saved-data-snapshot");
    expect(snapshot.sections.watchlists.meta).toEqual({
      total: 3,
      exported: 2,
      truncated: true,
      limit: 50,
    });
    expect(snapshot.sections.watchlists.records.map((row) => row.name)).toEqual([
      "Alpha",
      "Zulu",
    ]);
    expect(snapshot.sections.watchlistItems.records[0]?.instrument).toEqual({
      id: "NASDAQ:NVDA",
      ticker: "NVDA",
      exchange: "NASDAQ",
      name: "NVIDIA Corporation",
      sector: "Technology",
      currency: "USD",
      status: "active",
    });
    expect(snapshot.sections.portfolioHoldings.records[0]).toMatchObject({
      quantity: "15.25",
      averageCost: "123.456789",
    });
    expect(snapshot.sections.dailyBriefs.records[0]?.content.developments[0])
      .toEqual({
        title: "NVIDIA update",
        whyItMatters: "It may affect sentiment.",
        direction: "mixed",
        instrumentIds: ["NASDAQ:NVDA"],
      });
    expect(serialized).not.toContain("owner-a");
    expect(serialized).not.toContain("shared-evidence-secret");
    expect(serialized).not.toContain("never export this prompt");
    expect(serialized).not.toContain("never export this payload");
    expect(serialized).not.toContain("never-export-this-hash");
  });

  it("produces byte-stable full-section ordering from permuted source rows", async () => {
    const normal = await buildAccountSavedDataSnapshot("owner-a", {
      readOwnerSavedData: async () => deterministicSource(false),
      now: () => new Date(NOW),
    });
    const reversed = await buildAccountSavedDataSnapshot("owner-a", {
      readOwnerSavedData: async () => deterministicSource(true),
      now: () => new Date(NOW),
    });

    expect(JSON.stringify(reversed)).toBe(JSON.stringify(normal));
    expect(normal.sections.watchlists.records.map((row) => row.name)).toEqual([
      "Alpha",
      "Zulu",
    ]);
    expect(
      normal.sections.watchlistItems.records.map(
        (row) => `${row.watchlist.name}:${row.instrument.ticker}`,
      ),
    ).toEqual(["Alpha:AAPL", "Zulu:NVDA"]);
    expect(
      normal.sections.portfolioHoldings.records.map(
        (row) => row.instrument.ticker,
      ),
    ).toEqual(["AAPL", "NVDA"]);
    expect(normal.sections.inboxStates.records.map((row) => row.event.id))
      .toEqual(["event-new", "event-old"]);
    expect(normal.sections.alertRules.records.map((row) => row.instrument.ticker))
      .toEqual(["AAPL", "NVDA"]);
    expect(normal.sections.alertDeliveries.records.map((row) => row.event.id))
      .toEqual(["event-new", "event-old"]);
    expect(normal.sections.dailyBriefs.records.map((row) => row.briefDate))
      .toEqual(["2026-11-12", "2026-11-11"]);
    expect(normal.sections.syncSummary.records).toHaveLength(1);
    expect(normal.sections.aiUsageSummary.records).toHaveLength(1);
  });

  it("fails closed instead of exporting malformed cached or count data", async () => {
    await expect(
      buildAccountSavedDataSnapshot("owner-a", {
        readOwnerSavedData: async () =>
          emptySource({
            dailyBriefs: {
              total: 1,
              rows: [{
                briefDate: "2026-11-12",
                responseJson: "not-json",
                generatedAt: NOW,
                expiresAt: NOW,
                lastAccessedAt: NOW,
                hitCount: 0,
              }],
            },
          }),
        now: () => new Date(NOW),
      }),
    ).rejects.toThrow("Invalid Daily Brief record");

    await expect(
      buildAccountSavedDataSnapshot("owner-a", {
        readOwnerSavedData: async () =>
          emptySource({ watchlists: { total: 0, rows: [{
            watchlistId: "wl-1",
            name: "Impossible",
            isDefault: 0,
            createdAt: NOW,
            updatedAt: NOW,
          }] } }),
        now: () => new Date(NOW),
      }),
    ).rejects.toThrow("Invalid saved-data section");
  });
});

function migrationSql(name: string) {
  return readFileSync(resolve(process.cwd(), "drizzle", name), "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
}

function d1Adapter(sqlite: DatabaseSync) {
  return {
    prepare(query: string) {
      let values: SQLInputValue[] = [];
      const parameterIndexes: number[] = [];
      const sqliteQuery = query.replace(/\?([1-9]\d*)/g, (_match, index: string) => {
        parameterIndexes.push(Number(index) - 1);
        return "?";
      });
      const sqliteValues = () =>
        parameterIndexes.length === 0
          ? values
          : parameterIndexes.map((index) => {
              if (index >= values.length) {
                throw new Error("Missing D1 adapter binding.");
              }
              return values[index]!;
            });
      const prepared = {
        bind(...next: SQLInputValue[]) {
          values = next;
          return prepared;
        },
        async first<T>() {
          return (sqlite.prepare(sqliteQuery).get(...sqliteValues()) ??
            null) as T | null;
        },
        async all<T>() {
          return {
            results: sqlite.prepare(sqliteQuery).all(...sqliteValues()) as T[],
          };
        },
      };
      return prepared;
    },
  };
}

describe("saved-data snapshot repository isolation", () => {
  it("uses the authenticated owner predicate for every personal read", async () => {
    const sqlite = new DatabaseSync(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON");
    for (const migration of [
      "0000_damp_robbie_robertson.sql",
      "0001_thick_reptil.sql",
      "0002_portfolio_v1.sql",
      "0003_intelligence_inbox_v1.sql",
      "0004_ingestion_control_plane_v1.sql",
      "0005_ai_guardrails_v1.sql",
      "0006_daily_brief_guardrails_v1.sql",
      "0007_sec_fair_access_v1.sql",
      "0008_inbox_projection_cursor_v1.sql",
    ]) {
      sqlite.exec(migrationSql(migration));
    }
    const insertInstrument = sqlite.prepare(
      `INSERT INTO instruments (id, ticker, exchange, name, currency)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertInstrument.run(
      "NYSE:AAA",
      "AAA",
      "NYSE",
      "Owner A instrument",
      "USD",
    );
    insertInstrument.run(
      "NYSE:BBB",
      "BBB",
      "NYSE",
      "Owner B instrument",
      "USD",
    );
    sqlite.prepare(
      `INSERT INTO watchlists (id, owner_id, name, is_default)
       VALUES (?, ?, ?, ?)`,
    ).run("wl-a", "owner-a", "Owner A only", 1);
    sqlite.prepare(
      `INSERT INTO watchlists (id, owner_id, name, is_default)
       VALUES (?, ?, ?, ?)`,
    ).run("wl-b", "owner-b", "Owner B secret", 1);
    sqlite.prepare(
      `INSERT INTO watchlist_items (watchlist_id, symbol_id, note)
       VALUES (?, ?, ?)`,
    ).run("wl-a", "NYSE:AAA", "Owner A item note");
    sqlite.prepare(
      `INSERT INTO watchlist_items (watchlist_id, symbol_id, note)
       VALUES (?, ?, ?)`,
    ).run("wl-b", "NYSE:BBB", "Owner B item note");
    sqlite.prepare(
      `INSERT INTO portfolio_profiles (owner_id, objective)
       VALUES (?, ?)`,
    ).run("owner-a", "growth");
    sqlite.prepare(
      `INSERT INTO portfolio_profiles (owner_id, objective)
       VALUES (?, ?)`,
    ).run("owner-b", "income");

    const insertHolding = sqlite.prepare(
      `INSERT INTO portfolio_holdings
         (owner_id, symbol_id, quantity_micros, average_cost_micros,
          quantity_as_of, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    insertHolding.run(
      "owner-a",
      "NYSE:AAA",
      1_250_000,
      10_500_000,
      "2026-11-12T10:00:00.000Z",
      "2026-11-12T10:01:00.000Z",
    );
    insertHolding.run(
      "owner-b",
      "NYSE:BBB",
      9_750_000,
      88_250_000,
      "2026-11-12T11:00:00.000Z",
      "2026-11-12T11:01:00.000Z",
    );

    const insertEvent = sqlite.prepare(
      `INSERT INTO inbox_events
         (id, source, provider_event_key, source_kind, headline, summary,
          published_at, received_at, provider_revision_at, source_url,
          materiality, category, claim_status, causal_link, topic_tags_json,
          is_controversial, content_hash, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertEvent.run(
      "event-owner-a",
      "owner-a-source",
      "provider-owner-a",
      "news",
      "Owner A event headline",
      "Owner A event summary",
      "2026-11-12T12:00:00.000Z",
      "2026-11-12T12:01:00.000Z",
      "2026-11-12T12:00:30.000Z",
      "https://example.test/owner-a",
      "high",
      "earnings",
      "confirmed",
      "direct",
      '["owner-a-topic"]',
      0,
      "a".repeat(64),
      2,
    );
    insertEvent.run(
      "event-owner-b",
      "owner-b-source",
      "provider-owner-b",
      "filing",
      "Owner B event headline",
      "Owner B event summary",
      "2026-11-12T13:00:00.000Z",
      "2026-11-12T13:01:00.000Z",
      "2026-11-12T13:00:30.000Z",
      "https://example.test/owner-b",
      "critical",
      "legal",
      "reported",
      "possible",
      '["owner-b-topic"]',
      1,
      "b".repeat(64),
      3,
    );

    const insertEventState = sqlite.prepare(
      `INSERT INTO inbox_event_states
         (owner_id, event_id, read_at, read_revision, saved_at,
          first_seen_at, last_seen_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertEventState.run(
      "owner-a",
      "event-owner-a",
      "2026-11-12T12:03:00.000Z",
      2,
      "2026-11-12T12:04:00.000Z",
      "2026-11-12T12:01:00.000Z",
      "2026-11-12T12:05:00.000Z",
      4,
    );
    insertEventState.run(
      "owner-b",
      "event-owner-b",
      null,
      0,
      "2026-11-12T13:04:00.000Z",
      "2026-11-12T13:01:00.000Z",
      "2026-11-12T13:05:00.000Z",
      5,
    );

    const insertAlertRule = sqlite.prepare(
      `INSERT INTO alert_rules
         (owner_id, symbol_id, enabled, minimum_materiality,
          include_controversy, version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertAlertRule.run(
      "owner-a",
      "NYSE:AAA",
      1,
      "high",
      0,
      2,
      "2026-11-12T14:00:00.000Z",
    );
    insertAlertRule.run(
      "owner-b",
      "NYSE:BBB",
      1,
      "critical",
      1,
      3,
      "2026-11-12T15:00:00.000Z",
    );

    const insertDelivery = sqlite.prepare(
      `INSERT INTO alert_deliveries
         (owner_id, rule_symbol_id, event_id, event_revision, delivered_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertDelivery.run(
      "owner-a",
      "NYSE:AAA",
      "event-owner-a",
      2,
      "2026-11-12T14:05:00.000Z",
    );
    insertDelivery.run(
      "owner-b",
      "NYSE:BBB",
      "event-owner-b",
      3,
      "2026-11-12T15:05:00.000Z",
    );

    const insertDailyBrief = sqlite.prepare(
      `INSERT INTO ai_daily_brief_cache_entries
         (owner_id, cache_key, brief_date, prompt_version, model_key,
          watchlist_fingerprint, evidence_fingerprint, response_json,
          generated_at, expires_at, last_accessed_at, hit_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertDailyBrief.run(
      "owner-a",
      "a".repeat(64),
      "2026-11-12",
      "daily-brief-owner-a",
      "model-a",
      "c".repeat(64),
      "d".repeat(64),
      JSON.stringify({ data: { headline: "Owner A Daily Brief" } }),
      "2026-11-12T16:00:00.000Z",
      "2026-11-12T20:00:00.000Z",
      "2026-11-12T16:05:00.000Z",
      2,
    );
    insertDailyBrief.run(
      "owner-b",
      "b".repeat(64),
      "2026-11-12",
      "daily-brief-owner-b",
      "model-b",
      "e".repeat(64),
      "f".repeat(64),
      JSON.stringify({ data: { headline: "Owner B Daily Brief" } }),
      "2026-11-12T17:00:00.000Z",
      "2026-11-12T21:00:00.000Z",
      "2026-11-12T17:05:00.000Z",
      9,
    );

    const insertBudgetReservation = sqlite.prepare(
      `INSERT INTO ai_model_budget_reservations
         (reservation_id, owner_id, request_key_hash, operation,
          operation_key_hash, cost, day_start, status, reserved_at,
          lease_expires_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertBudgetReservation.run(
      "reservation-owner-a",
      "owner-a",
      "1".repeat(64),
      "daily_brief",
      "2".repeat(64),
      2,
      "2026-11-12",
      "completed",
      "2026-11-12T18:00:00.000Z",
      "2026-11-12T18:05:00.000Z",
      "2026-11-12T18:01:00.000Z",
    );
    insertBudgetReservation.run(
      "reservation-owner-b",
      "owner-b",
      "3".repeat(64),
      "omnigaze_view",
      "4".repeat(64),
      7,
      "2026-11-11",
      "completed",
      "2026-11-11T18:00:00.000Z",
      "2026-11-11T18:05:00.000Z",
      "2026-11-11T18:01:00.000Z",
    );

    const insertInboxProfile = sqlite.prepare(
      `INSERT INTO inbox_profiles
         (owner_id, activated_at, baseline_completed_at, last_checked_at,
          last_successful_sync_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertInboxProfile.run(
      "owner-a",
      "2026-11-01T01:00:00.000Z",
      "2026-11-01T01:05:00.000Z",
      "2026-11-12T19:01:00.000Z",
      "2026-11-12T19:00:00.000Z",
    );
    insertInboxProfile.run(
      "owner-b",
      "2026-11-02T02:00:00.000Z",
      "2026-11-02T02:05:00.000Z",
      "2026-11-12T19:31:00.000Z",
      "2026-11-12T19:30:00.000Z",
    );

    const insertSyncGate = sqlite.prepare(
      `INSERT INTO inbox_sync_gates
         (owner_id, next_allowed_at, catchup_pending, last_attempt_at,
          last_completed_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insertSyncGate.run(
      "owner-a",
      "2026-11-12T19:10:00.000Z",
      0,
      "2026-11-12T19:00:00.000Z",
      "2026-11-12T19:01:00.000Z",
    );
    insertSyncGate.run(
      "owner-b",
      "2026-11-12T19:40:00.000Z",
      1,
      "2026-11-12T19:30:00.000Z",
      "2026-11-12T19:31:00.000Z",
    );

    const insertProjection = sqlite.prepare(
      `INSERT INTO inbox_projection_cursors
         (owner_id, last_sequence, next_allowed_at, last_attempt_at,
          last_completed_at, consecutive_failures, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    insertProjection.run(
      "owner-a",
      11,
      "2026-11-12T19:20:00.000Z",
      "2026-11-12T19:10:00.000Z",
      "2026-11-12T19:11:00.000Z",
      1,
      "2026-11-12T19:12:00.000Z",
    );
    insertProjection.run(
      "owner-b",
      99,
      "2026-11-12T19:50:00.000Z",
      "2026-11-12T19:40:00.000Z",
      "2026-11-12T19:41:00.000Z",
      9,
      "2026-11-12T19:42:00.000Z",
    );

    const database = d1Adapter(sqlite);
    const ownerA = await readOwnerSavedData(
      "owner-a",
      () => database as unknown as D1Database,
    );
    const ownerB = await readOwnerSavedData(
      "owner-b",
      () => database as unknown as D1Database,
    );

    expect(ownerA.watchlists.rows.map((row) => row.name)).toEqual([
      "Owner A only",
    ]);
    expect(ownerA.watchlistItems.rows.map((row) => row.note)).toEqual([
      "Owner A item note",
    ]);
    expect(ownerA.portfolioProfile?.objective).toBe("growth");
    expect(ownerA.portfolioHoldings).toMatchObject({
      total: 1,
      rows: [{ ticker: "AAA", quantityMicros: 1_250_000 }],
    });
    expect(ownerA.inboxStates).toMatchObject({
      total: 1,
      rows: [{ headline: "Owner A event headline", eventId: "event-owner-a" }],
    });
    expect(ownerA.alertRules).toMatchObject({
      total: 1,
      rows: [{ ticker: "AAA", minimumMateriality: "high" }],
    });
    expect(ownerA.alertDeliveries).toMatchObject({
      total: 1,
      rows: [{ ticker: "AAA", eventHeadline: "Owner A event headline" }],
    });
    expect(ownerA.dailyBriefs).toMatchObject({
      total: 1,
      rows: [{ hitCount: 2 }],
    });
    expect(ownerA.dailyBriefs.rows[0]?.responseJson).toContain(
      "Owner A Daily Brief",
    );
    expect(ownerA.aiUsage).toEqual({
      reservationCount: 1,
      consumedUnits: 2,
      completedCount: 1,
      failedCount: 0,
      reservedCount: 0,
      firstDay: "2026-11-12",
      lastDay: "2026-11-12",
    });
    expect(ownerA.syncProfile?.activatedAt).toBe("2026-11-01T01:00:00.000Z");
    expect(ownerA.syncGate).toMatchObject({
      catchupPending: 0,
      nextAllowedAt: "2026-11-12T19:10:00.000Z",
    });
    expect(ownerA.projection).toMatchObject({
      consecutiveFailures: 1,
      updatedAt: "2026-11-12T19:12:00.000Z",
    });
    const serializedOwnerA = JSON.stringify(ownerA);
    for (const ownerBMarker of [
      "Owner B secret",
      "Owner B item note",
      "Owner B instrument",
      "Owner B event headline",
      "Owner B event summary",
      "owner-b-topic",
      "Owner B Daily Brief",
      "event-owner-b",
      "NYSE:BBB",
    ]) {
      expect(serializedOwnerA).not.toContain(ownerBMarker);
    }
    expect(ownerB.watchlists.rows.map((row) => row.name)).toEqual([
      "Owner B secret",
    ]);
    expect(ownerB.portfolioProfile?.objective).toBe("income");
    expect(ownerB.portfolioHoldings.rows[0]?.ticker).toBe("BBB");
    expect(ownerB.inboxStates.rows[0]?.headline).toBe("Owner B event headline");
    expect(ownerB.alertRules.rows[0]?.ticker).toBe("BBB");
    expect(ownerB.alertDeliveries.rows[0]?.eventHeadline).toBe(
      "Owner B event headline",
    );
    expect(ownerB.dailyBriefs.rows[0]?.responseJson).toContain(
      "Owner B Daily Brief",
    );
    expect(ownerB.aiUsage.consumedUnits).toBe(7);
    expect(ownerB.syncProfile?.activatedAt).toBe("2026-11-02T02:00:00.000Z");
    expect(ownerB.syncGate?.catchupPending).toBe(1);
    expect(ownerB.projection?.consecutiveFailures).toBe(9);
    sqlite.close();
  });
});
