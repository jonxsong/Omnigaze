import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  buildPendingMigrationSql,
  makeAdditiveStatementIdempotent,
  makeMigrationIdempotent,
} from "../scripts/migrate-local-d1.mjs";

describe("local D1 migration reconciliation", () => {
  it("makes additive table and index statements replay-safe", () => {
    expect(makeAdditiveStatementIdempotent("CREATE TABLE `sample` (`id` text);"))
      .toBe("CREATE TABLE IF NOT EXISTS `sample` (`id` text);");
    expect(
      makeAdditiveStatementIdempotent(
        "CREATE UNIQUE INDEX `sample_id_idx` ON `sample` (`id`);",
      ),
    ).toBe(
      "CREATE UNIQUE INDEX IF NOT EXISTS `sample_id_idx` ON `sample` (`id`);",
    );
    expect(makeAdditiveStatementIdempotent("CREATE INDEX IF NOT EXISTS idx ON t (id);"))
      .toBe("CREATE INDEX IF NOT EXISTS idx ON t (id);");
  });

  it("rejects destructive or unsupported migration statements", () => {
    expect(() => makeMigrationIdempotent("DROP TABLE important_data;")).toThrow(
      /only supports additive/i,
    );
    expect(() => makeMigrationIdempotent("ALTER TABLE t ADD COLUMN value text;"))
      .toThrow(/only supports additive/i);
  });

  it("includes only migration files absent from the local ledger", async () => {
    const applied = new Set([
      "0000_damp_robbie_robertson.sql",
      "0001_thick_reptil.sql",
      "0002_portfolio_v1.sql",
    ]);
    const result = await buildPendingMigrationSql(applied);

    expect(result.pendingNames).toEqual([
      "0003_intelligence_inbox_v1.sql",
      "0004_ingestion_control_plane_v1.sql",
      "0005_ai_guardrails_v1.sql",
    ]);
    expect(result.sql).toContain("CREATE TABLE IF NOT EXISTS `inbox_sync_gates`");
    expect(result.sql).toContain(
      "INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0003_intelligence_inbox_v1.sql')",
    );
    expect(result.sql).toContain(
      "CREATE TABLE IF NOT EXISTS `provider_ingestion_checkpoints`",
    );
    expect(result.sql).toContain(
      "CREATE TABLE IF NOT EXISTS `ai_model_budget_reservations`",
    );
    expect(result.sql).not.toContain("CREATE TABLE `portfolio_holdings`");
  });

  it("repairs a partially applied additive migration without deleting rows", async () => {
    const sqlite = new DatabaseSync(":memory:");
    try {
      for (const name of [
        "0000_damp_robbie_robertson.sql",
        "0001_thick_reptil.sql",
        "0002_portfolio_v1.sql",
      ]) {
        sqlite.exec(
          readFileSync(resolve(process.cwd(), "drizzle", name), "utf8")
            .replaceAll("--> statement-breakpoint", ""),
        );
      }

      const currentInboxMigration = readFileSync(
        resolve(process.cwd(), "drizzle", "0003_intelligence_inbox_v1.sql"),
        "utf8",
      );
      const earlierPartialInboxMigration = currentInboxMigration
        .split("--> statement-breakpoint")
        .filter((statement) => !statement.includes("`inbox_sync_gates`"))
        .join("\n");
      sqlite.exec(earlierPartialInboxMigration);
      sqlite.exec(`
        INSERT INTO inbox_profiles (
          owner_id,
          activated_at,
          baseline_completed_at,
          last_checked_at,
          last_successful_sync_at
        ) VALUES (
          'owner-preserved',
          '2026-11-12T08:00:00.000Z',
          NULL,
          '2026-11-12T08:00:00.000Z',
          '2026-11-12T08:00:00.000Z'
        );
        CREATE TABLE d1_migrations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT UNIQUE,
          applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
        );
        INSERT INTO d1_migrations (name) VALUES
          ('0000_damp_robbie_robertson.sql'),
          ('0001_thick_reptil.sql'),
          ('0002_portfolio_v1.sql');
      `);

      const pending = await buildPendingMigrationSql(
        new Set([
          "0000_damp_robbie_robertson.sql",
          "0001_thick_reptil.sql",
          "0002_portfolio_v1.sql",
        ]),
      );
      sqlite.exec(pending.sql);

      expect(
        sqlite
          .prepare("SELECT owner_id FROM inbox_profiles WHERE owner_id = ?")
          .get("owner-preserved"),
      ).toEqual({ owner_id: "owner-preserved" });
      expect(
        sqlite
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inbox_sync_gates'",
          )
          .get(),
      ).toEqual({ name: "inbox_sync_gates" });
      expect(
        sqlite
          .prepare("SELECT name FROM d1_migrations ORDER BY name")
          .all()
          .map(({ name }) => name),
      ).toEqual([
        "0000_damp_robbie_robertson.sql",
        "0001_thick_reptil.sql",
        "0002_portfolio_v1.sql",
        "0003_intelligence_inbox_v1.sql",
        "0004_ingestion_control_plane_v1.sql",
        "0005_ai_guardrails_v1.sql",
      ]);
    } finally {
      sqlite.close();
    }
  });
});
