import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  providerIngestionCheckpoints,
  providerIngestionRunErrors,
  providerIngestionRuns,
  sourceEventIngestionMetadata,
  sourceEventSymbols,
  sourceEvents,
} from "@/db/schema";
import type {
  ClaimNextDueInput,
  CollectedEventEnvelope,
  CollectedEventPage,
  CompleteRunInput,
  EnsureCheckpointInput,
  FailRunInput,
  GetIngestionStatusInput,
  IngestionAggregateStatus,
  IngestionLeaseIdentity,
  ListCollectedEventsInput,
  PersistPageInput,
  PersistPageResult,
  ProviderCheckpoint,
  ProviderCheckpointClaim,
  ProviderWindow,
  RawSourceEventReceipt,
  SafeIngestionError,
} from "@/lib/ingestion/contracts";
import type { CanonicalSymbol } from "@/lib/market-types";

type IngestionDatabase = ReturnType<typeof getDb>;
type IngestionDatabaseFactory = () => IngestionDatabase;

export const MAX_RECEIPTS_PER_INGESTION_PAGE = 100;
export const MAX_SYMBOL_LINKS_PER_INGESTION_PAGE = 500;
export const MAX_RETAINED_RUNS_PER_PARTITION = 100;
export const MAX_RAW_RECEIPT_BYTES = 32_000;
export const MAX_RAW_PAGE_BYTES = 500_000;

export type IngestionRepositoryErrorCode =
  | "invalid_input"
  | "lease_lost"
  | "not_found"
  | "conflict";

export class IngestionRepositoryError extends Error {
  constructor(readonly code: IngestionRepositoryErrorCode) {
    super(code);
    this.name = "IngestionRepositoryError";
  }
}

export interface IngestionRepository {
  ensureCheckpoint(input: EnsureCheckpointInput): Promise<ProviderCheckpoint>;
  claimNextDue(
    input: ClaimNextDueInput,
  ): Promise<ProviderCheckpointClaim | null>;
  startRun(lease: IngestionLeaseIdentity, startedAt: string): Promise<string>;
  persistPage(input: PersistPageInput): Promise<PersistPageResult>;
  completeRun(input: CompleteRunInput): Promise<void>;
  failRun(input: FailRunInput): Promise<void>;
  getAggregateStatus(
    input: GetIngestionStatusInput,
  ): Promise<IngestionAggregateStatus>;
  listCollectedEvents(
    input: ListCollectedEventsInput,
  ): Promise<CollectedEventPage>;
}

type CheckpointRow = typeof providerIngestionCheckpoints.$inferSelect;
type RunRow = typeof providerIngestionRuns.$inferSelect;

type PreparedReceipt = {
  id: string;
  source: string;
  sourceKind: string;
  sourceEventId: string;
  publishedAt: string;
  observedAt: string;
  rawPayloadHash: string;
  rawPayload: string;
  payloadPolicy: "minimal_redacted_v1";
  status: string;
  symbolIds: string[];
  providerRevisionAt: string | null;
};

function invalid(): never {
  throw new IngestionRepositoryError("invalid_input");
}

function boundedText(value: string, maximum: number) {
  const normalized = value.trim();
  if (
    normalized.length === 0 ||
    normalized.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    invalid();
  }
  return normalized;
}

function isoTimestamp(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) invalid();
  return new Date(timestamp).toISOString();
}

function optionalIsoTimestamp(value: string | null | undefined) {
  return value == null ? null : isoTimestamp(value);
}

function providerName(value: string) {
  return boundedText(value, 64).toLowerCase();
}

function partitionName(value: string) {
  return boundedText(value, 256);
}

function cursorValue(value: string | null) {
  return value === null ? null : boundedText(value, 2_048);
}

function normalizeWindow(window: ProviderWindow): ProviderWindow {
  const start = isoTimestamp(window.start);
  const end = isoTimestamp(window.end);
  if (Date.parse(start) > Date.parse(end)) invalid();
  return {
    start,
    end,
    fingerprint: boundedText(window.fingerprint, 128),
  };
}

function normalizeLease(lease: IngestionLeaseIdentity): IngestionLeaseIdentity {
  return {
    provider: providerName(lease.provider),
    partitionKey: partitionName(lease.partitionKey),
    token: boundedText(lease.token, 128),
  };
}

function checkpointView(row: CheckpointRow): ProviderCheckpoint {
  const hasWindow =
    row.windowStart !== null &&
    row.windowEnd !== null &&
    row.windowFingerprint !== null;
  return {
    provider: row.provider,
    partitionKey: row.partitionKey,
    leaseExpiresAt: row.leaseExpiresAt,
    window: hasWindow
      ? {
          start: row.windowStart!,
          end: row.windowEnd!,
          fingerprint: row.windowFingerprint!,
        }
      : null,
    resumeCursor: row.resumeCursor,
    highWaterMark: row.highWaterMark,
    nextDueAt: row.nextDueAt,
    lastAttemptAt: row.lastAttemptAt,
    lastSuccessAt: row.lastSuccessAt,
    lastFailureAt: row.lastFailureAt,
    consecutiveFailures: row.consecutiveFailures,
    totalSuccesses: row.totalSuccesses,
    totalFailures: row.totalFailures,
  };
}

function claimView(row: CheckpointRow): ProviderCheckpointClaim {
  if (
    row.leaseToken === null ||
    row.leaseExpiresAt === null ||
    row.windowStart === null ||
    row.windowEnd === null ||
    row.windowFingerprint === null
  ) {
    throw new Error("invalid_ingestion_checkpoint_claim");
  }
  return {
    ...checkpointView(row),
    lease: {
      provider: row.provider,
      partitionKey: row.partitionKey,
      token: row.leaseToken,
    },
    leaseExpiresAt: row.leaseExpiresAt,
    window: {
      start: row.windowStart,
      end: row.windowEnd,
      fingerprint: row.windowFingerprint,
    },
  };
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sourceReceiptId(
  source: string,
  sourceEventId: string,
  rawPayloadHash: string,
) {
  return `src_${await sha256Hex(
    `${source}\u0000${sourceEventId}\u0000${rawPayloadHash}`,
  )}`;
}

async function prepareReceipts(
  provider: string,
  receipts: readonly RawSourceEventReceipt[],
) {
  if (receipts.length > MAX_RECEIPTS_PER_INGESTION_PAGE) invalid();
  let pageBytes = 0;
  const byId = new Map<string, PreparedReceipt>();
  const revisionHashes = new Map<string, string>();

  for (const receipt of receipts) {
    if (receipt.payloadPolicy !== "minimal_redacted_v1") invalid();
    const sourceKind = boundedText(receipt.sourceKind, 64);
    const sourceEventId = boundedText(receipt.sourceEventId, 512);
    const publishedAt = isoTimestamp(receipt.publishedAt);
    const observedAt = isoTimestamp(receipt.observedAt);
    const rawPayloadHash = receipt.rawPayloadHash.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/u.test(rawPayloadHash)) invalid();
    const rawPayloadBytes = new TextEncoder().encode(receipt.rawPayload).length;
    pageBytes += rawPayloadBytes;
    if (
      rawPayloadBytes > MAX_RAW_RECEIPT_BYTES ||
      pageBytes > MAX_RAW_PAGE_BYTES ||
      (await sha256Hex(receipt.rawPayload)) !== rawPayloadHash
    ) {
      invalid();
    }
    let payload: unknown;
    try {
      payload = JSON.parse(receipt.rawPayload) as unknown;
    } catch {
      invalid();
    }
    if (
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      /"(?:authorization|credential|password|secret|api[_-]?key|access[_-]?token|raw[_-]?(?:body|payload)|article[_-]?(?:body|content)|full[_-]?text)"\s*:/iu.test(
        receipt.rawPayload,
      ) ||
      /\b(?:bearer\s+[a-z0-9._-]{8,}|sk-(?:proj-)?[a-z0-9_-]{8,})\b/iu.test(
        receipt.rawPayload,
      )
    ) {
      invalid();
    }
    const status = boundedText(receipt.status ?? "received", 32);
    const providerRevisionAt = optionalIsoTimestamp(
      receipt.providerRevisionAt,
    );
    const revisionIdentity = `${sourceEventId}\u0000${providerRevisionAt ?? observedAt}`;
    const acceptedRevisionHash = revisionHashes.get(revisionIdentity);
    if (
      acceptedRevisionHash !== undefined &&
      acceptedRevisionHash !== rawPayloadHash
    ) {
      throw new IngestionRepositoryError("conflict");
    }
    revisionHashes.set(revisionIdentity, rawPayloadHash);
    const symbolIds = [
      ...new Set(
        receipt.symbolIds.map((symbolId) => boundedText(symbolId, 128)),
      ),
    ].sort();
    const envelope = collectedEnvelope(receipt.rawPayload);
    const canonicalPayload = payload as Record<string, unknown>;
    const envelopeSymbols = Array.isArray(canonicalPayload.symbolIds)
      ? canonicalPayload.symbolIds
          .filter((value): value is string => typeof value === "string")
          .sort()
      : [];
    if (
      canonicalPayload.sourceKind !== sourceKind ||
      canonicalPayload.sourceEventId !== sourceEventId ||
      canonicalPayload.publishedAt !== publishedAt ||
      canonicalPayload.providerRevisionAt !== providerRevisionAt ||
      JSON.stringify(envelopeSymbols) !== JSON.stringify(symbolIds) ||
      envelope.headline.length === 0
    ) {
      invalid();
    }
    const id = await sourceReceiptId(
      provider,
      sourceEventId,
      rawPayloadHash,
    );
    const prepared: PreparedReceipt = {
      id,
      source: provider,
      sourceKind,
      sourceEventId,
      publishedAt,
      observedAt,
      rawPayloadHash,
      rawPayload: receipt.rawPayload,
      payloadPolicy: receipt.payloadPolicy,
      status,
      symbolIds,
      providerRevisionAt,
    };
    const existing = byId.get(id);
    if (existing) {
      if (
        existing.sourceKind !== prepared.sourceKind ||
        existing.sourceEventId !== prepared.sourceEventId ||
        existing.publishedAt !== prepared.publishedAt ||
        existing.rawPayload !== prepared.rawPayload ||
        existing.status !== prepared.status
      ) {
        throw new IngestionRepositoryError("conflict");
      }
      existing.symbolIds = [
        ...new Set([...existing.symbolIds, ...prepared.symbolIds]),
      ].sort();
      if (
        prepared.providerRevisionAt !== null &&
        (existing.providerRevisionAt === null ||
          Date.parse(prepared.providerRevisionAt) >
            Date.parse(existing.providerRevisionAt))
      ) {
        existing.providerRevisionAt = prepared.providerRevisionAt;
      }
      continue;
    }
    byId.set(id, prepared);
  }

  const prepared = [...byId.values()];
  if (
    prepared.reduce((count, receipt) => count + receipt.symbolIds.length, 0) >
    MAX_SYMBOL_LINKS_PER_INGESTION_PAGE
  ) {
    invalid();
  }
  return prepared;
}

function safeError(error: SafeIngestionError) {
  const safeToken = (value: string, fallback: string) => {
    const token = value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_.:-]+/gu, "_")
      .replace(/^_+|_+$/gu, "")
      .slice(0, 64);
    return token || fallback;
  };
  let message = error.message
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\bsk-(?:proj-)?[a-z0-9_-]{8,}\b/giu, "[redacted]")
    .replace(/(bearer\s+)[^\s]+/giu, "$1[redacted]")
    .replace(
      /([?&](?:token|key|secret|signature)=)[^&\s]+/giu,
      "$1[redacted]",
    )
    .replace(
      /((?:api[_-]?(?:key|secret)|access[_-]?token|password)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[redacted]",
    )
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 300);
  if (!message) message = "Provider ingestion failed.";
  return {
    code: safeToken(error.code, "provider_error"),
    stage: safeToken(error.stage, "unknown"),
    message,
    retryable: error.retryable,
  };
}

async function ensureCheckpoint(
  db: IngestionDatabase,
  input: EnsureCheckpointInput,
) {
  const provider = providerName(input.provider);
  const partitionKey = partitionName(input.partitionKey);
  const nextDueAt = isoTimestamp(input.nextDueAt);
  const now = isoTimestamp(input.now);
  await db
    .insert(providerIngestionCheckpoints)
    .values({
      provider,
      partitionKey,
      nextDueAt,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const row = (
    await db
      .select()
      .from(providerIngestionCheckpoints)
      .where(
        and(
          eq(providerIngestionCheckpoints.provider, provider),
          eq(providerIngestionCheckpoints.partitionKey, partitionKey),
        ),
      )
      .limit(1)
  )[0];
  if (!row) throw new Error("ingestion_checkpoint_create_failed");
  return checkpointView(row);
}

async function claimNextDue(
  db: IngestionDatabase,
  input: ClaimNextDueInput,
): Promise<ProviderCheckpointClaim | null> {
  const provider = providerName(input.provider);
  const partitionKey = input.partitionKey
    ? partitionName(input.partitionKey)
    : null;
  const claimedAt = isoTimestamp(input.claimedAt);
  const leaseExpiresAt = isoTimestamp(input.leaseExpiresAt);
  if (Date.parse(leaseExpiresAt) <= Date.parse(claimedAt)) invalid();
  const proposedWindow = normalizeWindow(input.proposedWindow);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const candidate = (
      await db
        .select()
        .from(providerIngestionCheckpoints)
        .where(
          and(
            eq(providerIngestionCheckpoints.provider, provider),
            partitionKey === null
              ? undefined
              : eq(providerIngestionCheckpoints.partitionKey, partitionKey),
            sql`julianday(${providerIngestionCheckpoints.nextDueAt}) <= julianday(${claimedAt})`,
            sql`(${providerIngestionCheckpoints.leaseToken} IS NULL OR julianday(${providerIngestionCheckpoints.leaseExpiresAt}) <= julianday(${claimedAt}))`,
          ),
        )
        .orderBy(
          asc(providerIngestionCheckpoints.nextDueAt),
          asc(providerIngestionCheckpoints.partitionKey),
        )
        .limit(1)
    )[0];
    if (!candidate) return null;

    const token = crypto.randomUUID();
    const abandonedLease =
      candidate.leaseToken !== null &&
      candidate.leaseExpiresAt !== null &&
      Date.parse(candidate.leaseExpiresAt) <= Date.parse(claimedAt);
    const updated = await db
      .update(providerIngestionCheckpoints)
      .set({
        leaseToken: token,
        leaseExpiresAt,
        windowStart: candidate.windowStart ?? proposedWindow.start,
        windowEnd: candidate.windowEnd ?? proposedWindow.end,
        windowFingerprint:
          candidate.windowFingerprint ?? proposedWindow.fingerprint,
        lastAttemptAt: claimedAt,
        lastFailureAt: abandonedLease
          ? claimedAt
          : candidate.lastFailureAt,
        consecutiveFailures: abandonedLease
          ? candidate.consecutiveFailures + 1
          : candidate.consecutiveFailures,
        totalFailures: abandonedLease
          ? candidate.totalFailures + 1
          : candidate.totalFailures,
        updatedAt: claimedAt,
      })
      .where(
        and(
          eq(providerIngestionCheckpoints.provider, candidate.provider),
          eq(
            providerIngestionCheckpoints.partitionKey,
            candidate.partitionKey,
          ),
          sql`julianday(${providerIngestionCheckpoints.nextDueAt}) <= julianday(${claimedAt})`,
          sql`(${providerIngestionCheckpoints.leaseToken} IS NULL OR julianday(${providerIngestionCheckpoints.leaseExpiresAt}) <= julianday(${claimedAt}))`,
        ),
      )
      .returning();
    if (!updated[0]) continue;

    // Repair a run orphaned between checkpoint finalization and run-ledger
    // finalization as well as one abandoned by lease expiry. The newly claimed
    // token has no run yet, so every different running token is stale.
    await db
      .update(providerIngestionRuns)
      .set({ status: "failed", completedAt: claimedAt })
      .where(
        and(
          eq(providerIngestionRuns.provider, candidate.provider),
          eq(providerIngestionRuns.partitionKey, candidate.partitionKey),
          eq(providerIngestionRuns.status, "running"),
          sql`${providerIngestionRuns.leaseToken} <> ${token}`,
        ),
      );
    return claimView(updated[0]);
  }
  return null;
}

async function activeCheckpoint(
  db: IngestionDatabase,
  lease: IngestionLeaseIdentity,
  at: string,
) {
  const row = (
    await db
      .select()
      .from(providerIngestionCheckpoints)
      .where(
        and(
          eq(providerIngestionCheckpoints.provider, lease.provider),
          eq(providerIngestionCheckpoints.partitionKey, lease.partitionKey),
          eq(providerIngestionCheckpoints.leaseToken, lease.token),
          sql`julianday(${providerIngestionCheckpoints.leaseExpiresAt}) > julianday(${at})`,
        ),
      )
      .limit(1)
  )[0];
  if (!row) throw new IngestionRepositoryError("lease_lost");
  return row;
}

async function startRun(
  db: IngestionDatabase,
  rawLease: IngestionLeaseIdentity,
  rawStartedAt: string,
) {
  const lease = normalizeLease(rawLease);
  const startedAt = isoTimestamp(rawStartedAt);
  const checkpoint = await activeCheckpoint(db, lease, startedAt);
  if (
    checkpoint.windowStart === null ||
    checkpoint.windowEnd === null ||
    checkpoint.windowFingerprint === null
  ) {
    throw new Error("ingestion_checkpoint_window_missing");
  }
  const runId = `run_${crypto.randomUUID()}`;
  const inserted = await db
    .insert(providerIngestionRuns)
    .values({
      id: runId,
      provider: lease.provider,
      partitionKey: lease.partitionKey,
      leaseToken: lease.token,
      windowStart: checkpoint.windowStart,
      windowEnd: checkpoint.windowEnd,
      windowFingerprint: checkpoint.windowFingerprint,
      resumeCursorStart: checkpoint.resumeCursor,
      status: "running",
      startedAt,
    })
    .onConflictDoNothing()
    .returning({ id: providerIngestionRuns.id });
  if (inserted[0]) return inserted[0].id;
  const existing = (
    await db
      .select({ id: providerIngestionRuns.id })
      .from(providerIngestionRuns)
      .where(
        and(
          eq(providerIngestionRuns.provider, lease.provider),
          eq(providerIngestionRuns.partitionKey, lease.partitionKey),
          eq(providerIngestionRuns.leaseToken, lease.token),
        ),
      )
      .limit(1)
  )[0];
  if (!existing) throw new Error("ingestion_run_create_failed");
  return existing.id;
}

async function loadRun(
  db: IngestionDatabase,
  lease: IngestionLeaseIdentity,
  runId: string,
) {
  const row = (
    await db
      .select()
      .from(providerIngestionRuns)
      .where(
        and(
          eq(providerIngestionRuns.id, runId),
          eq(providerIngestionRuns.provider, lease.provider),
          eq(providerIngestionRuns.partitionKey, lease.partitionKey),
          eq(providerIngestionRuns.leaseToken, lease.token),
        ),
      )
      .limit(1)
  )[0];
  if (!row) throw new IngestionRepositoryError("not_found");
  return row;
}

function sameCursor(left: string | null, right: string | null) {
  return left === right;
}

async function persistCursorAfterReceipts(
  db: IngestionDatabase,
  lease: IngestionLeaseIdentity,
  run: RunRow,
  persistedAt: string,
  nextCursor: string | null,
) {
  const updated = await db
    .update(providerIngestionCheckpoints)
    .set({
      resumeCursor: nextCursor,
      updatedAt: persistedAt,
    })
    .where(
      and(
        eq(providerIngestionCheckpoints.provider, lease.provider),
        eq(providerIngestionCheckpoints.partitionKey, lease.partitionKey),
        eq(providerIngestionCheckpoints.leaseToken, lease.token),
        sql`julianday(${providerIngestionCheckpoints.leaseExpiresAt}) > julianday(${persistedAt})`,
        run.resumeCursorStart === null
          ? isNull(providerIngestionCheckpoints.resumeCursor)
          : eq(
              providerIngestionCheckpoints.resumeCursor,
              run.resumeCursorStart,
            ),
      ),
    )
    .returning({
      resumeCursor: providerIngestionCheckpoints.resumeCursor,
      highWaterMark: providerIngestionCheckpoints.highWaterMark,
    });
  if (updated[0]) return updated[0];

  const checkpoint = await activeCheckpoint(db, lease, persistedAt);
  if (!sameCursor(checkpoint.resumeCursor, nextCursor)) {
    throw new IngestionRepositoryError("conflict");
  }
  return {
    resumeCursor: checkpoint.resumeCursor,
    highWaterMark: checkpoint.highWaterMark,
  };
}

async function persistPage(
  db: IngestionDatabase,
  input: PersistPageInput,
): Promise<PersistPageResult> {
  const lease = normalizeLease(input.lease);
  const runId = boundedText(input.runId, 128);
  const persistedAt = isoTimestamp(input.persistedAt);
  const nextCursor = cursorValue(input.nextCursor);
  await activeCheckpoint(db, lease, persistedAt);
  let run = await loadRun(db, lease, runId);
  if (run.status !== "running") throw new IngestionRepositoryError("conflict");

  const receipts = await prepareReceipts(lease.provider, input.receipts);
  const pageFingerprint = await sha256Hex(
    JSON.stringify({
      receipts: receipts
        .map(({ id, rawPayloadHash, symbolIds }) => ({
          id,
          rawPayloadHash,
          symbolIds,
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      nextCursor,
    }),
  );

  if (run.pagePersistedAt !== null) {
    if (run.pageFingerprint !== pageFingerprint) {
      throw new IngestionRepositoryError("conflict");
    }
    const checkpoint = await persistCursorAfterReceipts(
      db,
      lease,
      run,
      persistedAt,
      nextCursor,
    );
    return {
      receiptCount: run.receiptCount,
      insertedReceiptCount: run.insertedReceiptCount,
      linkedSymbolCount: run.symbolLinkCount,
      nextCursor: checkpoint.resumeCursor,
      highWaterMark: checkpoint.highWaterMark,
    };
  }

  const receiptJson = JSON.stringify(receipts);
  const insertedReceipts = await db.values<[string]>(sql`
    WITH incoming AS (
      SELECT
        json_extract(value, '$.id') AS id,
        json_extract(value, '$.source') AS source,
        json_extract(value, '$.sourceKind') AS source_kind,
        json_extract(value, '$.sourceEventId') AS source_event_id,
        json_extract(value, '$.publishedAt') AS published_at,
        json_extract(value, '$.observedAt') AS observed_at,
        json_extract(value, '$.rawPayloadHash') AS raw_payload_hash,
        json_extract(value, '$.rawPayload') AS raw_payload,
        json_extract(value, '$.status') AS status
      FROM json_each(${receiptJson})
    )
    INSERT INTO ${sourceEvents} (
      id, source, source_kind, source_event_id, symbol_id, published_at,
      observed_at, raw_payload_hash, raw_payload, status
    )
    SELECT
      id, source, source_kind, source_event_id, NULL, published_at,
      observed_at, raw_payload_hash, raw_payload, status
    FROM incoming
    WHERE 1 = 1
    ON CONFLICT (source, source_event_id, raw_payload_hash) DO NOTHING
    RETURNING id
  `);

  const collisions = await db.values<[string]>(sql`
    WITH incoming AS (
      SELECT
        json_extract(value, '$.id') AS id,
        json_extract(value, '$.source') AS source,
        json_extract(value, '$.sourceKind') AS source_kind,
        json_extract(value, '$.sourceEventId') AS source_event_id,
        json_extract(value, '$.publishedAt') AS published_at,
        json_extract(value, '$.rawPayloadHash') AS raw_payload_hash,
        json_extract(value, '$.rawPayload') AS raw_payload,
        json_extract(value, '$.status') AS status
      FROM json_each(${receiptJson})
    )
    SELECT incoming.id
    FROM incoming
    LEFT JOIN ${sourceEvents}
      ON ${sourceEvents.source} = incoming.source
      AND ${sourceEvents.sourceEventId} = incoming.source_event_id
      AND ${sourceEvents.rawPayloadHash} = incoming.raw_payload_hash
    WHERE ${sourceEvents.id} IS NULL
      OR ${sourceEvents.id} <> incoming.id
      OR ${sourceEvents.sourceKind} <> incoming.source_kind
      OR ${sourceEvents.publishedAt} <> incoming.published_at
      OR ${sourceEvents.rawPayload} <> incoming.raw_payload
      OR ${sourceEvents.status} <> incoming.status
    LIMIT 1
  `);
  if (collisions.length > 0) throw new IngestionRepositoryError("conflict");

  const symbolLinks = receipts.flatMap((receipt) =>
    receipt.symbolIds.map((symbolId) => ({
      sourceEventId: receipt.id,
      symbolId,
    })),
  );
  const insertedLinks =
    symbolLinks.length === 0
      ? []
      : await db.values<[string, string]>(sql`
          WITH incoming AS (
            SELECT
              json_extract(value, '$.sourceEventId') AS source_event_id,
              json_extract(value, '$.symbolId') AS symbol_id
            FROM json_each(${JSON.stringify(symbolLinks)})
          )
          INSERT INTO ${sourceEventSymbols} (source_event_id, symbol_id)
          SELECT source_event_id, symbol_id
          FROM incoming
          WHERE 1 = 1
          ON CONFLICT (source_event_id, symbol_id) DO NOTHING
          RETURNING source_event_id, symbol_id
        `);

  const metadata = receipts.map((receipt) => ({
    sourceEventId: receipt.id,
    provider: lease.provider,
    partitionKey: lease.partitionKey,
    payloadPolicy: receipt.payloadPolicy,
    providerRevisionAt: receipt.providerRevisionAt,
    runId,
    seenAt: persistedAt,
  }));
  if (metadata.length > 0) {
    await db.run(sql`
      WITH incoming AS (
        SELECT
          json_extract(value, '$.sourceEventId') AS source_event_id,
          json_extract(value, '$.provider') AS provider,
          json_extract(value, '$.partitionKey') AS partition_key,
          json_extract(value, '$.payloadPolicy') AS payload_policy,
          json_extract(value, '$.providerRevisionAt') AS provider_revision_at,
          json_extract(value, '$.runId') AS run_id,
          json_extract(value, '$.seenAt') AS seen_at
        FROM json_each(${JSON.stringify(metadata)})
      )
      INSERT INTO ${sourceEventIngestionMetadata} (
        source_event_id, provider, partition_key, payload_policy,
        provider_revision_at, first_ingestion_run_id, last_ingestion_run_id,
        first_seen_at, last_seen_at, seen_count
      )
      SELECT
        source_event_id, provider, partition_key, payload_policy,
        provider_revision_at, run_id, run_id, seen_at, seen_at, 1
      FROM incoming
      WHERE 1 = 1
      ON CONFLICT (source_event_id, provider, partition_key) DO UPDATE SET
        provider_revision_at = CASE
          WHEN excluded.provider_revision_at IS NOT NULL
            AND (
              ${sourceEventIngestionMetadata.providerRevisionAt} IS NULL
              OR julianday(${sourceEventIngestionMetadata.providerRevisionAt}) <
                julianday(excluded.provider_revision_at)
            )
          THEN excluded.provider_revision_at
          ELSE ${sourceEventIngestionMetadata.providerRevisionAt}
        END,
        last_ingestion_run_id = excluded.last_ingestion_run_id,
        last_seen_at = excluded.last_seen_at,
        seen_count = CASE
          WHEN ${sourceEventIngestionMetadata.lastIngestionRunId} =
            excluded.last_ingestion_run_id
          THEN ${sourceEventIngestionMetadata.seenCount}
          ELSE ${sourceEventIngestionMetadata.seenCount} + 1
        END
    `);
  }

  const pageRecorded = await db
    .update(providerIngestionRuns)
    .set({
      resumeCursorEnd: nextCursor,
      pageFingerprint,
      pagePersistedAt: persistedAt,
      receiptCount: receipts.length,
      insertedReceiptCount: insertedReceipts.length,
      symbolLinkCount: insertedLinks.length,
    })
    .where(
      and(
        eq(providerIngestionRuns.id, runId),
        eq(providerIngestionRuns.status, "running"),
        isNull(providerIngestionRuns.pageFingerprint),
      ),
    )
    .returning();
  if (!pageRecorded[0]) {
    run = await loadRun(db, lease, runId);
    if (
      run.status !== "running" ||
      run.pageFingerprint !== pageFingerprint
    ) {
      throw new IngestionRepositoryError("conflict");
    }
  } else {
    run = pageRecorded[0];
  }

  const checkpoint = await persistCursorAfterReceipts(
    db,
    lease,
    run,
    persistedAt,
    nextCursor,
  );
  return {
    receiptCount: run.receiptCount,
    insertedReceiptCount: run.insertedReceiptCount,
    linkedSymbolCount: run.symbolLinkCount,
    nextCursor: checkpoint.resumeCursor,
    highWaterMark: checkpoint.highWaterMark,
  };
}

async function pruneRuns(
  db: IngestionDatabase,
  lease: IngestionLeaseIdentity,
) {
  await db.run(sql`
    DELETE FROM ${providerIngestionRuns}
    WHERE id IN (
      SELECT id
      FROM ${providerIngestionRuns}
      WHERE provider = ${lease.provider}
        AND partition_key = ${lease.partitionKey}
        AND status <> 'running'
      ORDER BY completed_at DESC, started_at DESC, id DESC
      LIMIT -1 OFFSET ${MAX_RETAINED_RUNS_PER_PARTITION}
    )
  `);
}

async function completeRun(
  db: IngestionDatabase,
  input: CompleteRunInput,
) {
  const lease = normalizeLease(input.lease);
  const runId = boundedText(input.runId, 128);
  const completedAt = isoTimestamp(input.completedAt);
  const nextDueAt = isoTimestamp(input.nextDueAt);
  const requestedHighWater = optionalIsoTimestamp(input.highWaterMark);
  const run = await loadRun(db, lease, runId);
  if (run.status === "succeeded") return;
  if (run.status !== "running" || run.pagePersistedAt === null) {
    throw new IngestionRepositoryError("conflict");
  }
  if (
    (input.hasMore &&
      (run.resumeCursorEnd === null || requestedHighWater !== null)) ||
    (!input.hasMore &&
      (run.resumeCursorEnd !== null || requestedHighWater !== run.windowEnd))
  ) {
    invalid();
  }

  const completed = await db
    .update(providerIngestionCheckpoints)
    .set({
      leaseToken: null,
      leaseExpiresAt: null,
      windowStart: input.hasMore ? undefined : null,
      windowEnd: input.hasMore ? undefined : null,
      windowFingerprint: input.hasMore ? undefined : null,
      resumeCursor: input.hasMore ? undefined : null,
      highWaterMark:
        requestedHighWater === null
          ? undefined
          : sql`CASE
              WHEN ${providerIngestionCheckpoints.highWaterMark} IS NULL
                OR julianday(${providerIngestionCheckpoints.highWaterMark}) < julianday(${requestedHighWater})
              THEN ${requestedHighWater}
              ELSE ${providerIngestionCheckpoints.highWaterMark}
            END`,
      nextDueAt,
      lastSuccessAt: completedAt,
      consecutiveFailures: 0,
      totalSuccesses: sql`${providerIngestionCheckpoints.totalSuccesses} + 1`,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(providerIngestionCheckpoints.provider, lease.provider),
        eq(providerIngestionCheckpoints.partitionKey, lease.partitionKey),
        eq(providerIngestionCheckpoints.leaseToken, lease.token),
        sql`julianday(${providerIngestionCheckpoints.leaseExpiresAt}) > julianday(${completedAt})`,
      ),
    )
    .returning({ provider: providerIngestionCheckpoints.provider });
  if (!completed[0]) throw new IngestionRepositoryError("lease_lost");

  await db
    .update(providerIngestionRuns)
    .set({
      status: "succeeded",
      completedAt,
      highWaterMark: requestedHighWater,
    })
    .where(
      and(
        eq(providerIngestionRuns.id, runId),
        eq(providerIngestionRuns.status, "running"),
      ),
    );
  await pruneRuns(db, lease);
}

function shouldResetFrozenCursor(error: ReturnType<typeof safeError>) {
  return (
    !error.retryable &&
    new Set([
      "cursor_query_mismatch",
      "invalid_cursor",
      "invalid_page_token",
    ]).has(error.code)
  );
}

async function failRun(db: IngestionDatabase, input: FailRunInput) {
  const lease = normalizeLease(input.lease);
  const runId = boundedText(input.runId, 128);
  const failedAt = isoTimestamp(input.failedAt);
  const nextDueAt = isoTimestamp(input.nextDueAt);
  const error = safeError(input.error);
  const resetFrozenCursor = shouldResetFrozenCursor(error);
  const run = await loadRun(db, lease, runId);
  if (run.status === "failed") return;
  if (run.status !== "running") throw new IngestionRepositoryError("conflict");

  const failed = await db
    .update(providerIngestionCheckpoints)
    .set({
      leaseToken: null,
      leaseExpiresAt: null,
      windowStart: resetFrozenCursor ? null : undefined,
      windowEnd: resetFrozenCursor ? null : undefined,
      windowFingerprint: resetFrozenCursor ? null : undefined,
      resumeCursor: resetFrozenCursor ? null : undefined,
      nextDueAt,
      lastFailureAt: failedAt,
      consecutiveFailures: sql`${providerIngestionCheckpoints.consecutiveFailures} + 1`,
      totalFailures: sql`${providerIngestionCheckpoints.totalFailures} + 1`,
      updatedAt: failedAt,
    })
    .where(
      and(
        eq(providerIngestionCheckpoints.provider, lease.provider),
        eq(providerIngestionCheckpoints.partitionKey, lease.partitionKey),
        eq(providerIngestionCheckpoints.leaseToken, lease.token),
        sql`julianday(${providerIngestionCheckpoints.leaseExpiresAt}) > julianday(${failedAt})`,
      ),
    )
    .returning({ provider: providerIngestionCheckpoints.provider });
  if (!failed[0]) throw new IngestionRepositoryError("lease_lost");

  await db
    .insert(providerIngestionRunErrors)
    .values({
      id: `err_${crypto.randomUUID()}`,
      runId,
      code: error.code,
      stage: error.stage,
      safeMessage: error.message,
      retryable: error.retryable,
      occurredAt: failedAt,
    })
    .onConflictDoNothing();
  await db
    .update(providerIngestionRuns)
    .set({
      status: "failed",
      completedAt: failedAt,
      errorCount: sql`${providerIngestionRuns.errorCount} + 1`,
    })
    .where(
      and(
        eq(providerIngestionRuns.id, runId),
        eq(providerIngestionRuns.status, "running"),
      ),
    );
  await pruneRuns(db, lease);
}

function collectedEnvelope(rawPayload: string): CollectedEventEnvelope {
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawPayload) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("invalid_collected_event_envelope");
    }
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new IngestionRepositoryError("conflict");
  }
  const headline =
    typeof payload.headline === "string" ? payload.headline.trim() : "";
  if (headline.length === 0 || headline.length > 512) {
    throw new IngestionRepositoryError("conflict");
  }
  const optionalString = (value: unknown, maximum: number) => {
    if (value === null || value === undefined) return null;
    if (typeof value !== "string" || value.length > maximum) {
      throw new IngestionRepositoryError("conflict");
    }
    return value;
  };
  const schema = optionalString(payload.schema, 128);
  const url = optionalString(payload.url, 2_048);
  const contentDigest = optionalString(payload.contentDigest, 128);
  if (
    schema !== "omnigaze.provider-receipt.v1" ||
    (contentDigest !== null && !/^[a-f0-9]{64}$/u.test(contentDigest))
  ) {
    throw new IngestionRepositoryError("conflict");
  }
  if (url !== null) {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        throw new Error("unsupported_protocol");
      }
    } catch {
      throw new IngestionRepositoryError("conflict");
    }
  }
  return {
    schema,
    headline,
    summary: optionalString(payload.summary, 4_000),
    url,
    contentDigest,
  };
}

async function listCollectedEvents(
  db: IngestionDatabase,
  input: ListCollectedEventsInput,
): Promise<CollectedEventPage> {
  const provider = providerName(input.provider);
  const partitionKey = input.partitionKey
    ? partitionName(input.partitionKey)
    : null;
  const since = isoTimestamp(input.since);
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100) {
    invalid();
  }
  const symbolIds = [
    ...new Set(input.symbolIds.map((symbolId) => boundedText(symbolId, 128))),
  ].sort();
  if (symbolIds.length === 0) {
    return { items: [], hasMore: false, nextBefore: null };
  }
  if (symbolIds.length > 100) invalid();
  const before = input.before
    ? {
        effectiveAt: isoTimestamp(input.before.effectiveAt),
        receiptId: boundedText(input.before.receiptId, 128),
      }
    : null;
  const beforePredicate = before
    ? sql`AND (
        julianday(latest.effective_at) < julianday(${before.effectiveAt})
        OR (
          latest.effective_at = ${before.effectiveAt}
          AND latest.receipt_id < ${before.receiptId}
        )
      )`
    : sql``;
  const partitionPredicate = partitionKey
    ? sql`AND ${sourceEventIngestionMetadata.partitionKey} = ${partitionKey}`
    : sql``;
  const rows = await db.values<
    [
      string,
      string,
      string,
      string,
      string,
      string | null,
      string,
      string,
      string,
      string,
      string,
      string,
    ]
  >(sql`
    WITH versions AS (
      SELECT
        ${sourceEvents.id} AS receipt_id,
        ${sourceEvents.source} AS provider,
        ${sourceEvents.sourceKind} AS source_kind,
        ${sourceEvents.sourceEventId} AS source_event_id,
        ${sourceEvents.publishedAt} AS published_at,
        ${sourceEvents.observedAt} AS observed_at,
        ${sourceEventIngestionMetadata.providerRevisionAt} AS provider_revision_at,
        COALESCE(
          ${sourceEventIngestionMetadata.providerRevisionAt},
          ${sourceEvents.observedAt}
        ) AS effective_at,
        ${sourceEventIngestionMetadata.lastSeenAt} AS last_seen_at,
        ${sourceEventIngestionMetadata.payloadPolicy} AS payload_policy,
        ${sourceEvents.rawPayload} AS raw_payload,
        ROW_NUMBER() OVER (
          PARTITION BY ${sourceEvents.source}, ${sourceEvents.sourceEventId}
          ORDER BY
            julianday(COALESCE(
              ${sourceEventIngestionMetadata.providerRevisionAt},
              ${sourceEvents.observedAt}
            )) DESC,
            julianday(${sourceEventIngestionMetadata.lastSeenAt}) DESC,
            julianday(${sourceEventIngestionMetadata.firstSeenAt}) DESC,
            julianday(${sourceEvents.observedAt}) DESC,
            ${sourceEvents.id} DESC
        ) AS version_rank
      FROM ${sourceEventIngestionMetadata}
      INNER JOIN ${sourceEvents}
        ON ${sourceEvents.id} = ${sourceEventIngestionMetadata.sourceEventId}
      WHERE ${sourceEventIngestionMetadata.provider} = ${provider}
        ${partitionPredicate}
        AND julianday(COALESCE(
          ${sourceEventIngestionMetadata.providerRevisionAt},
          ${sourceEvents.observedAt}
        )) >= julianday(${since})
    ), latest AS (
      SELECT * FROM versions WHERE version_rank = 1
    )
    SELECT
      latest.receipt_id,
      latest.provider,
      latest.source_kind,
      latest.source_event_id,
      latest.published_at,
      latest.provider_revision_at,
      latest.observed_at,
      latest.effective_at,
      latest.last_seen_at,
      latest.payload_policy,
      latest.raw_payload,
      json_group_array(DISTINCT ${sourceEventSymbols.symbolId}) AS symbol_ids
    FROM latest
    INNER JOIN ${sourceEventSymbols}
      ON ${sourceEventSymbols.sourceEventId} = latest.receipt_id
    WHERE EXISTS (
      SELECT 1
      FROM ${sourceEventSymbols} AS requested_symbol
      WHERE requested_symbol.source_event_id = latest.receipt_id
        AND requested_symbol.symbol_id IN (
          SELECT value FROM json_each(${JSON.stringify(symbolIds)})
        )
    )
    ${beforePredicate}
    GROUP BY
      latest.receipt_id, latest.provider, latest.source_kind,
      latest.source_event_id, latest.published_at,
      latest.provider_revision_at, latest.observed_at, latest.effective_at,
      latest.last_seen_at, latest.payload_policy, latest.raw_payload
    ORDER BY latest.effective_at DESC, latest.receipt_id DESC
    LIMIT ${input.limit + 1}
  `);
  const hasMore = rows.length > input.limit;
  const selected = rows.slice(0, input.limit);
  const items = selected.map((row) => {
    let parsedSymbols: unknown;
    try {
      parsedSymbols = JSON.parse(row[11]) as unknown;
    } catch {
      throw new IngestionRepositoryError("conflict");
    }
    if (
      !Array.isArray(parsedSymbols) ||
      parsedSymbols.some((value) => typeof value !== "string")
    ) {
      throw new IngestionRepositoryError("conflict");
    }
    if (row[9] !== "minimal_redacted_v1") {
      throw new IngestionRepositoryError("conflict");
    }
    return {
      receiptId: row[0],
      provider: row[1],
      sourceKind: row[2],
      sourceEventId: row[3],
      publishedAt: row[4],
      providerRevisionAt: row[5],
      observedAt: row[6],
      effectiveAt: row[7],
      lastSeenAt: row[8],
      payloadPolicy: "minimal_redacted_v1" as const,
      envelope: collectedEnvelope(row[10]),
      symbolIds: parsedSymbols as CanonicalSymbol[],
    };
  });
  const last = items.at(-1);
  return {
    items,
    hasMore,
    nextBefore:
      hasMore && last
        ? { effectiveAt: last.effectiveAt, receiptId: last.receiptId }
        : null,
  };
}

async function getAggregateStatus(
  db: IngestionDatabase,
  input: GetIngestionStatusInput,
): Promise<IngestionAggregateStatus> {
  const now = isoTimestamp(input.now);
  const since = isoTimestamp(input.since);
  if (Date.parse(since) > Date.parse(now)) invalid();
  const provider = input.provider ? providerName(input.provider) : null;
  const partitionKey = input.partitionKey
    ? partitionName(input.partitionKey)
    : null;
  if (partitionKey !== null && provider === null) invalid();
  const providerFilter = provider ? sql`AND provider = ${provider}` : sql``;
  const partitionFilter = partitionKey
    ? sql`AND partition_key = ${partitionKey}`
    : sql``;
  const checkpoints = await db.values<
    [
      string,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      string | null,
      string | null,
      string | null,
    ]
  >(sql`
    SELECT
      provider,
      COUNT(*) AS partition_count,
      SUM(CASE WHEN julianday(next_due_at) <= julianday(${now}) THEN 1 ELSE 0 END) AS due_count,
      SUM(CASE WHEN lease_token IS NOT NULL AND julianday(lease_expires_at) > julianday(${now}) THEN 1 ELSE 0 END) AS leased_count,
      SUM(CASE WHEN window_fingerprint IS NOT NULL THEN 1 ELSE 0 END) AS resuming_count,
      SUM(CASE WHEN consecutive_failures > 0 THEN 1 ELSE 0 END) AS failing_count,
      SUM(total_successes) AS total_successes,
      SUM(total_failures) AS total_failures,
      MAX(last_attempt_at) AS last_attempt_at,
      MAX(last_success_at) AS last_success_at,
      MAX(last_failure_at) AS last_failure_at
    FROM ${providerIngestionCheckpoints}
    WHERE 1 = 1
    ${providerFilter}
    ${partitionFilter}
    GROUP BY provider
    ORDER BY provider
  `);
  const runProviderFilter = provider
    ? sql`AND provider = ${provider}`
    : sql``;
  const runPartitionFilter = partitionKey
    ? sql`AND partition_key = ${partitionKey}`
    : sql``;
  const runs = await db.values<
    [string, number, number, number, number, number]
  >(sql`
    SELECT
      provider,
      SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running_count,
      SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded_count,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      SUM(receipt_count) AS receipt_count,
      SUM(error_count) AS error_count
    FROM ${providerIngestionRuns}
    WHERE julianday(started_at) >= julianday(${since})
    ${runProviderFilter}
    ${runPartitionFilter}
    GROUP BY provider
  `);
  const evidenceProviderFilter = provider
    ? sql`AND ${sourceEventIngestionMetadata.provider} = ${provider}`
    : sql``;
  const evidencePartitionFilter = partitionKey
    ? sql`AND ${sourceEventIngestionMetadata.partitionKey} = ${partitionKey}`
    : sql``;
  const evidence = await db.values<[string, string | null]>(sql`
    SELECT
      ${sourceEventIngestionMetadata.provider},
      MAX(
        CASE
          WHEN ${sourceEventIngestionMetadata.providerRevisionAt} IS NOT NULL
            THEN ${sourceEventIngestionMetadata.providerRevisionAt}
          ELSE ${sourceEvents.observedAt}
        END
      ) AS latest_evidence_at
    FROM ${sourceEventIngestionMetadata}
    INNER JOIN ${sourceEvents}
      ON ${sourceEvents.id} = ${sourceEventIngestionMetadata.sourceEventId}
    WHERE 1 = 1
    ${evidenceProviderFilter}
    ${evidencePartitionFilter}
    GROUP BY ${sourceEventIngestionMetadata.provider}
  `);
  const runsByProvider = new Map(runs.map((row) => [row[0], row]));
  const evidenceByProvider = new Map(evidence);

  return {
    generatedAt: now,
    since,
    providers: checkpoints.map((row) => {
      const run = runsByProvider.get(row[0]);
      return {
        provider: row[0],
        partitionCount: Number(row[1] ?? 0),
        duePartitionCount: Number(row[2] ?? 0),
        leasedPartitionCount: Number(row[3] ?? 0),
        resumingPartitionCount: Number(row[4] ?? 0),
        failingPartitionCount: Number(row[5] ?? 0),
        totalSuccesses: Number(row[6] ?? 0),
        totalFailures: Number(row[7] ?? 0),
        lastAttemptAt: row[8],
        lastSuccessAt: row[9],
        lastFailureAt: row[10],
        latestEvidenceAt: evidenceByProvider.get(row[0]) ?? null,
        runs: {
          running: Number(run?.[1] ?? 0),
          succeeded: Number(run?.[2] ?? 0),
          failed: Number(run?.[3] ?? 0),
          receipts: Number(run?.[4] ?? 0),
          errors: Number(run?.[5] ?? 0),
        },
      };
    }),
  };
}

export function createIngestionRepository(
  databaseFactory: IngestionDatabaseFactory = getDb,
): IngestionRepository {
  return {
    ensureCheckpoint: (input) => ensureCheckpoint(databaseFactory(), input),
    claimNextDue: (input) => claimNextDue(databaseFactory(), input),
    startRun: (lease, startedAt) =>
      startRun(databaseFactory(), lease, startedAt),
    persistPage: (input) => persistPage(databaseFactory(), input),
    completeRun: (input) => completeRun(databaseFactory(), input),
    failRun: (input) => failRun(databaseFactory(), input),
    getAggregateStatus: (input) =>
      getAggregateStatus(databaseFactory(), input),
    listCollectedEvents: (input) =>
      listCollectedEvents(databaseFactory(), input),
  };
}

export const ingestionRepository = createIngestionRepository();
