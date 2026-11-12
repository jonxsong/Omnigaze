import { and, asc, eq, isNull, or, sql } from "drizzle-orm";
import { getDb } from "@/db";
import {
  inboxProjectionChanges,
  inboxProfiles,
  inboxProjectionCursors,
} from "@/db/schema";

type ProjectionDatabase = ReturnType<typeof getDb>;
type ProjectionDatabaseFactory = () => ProjectionDatabase;

export const INBOX_PROJECTION_LEASE_MS = 30_000;
export const INBOX_PROJECTION_IDLE_INTERVAL_MS = 30_000;
export const INBOX_PROJECTION_RETRY_INTERVAL_MS = 10_000;

export interface InboxProjectionLease {
  ownerId: string;
  token: string;
  lastSequence: number;
}

export interface InboxProjectionAggregateStatus {
  generatedAt: string;
  ownerCount: number;
  pendingOwnerCount: number;
  leasedOwnerCount: number;
  failingOwnerCount: number;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
}

export interface InboxProjectionCursorRepository {
  claimNext(requestedAt: string): Promise<InboxProjectionLease | null>;
  complete(
    lease: InboxProjectionLease,
    completedAt: string,
    lastSequence: number,
    hasMore: boolean,
  ): Promise<void>;
  fail(lease: InboxProjectionLease, failedAt: string): Promise<void>;
  getAggregateStatus(now: string): Promise<InboxProjectionAggregateStatus>;
}

function normalizedIso(value: string) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error("invalid_projection_timestamp");
  return new Date(timestamp).toISOString();
}

function shiftedIso(value: string, deltaMs: number) {
  return new Date(Date.parse(normalizedIso(value)) + deltaMs).toISOString();
}

async function registerActivatedOwners(
  db: ProjectionDatabase,
  requestedAt: string,
) {
  await db.run(sql`
    INSERT INTO ${inboxProjectionCursors} (
      owner_id,
      last_sequence,
      next_allowed_at,
      created_at,
      updated_at
    )
    SELECT
      ${inboxProfiles.ownerId},
      0,
      ${requestedAt},
      ${requestedAt},
      ${requestedAt}
    FROM ${inboxProfiles}
    WHERE 1 = 1
    ON CONFLICT (owner_id) DO NOTHING
  `);
}

async function claimNext(
  db: ProjectionDatabase,
  requestedAtInput: string,
): Promise<InboxProjectionLease | null> {
  const requestedAt = normalizedIso(requestedAtInput);
  await registerActivatedOwners(db, requestedAt);

  // A contender may win between selection and update. A second bounded attempt
  // lets another due owner progress without turning this into an unbounded loop.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const candidate = (
      await db
        .select({
          ownerId: inboxProjectionCursors.ownerId,
          lastSequence: inboxProjectionCursors.lastSequence,
        })
        .from(inboxProjectionCursors)
        .where(
          and(
            sql`julianday(${inboxProjectionCursors.nextAllowedAt}) <= julianday(${requestedAt})`,
            or(
              isNull(inboxProjectionCursors.claimToken),
              sql`julianday(${inboxProjectionCursors.claimUntil}) <= julianday(${requestedAt})`,
            ),
          ),
        )
        .orderBy(
          asc(inboxProjectionCursors.nextAllowedAt),
          asc(inboxProjectionCursors.lastCompletedAt),
          asc(inboxProjectionCursors.ownerId),
        )
        .limit(1)
    )[0];
    if (!candidate) return null;

    const token = crypto.randomUUID();
    const claimed = await db
      .update(inboxProjectionCursors)
      .set({
        claimToken: token,
        claimUntil: shiftedIso(requestedAt, INBOX_PROJECTION_LEASE_MS),
        lastAttemptAt: requestedAt,
        updatedAt: requestedAt,
      })
      .where(
        and(
          eq(inboxProjectionCursors.ownerId, candidate.ownerId),
          eq(inboxProjectionCursors.lastSequence, candidate.lastSequence),
          sql`julianday(${inboxProjectionCursors.nextAllowedAt}) <= julianday(${requestedAt})`,
          or(
            isNull(inboxProjectionCursors.claimToken),
            sql`julianday(${inboxProjectionCursors.claimUntil}) <= julianday(${requestedAt})`,
          ),
        ),
      )
      .returning({
        ownerId: inboxProjectionCursors.ownerId,
        lastSequence: inboxProjectionCursors.lastSequence,
      });
    if (claimed[0]) {
      return {
        ownerId: claimed[0].ownerId,
        token,
        lastSequence: claimed[0].lastSequence,
      };
    }
  }
  return null;
}

async function complete(
  db: ProjectionDatabase,
  lease: InboxProjectionLease,
  completedAtInput: string,
  lastSequence: number,
  hasMore: boolean,
) {
  const completedAt = normalizedIso(completedAtInput);
  if (
    !Number.isSafeInteger(lastSequence) ||
    lastSequence < lease.lastSequence
  ) {
    throw new Error("invalid_projection_cursor");
  }
  const updated = await db
    .update(inboxProjectionCursors)
    .set({
      lastSequence,
      claimToken: null,
      claimUntil: null,
      nextAllowedAt: hasMore
        ? completedAt
        : shiftedIso(completedAt, INBOX_PROJECTION_IDLE_INTERVAL_MS),
      lastCompletedAt: completedAt,
      consecutiveFailures: 0,
      updatedAt: completedAt,
    })
    .where(
      and(
        eq(inboxProjectionCursors.ownerId, lease.ownerId),
        eq(inboxProjectionCursors.claimToken, lease.token),
        eq(inboxProjectionCursors.lastSequence, lease.lastSequence),
      ),
    )
    .returning({ ownerId: inboxProjectionCursors.ownerId });
  if (!updated[0]) throw new Error("projection_lease_lost");
}

async function fail(
  db: ProjectionDatabase,
  lease: InboxProjectionLease,
  failedAtInput: string,
) {
  const failedAt = normalizedIso(failedAtInput);
  await db
    .update(inboxProjectionCursors)
    .set({
      claimToken: null,
      claimUntil: null,
      nextAllowedAt: shiftedIso(failedAt, INBOX_PROJECTION_RETRY_INTERVAL_MS),
      consecutiveFailures: sql`${inboxProjectionCursors.consecutiveFailures} + 1`,
      updatedAt: failedAt,
    })
    .where(
      and(
        eq(inboxProjectionCursors.ownerId, lease.ownerId),
        eq(inboxProjectionCursors.claimToken, lease.token),
        eq(inboxProjectionCursors.lastSequence, lease.lastSequence),
      ),
    );
}

async function getAggregateStatus(
  db: ProjectionDatabase,
  nowInput: string,
): Promise<InboxProjectionAggregateStatus> {
  const now = normalizedIso(nowInput);
  const rows = await db.values<
    [
      number,
      number,
      number,
      number,
      string | null,
      string | null,
    ]
  >(sql`
    SELECT
      COUNT(${inboxProfiles.ownerId}) AS owner_count,
      COALESCE(SUM(
        CASE
          WHEN ${inboxProjectionCursors.ownerId} IS NULL
            OR ${inboxProfiles.baselineCompletedAt} IS NULL
            OR ${inboxProjectionCursors.lastSequence} < ledger.max_sequence
          THEN 1
          ELSE 0
        END
      ), 0) AS pending_owner_count,
      COALESCE(SUM(
        CASE
          WHEN ${inboxProjectionCursors.claimToken} IS NOT NULL
            AND julianday(${inboxProjectionCursors.claimUntil}) > julianday(${now})
          THEN 1
          ELSE 0
        END
      ), 0) AS leased_owner_count,
      COALESCE(SUM(
        CASE
          WHEN ${inboxProjectionCursors.consecutiveFailures} > 0 THEN 1
          ELSE 0
        END
      ), 0) AS failing_owner_count,
      MAX(${inboxProjectionCursors.lastAttemptAt}) AS last_attempt_at,
      MAX(${inboxProjectionCursors.lastCompletedAt}) AS last_completed_at
    FROM ${inboxProfiles}
    LEFT JOIN ${inboxProjectionCursors}
      ON ${inboxProjectionCursors.ownerId} = ${inboxProfiles.ownerId}
    CROSS JOIN (
      SELECT COALESCE(MAX(${inboxProjectionChanges.sequence}), 0) AS max_sequence
      FROM ${inboxProjectionChanges}
    ) AS ledger
  `);
  const row = rows[0];
  return {
    generatedAt: now,
    ownerCount: Number(row?.[0] ?? 0),
    pendingOwnerCount: Number(row?.[1] ?? 0),
    leasedOwnerCount: Number(row?.[2] ?? 0),
    failingOwnerCount: Number(row?.[3] ?? 0),
    lastAttemptAt: row?.[4] ?? null,
    lastCompletedAt: row?.[5] ?? null,
  };
}

export function createInboxProjectionCursorRepository(
  databaseFactory: ProjectionDatabaseFactory = getDb,
): InboxProjectionCursorRepository {
  return {
    claimNext: (requestedAt) => claimNext(databaseFactory(), requestedAt),
    complete: (lease, completedAt, lastSequence, hasMore) =>
      complete(
        databaseFactory(),
        lease,
        completedAt,
        lastSequence,
        hasMore,
      ),
    fail: (lease, failedAt) => fail(databaseFactory(), lease, failedAt),
    getAggregateStatus: (now) => getAggregateStatus(databaseFactory(), now),
  };
}

export const inboxProjectionCursorRepository =
  createInboxProjectionCursorRepository();
