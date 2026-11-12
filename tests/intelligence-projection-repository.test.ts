import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import * as schema from "@/db/schema";
import {
  createInboxProjectionCursorRepository,
  type InboxProjectionCursorRepository,
} from "@/lib/intelligence-inbox/projection-repository";

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

function activate(sqlite: DatabaseSync, ownerId: string, activatedAt: string) {
  sqlite
    .prepare(`
      INSERT INTO inbox_profiles (
        owner_id, activated_at, baseline_completed_at,
        last_checked_at, last_successful_sync_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
    .run(ownerId, activatedAt, activatedAt, activatedAt, activatedAt);
}

describe("owner intelligence projection cursor repository", () => {
  let sqlite: DatabaseSync;
  let repository: InboxProjectionCursorRepository;

  beforeEach(() => {
    const testDatabase = createTestDatabase();
    sqlite = testDatabase.sqlite;
    repository = createInboxProjectionCursorRepository(
      () => testDatabase.database as never,
    );
  });

  afterEach(() => sqlite.close());

  it("enumerates only activated profiles and leases owners independently", async () => {
    activate(sqlite, "owner-a", "2026-11-12T08:00:00.000Z");
    activate(sqlite, "owner-b", "2026-11-12T08:00:01.000Z");

    const first = await repository.claimNext("2026-11-12T09:00:00.000Z");
    const second = await repository.claimNext("2026-11-12T09:00:00.000Z");

    expect(first).toMatchObject({ ownerId: "owner-a", lastSequence: 0 });
    expect(first?.token).toEqual(expect.any(String));
    expect(second).toMatchObject({ ownerId: "owner-b", lastSequence: 0 });
    expect(
      sqlite
        .prepare("SELECT owner_id FROM inbox_projection_cursors ORDER BY owner_id")
        .all(),
    ).toEqual([{ owner_id: "owner-a" }, { owner_id: "owner-b" }]);
  });

  it("advances only under the matching lease and keeps catch-up immediately due", async () => {
    activate(sqlite, "owner-a", "2026-11-12T08:00:00.000Z");
    const first = await repository.claimNext("2026-11-12T09:00:00.000Z");
    expect(first).not.toBeNull();

    await repository.complete(
      first!,
      "2026-11-12T09:00:01.000Z",
      12,
      true,
    );
    expect(
      sqlite
        .prepare(`
          SELECT last_sequence, claim_token, next_allowed_at,
            consecutive_failures
          FROM inbox_projection_cursors WHERE owner_id = 'owner-a'
        `)
        .get(),
    ).toEqual({
      last_sequence: 12,
      claim_token: null,
      next_allowed_at: "2026-11-12T09:00:01.000Z",
      consecutive_failures: 0,
    });

    const catchup = await repository.claimNext("2026-11-12T09:00:01.000Z");
    expect(catchup).toMatchObject({ ownerId: "owner-a", lastSequence: 12 });
    await expect(
      repository.complete(
        first!,
        "2026-11-12T09:00:02.000Z",
        13,
        false,
      ),
    ).rejects.toThrow("projection_lease_lost");
  });

  it("releases a failed lease without moving the cursor", async () => {
    activate(sqlite, "owner-a", "2026-11-12T08:00:00.000Z");
    const lease = await repository.claimNext("2026-11-12T09:00:00.000Z");
    await repository.fail(lease!, "2026-11-12T09:00:01.000Z");

    expect(
      sqlite
        .prepare(`
          SELECT last_sequence, claim_token, next_allowed_at,
            consecutive_failures
          FROM inbox_projection_cursors WHERE owner_id = 'owner-a'
        `)
        .get(),
    ).toEqual({
      last_sequence: 0,
      claim_token: null,
      next_allowed_at: "2026-11-12T09:00:11.000Z",
      consecutive_failures: 1,
    });
    await expect(
      repository.claimNext("2026-11-12T09:00:10.000Z"),
    ).resolves.toBeNull();
    await expect(
      repository.claimNext("2026-11-12T09:00:11.000Z"),
    ).resolves.toMatchObject({ lastSequence: 0 });
  });

  it("reports only privacy-bounded aggregate projection readiness", async () => {
    activate(sqlite, "owner-a", "2026-11-12T08:00:00.000Z");
    activate(sqlite, "owner-b", "2026-11-12T08:00:01.000Z");
    sqlite
      .prepare(
        "UPDATE inbox_profiles SET baseline_completed_at = NULL WHERE owner_id = ?",
      )
      .run("owner-b");

    await expect(
      repository.getAggregateStatus("2026-11-12T09:00:00.000Z"),
    ).resolves.toEqual({
      generatedAt: "2026-11-12T09:00:00.000Z",
      ownerCount: 2,
      pendingOwnerCount: 2,
      leasedOwnerCount: 0,
      failingOwnerCount: 0,
      lastAttemptAt: null,
      lastCompletedAt: null,
    });

    const first = await repository.claimNext("2026-11-12T09:00:00.000Z");
    const whileLeased = await repository.getAggregateStatus(
      "2026-11-12T09:00:00.500Z",
    );
    expect(whileLeased).toMatchObject({
      ownerCount: 2,
      pendingOwnerCount: 1,
      leasedOwnerCount: 1,
      failingOwnerCount: 0,
      lastAttemptAt: "2026-11-12T09:00:00.000Z",
    });

    await repository.complete(
      first!,
      "2026-11-12T09:00:01.000Z",
      0,
      false,
    );
    const second = await repository.claimNext("2026-11-12T09:00:01.000Z");
    await repository.fail(second!, "2026-11-12T09:00:02.000Z");
    const failed = await repository.getAggregateStatus(
      "2026-11-12T09:00:03.000Z",
    );
    expect(failed).toMatchObject({
      ownerCount: 2,
      pendingOwnerCount: 1,
      leasedOwnerCount: 0,
      failingOwnerCount: 1,
      lastAttemptAt: "2026-11-12T09:00:01.000Z",
      lastCompletedAt: "2026-11-12T09:00:01.000Z",
    });
    expect(JSON.stringify(failed)).not.toMatch(/owner-a|owner-b|claim|sequence/i);
  });
});
