import { defaultWatchlist } from "@/lib/demo-market-data";
import type {
  ClaimNextDueInput,
  CompleteRunInput,
  EnsureCheckpointInput,
  FailRunInput,
  IngestionAggregateStatus,
  IngestionLeaseIdentity,
  PersistPageInput,
  PersistPageResult,
  ProviderCheckpointClaim,
  RawSourceEventReceipt,
  SafeIngestionError,
} from "@/lib/ingestion/contracts";
import type { CanonicalSymbol } from "@/lib/market-types";
import type { RawSourceEvent } from "@/lib/pipeline/contracts";
import {
  AlpacaProvider,
  createAlpacaNewsQueryFingerprint,
} from "@/lib/providers/alpaca";
import {
  ProviderConfigurationError,
  ProviderCursorMismatchError,
  ProviderCursorRejectedError,
  type PaginatedIntelligenceSourceProvider,
} from "@/lib/providers/contracts";

const INGESTION_PROVIDER = "alpaca";
const PAGE_SIZE = 50;
const LEASE_DURATION_MS = 30_000;
const TICK_DEADLINE_MS = 12_000;
const PROVIDER_SETTLING_DELAY_MS = 30_000;
const CORRECTION_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CADENCE_SECONDS = 300;
const MAX_CONFIGURED_SYMBOLS = 50;
const MAX_RETRY_SECONDS = 30 * 60;

export type IngestionCollectionMode =
  | "scheduled"
  | "request_time"
  | "unavailable";

export type IngestionRuntimeConfig = {
  provider: typeof INGESTION_PROVIDER;
  partitionKey: string;
  symbols: CanonicalSymbol[];
  pageSize: number;
  cadenceSeconds: number;
  publiclyReportedCadenceSeconds: number | null;
  collectionMode: Exclude<IngestionCollectionMode, "unavailable">;
};

export interface IngestionRepositoryPort {
  ensureCheckpoint(input: EnsureCheckpointInput): Promise<unknown>;
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

type IngestionDependencies = {
  repository: IngestionRepositoryPort;
  provider: PaginatedIntelligenceSourceProvider;
  config: IngestionRuntimeConfig;
  now?: () => Date;
};

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

type FailureStage =
  | "claim"
  | "run_start"
  | "provider_fetch"
  | "page_validation"
  | "persistence"
  | "completion";

export class IngestionTickError extends Error {
  constructor(
    readonly code: string,
    readonly stage: FailureStage,
    readonly retryable: boolean,
  ) {
    super("The bounded ingestion tick failed.");
    this.name = "IngestionTickError";
  }
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum
    ? parsed
    : fallback;
}

function parseConfiguredSymbols(value: string | undefined) {
  const candidates = value
    ? value.split(",").map((symbol) => symbol.trim().toUpperCase())
    : defaultWatchlist;
  const symbols = [...new Set(candidates)].filter(
    (symbol): symbol is CanonicalSymbol =>
      /^[A-Z0-9._-]+:[A-Z0-9._-]+$/.test(symbol),
  );
  if (
    symbols.length === 0 ||
    symbols.length > MAX_CONFIGURED_SYMBOLS ||
    symbols.length !== new Set(candidates).size
  ) {
    throw new Error("invalid_alpaca_ingestion_symbols");
  }
  const tickers = symbols.map((symbol) => symbol.split(":")[1]);
  if (new Set(tickers).size !== tickers.length) {
    throw new Error("ambiguous_alpaca_ingestion_symbols");
  }
  return symbols.sort();
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

export async function readIngestionRuntimeConfig(
  environment: Record<string, string | undefined> = process.env,
): Promise<IngestionRuntimeConfig> {
  const symbols = parseConfiguredSymbols(environment.ALPACA_INGESTION_SYMBOLS);
  const configFingerprint = await sha256(
    JSON.stringify({ provider: INGESTION_PROVIDER, version: 1, symbols }),
  );
  const cadenceSeconds = parsePositiveInteger(
    environment.INGESTION_EXPECTED_CADENCE_SECONDS,
    DEFAULT_CADENCE_SECONDS,
    60,
    86_400,
  );
  const scheduleDeclared =
    environment.INGESTION_COLLECTION_MODE === "scheduled";
  return {
    provider: INGESTION_PROVIDER,
    partitionKey: `news:v1:${configFingerprint}`,
    symbols,
    pageSize: PAGE_SIZE,
    cadenceSeconds,
    publiclyReportedCadenceSeconds: scheduleDeclared ? cadenceSeconds : null,
    collectionMode: scheduleDeclared ? "scheduled" : "request_time",
  };
}

function addMilliseconds(iso: string, milliseconds: number) {
  return new Date(Date.parse(iso) + milliseconds).toISOString();
}

function eventSymbols(
  event: RawSourceEvent,
  configuredSymbols: CanonicalSymbol[],
) {
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  const rawSymbols = Array.isArray(payload.symbols) ? payload.symbols : [];
  const byTicker = new Map(
    configuredSymbols.map((symbol) => [symbol.split(":")[1], symbol]),
  );
  return [
    ...new Set(
      rawSymbols.flatMap((symbol) => {
        if (typeof symbol !== "string") return [];
        const canonical = byTicker.get(symbol.toUpperCase());
        return canonical ? [canonical] : [];
      }),
    ),
  ];
}

async function receiptForEvent(
  event: RawSourceEvent,
  configuredSymbols: CanonicalSymbol[],
): Promise<RawSourceEventReceipt> {
  const fullPayload = JSON.stringify(event.payload);
  const symbolIds = eventSymbols(event, configuredSymbols);
  const payload =
    event.payload && typeof event.payload === "object"
      ? (event.payload as Record<string, unknown>)
      : {};
  const headline =
    typeof payload.headline === "string" ? payload.headline.trim() : "";
  if (!fullPayload || symbolIds.length === 0 || headline.length === 0) {
    throw new IngestionTickError(
      "provider_payload_invalid",
      "page_validation",
      false,
    );
  }
  const publishedAt = new Date(event.publishedAt).toISOString();
  const providerRevisionAt = event.providerUpdatedAt
    ? new Date(event.providerUpdatedAt).toISOString()
    : publishedAt;
  const rawPayload = JSON.stringify({
    schema: "omnigaze.provider-receipt.v1",
    sourceKind: event.sourceKind,
    sourceEventId: event.sourceEventId,
    publishedAt,
    providerRevisionAt,
    symbolIds: [...symbolIds].sort(),
    headline: headline.slice(0, 512),
    summary:
      typeof payload.summary === "string"
        ? payload.summary.trim().slice(0, 4_000)
        : null,
    url:
      typeof payload.url === "string"
        ? payload.url.trim().slice(0, 2_048)
        : null,
    contentDigest: await sha256(fullPayload),
  });
  return {
    sourceKind: event.sourceKind,
    sourceEventId: event.sourceEventId,
    publishedAt,
    observedAt: new Date(event.receivedAt).toISOString(),
    payloadPolicy: "minimal_redacted_v1",
    rawPayloadHash: await sha256(rawPayload),
    rawPayload,
    status: "observed",
    symbolIds,
    providerRevisionAt,
  };
}

function safeFailure(
  failure: unknown,
  stage: FailureStage,
): SafeIngestionError & { stage: FailureStage } {
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

function validatePageEvents(
  events: RawSourceEvent[],
  claim: ProviderCheckpointClaim,
  pageSize: number,
) {
  if (events.length > pageSize) {
    throw new IngestionTickError(
      "provider_page_contract_invalid",
      "page_validation",
      false,
    );
  }
  const seenIds = new Set<string>();
  const windowStart = Date.parse(claim.window.start);
  const windowEnd = Date.parse(claim.window.end);
  if (
    !Number.isFinite(windowStart) ||
    !Number.isFinite(windowEnd) ||
    windowStart >= windowEnd
  ) {
    throw new IngestionTickError(
      "provider_page_contract_invalid",
      "page_validation",
      false,
    );
  }
  for (const event of events) {
    const effectiveObservationAt = Date.parse(
      event.providerUpdatedAt ?? event.publishedAt,
    );
    if (
      event.source !== claim.provider ||
      event.sourceKind !== "licensed_news" ||
      event.sourceEventId.trim().length === 0 ||
      seenIds.has(event.sourceEventId) ||
      !Number.isFinite(effectiveObservationAt) ||
      effectiveObservationAt < windowStart ||
      effectiveObservationAt > windowEnd
    ) {
      throw new IngestionTickError(
        "provider_page_contract_invalid",
        "page_validation",
        false,
      );
    }
    seenIds.add(event.sourceEventId);
  }
}

export function createIntelligenceIngestionService(
  dependencies: IngestionDependencies,
) {
  return {
    async runTick(): Promise<IngestionTickResult> {
      const startedAt = (dependencies.now ?? (() => new Date()))().toISOString();
      const windowEnd = addMilliseconds(startedAt, -PROVIDER_SETTLING_DELAY_MS);
      const windowStart = addMilliseconds(windowEnd, -CORRECTION_LOOKBACK_MS);
      const windowFingerprint = await createAlpacaNewsQueryFingerprint({
        symbols: dependencies.config.symbols,
        windowStart,
        windowEnd,
        pageSize: dependencies.config.pageSize,
      });
      const leaseExpiresAt = addMilliseconds(startedAt, LEASE_DURATION_MS);
      let claim: ProviderCheckpointClaim | null = null;
      let runId: string | null = null;
      let stage: FailureStage = "claim";

      try {
        await dependencies.repository.ensureCheckpoint({
          provider: dependencies.config.provider,
          partitionKey: dependencies.config.partitionKey,
          nextDueAt: startedAt,
          now: startedAt,
        });
        const claimInput: ClaimNextDueInput = {
          provider: dependencies.config.provider,
          partitionKey: dependencies.config.partitionKey,
          claimedAt: startedAt,
          leaseExpiresAt,
          proposedWindow: {
            start: windowStart,
            end: windowEnd,
            fingerprint: windowFingerprint,
          },
        };
        claim = await dependencies.repository.claimNextDue(claimInput);
        if (!claim) {
          return {
            outcome: "idle",
            provider: dependencies.config.provider,
            checkedAt: startedAt,
          };
        }

        stage = "run_start";
        runId = await dependencies.repository.startRun(claim.lease, startedAt);
        stage = "provider_fetch";
        const tickSignal = AbortSignal.timeout(TICK_DEADLINE_MS);
        const page = await dependencies.provider.getEventPage({
          symbols: dependencies.config.symbols,
          windowStart: claim.window.start,
          windowEnd: claim.window.end,
          pageSize: dependencies.config.pageSize,
          cursor: claim.resumeCursor
            ? {
                token: claim.resumeCursor,
                queryFingerprint: claim.window.fingerprint,
              }
            : null,
          signal: tickSignal,
        });

        stage = "page_validation";
        const nextCursor = page.nextCursor ?? null;
        if (
          page.queryFingerprint !== claim.window.fingerprint ||
          page.exhausted === Boolean(nextCursor) ||
          (nextCursor !== null &&
            nextCursor.queryFingerprint !== claim.window.fingerprint) ||
          (claim.resumeCursor !== null &&
            nextCursor?.token === claim.resumeCursor)
        ) {
          throw new IngestionTickError(
            claim.resumeCursor !== null &&
              nextCursor?.token === claim.resumeCursor
              ? "invalid_cursor"
              : "provider_page_contract_invalid",
            "page_validation",
            false,
          );
        }
        validatePageEvents(page.events, claim, dependencies.config.pageSize);
        const receipts = await Promise.all(
          page.events.map((event) =>
            receiptForEvent(event, dependencies.config.symbols),
          ),
        );
        stage = "persistence";
        const persisted = await dependencies.repository.persistPage({
          lease: claim.lease,
          runId,
          receipts,
          nextCursor: nextCursor?.token ?? null,
          persistedAt: (dependencies.now ?? (() => new Date()))().toISOString(),
        });

        stage = "completion";
        const completedAt = (dependencies.now ?? (() => new Date()))().toISOString();
        await dependencies.repository.completeRun({
          lease: claim.lease,
          runId,
          completedAt,
          nextDueAt: page.exhausted
            ? addMilliseconds(
                completedAt,
                dependencies.config.cadenceSeconds * 1_000,
              )
            : completedAt,
          hasMore: !page.exhausted,
          ...(page.exhausted ? { highWaterMark: claim.window.end } : {}),
        });
        return {
          outcome: "processed",
          provider: dependencies.config.provider,
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
          const failedAt = (dependencies.now ?? (() => new Date()))().toISOString();
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

export function createConfiguredAlpacaIngestionProvider(
  environment: Record<string, string | undefined> = process.env,
) {
  return new AlpacaProvider({
    keyId: environment.ALPACA_API_KEY_ID,
    secretKey: environment.ALPACA_API_SECRET_KEY,
    feed:
      environment.ALPACA_DATA_FEED === "sip" ||
      environment.ALPACA_DATA_FEED === "delayed_sip"
        ? environment.ALPACA_DATA_FEED
        : "iex",
  });
}

export async function runIntelligenceIngestionTick(
  environment: Record<string, string | undefined> = process.env,
) {
  const [config, { ingestionRepository }] = await Promise.all([
    readIngestionRuntimeConfig(environment),
    import("@/lib/ingestion/repository"),
  ]);
  return createIntelligenceIngestionService({
    repository: ingestionRepository,
    provider: createConfiguredAlpacaIngestionProvider(environment),
    config,
  }).runTick();
}
