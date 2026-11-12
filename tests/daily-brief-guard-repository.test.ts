import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@/db/schema";
import { DailyBriefGenerationGuard } from "@/lib/ai/daily-brief-guard";
import { buildDailyBriefCacheKey } from "@/lib/ai/daily-brief-fingerprint";
import { createAiGuardrailsRepository } from "@/lib/ai/guardrails-repository";

vi.mock("cloudflare:workers", () => ({ env: {} }));

function migrationSql(name: string) {
  return readFileSync(resolve(process.cwd(), "drizzle", name), "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
}

function testDatabase() {
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

const codec = {
  encode(value: { headline: string }) {
    return { headline: value.headline };
  },
  decode(value: unknown) {
    if (
      !value ||
      typeof value !== "object" ||
      typeof (value as { headline?: unknown }).headline !== "string"
    ) {
      throw new Error("invalid payload");
    }
    return { headline: (value as { headline: string }).headline };
  },
};

describe("Daily Brief guard with durable repository", () => {
  let sqlite: DatabaseSync | null = null;

  afterEach(() => {
    sqlite?.close();
    sqlite = null;
  });

  it("allows one cross-isolate generation and safely denies an active duplicate lease", async () => {
    const test = testDatabase();
    sqlite = test.sqlite;
    let reservation = 0;
    const now = new Date("2026-11-12T18:00:00.000Z");
    const repository = createAiGuardrailsRepository(
      () => test.database as never,
      {
        dailyLimit: 20,
        rollingLimit: 20,
        concurrencyLimit: 2,
        now: () => now,
        createReservationId: () =>
          `reservation-${String(++reservation).padStart(4, "0")}`,
      },
    );
    const identity = {
      briefDate: "2026-11-12",
      promptVersion: "2026-11-12.1",
      modelConfig: "test-model",
      watchlistFingerprint: "b".repeat(64),
      evidenceFingerprint: "c".repeat(64),
      cacheKey: await buildDailyBriefCacheKey({
        briefDate: "2026-11-12",
        promptVersion: "2026-11-12.1",
        modelKey: "test-model",
        watchlistFingerprint: "b".repeat(64),
        evidenceFingerprint: "c".repeat(64),
      }),
    };
    const firstGuard = new DailyBriefGenerationGuard(repository, codec, {
      now: () => now,
    });
    const secondGuard = new DailyBriefGenerationGuard(repository, codec, {
      now: () => now,
    });
    let release: (value: { headline: string }) => void = () => undefined;
    const pending = new Promise<{ headline: string }>((resolvePromise) => {
      release = resolvePromise;
    });
    const firstGenerate = vi.fn(() => pending);
    const secondGenerate = vi.fn(async () => ({ headline: "Duplicate" }));
    const shared = {
      ownerId: "owner-cross-isolate",
      identity,
      freshness: {
        state: "fresh" as const,
        asOf: "2026-11-12T17:59:00.000Z",
        maximumAgeSeconds: 86_400,
      },
    };

    const first = firstGuard.execute({
      ...shared,
      requestId: "request-first-isolate",
      generate: firstGenerate,
    });
    await vi.waitFor(() => expect(firstGenerate).toHaveBeenCalledOnce());
    await expect(
      secondGuard.execute({
        ...shared,
        requestId: "request-second-isolate",
        generate: secondGenerate,
      }),
    ).rejects.toMatchObject({
      code: "ai_rate_limited",
      budgetReason: "concurrency_limit",
      retryAt: "2026-11-12T18:01:30.000Z",
    });
    expect(secondGenerate).not.toHaveBeenCalled();

    release({ headline: "One durable generation" });
    await expect(first).resolves.toMatchObject({
      value: { headline: "One durable generation" },
      meta: { budget: { charged: true } },
    });
    await expect(
      secondGuard.execute({
        ...shared,
        requestId: "request-second-isolate",
        generate: secondGenerate,
      }),
    ).resolves.toMatchObject({
      value: { headline: "One durable generation" },
      meta: { source: "cache", budget: { charged: false } },
    });
    expect(secondGenerate).not.toHaveBeenCalled();
    expect(
      sqlite
        .prepare(
          "SELECT operation, status, COUNT(*) AS count FROM ai_model_budget_reservations GROUP BY operation, status",
        )
        .get(),
    ).toEqual({ operation: "daily_brief", status: "completed", count: 1 });
  });
});
