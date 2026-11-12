import type { CanonicalSymbol } from "@/lib/market-types";

const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;
const safeVersionPattern = /^[A-Za-z0-9._:-]+$/;
const safeModelPattern = /^[A-Za-z0-9._:/-]+$/;
const safeRequestIdPattern = /^[A-Za-z0-9._:-]+$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const textEncoder = new TextEncoder();

const DEFAULT_CACHE_TTL_SECONDS = 300;
const DEFAULT_RESERVATION_LEASE_SECONDS = 90;
const DEFAULT_MAX_CACHE_PAYLOAD_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const OMNIGAZE_DEFAULT_MODEL_CONFIG = "openai-agents-sdk-default";

export type OmnigazeAiGuardErrorCode =
  | "invalid_guard_request"
  | "fresh_evidence_required"
  | "ai_rate_limited"
  | "ai_guard_unavailable";

const guardErrorContract: Record<
  OmnigazeAiGuardErrorCode,
  { status: number; message: string }
> = {
  invalid_guard_request: {
    status: 400,
    message: "The AI analysis request is invalid.",
  },
  fresh_evidence_required: {
    status: 422,
    message: "Fresh provider evidence is required for an Omnigaze View.",
  },
  ai_rate_limited: {
    status: 429,
    message: "The AI analysis budget is temporarily exhausted.",
  },
  ai_guard_unavailable: {
    status: 503,
    message: "AI usage controls are temporarily unavailable.",
  },
};

export class OmnigazeAiGuardError extends Error {
  readonly status: number;

  constructor(
    readonly code: OmnigazeAiGuardErrorCode,
    readonly retryAt: string | null = null,
    readonly retryAfterSeconds: number | null = null,
    readonly budgetReason: AiBudgetDenialReason | null = null,
  ) {
    const contract = guardErrorContract[code];
    super(contract.message);
    this.name = "OmnigazeAiGuardError";
    this.status = contract.status;
  }
}

export interface EvidenceFingerprintItem {
  id: string;
  revisionAt: string;
  contentHash?: string | null;
}

export interface EvidenceFingerprintInput {
  /**
   * Optional request/feed timestamp for validation and diagnostics only. It is
   * deliberately excluded from the digest because feed generation time is
   * volatile even when every underlying evidence revision is unchanged.
   */
  dataCutoff?: string;
  evidence: readonly EvidenceFingerprintItem[];
}

export interface AiViewCacheLookup {
  symbolId: CanonicalSymbol;
  promptVersion: string;
  modelConfig: string;
  evidenceFingerprint: string;
}

export interface AiViewCacheRecord extends AiViewCacheLookup {
  payload: unknown;
  generatedAt: string;
  expiresAt: string;
}

export type AiBudgetDenialReason =
  | "daily_limit"
  | "rolling_limit"
  | "concurrency_limit";

export interface AiBudgetReservationInput {
  ownerId: string;
  operation: "omnigaze_view";
  operationKey: string;
  requestId: string;
  cost: number;
  requestedAt: string;
  leaseExpiresAt: string;
}

export type AiBudgetReservation =
  | {
      granted: true;
      reservationId: string;
      remaining: number;
      limit: number;
      resetAt: string;
    }
  | {
      granted: false;
      reason: AiBudgetDenialReason;
      remaining: number;
      limit: number;
      retryAt: string;
    };

export interface AiBudgetCompletion {
  reservationId: string;
  outcome: "succeeded" | "failed";
  completedAt: string;
}

export interface OmnigazeAiGuardRepository {
  findCachedView(lookup: AiViewCacheLookup): Promise<AiViewCacheRecord | null>;
  putCachedView(record: AiViewCacheRecord): Promise<void>;
  reserveBudget(input: AiBudgetReservationInput): Promise<AiBudgetReservation>;
  completeBudget(input: AiBudgetCompletion): Promise<void>;
}

/**
 * The cache projection is intentionally caller supplied. It must include only
 * the public, validated view envelope; prompts, messages, provider payloads,
 * and model inputs do not belong in this projection.
 */
export interface OmnigazeAiCacheCodec<T> {
  encode(value: T): unknown;
  decode(value: unknown): T;
}

export interface GuardedOmnigazeViewInput<T> {
  ownerId: string;
  symbolId: CanonicalSymbol;
  promptVersion: string;
  /** Stable effective model label, for example OPENAI_MODEL or a default. */
  modelConfig: string;
  requestId?: string;
  freshness: {
    state: "fresh";
    asOf: string;
    maximumAgeSeconds: number;
  };
  fingerprint: EvidenceFingerprintInput;
  generate(): Promise<T>;
}

export interface GuardedOmnigazeViewResult<T> {
  value: T;
  meta: {
    source: "cache" | "generated";
    deduplicated: boolean;
    modelConfig: string;
    evidenceFingerprint: string;
    cacheExpiresAt: string;
    budget:
      | {
          charged: false;
          remaining: null;
          limit: null;
          resetAt: null;
        }
      | {
          charged: true;
          remaining: number;
          limit: number;
          resetAt: string;
        };
  };
}

export interface OmnigazeAiGuardOptions {
  cacheTtlSeconds?: number;
  reservationLeaseSeconds?: number;
  maxCachePayloadBytes?: number;
  budgetCost?: number;
  now?: () => Date;
  createRequestId?: () => string;
}

type NormalizedGuardInput<T> = Omit<
  GuardedOmnigazeViewInput<T>,
  | "ownerId"
  | "promptVersion"
  | "modelConfig"
  | "requestId"
  | "freshness"
  | "fingerprint"
> & {
  ownerId: string;
  promptVersion: string;
  modelConfig: string;
  requestId: string;
  freshnessAsOf: string;
  freshnessExpiresAt: string;
  evidence: EvidenceFingerprintItem[];
};

function invalidRequest(): never {
  throw new OmnigazeAiGuardError("invalid_guard_request");
}

function finiteIntegerInRange(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    invalidRequest();
  }
  return candidate;
}

function normalizedIso(value: string) {
  if (typeof value !== "string" || !value.trim()) invalidRequest();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) invalidRequest();
  return new Date(milliseconds).toISOString();
}

function boundedText(value: string, maximum: number) {
  if (typeof value !== "string") invalidRequest();
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximum ||
    /[\u0000-\u001F\u007F]/.test(normalized)
  ) {
    invalidRequest();
  }
  return normalized;
}

function normalizeFingerprintInput(input: EvidenceFingerprintInput) {
  if (input.dataCutoff !== undefined) normalizedIso(input.dataCutoff);
  if (!Array.isArray(input.evidence) || input.evidence.length === 0 || input.evidence.length > 100) {
    invalidRequest();
  }

  const seenIds = new Set<string>();
  const evidence = input.evidence.map((item) => {
    const id = boundedText(item.id, 256);
    if (seenIds.has(id)) invalidRequest();
    seenIds.add(id);
    const revisionAt = normalizedIso(item.revisionAt);
    const contentHash = item.contentHash?.trim().toLowerCase() || null;
    if (contentHash && !sha256Pattern.test(contentHash)) invalidRequest();
    return { id, revisionAt, contentHash };
  });

  evidence.sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.revisionAt.localeCompare(right.revisionAt) ||
      (left.contentHash ?? "").localeCompare(right.contentHash ?? ""),
  );
  return { evidence };
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function computeOmnigazeEvidenceFingerprint(
  input: EvidenceFingerprintInput,
) {
  const normalized = normalizeFingerprintInput(input);
  const canonical = JSON.stringify({
    version: 1,
    evidence: normalized.evidence,
  });
  return sha256(canonical);
}

export function resolveOmnigazeModelConfig(configuredModel?: string) {
  const modelConfig = configuredModel?.trim() || OMNIGAZE_DEFAULT_MODEL_CONFIG;
  if (
    modelConfig.length > 128 ||
    !safeModelPattern.test(modelConfig) ||
    /[\u0000-\u001F\u007F]/.test(modelConfig)
  ) {
    invalidRequest();
  }
  return modelConfig;
}

function forbiddenCacheKey(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(forbiddenCacheKey);

  const forbidden = new Set([
    "prompt",
    "systemprompt",
    "userprompt",
    "messages",
    "modelinput",
    "input",
    "rawinput",
    "instructions",
    "conversation",
    "providerpayload",
    "rawproviderpayload",
    "rawpayload",
  ]);
  return Object.entries(value).some(
    ([key, child]) =>
      forbidden.has(key.replace(/[_\s-]/g, "").toLowerCase()) ||
      forbiddenCacheKey(child),
  );
}

function safeCachePayload(value: unknown, maximumBytes: number) {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new OmnigazeAiGuardError("ai_guard_unavailable");
  }
  if (!serialized || textEncoder.encode(serialized).byteLength > maximumBytes) {
    throw new OmnigazeAiGuardError("ai_guard_unavailable");
  }

  try {
    const parsed = JSON.parse(serialized) as unknown;
    if (forbiddenCacheKey(parsed)) {
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }
    return parsed;
  } catch {
    throw new OmnigazeAiGuardError("ai_guard_unavailable");
  }
}

function cacheRecordMatches(
  record: AiViewCacheRecord,
  lookup: AiViewCacheLookup,
) {
  return (
    record.symbolId === lookup.symbolId &&
    record.promptVersion === lookup.promptVersion &&
    record.modelConfig === lookup.modelConfig &&
    record.evidenceFingerprint === lookup.evidenceFingerprint
  );
}

function validCacheRecordShape(value: AiViewCacheRecord) {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    typeof value.symbolId === "string" &&
    canonicalSymbolPattern.test(value.symbolId) &&
    typeof value.promptVersion === "string" &&
    safeVersionPattern.test(value.promptVersion) &&
    typeof value.modelConfig === "string" &&
    safeModelPattern.test(value.modelConfig) &&
    typeof value.evidenceFingerprint === "string" &&
    sha256Pattern.test(value.evidenceFingerprint) &&
    Number.isFinite(Date.parse(value.generatedAt)) &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    Object.prototype.hasOwnProperty.call(value, "payload")
  );
}

function validBudgetReservation(value: AiBudgetReservation) {
  if (!value || typeof value !== "object") return false;
  if (
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
      value.reservationId.length > 0 &&
      value.reservationId.length <= 256 &&
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

export class OmnigazeAiGuard<T> {
  private readonly inFlight = new Map<
    string,
    Promise<GuardedOmnigazeViewResult<T>>
  >();
  private readonly cacheTtlSeconds: number;
  private readonly reservationLeaseSeconds: number;
  private readonly maxCachePayloadBytes: number;
  private readonly budgetCost: number;
  private readonly now: () => Date;
  private readonly createRequestId: () => string;

  constructor(
    private readonly repository: OmnigazeAiGuardRepository,
    private readonly codec: OmnigazeAiCacheCodec<T>,
    options: OmnigazeAiGuardOptions = {},
  ) {
    this.cacheTtlSeconds = finiteIntegerInRange(
      options.cacheTtlSeconds,
      DEFAULT_CACHE_TTL_SECONDS,
      30,
      1_800,
    );
    this.reservationLeaseSeconds = finiteIntegerInRange(
      options.reservationLeaseSeconds,
      DEFAULT_RESERVATION_LEASE_SECONDS,
      15,
      300,
    );
    this.maxCachePayloadBytes = finiteIntegerInRange(
      options.maxCachePayloadBytes,
      DEFAULT_MAX_CACHE_PAYLOAD_BYTES,
      1_024,
      64 * 1_024,
    );
    this.budgetCost = finiteIntegerInRange(options.budgetCost, 1, 1, 10);
    this.now = options.now ?? (() => new Date());
    this.createRequestId = options.createRequestId ?? (() => crypto.randomUUID());
  }

  private normalizeInput(input: GuardedOmnigazeViewInput<T>): NormalizedGuardInput<T> {
    const ownerId = boundedText(input.ownerId, 256);
    const symbolId = input.symbolId?.trim().toUpperCase() as CanonicalSymbol;
    if (!canonicalSymbolPattern.test(symbolId)) invalidRequest();
    const promptVersion = boundedText(input.promptVersion, 128);
    if (!safeVersionPattern.test(promptVersion)) invalidRequest();
    const modelConfig = boundedText(input.modelConfig, 128);
    if (!safeModelPattern.test(modelConfig)) invalidRequest();
    if (typeof input.generate !== "function") invalidRequest();
    if (input.freshness?.state !== "fresh") {
      throw new OmnigazeAiGuardError("fresh_evidence_required");
    }
    const freshnessAsOf = normalizedIso(input.freshness.asOf);
    const maximumAgeSeconds = finiteIntegerInRange(
      input.freshness.maximumAgeSeconds,
      0,
      1,
      24 * 60 * 60,
    );
    const now = this.now();
    const nowMs = now.getTime();
    if (!Number.isFinite(nowMs)) invalidRequest();
    const freshnessMs = Date.parse(freshnessAsOf);
    const freshnessExpiresMs = freshnessMs + maximumAgeSeconds * 1_000;
    if (
      freshnessMs > nowMs + MAX_CLOCK_SKEW_MS ||
      freshnessExpiresMs <= nowMs
    ) {
      throw new OmnigazeAiGuardError("fresh_evidence_required");
    }
    const normalizedFingerprint = normalizeFingerprintInput(input.fingerprint);
    const requestId = boundedText(
      input.requestId ?? this.createRequestId(),
      128,
    );
    if (!safeRequestIdPattern.test(requestId)) invalidRequest();

    return {
      ownerId,
      symbolId,
      promptVersion,
      modelConfig,
      requestId,
      freshnessAsOf,
      freshnessExpiresAt: new Date(freshnessExpiresMs).toISOString(),
      evidence: normalizedFingerprint.evidence,
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

  private decodeCached(
    record: AiViewCacheRecord,
    nowMs: number,
    freshnessExpiresAt: string,
  ) {
    const generatedAt = Date.parse(record.generatedAt);
    const expiresAt = Date.parse(record.expiresAt);
    if (
      !Number.isFinite(generatedAt) ||
      !Number.isFinite(expiresAt) ||
      generatedAt > nowMs + MAX_CLOCK_SKEW_MS
    ) {
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }
    const effectiveExpiresAt = Math.min(
      expiresAt,
      Date.parse(freshnessExpiresAt),
    );
    if (effectiveExpiresAt <= nowMs) return null;
    try {
      if (forbiddenCacheKey(record.payload)) {
        throw new Error("forbidden cache projection");
      }
      return { value: this.codec.decode(record.payload), expiresAt: effectiveExpiresAt };
    } catch {
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }
  }

  private async completeReservation(input: AiBudgetCompletion) {
    await this.repositoryCall(() => this.repository.completeBudget(input));
  }

  private async generateAndCache(
    input: NormalizedGuardInput<T>,
    lookup: AiViewCacheLookup,
    operationKey: string,
    evidenceFingerprint: string,
  ): Promise<GuardedOmnigazeViewResult<T>> {
    const requestedAt = this.now();
    const reservation = await this.repositoryCall(() =>
      this.repository.reserveBudget({
        ownerId: input.ownerId,
        operation: "omnigaze_view",
        operationKey,
        requestId: input.requestId,
        cost: this.budgetCost,
        requestedAt: requestedAt.toISOString(),
        leaseExpiresAt: new Date(
          requestedAt.getTime() + this.reservationLeaseSeconds * 1_000,
        ).toISOString(),
      }),
    );
    if (!validBudgetReservation(reservation)) {
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }
    if (!reservation.granted) {
      const retryAtMs = Date.parse(reservation.retryAt);
      if (retryAtMs <= requestedAt.getTime()) {
        throw new OmnigazeAiGuardError("ai_guard_unavailable");
      }
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((retryAtMs - requestedAt.getTime()) / 1_000),
      );
      throw new OmnigazeAiGuardError(
        "ai_rate_limited",
        new Date(retryAtMs).toISOString(),
        retryAfterSeconds,
        reservation.reason,
      );
    }
    if (Date.parse(reservation.resetAt) <= requestedAt.getTime()) {
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }

    let value: T;
    try {
      value = await input.generate();
    } catch (error) {
      await this.completeReservation({
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
    let payload: unknown;
    let cacheFailure: OmnigazeAiGuardError | null =
      expiresAtMs <= generatedAt.getTime()
        ? new OmnigazeAiGuardError("fresh_evidence_required")
        : null;
    if (!cacheFailure) {
      try {
        payload = safeCachePayload(
          this.codec.encode(value),
          this.maxCachePayloadBytes,
        );
        this.codec.decode(payload);
        await this.repositoryCall(() =>
          this.repository.putCachedView({
            ...lookup,
            payload,
            generatedAt: generatedAt.toISOString(),
            expiresAt: new Date(expiresAtMs).toISOString(),
          }),
        );
      } catch {
        cacheFailure = new OmnigazeAiGuardError("ai_guard_unavailable");
      }
    }

    await this.completeReservation({
      reservationId: reservation.reservationId,
      outcome: "succeeded",
      completedAt: this.now().toISOString(),
    });
    if (cacheFailure) throw cacheFailure;

    return {
      value,
      meta: {
        source: "generated",
        deduplicated: false,
        modelConfig: input.modelConfig,
        evidenceFingerprint,
        cacheExpiresAt: new Date(expiresAtMs).toISOString(),
        budget: {
          charged: true,
          remaining: reservation.remaining,
          limit: reservation.limit,
          resetAt: new Date(Date.parse(reservation.resetAt)).toISOString(),
        },
      },
    };
  }

  async execute(
    request: GuardedOmnigazeViewInput<T>,
  ): Promise<GuardedOmnigazeViewResult<T>> {
    const input = this.normalizeInput(request);
    const evidenceFingerprint = await computeOmnigazeEvidenceFingerprint({
      evidence: input.evidence,
    });
    const lookup: AiViewCacheLookup = {
      symbolId: input.symbolId,
      promptVersion: input.promptVersion,
      modelConfig: input.modelConfig,
      evidenceFingerprint,
    };
    const operationKey = [
      input.symbolId,
      input.promptVersion,
      input.modelConfig,
      evidenceFingerprint,
    ].join("|");
    const nowMs = this.now().getTime();
    const record = await this.repositoryCall(() =>
      this.repository.findCachedView(lookup),
    );
    if (record && !validCacheRecordShape(record)) {
      throw new OmnigazeAiGuardError("ai_guard_unavailable");
    }
    if (record && cacheRecordMatches(record, lookup)) {
      const decoded = this.decodeCached(
        record,
        nowMs,
        input.freshnessExpiresAt,
      );
      if (decoded) {
        return {
          value: decoded.value,
          meta: {
            source: "cache",
            deduplicated: false,
            modelConfig: input.modelConfig,
            evidenceFingerprint,
            cacheExpiresAt: new Date(decoded.expiresAt).toISOString(),
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

    const existing = this.inFlight.get(operationKey);
    if (existing) {
      const result = await existing;
      const cacheExpiresAtMs = Math.min(
        Date.parse(result.meta.cacheExpiresAt),
        Date.parse(input.freshnessExpiresAt),
      );
      if (cacheExpiresAtMs <= this.now().getTime()) {
        throw new OmnigazeAiGuardError("fresh_evidence_required");
      }
      return {
        ...result,
        meta: {
          ...result.meta,
          deduplicated: true,
          cacheExpiresAt: new Date(cacheExpiresAtMs).toISOString(),
          budget: {
            charged: false,
            remaining: null,
            limit: null,
            resetAt: null,
          },
        },
      };
    }

    const generation = this.generateAndCache(
      input,
      lookup,
      operationKey,
      evidenceFingerprint,
    );
    this.inFlight.set(operationKey, generation);
    try {
      return await generation;
    } finally {
      if (this.inFlight.get(operationKey) === generation) {
        this.inFlight.delete(operationKey);
      }
    }
  }
}

export function omnigazeAiGuardResultHeaders<T>(
  result: GuardedOmnigazeViewResult<T>,
): Record<string, string> {
  const headers: Record<string, string> = {
    "X-Omnigaze-AI-Cache": result.meta.source === "cache" ? "hit" : "miss",
    "X-Omnigaze-AI-Deduplicated": String(result.meta.deduplicated),
    "X-Omnigaze-AI-Budget-Charged": String(result.meta.budget.charged),
  };
  if (result.meta.budget.charged) {
    headers["X-Omnigaze-AI-Budget-Remaining"] = String(
      result.meta.budget.remaining,
    );
    headers["X-Omnigaze-AI-Budget-Limit"] = String(result.meta.budget.limit);
    headers["X-Omnigaze-AI-Budget-Reset"] = result.meta.budget.resetAt;
  }
  return headers;
}

export function omnigazeAiGuardErrorHeaders(
  error: unknown,
): Record<string, string> {
  if (
    !(error instanceof OmnigazeAiGuardError) ||
    error.code !== "ai_rate_limited" ||
    !error.retryAt ||
    !error.retryAfterSeconds
  ) {
    return {};
  }
  return {
    "Retry-After": String(error.retryAfterSeconds),
    "X-Omnigaze-AI-Budget-Retry-At": error.retryAt,
    ...(error.budgetReason
      ? { "X-Omnigaze-AI-Budget-Reason": error.budgetReason }
      : {}),
  };
}
