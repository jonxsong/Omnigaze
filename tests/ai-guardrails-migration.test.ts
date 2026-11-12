import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  aiDailyBriefCacheEntries,
  aiModelBudgetReservations,
  aiViewCacheEntries,
} from "@/db/schema";

type SnapshotTable = {
  columns: Record<string, unknown>;
  checkConstraints: Record<string, unknown>;
};

type Snapshot = {
  id: string;
  prevId: string;
  tables: Record<string, SnapshotTable>;
};

function readJson<T>(path: string) {
  return JSON.parse(readFileSync(resolve(process.cwd(), path), "utf8")) as T;
}

function migrationSql(name: string) {
  return readFileSync(resolve(process.cwd(), "drizzle", name), "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
}

describe("AI guardrail migration artifacts", () => {
  it("chains and registers additive migration 0005", () => {
    const previous = readJson<Snapshot>("drizzle/meta/0004_snapshot.json");
    const current = readJson<Snapshot>("drizzle/meta/0005_snapshot.json");
    const journal = readJson<{
      entries: Array<{
        idx: number;
        tag: string;
        version: string;
        when: number;
        breakpoints: boolean;
      }>;
    }>("drizzle/meta/_journal.json");

    expect(current.prevId).toBe(previous.id);
    expect(journal.entries.find((entry) => entry.idx === 5)).toEqual({
      idx: 5,
      tag: "0005_ai_guardrails_v1",
      version: "6",
      when: expect.any(Number),
      breakpoints: true,
    });
  });

  it("chains and registers additive migration 0006", () => {
    const previous = readJson<Snapshot>("drizzle/meta/0005_snapshot.json");
    const current = readJson<Snapshot>("drizzle/meta/0006_snapshot.json");
    const journal = readJson<{
      entries: Array<{
        idx: number;
        tag: string;
        version: string;
        when: number;
        breakpoints: boolean;
      }>;
    }>("drizzle/meta/_journal.json");

    expect(current.prevId).toBe(previous.id);
    expect(journal.entries.find((entry) => entry.idx === 6)).toEqual({
      idx: 6,
      tag: "0006_daily_brief_guardrails_v1",
      version: "6",
      when: expect.any(Number),
      breakpoints: true,
    });
  });

  it.each([
    ["ai_view_cache_entries", aiViewCacheEntries, "0005"],
    ["ai_model_budget_reservations", aiModelBudgetReservations, "0006"],
    ["ai_daily_brief_cache_entries", aiDailyBriefCacheEntries, "0006"],
  ] as const)("matches generated columns and checks for %s", (name, table, version) => {
    const snapshot = readJson<Snapshot>(`drizzle/meta/${version}_snapshot.json`);
    const config = getTableConfig(table);

    expect(Object.keys(snapshot.tables[name].columns).sort()).toEqual(
      config.columns.map((column) => column.name).sort(),
    );
    expect(Object.keys(snapshot.tables[name].checkConstraints).sort()).toEqual(
      config.checks.map((constraint) => constraint.name).sort(),
    );
  });

  it("is create-only and keeps cache identity separate from legacy views", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "drizzle/0005_ai_guardrails_v1.sql"),
      "utf8",
    );

    expect(migration.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(migration).not.toMatch(/\b(?:DROP|ALTER)\s+TABLE\b/i);
    expect(migration).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(migration).not.toContain("`omnigaze_views`");
    expect(migration).toContain("`model_key` text NOT NULL");
    expect(migration).toContain("`lease_expires_at` text NOT NULL");
    expect(migration).toContain("`request_key_hash` text NOT NULL");
    expect(migration).not.toContain("`request_id`");
    expect(migration).toContain("json_valid(response_json)");
    expect(migration).toContain("status IN ('reserved', 'completed', 'failed')");
  });

  it("preserves deployed reservations while widening operation safely", () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      sqlite.exec(migrationSql("0005_ai_guardrails_v1.sql"));
      sqlite
        .prepare(`
          INSERT INTO ai_model_budget_reservations (
            reservation_id, owner_id, request_key_hash, operation,
            operation_key_hash, cost, day_start, status, reserved_at,
            lease_expires_at, completed_at, safe_error_code
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          "reservation-existing",
          "owner-existing",
          "a".repeat(64),
          "omnigaze_view",
          "b".repeat(64),
          1,
          "2026-11-12",
          "completed",
          "2026-11-12T12:00:00.000Z",
          "2026-11-12T12:01:30.000Z",
          "2026-11-12T12:00:20.000Z",
          null,
        );

      sqlite.exec(migrationSql("0006_daily_brief_guardrails_v1.sql"));

      expect(
        sqlite
          .prepare(
            "SELECT reservation_id, owner_id, operation, status FROM ai_model_budget_reservations",
          )
          .get(),
      ).toEqual({
        reservation_id: "reservation-existing",
        owner_id: "owner-existing",
        operation: "omnigaze_view",
        status: "completed",
      });
      expect(() =>
        sqlite
          .prepare(`
            INSERT INTO ai_model_budget_reservations (
              reservation_id, owner_id, request_key_hash, operation,
              operation_key_hash, cost, day_start, status, reserved_at,
              lease_expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
          `)
          .run(
            "reservation-daily",
            "owner-existing",
            "c".repeat(64),
            "daily_brief",
            "d".repeat(64),
            1,
            "2026-11-12",
            "2026-11-12T12:02:00.000Z",
            "2026-11-12T12:03:30.000Z",
          ),
      ).not.toThrow();
      expect(() =>
        sqlite
          .prepare(`
            INSERT INTO ai_model_budget_reservations (
              reservation_id, owner_id, request_key_hash, operation,
              operation_key_hash, cost, day_start, status, reserved_at,
              lease_expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
          `)
          .run(
            "reservation-invalid",
            "owner-existing",
            "e".repeat(64),
            "unsupported_operation",
            "f".repeat(64),
            1,
            "2026-11-12",
            "2026-11-12T12:04:00.000Z",
            "2026-11-12T12:05:30.000Z",
          ),
      ).toThrow();
    } finally {
      sqlite.close();
    }
  });

  it("creates a bounded owner-scoped Daily Brief cache", () => {
    const migration = migrationSql("0006_daily_brief_guardrails_v1.sql");

    expect(migration).toContain("CREATE TABLE `ai_daily_brief_cache_entries`");
    expect(migration).toContain("PRIMARY KEY(`owner_id`, `cache_key`)");
    expect(migration).toContain("json_valid(response_json)");
    expect(migration).toContain("julianday(generated_at) + 1");
    expect(migration).toContain(
      "operation IN ('omnigaze_view', 'daily_brief')",
    );
    expect(migration).not.toContain("`request_id`");
    expect(migration.indexOf("INSERT INTO `__new_ai_model_budget_reservations`")).toBeLessThan(
      migration.indexOf("DROP TABLE `ai_model_budget_reservations`"),
    );
  });
});
