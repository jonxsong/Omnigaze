import type {
  AiBudgetCompletion,
  AiBudgetReservation,
  GuardedOmnigazeViewResult,
  OmnigazeAiCacheCodec,
} from "@/lib/ai/omnigaze-view-guard";
import { OmnigazeAiGuardError } from "@/lib/ai/omnigaze-view-guard";
import type { AiGuardrailsBudgetReservationInput } from "@/lib/ai/guardrails-repository";

const sha256Pattern = /^[a-f0-9]{64}$/;
const safeIdentityPattern = /^[A-Za-z0-9._:/-]+$/;
const safeRequestIdPattern = /^[A-Za-z0-9._:-]+$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const DEFAULT_CACHE_TTL_SECONDS = 6 * 60 * 60;
const DEFAULT_RESERVATION_LEASE_SECONDS = 90;

export interface DailyBriefCacheLookup {
  ownerId: string;
  cacheKey: string;
  now: string;
}

export interface DailyBriefCacheRecord {
  ownerId: string;
  cacheKey: string;
  payload: unknown;
  generatedAt: string;
  expiresAt: string;
}

export interface DailyBriefCacheWrite {
  ownerId: string;
  cacheKey: string;
  briefDate: string;
  promptVersion: string;
  modelConfig: string;
  watchlistFingerprint: string;
  evidenceFingerprint: string;
  payload: unknown;
  generatedAt: string;
  expiresAt: string;
}

export interface DailyBriefGuardRepository {
  findCachedDailyBrief(
    lookup: DailyBriefCacheLookup,
  ): Promise<DailyBriefCacheRecord | null>;
  putCachedDailyBrief(record: DailyBriefCacheWrite): Promise<void>;
  reserveBudget(
    input: AiGuardrailsBudgetReservationInput,
  ): Promise<AiBudgetReservation>;
  completeBudget(input: AiBudgetCompletion): Promise<void>;
}

export interface DailyBriefGuardIdentity {
  cacheKey: string;
  briefDate: string;
  promptVersion: string;
  modelConfig: string;
  watchlistFingerprint: string;
  evidenceFingerprint: string;
}

export interface DailyBriefGuardInput<T> {
  ownerId: string;
  requestId?: string;
  identity: DailyBriefGuardIdentity;
  freshness: {
    state: "fresh";
    asOf: string;
    maximumAgeSeconds: number;
  };
  generate(): Promise<T>;
}

export type DailyBriefGuardResult<T> = GuardedOmnigazeViewResult<T> & {
  meta: GuardedOmnigazeViewResult<T>["meta"] & { generatedAt: string };
};

export interface DailyBriefGuardOptions {
  cacheTtlSeconds?: number;
  reservationLeaseSeconds?: number;
  now?: () => Date;
  createRequestId?: () => string;
}

type NormalizedInput<T> = {
  ownerId: string;
  requestId: string;
  identity: DailyBriefGuardIdentity;
  freshnessExpiresAt: string;
  generate(): Promise<T>;
};

function invalid(): never {
  throw new OmnigazeAiGuardError("invalid_guard_request");
}

function bounded(value: string, maximum: number, pattern?: RegExp) {
  if (typeof value !== "string") invalid();
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u001F\u007F]/.test(normalized) ||
    (pattern && !pattern.test(normalized))
  ) {
    invalid();
  }
  return normalized;
}

function iso(value: string) {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalid();
  return new Date(milliseconds).toISOString();
}

function integer(value: number | undefined, fallback: number, min: number, max: number) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < min || candidate > max) {
    invalid();
  }
  return candidate;
}

function validReservation(value: AiBudgetReservation) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.remaining) ||
    value.remaining < 0 ||
    !Number.isSafeInteger(value.limit) ||
    value.limit < 1 ||
    value.remaining > value.limit
  ) {
    return false;
  }
  if (value.granted) {
    return (
      typeof value.reservationId === "string" &&
      value.reservationId.length >= 8 &&
      value.reservationId.length <= 128 &&
      Number.isFinite(Date.parse(value.resetAt))
    );
  }
  return (
    (value.reason === "daily_limit" ||
      value.reason === "rolling_limit" ||
      value.reason === "concurrency_limit") &&
    Number.isFinite(Date.parse(value.retryAt))
  );
}

export class DailyBriefGenerationGuard<T> {
  private readonly inFlight = new Map<string, Promise<DailyBriefGuardResult<T>>>();
  private readonly cacheTtlSeconds: number;
  private readonly reservationLeaseSeconds: number;
  private readonly now: () => Date;
  private readonly createRequestId: () => string;

  constructor(
    private readonly repository: DailyBriefGuardRepository,
    private readonly codec: OmnigazeAiCacheCodec<T>,
    options: DailyBriefGuardOptions = {},
  ) {
    this.cacheTtlSeconds = integer(
      options.cacheTtlSeconds,
      DEFAULT_CACHE_TTL_SECONDS,
      30,
      24 * 60 * 60,
    );
    this.reservationLeaseSeconds = integer(
      options.reservationLeaseSeconds,
      DEFAULT_RESERVATION_LEASE_SECONDS,
      15,
      300,
    );
    this.now = options.now ?? (() => new Date());
    this.createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
  }

  private normalize(input: DailyBriefGuardInput<T>): NormalizedInput<T> {
    if (typeof input.generate !== "function") invalid();
    if (input.freshness?.state !== "fresh") {
      throw new OmnigazeAiGuardError("fresh_evidence_required");
    }
    const ownerId = bounded(input.ownerId, 256);
    const requestId = bounded(
      input.requestId ?? this.createRequestId(),
      128,
      safeRequestIdPattern,
    );
    const identity: DailyBriefGuardIdentity = {
      cacheKey: bounded(input.identity.cacheKey, 64, sha256Pattern),
      briefDate: bounded(input.identity.briefDate, 10, /^\d{4}-\d{2}-\d{2}$/),
      promptVersion: bounded(input.identity.promptVersion, 128, safeIdentityPattern),
      modelConfig: bounded(input.identity.modelConfig, 128, safeIdentityPattern),
      watchlistFingerprint: bounded(
        input.identity.watchlistFingerprint,
        64,
        sha256Pattern,
      ),
      evidenceFingerprint: bounded(
        input.identity.evidenceFingerprint,
        64,
        sha256Pattern,
      ),
    };
    const freshnessAsOf = iso(input.freshness.asOf);
    const maximumAgeSeconds = integer(
      input.freshness.maximumAgeSeconds,
      0,
      1,
      24 * 60 * 60,
    );
    const nowMs = this.now().getTime();
    const freshnessMs = Date.parse(freshnessAsOf);
    const expiresMs = freshnessMs + maximumAgeSeconds * 1_000;
    if (
      !Number.isFinite(nowMs) ||
      freshnessMs > nowMs + MAX_CLOCK_SKEW_MS ||
      expiresMs <= nowMs
    ) {
      throw new OmnigazeAiGuardError("fresh_evidence_required");
    }
    return {
      ownerId,
      requestId,
      identity,
      freshnessExpiresAt: new Date(expiresMs).toISOString(),
      generate: input.generate,
    };
  }

  private async repositoryCall<R>(operation: () => Promise<R>) {
    try {
      return await operation();
    } catch {
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }
  }

  private decodeCache(
    record: DailyBriefCacheRecord,
    input: NormalizedInput<T>,
    nowMs: number,
  ) {
    if (
      record.ownerId !== input.ownerId ||
      record.cacheKey !== input.identity.cacheKey ||
      !Number.isFinite(Date.parse(record.generatedAt)) ||
      !Number.isFinite(Date.parse(record.expiresAt)) ||
      Date.parse(record.generatedAt) > nowMs + MAX_CLOCK_SKEW_MS
    ) {
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }
    const expiresAt = Math.min(
      Date.parse(record.expiresAt),
      Date.parse(input.freshnessExpiresAt),
    );
    if (expiresAt <= nowMs) return null;
    try {
      return {
        value: this.codec.decode(record.payload),
        generatedAt: new Date(Date.parse(record.generatedAt)).toISOString(),
        expiresAt: new Date(expiresAt).toISOString(),
      };
    } catch {
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }
  }

  private async complete(input: AiBudgetCompletion) {
    await this.repositoryCall(() => this.repository.completeBudget(input));
  }

  private async generate(
    input: NormalizedInput<T>,
  ): Promise<DailyBriefGuardResult<T>> {
    const requestedAt = this.now();
    const reservation = await this.repositoryCall(() =>
      this.repository.reserveBudget({
        ownerId: input.ownerId,
        operation: "daily_brief",
        operationKey: input.identity.cacheKey,
        requestId: input.requestId,
        cost: 1,
        requestedAt: requestedAt.toISOString(),
        leaseExpiresAt: new Date(
          requestedAt.getTime() + this.reservationLeaseSeconds * 1_000,
        ).toISOString(),
      }),
    );
    if (!validReservation(reservation)) {
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }
    if (!reservation.granted) {
      const retryAt = Date.parse(reservation.retryAt);
      if (retryAt <= requestedAt.getTime()) {
        throw new OmnigazeAiGuardError("ai_guard_unavailable");
      }
      throw new OmnigazeAiGuardError(
        "ai_rate_limited",
        new Date(retryAt).toISOString(),
        Math.max(1, Math.ceil((retryAt - requestedAt.getTime()) / 1_000)),
        reservation.reason,
      );
    }
    if (Date.parse(reservation.resetAt) <= requestedAt.getTime()) {
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }

    let value: T;
    try {
      value = this.codec.decode(this.codec.encode(await input.generate()));
    } catch (error) {
      await this.complete({
        reservationId: reservation.reservationId,
        outcome: "failed",
        completedAt: this.now().toISOString(),
      });
      throw error;
    }

    const generatedAt = this.now();
    const expiresAtMs = Math.min(
      generatedAt.getTime() + this.cacheTtlSeconds * 1_000,
      Date.parse(input.freshnessExpiresAt),
    );
    if (expiresAtMs <= generatedAt.getTime()) {
      await this.complete({
        reservationId: reservation.reservationId,
        outcome: "failed",
        completedAt: this.now().toISOString(),
      });
      throw new OmnigazeAiGuardError("fresh_evidence_required");
    }
    try {
      await this.repositoryCall(() =>
        this.repository.putCachedDailyBrief({
          ownerId: input.ownerId,
          ...input.identity,
          payload: this.codec.encode(value),
          generatedAt: generatedAt.toISOString(),
          expiresAt: new Date(expiresAtMs).toISOString(),
        }),
      );
    } catch {
      await this.complete({
        reservationId: reservation.reservationId,
        outcome: "succeeded",
        completedAt: this.now().toISOString(),
      });
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }
    await this.complete({
      reservationId: reservation.reservationId,
      outcome: "succeeded",
      completedAt: this.now().toISOString(),
    });
    return {
      value,
      meta: {
        source: "generated",
        deduplicated: false,
        modelConfig: input.identity.modelConfig,
        evidenceFingerprint: input.identity.evidenceFingerprint,
        cacheExpiresAt: new Date(expiresAtMs).toISOString(),
        generatedAt: generatedAt.toISOString(),
        budget: {
          charged: true,
          remaining: reservation.remaining,
          limit: reservation.limit,
          resetAt: new Date(Date.parse(reservation.resetAt)).toISOString(),
        },
      },
    };
  }

  async execute(request: DailyBriefGuardInput<T>): Promise<DailyBriefGuardResult<T>> {
    const input = this.normalize(request);
    const now = this.now();
    const cached = await this.repositoryCall(() =>
      this.repository.findCachedDailyBrief({
        ownerId: input.ownerId,
        cacheKey: input.identity.cacheKey,
        now: now.toISOString(),
      }),
    );
    if (cached) {
      const decoded = this.decodeCache(cached, input, now.getTime());
      if (decoded) {
        return {
          value: decoded.value,
          meta: {
            source: "cache",
            deduplicated: false,
            modelConfig: input.identity.modelConfig,
            evidenceFingerprint: input.identity.evidenceFingerprint,
            cacheExpiresAt: decoded.expiresAt,
            generatedAt: decoded.generatedAt,
            budget: {
              charged: false,
              remaining: null,
              limit: null,
              resetAt: null,
            },
          },
        };
      }
    }

    const inFlightKey = `${input.ownerId}\0${input.identity.cacheKey}`;
    const existing = this.inFlight.get(inFlightKey);
    if (existing) {
      const result = await existing;
      if (Date.parse(result.meta.cacheExpiresAt) <= this.now().getTime()) {
        throw new OmnigazeAiGuardError("fresh_evidence_required");
      }
      return {
        ...result,
        meta: {
          ...result.meta,
          deduplicated: true,
          budget: {
            charged: false,
            remaining: null,
            limit: null,
            resetAt: null,
          },
        },
      };
    }

    const generation = this.generate(input);
    this.inFlight.set(inFlightKey, generation);
    try {
      return await generation;
    } finally {
      if (this.inFlight.get(inFlightKey) === generation) {
        this.inFlight.delete(inFlightKey);
      }
    }
  }
}
