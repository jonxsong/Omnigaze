import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  portfolioHoldings,
  portfolioProfiles,
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

describe("portfolio migration artifacts", () => {
  it("keeps the generated snapshot chained to 0001 and registered in the journal", () => {
    const previous = readJson<Snapshot>("drizzle/meta/0001_snapshot.json");
    const current = readJson<Snapshot>("drizzle/meta/0002_snapshot.json");
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
      idx: 2,
      tag: "0002_portfolio_v1",
      version: "6",
      when: expect.any(Number),
      breakpoints: true,
    });
  });

  it.each([
    ["portfolio_holdings", portfolioHoldings],
    ["portfolio_profiles", portfolioProfiles],
  ] as const)("matches schema columns and checks for %s", (tableName, table) => {
    const snapshot = readJson<Snapshot>("drizzle/meta/0002_snapshot.json");
    const snapshotTable = snapshot.tables[tableName];
    const config = getTableConfig(table);

    expect(Object.keys(snapshotTable.columns).sort()).toEqual(
      config.columns.map((column) => column.name).sort(),
    );
    expect(Object.keys(snapshotTable.checkConstraints).sort()).toEqual(
      config.checks.map((constraint) => constraint.name).sort(),
    );
  });

  it("contains only additive portfolio DDL in the 0002 migration", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "drizzle/0002_portfolio_v1.sql"),
      "utf8",
    );

    expect(migration.match(/CREATE TABLE/g)).toHaveLength(2);
    expect(migration).toContain("portfolio_holdings");
    expect(migration).toContain("portfolio_profiles");
    expect(migration).not.toMatch(/\b(?:DROP|ALTER)\s+TABLE\b/i);
  });
});
