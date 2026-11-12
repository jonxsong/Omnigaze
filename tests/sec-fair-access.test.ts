import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/db/schema";
import { secFairAccessControl } from "@/db/schema";
import {
  createSecFairAccessCoordinator,
  SecFairAccessCoordinatorError,
} from "@/lib/providers/sec-fair-access";

vi.mock("cloudflare:workers", () => ({ env: {} }));

function migrationSql() {
  return readFileSync(
    resolve(process.cwd(), "drizzle/0007_sec_fair_access_v1.sql"),
    "utf8",
  ).replaceAll("--> statement-breakpoint", "");
}

function createTestDatabase(applyMigration = true) {
  const sqlite = new DatabaseSync(":memory:");
  if (applyMigration) sqlite.exec(migrationSql());
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

describe("distributed SEC Fair Access coordinator", () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    while (databases.length > 0) databases.pop()?.close();
  });

  function sharedDatabase(applyMigration = true) {
    const result = createTestDatabase(applyMigration);
    databases.push(result.sqlite);
    return result;
  }

  it("admits only one concurrent caller across coordinator instances", async () => {
    const { sqlite, database } = sharedDatabase();
    const factory = () => database as never;
    const first = createSecFairAccessCoordinator(factory, { maxWaitMs: 0 });
    const second = createSecFairAccessCoordinator(factory, { maxWaitMs: 0 });

    const results = await Promise.allSettled([first.acquire(), second.acquire()]);

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        code: "admission_deadline_exceeded",
      }),
    });
    expect(
      sqlite
        .prepare(
          "SELECT provider, next_admission_at_ms, cooldown_until_ms FROM sec_fair_access_control",
        )
        .get(),
    ).toMatchObject({
      provider: "sec-edgar",
      next_admission_at_ms: expect.any(Number),
      cooldown_until_ms: 0,
    });
  });

  it("does not reserve future slots for denied callers", async () => {
    const { sqlite, database } = sharedDatabase();
    const factory = () => database as never;
    const admitted = createSecFairAccessCoordinator(factory, { maxWaitMs: 0 });
    await admitted.acquire();
    const before = sqlite
      .prepare(
        "SELECT next_admission_at_ms FROM sec_fair_access_control WHERE provider = 'sec-edgar'",
      )
      .get()?.next_admission_at_ms;

    const denied = Array.from({ length: 5 }, () =>
      createSecFairAccessCoordinator(factory, { maxWaitMs: 0 }).acquire(),
    );
    const results = await Promise.allSettled(denied);
    const after = sqlite
      .prepare(
        "SELECT next_admission_at_ms FROM sec_fair_access_control WHERE provider = 'sec-edgar'",
      )
      .get()?.next_admission_at_ms;

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(after).toBe(before);
  });

  it("retries within one bounded deadline and never sleeps past the next slot", async () => {
    const { sqlite, database } = sharedDatabase();
    const factory = () => database as never;
    await createSecFairAccessCoordinator(factory, { maxWaitMs: 0 }).acquire();
    let elapsed = 0;
    const sleeps: number[] = [];
    const coordinator = createSecFairAccessCoordinator(factory, {
      maxWaitMs: 500,
      monotonicNow: () => elapsed,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        elapsed += milliseconds;
        sqlite
          .prepare(
            "UPDATE sec_fair_access_control SET next_admission_at_ms = 0 WHERE provider = 'sec-edgar'",
          )
          .run();
      },
    });

    await expect(coordinator.acquire()).resolves.toBeUndefined();
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(0);
    expect(sleeps[0]).toBeLessThanOrEqual(125);
  });

  it("rejects an overslept waiter before attempting another admission", async () => {
    const { sqlite, database } = sharedDatabase();
    const factory = () => database as never;
    await createSecFairAccessCoordinator(factory, { maxWaitMs: 0 }).acquire();
    let elapsed = 0;
    let writes = 0;
    const countedDatabase = {
      values: async <T extends unknown[]>(query: Parameters<typeof database.values>[0]) => {
        writes += 1;
        return database.values<T>(query);
      },
    };
    const coordinator = createSecFairAccessCoordinator(
      () => countedDatabase,
      {
        maxWaitMs: 500,
        monotonicNow: () => elapsed,
        sleep: async () => {
          elapsed = 501;
          sqlite
            .prepare(
              "UPDATE sec_fair_access_control SET next_admission_at_ms = 0 WHERE provider = 'sec-edgar'",
            )
            .run();
        },
      },
    );

    await expect(coordinator.acquire()).rejects.toMatchObject({
      code: "admission_deadline_exceeded",
    });
    expect(writes).toBe(2);
  });

  it("shares and monotonically extends a minimum ten-minute cooldown", async () => {
    const { sqlite, database } = sharedDatabase();
    const factory = () => database as never;
    const writer = createSecFairAccessCoordinator(factory, { maxWaitMs: 0 });
    const reader = createSecFairAccessCoordinator(factory, { maxWaitMs: 0 });

    await writer.imposeCooldown(1);
    const first = sqlite
      .prepare(
        "SELECT cooldown_until_ms FROM sec_fair_access_control WHERE provider = 'sec-edgar'",
      )
      .get()?.cooldown_until_ms as number;
    expect(first - Date.now()).toBeGreaterThan(590_000);
    await reader.imposeCooldown(1_200);
    const extended = sqlite
      .prepare(
        "SELECT cooldown_until_ms FROM sec_fair_access_control WHERE provider = 'sec-edgar'",
      )
      .get()?.cooldown_until_ms as number;

    expect(extended).toBeGreaterThan(first);
    await expect(reader.getStatus()).resolves.toMatchObject({
      status: "cooldown",
      retryAfterSeconds: expect.any(Number),
    });
    await expect(reader.acquire()).rejects.toMatchObject({
      code: "cooldown",
      retryAfterSeconds: expect.any(Number),
    });
  });

  it("fails closed with stable errors when D1 is absent or unavailable", async () => {
    const missing = sharedDatabase(false);
    const missingCoordinator = createSecFairAccessCoordinator(
      () => missing.database as never,
      { maxWaitMs: 0 },
    );
    const unavailableCoordinator = createSecFairAccessCoordinator(
      () => ({
        values: async () => {
          throw new Error(
            "private DB binding https://internal.test?token=do-not-log",
          );
        },
      }),
      { maxWaitMs: 0 },
    );

    for (const coordinator of [missingCoordinator, unavailableCoordinator]) {
      let failure: unknown;
      try {
        await coordinator.acquire();
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SecFairAccessCoordinatorError);
      expect(failure).toMatchObject({ code: "coordinator_unavailable" });
      expect(String(failure)).not.toContain("private DB");
      expect(String(failure)).not.toContain("token=");
      await expect(coordinator.getStatus()).resolves.toEqual({
        status: "unavailable",
        retryAfterSeconds: null,
      });
    }
  });

  it("rejects unsafe policy values at construction", () => {
    const database = () => sharedDatabase().database as never;
    expect(() =>
      createSecFairAccessCoordinator(database, { minimumIntervalMs: 124 }),
    ).toThrow("invalid_sec_fair_access_policy");
    expect(() =>
      createSecFairAccessCoordinator(database, { maxWaitMs: 30_001 }),
    ).toThrow("invalid_sec_fair_access_policy");
  });
});

describe("SEC Fair Access migration", () => {
  it("is additive, privacy-minimal, and matches the generated schema snapshot", () => {
    const migration = migrationSql();
    const snapshot = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle/meta/0007_snapshot.json"),
        "utf8",
      ),
    ) as {
      tables: Record<
        string,
        {
          columns: Record<string, unknown>;
          checkConstraints: Record<string, unknown>;
        }
      >;
    };
    const table = snapshot.tables.sec_fair_access_control;
    const config = getTableConfig(secFairAccessControl);

    expect(migration).toMatch(/^CREATE TABLE `sec_fair_access_control`/);
    expect(migration).not.toMatch(/\b(?:DROP|ALTER|INSERT)\b/i);
    expect(migration).not.toMatch(/owner|symbol|ticker|url|user.agent|email/i);
    expect(Object.keys(table.columns).sort()).toEqual(
      config.columns.map((column) => column.name).sort(),
    );
    expect(Object.keys(table.checkConstraints).sort()).toEqual(
      config.checks.map((constraint) => constraint.name).sort(),
    );
  });

  it("chains migration 0007 in the Drizzle journal", () => {
    const previous = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle/meta/0006_snapshot.json"),
        "utf8",
      ),
    ) as { id: string };
    const current = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle/meta/0007_snapshot.json"),
        "utf8",
      ),
    ) as { prevId: string };
    const journal = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ idx: number; tag: string }> };

    expect(current.prevId).toBe(previous.id);
    expect(journal.entries.find((entry) => entry.idx === 7)).toMatchObject({
      idx: 7,
      tag: "0007_sec_fair_access_v1",
    });
  });
});
