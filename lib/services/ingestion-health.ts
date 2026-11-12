import type { IngestionAggregateStatus } from "@/lib/ingestion/contracts";
import type {
  IngestionCollectionMode,
  IngestionRuntimeConfig,
} from "@/lib/services/intelligence-ingestion";
import { readIngestionRuntimeConfig } from "@/lib/services/intelligence-ingestion";
import { isValidSecUserAgent } from "@/lib/providers/sec-edgar";

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

type ReadinessConfig = Pick<
  IngestionRuntimeConfig,
  "collectionMode" | "publiclyReportedCadenceSeconds"
>;

function latest(values: Array<string | null>) {
  return values
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) ?? null;
}

export function summarizeIngestionReadiness(
  aggregate: IngestionAggregateStatus,
  config: ReadinessConfig,
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

function mergeProviderStatuses(
  providers: IngestionAggregateStatus["providers"],
) {
  const merged = new Map<
    string,
    IngestionAggregateStatus["providers"][number]
  >();
  for (const provider of providers) {
    const current = merged.get(provider.provider);
    if (!current) {
      merged.set(provider.provider, {
        ...provider,
        runs: { ...provider.runs },
      });
      continue;
    }
    const latest = (left: string | null, right: string | null) =>
      [left, right]
        .filter((value): value is string => value !== null)
        .sort()
        .at(-1) ?? null;
    current.partitionCount += provider.partitionCount;
    current.duePartitionCount += provider.duePartitionCount;
    current.leasedPartitionCount += provider.leasedPartitionCount;
    current.resumingPartitionCount += provider.resumingPartitionCount;
    current.failingPartitionCount += provider.failingPartitionCount;
    current.totalSuccesses += provider.totalSuccesses;
    current.totalFailures += provider.totalFailures;
    current.lastAttemptAt = latest(current.lastAttemptAt, provider.lastAttemptAt);
    current.lastSuccessAt = latest(current.lastSuccessAt, provider.lastSuccessAt);
    current.lastFailureAt = latest(current.lastFailureAt, provider.lastFailureAt);
    current.latestEvidenceAt = latest(
      current.latestEvidenceAt,
      provider.latestEvidenceAt,
    );
    current.runs.running += provider.runs.running;
    current.runs.succeeded += provider.runs.succeeded;
    current.runs.failed += provider.runs.failed;
    current.runs.receipts += provider.runs.receipts;
    current.runs.errors += provider.runs.errors;
  }
  return [...merged.values()].sort((left, right) =>
    left.provider.localeCompare(right.provider),
  );
}

function uninitializedScheduledProvider(provider: string) {
  return {
    provider,
    partitionCount: 1,
    duePartitionCount: 1,
    leasedPartitionCount: 0,
    resumingPartitionCount: 0,
    failingPartitionCount: 0,
    totalSuccesses: 0,
    totalFailures: 0,
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    latestEvidenceAt: null,
    runs: {
      running: 0,
      succeeded: 0,
      failed: 0,
      receipts: 0,
      errors: 0,
    },
  } satisfies IngestionAggregateStatus["providers"][number];
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
    const [config, secConfig, { ingestionRepository }] = await Promise.all([
      readIngestionRuntimeConfig(environment),
      environment.SEC_DURABLE_INGESTION_ENABLED === "true"
        ? import("@/lib/services/sec-filing-ingestion").then(
            ({ readSecFilingIngestionRuntimeConfig }) =>
              readSecFilingIngestionRuntimeConfig(environment),
          )
        : Promise.resolve(null),
      import("@/lib/ingestion/repository"),
    ]);
    const secConfigured =
      secConfig?.enabled === true &&
      environment.SEC_EDGAR_ENABLED === "true" &&
      isValidSecUserAgent(environment.SEC_USER_AGENT);
    const activeSecConfig = secConfigured ? secConfig : null;
    const scopes = [
      { provider: config.provider, partitionKey: config.partitionKey },
      ...(activeSecConfig
        ? activeSecConfig.partitions.map((partition) => ({
            provider: activeSecConfig.provider,
            partitionKey: partition.partitionKey,
          }))
        : []),
    ];
    const aggregates = await Promise.all(
      scopes.map((scope) =>
        ingestionRepository.getAggregateStatus({ now, since, ...scope }),
      ),
    );
    const aggregate: IngestionAggregateStatus = {
      generatedAt: now,
      since,
      providers: mergeProviderStatuses(
        aggregates.flatMap((entry, index) => {
          const scope = scopes[index];
          const scheduledSecScope =
            activeSecConfig?.collectionMode === "scheduled" &&
            scope.provider === activeSecConfig.provider;
          if (!scheduledSecScope) return entry.providers;
          if (entry.providers.length === 0) {
            return [uninitializedScheduledProvider(scope.provider)];
          }
          return entry.providers.map((provider) =>
            provider.totalSuccesses === 0
              ? {
                  ...provider,
                  duePartitionCount: Math.max(
                    1,
                    provider.duePartitionCount,
                  ),
                }
              : provider,
          );
        }),
      ),
    };
    const reportedCadences = [
      config.publiclyReportedCadenceSeconds,
      ...(activeSecConfig
        ? [activeSecConfig.publiclyReportedCadenceSeconds]
        : []),
    ].filter((value): value is number => value !== null);
    const readinessConfig: ReadinessConfig = {
      collectionMode:
        config.collectionMode === "scheduled" ||
        activeSecConfig?.collectionMode === "scheduled"
          ? "scheduled"
          : "request_time",
      publiclyReportedCadenceSeconds:
        reportedCadences.length > 0 ? Math.min(...reportedCadences) : null,
    };
    return summarizeIngestionReadiness(aggregate, readinessConfig);
  } catch {
    return unavailableIngestionReadiness({ now, since });
  }
}
