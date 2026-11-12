import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@/db/schema";
import { createInboxProjectionCursorRepository } from "@/lib/intelligence-inbox/projection-repository";
import { createIntelligenceInboxRepository } from "@/lib/intelligence-inbox/repository";
import type { RawSourceEventReceipt } from "@/lib/ingestion/contracts";
import {
  createIngestionRepository,
  sha256Hex,
  type IngestionRepository,
} from "@/lib/ingestion/repository";
import {
  runIntelligenceProjectionTick,
  type IntelligenceProjectionDependencies,
} from "@/lib/services/intelligence-projection";

vi.mock("cloudflare:workers", () => ({ env: {} }));

function migrationSql(name: string) {
  return readFileSync(resolve(process.cwd(), "drizzle", name), "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
}

function createTestDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of [
    "0000_damp_robbie_robertson.sql",
    "0001_thick_reptil.sql",
    "0002_portfolio_v1.sql",
    "0003_intelligence_inbox_v1.sql",
    "0004_ingestion_control_plane_v1.sql",
    "0008_inbox_projection_cursor_v1.sql",
  ]) {
    sqlite.exec(migrationSql(migration));
  }
  const database = drizzle(
    async (query, params, method) => {
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
      return {
        rows: statement.all(...params).map((row) => Object.values(row)),
      };
    },
    { schema },
  );
  return { sqlite, database };
}

async function version(
  headline: string,
  digestCharacter: string,
): Promise<RawSourceEventReceipt> {
  const rawPayload = JSON.stringify({
    schema: "omnigaze.provider-receipt.v1",
    sourceKind: "licensed_news",
    sourceEventId: "news-transition",
    publishedAt: "2026-11-12T08:20:00.000Z",
    providerRevisionAt: "2026-11-12T08:30:00.000Z",
    symbolIds: ["NASDAQ:NVDA"],
    headline,
    summary: "A retained equal-revision provider observation.",
    url: "https://example.test/news-transition",
    contentDigest: digestCharacter.repeat(64),
  });
  return {
    sourceKind: "licensed_news",
    sourceEventId: "news-transition",
    publishedAt: "2026-11-12T08:20:00.000Z",
    observedAt: "2026-11-12T08:31:00.000Z",
    payloadPolicy: "minimal_redacted_v1",
    rawPayloadHash: await sha256Hex(rawPayload),
    rawPayload,
    symbolIds: ["NASDAQ:NVDA"],
    providerRevisionAt: "2026-11-12T08:30:00.000Z",
  };
}

describe("durable owner projection transitions", () => {
  let sqlite: DatabaseSync;
  let ingestion: IngestionRepository;
  let dependencies: IntelligenceProjectionDependencies;
  let currentNow: Date;

  beforeEach(() => {
    const testDatabase = createTestDatabase();
    sqlite = testDatabase.sqlite;
    ingestion = createIngestionRepository(
      () => testDatabase.database as never,
    );
    const inbox = createIntelligenceInboxRepository(
      () => testDatabase.database as never,
    );
    const cursors = createInboxProjectionCursorRepository(
      () => testDatabase.database as never,
    );
    sqlite.exec(`
      INSERT INTO instruments (
        id, ticker, exchange, name, sector, currency, status
      ) VALUES (
        'NASDAQ:NVDA', 'NVDA', 'NASDAQ', 'NVIDIA', 'Technology', 'USD', 'active'
      );
      INSERT INTO watchlists (id, owner_id, name, is_default, created_at)
      VALUES (
        'watchlist-owner-a', 'owner-a', 'Core holdings', 1,
        '2026-11-12T08:00:00.000Z'
      );
      INSERT INTO watchlist_items (watchlist_id, symbol_id, added_at)
      VALUES (
        'watchlist-owner-a', 'NASDAQ:NVDA',
        '2026-11-12T08:00:00.000Z'
      );
      INSERT INTO inbox_profiles (
        owner_id, activated_at, baseline_completed_at,
        last_checked_at, last_successful_sync_at
      ) VALUES (
        'owner-a', '2026-11-12T08:00:00.000Z', NULL,
        '2026-11-12T08:00:00.000Z', '2026-11-12T08:00:00.000Z'
      );
    `);
    currentNow = new Date("2026-11-12T09:00:10.000Z");
    dependencies = {
      cursors,
      inbox,
      listWatchlists: async () =>
        [
          {
            id: "watchlist-owner-a",
            ownerId: "owner-a",
            name: "Core holdings",
            isDefault: true,
            createdAt: "2026-11-12T08:00:00.000Z",
            updatedAt: "2026-11-12T08:00:00.000Z",
            items: [
              {
                watchlistId: "watchlist-owner-a",
                symbolId: "NASDAQ:NVDA",
                note: null,
                addedAt: "2026-11-12T08:00:00.000Z",
                ticker: "NVDA",
                exchange: "NASDAQ",
                name: "NVIDIA",
              },
            ],
          },
        ] as never,
      listChanges: (input) => ingestion.listProjectionChanges(input),
      now: () => currentNow,
    };
  });

  afterEach(() => sqlite.close());

  async function ingest(
    receipt: RawSourceEventReceipt,
    index: number,
    changedAt: string,
  ) {
    const partitionKey = `transition-${index}`;
    await ingestion.ensureCheckpoint({
      provider: "alpaca",
      partitionKey,
      nextDueAt: "2026-11-12T08:00:00.000Z",
      now: "2026-11-12T08:00:00.000Z",
    });
    const claim = await ingestion.claimNextDue({
      provider: "alpaca",
      partitionKey,
      claimedAt: "2026-11-12T08:00:00.000Z",
      leaseExpiresAt: "2026-11-12T10:00:00.000Z",
      proposedWindow: {
        start: "2026-11-12T07:00:00.000Z",
        end: "2026-11-12T08:00:00.000Z",
        fingerprint: `transition-window-${index}`,
      },
    });
    const runId = await ingestion.startRun(
      claim!.lease,
      "2026-11-12T08:00:01.000Z",
    );
    await ingestion.persistPage({
      lease: claim!.lease,
      runId,
      receipts: [receipt],
      nextCursor: null,
      persistedAt: changedAt,
    });
  }

  function storedEvent() {
    return sqlite
      .prepare(`
        SELECT headline, revision, received_at, provider_revision_at
        FROM inbox_events WHERE id = 'alpaca:news-transition'
      `)
      .get();
  }

  it("materializes equal-revision A-to-B-to-A transitions across separate ticks", async () => {
    const a = await version("Version A", "a");
    const b = await version("Version B", "b");

    await ingest(a, 1, "2026-11-12T09:00:00.000Z");
    await runIntelligenceProjectionTick(dependencies);
    expect(storedEvent()).toEqual({
      headline: "Version A",
      revision: 1,
      received_at: "2026-11-12T09:00:00.000Z",
      provider_revision_at: "2026-11-12T08:30:00.000Z",
    });
    expect(
      sqlite
        .prepare(
          "SELECT baseline_completed_at FROM inbox_profiles WHERE owner_id = 'owner-a'",
        )
        .get(),
    ).toEqual({ baseline_completed_at: currentNow.toISOString() });

    await ingest(b, 2, "2026-11-12T09:01:00.000Z");
    currentNow = new Date("2026-11-12T09:01:10.000Z");
    await runIntelligenceProjectionTick(dependencies);
    expect(storedEvent()).toEqual({
      headline: "Version B",
      revision: 2,
      received_at: "2026-11-12T09:01:00.000Z",
      provider_revision_at: "2026-11-12T08:30:00.000Z",
    });

    await ingest(a, 3, "2026-11-12T09:02:00.000Z");
    currentNow = new Date("2026-11-12T09:02:10.000Z");
    await runIntelligenceProjectionTick(dependencies);
    expect(storedEvent()).toEqual({
      headline: "Version A",
      revision: 3,
      received_at: "2026-11-12T09:02:00.000Z",
      provider_revision_at: "2026-11-12T08:30:00.000Z",
    });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM inbox_projection_changes")
        .get(),
    ).toEqual({ count: 3 });
  });
});
