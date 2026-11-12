import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@/db/schema";
import {
  createIntelligenceInboxRepository,
  type IntelligenceInboxRepository,
} from "@/lib/intelligence-inbox/repository";
import type { IntelligenceFeedItem } from "@/lib/services/live-market-data";

vi.mock("cloudflare:workers", () => ({ env: {} }));

function migrationSql(name: string) {
  return readFileSync(resolve(process.cwd(), "drizzle", name), "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
}

function createTestDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  let queryHook: ((query: string, params: unknown[]) => boolean) | null = null;
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0000_damp_robbie_robertson.sql",
    "0001_thick_reptil.sql",
    "0002_portfolio_v1.sql",
    "0003_intelligence_inbox_v1.sql",
  ]) {
    sqlite.exec(migrationSql(migration));
  }

  const database = drizzle(
    async (query, params, method) => {
      if (queryHook?.(query, params)) queryHook = null;
      if (params.length > 100) {
        throw new Error(`D1 bind cap exceeded: ${params.length}`);
      }
      const statement = sqlite.prepare(query);
      if (method === "run") {
        statement.run(...params);
        return { rows: [] };
      }
      if (method === "get") {
        const row = statement.get(...params);
        return { rows: row ? [Object.values(row)] : [] };
      }
      const rows = statement.all(...params).map((row) => Object.values(row));
      return { rows };
    },
    { schema },
  );
  return {
    sqlite,
    database,
    setQueryHook(hook: (query: string, params: unknown[]) => boolean) {
      queryHook = hook;
    },
  };
}

function seedOwner(sqlite: DatabaseSync, ownerId: string) {
  sqlite
    .prepare(
      "INSERT OR IGNORE INTO instruments (id, ticker, exchange, name, sector, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run("NASDAQ:NVDA", "NVDA", "NASDAQ", "NVIDIA", "Technology", "USD", "active");
  sqlite
    .prepare(
      "INSERT INTO watchlists (id, owner_id, name, is_default) VALUES (?, ?, ?, 1)",
    )
    .run(`watchlist-${ownerId}`, ownerId, "Core holdings");
  sqlite
    .prepare(
      "INSERT INTO watchlist_items (watchlist_id, symbol_id, added_at) VALUES (?, ?, ?)",
    )
    .run(
      `watchlist-${ownerId}`,
      "NASDAQ:NVDA",
      "2026-11-12T07:00:00.000Z",
    );
}

function liveItem(
  id: string,
  overrides: Partial<IntelligenceFeedItem> = {},
): IntelligenceFeedItem {
  return {
    id,
    symbolIds: ["NASDAQ:NVDA"],
    source: "alpaca",
    sourceKind: "licensed_news",
    headline: `Headline ${id}`,
    summary: "A provider-backed market event.",
    publishedAt: "2026-11-12T08:00:00.000Z",
    receivedAt: "2026-11-12T08:00:01.000Z",
    providerUpdatedAt:
      overrides.providerUpdatedAt ??
      overrides.receivedAt ??
      overrides.publishedAt ??
      "2026-11-12T08:00:01.000Z",
    sourceUrl: `https://example.test/${id}`,
    materiality: "high",
    isLive: true,
    category: "market",
    claimStatus: "reported",
    causalLink: "unassessed",
    topicTags: ["market"],
    isControversial: false,
    ...overrides,
  };
}

const symbol = {
  id: "NASDAQ:NVDA" as const,
  ticker: "NVDA",
  exchange: "NASDAQ",
  name: "NVIDIA",
};

describe("durable intelligence inbox repository", () => {
  let sqlite: DatabaseSync;
  let repository: IntelligenceInboxRepository;
  let setQueryHook: (
    hook: (query: string, params: unknown[]) => boolean,
  ) => void;

  beforeEach(() => {
    const testDatabase = createTestDatabase();
    sqlite = testDatabase.sqlite;
    setQueryHook = testDatabase.setQueryHook;
    repository = createIntelligenceInboxRepository(
      () => testDatabase.database as never,
    );
    seedOwner(sqlite, "owner-a");
    seedOwner(sqlite, "owner-b");
  });

  afterEach(() => sqlite.close());

  it("coalesces provider reconciliation with a durable owner-scoped lease", async () => {
    const first = await repository.claimReconciliation(
      "owner-a",
      "2026-11-12T08:00:00.000Z",
    );
    const concurrent = await repository.claimReconciliation(
      "owner-a",
      "2026-11-12T08:00:01.000Z",
    );
    const otherOwner = await repository.claimReconciliation(
      "owner-b",
      "2026-11-12T08:00:01.000Z",
    );

    expect(first).toMatchObject({
      acquired: true,
      reason: "claimed",
      catchupPending: false,
    });
    expect(first.token).toEqual(expect.any(String));
    expect(concurrent).toMatchObject({
      acquired: false,
      token: null,
      reason: "in_flight",
      catchupPending: false,
    });
    expect(otherOwner.acquired).toBe(true);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM inbox_profiles")
        .get(),
    ).toMatchObject({ count: 0 });

    await repository.completeReconciliation(
      "owner-a",
      first.token!,
      "2026-11-12T08:00:02.000Z",
      { providerSucceeded: true, hasMoreCandidates: false },
    );
    const throttled = await repository.claimReconciliation(
      "owner-a",
      "2026-11-12T08:00:20.000Z",
    );
    const due = await repository.claimReconciliation(
      "owner-a",
      "2026-11-12T08:00:32.000Z",
    );
    expect(throttled).toMatchObject({
      acquired: false,
      reason: "throttled",
      catchupPending: false,
      lastCompletedAt: "2026-11-12T08:00:02.000Z",
    });
    expect(due.acquired).toBe(true);
  });

  it("retries failed provider attempts after the shorter durable backoff", async () => {
    const first = await repository.claimReconciliation(
      "owner-a",
      "2026-11-12T08:00:00.000Z",
    );
    await repository.completeReconciliation(
      "owner-a",
      first.token!,
      "2026-11-12T08:00:01.000Z",
      { providerSucceeded: false, hasMoreCandidates: false },
    );

    expect(
      await repository.claimReconciliation(
        "owner-a",
        "2026-11-12T08:00:10.000Z",
      ),
    ).toMatchObject({ acquired: false, reason: "throttled" });
    expect(
      await repository.claimReconciliation(
        "owner-a",
        "2026-11-12T08:00:11.000Z",
      ),
    ).toMatchObject({ acquired: true, reason: "claimed" });
  });

  it("keeps two-second catch-up eligible without allowing stale lease completion", async () => {
    const first = await repository.claimReconciliation(
      "owner-a",
      "2026-11-12T08:00:00.000Z",
    );
    await repository.completeReconciliation(
      "owner-a",
      first.token!,
      "2026-11-12T08:00:01.000Z",
      { providerSucceeded: true, hasMoreCandidates: true },
    );
    const waiting = await repository.claimReconciliation(
      "owner-a",
      "2026-11-12T08:00:02.000Z",
    );
    const catchup = await repository.claimReconciliation(
      "owner-a",
      "2026-11-12T08:00:03.000Z",
    );
    expect(waiting).toMatchObject({
      acquired: false,
      reason: "throttled",
      catchupPending: true,
    });
    expect(catchup).toMatchObject({
      acquired: true,
      catchupPending: true,
    });

    await repository.completeReconciliation(
      "owner-a",
      first.token!,
      "2026-11-12T08:00:04.000Z",
      { providerSucceeded: true, hasMoreCandidates: false },
    );
    const stillInFlight = await repository.claimReconciliation(
      "owner-a",
      "2026-11-12T08:00:05.000Z",
    );
    expect(stillInFlight).toMatchObject({
      acquired: false,
      reason: "in_flight",
      catchupPending: true,
    });
  });

  it("baselines the first live sync, isolates owners, and never alerts backlog", async () => {
    await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "medium",
        include_controversy: true,
        expected_version: 0,
      },
      "2026-11-12T08:00:00.000Z",
    );

    const first = await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:backlog")],
      "2026-11-12T08:01:00.000Z",
    );
    expect(first).toEqual({
      baselineApplied: true,
      hasMoreCandidates: false,
      newItemCount: 1,
      newDeliveryCount: 0,
    });
    const ownerA = await repository.listInbox("owner-a", "all", 50);
    const ownerB = await repository.listInbox("owner-b", "all", 50);
    expect(ownerA.counts).toEqual({ all: 1, unread: 0, saved: 0, alerts: 0 });
    expect(ownerA.items[0].state).toMatchObject({
      read: true,
      readRevision: 1,
      hasUpdate: false,
    });
    expect(ownerB.items).toEqual([]);

    const firstForOwnerB = await repository.syncLiveItems(
      "owner-b",
      [liveItem("alpaca:backlog")],
      "2026-11-12T08:02:00.000Z",
    );
    expect(firstForOwnerB.baselineApplied).toBe(true);
    expect((await repository.listInbox("owner-b", "all", 50)).counts.unread).toBe(0);
  });

  it("uses activation-only sync so the first later fresh event is unread", async () => {
    await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "medium",
        include_controversy: false,
        expected_version: 0,
      },
      "2026-11-12T08:00:00.000Z",
    );
    const activation = await repository.syncLiveItems(
      "owner-a",
      [],
      "2026-11-12T08:01:00.000Z",
    );
    const firstEvent = await repository.syncLiveItems(
      "owner-a",
      [
        liveItem("alpaca:first-after-empty", {
          publishedAt: "2026-11-12T08:02:00.000Z",
        }),
      ],
      "2026-11-12T08:02:01.000Z",
    );

    expect(activation).toEqual({
      baselineApplied: true,
      hasMoreCandidates: false,
      newItemCount: 0,
      newDeliveryCount: 0,
    });
    expect(firstEvent).toEqual({
      baselineApplied: false,
      hasMoreCandidates: false,
      newItemCount: 1,
      newDeliveryCount: 1,
    });
    expect((await repository.listInbox("owner-a", "all", 50)).items[0]).toMatchObject({
      state: { read: false },
      alert: { triggered: true },
    });
  });

  it("reads one durable item only for its owning account, including dismissed saved state", async () => {
    await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:targeted-read")],
      "2026-11-12T08:00:00.000Z",
    );
    await repository.updateInboxState(
      "owner-a",
      "alpaca:targeted-read",
      {
        read: true,
        saved: true,
        dismissed: true,
        expected_version: 1,
        expected_event_revision: 1,
      },
      "2026-11-12T08:01:00.000Z",
    );
    expect((await repository.listInbox("owner-a", "all", 1)).items).toEqual(
      [],
    );

    const item = await repository.getInboxItem(
      "owner-a",
      "alpaca:targeted-read",
    );
    expect(item).toEqual({
      event: {
        eventId: "alpaca:targeted-read",
        eventRevision: 1,
        symbols: [symbol],
        source: {
          name: "alpaca",
          kind: "licensed_news",
          url: "https://example.test/alpaca:targeted-read",
        },
        headline: "Headline alpaca:targeted-read",
        summary: "A provider-backed market event.",
        materiality: "high",
        category: "market",
        claimStatus: "reported",
        causalLink: "unassessed",
        topicTags: ["market"],
        isControversial: false,
        publishedAt: "2026-11-12T08:00:00.000Z",
        receivedAt: "2026-11-12T08:00:01.000Z",
        providerUpdatedAt: "2026-11-12T08:00:01.000Z",
      },
      state: {
        read: true,
        saved: true,
        dismissed: true,
        readRevision: 1,
        hasUpdate: false,
        version: 2,
        firstSeenAt: "2026-11-12T08:00:00.000Z",
        lastSeenAt: "2026-11-12T08:00:00.000Z",
      },
      alert: {
        triggered: false,
        deliveryCount: 0,
        lastDeliveredAt: null,
        matchedRuleSymbols: [],
      },
    });
    await expect(
      repository.getInboxItem("owner-b", "alpaca:targeted-read"),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      repository.getInboxItem("owner-a", "alpaca:missing"),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("merges owner-scoped symbol observations without creating a false correction", async () => {
    sqlite
      .prepare(
        "INSERT INTO instruments (id, ticker, exchange, name, sector, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("NASDAQ:MSFT", "MSFT", "NASDAQ", "Microsoft", "Technology", "USD", "active");
    sqlite
      .prepare(
        "INSERT INTO watchlist_items (watchlist_id, symbol_id, added_at) VALUES (?, ?, ?)",
      )
      .run(
        "watchlist-owner-b",
        "NASDAQ:MSFT",
        "2026-11-12T07:00:00.000Z",
      );

    await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:multi-symbol")],
      "2026-11-12T08:00:00.000Z",
    );
    await repository.syncLiveItems(
      "owner-b",
      [
        liveItem("alpaca:multi-symbol", {
          symbolIds: ["NASDAQ:MSFT"],
          receivedAt: "2026-11-12T08:01:00.000Z",
        }),
      ],
      "2026-11-12T08:01:00.000Z",
    );

    const itemForOwnerA = (await repository.listInbox("owner-a", "all", 50))
      .items[0];
    expect(itemForOwnerA.event.eventRevision).toBe(1);
    expect(itemForOwnerA.event.symbols.map((entry) => entry.id).sort()).toEqual([
      "NASDAQ:MSFT",
      "NASDAQ:NVDA",
    ]);
  });

  it("filters, counts, and enriches more than 1000 events within D1's bind cap", async () => {
    sqlite.exec(`
      WITH RECURSIVE sequence(value) AS (
        VALUES(1)
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 1005
      )
      INSERT INTO inbox_events (
        id, source, provider_event_key, source_kind, headline,
        published_at, received_at, provider_revision_at, materiality, content_hash
      )
      SELECT
        'bulk:' || value,
        'bulk-provider',
        'bulk:' || value,
        'licensed_news',
        'Bulk event ' || value,
        datetime('2026-11-12T00:00:00Z', '+' || value || ' seconds'),
        datetime('2026-11-12T00:00:00Z', '+' || value || ' seconds'),
        datetime('2026-11-12T00:00:00Z', '+' || value || ' seconds'),
        'high',
        'hash-' || value
      FROM sequence;

      INSERT INTO inbox_event_states (
        owner_id, event_id, read_revision, first_seen_at, last_seen_at
      )
      SELECT
        'owner-a', id, 0,
        '2026-11-12T01:00:00.000Z',
        '2026-11-12T01:00:00.000Z'
      FROM inbox_events WHERE source = 'bulk-provider';

      INSERT INTO inbox_event_symbols (event_id, symbol_id)
      SELECT id, 'NASDAQ:NVDA'
      FROM inbox_events WHERE source = 'bulk-provider';

      INSERT INTO alert_deliveries (
        owner_id, rule_symbol_id, event_id, event_revision, delivered_at
      )
      SELECT
        'owner-a', 'NASDAQ:NVDA', id, revision,
        '2026-11-12T01:00:00.000Z'
      FROM inbox_events WHERE source = 'bulk-provider';
    `);

    const all = await repository.listInbox("owner-a", "all", 100);
    const alerts = await repository.listInbox("owner-a", "alerts", 100);

    expect(all.items).toHaveLength(100);
    expect(alerts.items).toHaveLength(100);
    expect(all.counts).toEqual({
      all: 1005,
      unread: 1005,
      saved: 0,
      alerts: 1005,
    });
    expect(all.items.every((entry) => entry.event.symbols.length === 1)).toBe(true);
    expect(alerts.items.every((entry) => entry.alert.deliveryCount === 1)).toBe(true);
  });

  it("rotates bounded sync candidates until the initial feed is fully baselined", async () => {
    const events = Array.from({ length: 8 }, (_, index) =>
      liveItem(`alpaca:rotation-${index}`, {
        publishedAt: new Date(
          Date.parse("2026-11-12T07:00:00.000Z") + index * 60_000,
        ).toISOString(),
      }),
    ).reverse();

    const first = await repository.syncLiveItems(
      "owner-a",
      events,
      "2026-11-12T08:00:00.000Z",
    );
    const second = await repository.syncLiveItems(
      "owner-a",
      events,
      "2026-11-12T08:01:00.000Z",
    );
    const third = await repository.syncLiveItems(
      "owner-a",
      events,
      "2026-11-12T08:02:00.000Z",
    );

    expect(first).toMatchObject({ baselineApplied: true, newItemCount: 4 });
    expect(second).toMatchObject({ baselineApplied: false, newItemCount: 4 });
    expect(third).toMatchObject({ baselineApplied: false, newItemCount: 0 });
    const inbox = await repository.listInbox("owner-a", "all", 100);
    expect(inbox.counts).toEqual({ all: 8, unread: 0, saved: 0, alerts: 0 });
    expect(inbox.items.every((entry) => entry.state.read)).toBe(true);
    expect(
      sqlite
        .prepare(
          "SELECT baseline_completed_at FROM inbox_profiles WHERE owner_id = ?",
        )
        .get("owner-a"),
    ).toMatchObject({ baseline_completed_at: "2026-11-12T08:01:00.000Z" });
  });

  it("keeps late-materialized pre-activation history read after an empty poll closes baseline", async () => {
    const events = Array.from({ length: 8 }, (_, index) =>
      liveItem(`alpaca:partial-baseline-${index}`, {
        publishedAt: new Date(
          Date.parse("2026-11-12T07:00:00.000Z") + index * 60_000,
        ).toISOString(),
      }),
    ).reverse();

    const first = await repository.syncLiveItems(
      "owner-a",
      events,
      "2026-11-12T08:00:00.000Z",
    );
    const empty = await repository.syncLiveItems(
      "owner-a",
      [],
      "2026-11-12T08:01:00.000Z",
    );
    const remaining = await repository.syncLiveItems(
      "owner-a",
      events.slice(4),
      "2026-11-12T08:02:00.000Z",
    );

    expect(first).toMatchObject({
      baselineApplied: true,
      hasMoreCandidates: true,
      newItemCount: 4,
    });
    expect(empty).toMatchObject({
      baselineApplied: false,
      hasMoreCandidates: false,
      newItemCount: 0,
    });
    expect(remaining).toMatchObject({
      baselineApplied: false,
      hasMoreCandidates: false,
      newItemCount: 4,
      newDeliveryCount: 0,
    });
    const inbox = await repository.listInbox("owner-a", "all", 100);
    expect(inbox.counts).toEqual({ all: 8, unread: 0, saved: 0, alerts: 0 });
    expect(inbox.items.every((entry) => entry.state.read)).toBe(true);
  });

  it("reserves activation before ingestion so a failed first sync cannot swallow later news", async () => {
    await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "medium",
        include_controversy: false,
        expected_version: 0,
      },
      "2026-11-12T07:30:00.000Z",
    );
    let failed = false;
    setQueryHook((query) => {
      if (!failed && query.toLowerCase().includes('insert into "inbox_events"')) {
        failed = true;
        throw new Error("injected_ingestion_failure");
      }
      return false;
    });

    await expect(
      repository.syncLiveItems(
        "owner-a",
        [liveItem("alpaca:failed-first")],
        "2026-11-12T08:00:00.000Z",
      ),
    ).rejects.toThrow();
    expect(
      sqlite
        .prepare(
          "SELECT activated_at, baseline_completed_at FROM inbox_profiles WHERE owner_id = ?",
        )
        .get("owner-a"),
    ).toMatchObject({
      activated_at: "2026-11-12T08:00:00.000Z",
      baseline_completed_at: null,
    });

    const later = await repository.syncLiveItems(
      "owner-a",
      [
        liveItem("alpaca:after-failure", {
          publishedAt: "2026-11-12T08:01:00.000Z",
          providerUpdatedAt: "2026-11-12T08:01:00.000Z",
        }),
      ],
      "2026-11-12T08:02:00.000Z",
    );
    expect(later).toMatchObject({
      baselineApplied: false,
      newItemCount: 1,
      newDeliveryCount: 1,
    });
    expect((await repository.listInbox("owner-a", "all", 50)).items[0]).toMatchObject({
      state: { read: false },
      alert: { triggered: true },
    });
  });

  it("treats a post-activation correction as new during a multi-poll baseline", async () => {
    await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "medium",
        include_controversy: true,
        expected_version: 0,
      },
      "2026-11-12T06:00:00.000Z",
    );
    const events = Array.from({ length: 8 }, (_, index) =>
      liveItem(`alpaca:baseline-correction-${index}`, {
        publishedAt: new Date(
          Date.parse("2026-11-12T07:00:00.000Z") + index * 60_000,
        ).toISOString(),
      }),
    ).reverse();
    await repository.syncLiveItems(
      "owner-a",
      events,
      "2026-11-12T08:00:00.000Z",
    );
    const corrected = events.map((event) =>
      event.id === "alpaca:baseline-correction-7"
        ? {
            ...event,
            headline: "Corrected during baseline",
            claimStatus: "corrected" as const,
            providerUpdatedAt: "2026-11-12T08:01:00.000Z",
          }
        : event,
    );
    const second = await repository.syncLiveItems(
      "owner-a",
      corrected,
      "2026-11-12T08:01:00.000Z",
    );

    expect(second.newDeliveryCount).toBe(1);
    const correctedItem = (await repository.listInbox("owner-a", "all", 100))
      .items.find(
        (entry) => entry.event.eventId === "alpaca:baseline-correction-7",
      );
    expect(correctedItem).toMatchObject({
      event: { eventRevision: 2 },
      state: { read: true, readRevision: 1, hasUpdate: true },
      alert: { triggered: true },
    });
  });

  it("baselines a correction that predates activation even when it is ingested later", async () => {
    await repository.syncLiveItems(
      "owner-b",
      [
        liveItem("alpaca:delayed-correction", {
          headline: "H1",
          publishedAt: "2026-11-12T08:00:00.000Z",
          providerUpdatedAt: "2026-11-12T08:00:00.000Z",
        }),
      ],
      "2026-11-12T08:00:01.000Z",
    );
    await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "medium",
        include_controversy: false,
        expected_version: 0,
      },
      "2026-11-12T09:00:00.000Z",
    );
    await repository.syncLiveItems(
      "owner-a",
      [],
      "2026-11-12T09:00:00.000Z",
    );

    const result = await repository.syncLiveItems(
      "owner-a",
      [
        liveItem("alpaca:delayed-correction", {
          headline: "H2",
          claimStatus: "corrected",
          publishedAt: "2026-11-12T08:00:00.000Z",
          providerUpdatedAt: "2026-11-12T08:30:00.000Z",
          receivedAt: "2026-11-12T10:00:00.000Z",
        }),
      ],
      "2026-11-12T10:00:00.000Z",
    );

    expect(result).toMatchObject({ newItemCount: 1, newDeliveryCount: 0 });
    expect((await repository.listInbox("owner-a", "all", 50)).items[0]).toMatchObject({
      event: {
        headline: "H2",
        eventRevision: 2,
        providerUpdatedAt: "2026-11-12T08:30:00.000Z",
      },
      state: { read: true, readRevision: 2, hasUpdate: false },
      alert: { triggered: false },
    });
  });

  it("treats a provider update after activation as new on its first local observation", async () => {
    await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "medium",
        include_controversy: false,
        expected_version: 0,
      },
      "2026-11-12T09:00:00.000Z",
    );
    await repository.syncLiveItems(
      "owner-a",
      [],
      "2026-11-12T09:00:00.000Z",
    );

    const result = await repository.syncLiveItems(
      "owner-a",
      [
        liveItem("alpaca:first-observed-update", {
          headline: "Already corrected by provider",
          publishedAt: "2026-11-12T08:00:00.000Z",
          providerUpdatedAt: "2026-11-12T10:00:00.000Z",
          receivedAt: "2026-11-12T11:00:00.000Z",
        }),
      ],
      "2026-11-12T11:00:00.000Z",
    );

    expect(result).toMatchObject({ newItemCount: 1, newDeliveryCount: 1 });
    expect((await repository.listInbox("owner-a", "all", 50)).items[0]).toMatchObject({
      event: {
        eventRevision: 1,
        providerUpdatedAt: "2026-11-12T10:00:00.000Z",
      },
      state: { read: false, readRevision: 0 },
      alert: { triggered: true, deliveryCount: 1 },
    });
  });

  it("delivers only subsequent matching events and is replay-safe", async () => {
    await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "high",
        include_controversy: false,
        expected_version: 0,
      },
      "2026-11-12T08:00:00.000Z",
    );
    await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:baseline")],
      "2026-11-12T08:01:00.000Z",
    );

    const event = liveItem("alpaca:new", {
      publishedAt: "2026-11-12T08:03:00.000Z",
    });
    const first = await repository.syncLiveItems(
      "owner-a",
      [event],
      "2026-11-12T08:03:01.000Z",
    );
    const retry = await repository.syncLiveItems(
      "owner-a",
      [{ ...event, receivedAt: "2026-11-12T08:04:00.000Z" }],
      "2026-11-12T08:04:00.000Z",
    );

    expect(first).toMatchObject({ newItemCount: 1, newDeliveryCount: 1 });
    expect(retry).toMatchObject({ newItemCount: 0, newDeliveryCount: 0 });
    const inbox = await repository.listInbox("owner-a", "alerts", 50);
    expect(inbox.counts).toMatchObject({ unread: 1, alerts: 1 });
    expect(inbox.items[0].alert).toMatchObject({
      triggered: true,
      deliveryCount: 1,
      matchedRuleSymbols: ["NASDAQ:NVDA"],
    });
  });

  it("does not alert historical backlog after rule activation or re-enable", async () => {
    await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:baseline")],
      "2026-11-12T08:00:00.000Z",
    );
    await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "medium",
        include_controversy: false,
        expected_version: 0,
      },
      "2026-11-12T09:00:00.000Z",
    );

    const backlog = await repository.syncLiveItems(
      "owner-a",
      [
        liveItem("alpaca:late-replay", {
          publishedAt: "2026-11-12T08:30:00.000Z",
        }),
      ],
      "2026-11-12T09:01:00.000Z",
    );
    const newEvent = await repository.syncLiveItems(
      "owner-a",
      [
        liveItem("alpaca:after-enable", {
          publishedAt: "2026-11-12T09:02:00.000Z",
        }),
      ],
      "2026-11-12T09:02:01.000Z",
    );
    expect(backlog.newDeliveryCount).toBe(0);
    expect(newEvent.newDeliveryCount).toBe(1);

    const disabled = await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: false,
        minimum_materiality: "medium",
        include_controversy: false,
        expected_version: 1,
      },
      "2026-11-12T09:03:00.000Z",
    );
    expect(disabled.rule.version).toBe(2);
    await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "medium",
        include_controversy: false,
        expected_version: 2,
      },
      "2026-11-12T09:05:00.000Z",
    );
    const beforeReEnable = await repository.syncLiveItems(
      "owner-a",
      [
        liveItem("alpaca:before-re-enable", {
          publishedAt: "2026-11-12T09:04:00.000Z",
        }),
      ],
      "2026-11-12T09:06:00.000Z",
    );
    expect(beforeReEnable.newDeliveryCount).toBe(0);
  });

  it("keeps provider identity and saved state across a corrected revision", async () => {
    await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "high",
        include_controversy: false,
        expected_version: 0,
      },
      "2026-11-12T08:00:00.000Z",
    );
    await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:baseline")],
      "2026-11-12T08:01:00.000Z",
    );
    await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:corrected")],
      "2026-11-12T08:02:00.000Z",
    );
    const saved = await repository.updateInboxState(
      "owner-a",
      "alpaca:corrected",
      {
        read: true,
        saved: true,
        dismissed: false,
        expected_version: 1,
        expected_event_revision: 1,
      },
      "2026-11-12T08:03:00.000Z",
    );
    expect(saved.state).toMatchObject({ read: true, saved: true, version: 2 });

    const correction = await repository.syncLiveItems(
      "owner-a",
      [
        liveItem("alpaca:corrected", {
          headline: "Corrected provider headline",
          receivedAt: "2026-11-12T08:04:00.000Z",
          providerUpdatedAt: "2026-11-12T08:04:00.000Z",
          claimStatus: "corrected",
        }),
      ],
      "2026-11-12T08:04:00.000Z",
    );
    expect(correction).toMatchObject({ newItemCount: 0, newDeliveryCount: 1 });

    const inbox = await repository.listInbox("owner-a", "saved", 50);
    const corrected = inbox.items.find(
      (item) => item.event.eventId === "alpaca:corrected",
    );
    expect(corrected).toMatchObject({
      event: { eventId: "alpaca:corrected", eventRevision: 2 },
      state: { saved: true, read: true, readRevision: 1, hasUpdate: true, version: 2 },
      alert: { deliveryCount: 1 },
    });
  });

  it("marks a corrected never-read item as updated without changing user state", async () => {
    await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:baseline")],
      "2026-11-12T08:00:00.000Z",
    );
    await repository.syncLiveItems(
      "owner-a",
      [
        liveItem("alpaca:unread-correction", {
          publishedAt: "2026-11-12T08:01:00.000Z",
          providerUpdatedAt: "2026-11-12T08:01:00.000Z",
        }),
      ],
      "2026-11-12T08:01:00.000Z",
    );
    await repository.syncLiveItems(
      "owner-a",
      [
        liveItem("alpaca:unread-correction", {
          headline: "Corrected while still unread",
          claimStatus: "corrected",
          publishedAt: "2026-11-12T08:01:00.000Z",
          providerUpdatedAt: "2026-11-12T08:02:00.000Z",
        }),
      ],
      "2026-11-12T08:02:00.000Z",
    );

    const corrected = (await repository.listInbox("owner-a", "unread", 50))
      .items.find(
        (entry) => entry.event.eventId === "alpaca:unread-correction",
      );
    expect(corrected).toMatchObject({
      event: { eventRevision: 2 },
      state: { read: false, readRevision: 0, hasUpdate: true, version: 1 },
    });
  });

  it("delivers a global correction once to every eligible owner", async () => {
    for (const ownerId of ["owner-a", "owner-b"]) {
      await repository.putAlertRule(
        ownerId,
        "NASDAQ:NVDA",
        {
          enabled: true,
          minimum_materiality: "high",
          include_controversy: false,
          expected_version: 0,
        },
        "2026-11-12T08:00:00.000Z",
      );
      await repository.syncLiveItems(
        ownerId,
        [liveItem("alpaca:shared-correction")],
        "2026-11-12T08:01:00.000Z",
      );
    }

    const corrected = liveItem("alpaca:shared-correction", {
      headline: "Corrected for every owner",
      claimStatus: "corrected",
      receivedAt: "2026-11-12T09:00:00.000Z",
      providerUpdatedAt: "2026-11-12T09:00:00.000Z",
    });
    const ownerA = await repository.syncLiveItems(
      "owner-a",
      [corrected],
      "2026-11-12T09:00:00.000Z",
    );
    const ownerB = await repository.syncLiveItems(
      "owner-b",
      [corrected],
      "2026-11-12T09:01:00.000Z",
    );
    const ownerBRetry = await repository.syncLiveItems(
      "owner-b",
      [{ ...corrected, receivedAt: "2026-11-12T09:02:00.000Z" }],
      "2026-11-12T09:02:00.000Z",
    );

    expect(ownerA.newDeliveryCount).toBe(1);
    expect(ownerB.newDeliveryCount).toBe(1);
    expect(ownerBRetry.newDeliveryCount).toBe(0);
    expect(
      (await repository.listInbox("owner-b", "alerts", 50)).items[0].alert,
    ).toMatchObject({ deliveryCount: 1 });
  });

  it("rejects a late provider revision without reverting global content or duplicating delivery", async () => {
    for (const ownerId of ["owner-a", "owner-b"]) {
      await repository.putAlertRule(
        ownerId,
        "NASDAQ:NVDA",
        {
          enabled: true,
          minimum_materiality: "medium",
          include_controversy: false,
          expected_version: 0,
        },
        "2026-11-12T07:30:00.000Z",
      );
      await repository.syncLiveItems(
        ownerId,
        [],
        "2026-11-12T08:00:00.000Z",
      );
    }

    const original = liveItem("alpaca:monotonic", {
      headline: "H1",
      publishedAt: "2026-11-12T08:01:00.000Z",
      providerUpdatedAt: "2026-11-12T08:01:00.000Z",
    });
    await repository.syncLiveItems(
      "owner-a",
      [original],
      "2026-11-12T08:01:01.000Z",
    );
    await repository.syncLiveItems(
      "owner-b",
      [original],
      "2026-11-12T08:01:02.000Z",
    );

    const corrected = {
      ...original,
      headline: "H2",
      providerUpdatedAt: "2026-11-12T08:02:00.000Z",
      receivedAt: "2026-11-12T08:02:00.000Z",
    };
    const ownerACorrection = await repository.syncLiveItems(
      "owner-a",
      [corrected],
      "2026-11-12T08:02:00.000Z",
    );
    const ownerBLateResponse = await repository.syncLiveItems(
      "owner-b",
      [{ ...original, receivedAt: "2026-11-12T08:03:00.000Z" }],
      "2026-11-12T08:03:00.000Z",
    );
    const ownerBRetry = await repository.syncLiveItems(
      "owner-b",
      [{ ...original, receivedAt: "2026-11-12T08:04:00.000Z" }],
      "2026-11-12T08:04:00.000Z",
    );

    expect(ownerACorrection.newDeliveryCount).toBe(1);
    expect(ownerBLateResponse.newDeliveryCount).toBe(1);
    expect(ownerBRetry.newDeliveryCount).toBe(0);
    const ownerBItem = (await repository.listInbox("owner-b", "all", 50))
      .items[0];
    expect(ownerBItem).toMatchObject({
      event: {
        headline: "H2",
        eventRevision: 2,
        providerUpdatedAt: "2026-11-12T08:02:00.000Z",
      },
      alert: { deliveryCount: 2 },
    });
    expect(
      sqlite
        .prepare(
          "SELECT headline, revision, provider_revision_at FROM inbox_events WHERE id = ?",
        )
        .get("alpaca:monotonic"),
    ).toMatchObject({
      headline: "H2",
      revision: 2,
      provider_revision_at: "2026-11-12T08:02:00.000Z",
    });
  });

  it("supports exact replay without bump and rejects stale divergent state", async () => {
    await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:state")],
      "2026-11-12T08:00:00.000Z",
    );
    const mutation = {
      read: true,
      saved: true,
      dismissed: false,
      expected_version: 1,
      expected_event_revision: 1,
    } as const;
    const first = await repository.updateInboxState(
      "owner-a",
      "alpaca:state",
      mutation,
      "2026-11-12T08:01:00.000Z",
    );
    const replay = await repository.updateInboxState(
      "owner-a",
      "alpaca:state",
      mutation,
      "2026-11-12T08:02:00.000Z",
    );
    expect(first).toMatchObject({ replayed: false, state: { version: 2 } });
    expect(replay).toMatchObject({ replayed: true, state: { version: 2 } });

    await expect(
      repository.updateInboxState(
        "owner-a",
        "alpaca:state",
        { ...mutation, saved: false },
        "2026-11-12T08:03:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      repository.updateInboxState(
        "owner-b",
        "alpaca:state",
        mutation,
        "2026-11-12T08:03:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("atomically rejects a correction racing between CAS read and write", async () => {
    await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:cas-race")],
      "2026-11-12T08:00:00.000Z",
    );
    setQueryHook((query) => {
      const normalized = query.toLowerCase();
      if (
        !normalized.includes('update "inbox_event_states"') ||
        !normalized.includes("exists")
      ) {
        return false;
      }
      sqlite
        .prepare(
          "UPDATE inbox_events SET revision = 2, content_hash = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          "racing-correction",
          "2026-11-12T08:01:00.000Z",
          "alpaca:cas-race",
        );
      return true;
    });

    await expect(
      repository.updateInboxState(
        "owner-a",
        "alpaca:cas-race",
        {
          read: true,
          saved: true,
          dismissed: false,
          expected_version: 1,
          expected_event_revision: 1,
        },
        "2026-11-12T08:02:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      sqlite
        .prepare(
          "SELECT saved_at, version FROM inbox_event_states WHERE owner_id = ? AND event_id = ?",
        )
        .get("owner-a", "alpaca:cas-race"),
    ).toMatchObject({ saved_at: null, version: 1 });
  });

  it("keeps dismissed saved items reachable for restore while suppressing badges", async () => {
    await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:dismissed")],
      "2026-11-12T08:00:00.000Z",
    );
    await repository.updateInboxState(
      "owner-a",
      "alpaca:dismissed",
      {
        read: true,
        saved: true,
        dismissed: true,
        expected_version: 1,
        expected_event_revision: 1,
      },
      "2026-11-12T08:01:00.000Z",
    );

    const all = await repository.listInbox("owner-a", "all", 50);
    const saved = await repository.listInbox("owner-a", "saved", 50);
    const unread = await repository.listInbox("owner-a", "unread", 50);
    expect(all.counts).toEqual({ all: 0, unread: 0, saved: 1, alerts: 0 });
    expect(all.items).toEqual([]);
    expect(saved.items[0].state).toMatchObject({ saved: true, dismissed: true });
    expect(unread.items).toEqual([]);
  });

  it("keeps rules absent by default and applies CAS/exact-replay semantics", async () => {
    expect(await repository.listRules("owner-a", [symbol])).toEqual([
      expect.objectContaining({
        symbol,
        enabled: false,
        version: 0,
        persisted: false,
        channel: "in_app",
      }),
    ]);
    const desired = {
      enabled: true,
      minimum_materiality: "critical" as const,
      include_controversy: true,
      expected_version: 0,
    };
    const first = await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      desired,
      "2026-11-12T08:00:00.000Z",
    );
    const replay = await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      desired,
      "2026-11-12T08:01:00.000Z",
    );
    expect(first).toMatchObject({ replayed: false, rule: { version: 1 } });
    expect(replay).toMatchObject({ replayed: true, rule: { version: 1 } });
    await expect(
      repository.putAlertRule(
        "owner-a",
        "NASDAQ:NVDA",
        { ...desired, enabled: false },
        "2026-11-12T08:02:00.000Z",
      ),
    ).rejects.toMatchObject({ code: "conflict" });

    await repository.syncLiveItems(
      "owner-a",
      [liveItem("alpaca:baseline")],
      "2026-11-12T08:03:00.000Z",
    );
    const controversial = await repository.syncLiveItems(
      "owner-a",
      [
        liveItem("alpaca:controversy", {
          materiality: "medium",
          isControversial: true,
          publishedAt: "2026-11-12T08:04:00.000Z",
          providerUpdatedAt: "2026-11-12T08:04:00.000Z",
        }),
      ],
      "2026-11-12T08:04:00.000Z",
    );
    expect(controversial.newDeliveryCount).toBe(1);
  });

  it("lists virtual defaults for more than 100 tracked symbols without bind overflow", async () => {
    const tracked = [
      symbol,
      ...Array.from({ length: 120 }, (_, index) => ({
        id: `NASDAQ:TEST${index}` as const,
        ticker: `TEST${index}`,
        exchange: "NASDAQ",
        name: `Test ${index}`,
      })),
    ];

    const rules = await repository.listRules("owner-a", tracked);

    expect(rules).toHaveLength(121);
    expect(rules.every((rule) => rule.persisted === false)).toBe(true);
  });

  it("does not deliver through removed symbols or manufacture backlog after re-add", async () => {
    sqlite
      .prepare(
        "INSERT INTO instruments (id, ticker, exchange, name, sector, currency, status) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run("NASDAQ:MSFT", "MSFT", "NASDAQ", "Microsoft", "Technology", "USD", "active");
    for (const ownerId of ["owner-a", "owner-b"]) {
      sqlite
        .prepare(
          "INSERT INTO watchlist_items (watchlist_id, symbol_id, added_at) VALUES (?, ?, ?)",
        )
        .run(
          `watchlist-${ownerId}`,
          "NASDAQ:MSFT",
          "2026-11-12T07:00:00.000Z",
        );
    }
    await repository.putAlertRule(
      "owner-a",
      "NASDAQ:NVDA",
      {
        enabled: true,
        minimum_materiality: "medium",
        include_controversy: true,
        expected_version: 0,
      },
      "2026-11-12T08:00:00.000Z",
    );
    await repository.syncLiveItems(
      "owner-a",
      [],
      "2026-11-12T08:01:00.000Z",
    );

    const shared = liveItem("alpaca:untracked-shared", {
      symbolIds: ["NASDAQ:NVDA", "NASDAQ:MSFT"],
      publishedAt: "2026-11-12T08:02:00.000Z",
    });
    await repository.syncLiveItems(
      "owner-b",
      [shared],
      "2026-11-12T08:02:01.000Z",
    );
    sqlite
      .prepare(
        "DELETE FROM watchlist_items WHERE watchlist_id = ? AND symbol_id = ?",
      )
      .run("watchlist-owner-a", "NASDAQ:NVDA");
    const whileRemoved = await repository.syncLiveItems(
      "owner-a",
      [{ ...shared, symbolIds: ["NASDAQ:MSFT"] }],
      "2026-11-12T08:03:00.000Z",
    );
    expect(whileRemoved.newDeliveryCount).toBe(0);

    const duringAbsence = liveItem("alpaca:during-absence", {
      publishedAt: "2026-11-12T08:03:30.000Z",
    });
    await repository.syncLiveItems(
      "owner-b",
      [duringAbsence],
      "2026-11-12T08:03:31.000Z",
    );
    sqlite
      .prepare(
        "INSERT INTO watchlist_items (watchlist_id, symbol_id, added_at) VALUES (?, ?, ?)",
      )
      .run(
        "watchlist-owner-a",
        "NASDAQ:NVDA",
        "2026-11-12T08:04:00.000Z",
      );
    const afterReAdd = await repository.syncLiveItems(
      "owner-a",
      [duringAbsence],
      "2026-11-12T08:05:00.000Z",
    );
    expect(afterReAdd.newDeliveryCount).toBe(0);
  });
});
