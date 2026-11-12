import type { InboxProjectionAggregateStatus } from "@/lib/intelligence-inbox/projection-repository";

const DEFAULT_CADENCE_SECONDS = 300;
const MINIMUM_CADENCE_SECONDS = 60;
const MAXIMUM_CADENCE_SECONDS = 86_400;

export type ProjectionCollectionMode =
  | "request_time"
  | "scheduled"
  | "unavailable";

export type ProjectionReadinessStatus =
  | "healthy"
  | "catching_up"
  | "delayed"
  | "degraded"
  | "idle"
  | "unavailable";

export interface ProjectionRuntimeConfig {
  collectionMode: Exclude<ProjectionCollectionMode, "unavailable">;
  publiclyReportedCadenceSeconds: number | null;
}

export type ProjectionReadiness = {
  mode: ProjectionCollectionMode;
  status: ProjectionReadinessStatus;
  expectedCadenceSeconds: number | null;
  generatedAt: string;
  hasProfiles: boolean | null;
  hasPendingWork: boolean | null;
  hasActiveLease: boolean | null;
  hasFailures: boolean | null;
  lastAttemptAt: string | null;
  lastCompletedAt: string | null;
};

function boundedCadence(value: string | undefined) {
  if (!value) return DEFAULT_CADENCE_SECONDS;
  const parsed = Number(value);
  return Number.isInteger(parsed) &&
    parsed >= MINIMUM_CADENCE_SECONDS &&
    parsed <= MAXIMUM_CADENCE_SECONDS
    ? parsed
    : DEFAULT_CADENCE_SECONDS;
}

export function readProjectionRuntimeConfig(
  environment: Record<string, string | undefined> = process.env,
): ProjectionRuntimeConfig {
  const scheduled =
    environment.INBOX_PROJECTION_COLLECTION_MODE === "scheduled";
  return {
    collectionMode: scheduled ? "scheduled" : "request_time",
    publiclyReportedCadenceSeconds: scheduled
      ? boundedCadence(environment.INBOX_PROJECTION_EXPECTED_CADENCE_SECONDS)
      : null,
  };
}

export function summarizeProjectionReadiness(
  aggregate: InboxProjectionAggregateStatus,
  config: ProjectionRuntimeConfig,
): ProjectionReadiness {
  const generatedAtMs = Date.parse(aggregate.generatedAt);
  const lastCompletedAtMs = aggregate.lastCompletedAt
    ? Date.parse(aggregate.lastCompletedAt)
    : Number.NaN;
  const cadence = config.publiclyReportedCadenceSeconds;
  const delayed =
    cadence !== null &&
    aggregate.ownerCount > 0 &&
    (!Number.isFinite(lastCompletedAtMs) ||
      generatedAtMs - lastCompletedAtMs > cadence * 2 * 1_000);
  const status: ProjectionReadinessStatus =
    aggregate.failingOwnerCount > 0
      ? "degraded"
      : delayed
        ? "delayed"
        : aggregate.pendingOwnerCount > 0 || aggregate.leasedOwnerCount > 0
          ? "catching_up"
          : aggregate.ownerCount === 0
            ? "idle"
            : "healthy";

  return {
    mode: config.collectionMode,
    status,
    expectedCadenceSeconds: cadence,
    generatedAt: aggregate.generatedAt,
    hasProfiles: aggregate.ownerCount > 0,
    hasPendingWork: aggregate.pendingOwnerCount > 0,
    hasActiveLease: aggregate.leasedOwnerCount > 0,
    hasFailures: aggregate.failingOwnerCount > 0,
    lastAttemptAt: aggregate.lastAttemptAt,
    lastCompletedAt: aggregate.lastCompletedAt,
  };
}

export function unavailableProjectionReadiness(
  generatedAt: string,
): ProjectionReadiness {
  return {
    mode: "unavailable",
    status: "unavailable",
    expectedCadenceSeconds: null,
    generatedAt,
    hasProfiles: null,
    hasPendingWork: null,
    hasActiveLease: null,
    hasFailures: null,
    lastAttemptAt: null,
    lastCompletedAt: null,
  };
}

export async function getProjectionReadiness(
  environment: Record<string, string | undefined> = process.env,
): Promise<ProjectionReadiness> {
  const generatedAt = new Date().toISOString();
  try {
    const [{ inboxProjectionCursorRepository }, config] = await Promise.all([
      import("@/lib/intelligence-inbox/projection-repository"),
      Promise.resolve(readProjectionRuntimeConfig(environment)),
    ]);
    const aggregate =
      await inboxProjectionCursorRepository.getAggregateStatus(generatedAt);
    return summarizeProjectionReadiness(aggregate, config);
  } catch {
    return unavailableProjectionReadiness(generatedAt);
  }
}
