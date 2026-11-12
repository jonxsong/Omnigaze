import { sql, type SQL } from "drizzle-orm";
import { providerEgressGuard } from "@/db/schema";

export const PROVIDER_EGRESS_BUCKETS = [
  "alpaca_quotes_interactive",
  "alpaca_bars_interactive",
  "alpaca_catalog_interactive",
  "alpaca_news_interactive",
  "alpaca_news_ingestion",
] as const;

export type ProviderEgressBucket = (typeof PROVIDER_EGRESS_BUCKETS)[number];

type ProviderEgressPolicy = {
  limit: number;
  windowMs: number;
};

/** Conservative defaults reserve independent capacity for each product path. */
export const DEFAULT_PROVIDER_EGRESS_POLICIES = {
  alpaca_quotes_interactive: { limit: 100, windowMs: 60_000 },
  alpaca_bars_interactive: { limit: 25, windowMs: 60_000 },
  alpaca_catalog_interactive: { limit: 5, windowMs: 60_000 },
  alpaca_news_interactive: { limit: 20, windowMs: 60_000 },
  alpaca_news_ingestion: { limit: 30, windowMs: 60_000 },
} as const satisfies Record<ProviderEgressBucket, ProviderEgressPolicy>;

const DEFAULT_COOLDOWN_SECONDS = 60;
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const MAX_WINDOW_MS = 60 * 60 * 1_000;
const MAX_WINDOW_LIMIT = 10_000;

type ProviderEgressDatabase = {
  values<T extends unknown[]>(query: SQL): Promise<T[]>;
};

type ProviderEgressDatabaseFactory =
  () => ProviderEgressDatabase | Promise<ProviderEgressDatabase>;

async function runtimeDatabaseFactory(): Promise<ProviderEgressDatabase> {
  const { getDb } = await import("@/db");
  return getDb() as ProviderEgressDatabase;
}

export type ProviderEgressGuardErrorCode =
  | "guard_unavailable"
  | "budget_exhausted"
  | "cooldown";

export function boundedProviderRetryAfterSeconds(
  value: number | undefined,
  fallback = DEFAULT_COOLDOWN_SECONDS,
) {
  const candidate =
    typeof value === "number" && Number.isFinite(value) && value >= 0
      ? Math.ceil(value)
      : fallback;
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, candidate));
}

export class ProviderEgressGuardError extends Error {
  readonly retryAfterSeconds?: number;

  constructor(
    readonly code: ProviderEgressGuardErrorCode,
    readonly bucket: ProviderEgressBucket,
    retryAfterSeconds?: number,
  ) {
    super(
      code === "cooldown"
        ? "The provider cooldown is active."
        : code === "budget_exhausted"
          ? "The provider request budget is exhausted."
          : "Provider request coordination is unavailable.",
    );
    this.name = "ProviderEgressGuardError";
    this.retryAfterSeconds =
      code === "guard_unavailable"
        ? undefined
        : boundedProviderRetryAfterSeconds(
            retryAfterSeconds,
            code === "cooldown" ? DEFAULT_COOLDOWN_SECONDS : 1,
          );
  }
}

export type ProviderEgressGuardStatus =
  | { status: "ready"; retryAfterSeconds: null }
  | {
      status: "limited";
      reason: "budget_exhausted" | "cooldown";
      retryAfterSeconds: number;
    }
  | { status: "unavailable"; retryAfterSeconds: null };

export interface ProviderEgressAdmissionGuard {
  acquire(bucket: ProviderEgressBucket): Promise<void>;
  /**
   * Records an account-wide upstream cooldown atomically. `bucket` identifies
   * only the operation that observed the rejection; every Alpaca bucket waits.
   */
  imposeCooldown(
    bucket: ProviderEgressBucket,
    retryAfterSeconds?: number,
  ): Promise<void>;
  getStatus(bucket: ProviderEgressBucket): Promise<ProviderEgressGuardStatus>;
}

export interface ProviderEgressGuardOptions {
  policies?: Partial<Record<ProviderEgressBucket, ProviderEgressPolicy>>;
  defaultCooldownSeconds?: number;
}

type GuardState = {
  windowStartedAtMs: number;
  requestCount: number;
  cooldownUntilMs: number;
  databaseNowMs: number;
};

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error("invalid_provider_egress_policy");
  }
  return value;
}

function policiesFrom(options: ProviderEgressGuardOptions) {
  return Object.fromEntries(
    PROVIDER_EGRESS_BUCKETS.map((bucket) => {
      const configured =
        options.policies?.[bucket] ?? DEFAULT_PROVIDER_EGRESS_POLICIES[bucket];
      return [
        bucket,
        {
          limit: boundedInteger(configured.limit, 1, MAX_WINDOW_LIMIT),
          windowMs: boundedInteger(configured.windowMs, 1_000, MAX_WINDOW_MS),
        },
      ];
    }),
  ) as Record<ProviderEgressBucket, ProviderEgressPolicy>;
}

function validState(row: unknown[] | undefined): GuardState | null {
  if (
    !row ||
    row.length < 4 ||
    row.slice(0, 4).some(
      (value) =>
        typeof value !== "number" ||
        !Number.isSafeInteger(value) ||
        value < 0,
    )
  ) {
    return null;
  }
  return {
    windowStartedAtMs: row[0] as number,
    requestCount: row[1] as number,
    cooldownUntilMs: row[2] as number,
    databaseNowMs: row[3] as number,
  };
}

function unavailable(bucket: ProviderEgressBucket): never {
  throw new ProviderEgressGuardError("guard_unavailable", bucket);
}

function retrySeconds(milliseconds: number) {
  return boundedProviderRetryAfterSeconds(Math.ceil(milliseconds / 1_000), 1);
}

class D1ProviderEgressGuard implements ProviderEgressAdmissionGuard {
  private readonly policies: Record<
    ProviderEgressBucket,
    ProviderEgressPolicy
  >;
  private readonly defaultCooldownSeconds: number;

  constructor(
    private readonly databaseFactory: ProviderEgressDatabaseFactory,
    options: ProviderEgressGuardOptions,
  ) {
    this.policies = policiesFrom(options);
    this.defaultCooldownSeconds = boundedInteger(
      options.defaultCooldownSeconds ?? DEFAULT_COOLDOWN_SECONDS,
      1,
      MAX_RETRY_AFTER_SECONDS,
    );
  }

  private async database(bucket: ProviderEgressBucket) {
    try {
      return await this.databaseFactory();
    } catch {
      unavailable(bucket);
    }
  }

  private async tryAcquire(bucket: ProviderEgressBucket) {
    const database = await this.database(bucket);
    const policy = this.policies[bucket];
    try {
      const rows = await database.values<[number, number, number, number]>(sql`
        INSERT INTO ${providerEgressGuard} (
          bucket,
          window_started_at_ms,
          request_count,
          cooldown_until_ms,
          updated_at
        ) VALUES (
          ${bucket},
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          1,
          0,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT(bucket) DO UPDATE SET
          window_started_at_ms = CASE
            WHEN CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
                   >= window_started_at_ms + ${policy.windowMs}
              THEN CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            ELSE window_started_at_ms
          END,
          request_count = CASE
            WHEN CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
                   >= window_started_at_ms + ${policy.windowMs}
              THEN 1
            ELSE request_count + 1
          END,
          updated_at = CURRENT_TIMESTAMP
        WHERE CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
                >= cooldown_until_ms
          AND (
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
                >= window_started_at_ms + ${policy.windowMs}
            OR request_count < ${policy.limit}
          )
        RETURNING
          window_started_at_ms,
          request_count,
          cooldown_until_ms,
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      `);
      if (rows.length === 0) return false;
      if (!validState(rows[0])) unavailable(bucket);
      return true;
    } catch (error) {
      if (error instanceof ProviderEgressGuardError) throw error;
      unavailable(bucket);
    }
  }

  private async readState(bucket: ProviderEgressBucket) {
    const database = await this.database(bucket);
    try {
      const rows = await database.values<[number, number, number, number]>(sql`
        SELECT
          window_started_at_ms,
          request_count,
          cooldown_until_ms,
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        FROM ${providerEgressGuard}
        WHERE bucket = ${bucket}
        LIMIT 1
      `);
      if (rows.length === 0) return null;
      const state = validState(rows[0]);
      if (!state) unavailable(bucket);
      return state;
    } catch (error) {
      if (error instanceof ProviderEgressGuardError) throw error;
      unavailable(bucket);
    }
  }

  private limitation(
    bucket: ProviderEgressBucket,
    state: GuardState,
  ): ProviderEgressGuardError | null {
    const cooldownDelay = state.cooldownUntilMs - state.databaseNowMs;
    if (cooldownDelay > 0) {
      return new ProviderEgressGuardError(
        "cooldown",
        bucket,
        retrySeconds(cooldownDelay),
      );
    }

    const policy = this.policies[bucket];
    const windowDelay =
      state.windowStartedAtMs + policy.windowMs - state.databaseNowMs;
    if (state.requestCount >= policy.limit && windowDelay > 0) {
      return new ProviderEgressGuardError(
        "budget_exhausted",
        bucket,
        retrySeconds(windowDelay),
      );
    }
    return null;
  }

  async acquire(bucket: ProviderEgressBucket) {
    if (await this.tryAcquire(bucket)) return;
    let state = await this.readState(bucket);
    if (!state) unavailable(bucket);
    const limited = this.limitation(bucket, state);
    if (limited) throw limited;

    // The database clock may have crossed the exact window boundary between
    // the rejected write and state read. Retry once without queueing callers.
    if (await this.tryAcquire(bucket)) return;
    state = await this.readState(bucket);
    if (!state) unavailable(bucket);
    throw (
      this.limitation(bucket, state) ??
      new ProviderEgressGuardError("budget_exhausted", bucket, 1)
    );
  }

  async imposeCooldown(
    bucket: ProviderEgressBucket,
    retryAfterSeconds?: number,
  ) {
    const database = await this.database(bucket);
    const cooldownSeconds = boundedProviderRetryAfterSeconds(
      retryAfterSeconds,
      this.defaultCooldownSeconds,
    );
    try {
      const rows = await database.values<[string, number]>(sql`
        INSERT INTO ${providerEgressGuard} (
          bucket,
          window_started_at_ms,
          request_count,
          cooldown_until_ms,
          updated_at
        ) VALUES (
          ${PROVIDER_EGRESS_BUCKETS[0]},
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          0,
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            + ${cooldownSeconds * 1_000},
          CURRENT_TIMESTAMP
        ), (
          ${PROVIDER_EGRESS_BUCKETS[1]},
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          0,
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            + ${cooldownSeconds * 1_000},
          CURRENT_TIMESTAMP
        ), (
          ${PROVIDER_EGRESS_BUCKETS[2]},
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          0,
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            + ${cooldownSeconds * 1_000},
          CURRENT_TIMESTAMP
        ), (
          ${PROVIDER_EGRESS_BUCKETS[3]},
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          0,
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            + ${cooldownSeconds * 1_000},
          CURRENT_TIMESTAMP
        ), (
          ${PROVIDER_EGRESS_BUCKETS[4]},
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER),
          0,
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            + ${cooldownSeconds * 1_000},
          CURRENT_TIMESTAMP
        )
        ON CONFLICT(bucket) DO UPDATE SET
          cooldown_until_ms = MAX(
            cooldown_until_ms,
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
              + ${cooldownSeconds * 1_000}
          ),
          updated_at = CURRENT_TIMESTAMP
        RETURNING bucket, cooldown_until_ms
      `);
      const returnedBuckets = new Set(rows.map(([returnedBucket]) => returnedBucket));
      if (
        rows.length !== PROVIDER_EGRESS_BUCKETS.length ||
        rows.some(
          ([returnedBucket, cooldownUntilMs]) =>
            !PROVIDER_EGRESS_BUCKETS.includes(
              returnedBucket as ProviderEgressBucket,
            ) ||
            typeof cooldownUntilMs !== "number" ||
            !Number.isSafeInteger(cooldownUntilMs) ||
            cooldownUntilMs < 0,
        ) ||
        PROVIDER_EGRESS_BUCKETS.some(
          (expectedBucket) => !returnedBuckets.has(expectedBucket),
        )
      ) {
        unavailable(bucket);
      }
    } catch (error) {
      if (error instanceof ProviderEgressGuardError) throw error;
      unavailable(bucket);
    }
  }

  async getStatus(
    bucket: ProviderEgressBucket,
  ): Promise<ProviderEgressGuardStatus> {
    try {
      const state = await this.readState(bucket);
      if (!state) return { status: "ready", retryAfterSeconds: null };
      const limited = this.limitation(bucket, state);
      return limited
        ? {
            status: "limited",
            reason: limited.code as "budget_exhausted" | "cooldown",
            retryAfterSeconds: limited.retryAfterSeconds ?? 1,
          }
        : { status: "ready", retryAfterSeconds: null };
    } catch {
      return { status: "unavailable", retryAfterSeconds: null };
    }
  }
}

export function createProviderEgressGuard(
  databaseFactory: ProviderEgressDatabaseFactory = runtimeDatabaseFactory,
  options: ProviderEgressGuardOptions = {},
): ProviderEgressAdmissionGuard {
  return new D1ProviderEgressGuard(databaseFactory, options);
}
