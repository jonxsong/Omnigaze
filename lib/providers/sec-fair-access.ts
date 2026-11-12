import { sql, type SQL } from "drizzle-orm";
import { secFairAccessControl } from "@/db/schema";

const PROVIDER = "sec-edgar";
const DEFAULT_MINIMUM_INTERVAL_MS = 125;
const DEFAULT_MAX_WAIT_MS = 2_000;
const MINIMUM_COOLDOWN_SECONDS = 10 * 60;
const MAXIMUM_COOLDOWN_SECONDS = 24 * 60 * 60;
const MAXIMUM_WAIT_MS = 30_000;

type SecFairAccessDatabase = {
  values<T extends unknown[]>(query: SQL): Promise<T[]>;
};

type SecFairAccessDatabaseFactory =
  () => SecFairAccessDatabase | Promise<SecFairAccessDatabase>;

async function runtimeDatabaseFactory(): Promise<SecFairAccessDatabase> {
  const { getDb } = await import("@/db");
  return getDb() as SecFairAccessDatabase;
}

export type SecFairAccessCoordinatorErrorCode =
  | "coordinator_unavailable"
  | "admission_deadline_exceeded"
  | "cooldown";

export class SecFairAccessCoordinatorError extends Error {
  constructor(
    readonly code: SecFairAccessCoordinatorErrorCode,
    readonly retryAfterSeconds?: number,
  ) {
    super(
      code === "cooldown"
        ? "SEC Fair Access cooldown is active."
        : code === "admission_deadline_exceeded"
          ? "SEC Fair Access admission deadline was exceeded."
          : "SEC Fair Access coordination is unavailable.",
    );
    this.name = "SecFairAccessCoordinatorError";
  }
}

export type SecFairAccessStatus =
  | { status: "ready"; retryAfterSeconds: null }
  | { status: "cooldown"; retryAfterSeconds: number }
  | { status: "unavailable"; retryAfterSeconds: null };

export interface SecFairAccessCoordinator {
  acquire(): Promise<void>;
  imposeCooldown(retryAfterSeconds?: number): Promise<void>;
  getStatus(): Promise<SecFairAccessStatus>;
}

export interface SecFairAccessCoordinatorOptions {
  minimumIntervalMs?: number;
  maxWaitMs?: number;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

type Policy = {
  minimumIntervalMs: number;
  maxWaitMs: number;
};

function integer(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const candidate = value ?? fallback;
  if (
    !Number.isSafeInteger(candidate) ||
    candidate < minimum ||
    candidate > maximum
  ) {
    throw new Error("invalid_sec_fair_access_policy");
  }
  return candidate;
}

function policyFrom(options: SecFairAccessCoordinatorOptions): Policy {
  return {
    minimumIntervalMs: integer(
      options.minimumIntervalMs,
      DEFAULT_MINIMUM_INTERVAL_MS,
      DEFAULT_MINIMUM_INTERVAL_MS,
      10_000,
    ),
    maxWaitMs: integer(
      options.maxWaitMs,
      DEFAULT_MAX_WAIT_MS,
      0,
      MAXIMUM_WAIT_MS,
    ),
  };
}

function wait(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function validClockRow(row: unknown[] | undefined) {
  if (
    !row ||
    row.length < 3 ||
    row.some(
      (value, index) =>
        index < 3 &&
        (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0),
    )
  ) {
    return null;
  }
  return {
    nextAdmissionAtMs: row[0] as number,
    cooldownUntilMs: row[1] as number,
    databaseNowMs: row[2] as number,
  };
}

function retrySeconds(milliseconds: number) {
  return Math.max(1, Math.ceil(milliseconds / 1_000));
}

function normalizedCooldownSeconds(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return MINIMUM_COOLDOWN_SECONDS;
  }
  return Math.min(
    MAXIMUM_COOLDOWN_SECONDS,
    Math.max(MINIMUM_COOLDOWN_SECONDS, Math.ceil(value)),
  );
}

function unavailable(): never {
  throw new SecFairAccessCoordinatorError("coordinator_unavailable");
}

class D1SecFairAccessCoordinator implements SecFairAccessCoordinator {
  private readonly policy: Policy;
  private readonly monotonicNow: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly databaseFactory: SecFairAccessDatabaseFactory,
    options: SecFairAccessCoordinatorOptions,
  ) {
    this.policy = policyFrom(options);
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.sleep = options.sleep ?? wait;
  }

  private async database() {
    try {
      return await this.databaseFactory();
    } catch {
      unavailable();
    }
  }

  private async tryAcquire() {
    const database = await this.database();
    try {
      const rows = await database.values<[number, number, number]>(sql`
        INSERT INTO ${secFairAccessControl} (
          provider, next_admission_at_ms, cooldown_until_ms, updated_at
        ) VALUES (
          ${PROVIDER},
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            + ${this.policy.minimumIntervalMs},
          0,
          CURRENT_TIMESTAMP
        )
        ON CONFLICT(provider) DO UPDATE SET
          next_admission_at_ms =
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
              + ${this.policy.minimumIntervalMs},
          updated_at = CURRENT_TIMESTAMP
        WHERE CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
              >= next_admission_at_ms
          AND CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
              >= cooldown_until_ms
        RETURNING
          next_admission_at_ms,
          cooldown_until_ms,
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
      `);
      if (rows.length === 0) return null;
      const row = validClockRow(rows[0]);
      if (!row) unavailable();
      return row;
    } catch (error) {
      if (error instanceof SecFairAccessCoordinatorError) throw error;
      unavailable();
    }
  }

  private async readState() {
    const database = await this.database();
    try {
      const rows = await database.values<[number, number, number]>(sql`
        SELECT
          next_admission_at_ms,
          cooldown_until_ms,
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
        FROM ${secFairAccessControl}
        WHERE provider = ${PROVIDER}
        LIMIT 1
      `);
      if (rows.length === 0) return null;
      const row = validClockRow(rows[0]);
      if (!row) unavailable();
      return row;
    } catch (error) {
      if (error instanceof SecFairAccessCoordinatorError) throw error;
      unavailable();
    }
  }

  async acquire() {
    const startedAt = this.monotonicNow();
    let attempted = false;

    while (true) {
      const elapsedBeforeAttempt = Math.max(
        0,
        this.monotonicNow() - startedAt,
      );
      if (attempted && elapsedBeforeAttempt >= this.policy.maxWaitMs) {
        throw new SecFairAccessCoordinatorError(
          "admission_deadline_exceeded",
          1,
        );
      }
      attempted = true;
      if (await this.tryAcquire()) return;
      const state = await this.readState();
      if (!state) unavailable();

      const cooldownDelay = state.cooldownUntilMs - state.databaseNowMs;
      if (cooldownDelay > 0) {
        throw new SecFairAccessCoordinatorError(
          "cooldown",
          retrySeconds(cooldownDelay),
        );
      }

      const delay = Math.max(
        1,
        state.nextAdmissionAtMs - state.databaseNowMs,
      );
      const elapsed = Math.max(0, this.monotonicNow() - startedAt);
      const remaining = this.policy.maxWaitMs - elapsed;
      if (delay > remaining) {
        throw new SecFairAccessCoordinatorError(
          "admission_deadline_exceeded",
          retrySeconds(delay),
        );
      }

      try {
        await this.sleep(delay);
      } catch {
        unavailable();
      }
    }
  }

  async imposeCooldown(retryAfterSeconds?: number) {
    const database = await this.database();
    const cooldownSeconds = normalizedCooldownSeconds(retryAfterSeconds);
    try {
      const rows = await database.values<[number]>(sql`
        INSERT INTO ${secFairAccessControl} (
          provider, next_admission_at_ms, cooldown_until_ms, updated_at
        ) VALUES (
          ${PROVIDER},
          0,
          CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
            + ${cooldownSeconds * 1_000},
          CURRENT_TIMESTAMP
        )
        ON CONFLICT(provider) DO UPDATE SET
          cooldown_until_ms = MAX(
            cooldown_until_ms,
            CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)
              + ${cooldownSeconds * 1_000}
          ),
          updated_at = CURRENT_TIMESTAMP
        RETURNING cooldown_until_ms
      `);
      if (
        rows.length !== 1 ||
        typeof rows[0]?.[0] !== "number" ||
        !Number.isSafeInteger(rows[0][0]) ||
        rows[0][0] < 0
      ) {
        unavailable();
      }
    } catch (error) {
      if (error instanceof SecFairAccessCoordinatorError) throw error;
      unavailable();
    }
  }

  async getStatus(): Promise<SecFairAccessStatus> {
    try {
      const state = await this.readState();
      if (!state) return { status: "ready", retryAfterSeconds: null };
      const cooldownDelay = state.cooldownUntilMs - state.databaseNowMs;
      return cooldownDelay > 0
        ? {
            status: "cooldown",
            retryAfterSeconds: retrySeconds(cooldownDelay),
          }
        : { status: "ready", retryAfterSeconds: null };
    } catch {
      return { status: "unavailable", retryAfterSeconds: null };
    }
  }
}

export function createSecFairAccessCoordinator(
  databaseFactory: SecFairAccessDatabaseFactory = runtimeDatabaseFactory,
  options: SecFairAccessCoordinatorOptions = {},
): SecFairAccessCoordinator {
  return new D1SecFairAccessCoordinator(databaseFactory, options);
}
