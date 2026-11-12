import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import * as schema from "@/db/schema";
import { providerEgressGuard } from "@/db/schema";
import {
  AlpacaAssetCatalogProvider,
  AlpacaAssetProviderError,
} from "@/lib/providers/alpaca-assets";
import { AlpacaProvider } from "@/lib/providers/alpaca";
import {
  createProviderEgressGuard,
  ProviderEgressGuardError,
  type ProviderEgressAdmissionGuard,
} from "@/lib/providers/provider-egress-guard";
import { createLiveMarketDataOrchestrator } from "@/lib/services/live-market-data";

vi.mock("cloudflare:workers", () => ({ env: {} }));

function migrationSql() {
  return readFileSync(
    resolve(process.cwd(), "drizzle/0009_provider_egress_guard_v1.sql"),
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

const oneQuotePerSecond = {
  policies: {
    alpaca_quotes_interactive: { limit: 1, windowMs: 1_000 },
  },
};

describe("distributed provider egress guard", () => {
  const databases: DatabaseSync[] = [];

  afterEach(() => {
    vi.unstubAllGlobals();
    while (databases.length > 0) databases.pop()?.close();
  });

  function sharedDatabase(applyMigration = true) {
    const result = createTestDatabase(applyMigration);
    databases.push(result.sqlite);
    return result;
  }

  it("atomically admits only one concurrent caller across guard instances", async () => {
    const { sqlite, database } = sharedDatabase();
    const factory = () => database as never;
    const first = createProviderEgressGuard(factory, oneQuotePerSecond);
    const second = createProviderEgressGuard(factory, oneQuotePerSecond);

    const outcomes = await Promise.allSettled([
      first.acquire("alpaca_quotes_interactive"),
      second.acquire("alpaca_quotes_interactive"),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        code: "budget_exhausted",
        bucket: "alpaca_quotes_interactive",
        retryAfterSeconds: 1,
      }),
    });
    expect(
      sqlite
        .prepare(
          "SELECT bucket, request_count, cooldown_until_ms FROM provider_egress_guard",
        )
        .get(),
    ).toEqual({
      bucket: "alpaca_quotes_interactive",
      request_count: 1,
      cooldown_until_ms: 0,
    });
  });

  it("rolls over at the database-clock boundary without carrying denied demand", async () => {
    const { sqlite, database } = sharedDatabase();
    const guard = createProviderEgressGuard(
      () => database as never,
      oneQuotePerSecond,
    );

    await guard.acquire("alpaca_quotes_interactive");
    await expect(
      guard.acquire("alpaca_quotes_interactive"),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    expect(
      sqlite
        .prepare(
          "SELECT request_count FROM provider_egress_guard WHERE bucket = ?",
        )
        .get("alpaca_quotes_interactive"),
    ).toEqual({ request_count: 1 });

    sqlite
      .prepare(`
        UPDATE provider_egress_guard
        SET window_started_at_ms =
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) - 1000
        WHERE bucket = ?
      `)
      .run("alpaca_quotes_interactive");

    await expect(
      guard.acquire("alpaca_quotes_interactive"),
    ).resolves.toBeUndefined();
    expect(
      sqlite
        .prepare(
          "SELECT request_count FROM provider_egress_guard WHERE bucket = ?",
        )
        .get("alpaca_quotes_interactive"),
    ).toEqual({ request_count: 1 });
  });

  it("shares an upstream cooldown across buckets and resumes only after it clears", async () => {
    const { sqlite, database } = sharedDatabase();
    const writer = createProviderEgressGuard(() => database as never, {
      ...oneQuotePerSecond,
      defaultCooldownSeconds: 1,
    });
    const reader = createProviderEgressGuard(() => database as never, {
      ...oneQuotePerSecond,
      defaultCooldownSeconds: 1,
    });

    await writer.imposeCooldown("alpaca_quotes_interactive", 1);
    await expect(
      reader.getStatus("alpaca_quotes_interactive"),
    ).resolves.toEqual({
      status: "limited",
      reason: "cooldown",
      retryAfterSeconds: 1,
    });
    await expect(
      reader.getStatus("alpaca_news_ingestion"),
    ).resolves.toEqual({
      status: "limited",
      reason: "cooldown",
      retryAfterSeconds: 1,
    });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM provider_egress_guard").get(),
    ).toEqual({ count: 5 });
    await expect(
      reader.acquire("alpaca_quotes_interactive"),
    ).rejects.toMatchObject({
      code: "cooldown",
      retryAfterSeconds: 1,
    });

    sqlite
      .prepare(`
        UPDATE provider_egress_guard
        SET cooldown_until_ms = 0, window_started_at_ms = 0, request_count = 0
        WHERE bucket = ?
      `)
      .run("alpaca_quotes_interactive");
    await expect(
      reader.acquire("alpaca_quotes_interactive"),
    ).resolves.toBeUndefined();
  });

  it("fails closed with stable errors when guard storage is missing or unavailable", async () => {
    const missing = sharedDatabase(false);
    const guards = [
      createProviderEgressGuard(() => missing.database as never),
      createProviderEgressGuard(() => ({
        values: async () => {
          throw new Error("private DB binding?token=do-not-log");
        },
      })),
    ];

    for (const guard of guards) {
      const error = await guard
        .acquire("alpaca_bars_interactive")
        .catch((failure) => failure);
      expect(error).toBeInstanceOf(ProviderEgressGuardError);
      expect(error).toMatchObject({
        code: "guard_unavailable",
        bucket: "alpaca_bars_interactive",
      });
      expect(String(error)).not.toContain("private DB");
      expect(String(error)).not.toContain("token=");
    }
  });

  it("rejects unsafe policy values before touching D1", () => {
    expect(() =>
      createProviderEgressGuard(async () => {
        throw new Error("must not run");
      }, {
        policies: {
          alpaca_news_ingestion: { limit: 0, windowMs: 60_000 },
        },
      }),
    ).toThrow("invalid_provider_egress_policy");
  });
});

describe("provider boundary integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function denyingGuard() {
    const acquire = vi.fn(
      async (bucket: Parameters<ProviderEgressAdmissionGuard["acquire"]>[0]) => {
        throw new ProviderEgressGuardError("budget_exhausted", bucket, 9);
      },
    );
    return {
      guard: {
        acquire,
        imposeCooldown: vi.fn(async () => undefined),
        getStatus: vi.fn(async () => ({
          status: "ready" as const,
          retryAfterSeconds: null,
        })),
      } satisfies ProviderEgressAdmissionGuard,
      acquire,
    };
  }

  it("never calls Alpaca when any covered operation is denied", async () => {
    const upstream = vi.fn();
    const catalogUpstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const { guard, acquire } = denyingGuard();
    const provider = new AlpacaProvider({
      keyId: "public-key",
      secretKey: "private-secret",
      egressGuard: guard,
    });
    const catalog = new AlpacaAssetCatalogProvider({
      keyId: "public-key",
      secretKey: "private-secret",
      fetcher: catalogUpstream,
      egressGuard: guard,
    });

    await expect(provider.getSnapshot("NASDAQ:NVDA")).rejects.toMatchObject({
      code: "budget_exhausted",
    });
    await expect(
      provider.getSnapshots(["NASDAQ:NVDA", "NYSE:IBM"]),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    await expect(
      provider.getHistoricalBars("NASDAQ:NVDA", {
        range: "1D",
        timeframe: "5Min",
        start: "2026-11-11T00:00:00.000Z",
        end: "2026-11-12T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    await expect(
      provider.getLatestEvents({
        symbols: ["NASDAQ:NVDA"],
        since: "2026-11-11T00:00:00.000Z",
        limit: 10,
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    await expect(
      provider.getEventPage({
        symbols: ["NASDAQ:NVDA"],
        windowStart: "2026-11-11T00:00:00.000Z",
        windowEnd: "2026-11-12T00:00:00.000Z",
        pageSize: 10,
        cursor: null,
      }),
    ).rejects.toMatchObject({ code: "budget_exhausted" });
    await expect(catalog.listActiveUsEquities()).rejects.toBeInstanceOf(
      AlpacaAssetProviderError,
    );
    await expect(catalog.resolveExact("NVDA")).rejects.toMatchObject({
      code: "provider_rate_limited",
      retryAfterSeconds: 9,
    });

    expect(upstream).not.toHaveBeenCalled();
    expect(catalogUpstream).not.toHaveBeenCalled();
    expect(acquire.mock.calls.map(([bucket]) => bucket)).toEqual([
      "alpaca_quotes_interactive",
      "alpaca_quotes_interactive",
      "alpaca_bars_interactive",
      "alpaca_news_interactive",
      "alpaca_news_ingestion",
      "alpaca_catalog_interactive",
      "alpaca_catalog_interactive",
    ]);
  });

  it("turns upstream 429 responses into a shared sanitized cooldown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("private upstream body", {
          status: 429,
          headers: { "Retry-After": "12" },
        }),
      ),
    );
    const guard = {
      acquire: vi.fn(async () => undefined),
      imposeCooldown: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({
        status: "ready" as const,
        retryAfterSeconds: null,
      })),
    } satisfies ProviderEgressAdmissionGuard;
    const provider = new AlpacaProvider({
      keyId: "public-key",
      secretKey: "private-secret",
      egressGuard: guard,
    });

    const error = await provider
      .getSnapshot("NASDAQ:NVDA")
      .catch((failure) => failure);
    expect(error).toBeInstanceOf(ProviderEgressGuardError);
    expect(error).toMatchObject({
      code: "cooldown",
      bucket: "alpaca_quotes_interactive",
      retryAfterSeconds: 12,
    });
    expect(String(error)).not.toContain("private upstream body");
    expect(guard.imposeCooldown).toHaveBeenCalledWith(
      "alpaca_quotes_interactive",
      12,
    );
  });

  it("uses Alpaca's reset epoch when Retry-After is absent", async () => {
    vi.spyOn(Date, "now").mockReturnValue(2_000_000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 429,
          headers: { "X-RateLimit-Reset": "2005" },
        }),
      ),
    );
    const guard = {
      acquire: vi.fn(async () => undefined),
      imposeCooldown: vi.fn(async () => undefined),
      getStatus: vi.fn(async () => ({
        status: "ready" as const,
        retryAfterSeconds: null,
      })),
    } satisfies ProviderEgressAdmissionGuard;
    const provider = new AlpacaProvider({
      keyId: "public-key",
      secretKey: "private-secret",
      egressGuard: guard,
    });

    await expect(provider.getSnapshot("NASDAQ:NVDA")).rejects.toMatchObject({
      code: "cooldown",
      retryAfterSeconds: 5,
    });
    expect(guard.imposeCooldown).toHaveBeenCalledWith(
      "alpaca_quotes_interactive",
      5,
    );
  });

  it("keeps quote admission denial on the established demo fallback contract", async () => {
    const upstream = vi.fn();
    vi.stubGlobal("fetch", upstream);
    const { guard } = denyingGuard();
    const service = createLiveMarketDataOrchestrator(
      {
        ALPACA_API_KEY_ID: "public-key",
        ALPACA_API_SECRET_KEY: "private-secret",
      },
      { createProviderEgressGuard: () => guard },
    );

    const result = await service.getSnapshot("NASDAQ:NVDA");

    expect(result.meta).toMatchObject({
      dataMode: "demo",
      fallbackReason: "provider_request_failed",
    });
    expect(result.data?.symbolId).toBe("NASDAQ:NVDA");
    expect(upstream).not.toHaveBeenCalled();
  });
});

describe("provider egress guard migration", () => {
  it("is additive, identity-free, and matches the generated schema snapshot", () => {
    const migration = migrationSql();
    const snapshot = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle/meta/0009_snapshot.json"),
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
    const table = snapshot.tables.provider_egress_guard;
    const config = getTableConfig(providerEgressGuard);

    expect(migration).toMatch(/^CREATE TABLE `provider_egress_guard`/);
    expect(migration).not.toMatch(/\b(?:DROP|ALTER|INSERT)\b/i);
    expect(migration).not.toMatch(
      /owner|user|email|ip_address|remote_address|symbol|ticker|url/i,
    );
    expect(Object.keys(table.columns).sort()).toEqual(
      config.columns.map((column) => column.name).sort(),
    );
    expect(Object.keys(table.checkConstraints).sort()).toEqual(
      config.checks.map((constraint) => constraint.name).sort(),
    );
  });

  it("chains and registers the inspected next migration", () => {
    const previous = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle/meta/0008_snapshot.json"),
        "utf8",
      ),
    ) as { id: string };
    const current = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle/meta/0009_snapshot.json"),
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
    expect(journal.entries.find((entry) => entry.idx === 9)).toMatchObject({
      idx: 9,
      tag: "0009_provider_egress_guard_v1",
    });
  });
});
