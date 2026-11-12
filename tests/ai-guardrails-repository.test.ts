import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@/db/schema";
import {
  OmnigazeAiGuard,
  type AiViewCacheLookup,
} from "@/lib/ai/omnigaze-view-guard";
import { buildDailyBriefCacheKey } from "@/lib/ai/daily-brief-fingerprint";
import {
  AI_GUARDRAILS_OPPORTUNISTIC_PRUNE_LIMIT,
  AI_VIEW_CACHE_MAX_TTL_MS,
  createAiGuardrailsRepository,
  createAiViewCacheKey,
  DAILY_BRIEF_CACHE_MAX_TTL_MS,
  type AiGuardrailsOperationalRepository,
  type DailyBriefCacheWrite,
} from "@/lib/ai/guardrails-repository";

vi.mock("cloudflare:workers", () => ({ env: {} }));

function migrationSql(name: string) {
  return readFileSync(resolve(process.cwd(), "drizzle", name), "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
}

function createTestDatabase({ includeDailyBrief = true } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const migrations = [
    "0000_damp_robbie_robertson.sql",
    "0001_thick_reptil.sql",
    "0002_portfolio_v1.sql",
    "0003_intelligence_inbox_v1.sql",
    "0004_ingestion_control_plane_v1.sql",
    "0005_ai_guardrails_v1.sql",
  ];
  if (includeDailyBrief) migrations.push("0006_daily_brief_guardrails_v1.sql");
  for (const migration of migrations) {
    sqlite.exec(migrationSql(migration));
  }
  const database = drizzle(
    async (query, params, method) => {
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

const lookup: AiViewCacheLookup = {
  symbolId: "NASDAQ:NVDA",
  promptVersion: "omnigaze-analysis-v3",
  modelConfig: "openai-agents-sdk-default",
  evidenceFingerprint: "a".repeat(64),
};
const NOW = "2026-11-12T12:30:00.000Z";

async function dailyBriefRecord(
  overrides: Partial<DailyBriefCacheWrite> = {},
): Promise<DailyBriefCacheWrite> {
  const identity = {
    briefDate: overrides.briefDate ?? "2026-11-12",
    promptVersion: overrides.promptVersion ?? "daily-brief-v1",
    modelConfig: overrides.modelConfig ?? "openai-agents-sdk-default",
    watchlistFingerprint: overrides.watchlistFingerprint ?? "b".repeat(64),
    evidenceFingerprint: overrides.evidenceFingerprint ?? "c".repeat(64),
  };
  return {
    ownerId: "owner-ai-guardrail-test",
    cacheKey:
      overrides.cacheKey ??
      (await buildDailyBriefCacheKey({
        promptVersion: identity.promptVersion,
        modelKey: identity.modelConfig,
        briefDate: identity.briefDate,
        watchlistFingerprint: identity.watchlistFingerprint,
        evidenceFingerprint: identity.evidenceFingerprint,
      })),
    ...identity,
    payload: { data: { headline: "Personal Daily Brief" } },
    generatedAt: NOW,
    expiresAt: "2026-11-12T18:30:00.000Z",
    ...overrides,
  };
}

function reservationInput(overrides: Record<string, unknown> = {}) {
  return {
    ownerId: "owner-ai-guardrail-test",
    operation: "omnigaze_view" as const,
    operationKey: "NASDAQ:NVDA|prompt|model|evidence",
    requestId: "request-0001",
    cost: 1,
    requestedAt: NOW,
    leaseExpiresAt: "2026-11-12T12:31:30.000Z",
    ...overrides,
  };
}

describe("AI guardrails repository", () => {
  let sqlite: DatabaseSync;
  let repository: AiGuardrailsOperationalRepository;
  let now: string;
  let reservationSequence: number;

  beforeEach(() => {
    const testDatabase = createTestDatabase();
    sqlite = testDatabase.sqlite;
    now = NOW;
    reservationSequence = 0;
    repository = createAiGuardrailsRepository(
      () => testDatabase.database as never,
      {
        dailyLimit: 2,
        rollingLimit: 2,
        concurrencyLimit: 2,
        now: () => new Date(now),
        createReservationId: () =>
          `reservation-${String(++reservationSequence).padStart(4, "0")}`,
      },
    );
  });

  afterEach(() => sqlite.close());

  it("round-trips a stable prompt/model/evidence cache identity", async () => {
    const cacheKey = await createAiViewCacheKey(lookup);
    await repository.putCachedView({
      ...lookup,
      payload: { data: { headline: "Grounded view" } },
      generatedAt: NOW,
      expiresAt: "2026-11-12T12:40:00.000Z",
    });
    await expect(repository.findCachedView(lookup)).resolves.toMatchObject({
      ...lookup,
      payload: { data: { headline: "Grounded view" } },
      generatedAt: NOW,
    });
    expect(
      sqlite
        .prepare("SELECT cache_key, hit_count FROM ai_view_cache_entries")
        .get(),
    ).toEqual({ cache_key: cacheKey, hit_count: 1 });

    await expect(
      repository.findCachedView({ ...lookup, modelConfig: "different-model" }),
    ).resolves.toBeNull();
    now = "2026-11-12T12:40:00.000Z";
    await expect(repository.findCachedView(lookup)).resolves.toBeNull();
  });

  it("rejects unsafe, oversized, and overlong cache records", async () => {
    await expect(
      repository.putCachedView({
        ...lookup,
        payload: { systemPrompt: "do not persist me" },
        generatedAt: NOW,
        expiresAt: "2026-11-12T12:40:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "cache_payload_invalid" });
    await expect(
      repository.putCachedView({
        ...lookup,
        payload: { value: "x".repeat(65 * 1_024) },
        generatedAt: NOW,
        expiresAt: "2026-11-12T12:40:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "cache_payload_invalid" });
    await expect(
      repository.putCachedView({
        ...lookup,
        payload: { ok: true },
        generatedAt: NOW,
        expiresAt: new Date(
          Date.parse(NOW) + AI_VIEW_CACHE_MAX_TTL_MS + 1,
        ).toISOString(),
      }),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("round-trips an owner-isolated Daily Brief cache identity", async () => {
    const record = await dailyBriefRecord();
    await repository.putCachedDailyBrief(record);

    await expect(
      repository.findCachedDailyBrief({
        ownerId: record.ownerId,
        cacheKey: record.cacheKey,
        now: NOW,
      }),
    ).resolves.toEqual({
      ownerId: record.ownerId,
      cacheKey: record.cacheKey,
      payload: record.payload,
      generatedAt: record.generatedAt,
      expiresAt: record.expiresAt,
    });
    await expect(
      repository.findCachedDailyBrief({
        ownerId: "different-owner",
        cacheKey: record.cacheKey,
        now: NOW,
      }),
    ).resolves.toBeNull();
    expect(
      sqlite
        .prepare(
          "SELECT owner_id, cache_key, hit_count FROM ai_daily_brief_cache_entries",
        )
        .get(),
    ).toEqual({
      owner_id: record.ownerId,
      cache_key: record.cacheKey,
      hit_count: 1,
    });

    await expect(
      repository.findCachedDailyBrief({
        ownerId: record.ownerId,
        cacheKey: record.cacheKey,
        now: record.expiresAt,
      }),
    ).resolves.toBeNull();
  });

  it("validates Daily Brief identity, payload, and TTL bounds", async () => {
    await expect(
      repository.putCachedDailyBrief(
        await dailyBriefRecord({ cacheKey: "d".repeat(64) }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
    await expect(
      repository.putCachedDailyBrief(
        await dailyBriefRecord({ payload: { rawProviderPayload: "secret" } }),
      ),
    ).rejects.toMatchObject({ code: "cache_payload_invalid" });
    await expect(
      repository.putCachedDailyBrief(
        await dailyBriefRecord({
          payload: { value: "x".repeat(65 * 1_024) },
        }),
      ),
    ).rejects.toMatchObject({ code: "cache_payload_invalid" });
    await expect(
      repository.putCachedDailyBrief(
        await dailyBriefRecord({
          expiresAt: new Date(
            Date.parse(NOW) + DAILY_BRIEF_CACHE_MAX_TTL_MS + 1,
          ).toISOString(),
        }),
      ),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("fails closed when a persisted Daily Brief projection is unsafe", async () => {
    const record = await dailyBriefRecord();
    await repository.putCachedDailyBrief(record);
    sqlite
      .prepare(
        "UPDATE ai_daily_brief_cache_entries SET response_json = ? WHERE owner_id = ? AND cache_key = ?",
      )
      .run(
        JSON.stringify({ systemPrompt: "must never be returned" }),
        record.ownerId,
        record.cacheKey,
      );

    await expect(
      repository.findCachedDailyBrief({
        ownerId: record.ownerId,
        cacheKey: record.cacheKey,
        now: NOW,
      }),
    ).rejects.toMatchObject({ code: "cache_payload_invalid" });
  });

  it("stores identical Daily Brief identities separately for each owner", async () => {
    const first = await dailyBriefRecord({ ownerId: "owner-one" });
    const second = await dailyBriefRecord({
      ownerId: "owner-two",
      payload: { data: { headline: "Owner two copy" } },
    });
    await repository.putCachedDailyBrief(first);
    await repository.putCachedDailyBrief(second);
    await repository.putCachedDailyBrief({
      ...first,
      payload: { data: { headline: "Owner one refreshed" } },
    });

    expect(
      sqlite
        .prepare(
          "SELECT owner_id, response_json FROM ai_daily_brief_cache_entries ORDER BY owner_id",
        )
        .all(),
    ).toEqual([
      {
        owner_id: "owner-one",
        response_json: JSON.stringify({
          data: { headline: "Owner one refreshed" },
        }),
      },
      {
        owner_id: "owner-two",
        response_json: JSON.stringify(second.payload),
      },
    ]);
  });

  it("atomically bounds daily/rolling usage and replays active requests", async () => {
    const attempts = await Promise.all(
      ["request-0001", "request-0002", "request-0003"].map((requestId) =>
        repository.reserveBudget(
          reservationInput({
            requestId,
            operationKey: `operation-${requestId}`,
          }),
        ),
      ),
    );
    expect(attempts.filter((result) => result.granted)).toHaveLength(2);
    expect(attempts.filter((result) => !result.granted)).toHaveLength(1);
    const accepted = attempts.find((result) => result.granted);
    expect(accepted?.granted).toBe(true);
    if (!accepted?.granted) throw new Error("expected reservation");

    const activeReplay = await repository.reserveBudget(
      reservationInput({
        requestId: "request-0001",
        operationKey: "operation-request-0001",
      }),
    );
    expect(activeReplay).toMatchObject({
      granted: false,
      reason: "concurrency_limit",
      retryAt: "2026-11-12T12:31:30.000Z",
    });
    await expect(
      repository.reserveBudget(
        reservationInput({
          requestId: "request-0001",
          operationKey: "different-input",
        }),
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM ai_model_budget_reservations")
        .get(),
    ).toEqual({ count: 2 });
  });

  it.each(["omnigaze_view", "daily_brief"] as const)(
    "deduplicates active %s operation identities across distinct requests",
    async (operation) => {
      const firstInput = reservationInput({
        operation,
        operationKey: `same-${operation}-identity`,
        requestId: `first-${operation}-request`,
        leaseExpiresAt: "2026-11-12T12:31:15.000Z",
      });
      await expect(repository.reserveBudget(firstInput)).resolves.toMatchObject({
        granted: true,
      });
      await expect(
        repository.reserveBudget(
          reservationInput({
            operation,
            operationKey: firstInput.operationKey,
            requestId: `second-${operation}-request`,
            requestedAt: "2026-11-12T12:30:10.000Z",
            leaseExpiresAt: "2026-11-12T12:31:40.000Z",
          }),
        ),
      ).resolves.toMatchObject({
        granted: false,
        reason: "concurrency_limit",
        remaining: 1,
        retryAt: firstInput.leaseExpiresAt,
      });
      expect(
        sqlite
          .prepare(
            "SELECT COUNT(*) AS count FROM ai_model_budget_reservations",
          )
          .get(),
      ).toEqual({ count: 1 });
    },
  );

  it("shares one atomic owner budget across view and Daily Brief operations", async () => {
    const dailyBriefInput = reservationInput({
      operation: "daily_brief",
      operationKey: "daily-brief-cache-key",
      requestId: "request-daily-brief",
    });
    const brief = await repository.reserveBudget(dailyBriefInput);
    await expect(repository.reserveBudget(dailyBriefInput)).resolves.toMatchObject({
      granted: false,
      reason: "concurrency_limit",
      retryAt: dailyBriefInput.leaseExpiresAt,
    });
    const view = await repository.reserveBudget(
      reservationInput({ requestId: "request-view" }),
    );
    expect(brief.granted).toBe(true);
    expect(view.granted).toBe(true);
    await expect(
      repository.getBudgetUsage("owner-ai-guardrail-test", NOW),
    ).resolves.toMatchObject({
      dailyUsed: 2,
      dailyRemaining: 0,
      rollingUsed: 2,
      rollingRemaining: 0,
      activeReservations: 2,
      concurrencyRemaining: 0,
    });
    await expect(
      repository.reserveBudget(
        reservationInput({
          operation: "daily_brief",
          operationKey: "another-daily-brief-cache-key",
          requestId: "request-over-shared-limit",
        }),
      ),
    ).resolves.toMatchObject({
      granted: false,
      reason: "daily_limit",
      remaining: 0,
    });
    expect(
      sqlite
        .prepare(
          "SELECT operation FROM ai_model_budget_reservations ORDER BY operation",
        )
        .all(),
    ).toEqual([
      { operation: "daily_brief" },
      { operation: "omnigaze_view" },
    ]);
    const hashes = sqlite
      .prepare(
        "SELECT request_key_hash, operation_key_hash FROM ai_model_budget_reservations WHERE operation = 'daily_brief'",
      )
      .get() as { request_key_hash: string; operation_key_hash: string };
    expect(hashes.request_key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashes.operation_key_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(hashes)).not.toContain("request-daily-brief");
    expect(JSON.stringify(hashes)).not.toContain("daily-brief-cache-key");

    await expect(
      repository.reserveBudget(
        reservationInput({
          ownerId: "different-owner",
          operation: "daily_brief",
          operationKey: "daily-brief-cache-key",
          requestId: "request-daily-brief",
        }),
      ),
    ).resolves.toMatchObject({ granted: true });
  });

  it("keeps request idempotency hashes conflict-safe across operations", async () => {
    await repository.reserveBudget(
      reservationInput({ requestId: "cross-operation-request" }),
    );
    await expect(
      repository.reserveBudget(
        reservationInput({
          operation: "daily_brief",
          operationKey: "daily-brief-cache-key",
          requestId: "cross-operation-request",
        }),
      ),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("enforces active concurrency and reclaims the same expired request", async () => {
    const testDatabase = createTestDatabase();
    sqlite.close();
    sqlite = testDatabase.sqlite;
    let sequence = 0;
    repository = createAiGuardrailsRepository(
      () => testDatabase.database as never,
      {
        dailyLimit: 10,
        rollingLimit: 10,
        concurrencyLimit: 1,
        createReservationId: () => `lease-reservation-${++sequence}`,
      },
    );
    const firstInput = reservationInput({
      leaseExpiresAt: "2026-11-12T12:31:00.000Z",
    });
    const first = await repository.reserveBudget(firstInput);
    expect(first.granted).toBe(true);
    await expect(
      repository.reserveBudget(
        reservationInput({
          requestId: "request-0002",
          operationKey: "other-concurrency-operation",
          requestedAt: "2026-11-12T12:30:10.000Z",
          leaseExpiresAt: "2026-11-12T12:31:10.000Z",
        }),
      ),
    ).resolves.toMatchObject({
      granted: false,
      reason: "concurrency_limit",
      retryAt: "2026-11-12T12:31:00.000Z",
    });
    const activeReplay = await repository.reserveBudget(firstInput);
    expect(activeReplay).toMatchObject({
      granted: false,
      reason: "concurrency_limit",
      retryAt: "2026-11-12T12:31:00.000Z",
    });

    const reclaimed = await repository.reserveBudget(
      reservationInput({
        requestedAt: "2026-11-12T12:31:00.000Z",
        leaseExpiresAt: "2026-11-12T12:32:00.000Z",
      }),
    );
    expect(reclaimed.granted).toBe(true);
    if (first.granted && reclaimed.granted) {
      expect(reclaimed.reservationId).not.toBe(first.reservationId);
      await expect(
        repository.completeBudget({
          reservationId: first.reservationId,
          outcome: "succeeded",
          completedAt: "2026-11-12T12:31:01.000Z",
        }),
      ).rejects.toMatchObject({ code: "reservation_not_found" });
    }
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM ai_model_budget_reservations")
        .get(),
    ).toEqual({ count: 1 });
  });

  it("prevents a cross-isolate active retry from invoking the model twice", async () => {
    let release: (value: { headline: string }) => void = () => undefined;
    const pending = new Promise<{ headline: string }>((resolve) => {
      release = resolve;
    });
    const firstGenerate = vi.fn(() => pending);
    const secondGenerate = vi.fn(async () => ({ headline: "duplicate" }));
    const codec = {
      encode: (value: { headline: string }) => value,
      decode: (value: unknown) => value as { headline: string },
    };
    const guardOptions = { now: () => new Date(NOW) };
    const firstGuard = new OmnigazeAiGuard(repository, codec, guardOptions);
    const secondGuard = new OmnigazeAiGuard(repository, codec, guardOptions);
    const input = {
      ownerId: "owner-ai-guardrail-test",
      symbolId: "NASDAQ:NVDA" as const,
      promptVersion: "omnigaze-analysis-v3",
      modelConfig: "openai-agents-sdk-default",
      freshness: {
        state: "fresh" as const,
        asOf: NOW,
        maximumAgeSeconds: 300,
      },
      fingerprint: {
        evidence: [
          {
            id: "evidence-1",
            revisionAt: NOW,
            contentHash: "a".repeat(64),
          },
        ],
      },
    };
    const first = firstGuard.execute({
      ...input,
      requestId: "first-isolate-request",
      generate: firstGenerate,
    });
    await vi.waitFor(() => expect(firstGenerate).toHaveBeenCalledOnce());

    await expect(
      secondGuard.execute({
        ...input,
        requestId: "second-isolate-request",
        generate: secondGenerate,
      }),
    ).rejects.toMatchObject({
      code: "ai_rate_limited",
      budgetReason: "concurrency_limit",
      retryAt: "2026-11-12T12:31:30.000Z",
    });
    expect(secondGenerate).not.toHaveBeenCalled();

    release({ headline: "single generation" });
    await expect(first).resolves.toMatchObject({
      value: { headline: "single generation" },
      meta: { source: "generated" },
    });
    await expect(
      secondGuard.execute({
        ...input,
        requestId: "second-isolate-request",
        generate: secondGenerate,
      }),
    ).resolves.toMatchObject({
      value: { headline: "single generation" },
      meta: { source: "cache", budget: { charged: false } },
    });
    expect(secondGenerate).not.toHaveBeenCalled();
  });

  it("reports rolling capacity separately from daily and concurrency limits", async () => {
    const testDatabase = createTestDatabase();
    sqlite.close();
    sqlite = testDatabase.sqlite;
    repository = createAiGuardrailsRepository(
      () => testDatabase.database as never,
      {
        dailyLimit: 10,
        rollingLimit: 1,
        concurrencyLimit: 10,
        createReservationId: () => `rolling-reservation-${crypto.randomUUID()}`,
      },
    );
    await repository.reserveBudget(reservationInput());
    await expect(
      repository.reserveBudget(
        reservationInput({
          requestId: "request-rolling-2",
          operationKey: "rolling-operation-2",
          requestedAt: "2026-11-12T12:30:10.000Z",
          leaseExpiresAt: "2026-11-12T12:31:10.000Z",
        }),
      ),
    ).resolves.toMatchObject({
      granted: false,
      reason: "rolling_limit",
      remaining: 9,
      retryAt: "2026-11-12T12:31:01.000Z",
    });
  });

  it("completes reservations idempotently and keeps failed attempts charged", async () => {
    const first = await repository.reserveBudget(
      reservationInput({
        requestId: "request-success",
        operationKey: "successful-operation",
      }),
    );
    const second = await repository.reserveBudget(
      reservationInput({
        requestId: "request-failure",
        operationKey: "failed-operation",
      }),
    );
    if (!first.granted || !second.granted) throw new Error("expected grants");
    const success = {
      reservationId: first.reservationId,
      outcome: "succeeded" as const,
      completedAt: "2026-11-12T12:30:20.000Z",
    };
    await expect(repository.completeBudget(success)).resolves.toBeUndefined();
    await expect(repository.completeBudget(success)).resolves.toBeUndefined();
    await expect(
      repository.completeBudget({
        ...success,
        completedAt: "2026-11-12T12:30:21.000Z",
      }),
    ).resolves.toBeUndefined();
    await repository.completeBudget({
      reservationId: second.reservationId,
      outcome: "failed",
      completedAt: "2026-11-12T12:30:10.000Z",
    });
    await expect(
      repository.reserveBudget(reservationInput({ requestId: "request-after" })),
    ).resolves.toMatchObject({ granted: false, reason: "daily_limit" });
    await expect(
      repository.getBudgetUsage("owner-ai-guardrail-test", NOW),
    ).resolves.toMatchObject({ dailyUsed: 2, activeReservations: 0 });
  });

  it("opportunistically prunes bounded expired state after durable admission", async () => {
    const generatedAt = "2026-11-01T00:00:00.000Z";
    await repository.putCachedView({
      ...lookup,
      payload: { old: true },
      generatedAt,
      expiresAt: "2026-11-01T00:10:00.000Z",
    });
    await repository.putCachedDailyBrief(
      await dailyBriefRecord({
        briefDate: "2026-11-01",
        generatedAt,
        expiresAt: "2026-11-01T06:00:00.000Z",
      }),
    );
    const insertOldReservation = sqlite.prepare(`
      INSERT INTO ai_model_budget_reservations (
        reservation_id, owner_id, request_key_hash, operation,
        operation_key_hash, cost, day_start, status, reserved_at,
        lease_expires_at, completed_at, safe_error_code
      ) VALUES (?, ?, ?, 'omnigaze_view', ?, 1, '2026-11-01', 'completed',
        '2026-11-01T00:00:00.000Z', '2026-11-01T00:01:30.000Z',
        '2026-11-01T00:00:20.000Z', NULL)
    `);
    for (
      let index = 0;
      index < AI_GUARDRAILS_OPPORTUNISTIC_PRUNE_LIMIT + 1;
      index += 1
    ) {
      const digest = index.toString(16).padStart(64, "0");
      insertOldReservation.run(
        `old-reservation-${String(index).padStart(3, "0")}`,
        "owner-old-cleanup",
        digest,
        digest,
      );
    }

    await expect(
      repository.reserveBudget(
        reservationInput({
          operationKey: "cleanup-trigger-operation",
          requestId: "cleanup-trigger-request",
        }),
      ),
    ).resolves.toMatchObject({ granted: true });

    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM ai_view_cache_entries").get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM ai_daily_brief_cache_entries")
        .get(),
    ).toEqual({ count: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM ai_model_budget_reservations WHERE reserved_at < '2026-11-05T00:00:00.000Z'",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM ai_model_budget_reservations WHERE reserved_at >= '2026-11-05T00:00:00.000Z'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("keeps an admitted reservation when best-effort cleanup fails", async () => {
    const testDatabase = createTestDatabase({ includeDailyBrief: false });
    sqlite.close();
    sqlite = testDatabase.sqlite;
    repository = createAiGuardrailsRepository(
      () => testDatabase.database as never,
      {
        dailyLimit: 2,
        rollingLimit: 2,
        concurrencyLimit: 2,
        createReservationId: () => "reservation-cleanup-failure",
      },
    );

    await expect(
      repository.reserveBudget(
        reservationInput({
          operationKey: "cleanup-failure-operation",
          requestId: "cleanup-failure-request",
        }),
      ),
    ).resolves.toMatchObject({ granted: true });
    expect(
      sqlite
        .prepare(
          "SELECT reservation_id, status FROM ai_model_budget_reservations",
        )
        .get(),
    ).toEqual({
      reservation_id: "reservation-cleanup-failure",
      status: "reserved",
    });
  });

  it("prunes expired cache and old budget rows in bounded batches", async () => {
    const old = "2026-11-03T12:00:00.000Z";
    await repository.putCachedView({
      ...lookup,
      payload: { old: true },
      generatedAt: old,
      expiresAt: "2026-11-03T12:10:00.000Z",
    });
    await repository.reserveBudget(
      reservationInput({
        requestId: "request-old",
        requestedAt: old,
        leaseExpiresAt: "2026-11-03T12:01:00.000Z",
      }),
    );
    await expect(repository.prune(NOW, 1)).resolves.toEqual({
      cacheEntriesPruned: 1,
      dailyBriefCacheEntriesPruned: 0,
      budgetReservationsPruned: 1,
    });
  });

  it("prunes expired Daily Brief entries in owner-safe bounded batches", async () => {
    const generatedAt = "2026-11-11T00:00:00.000Z";
    const expiresAt = "2026-11-11T06:00:00.000Z";
    const first = await dailyBriefRecord({
      ownerId: "owner-one",
      briefDate: "2026-11-11",
      generatedAt,
      expiresAt,
    });
    const second = await dailyBriefRecord({
      ownerId: "owner-two",
      briefDate: "2026-11-11",
      generatedAt,
      expiresAt,
    });
    expect(second.cacheKey).toBe(first.cacheKey);
    await repository.putCachedDailyBrief(first);
    await repository.putCachedDailyBrief(second);

    await expect(repository.pruneDailyBriefCache(NOW, 1)).resolves.toBe(1);
    expect(
      sqlite
        .prepare("SELECT COUNT(*) AS count FROM ai_daily_brief_cache_entries")
        .get(),
    ).toEqual({ count: 1 });
    await expect(repository.prune(NOW, 1)).resolves.toEqual({
      cacheEntriesPruned: 0,
      dailyBriefCacheEntriesPruned: 1,
      budgetReservationsPruned: 0,
    });
  });
});
