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
import {
  AI_VIEW_CACHE_MAX_TTL_MS,
  createAiGuardrailsRepository,
  createAiViewCacheKey,
  type AiGuardrailsOperationalRepository,
} from "@/lib/ai/guardrails-repository";

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
    "0005_ai_guardrails_v1.sql",
  ]) {
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

  it("atomically bounds daily/rolling usage and replays active requests", async () => {
    const attempts = await Promise.all(
      ["request-0001", "request-0002", "request-0003"].map((requestId) =>
        repository.reserveBudget(reservationInput({ requestId })),
      ),
    );
    expect(attempts.filter((result) => result.granted)).toHaveLength(2);
    expect(attempts.filter((result) => !result.granted)).toHaveLength(1);
    const accepted = attempts.find((result) => result.granted);
    expect(accepted?.granted).toBe(true);
    if (!accepted?.granted) throw new Error("expected reservation");

    const activeReplay = await repository.reserveBudget(
      reservationInput({ requestId: "request-0001" }),
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
      requestId: "shared-request-id",
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
    const first = firstGuard.execute({ ...input, generate: firstGenerate });
    await vi.waitFor(() => expect(firstGenerate).toHaveBeenCalledOnce());

    await expect(
      secondGuard.execute({ ...input, generate: secondGenerate }),
    ).rejects.toMatchObject({
      code: "ai_rate_limited",
      budgetReason: "concurrency_limit",
    });
    expect(secondGenerate).not.toHaveBeenCalled();

    release({ headline: "single generation" });
    await expect(first).resolves.toMatchObject({
      value: { headline: "single generation" },
      meta: { source: "generated" },
    });
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
      reservationInput({ requestId: "request-success" }),
    );
    const second = await repository.reserveBudget(
      reservationInput({ requestId: "request-failure" }),
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
      budgetReservationsPruned: 1,
    });
  });
});
