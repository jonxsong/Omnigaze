import { and, eq, inArray, lte, lt, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  aiModelBudgetReservations,
  aiViewCacheEntries,
} from "@/db/schema";
import type {
  AiBudgetCompletion,
  AiBudgetReservation,
  AiBudgetReservationInput,
  AiViewCacheLookup,
  AiViewCacheRecord,
  OmnigazeAiGuardRepository,
} from "@/lib/ai/omnigaze-view-guard";

export const AI_VIEW_CACHE_MAX_PAYLOAD_BYTES = 64 * 1_024;
export const AI_VIEW_CACHE_MAX_TTL_MS = 24 * 60 * 60 * 1_000;
export const AI_BUDGET_RESERVATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;
const hexDigestPattern = /^[a-f0-9]{64}$/;
const DEFAULT_PRUNE_LIMIT = 100;
const MAX_PRUNE_LIMIT = 500;
type GuardrailsDatabase = ReturnType<typeof getDb>;

export type AiGuardrailsRepositoryErrorCode =
  | "invalid_input"
  | "idempotency_conflict"
  | "reservation_not_found"
  | "reservation_terminal_conflict"
  | "cache_payload_invalid";

export class AiGuardrailsRepositoryError extends Error {
  constructor(readonly code: AiGuardrailsRepositoryErrorCode) {
    super(code);
    this.name = "AiGuardrailsRepositoryError";
  }
}

export interface AiGuardrailsRepositoryOptions {
  dailyLimit?: number;
  concurrencyLimit?: number;
  rollingLimit?: number;
  rollingWindowSeconds?: number;
  now?: () => Date;
  createReservationId?: () => string;
}

export interface AiBudgetUsageSnapshot {
  dailyUsed: number;
  dailyLimit: number;
  dailyRemaining: number;
  rollingUsed: number;
  rollingLimit: number;
  rollingRemaining: number;
  activeReservations: number;
  concurrencyLimit: number;
  concurrencyRemaining: number;
  resetAt: string;
}

export interface AiGuardrailsOperationalRepository
  extends OmnigazeAiGuardRepository {
  getBudgetUsage(ownerId: string, at: string): Promise<AiBudgetUsageSnapshot>;
  prune(now: string, limit?: number): Promise<{
    cacheEntriesPruned: number;
    budgetReservationsPruned: number;
  }>;
}

type Policy = {
  dailyLimit: number;
  concurrencyLimit: number;
  rollingLimit: number;
  rollingWindowMs: number;
};

type ReservationInput = {
  ownerId: string;
  operation: "omnigaze_view";
  operationKeyHash: string;
  requestKeyHash: string;
  cost: number;
  requestedAt: string;
  leaseExpiresAt: string;
  dayStart: string;
  rollingWindowStart: string;
};

function invalid(): never {
  throw new AiGuardrailsRepositoryError("invalid_input");
}

function boundedText(value: string, min: number, max: number) {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length < min ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalid();
  }
  return value;
}

function iso(value: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid();
  return new Date(milliseconds).toISOString();
}

function integer(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    invalid();
  }
  return candidate;
}

function policyFrom(options: AiGuardrailsRepositoryOptions): Policy {
  return {
    dailyLimit: integer(options.dailyLimit, 20, 1, 10_000),
    concurrencyLimit: integer(options.concurrencyLimit, 2, 1, 100),
    rollingLimit: integer(options.rollingLimit, 5, 1, 1_000),
    rollingWindowMs: integer(options.rollingWindowSeconds, 60, 1, 3_600) * 1_000,
  };
}

function nextUtcDay(value: string) {
  const date = new Date(value);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1),
  ).toISOString();
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeLookup(input: AiViewCacheLookup) {
  const symbolId = boundedText(input.symbolId, 3, 64).toUpperCase();
  if (!canonicalSymbolPattern.test(symbolId)) invalid();
  const evidenceFingerprint = boundedText(
    input.evidenceFingerprint,
    64,
    64,
  ).toLowerCase();
  if (!hexDigestPattern.test(evidenceFingerprint)) invalid();
  return {
    symbolId: symbolId as AiViewCacheLookup["symbolId"],
    promptVersion: boundedText(input.promptVersion, 1, 128),
    modelConfig: boundedText(input.modelConfig, 1, 128),
    evidenceFingerprint,
  };
}

export async function createAiViewCacheKey(input: AiViewCacheLookup) {
  const value = normalizeLookup(input);
  return sha256(
    JSON.stringify([
      "omnigaze.ai-view-cache.v1",
      value.symbolId,
      value.promptVersion,
      value.modelConfig,
      value.evidenceFingerprint,
    ]),
  );
}

function forbiddenField(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(forbiddenField);
  const forbidden = new Set([
    "prompt", "systemprompt", "userprompt", "messages", "modelinput",
    "providerpayload", "rawproviderpayload", "apikey", "authorization",
    "requestheaders", "headers", "secret", "accesstoken", "refreshtoken",
  ]);
  return Object.entries(value).some(([key, child]) =>
    forbidden.has(key.toLowerCase().replace(/[^a-z0-9]/g, "")) || forbiddenField(child),
  );
}

function serializePayload(value: unknown) {
  if (forbiddenField(value)) {
    throw new AiGuardrailsRepositoryError("cache_payload_invalid");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new AiGuardrailsRepositoryError("cache_payload_invalid");
  }
  if (
    !serialized ||
    serialized.length < 2 ||
    new TextEncoder().encode(serialized).byteLength > AI_VIEW_CACHE_MAX_PAYLOAD_BYTES
  ) {
    throw new AiGuardrailsRepositoryError("cache_payload_invalid");
  }
  return serialized;
}

function parsePayload(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (forbiddenField(parsed)) throw new Error("forbidden");
    return parsed;
  } catch {
    throw new AiGuardrailsRepositoryError("cache_payload_invalid");
  }
}

async function normalizeReservation(
  input: AiBudgetReservationInput,
  policy: Policy,
): Promise<ReservationInput> {
  const ownerId = boundedText(input.ownerId, 1, 256);
  if (input.operation !== "omnigaze_view") invalid();
  const operationKey = boundedText(input.operationKey, 1, 512);
  const requestId = boundedText(input.requestId, 1, 128);
  const cost = integer(input.cost, 1, 1, 10);
  const requestedAt = iso(input.requestedAt);
  const leaseExpiresAt = iso(input.leaseExpiresAt);
  const leaseMs = Date.parse(leaseExpiresAt) - Date.parse(requestedAt);
  if (leaseMs <= 0 || leaseMs > 15 * 60 * 1_000) invalid();
  return {
    ownerId,
    operation: input.operation,
    operationKeyHash: await sha256(
      `omnigaze.ai-operation.v1\0${input.operation}\0${operationKey}`,
    ),
    requestKeyHash: await sha256(
      `omnigaze.ai-request.v1\0${ownerId}\0${requestId}`,
    ),
    cost,
    requestedAt,
    leaseExpiresAt,
    dayStart: requestedAt.slice(0, 10),
    rollingWindowStart: new Date(
      Date.parse(requestedAt) - policy.rollingWindowMs,
    ).toISOString(),
  };
}

async function byRequest(db: GuardrailsDatabase, ownerId: string, requestKeyHash: string) {
  return (
    await db.select().from(aiModelBudgetReservations).where(and(
      eq(aiModelBudgetReservations.ownerId, ownerId),
      eq(aiModelBudgetReservations.requestKeyHash, requestKeyHash),
    )).limit(1)
  )[0];
}

async function usage(
  db: GuardrailsDatabase,
  ownerId: string,
  rawAt: string,
  policy: Policy,
): Promise<AiBudgetUsageSnapshot> {
  const at = iso(rawAt);
  const dayStart = at.slice(0, 10);
  const rollingStart = new Date(Date.parse(at) - policy.rollingWindowMs).toISOString();
  const values = await db.values<[number, number, number]>(sql`
    SELECT
      COALESCE(SUM(CASE WHEN day_start = ${dayStart} THEN cost ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN julianday(reserved_at) >= julianday(${rollingStart})
        AND julianday(reserved_at) <= julianday(${at}) THEN cost ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN status = 'reserved'
        AND julianday(lease_expires_at) > julianday(${at}) THEN 1 ELSE 0 END), 0)
    FROM ${aiModelBudgetReservations}
    WHERE owner_id = ${ownerId}
  `);
  const [dailyUsed = 0, rollingUsed = 0, activeReservations = 0] = values[0] ?? [];
  return {
    dailyUsed,
    dailyLimit: policy.dailyLimit,
    dailyRemaining: Math.max(0, policy.dailyLimit - dailyUsed),
    rollingUsed,
    rollingLimit: policy.rollingLimit,
    rollingRemaining: Math.max(0, policy.rollingLimit - rollingUsed),
    activeReservations,
    concurrencyLimit: policy.concurrencyLimit,
    concurrencyRemaining: Math.max(0, policy.concurrencyLimit - activeReservations),
    resetAt: nextUtcDay(at),
  };
}

function granted(
  row: typeof aiModelBudgetReservations.$inferSelect,
  state: AiBudgetUsageSnapshot,
): AiBudgetReservation {
  return {
    granted: true,
    reservationId: row.reservationId,
    remaining: state.dailyRemaining,
    limit: state.dailyLimit,
    resetAt: state.resetAt,
  };
}

async function capacityRetryAt(
  db: GuardrailsDatabase,
  input: ReservationInput,
  policy: Policy,
  state: AiBudgetUsageSnapshot,
) {
  if (state.dailyRemaining < input.cost) return state.resetAt;
  const candidates: number[] = [];
  if (state.rollingRemaining < input.cost) {
    const oldest = await db.values<[string]>(sql`
      SELECT reserved_at FROM ${aiModelBudgetReservations}
      WHERE owner_id = ${input.ownerId}
        AND julianday(reserved_at) >= julianday(${input.rollingWindowStart})
        AND julianday(reserved_at) <= julianday(${input.requestedAt})
      ORDER BY reserved_at ASC LIMIT 1
    `);
    if (oldest[0]?.[0]) {
      candidates.push(Date.parse(oldest[0][0]) + policy.rollingWindowMs + 1_000);
    }
  }
  if (state.concurrencyRemaining < 1) {
    const lease = await db.values<[string]>(sql`
      SELECT lease_expires_at FROM ${aiModelBudgetReservations}
      WHERE owner_id = ${input.ownerId} AND status = 'reserved'
        AND julianday(lease_expires_at) > julianday(${input.requestedAt})
      ORDER BY lease_expires_at ASC LIMIT 1
    `);
    if (lease[0]?.[0]) candidates.push(Date.parse(lease[0][0]));
  }
  return new Date(
    Math.max(Date.parse(input.requestedAt) + 1_000, ...candidates),
  ).toISOString();
}

async function reserve(
  db: GuardrailsDatabase,
  rawInput: AiBudgetReservationInput,
  policy: Policy,
  createId: () => string,
): Promise<AiBudgetReservation> {
  const input = await normalizeReservation(rawInput, policy);
  const reservationId = boundedText(createId(), 8, 128);
  const inserted = await db.values<[string]>(sql`
    INSERT INTO ${aiModelBudgetReservations} (
      reservation_id, owner_id, request_key_hash, operation,
      operation_key_hash, cost, day_start, status, reserved_at, lease_expires_at
    )
    SELECT ${reservationId}, ${input.ownerId}, ${input.requestKeyHash},
      ${input.operation}, ${input.operationKeyHash}, ${input.cost},
      ${input.dayStart}, 'reserved', ${input.requestedAt}, ${input.leaseExpiresAt}
    WHERE COALESCE((SELECT SUM(cost) FROM ${aiModelBudgetReservations} daily
      WHERE daily.owner_id = ${input.ownerId} AND daily.day_start = ${input.dayStart}), 0)
        + ${input.cost} <= ${policy.dailyLimit}
      AND COALESCE((SELECT SUM(cost) FROM ${aiModelBudgetReservations} rolling
        WHERE rolling.owner_id = ${input.ownerId}
          AND julianday(rolling.reserved_at) >= julianday(${input.rollingWindowStart})
          AND julianday(rolling.reserved_at) <= julianday(${input.requestedAt})), 0)
        + ${input.cost} <= ${policy.rollingLimit}
      AND (SELECT COUNT(*) FROM ${aiModelBudgetReservations} active
        WHERE active.owner_id = ${input.ownerId} AND active.status = 'reserved'
          AND julianday(active.lease_expires_at) > julianday(${input.requestedAt}))
        < ${policy.concurrencyLimit}
    ON CONFLICT (owner_id, request_key_hash) DO NOTHING
    RETURNING reservation_id
  `);
  let row = await byRequest(db, input.ownerId, input.requestKeyHash);
  if (inserted.length > 0 && row) {
    return granted(row, await usage(db, input.ownerId, input.requestedAt, policy));
  }
  if (row) {
    if (
      row.operation !== input.operation ||
      row.operationKeyHash !== input.operationKeyHash ||
      row.cost !== input.cost
    ) {
      throw new AiGuardrailsRepositoryError("idempotency_conflict");
    }
    if (row.status === "reserved" && Date.parse(row.leaseExpiresAt) > Date.parse(input.requestedAt)) {
      const state = await usage(db, input.ownerId, input.requestedAt, policy);
      return {
        granted: false,
        reason: "concurrency_limit",
        remaining: state.dailyRemaining,
        limit: state.dailyLimit,
        retryAt: row.leaseExpiresAt,
      };
    }
    if (row.status !== "reserved") {
      throw new AiGuardrailsRepositoryError("reservation_terminal_conflict");
    }
    const reclaimedId = boundedText(createId(), 8, 128);
    const reclaimed = await db.values<[string]>(sql`
      UPDATE ${aiModelBudgetReservations}
      SET reservation_id = ${reclaimedId}, day_start = ${input.dayStart},
          reserved_at = ${input.requestedAt}, lease_expires_at = ${input.leaseExpiresAt}
      WHERE reservation_id = ${row.reservationId} AND status = 'reserved'
        AND julianday(lease_expires_at) <= julianday(${input.requestedAt})
        AND COALESCE((SELECT SUM(cost) FROM ${aiModelBudgetReservations} daily
          WHERE daily.owner_id = ${input.ownerId} AND daily.day_start = ${input.dayStart}
            AND daily.reservation_id <> ${row.reservationId}), 0)
          + ${input.cost} <= ${policy.dailyLimit}
        AND COALESCE((SELECT SUM(cost) FROM ${aiModelBudgetReservations} rolling
          WHERE rolling.owner_id = ${input.ownerId}
            AND rolling.reservation_id <> ${row.reservationId}
            AND julianday(rolling.reserved_at) >= julianday(${input.rollingWindowStart})
            AND julianday(rolling.reserved_at) <= julianday(${input.requestedAt})), 0)
          + ${input.cost} <= ${policy.rollingLimit}
        AND (SELECT COUNT(*) FROM ${aiModelBudgetReservations} active
          WHERE active.owner_id = ${input.ownerId}
            AND active.reservation_id <> ${row.reservationId}
            AND active.status = 'reserved'
            AND julianday(active.lease_expires_at) > julianday(${input.requestedAt}))
          < ${policy.concurrencyLimit}
      RETURNING reservation_id
    `);
    row = await byRequest(db, input.ownerId, input.requestKeyHash);
    if (reclaimed.length > 0 && row) {
      return granted(row, await usage(db, input.ownerId, input.requestedAt, policy));
    }
    if (row?.status === "reserved" && Date.parse(row.leaseExpiresAt) > Date.parse(input.requestedAt)) {
      const state = await usage(db, input.ownerId, input.requestedAt, policy);
      return {
        granted: false,
        reason: "concurrency_limit",
        remaining: state.dailyRemaining,
        limit: state.dailyLimit,
        retryAt: row.leaseExpiresAt,
      };
    }
  }
  const state = await usage(db, input.ownerId, input.requestedAt, policy);
  const reason =
    state.dailyRemaining < input.cost
      ? "daily_limit"
      : state.rollingRemaining < input.cost
        ? "rolling_limit"
        : "concurrency_limit";
  return {
    granted: false,
    reason,
    remaining: state.dailyRemaining,
    limit: state.dailyLimit,
    retryAt: await capacityRetryAt(db, input, policy, state),
  };
}

async function complete(db: GuardrailsDatabase, input: AiBudgetCompletion) {
  const reservationId = boundedText(input.reservationId, 8, 128);
  const completedAt = iso(input.completedAt);
  if (input.outcome !== "succeeded" && input.outcome !== "failed") invalid();
  const target = input.outcome === "succeeded" ? "completed" : "failed";
  const safeErrorCode = input.outcome === "failed" ? "generation_failed" : null;
  const updated = await db.update(aiModelBudgetReservations)
    .set({ status: target, completedAt, safeErrorCode })
    .where(and(
      eq(aiModelBudgetReservations.reservationId, reservationId),
      eq(aiModelBudgetReservations.status, "reserved"),
      sql`julianday(${aiModelBudgetReservations.reservedAt}) <= julianday(${completedAt})`,
    )).returning({ reservationId: aiModelBudgetReservations.reservationId });
  if (updated[0]) return;
  const existing = (
    await db.select({
      status: aiModelBudgetReservations.status,
    }).from(aiModelBudgetReservations)
      .where(eq(aiModelBudgetReservations.reservationId, reservationId)).limit(1)
  )[0];
  if (!existing) throw new AiGuardrailsRepositoryError("reservation_not_found");
  if (existing.status === target) return;
  throw new AiGuardrailsRepositoryError("reservation_terminal_conflict");
}

export function createAiGuardrailsRepository(
  databaseFactory: () => GuardrailsDatabase = getDb,
  options: AiGuardrailsRepositoryOptions = {},
): AiGuardrailsOperationalRepository {
  const policy = policyFrom(options);
  const now = options.now ?? (() => new Date());
  const createId = options.createReservationId ?? (() => `air_${crypto.randomUUID()}`);
  return {
    async findCachedView(rawLookup) {
      const lookup = normalizeLookup(rawLookup);
      const cacheKey = await createAiViewCacheKey(lookup);
      const checkedAt = iso(now().toISOString());
      const db = databaseFactory();
      const row = (
        await db.select().from(aiViewCacheEntries).where(and(
          eq(aiViewCacheEntries.cacheKey, cacheKey),
          eq(aiViewCacheEntries.symbolId, lookup.symbolId),
          eq(aiViewCacheEntries.promptVersion, lookup.promptVersion),
          eq(aiViewCacheEntries.modelKey, lookup.modelConfig),
          eq(aiViewCacheEntries.evidenceFingerprint, lookup.evidenceFingerprint),
          sql`julianday(${aiViewCacheEntries.expiresAt}) > julianday(${checkedAt})`,
        )).limit(1)
      )[0];
      if (!row) return null;
      await db.update(aiViewCacheEntries).set({
        lastAccessedAt: checkedAt,
        hitCount: sql`${aiViewCacheEntries.hitCount} + 1`,
      }).where(eq(aiViewCacheEntries.cacheKey, cacheKey));
      return {
        symbolId: row.symbolId as AiViewCacheRecord["symbolId"],
        promptVersion: row.promptVersion,
        modelConfig: row.modelKey,
        evidenceFingerprint: row.evidenceFingerprint,
        payload: parsePayload(row.responseJson),
        generatedAt: row.generatedAt,
        expiresAt: row.expiresAt,
      };
    },

    async putCachedView(rawRecord) {
      const lookup = normalizeLookup(rawRecord);
      const cacheKey = await createAiViewCacheKey(lookup);
      const generatedAt = iso(rawRecord.generatedAt);
      const expiresAt = iso(rawRecord.expiresAt);
      const ttl = Date.parse(expiresAt) - Date.parse(generatedAt);
      if (ttl <= 0 || ttl > AI_VIEW_CACHE_MAX_TTL_MS) invalid();
      const responseJson = serializePayload(rawRecord.payload);
      await databaseFactory().insert(aiViewCacheEntries).values({
        cacheKey,
        symbolId: lookup.symbolId,
        promptVersion: lookup.promptVersion,
        modelKey: lookup.modelConfig,
        evidenceFingerprint: lookup.evidenceFingerprint,
        responseJson,
        generatedAt,
        expiresAt,
        lastAccessedAt: generatedAt,
      }).onConflictDoUpdate({
        target: aiViewCacheEntries.cacheKey,
        set: { responseJson, generatedAt, expiresAt, lastAccessedAt: generatedAt, hitCount: 0 },
      });
    },

    reserveBudget(input) {
      return reserve(databaseFactory(), input, policy, createId);
    },

    completeBudget(input) {
      return complete(databaseFactory(), input);
    },

    getBudgetUsage(ownerId, at) {
      return usage(databaseFactory(), boundedText(ownerId, 1, 256), at, policy);
    },

    async prune(rawNow, rawLimit = DEFAULT_PRUNE_LIMIT) {
      const checkedAt = iso(rawNow);
      if (!Number.isFinite(rawLimit)) invalid();
      const limit = Math.max(1, Math.min(Math.trunc(rawLimit), MAX_PRUNE_LIMIT));
      const db = databaseFactory();
      const cacheKeys = db.select({ cacheKey: aiViewCacheEntries.cacheKey })
        .from(aiViewCacheEntries).where(lte(aiViewCacheEntries.expiresAt, checkedAt)).limit(limit);
      const cacheRows = await db.delete(aiViewCacheEntries)
        .where(inArray(aiViewCacheEntries.cacheKey, cacheKeys))
        .returning({ cacheKey: aiViewCacheEntries.cacheKey });
      const cutoff = new Date(
        Date.parse(checkedAt) - AI_BUDGET_RESERVATION_RETENTION_MS,
      ).toISOString();
      const reservationIds = db.select({ reservationId: aiModelBudgetReservations.reservationId })
        .from(aiModelBudgetReservations)
        .where(lt(aiModelBudgetReservations.reservedAt, cutoff)).limit(limit);
      const budgetRows = await db.delete(aiModelBudgetReservations)
        .where(inArray(aiModelBudgetReservations.reservationId, reservationIds))
        .returning({ reservationId: aiModelBudgetReservations.reservationId });
      return {
        cacheEntriesPruned: cacheRows.length,
        budgetReservationsPruned: budgetRows.length,
      };
    },
  };
}

export const aiGuardrailsRepository = createAiGuardrailsRepository();
