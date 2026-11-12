import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@/db/schema";

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
}));

vi.mock("@/db", () => ({ getDb: mocks.getDb }));
vi.mock("cloudflare:workers", () => ({ env: {} }));

import { getPortfolioPulseHoldings } from "@/lib/repositories/portfolio";

function migrationSql(name: string) {
  return readFileSync(resolve(process.cwd(), "drizzle", name), "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
}

function createTestDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  sqlite.exec(migrationSql("0000_damp_robbie_robertson.sql"));
  sqlite.exec(migrationSql("0002_portfolio_v1.sql"));
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const database = drizzle(
    async (query, params, method) => {
      queries.push({ sql: query, params });
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
  return { sqlite, database, queries };
}

function compareCanonicalSymbols(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function seedHolding(
  sqlite: DatabaseSync,
  ownerId: string,
  symbolId: string,
  quantityMicros = 1_000_000,
) {
  const [exchange, ticker] = symbolId.split(":");
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO instruments (
        id, ticker, exchange, name, sector, currency, status
      ) VALUES (?, ?, ?, ?, NULL, 'USD', 'active')`,
    )
    .run(symbolId, ticker, exchange, `${ticker} Incorporated`);
  sqlite
    .prepare(
      `INSERT INTO portfolio_holdings (
        owner_id, symbol_id, quantity_micros, average_cost_micros,
        cost_currency, quantity_as_of, entry_source, version
      ) VALUES (?, ?, ?, 90000000, 'USD', ?, 'user_entered', 1)`,
    )
    .run(ownerId, symbolId, quantityMicros, "2026-11-12T08:00:00.000Z");
}

describe("Portfolio Pulse holdings repository read", () => {
  let sqlite: DatabaseSync;
  let queries: Array<{ sql: string; params: unknown[] }>;

  beforeEach(() => {
    const testDatabase = createTestDatabase();
    sqlite = testDatabase.sqlite;
    queries = testDatabase.queries;
    mocks.getDb.mockReset();
    mocks.getDb.mockReturnValue(testDatabase.database as never);
  });

  afterEach(() => sqlite.close());

  it("counts only the owner and selects the first fifty canonical symbols at D1", async () => {
    const ownerSymbols = Array.from({ length: 55 }, (_, index) => {
      const exchange = index % 2 === 0 ? "NYSE" : "NASDAQ";
      return `${exchange}:T${index.toString().padStart(2, "0")}`;
    });
    sqlite.exec("BEGIN");
    for (const symbolId of [...ownerSymbols].reverse()) {
      seedHolding(sqlite, "owner-a", symbolId);
    }
    seedHolding(sqlite, "owner-b", "AMEX:PRIVATE");
    sqlite.exec("COMMIT");

    const result = await getPortfolioPulseHoldings("owner-a");
    const expected = [...ownerSymbols]
      .sort(compareCanonicalSymbols)
      .slice(0, 50);

    expect(result.totalPositions).toBe(55);
    expect(result.holdings.map(({ symbolId }) => symbolId)).toEqual(expected);
    expect(result.holdings).toHaveLength(50);
    expect(result.holdings.some(({ symbolId }) => symbolId === "AMEX:PRIVATE")).toBe(
      false,
    );
    expect(queries).toHaveLength(2);
    expect(
      queries.every(
        ({ sql, params }) =>
          /portfolio_holdings[\s\S]*owner_id/u.test(sql) &&
          params.includes("owner-a"),
      ),
    ).toBe(true);
    expect(
      queries.some(
        ({ sql, params }) => /limit\s+\?/iu.test(sql) && params.includes(50),
      ),
    ).toBe(true);
  });

  it("returns an empty bounded page and zero total for an owner with no holdings", async () => {
    seedHolding(sqlite, "owner-b", "NASDAQ:NVDA");

    await expect(getPortfolioPulseHoldings("owner-empty")).resolves.toEqual({
      holdings: [],
      totalPositions: 0,
    });
  });
});
