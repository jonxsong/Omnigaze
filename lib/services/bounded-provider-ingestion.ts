import type {
  ClaimNextDueInput,
  CompleteRunInput,
  EnsureCheckpointInput,
  FailRunInput,
  IngestionAggregateStatus,
  IngestionLeaseIdentity,
  PersistPageInput,
  PersistPageResult,
  ProviderCheckpoint,
  ProviderCheckpointClaim,
  RawSourceEventReceipt,
  SafeIngestionError,
} from "@/lib/ingestion/contracts";
import type { CanonicalSymbol } from "@/lib/market-types";
import type { RawSourceEvent, SourceKind } from "@/lib/pipeline/contracts";
import {
  ProviderConfigurationError,
  ProviderCursorMismatchError,
  ProviderCursorRejectedError,
  type PaginatedIntelligenceSourceProvider,
} from "@/lib/providers/contracts";

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_TICK_DEADLINE_MS = 12_000;
const MAX_PARTITIONS = 100;
const MAX_SYMBOLS_PER_PARTITION = 100;
const MAX_PAGE_SIZE = 100;
const MAX_RETRY_SECONDS = 30 * 60;
const MAX_CURSOR_BYTES = 2_048;
const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/u;

export interface IngestionRepositoryPort {
  ensureCheckpoint(input: EnsureCheckpointInput): Promise<ProviderCheckpoint>;
  claimNextDue(
    input: ClaimNextDueInput,
  ): Promise<ProviderCheckpointClaim | null>;
  startRun(lease: IngestionLeaseIdentity, startedAt: string): Promise<string>;
  persistPage(input: PersistPageInput): Promise<PersistPageResult>;
  completeRun(input: CompleteRunInput): Promise<unknown>;
  failRun(input: FailRunInput): Promise<unknown>;
  getAggregateStatus(input: {
    now: string;
    since: string;
    provider?: string;
    partitionKey?: string;
  }): Promise<IngestionAggregateStatus>;
}

export interface BoundedIngestionPartition {
  partitionKey: string;
  symbols: CanonicalSymbol[];
}

export interface BoundedProviderIngestionConfig {
  provider: string;
  partitions: BoundedIngestionPartition[];
  sourceKinds: SourceKind[];
  pageSize: number;
  cadenceSeconds: number;
  settlingDelayMs: number;
  lookbackMs: number;
  leaseDurationMs?: number;
  tickDeadlineMs?: number;
}

export interface BoundedIngestionQueryInput {
  provider: string;
  partition: BoundedIngestionPartition;
  windowStart: string;
  windowEnd: string;
  pageSize: number;
}

export interface BoundedIngestionEventContext {
  partition: BoundedIngestionPartition;
  claim: ProviderCheckpointClaim;
}

export interface BoundedProviderIngestionAdapter {
  createQueryFingerprint(input: BoundedIngestionQueryInput): Promise<string>;
  createReceipt(
    event: RawSourceEvent,
    context: BoundedIngestionEventContext,
  ): Promise<RawSourceEventReceipt>;
  validateEvent?(
    event: RawSourceEvent,
    context: BoundedIngestionEventContext,
  ): void;
}

export interface BoundedProviderIngestionDependencies {
  repository: IngestionRepositoryPort;
  provider: PaginatedIntelligenceSourceProvider;
  config: BoundedProviderIngestionConfig;
  adapter: BoundedProviderIngestionAdapter;
  now?: () => Date;
}

export type IngestionTickResult =
  | {
      outcome: "idle";
      provider: string;
      checkedAt: string;
    }
  | {
      outcome: "processed";
      provider: string;
      runId: string;
      completedAt: string;
      hasMore: boolean;
      receiptCount: number;
      insertedReceiptCount: number;
      linkedSymbolCount: number;
    };

export type IngestionFailureStage =
  | "claim"
  | "run_start"
  | "provider_fetch"
  | "page_validation"
  | "persistence"
  | "completion";

export class IngestionTickError extends Error {
  constructor(
    readonly code: string,
    readonly stage: IngestionFailureStage,
    readonly retryable: boolean,
  ) {
    super("The bounded ingestion tick failed.");
    this.name = "IngestionTickError";
  }
}

function invalidConfig(): never {
  throw new Error("invalid_bounded_ingestion_config");
}

function boundedToken(value: string, maximum: number) {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    invalidConfig();
  }
  return normalized;
}

function boundedInteger(
  value: number,
  minimum: number,
  maximum: number,
) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    invalidConfig();
  }
  return value;
}

function normalizedConfig(
  config: BoundedProviderIngestionConfig,
): Required<BoundedProviderIngestionConfig> {
  const provider = boundedToken(config.provider, 64).toLowerCase();
  if (
    !Array.isArray(config.partitions) ||
    config.partitions.length === 0 ||
    config.partitions.length > MAX_PARTITIONS ||
    !Array.isArray(config.sourceKinds) ||
    config.sourceKinds.length === 0
  ) {
    invalidConfig();
  }
  const partitionKeys = new Set<string>();
  const partitions = config.partitions.map((partition) => {
    const partitionKey = boundedToken(partition.partitionKey, 256);
    if (
      partitionKeys.has(partitionKey) ||
      !Array.isArray(partition.symbols) ||
      partition.symbols.length === 0 ||
      partition.symbols.length > MAX_SYMBOLS_PER_PARTITION
    ) {
      invalidConfig();
    }
    partitionKeys.add(partitionKey);
    const symbols = [...new Set(partition.symbols)];
    if (
      symbols.length !== partition.symbols.length ||
      symbols.some(
        (symbol) =>
          typeof symbol !== "string" ||
          !canonicalSymbolPattern.test(symbol),
      )
    ) {
      invalidConfig();
    }
    return { partitionKey, symbols: [...symbols].sort() };
  });
  const sourceKinds = [...new Set(config.sourceKinds)];
  if (sourceKinds.length !== config.sourceKinds.length) invalidConfig();
  return {
    provider,
    partitions: partitions.sort((left, right) =>
      left.partitionKey.localeCompare(right.partitionKey),
    ),
    sourceKinds,
    pageSize: boundedInteger(config.pageSize, 1, MAX_PAGE_SIZE),
    cadenceSeconds: boundedInteger(config.cadenceSeconds, 1, 86_400),
    settlingDelayMs: boundedInteger(
      config.settlingDelayMs,
      0,
      24 * 60 * 60 * 1_000,
    ),
    lookbackMs: boundedInteger(
      config.lookbackMs,
      1,
      366 * 24 * 60 * 60 * 1_000,
    ),
    leaseDurationMs: boundedInteger(
      config.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      1_000,
      5 * 60 * 1_000,
    ),
    tickDeadlineMs: boundedInteger(
      config.tickDeadlineMs ?? DEFAULT_TICK_DEADLINE_MS,
      1_000,
      60_000,
    ),
  };
}

function addMilliseconds(iso: string, milliseconds: number) {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function safeFailure(
  failure: unknown,
  stage: IngestionFailureStage,
): SafeIngestionError & { stage: IngestionFailureStage } {
  if (failure instanceof IngestionTickError) {
    return {
      code: failure.code,
      stage: failure.stage,
      message: failure.message,
      retryable: failure.retryable,
    };
  }
  if (failure instanceof ProviderConfigurationError) {
    return {
      code: "provider_unconfigured",
      stage,
      message: "The ingestion provider is not configured.",
      retryable: false,
    };
  }
  if (failure instanceof ProviderCursorMismatchError) {
    return {
      code: "cursor_query_mismatch",
      stage,
      message: "The stored provider cursor does not match its frozen query.",
      retryable: false,
    };
  }
  if (failure instanceof ProviderCursorRejectedError) {
    return {
      code: "invalid_page_token",
      stage,
      message: "The provider rejected the stored page cursor.",
      retryable: false,
    };
  }
  if (
    failure instanceof DOMException &&
    (failure.name === "AbortError" || failure.name === "TimeoutError")
  ) {
    return {
      code: "provider_timeout",
      stage,
      message: "The provider request exceeded its bounded deadline.",
      retryable: true,
    };
  }
  return {
    code:
      stage === "persistence" || stage === "completion"
        ? "ingestion_persistence_failed"
        : "provider_request_failed",
    stage,
    message: "The ingestion tick failed without exposing upstream details.",
    retryable: true,
  };
}

function retryDelaySeconds(claim: ProviderCheckpointClaim, retryable: boolean) {
  if (!retryable) return 15 * 60;
  return Math.min(
    60 * 2 ** Math.min(claim.consecutiveFailures, 5),
    MAX_RETRY_SECONDS,
  );
}

function invalidPage(code = "provider_page_contract_invalid"): never {
  throw new IngestionTickError(code, "page_validation", false);
}

function validatePageEvents(
  events: RawSourceEvent[],
  claim: ProviderCheckpointClaim,
  partition: BoundedIngestionPartition,
  config: Required<BoundedProviderIngestionConfig>,
  adapter: BoundedProviderIngestionAdapter,
) {
  if (!Array.isArray(events) || events.length > config.pageSize) invalidPage();
  const seenIds = new Set<string>();
  const allowedKinds = new Set(config.sourceKinds);
  const windowStart = Date.parse(claim.window.start);
  const windowEnd = Date.parse(claim.window.end);
  if (
    !Number.isFinite(windowStart) ||
    !Number.isFinite(windowEnd) ||
    windowStart >= windowEnd
  ) {
    invalidPage();
  }
  for (const event of events) {
    if (!event || typeof event !== "object") invalidPage();
    const effectiveObservationAt = Date.parse(
      event.providerUpdatedAt ?? event.publishedAt,
    );
    if (
      event.source !== claim.provider ||
      !allowedKinds.has(event.sourceKind) ||
      typeof event.sourceEventId !== "string" ||
      event.sourceEventId.trim().length === 0 ||
      seenIds.has(event.sourceEventId) ||
      !Number.isFinite(effectiveObservationAt) ||
      effectiveObservationAt < windowStart ||
      effectiveObservationAt > windowEnd
    ) {
      invalidPage();
    }
    seenIds.add(event.sourceEventId);
    adapter.validateEvent?.(event, { partition, claim });
  }
}

function validateCursorPage(
  page: Awaited<
    ReturnType<PaginatedIntelligenceSourceProvider["getEventPage"]>
  >,
  claim: ProviderCheckpointClaim,
) {
  if (!page || typeof page !== "object" || !Array.isArray(page.events)) {
    invalidPage();
  }
  const nextCursor = page.nextCursor ?? null;
  const validCursor =
    nextCursor === null ||
    (typeof nextCursor === "object" &&
      typeof nextCursor.token === "string" &&
      nextCursor.token.length > 0 &&
      new TextEncoder().encode(nextCursor.token).length <= MAX_CURSOR_BYTES &&
      nextCursor.queryFingerprint === claim.window.fingerprint);
  if (
    typeof page.queryFingerprint !== "string" ||
    page.queryFingerprint !== claim.window.fingerprint ||
    typeof page.exhausted !== "boolean" ||
    page.exhausted === Boolean(nextCursor) ||
    !validCursor ||
    (claim.resumeCursor !== null && nextCursor?.token === claim.resumeCursor)
  ) {
    invalidPage(
      claim.resumeCursor !== null && nextCursor?.token === claim.resumeCursor
        ? "invalid_cursor"
        : "provider_page_contract_invalid",
    );
  }
  return nextCursor;
}

export function createBoundedProviderIngestionService(
  dependencies: BoundedProviderIngestionDependencies,
) {
  const config = normalizedConfig(dependencies.config);
  if (dependencies.provider.name !== config.provider) invalidConfig();
  const clock = dependencies.now ?? (() => new Date());

  return {
    async runTick(): Promise<IngestionTickResult> {
      const startedAt = clock().toISOString();
      const windowEnd = addMilliseconds(startedAt, -config.settlingDelayMs);
      const windowStart = addMilliseconds(windowEnd, -config.lookbackMs);
      const leaseExpiresAt = addMilliseconds(
        startedAt,
        config.leaseDurationMs,
      );
      let claim: ProviderCheckpointClaim | null = null;
      let partition: BoundedIngestionPartition | null = null;
      let runId: string | null = null;
      let stage: IngestionFailureStage = "claim";

      try {
        const initialized = [] as Array<{
          partition: BoundedIngestionPartition;
          checkpoint: ProviderCheckpoint;
        }>;
        for (const candidate of config.partitions) {
          const checkpoint = await dependencies.repository.ensureCheckpoint({
            provider: config.provider,
            partitionKey: candidate.partitionKey,
            nextDueAt: startedAt,
            now: startedAt,
          });
          if (
            checkpoint.provider !== config.provider ||
            checkpoint.partitionKey !== candidate.partitionKey ||
            !Number.isFinite(Date.parse(checkpoint.nextDueAt))
          ) {
            throw new IngestionTickError(
              "invalid_checkpoint",
              "claim",
              false,
            );
          }
          initialized.push({ partition: candidate, checkpoint });
        }
        initialized.sort(
          (left, right) =>
            Number(right.checkpoint.resumeCursor !== null) -
              Number(left.checkpoint.resumeCursor !== null) ||
            Date.parse(left.checkpoint.nextDueAt) -
              Date.parse(right.checkpoint.nextDueAt) ||
            left.partition.partitionKey.localeCompare(
              right.partition.partitionKey,
            ),
        );
        for (const { partition: candidate } of initialized) {
          const fingerprint = boundedToken(
            await dependencies.adapter.createQueryFingerprint({
              provider: config.provider,
              partition: candidate,
              windowStart,
              windowEnd,
              pageSize: config.pageSize,
            }),
            128,
          );
          const claimInput: ClaimNextDueInput = {
            provider: config.provider,
            partitionKey: candidate.partitionKey,
            claimedAt: startedAt,
            leaseExpiresAt,
            proposedWindow: {
              start: windowStart,
              end: windowEnd,
              fingerprint,
            },
          };
          const candidateClaim =
            await dependencies.repository.claimNextDue(claimInput);
          if (!candidateClaim) continue;
          if (
            candidateClaim.provider !== config.provider ||
            candidateClaim.partitionKey !== candidate.partitionKey ||
            candidateClaim.lease.provider !== config.provider ||
            candidateClaim.lease.partitionKey !== candidate.partitionKey
          ) {
            throw new IngestionTickError(
              "invalid_checkpoint_claim",
              "claim",
              false,
            );
          }
          claim = candidateClaim;
          partition = candidate;
          break;
        }
        if (!claim || !partition) {
          return {
            outcome: "idle",
            provider: config.provider,
            checkedAt: startedAt,
          };
        }
        const activeClaim = claim;
        const activePartition = partition;

        stage = "run_start";
        runId = await dependencies.repository.startRun(
          activeClaim.lease,
          startedAt,
        );
        stage = "provider_fetch";
        const page = await dependencies.provider.getEventPage({
          symbols: activePartition.symbols,
          windowStart: activeClaim.window.start,
          windowEnd: activeClaim.window.end,
          pageSize: config.pageSize,
          cursor: activeClaim.resumeCursor
            ? {
                token: activeClaim.resumeCursor,
                queryFingerprint: activeClaim.window.fingerprint,
              }
            : null,
          signal: AbortSignal.timeout(config.tickDeadlineMs),
        });

        stage = "page_validation";
        const nextCursor = validateCursorPage(page, activeClaim);
        validatePageEvents(
          page.events,
          activeClaim,
          activePartition,
          config,
          dependencies.adapter,
        );
        const receipts = await Promise.all(
          page.events.map((event) =>
            dependencies.adapter.createReceipt(event, {
              partition: activePartition,
              claim: activeClaim,
            }),
          ),
        );
        stage = "persistence";
        const persisted = await dependencies.repository.persistPage({
          lease: activeClaim.lease,
          runId,
          receipts,
          nextCursor: nextCursor?.token ?? null,
          persistedAt: clock().toISOString(),
        });

        stage = "completion";
        const completedAt = clock().toISOString();
        await dependencies.repository.completeRun({
          lease: activeClaim.lease,
          runId,
          completedAt,
          nextDueAt: page.exhausted
            ? addMilliseconds(completedAt, config.cadenceSeconds * 1_000)
            : completedAt,
          hasMore: !page.exhausted,
          ...(page.exhausted
            ? { highWaterMark: activeClaim.window.end }
            : {}),
        });
        return {
          outcome: "processed",
          provider: config.provider,
          runId,
          completedAt,
          hasMore: !page.exhausted,
          receiptCount: persisted.receiptCount,
          insertedReceiptCount: persisted.insertedReceiptCount,
          linkedSymbolCount: persisted.linkedSymbolCount,
        };
      } catch (failure) {
        const safe = safeFailure(failure, stage);
        if (claim && runId) {
          const failedAt = clock().toISOString();
          try {
            await dependencies.repository.failRun({
              lease: claim.lease,
              runId,
              failedAt,
              nextDueAt: addMilliseconds(
                failedAt,
                retryDelaySeconds(claim, safe.retryable) * 1_000,
              ),
              error: safe,
            });
          } catch {
            // A stale lease must not overwrite the newer owner's outcome.
          }
        }
        throw new IngestionTickError(safe.code, safe.stage, safe.retryable);
      }
    },
  };
}
