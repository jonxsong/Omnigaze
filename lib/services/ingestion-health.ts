import type { IngestionAggregateStatus } from "@/lib/ingestion/contracts";
import type {
  IngestionCollectionMode,
  IngestionRuntimeConfig,
} from "@/lib/services/intelligence-ingestion";
import { readIngestionRuntimeConfig } from "@/lib/services/intelligence-ingestion";

const STATUS_LOOKBACK_MS = 24 * 60 * 60 * 1_000;

export type IngestionReadinessStatus =
  | "healthy"
  | "catching_up"
  | "delayed"
  | "degraded"
  | "idle"
  | "unavailable";

export type IngestionReadiness = IngestionAggregateStatus & {
  mode: IngestionCollectionMode;
  status: IngestionReadinessStatus;
  expectedCadenceSeconds: number | null;
  lastSuccessAt: string | null;
  latestEvidenceAt: string | null;
};

function latest(values: Array<string | null>) {
  return values
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
}

export function summarizeIngestionReadiness(
  aggregate: IngestionAggregateStatus,
  config: Pick<
    IngestionRuntimeConfig,
    "collectionMode" | "publiclyReportedCadenceSeconds"
  >,
): IngestionReadiness {
  const partitionCount = aggregate.providers.reduce(
    (total, provider) => total + provider.partitionCount,
    0,
  );
  const hasFailure = aggregate.providers.some(
    (provider) => provider.failingPartitionCount > 0,
  );
  const catchingUp = aggregate.providers.some(
    (provider) =>
      provider.duePartitionCount > 0 ||
      provider.resumingPartitionCount > 0 ||
      provider.runs.running > 0,
  );
  const lastSuccessAt = latest(
    aggregate.providers.map((provider) => provider.lastSuccessAt),
  );
  const latestEvidenceAt = latest(
    aggregate.providers.map((provider) => provider.latestEvidenceAt),
  );
  const cadence = config.publiclyReportedCadenceSeconds;
  const generatedAtMs = Date.parse(aggregate.generatedAt);
  const lastSuccessMs = lastSuccessAt ? Date.parse(lastSuccessAt) : Number.NaN;
  const delayed =
    cadence !== null &&
    partitionCount > 0 &&
    (!Number.isFinite(lastSuccessMs) ||
      generatedAtMs - lastSuccessMs > cadence * 2 * 1_000);

  const status: IngestionReadinessStatus = hasFailure
    ? "degraded"
    : delayed
      ? "delayed"
      : catchingUp
        ? "catching_up"
        : partitionCount === 0
          ? "idle"
          : "healthy";

  return {
    ...aggregate,
    mode: config.collectionMode,
    status,
    expectedCadenceSeconds: cadence,
    lastSuccessAt,
    latestEvidenceAt,
  };
}

export function unavailableIngestionReadiness(options: {
  now: string;
  since: string;
}): IngestionReadiness {
  return {
    mode: "unavailable",
    status: "unavailable",
    expectedCadenceSeconds: null,
    lastSuccessAt: null,
    latestEvidenceAt: null,
    generatedAt: options.now,
    since: options.since,
    providers: [],
  };
}

export async function getIngestionReadiness(
  environment: Record<string, string | undefined> = process.env,
): Promise<IngestionReadiness> {
  const now = new Date().toISOString();
  const since = new Date(Date.parse(now) - STATUS_LOOKBACK_MS).toISOString();
  try {
    const [config, { ingestionRepository }] = await Promise.all([
      readIngestionRuntimeConfig(environment),
      import("@/lib/ingestion/repository"),
    ]);
    const aggregate = await ingestionRepository.getAggregateStatus({
      now,
      since,
      provider: config.provider,
      partitionKey: config.partitionKey,
    });
    return summarizeIngestionReadiness(aggregate, config);
  } catch {
    return unavailableIngestionReadiness({ now, since });
  }
}
