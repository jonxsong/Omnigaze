import type { CanonicalSymbol } from "@/lib/market-types";

export interface ProviderWindow {
  start: string;
  end: string;
  /** Stable hash of every query input other than the provider page token. */
  fingerprint: string;
}

export interface IngestionLeaseIdentity {
  provider: string;
  partitionKey: string;
  token: string;
}

export interface ProviderCheckpoint {
  provider: string;
  partitionKey: string;
  leaseExpiresAt: string | null;
  window: ProviderWindow | null;
  resumeCursor: string | null;
  highWaterMark: string | null;
  nextDueAt: string;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  consecutiveFailures: number;
  totalSuccesses: number;
  totalFailures: number;
}

export interface ProviderCheckpointClaim extends ProviderCheckpoint {
  lease: IngestionLeaseIdentity;
  leaseExpiresAt: string;
  window: ProviderWindow;
}

export interface EnsureCheckpointInput {
  provider: string;
  partitionKey: string;
  nextDueAt: string;
  now: string;
}

export interface ClaimNextDueInput {
  provider: string;
  /** When set, only this configured partition may be claimed. */
  partitionKey?: string;
  claimedAt: string;
  leaseExpiresAt: string;
  proposedWindow: ProviderWindow;
}

export interface RawSourceEventReceipt {
  sourceKind: string;
  sourceEventId: string;
  publishedAt: string;
  observedAt: string;
  /** Only a minimal canonical envelope may be persisted, never provider bodies. */
  payloadPolicy: "minimal_redacted_v1";
  /** Lower-case SHA-256 of the minimal redacted rawPayload envelope. */
  rawPayloadHash: string;
  rawPayload: string;
  status?: string;
  symbolIds: CanonicalSymbol[];
  providerRevisionAt?: string | null;
}

export interface PersistPageInput {
  lease: IngestionLeaseIdentity;
  runId: string;
  receipts: readonly RawSourceEventReceipt[];
  nextCursor: string | null;
  persistedAt: string;
}

export interface PersistPageResult {
  receiptCount: number;
  insertedReceiptCount: number;
  linkedSymbolCount: number;
  nextCursor: string | null;
  highWaterMark: string | null;
}

export interface CompleteRunInput {
  lease: IngestionLeaseIdentity;
  runId: string;
  completedAt: string;
  nextDueAt: string;
  /** Keep the frozen window and resume cursor when another page remains. */
  hasMore: boolean;
  highWaterMark?: string | null;
}

export interface SafeIngestionError {
  code: string;
  stage: string;
  message: string;
  retryable: boolean;
}

export interface FailRunInput {
  lease: IngestionLeaseIdentity;
  runId: string;
  failedAt: string;
  nextDueAt: string;
  error: SafeIngestionError;
}

export interface IngestionProviderStatus {
  provider: string;
  partitionCount: number;
  duePartitionCount: number;
  leasedPartitionCount: number;
  resumingPartitionCount: number;
  failingPartitionCount: number;
  totalSuccesses: number;
  totalFailures: number;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  /** Latest provider revision/observation seen; distinct from scan watermark. */
  latestEvidenceAt: string | null;
  runs: {
    running: number;
    succeeded: number;
    failed: number;
    receipts: number;
    errors: number;
  };
}

export interface IngestionAggregateStatus {
  generatedAt: string;
  since: string;
  providers: IngestionProviderStatus[];
}

export interface GetIngestionStatusInput {
  now: string;
  since: string;
  provider?: string;
  partitionKey?: string;
}

export interface CollectedEventCursor {
  effectiveAt: string;
  receiptId: string;
}

export interface ListCollectedEventsInput {
  provider: string;
  /** Omit to read the provider's retained history across partition versions. */
  partitionKey?: string;
  /** Inclusive lower bound over provider revision/observation time. */
  since: string;
  symbolIds: readonly CanonicalSymbol[];
  before?: CollectedEventCursor;
  limit: number;
}

export interface CollectedEventEnvelope {
  schema: string | null;
  headline: string;
  summary: string | null;
  url: string | null;
  contentDigest: string | null;
}

export interface CollectedSourceEvent {
  receiptId: string;
  provider: string;
  sourceKind: string;
  sourceEventId: string;
  publishedAt: string;
  observedAt: string;
  providerRevisionAt: string | null;
  effectiveAt: string;
  lastSeenAt: string;
  symbolIds: CanonicalSymbol[];
  payloadPolicy: "minimal_redacted_v1";
  envelope: CollectedEventEnvelope;
}

export interface CollectedEventPage {
  items: CollectedSourceEvent[];
  hasMore: boolean;
  nextBefore: CollectedEventCursor | null;
}
