import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { getDb } from "@/db";
import {
  alertDeliveries,
  alertRules,
  inboxEventStates,
  inboxEventSymbols,
  inboxEvents,
  inboxProfiles,
  inboxSyncGates,
  instruments,
  watchlistItems,
  watchlists,
} from "@/db/schema";
import type {
  AlertMinimumMateriality,
  AlertRuleMutation,
  AlertRuleMutationResponse,
  AlertRuleView,
  InboxFilter,
  InboxStateMutation,
  InboxStateMutationResponse,
  InboxSymbolSnapshot,
  InboxUserState,
  IntelligenceInboxCounts,
  IntelligenceInboxItem,
} from "@/lib/intelligence-inbox/contracts";
import type {
  CanonicalSymbol,
  CausalLink,
  ClaimStatus,
  IntelligenceEvent,
  Materiality,
} from "@/lib/market-types";
import type { IntelligenceFeedItem } from "@/lib/services/live-market-data";

type InboxDatabase = ReturnType<typeof getDb>;
type InboxDatabaseFactory = () => InboxDatabase;

export type InboxRepositoryErrorCode = "not_found" | "conflict";

export class InboxRepositoryError extends Error {
  constructor(readonly code: InboxRepositoryErrorCode) {
    super(code);
    this.name = "InboxRepositoryError";
  }
}

export interface InboxSyncResult {
  baselineApplied: boolean;
  hasMoreCandidates: boolean;
  newItemCount: number;
  newDeliveryCount: number;
}

export interface InboxSyncOptions {
  /** True only when the durable owner projection cursor has no remaining page. */
  globalCursorDrained: boolean;
}

export interface InboxReconciliationClaim {
  acquired: boolean;
  token: string | null;
  reason: "claimed" | "in_flight" | "throttled";
  catchupPending: boolean;
  nextAllowedAt: string;
  lastCompletedAt: string | null;
}

export interface InboxReconciliationCompletion {
  providerSucceeded: boolean;
  hasMoreCandidates: boolean;
}

export interface InboxListResult {
  items: IntelligenceInboxItem[];
  counts: IntelligenceInboxCounts;
}

export interface InboxStateUpdateResult {
  eventId: string;
  eventRevision: number;
  state: InboxUserState;
  replayed: boolean;
}

export interface AlertRuleUpdateResult {
  rule: AlertRuleView;
  replayed: boolean;
}

// D1's free plan permits 50 queries per Worker invocation. Request-time
// materialization leaves headroom for watchlist reads, counts, enrichments,
// rules, retries, and the final response while a scheduled batch pipeline is absent.
export const MAX_INBOX_ITEMS_PER_SYNC = 4;
export const INBOX_RECONCILIATION_INTERVAL_MS = 30_000;
export const INBOX_RECONCILIATION_FAILURE_INTERVAL_MS = 10_000;
export const INBOX_RECONCILIATION_CATCHUP_INTERVAL_MS = 2_000;
export const INBOX_RECONCILIATION_LEASE_MS = 30_000;

export interface IntelligenceInboxRepository {
  claimReconciliation(
    ownerId: string,
    requestedAt: string,
  ): Promise<InboxReconciliationClaim>;
  completeReconciliation(
    ownerId: string,
    token: string,
    completedAt: string,
    completion: InboxReconciliationCompletion,
  ): Promise<void>;
  syncLiveItems(
    ownerId: string,
    items: IntelligenceFeedItem[],
    syncedAt: string,
    options?: InboxSyncOptions,
  ): Promise<InboxSyncResult>;
  listInbox(
    ownerId: string,
    filter: InboxFilter,
    limit: number,
  ): Promise<InboxListResult>;
  getInboxItem(
    ownerId: string,
    eventId: string,
  ): Promise<IntelligenceInboxItem>;
  listRules(
    ownerId: string,
    trackedSymbols: InboxSymbolSnapshot[],
  ): Promise<AlertRuleView[]>;
  updateInboxState(
    ownerId: string,
    eventId: string,
    mutation: InboxStateMutation,
    updatedAt: string,
  ): Promise<InboxStateUpdateResult>;
  putAlertRule(
    ownerId: string,
    symbolId: CanonicalSymbol,
    mutation: AlertRuleMutation,
    updatedAt: string,
  ): Promise<AlertRuleUpdateResult>;
}

function parseTopicTags(value: string) {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function asCategory(value: string | null) {
  return value as IntelligenceEvent["category"] | null;
}

function asClaimStatus(value: string | null) {
  return value as ClaimStatus | null;
}

function asCausalLink(value: string | null) {
  return value as CausalLink | null;
}

function asMateriality(value: string) {
  return value as Materiality;
}

function asMinimumMateriality(value: string) {
  return value as AlertMinimumMateriality;
}

function sameRule(
  existing: {
    enabled: boolean;
    minimumMateriality: string;
    includeControversy: boolean;
  },
  mutation: AlertRuleMutation,
) {
  return (
    existing.enabled === mutation.enabled &&
    existing.minimumMateriality === mutation.minimum_materiality &&
    existing.includeControversy === mutation.include_controversy
  );
}

function stateView(
  row: {
    readAt: string | null;
    readRevision: number;
    savedAt: string | null;
    dismissedAt: string | null;
    firstSeenAt: string;
    lastSeenAt: string;
    version: number;
  },
  eventRevision: number,
): InboxUserState {
  return {
    read: row.readAt !== null,
    saved: row.savedAt !== null,
    dismissed: row.dismissedAt !== null,
    readRevision: row.readRevision,
    hasUpdate: eventRevision > 1 && eventRevision > row.readRevision,
    version: row.version,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
  };
}

function desiredStateAlreadyApplied(
  row: {
    readAt: string | null;
    readRevision: number;
    savedAt: string | null;
    dismissedAt: string | null;
  },
  eventRevision: number,
  mutation: InboxStateMutation,
) {
  const readApplied = mutation.read
    ? row.readAt !== null && row.readRevision === eventRevision
    : row.readAt === null && row.readRevision === 0;
  return (
    readApplied &&
    (row.savedAt !== null) === mutation.saved &&
    (row.dismissedAt !== null) === mutation.dismissed
  );
}

function ruleView(
  symbol: InboxSymbolSnapshot,
  row?: {
    enabled: boolean;
    minimumMateriality: string;
    includeControversy: boolean;
    channel: string;
    version: number;
    createdAt: string;
    updatedAt: string;
  },
): AlertRuleView {
  if (!row) {
    return {
      symbol,
      enabled: false,
      minimumMateriality: "high",
      includeControversy: false,
      channel: "in_app",
      version: 0,
      persisted: false,
      createdAt: null,
      updatedAt: null,
    };
  }

  return {
    symbol,
    enabled: row.enabled,
    minimumMateriality: asMinimumMateriality(row.minimumMateriality),
    includeControversy: row.includeControversy,
    channel: "in_app",
    version: row.version,
    persisted: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isAtOrAfter(candidate: string, effectiveAt: string) {
  const candidateTime = Date.parse(candidate);
  const effectiveTime = Date.parse(effectiveAt);
  return (
    Number.isFinite(candidateTime) &&
    Number.isFinite(effectiveTime) &&
    candidateTime >= effectiveTime
  );
}

function chunksOf<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export async function contentHashForInboxItem(item: IntelligenceFeedItem) {
  const stableContent = JSON.stringify({
    source: item.source,
    sourceKind: item.sourceKind,
    headline: item.headline,
    summary: item.summary,
    publishedAt: item.publishedAt,
    sourceUrl: item.sourceUrl,
    materiality: item.materiality,
    category: item.category ?? null,
    claimStatus: item.claimStatus ?? null,
    causalLink: item.causalLink ?? null,
    topicTags: [...(item.topicTags ?? [])].sort(),
    isControversial: item.isControversial === true,
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableContent),
  );
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function providerRevisionForInboxItem(item: IntelligenceFeedItem) {
  const value = item.providerUpdatedAt ?? item.publishedAt;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("invalid_provider_revision");
  }
  return new Date(timestamp).toISOString();
}

function receivedAtForInboxItem(item: IntelligenceFeedItem) {
  const timestamp = Date.parse(item.receivedAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error("invalid_provider_observation");
  }
  return new Date(timestamp).toISOString();
}

async function upsertInboxEvent(
  db: InboxDatabase,
  item: IntelligenceFeedItem,
  syncedAt: string,
  knownContentHash?: string,
  knownProviderRevisionAt?: string,
  knownReceivedAt?: string,
) {
  const contentHash =
    knownContentHash ?? (await contentHashForInboxItem(item));
  const providerRevisionAt =
    knownProviderRevisionAt ?? providerRevisionForInboxItem(item);
  const receivedAt = knownReceivedAt ?? receivedAtForInboxItem(item);
  let existing = (
    await db
      .select()
      .from(inboxEvents)
      .where(eq(inboxEvents.id, item.id))
      .limit(1)
  )[0];

  let created = false;
  let revisionChanged = false;
  let acceptedVersion = false;
  if (!existing) {
    const inserted = await db
      .insert(inboxEvents)
      .values({
        id: item.id,
        source: item.source,
        providerEventKey: item.id,
        sourceKind: item.sourceKind,
        headline: item.headline,
        summary: item.summary,
        publishedAt: item.publishedAt,
        receivedAt,
        providerRevisionAt,
        sourceUrl: item.sourceUrl,
        materiality: item.materiality,
        category: item.category ?? null,
        claimStatus: item.claimStatus ?? null,
        causalLink: item.causalLink ?? null,
        topicTagsJson: JSON.stringify(item.topicTags ?? []),
        isControversial: item.isControversial === true,
        contentHash,
        revision: 1,
        createdAt: syncedAt,
        updatedAt: syncedAt,
      })
      .onConflictDoNothing()
      .returning();
    existing =
      inserted[0] ??
      (
        await db
          .select()
          .from(inboxEvents)
          .where(eq(inboxEvents.id, item.id))
          .limit(1)
      )[0];
    created = Boolean(inserted[0]);
    acceptedVersion = created;
  }

  if (!existing) throw new Error("inbox_event_upsert_failed");
  if (existing.source !== item.source || existing.providerEventKey !== item.id) {
    throw new Error("inbox_event_identity_collision");
  }

  for (let attempt = 0; !created && attempt < 3; attempt += 1) {
    const incomingRevisionTime = Date.parse(providerRevisionAt);
    const storedRevisionTime = Date.parse(existing.providerRevisionAt);
    const incomingObservationTime = Date.parse(receivedAt);
    const storedObservationTime = Date.parse(existing.receivedAt);
    if (
      !Number.isFinite(incomingRevisionTime) ||
      !Number.isFinite(storedRevisionTime) ||
      !Number.isFinite(incomingObservationTime) ||
      !Number.isFinite(storedObservationTime)
    ) {
      throw new Error("invalid_inbox_event_clock");
    }
    if (
      incomingRevisionTime < storedRevisionTime ||
      (incomingRevisionTime === storedRevisionTime &&
        incomingObservationTime <= storedObservationTime)
    ) {
      break;
    }

    const contentChanged = existing.contentHash !== contentHash;
    const updated = await db
      .update(inboxEvents)
      .set(
        contentChanged
          ? {
              sourceKind: item.sourceKind,
              headline: item.headline,
              summary: item.summary,
              publishedAt: item.publishedAt,
              receivedAt,
              providerRevisionAt,
              sourceUrl: item.sourceUrl,
              materiality: item.materiality,
              category: item.category ?? null,
              claimStatus: item.claimStatus ?? null,
              causalLink: item.causalLink ?? null,
              topicTagsJson: JSON.stringify(item.topicTags ?? []),
              isControversial: item.isControversial === true,
              contentHash,
              revision: existing.revision + 1,
              updatedAt: syncedAt,
            }
          : { providerRevisionAt, receivedAt },
      )
      .where(
        and(
          eq(inboxEvents.id, item.id),
          eq(inboxEvents.contentHash, existing.contentHash),
          eq(inboxEvents.providerRevisionAt, existing.providerRevisionAt),
          eq(inboxEvents.receivedAt, existing.receivedAt),
        ),
      )
      .returning();
    if (updated[0]) {
      existing = updated[0];
      revisionChanged = contentChanged;
      acceptedVersion = true;
      break;
    }

    existing = (
      await db
        .select()
        .from(inboxEvents)
        .where(eq(inboxEvents.id, item.id))
        .limit(1)
    )[0];
    if (!existing) throw new Error("inbox_event_update_failed");
    if (existing.source !== item.source || existing.providerEventKey !== item.id) {
      throw new Error("inbox_event_identity_collision");
    }
  }

  // Provider queries are owner-scoped and can expose only a subset of an event's
  // symbols. Build the global mapping monotonically so one owner's projection
  // never erases another owner's canonical symbol association.
  const sameCurrentReceipt =
    providerRevisionAt === existing.providerRevisionAt &&
    contentHash === existing.contentHash &&
    Date.parse(receivedAt) >= Date.parse(existing.receivedAt);
  if ((acceptedVersion || sameCurrentReceipt) && item.symbolIds.length > 0) {
    await db.run(sql`
      INSERT INTO ${inboxEventSymbols} (event_id, symbol_id)
      SELECT ${item.id}, value
      FROM json_each(${JSON.stringify([...new Set(item.symbolIds)])})
      WHERE 1 = 1
      ON CONFLICT (event_id, symbol_id) DO NOTHING
    `);
  }

  return { event: existing, created, revisionChanged, acceptedVersion };
}

function shiftedIso(value: string, deltaMs: number) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("invalid_sync_timestamp");
  return new Date(timestamp + deltaMs).toISOString();
}

async function claimReconciliation(
  db: InboxDatabase,
  ownerId: string,
  requestedAt: string,
): Promise<InboxReconciliationClaim> {
  const claimToken = crypto.randomUUID();
  const claimUntil = shiftedIso(requestedAt, INBOX_RECONCILIATION_LEASE_MS);
  const inserted = await db
    .insert(inboxSyncGates)
    .values({
      ownerId,
      claimToken,
      claimUntil,
      nextAllowedAt: requestedAt,
      catchupPending: false,
      lastAttemptAt: requestedAt,
      lastCompletedAt: null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) {
    return {
      acquired: true,
      token: claimToken,
      reason: "claimed",
      catchupPending: false,
      nextAllowedAt: requestedAt,
      lastCompletedAt: null,
    };
  }

  const claimed = await db
    .update(inboxSyncGates)
    .set({
      claimToken,
      claimUntil,
      lastAttemptAt: requestedAt,
    })
    .where(
      and(
        eq(inboxSyncGates.ownerId, ownerId),
        sql`julianday(${inboxSyncGates.nextAllowedAt}) <= julianday(${requestedAt})`,
        sql`(${inboxSyncGates.claimToken} IS NULL OR julianday(${inboxSyncGates.claimUntil}) <= julianday(${requestedAt}))`,
      ),
    )
    .returning();
  if (claimed[0]) {
    return {
      acquired: true,
      token: claimToken,
      reason: "claimed",
      catchupPending: claimed[0].catchupPending,
      nextAllowedAt: claimed[0].nextAllowedAt,
      lastCompletedAt: claimed[0].lastCompletedAt,
    };
  }

  const gate = (
    await db
      .select()
      .from(inboxSyncGates)
      .where(eq(inboxSyncGates.ownerId, ownerId))
      .limit(1)
  )[0];
  if (!gate) throw new Error("inbox_sync_gate_missing");
  const claimExpiresAt = gate.claimUntil ? Date.parse(gate.claimUntil) : NaN;
  const requestedTime = Date.parse(requestedAt);
  const inFlight =
    gate.claimToken !== null &&
    Number.isFinite(claimExpiresAt) &&
    Number.isFinite(requestedTime) &&
    claimExpiresAt > requestedTime;
  return {
    acquired: false,
    token: null,
    reason: inFlight ? "in_flight" : "throttled",
    catchupPending: gate.catchupPending,
    nextAllowedAt: gate.nextAllowedAt,
    lastCompletedAt: gate.lastCompletedAt,
  };
}

async function completeReconciliation(
  db: InboxDatabase,
  ownerId: string,
  token: string,
  completedAt: string,
  completion: InboxReconciliationCompletion,
) {
  const delayMs = completion.hasMoreCandidates
    ? INBOX_RECONCILIATION_CATCHUP_INTERVAL_MS
    : completion.providerSucceeded
      ? INBOX_RECONCILIATION_INTERVAL_MS
      : INBOX_RECONCILIATION_FAILURE_INTERVAL_MS;
  await db
    .update(inboxSyncGates)
    .set({
      claimToken: null,
      claimUntil: null,
      nextAllowedAt: shiftedIso(completedAt, delayMs),
      catchupPending: completion.hasMoreCandidates,
      lastCompletedAt: completedAt,
    })
    .where(
      and(
        eq(inboxSyncGates.ownerId, ownerId),
        eq(inboxSyncGates.claimToken, token),
      ),
    );
}

async function syncLiveItems(
  db: InboxDatabase,
  ownerId: string,
  items: IntelligenceFeedItem[],
  syncedAt: string,
  options: InboxSyncOptions = { globalCursorDrained: true },
): Promise<InboxSyncResult> {
  let profile = (
    await db
      .select({
        ownerId: inboxProfiles.ownerId,
        activatedAt: inboxProfiles.activatedAt,
        baselineCompletedAt: inboxProfiles.baselineCompletedAt,
      })
      .from(inboxProfiles)
      .where(eq(inboxProfiles.ownerId, ownerId))
      .limit(1)
  )[0];
  let baselineApplied = false;
  if (!profile) {
    const inserted = await db
      .insert(inboxProfiles)
      .values({
        ownerId,
        activatedAt: syncedAt,
        baselineCompletedAt: null,
        lastCheckedAt: syncedAt,
        lastSuccessfulSyncAt: syncedAt,
      })
      .onConflictDoNothing()
      .returning({
        ownerId: inboxProfiles.ownerId,
        activatedAt: inboxProfiles.activatedAt,
        baselineCompletedAt: inboxProfiles.baselineCompletedAt,
      });
    baselineApplied = Boolean(inserted[0]);
    profile =
      inserted[0] ??
      (
        await db
          .select({
            ownerId: inboxProfiles.ownerId,
            activatedAt: inboxProfiles.activatedAt,
            baselineCompletedAt: inboxProfiles.baselineCompletedAt,
          })
          .from(inboxProfiles)
          .where(eq(inboxProfiles.ownerId, ownerId))
          .limit(1)
      )[0];
  }
  if (!profile) throw new Error("inbox_profile_activation_failed");

  const baselineInProgress = profile.baselineCompletedAt === null;
  const activationCutoff = profile.activatedAt;
  let newItemCount = 0;
  let newDeliveryCount = 0;
  const eligibleItems = [
    ...new Map(
      items
        .filter(
          (item) =>
            item.isLive &&
            item.sourceKind !== "demo_fixture" &&
            item.symbolIds.length > 0,
        )
        .map((item) => [item.id, item]),
    ).values(),
  ];
  const preparedItems = await Promise.all(
    eligibleItems.map(async (item) => {
      const receivedAt = receivedAtForInboxItem(item);
      return {
        item: { ...item, receivedAt },
        contentHash: await contentHashForInboxItem(item),
        providerRevisionAt: providerRevisionForInboxItem(item),
        receivedAt,
      };
    }),
  );
  const preparedById = new Map(
    preparedItems.map((prepared) => [prepared.item.id, prepared]),
  );
  const candidateRows =
    preparedItems.length === 0
      ? []
      : await db.values<[string]>(sql`
          WITH incoming AS (
            SELECT
              json_extract(value, '$.id') AS id,
              json_extract(value, '$.contentHash') AS content_hash,
              json_extract(value, '$.providerRevisionAt') AS provider_revision_at,
              json_extract(value, '$.receivedAt') AS received_at,
              json_extract(value, '$.symbolIds') AS symbol_ids_json,
              json_extract(value, '$.publishedAt') AS published_at
            FROM json_each(${JSON.stringify(
              preparedItems.map(
                ({ item, contentHash, providerRevisionAt, receivedAt }) => ({
                  id: item.id,
                  contentHash,
                  providerRevisionAt,
                  receivedAt,
                  symbolIds: item.symbolIds,
                  publishedAt: item.publishedAt,
                }),
              ),
            )})
          )
          SELECT incoming.id
          FROM incoming
          LEFT JOIN ${inboxEvents}
            ON ${inboxEvents.id} = incoming.id
          LEFT JOIN ${inboxEventStates}
            ON ${inboxEventStates.ownerId} = ${ownerId}
            AND ${inboxEventStates.eventId} = incoming.id
          WHERE ${inboxEvents.id} IS NULL
            OR ${inboxEventStates.eventId} IS NULL
            OR julianday(incoming.provider_revision_at) >
              julianday(${inboxEvents.providerRevisionAt})
            OR (
              julianday(incoming.provider_revision_at) =
                julianday(${inboxEvents.providerRevisionAt})
              AND (
                (
                  julianday(incoming.received_at) >
                    julianday(${inboxEvents.receivedAt})
                  AND incoming.content_hash <> ${inboxEvents.contentHash}
                )
                OR (
                  julianday(incoming.received_at) >=
                    julianday(${inboxEvents.receivedAt})
                  AND incoming.content_hash = ${inboxEvents.contentHash}
                  AND EXISTS (
                    SELECT 1
                    FROM json_each(incoming.symbol_ids_json) AS incoming_symbol
                    WHERE NOT EXISTS (
                      SELECT 1
                      FROM ${inboxEventSymbols}
                      WHERE ${inboxEventSymbols.eventId} = incoming.id
                        AND ${inboxEventSymbols.symbolId} = incoming_symbol.value
                    )
                  )
                )
              )
            )
            OR ${inboxEvents.updatedAt} > ${inboxEventStates.lastSeenAt}
          ORDER BY
            CASE WHEN ${inboxEvents.id} IS NOT NULL AND (
              julianday(incoming.provider_revision_at) >
                julianday(${inboxEvents.providerRevisionAt})
              OR (
                julianday(incoming.provider_revision_at) =
                  julianday(${inboxEvents.providerRevisionAt})
                AND (
                  (
                    julianday(incoming.received_at) >
                      julianday(${inboxEvents.receivedAt})
                    AND incoming.content_hash <> ${inboxEvents.contentHash}
                  )
                  OR (
                    julianday(incoming.received_at) >=
                      julianday(${inboxEvents.receivedAt})
                    AND incoming.content_hash = ${inboxEvents.contentHash}
                    AND EXISTS (
                      SELECT 1
                      FROM json_each(incoming.symbol_ids_json) AS incoming_symbol
                      WHERE NOT EXISTS (
                        SELECT 1
                        FROM ${inboxEventSymbols}
                        WHERE ${inboxEventSymbols.eventId} = incoming.id
                          AND ${inboxEventSymbols.symbolId} = incoming_symbol.value
                      )
                    )
                  )
                )
              )
              OR (${inboxEventStates.eventId} IS NOT NULL
                AND ${inboxEvents.updatedAt} > ${inboxEventStates.lastSeenAt})
            ) THEN 0
            WHEN ${baselineInProgress ? 1 : 0} = 1
              AND julianday(incoming.published_at) <= julianday(${activationCutoff})
            THEN 1
            ELSE 2 END,
            incoming.published_at DESC,
            incoming.id ASC
          LIMIT ${MAX_INBOX_ITEMS_PER_SYNC + 1}
        `);
  const hasMoreCandidates = candidateRows.length > MAX_INBOX_ITEMS_PER_SYNC;
  const syncCandidates = candidateRows
    .slice(0, MAX_INBOX_ITEMS_PER_SYNC)
    .map(([eventId]) => preparedById.get(eventId))
    .filter(
      (prepared): prepared is (typeof preparedItems)[number] =>
        prepared !== undefined,
    );

  for (const {
    item,
    contentHash,
    providerRevisionAt,
    receivedAt,
  } of syncCandidates) {
    const { event } = await upsertInboxEvent(
      db,
      item,
      syncedAt,
      contentHash,
      providerRevisionAt,
      receivedAt,
    );
    const effectiveEventTime = event.providerRevisionAt;
    const preActivationEvent =
      Number.isFinite(Date.parse(effectiveEventTime)) &&
      Date.parse(effectiveEventTime) <= Date.parse(activationCutoff);
    const insertedState = await db
      .insert(inboxEventStates)
      .values({
        ownerId,
        eventId: event.id,
        readAt: preActivationEvent ? syncedAt : null,
        readRevision: preActivationEvent ? event.revision : 0,
        savedAt: null,
        dismissedAt: null,
        firstSeenAt: syncedAt,
        lastSeenAt: preActivationEvent ? syncedAt : "1970-01-01T00:00:00.000Z",
        version: 1,
      })
      .onConflictDoNothing()
      .returning();
    const stateCreated = Boolean(insertedState[0]);
    if (stateCreated) newItemCount += 1;
    if (!stateCreated && preActivationEvent) {
      await db
        .update(inboxEventStates)
        .set({
          readAt: syncedAt,
          readRevision: event.revision,
          lastSeenAt: syncedAt,
        })
        .where(
          and(
            eq(inboxEventStates.ownerId, ownerId),
            eq(inboxEventStates.eventId, event.id),
          ),
        );
    }

    if (!preActivationEvent) {
      if (isAtOrAfter(effectiveEventTime, "1970-01-01T00:00:00.000Z")) {
        const insertedDeliveries = await db.values<[string]>(sql`
      INSERT INTO ${alertDeliveries} (
        owner_id,
        rule_symbol_id,
        event_id,
        event_revision,
        channel,
        delivered_at
      )
      SELECT
        ${ownerId},
        ${alertRules.symbolId},
        ${event.id},
        ${event.revision},
        'in_app',
        ${syncedAt}
      FROM ${alertRules}
      INNER JOIN ${inboxEventSymbols}
        ON ${inboxEventSymbols.symbolId} = ${alertRules.symbolId}
      -- upsertInboxEvent may reject a stale owner projection and return a newer
      -- global revision. Evaluate that revision's complete monotonic symbol map,
      -- never the stale incoming item's narrower symbol subset.
      WHERE ${alertRules.ownerId} = ${ownerId}
        AND ${alertRules.enabled} = 1
        AND ${inboxEventSymbols.eventId} = ${event.id}
        AND EXISTS (
          SELECT 1
          FROM ${watchlistItems}
          INNER JOIN ${watchlists}
            ON ${watchlists.id} = ${watchlistItems.watchlistId}
          WHERE ${watchlists.ownerId} = ${ownerId}
            AND ${watchlistItems.symbolId} = ${alertRules.symbolId}
            AND julianday(${watchlistItems.addedAt}) <= julianday(${effectiveEventTime})
        )
        AND julianday(${alertRules.updatedAt}) <= julianday(${effectiveEventTime})
        AND (
          CASE ${event.materiality}
            WHEN 'low' THEN 0
            WHEN 'medium' THEN 1
            WHEN 'high' THEN 2
            WHEN 'critical' THEN 3
          END >= CASE ${alertRules.minimumMateriality}
            WHEN 'medium' THEN 1
            WHEN 'high' THEN 2
            WHEN 'critical' THEN 3
          END
          OR (${event.isControversial ? 1 : 0} = 1
            AND ${alertRules.includeControversy} = 1)
        )
      ON CONFLICT (
        owner_id,
        rule_symbol_id,
        event_id,
        event_revision
      ) DO NOTHING
      RETURNING event_id
    `);
        newDeliveryCount += insertedDeliveries.length;
      }
    }

    if (!stateCreated || !preActivationEvent) {
      await db
        .update(inboxEventStates)
        .set({ lastSeenAt: syncedAt })
        .where(
          and(
            eq(inboxEventStates.ownerId, ownerId),
            eq(inboxEventStates.eventId, event.id),
          ),
        );
    }
  }

  const baselineFinished =
    baselineInProgress &&
    !hasMoreCandidates &&
    options.globalCursorDrained;
  await db
    .update(inboxProfiles)
    .set({
      lastCheckedAt: syncedAt,
      lastSuccessfulSyncAt: syncedAt,
      ...(baselineFinished ? { baselineCompletedAt: syncedAt } : {}),
    })
    .where(eq(inboxProfiles.ownerId, ownerId));

  return {
    baselineApplied,
    hasMoreCandidates,
    newItemCount,
    newDeliveryCount,
  };
}

async function listInbox(
  db: InboxDatabase,
  ownerId: string,
  filter: InboxFilter,
  limit: number,
): Promise<InboxListResult> {
  const hasDelivery = sql<boolean>`EXISTS (
    SELECT 1 FROM ${alertDeliveries}
    WHERE ${alertDeliveries.ownerId} = ${ownerId}
      AND ${alertDeliveries.eventId} = ${inboxEventStates.eventId}
  )`;
  const filterCondition =
    filter === "unread"
      ? and(
          isNull(inboxEventStates.dismissedAt),
          or(
            isNull(inboxEventStates.readAt),
            sql`${inboxEvents.revision} > ${inboxEventStates.readRevision}`,
          ),
        )
      : filter === "saved"
        ? isNotNull(inboxEventStates.savedAt)
        : filter === "alerts"
          ? and(isNull(inboxEventStates.dismissedAt), hasDelivery)
          : isNull(inboxEventStates.dismissedAt);
  const rows = await db
    .select({
      eventId: inboxEvents.id,
      eventRevision: inboxEvents.revision,
      source: inboxEvents.source,
      sourceKind: inboxEvents.sourceKind,
      headline: inboxEvents.headline,
      summary: inboxEvents.summary,
      publishedAt: inboxEvents.publishedAt,
      receivedAt: inboxEvents.receivedAt,
      providerRevisionAt: inboxEvents.providerRevisionAt,
      sourceUrl: inboxEvents.sourceUrl,
      materiality: inboxEvents.materiality,
      category: inboxEvents.category,
      claimStatus: inboxEvents.claimStatus,
      causalLink: inboxEvents.causalLink,
      topicTagsJson: inboxEvents.topicTagsJson,
      isControversial: inboxEvents.isControversial,
      readAt: inboxEventStates.readAt,
      readRevision: inboxEventStates.readRevision,
      savedAt: inboxEventStates.savedAt,
      dismissedAt: inboxEventStates.dismissedAt,
      firstSeenAt: inboxEventStates.firstSeenAt,
      lastSeenAt: inboxEventStates.lastSeenAt,
      stateVersion: inboxEventStates.version,
    })
    .from(inboxEventStates)
    .innerJoin(inboxEvents, eq(inboxEvents.id, inboxEventStates.eventId))
    .where(and(eq(inboxEventStates.ownerId, ownerId), filterCondition))
    .orderBy(desc(inboxEvents.publishedAt), desc(inboxEvents.id))
    .limit(limit);

  const countRows = await db
    .select({
      all: sql<number>`COALESCE(SUM(CASE
        WHEN ${inboxEventStates.dismissedAt} IS NULL THEN 1 ELSE 0 END), 0)`,
      unread: sql<number>`COALESCE(SUM(CASE
        WHEN ${inboxEventStates.dismissedAt} IS NULL
          AND (${inboxEventStates.readAt} IS NULL
            OR ${inboxEvents.revision} > ${inboxEventStates.readRevision})
        THEN 1 ELSE 0 END), 0)`,
      saved: sql<number>`COALESCE(SUM(CASE
        WHEN ${inboxEventStates.savedAt} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
      alerts: sql<number>`COALESCE(SUM(CASE
        WHEN ${inboxEventStates.dismissedAt} IS NULL AND EXISTS (
          SELECT 1 FROM ${alertDeliveries}
          WHERE ${alertDeliveries.ownerId} = ${ownerId}
            AND ${alertDeliveries.eventId} = ${inboxEventStates.eventId}
        ) THEN 1 ELSE 0 END), 0)`,
    })
    .from(inboxEventStates)
    .innerJoin(inboxEvents, eq(inboxEvents.id, inboxEventStates.eventId))
    .where(eq(inboxEventStates.ownerId, ownerId));

  const eventIds = rows.map((row) => row.eventId);
  const eventIdChunks = chunksOf(eventIds, 90);
  const symbolRows = (
    await Promise.all(
      eventIdChunks.map((eventIdChunk) =>
        db
          .select({
            eventId: inboxEventSymbols.eventId,
            id: instruments.id,
            ticker: instruments.ticker,
            exchange: instruments.exchange,
            name: instruments.name,
          })
          .from(inboxEventSymbols)
          .innerJoin(instruments, eq(instruments.id, inboxEventSymbols.symbolId))
          .where(inArray(inboxEventSymbols.eventId, eventIdChunk)),
      ),
    )
  ).flat();
  const deliveryRows = (
    await Promise.all(
      eventIdChunks.map((eventIdChunk) =>
        db
          .select({
            eventId: alertDeliveries.eventId,
            ruleSymbolId: alertDeliveries.ruleSymbolId,
            deliveredAt: alertDeliveries.deliveredAt,
          })
          .from(alertDeliveries)
          .where(
            and(
              eq(alertDeliveries.ownerId, ownerId),
              inArray(alertDeliveries.eventId, eventIdChunk),
            ),
          ),
      ),
    )
  ).flat();

  const allItems: IntelligenceInboxItem[] = rows.map((row) => {
    const deliveries = deliveryRows.filter(
      (delivery) => delivery.eventId === row.eventId,
    );
    const state = stateView(
      {
        readAt: row.readAt,
        readRevision: row.readRevision,
        savedAt: row.savedAt,
        dismissedAt: row.dismissedAt,
        firstSeenAt: row.firstSeenAt,
        lastSeenAt: row.lastSeenAt,
        version: row.stateVersion,
      },
      row.eventRevision,
    );
    return {
      event: {
        eventId: row.eventId,
        eventRevision: row.eventRevision,
        symbols: symbolRows
          .filter((symbol) => symbol.eventId === row.eventId)
          .map((symbol) => ({
            id: symbol.id as CanonicalSymbol,
            ticker: symbol.ticker,
            exchange: symbol.exchange,
            name: symbol.name,
          })),
        source: {
          name: row.source,
          kind: row.sourceKind,
          url: row.sourceUrl,
        },
        headline: row.headline,
        summary: row.summary,
        materiality: asMateriality(row.materiality),
        category: asCategory(row.category),
        claimStatus: asClaimStatus(row.claimStatus),
        causalLink: asCausalLink(row.causalLink),
        topicTags: parseTopicTags(row.topicTagsJson),
        isControversial: row.isControversial,
        publishedAt: row.publishedAt,
        receivedAt: row.receivedAt,
        providerUpdatedAt: row.providerRevisionAt,
      },
      state,
      alert: {
        triggered: deliveries.length > 0,
        deliveryCount: deliveries.length,
        lastDeliveredAt:
          deliveries
            .map((delivery) => delivery.deliveredAt)
            .sort()
            .at(-1) ?? null,
        matchedRuleSymbols: [
          ...new Set(
            deliveries.map(
              (delivery) => delivery.ruleSymbolId as CanonicalSymbol,
            ),
          ),
        ],
      },
    };
  });

  const countRow = countRows[0];
  const counts = {
    all: Number(countRow?.all ?? 0),
    unread: Number(countRow?.unread ?? 0),
    saved: Number(countRow?.saved ?? 0),
    alerts: Number(countRow?.alerts ?? 0),
  };

  return { items: allItems, counts };
}

async function getInboxItem(
  db: InboxDatabase,
  ownerId: string,
  eventId: string,
): Promise<IntelligenceInboxItem> {
  const row = (
    await db
      .select({
        eventId: inboxEvents.id,
        eventRevision: inboxEvents.revision,
        source: inboxEvents.source,
        sourceKind: inboxEvents.sourceKind,
        headline: inboxEvents.headline,
        summary: inboxEvents.summary,
        publishedAt: inboxEvents.publishedAt,
        receivedAt: inboxEvents.receivedAt,
        providerRevisionAt: inboxEvents.providerRevisionAt,
        sourceUrl: inboxEvents.sourceUrl,
        materiality: inboxEvents.materiality,
        category: inboxEvents.category,
        claimStatus: inboxEvents.claimStatus,
        causalLink: inboxEvents.causalLink,
        topicTagsJson: inboxEvents.topicTagsJson,
        isControversial: inboxEvents.isControversial,
        readAt: inboxEventStates.readAt,
        readRevision: inboxEventStates.readRevision,
        savedAt: inboxEventStates.savedAt,
        dismissedAt: inboxEventStates.dismissedAt,
        firstSeenAt: inboxEventStates.firstSeenAt,
        lastSeenAt: inboxEventStates.lastSeenAt,
        stateVersion: inboxEventStates.version,
      })
      .from(inboxEventStates)
      .innerJoin(inboxEvents, eq(inboxEvents.id, inboxEventStates.eventId))
      .where(
        and(
          eq(inboxEventStates.ownerId, ownerId),
          eq(inboxEventStates.eventId, eventId),
        ),
      )
      .limit(1)
  )[0];
  if (!row) throw new InboxRepositoryError("not_found");

  const [symbolRows, deliveryRows] = await Promise.all([
    db
      .select({
        id: instruments.id,
        ticker: instruments.ticker,
        exchange: instruments.exchange,
        name: instruments.name,
      })
      .from(inboxEventSymbols)
      .innerJoin(instruments, eq(instruments.id, inboxEventSymbols.symbolId))
      .where(eq(inboxEventSymbols.eventId, eventId)),
    db
      .select({
        ruleSymbolId: alertDeliveries.ruleSymbolId,
        deliveredAt: alertDeliveries.deliveredAt,
      })
      .from(alertDeliveries)
      .where(
        and(
          eq(alertDeliveries.ownerId, ownerId),
          eq(alertDeliveries.eventId, eventId),
        ),
      ),
  ]);
  const state = stateView(
    {
      readAt: row.readAt,
      readRevision: row.readRevision,
      savedAt: row.savedAt,
      dismissedAt: row.dismissedAt,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      version: row.stateVersion,
    },
    row.eventRevision,
  );

  return {
    event: {
      eventId: row.eventId,
      eventRevision: row.eventRevision,
      symbols: symbolRows.map((symbol) => ({
        id: symbol.id as CanonicalSymbol,
        ticker: symbol.ticker,
        exchange: symbol.exchange,
        name: symbol.name,
      })),
      source: {
        name: row.source,
        kind: row.sourceKind,
        url: row.sourceUrl,
      },
      headline: row.headline,
      summary: row.summary,
      materiality: asMateriality(row.materiality),
      category: asCategory(row.category),
      claimStatus: asClaimStatus(row.claimStatus),
      causalLink: asCausalLink(row.causalLink),
      topicTags: parseTopicTags(row.topicTagsJson),
      isControversial: row.isControversial,
      publishedAt: row.publishedAt,
      receivedAt: row.receivedAt,
      providerUpdatedAt: row.providerRevisionAt,
    },
    state,
    alert: {
      triggered: deliveryRows.length > 0,
      deliveryCount: deliveryRows.length,
      lastDeliveredAt:
        deliveryRows
          .map((delivery) => delivery.deliveredAt)
          .sort()
          .at(-1) ?? null,
      matchedRuleSymbols: [
        ...new Set(
          deliveryRows.map(
            (delivery) => delivery.ruleSymbolId as CanonicalSymbol,
          ),
        ),
      ],
    },
  };
}

async function listRules(
  db: InboxDatabase,
  ownerId: string,
  trackedSymbols: InboxSymbolSnapshot[],
) {
  if (trackedSymbols.length === 0) return [];
  const rows = await db
    .select()
    .from(alertRules)
    .where(eq(alertRules.ownerId, ownerId));
  const bySymbol = new Map(rows.map((row) => [row.symbolId, row]));
  return trackedSymbols.map((symbol) => ruleView(symbol, bySymbol.get(symbol.id)));
}

async function readStateRow(
  db: InboxDatabase,
  ownerId: string,
  eventId: string,
) {
  return (
    await db
      .select({
        eventRevision: inboxEvents.revision,
        readAt: inboxEventStates.readAt,
        readRevision: inboxEventStates.readRevision,
        savedAt: inboxEventStates.savedAt,
        dismissedAt: inboxEventStates.dismissedAt,
        firstSeenAt: inboxEventStates.firstSeenAt,
        lastSeenAt: inboxEventStates.lastSeenAt,
        version: inboxEventStates.version,
      })
      .from(inboxEventStates)
      .innerJoin(inboxEvents, eq(inboxEvents.id, inboxEventStates.eventId))
      .where(
        and(
          eq(inboxEventStates.ownerId, ownerId),
          eq(inboxEventStates.eventId, eventId),
        ),
      )
      .limit(1)
  )[0];
}

async function updateInboxState(
  db: InboxDatabase,
  ownerId: string,
  eventId: string,
  mutation: InboxStateMutation,
  updatedAt: string,
): Promise<InboxStateUpdateResult> {
  const existing = await readStateRow(db, ownerId, eventId);
  if (!existing) throw new InboxRepositoryError("not_found");
  if (desiredStateAlreadyApplied(existing, existing.eventRevision, mutation)) {
    return {
      eventId,
      eventRevision: existing.eventRevision,
      state: stateView(existing, existing.eventRevision),
      replayed: true,
    };
  }
  if (
    existing.version !== mutation.expected_version ||
    existing.eventRevision !== mutation.expected_event_revision
  ) {
    throw new InboxRepositoryError("conflict");
  }

  const updated = await db
    .update(inboxEventStates)
    .set({
      readAt: mutation.read ? updatedAt : null,
      readRevision: mutation.read ? existing.eventRevision : 0,
      savedAt: mutation.saved ? existing.savedAt ?? updatedAt : null,
      dismissedAt: mutation.dismissed ? existing.dismissedAt ?? updatedAt : null,
      version: existing.version + 1,
    })
    .where(
      and(
        eq(inboxEventStates.ownerId, ownerId),
        eq(inboxEventStates.eventId, eventId),
        eq(inboxEventStates.version, mutation.expected_version),
        sql`EXISTS (
          SELECT 1 FROM ${inboxEvents}
          WHERE ${inboxEvents.id} = ${eventId}
            AND ${inboxEvents.revision} = ${mutation.expected_event_revision}
        )`,
      ),
    )
    .returning();
  if (updated[0]) {
    return {
      eventId,
      eventRevision: existing.eventRevision,
      state: stateView(updated[0], existing.eventRevision),
      replayed: false,
    };
  }

  const winner = await readStateRow(db, ownerId, eventId);
  if (!winner) throw new InboxRepositoryError("not_found");
  if (desiredStateAlreadyApplied(winner, winner.eventRevision, mutation)) {
    return {
      eventId,
      eventRevision: winner.eventRevision,
      state: stateView(winner, winner.eventRevision),
      replayed: true,
    };
  }
  throw new InboxRepositoryError("conflict");
}

async function findTrackedSymbol(
  db: InboxDatabase,
  ownerId: string,
  symbolId: CanonicalSymbol,
) {
  const row = (
    await db
      .select({
        id: instruments.id,
        ticker: instruments.ticker,
        exchange: instruments.exchange,
        name: instruments.name,
      })
      .from(instruments)
      .innerJoin(watchlistItems, eq(watchlistItems.symbolId, instruments.id))
      .innerJoin(watchlists, eq(watchlists.id, watchlistItems.watchlistId))
      .where(
        and(
          eq(watchlists.ownerId, ownerId),
          eq(instruments.id, symbolId),
        ),
      )
      .limit(1)
  )[0];
  return row
    ? { ...row, id: row.id as CanonicalSymbol }
    : null;
}

async function putAlertRule(
  db: InboxDatabase,
  ownerId: string,
  symbolId: CanonicalSymbol,
  mutation: AlertRuleMutation,
  updatedAt: string,
): Promise<AlertRuleUpdateResult> {
  const symbol = await findTrackedSymbol(db, ownerId, symbolId);
  if (!symbol) throw new InboxRepositoryError("not_found");
  let existing = (
    await db
      .select()
      .from(alertRules)
      .where(
        and(
          eq(alertRules.ownerId, ownerId),
          eq(alertRules.symbolId, symbolId),
        ),
      )
      .limit(1)
  )[0];

  if (existing && sameRule(existing, mutation)) {
    return { rule: ruleView(symbol, existing), replayed: true };
  }
  if (!existing && mutation.expected_version !== 0) {
    throw new InboxRepositoryError("not_found");
  }
  if (existing && existing.version !== mutation.expected_version) {
    throw new InboxRepositoryError("conflict");
  }

  if (!existing) {
    const inserted = await db
      .insert(alertRules)
      .values({
        ownerId,
        symbolId,
        enabled: mutation.enabled,
        minimumMateriality: mutation.minimum_materiality,
        includeControversy: mutation.include_controversy,
        channel: "in_app",
        version: 1,
        createdAt: updatedAt,
        updatedAt,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) {
      return { rule: ruleView(symbol, inserted[0]), replayed: false };
    }
    existing = (
      await db
        .select()
        .from(alertRules)
        .where(
          and(
            eq(alertRules.ownerId, ownerId),
            eq(alertRules.symbolId, symbolId),
          ),
        )
        .limit(1)
    )[0];
    if (existing && sameRule(existing, mutation)) {
      return { rule: ruleView(symbol, existing), replayed: true };
    }
    throw new InboxRepositoryError("conflict");
  }

  const updated = await db
    .update(alertRules)
    .set({
      enabled: mutation.enabled,
      minimumMateriality: mutation.minimum_materiality,
      includeControversy: mutation.include_controversy,
      updatedAt,
      version: existing.version + 1,
    })
    .where(
      and(
        eq(alertRules.ownerId, ownerId),
        eq(alertRules.symbolId, symbolId),
        eq(alertRules.version, mutation.expected_version),
      ),
    )
    .returning();
  if (updated[0]) {
    return { rule: ruleView(symbol, updated[0]), replayed: false };
  }

  const winner = (
    await db
      .select()
      .from(alertRules)
      .where(
        and(
          eq(alertRules.ownerId, ownerId),
          eq(alertRules.symbolId, symbolId),
        ),
      )
      .limit(1)
  )[0];
  if (winner && sameRule(winner, mutation)) {
    return { rule: ruleView(symbol, winner), replayed: true };
  }
  throw new InboxRepositoryError(winner ? "conflict" : "not_found");
}

export function createIntelligenceInboxRepository(
  databaseFactory: InboxDatabaseFactory = getDb,
): IntelligenceInboxRepository {
  return {
    claimReconciliation: (ownerId, requestedAt) =>
      claimReconciliation(databaseFactory(), ownerId, requestedAt),
    completeReconciliation: (ownerId, token, completedAt, completion) =>
      completeReconciliation(
        databaseFactory(),
        ownerId,
        token,
        completedAt,
        completion,
      ),
    syncLiveItems: (ownerId, items, syncedAt, options) =>
      syncLiveItems(databaseFactory(), ownerId, items, syncedAt, options),
    listInbox: (ownerId, filter, limit) =>
      listInbox(databaseFactory(), ownerId, filter, limit),
    getInboxItem: (ownerId, eventId) =>
      getInboxItem(databaseFactory(), ownerId, eventId),
    listRules: (ownerId, trackedSymbols) =>
      listRules(databaseFactory(), ownerId, trackedSymbols),
    updateInboxState: (ownerId, eventId, mutation, updatedAt) =>
      updateInboxState(
        databaseFactory(),
        ownerId,
        eventId,
        mutation,
        updatedAt,
      ),
    putAlertRule: (ownerId, symbolId, mutation, updatedAt) =>
      putAlertRule(
        databaseFactory(),
        ownerId,
        symbolId,
        mutation,
        updatedAt,
      ),
  };
}

export const intelligenceInboxRepository = createIntelligenceInboxRepository();

export function toInboxStateMutationResponse(
  result: InboxStateUpdateResult,
  generatedAt: string,
): InboxStateMutationResponse {
  return {
    data: {
      eventId: result.eventId,
      eventRevision: result.eventRevision,
      state: result.state,
    },
    meta: {
      scope: "personal",
      identity: "authenticated",
      persistence: "server",
      replayed: result.replayed,
      generatedAt,
    },
  };
}

export function toAlertRuleMutationResponse(
  result: AlertRuleUpdateResult,
  generatedAt: string,
): AlertRuleMutationResponse {
  return {
    data: { rule: result.rule },
    meta: {
      scope: "personal",
      identity: "authenticated",
      persistence: "server",
      channel: "in_app",
      replayed: result.replayed,
      generatedAt,
    },
  };
}
