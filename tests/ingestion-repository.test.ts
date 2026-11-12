import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@/db/schema";
import type { RawSourceEventReceipt } from "@/lib/ingestion/contracts";
import {
  createIngestionRepository,
  sha256Hex,
  type IngestionRepository,
} from "@/lib/ingestion/repository";

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
      const rows = statement.all(...params).map((row) => Object.values(row));
      return { rows };
    },
    { schema },
  );
  return { sqlite, database };
}

const window = {
  start: "2026-11-12T07:00:00.000Z",
  end: "2026-11-12T08:00:00.000Z",
  fingerprint: "configured-symbols-v1",
};

async function receipt(
  overrides: Partial<RawSourceEventReceipt> = {},
): Promise<RawSourceEventReceipt> {
  const rawPayload = JSON.stringify({
    schema: "omnigaze.provider-receipt.v1",
    sourceKind: "licensed_news",
    sourceEventId: "news-1",
    publishedAt: "2026-11-12T07:45:00.000Z",
    providerRevisionAt: "2026-11-12T07:45:30.000Z",
    symbolIds: ["NASDAQ:NVDA"],
    headline: "A material update",
    summary: "A minimal, redacted provider envelope.",
    url: "https://example.test/news-1",
    contentDigest: "a".repeat(64),
  });
  return {
    sourceKind: "licensed_news",
    sourceEventId: "news-1",
    publishedAt: "2026-11-12T07:45:00.000Z",
    observedAt: "2026-11-12T07:46:00.000Z",
    payloadPolicy: "minimal_redacted_v1",
    rawPayloadHash: await sha256Hex(rawPayload),
    rawPayload,
    status: "received",
    symbolIds: ["NASDAQ:NVDA"],
    providerRevisionAt: "2026-11-12T07:45:30.000Z",
    ...overrides,
  };
}

describe("global ingestion repository", () => {
  let sqlite: DatabaseSync;
  let repository: IngestionRepository;

  beforeEach(() => {
    const testDatabase = createTestDatabase();
    sqlite = testDatabase.sqlite;
    repository = createIngestionRepository(
      () => testDatabase.database as never,
    );
  });

  afterEach(() => sqlite.close());

  async function ensureAndClaim(partitionKey = "news:configured-v1") {
    await repository.ensureCheckpoint({
      provider: "alpaca",
      partitionKey,
      nextDueAt: "2026-11-12T08:00:00.000Z",
      now: "2026-11-12T08:00:00.000Z",
    });
    const claim = await repository.claimNextDue({
      provider: "alpaca",
      partitionKey,
      claimedAt: "2026-11-12T08:00:00.000Z",
      leaseExpiresAt: "2026-11-12T08:01:00.000Z",
      proposedWindow: window,
    });
    expect(claim).not.toBeNull();
    return claim!;
  }

  it("freezes and resumes a paginated window, advancing high-water only when exhausted", async () => {
    const first = await ensureAndClaim();
    expect(first.window).toEqual(window);
    expect(
      await repository.claimNextDue({
        provider: "alpaca",
        partitionKey: first.partitionKey,
        claimedAt: "2026-11-12T08:00:01.000Z",
        leaseExpiresAt: "2026-11-12T08:01:01.000Z",
        proposedWindow: window,
      }),
    ).toBeNull();
    const runId = await repository.startRun(
      first.lease,
      "2026-11-12T08:00:01.000Z",
    );
    expect(
      await repository.startRun(
        first.lease,
        "2026-11-12T08:00:01.000Z",
      ),
    ).toBe(runId);
    await repository.persistPage({
      lease: first.lease,
      runId,
      receipts: [],
      nextCursor: "page-2",
      persistedAt: "2026-11-12T08:00:02.000Z",
    });
    await repository.completeRun({
      lease: first.lease,
      runId,
      completedAt: "2026-11-12T08:00:03.000Z",
      nextDueAt: "2026-11-12T08:00:04.000Z",
      hasMore: true,
    });

    expect(
      sqlite
        .prepare(
          "SELECT resume_cursor, high_water_mark, window_end FROM provider_ingestion_checkpoints WHERE provider = ? AND partition_key = ?",
        )
        .get("alpaca", first.partitionKey),
    ).toMatchObject({
      resume_cursor: "page-2",
      high_water_mark: null,
      window_end: window.end,
    });

    const resumed = await repository.claimNextDue({
      provider: "alpaca",
      partitionKey: first.partitionKey,
      claimedAt: "2026-11-12T08:00:04.000Z",
      leaseExpiresAt: "2026-11-12T08:01:04.000Z",
      proposedWindow: {
        start: "2026-11-12T08:00:00.000Z",
        end: "2026-11-12T09:00:00.000Z",
        fingerprint: "must-not-replace-frozen-window",
      },
    });
    expect(resumed).toMatchObject({ resumeCursor: "page-2", window });
    const finalRunId = await repository.startRun(
      resumed!.lease,
      "2026-11-12T08:00:05.000Z",
    );
    await repository.persistPage({
      lease: resumed!.lease,
      runId: finalRunId,
      receipts: [],
      nextCursor: null,
      persistedAt: "2026-11-12T08:00:06.000Z",
    });
    await repository.completeRun({
      lease: resumed!.lease,
      runId: finalRunId,
      completedAt: "2026-11-12T08:00:07.000Z",
      nextDueAt: "2026-11-12T08:05:00.000Z",
      hasMore: false,
      highWaterMark: window.end,
    });

    expect(
      sqlite
        .prepare(
          "SELECT resume_cursor, high_water_mark, window_end, total_successes FROM provider_ingestion_checkpoints WHERE provider = ? AND partition_key = ?",
        )
        .get("alpaca", first.partitionKey),
    ).toMatchObject({
      resume_cursor: null,
      high_water_mark: window.end,
      window_end: null,
      total_successes: 2,
    });
  });

  it("reclaims an expired lease without losing its persisted resume cursor", async () => {
    const first = await ensureAndClaim();
    const abandonedRun = await repository.startRun(
      first.lease,
      "2026-11-12T08:00:01.000Z",
    );
    await repository.persistPage({
      lease: first.lease,
      runId: abandonedRun,
      receipts: [],
      nextCursor: "page-2",
      persistedAt: "2026-11-12T08:00:02.000Z",
    });

    const reclaimed = await repository.claimNextDue({
      provider: "alpaca",
      partitionKey: first.partitionKey,
      claimedAt: "2026-11-12T08:01:00.000Z",
      leaseExpiresAt: "2026-11-12T08:02:00.000Z",
      proposedWindow: {
        start: "2026-11-12T08:00:00.000Z",
        end: "2026-11-12T09:00:00.000Z",
        fingerprint: "must-not-replace-frozen-window",
      },
    });
    expect(reclaimed).toMatchObject({
      resumeCursor: "page-2",
      window,
      consecutiveFailures: 1,
      totalFailures: 1,
    });
    expect(reclaimed!.lease.token).not.toBe(first.lease.token);
    expect(
      sqlite
        .prepare("SELECT status FROM provider_ingestion_runs WHERE id = ?")
        .get(abandonedRun),
    ).toMatchObject({ status: "failed" });
    await expect(
      repository.completeRun({
        lease: first.lease,
        runId: abandonedRun,
        completedAt: "2026-11-12T08:00:59.000Z",
        nextDueAt: "2026-11-12T08:05:00.000Z",
        hasMore: true,
      }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("persists immutable receipts before cursor movement and replays idempotently", async () => {
    const claim = await ensureAndClaim();
    const runId = await repository.startRun(
      claim.lease,
      "2026-11-12T08:00:01.000Z",
    );
    const news = await receipt();
    const page = {
      lease: claim.lease,
      runId,
      receipts: [news],
      nextCursor: "page-2",
      persistedAt: "2026-11-12T08:00:02.000Z",
    } as const;

    await expect(repository.persistPage(page)).rejects.toThrow();
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM source_events").get(),
    ).toMatchObject({ count: 1 });
    expect(
      sqlite
        .prepare(
          "SELECT resume_cursor FROM provider_ingestion_checkpoints WHERE provider = 'alpaca'",
        )
        .get(),
    ).toMatchObject({ resume_cursor: null });

    sqlite
      .prepare(
        "INSERT INTO instruments (id, ticker, exchange, name, currency, status) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("NASDAQ:NVDA", "NVDA", "NASDAQ", "NVIDIA", "USD", "active");
    const persisted = await repository.persistPage(page);
    expect(persisted).toMatchObject({
      receiptCount: 1,
      insertedReceiptCount: 0,
      linkedSymbolCount: 1,
      nextCursor: "page-2",
      highWaterMark: null,
    });
    expect(await repository.persistPage(page)).toEqual(persisted);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM source_events").get(),
    ).toMatchObject({ count: 1 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM source_event_symbols").get(),
    ).toMatchObject({ count: 1 });
    expect(
      sqlite
        .prepare(
          "SELECT seen_count, payload_policy FROM source_event_ingestion_metadata",
        )
        .get(),
    ).toMatchObject({
      seen_count: 1,
      payload_policy: "minimal_redacted_v1",
    });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM inbox_projection_changes")
        .get(),
    ).toMatchObject({ count: 1 });

    const projectionPage = await repository.listProjectionChanges({
      afterSequence: 0,
      limit: 1,
    });
    expect(projectionPage).toMatchObject({
      hasMore: false,
      items: [
        {
          sequence: 1,
          event: {
            provider: "alpaca",
            sourceEventId: "news-1",
            symbolIds: ["NASDAQ:NVDA"],
            providerRevisionAt: news.providerRevisionAt,
            envelope: { headline: "A material update" },
          },
        },
      ],
    });
    await expect(
      repository.listProjectionChanges({ afterSequence: 1, limit: 20 }),
    ).resolves.toEqual({ items: [], hasMore: false });

    const status = await repository.getAggregateStatus({
      now: "2026-11-12T08:00:03.000Z",
      since: "2026-11-12T07:00:00.000Z",
    });
    expect(status.providers[0]).toMatchObject({
      provider: "alpaca",
      latestEvidenceAt: news.providerRevisionAt,
      runs: { running: 1, receipts: 1, errors: 0 },
    });
    expect(JSON.stringify(status)).not.toContain(claim.lease.token);
    expect(JSON.stringify(status)).not.toContain("page-2");
    expect(JSON.stringify(status)).not.toContain(news.rawPayload);

    const collected = await repository.listCollectedEvents({
      provider: "alpaca",
      partitionKey: claim.partitionKey,
      since: "2026-11-12T07:00:00.000Z",
      symbolIds: ["NASDAQ:NVDA"],
      limit: 20,
    });
    expect(collected).toMatchObject({
      hasMore: false,
      nextBefore: null,
      items: [
        {
          provider: "alpaca",
          sourceEventId: "news-1",
          symbolIds: ["NASDAQ:NVDA"],
          providerRevisionAt: news.providerRevisionAt,
          envelope: {
            headline: "A material update",
            summary: "A minimal, redacted provider envelope.",
            url: "https://example.test/news-1",
          },
        },
      ],
    });
    expect(JSON.stringify(collected)).not.toContain(news.rawPayloadHash);
  });

  it("deduplicates one provider version globally while retaining partition receipts", async () => {
    sqlite
      .prepare(
        "INSERT INTO instruments (id, ticker, exchange, name, currency, status) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("NASDAQ:NVDA", "NVDA", "NASDAQ", "NVIDIA", "USD", "active");
    const news = await receipt();

    for (const [index, partitionKey] of ["partition-a", "partition-b"].entries()) {
      const claim = await ensureAndClaim(partitionKey);
      const runId = await repository.startRun(
        claim.lease,
        `2026-11-12T08:00:0${index + 1}.000Z`,
      );
      await repository.persistPage({
        lease: claim.lease,
        runId,
        receipts: [news],
        nextCursor: null,
        persistedAt: `2026-11-12T08:00:1${index}.000Z`,
      });
      await repository.completeRun({
        lease: claim.lease,
        runId,
        completedAt: `2026-11-12T08:00:2${index}.000Z`,
        nextDueAt: "2026-11-12T09:00:00.000Z",
        hasMore: false,
        highWaterMark: window.end,
      });
    }

    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM source_events").get(),
    ).toMatchObject({ count: 1 });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM source_event_symbols").get(),
    ).toMatchObject({ count: 1 });
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM source_event_ingestion_metadata",
        )
        .get(),
    ).toMatchObject({ count: 2 });
    await expect(
      repository.getAggregateStatus({
        now: "2026-11-12T08:01:00.000Z",
        since: "2026-11-12T07:00:00.000Z",
        provider: "alpaca",
        partitionKey: "partition-a",
      }),
    ).resolves.toMatchObject({
      providers: [{ provider: "alpaca", partitionCount: 1 }],
    });
    await expect(
      repository.listCollectedEvents({
        provider: "alpaca",
        since: "2026-11-12T07:00:00.000Z",
        symbolIds: ["NASDAQ:NVDA"],
        limit: 20,
      }),
    ).resolves.toMatchObject({
      hasMore: false,
      items: [
        expect.objectContaining({
          sourceEventId: "news-1",
          symbolIds: ["NASDAQ:NVDA"],
        }),
      ],
    });
  });

  it("coalesces cross-run repeats while retaining A-to-B-to-A reversions", async () => {
    sqlite
      .prepare(
        "INSERT INTO instruments (id, ticker, exchange, name, currency, status) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("NASDAQ:NVDA", "NVDA", "NASDAQ", "NVIDIA", "USD", "active");
    const original = await receipt();
    const correctedPayload = JSON.stringify({
      schema: "omnigaze.provider-receipt.v1",
      sourceKind: "licensed_news",
      sourceEventId: "news-1",
      publishedAt: "2026-11-12T07:45:00.000Z",
      providerRevisionAt: "2026-11-12T07:45:30.000Z",
      symbolIds: ["NASDAQ:NVDA"],
      headline: "A material correction",
      summary: "A later-observed equal-revision correction.",
      url: "https://example.test/news-1",
      contentDigest: "b".repeat(64),
    });
    const corrected = await receipt({
      rawPayload: correctedPayload,
      rawPayloadHash: await sha256Hex(correctedPayload),
      observedAt: "2026-11-12T07:47:00.000Z",
    });

    for (const [index, version] of [
      original,
      original,
      corrected,
      original,
    ].entries()) {
      const claim = await ensureAndClaim(`transition-${index}`);
      const runId = await repository.startRun(
        claim.lease,
        `2026-11-12T08:00:${String(index).padStart(2, "0")}.000Z`,
      );
      await repository.persistPage({
        lease: claim.lease,
        runId,
        receipts: [version],
        nextCursor: null,
        persistedAt: `2026-11-12T08:00:${String(index + 10).padStart(2, "0")}.000Z`,
      });
    }

    expect(
      sqlite
        .prepare(`
          SELECT
            json_extract(source_events.raw_payload, '$.headline') AS headline,
            inbox_projection_changes.changed_at AS changed_at
          FROM inbox_projection_changes
          INNER JOIN source_events
            ON source_events.id = inbox_projection_changes.source_event_id
          ORDER BY inbox_projection_changes.sequence
        `)
        .all(),
    ).toEqual([
      {
        headline: "A material update",
        changed_at: "2026-11-12T08:00:10.000Z",
      },
      {
        headline: "A material correction",
        changed_at: "2026-11-12T08:00:12.000Z",
      },
      {
        headline: "A material update",
        changed_at: "2026-11-12T08:00:13.000Z",
      },
    ]);
    expect(
      sqlite
        .prepare(`
          SELECT COUNT(DISTINCT logical_event_id) AS count
          FROM inbox_projection_changes
        `)
        .get(),
    ).toEqual({ count: 1 });
    const changes = await repository.listProjectionChanges({
      afterSequence: 0,
      limit: 10,
    });
    expect(changes.items.map((entry) => entry.event.envelope.headline)).toEqual([
      "A material update",
      "A material correction",
      "A material update",
    ]);
  });

  it("follows the latest observation across an equal-revision correction and reversion", async () => {
    sqlite
      .prepare(
        "INSERT INTO instruments (id, ticker, exchange, name, currency, status) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run("NASDAQ:NVDA", "NVDA", "NASDAQ", "NVIDIA", "USD", "active");
    const firstReceipt = await receipt();
    const first = await ensureAndClaim();
    const firstRun = await repository.startRun(
      first.lease,
      "2026-11-12T08:00:01.000Z",
    );
    await repository.persistPage({
      lease: first.lease,
      runId: firstRun,
      receipts: [firstReceipt],
      nextCursor: null,
      persistedAt: "2026-11-12T08:00:02.000Z",
    });
    await repository.completeRun({
      lease: first.lease,
      runId: firstRun,
      completedAt: "2026-11-12T08:00:03.000Z",
      nextDueAt: "2026-11-12T08:00:04.000Z",
      hasMore: false,
      highWaterMark: first.window.end,
    });

    const laterWindow = {
      start: "2026-11-12T08:00:00.000Z",
      end: "2026-11-12T09:00:00.000Z",
      fingerprint: "configured-symbols-v2",
    };
    const second = await repository.claimNextDue({
      provider: "alpaca",
      partitionKey: first.partitionKey,
      claimedAt: "2026-11-12T08:00:04.000Z",
      leaseExpiresAt: "2026-11-12T08:01:04.000Z",
      proposedWindow: laterWindow,
    });
    const correctedEnvelope = JSON.stringify({
      schema: "omnigaze.provider-receipt.v1",
      sourceKind: "licensed_news",
      sourceEventId: "news-1",
      publishedAt: "2026-11-12T07:45:00.000Z",
      providerRevisionAt: "2026-11-12T07:45:30.000Z",
      symbolIds: ["NASDAQ:NVDA"],
      headline: "Late corrected variant",
      summary: "The latest observed equal-revision variant must win.",
      url: "https://example.test/news-1",
      contentDigest: "b".repeat(64),
    });
    const secondRun = await repository.startRun(
      second!.lease,
      "2026-11-12T08:00:05.000Z",
    );
    await repository.persistPage({
      lease: second!.lease,
      runId: secondRun,
      receipts: [
        await receipt({
          observedAt: "2026-11-12T08:00:05.000Z",
          rawPayload: correctedEnvelope,
          rawPayloadHash: await sha256Hex(correctedEnvelope),
        }),
      ],
      nextCursor: null,
      persistedAt: "2026-11-12T08:00:06.000Z",
    });
    await repository.completeRun({
      lease: second!.lease,
      runId: secondRun,
      completedAt: "2026-11-12T08:00:07.000Z",
      nextDueAt: "2026-11-12T09:05:00.000Z",
      hasMore: false,
      highWaterMark: laterWindow.end,
    });

    const thirdWindow = {
      start: "2026-11-12T09:00:00.000Z",
      end: "2026-11-12T10:00:00.000Z",
      fingerprint: "configured-symbols-v3",
    };
    const third = await repository.claimNextDue({
      provider: "alpaca",
      partitionKey: first.partitionKey,
      claimedAt: "2026-11-12T09:05:00.000Z",
      leaseExpiresAt: "2026-11-12T09:06:00.000Z",
      proposedWindow: thirdWindow,
    });
    const thirdRun = await repository.startRun(
      third!.lease,
      "2026-11-12T09:05:01.000Z",
    );
    await repository.persistPage({
      lease: third!.lease,
      runId: thirdRun,
      receipts: [
        await receipt({ observedAt: "2026-11-12T09:05:01.000Z" }),
      ],
      nextCursor: null,
      persistedAt: "2026-11-12T09:05:02.000Z",
    });
    await repository.completeRun({
      lease: third!.lease,
      runId: thirdRun,
      completedAt: "2026-11-12T09:05:03.000Z",
      nextDueAt: "2026-11-12T10:05:00.000Z",
      hasMore: false,
      highWaterMark: thirdWindow.end,
    });

    const collected = await repository.listCollectedEvents({
      provider: "alpaca",
      partitionKey: first.partitionKey,
      since: "2026-11-12T07:00:00.000Z",
      symbolIds: ["NASDAQ:NVDA"],
      limit: 10,
    });
    expect(collected.items).toHaveLength(1);
    expect(collected.items[0].envelope.headline).toBe("A material update");
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM source_events").get(),
    ).toMatchObject({ count: 2 });
  });

  it("sanitizes bounded errors and discards a non-retryable poison cursor", async () => {
    const first = await ensureAndClaim();
    const firstRun = await repository.startRun(
      first.lease,
      "2026-11-12T08:00:01.000Z",
    );
    await repository.persistPage({
      lease: first.lease,
      runId: firstRun,
      receipts: [],
      nextCursor: "poison-token",
      persistedAt: "2026-11-12T08:00:02.000Z",
    });
    await repository.completeRun({
      lease: first.lease,
      runId: firstRun,
      completedAt: "2026-11-12T08:00:03.000Z",
      nextDueAt: "2026-11-12T08:00:04.000Z",
      hasMore: true,
    });
    const resumed = await repository.claimNextDue({
      provider: "alpaca",
      partitionKey: first.partitionKey,
      claimedAt: "2026-11-12T08:00:04.000Z",
      leaseExpiresAt: "2026-11-12T08:01:04.000Z",
      proposedWindow: window,
    });
    const failedRun = await repository.startRun(
      resumed!.lease,
      "2026-11-12T08:00:05.000Z",
    );
    await repository.failRun({
      lease: resumed!.lease,
      runId: failedRun,
      failedAt: "2026-11-12T08:00:06.000Z",
      nextDueAt: "2026-11-12T08:00:10.000Z",
      error: {
        code: "invalid_cursor",
        stage: "provider_fetch",
        message:
          "Bearer top-secret-value api_key=also-secret https://example.test/?token=third-secret",
        retryable: false,
      },
    });

    expect(
      sqlite
        .prepare(
          "SELECT resume_cursor, window_end, high_water_mark, total_failures FROM provider_ingestion_checkpoints WHERE provider = 'alpaca'",
        )
        .get(),
    ).toMatchObject({
      resume_cursor: null,
      window_end: null,
      high_water_mark: null,
      total_failures: 1,
    });
    const storedError = sqlite
      .prepare(
        "SELECT code, safe_message, retryable FROM provider_ingestion_run_errors",
      )
      .get() as { code: string; safe_message: string; retryable: number };
    expect(storedError).toMatchObject({ code: "invalid_cursor", retryable: 0 });
    expect(storedError.safe_message).toContain("[redacted]");
    expect(storedError.safe_message).not.toContain("top-secret-value");
    expect(storedError.safe_message).not.toContain("also-secret");
    expect(storedError.safe_message).not.toContain("third-secret");
  });

  it("rejects full provider bodies and stale lease tokens", async () => {
    const claim = await ensureAndClaim();
    const runId = await repository.startRun(
      claim.lease,
      "2026-11-12T08:00:01.000Z",
    );
    const unsafePayload = JSON.stringify({
      source_event_id: "news-unsafe",
      article_content: "A full provider body must not be retained.",
    });
    await expect(
      repository.persistPage({
        lease: claim.lease,
        runId,
        receipts: [
          await receipt({
            sourceEventId: "news-unsafe",
            rawPayload: unsafePayload,
            rawPayloadHash: await sha256Hex(unsafePayload),
          }),
        ],
        nextCursor: null,
        persistedAt: "2026-11-12T08:00:02.000Z",
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      repository.persistPage({
        lease: claim.lease,
        runId,
        receipts: [],
        nextCursor: null,
        persistedAt: "2026-11-12T08:02:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "lease_lost" });
  });

  it("bounds terminal run telemetry per provider partition", async () => {
    for (let index = 0; index < 105; index += 1) {
      sqlite
        .prepare(
          `INSERT INTO provider_ingestion_runs (
            id, provider, partition_key, lease_token, window_start, window_end,
            window_fingerprint, status, started_at, completed_at
          ) VALUES (?, 'alpaca', 'news:configured-v1', ?, ?, ?, ?, 'succeeded', ?, ?)`,
        )
        .run(
          `old-run-${index}`,
          `old-lease-${index}`,
          window.start,
          window.end,
          window.fingerprint,
          `2026-11-11T07:${String(index % 60).padStart(2, "0")}:00.000Z`,
          `2026-11-11T07:${String(index % 60).padStart(2, "0")}:30.000Z`,
        );
    }
    const claim = await ensureAndClaim();
    const runId = await repository.startRun(
      claim.lease,
      "2026-11-12T08:00:01.000Z",
    );
    await repository.persistPage({
      lease: claim.lease,
      runId,
      receipts: [],
      nextCursor: null,
      persistedAt: "2026-11-12T08:00:02.000Z",
    });
    await repository.completeRun({
      lease: claim.lease,
      runId,
      completedAt: "2026-11-12T08:00:03.000Z",
      nextDueAt: "2026-11-12T09:00:00.000Z",
      hasMore: false,
      highWaterMark: window.end,
    });

    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM provider_ingestion_runs WHERE provider = 'alpaca' AND partition_key = 'news:configured-v1'",
        )
        .get(),
    ).toMatchObject({ count: 100 });
  });
});
