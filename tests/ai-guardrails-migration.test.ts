import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
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
    expect(journal.entries.at(-1)).toEqual({
      idx: 5,
      tag: "0005_ai_guardrails_v1",
      version: "6",
      when: expect.any(Number),
      breakpoints: true,
    });
  });

  it.each([
    ["ai_view_cache_entries", aiViewCacheEntries],
    ["ai_model_budget_reservations", aiModelBudgetReservations],
  ] as const)("matches generated columns and checks for %s", (name, table) => {
    const snapshot = readJson<Snapshot>("drizzle/meta/0005_snapshot.json");
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
});
