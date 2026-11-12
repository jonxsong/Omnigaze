import { defaultWatchlist } from "@/lib/demo-market-data";
import type { RawSourceEventReceipt } from "@/lib/ingestion/contracts";
import type { CanonicalSymbol } from "@/lib/market-types";
import type { RawSourceEvent } from "@/lib/pipeline/contracts";
import type { PaginatedIntelligenceSourceProvider } from "@/lib/providers/contracts";
import {
  createSecFilingQueryFingerprint,
  isValidSecUserAgent,
  SecEdgarProvider,
} from "@/lib/providers/sec-edgar";
import {
  createSecFairAccessCoordinator,
  type SecFairAccessCoordinator,
} from "@/lib/providers/sec-fair-access";
import { SEC_KNOWN_CIK_BY_TICKER } from "@/lib/providers/sec-known-ciks";
import {
  createBoundedProviderIngestionService,
  IngestionTickError,
  type BoundedIngestionPartition,
  type IngestionRepositoryPort,
} from "@/lib/services/bounded-provider-ingestion";
import type { IngestionCollectionMode } from "@/lib/services/intelligence-ingestion";

const PROVIDER = "sec-edgar";
const PAGE_SIZE = 100;
const DEFAULT_CADENCE_SECONDS = 300;
const SETTLING_DELAY_MS = 30_000;
const RECENT_CORRECTION_LOOKBACK_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_CONFIGURED_SYMBOLS = 50;
const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/u;
const accessionPattern = /^\d{10}-\d{2}-\d{6}$/u;

export interface SecFilingIngestionPartition
  extends BoundedIngestionPartition {
  cik: string;
}

export interface SecFilingIngestionRuntimeConfig {
  provider: typeof PROVIDER;
  enabled: boolean;
  partitions: SecFilingIngestionPartition[];
  pageSize: number;
  cadenceSeconds: number;
  publiclyReportedCadenceSeconds: number | null;
  collectionMode: Exclude<IngestionCollectionMode, "unavailable">;
}

type SecFilingIngestionDependencies = {
  repository: IngestionRepositoryPort;
  provider: PaginatedIntelligenceSourceProvider;
  config: SecFilingIngestionRuntimeConfig;
  now?: () => Date;
};

type SecFilingRuntimeDependencies = {
  coordinator?: SecFairAccessCoordinator;
  provider?: PaginatedIntelligenceSourceProvider;
  repository?: IngestionRepositoryPort;
  now?: () => Date;
};

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

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function configuredSymbols(value: string | undefined) {
  const candidates = value
    ? value.split(",").map((symbol) => symbol.trim().toUpperCase())
    : defaultWatchlist.filter(
        (symbol) => SEC_KNOWN_CIK_BY_TICKER[symbol.split(":")[1]],
      );
  const unique = [...new Set(candidates)];
  if (
    unique.length === 0 ||
    unique.length > MAX_CONFIGURED_SYMBOLS ||
    unique.length !== candidates.length ||
    unique.some(
      (symbol) =>
        !canonicalSymbolPattern.test(symbol) ||
        !SEC_KNOWN_CIK_BY_TICKER[symbol.split(":")[1]],
    )
  ) {
    throw new Error("invalid_sec_ingestion_symbols");
  }
  return unique.sort() as CanonicalSymbol[];
}

export async function readSecFilingIngestionRuntimeConfig(
  environment: Record<string, string | undefined> = process.env,
): Promise<SecFilingIngestionRuntimeConfig> {
  const symbols = configuredSymbols(environment.SEC_INGESTION_SYMBOLS);
  const symbolsByCik = new Map<string, CanonicalSymbol[]>();
  for (const symbol of symbols) {
    const cik = SEC_KNOWN_CIK_BY_TICKER[symbol.split(":")[1]];
    const grouped = symbolsByCik.get(cik) ?? [];
    grouped.push(symbol);
    symbolsByCik.set(cik, grouped);
  }
  const partitions = await Promise.all(
    [...symbolsByCik]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([cik, groupedSymbols]) => {
        const normalizedSymbols = [...groupedSymbols].sort();
        const mappingHash = await sha256(
          JSON.stringify({ provider: PROVIDER, version: 1, cik, symbols: normalizedSymbols }),
        );
        return {
          cik,
          symbols: normalizedSymbols,
          partitionKey: `filings-recent:v1:${mappingHash}`,
        };
      }),
  );
  const cadenceSeconds = parsePositiveInteger(
    environment.SEC_INGESTION_EXPECTED_CADENCE_SECONDS,
    DEFAULT_CADENCE_SECONDS,
    60,
    86_400,
  );
  const enabled = environment.SEC_DURABLE_INGESTION_ENABLED === "true";
  const scheduleDeclared =
    enabled && environment.SEC_INGESTION_COLLECTION_MODE === "scheduled";
  return {
    provider: PROVIDER,
    enabled,
    partitions,
    pageSize: PAGE_SIZE,
    cadenceSeconds,
    publiclyReportedCadenceSeconds: scheduleDeclared ? cadenceSeconds : null,
    collectionMode: scheduleDeclared ? "scheduled" : "request_time",
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactStringArray(value: unknown, expected: string[]) {
  return (
    Array.isArray(value) &&
    value.every((item) => typeof item === "string") &&
    JSON.stringify([...value].sort()) === JSON.stringify([...expected].sort())
  );
}

function validatedFilingPayload(
  event: RawSourceEvent,
  partition: SecFilingIngestionPartition,
) {
  const payload = record(event.payload);
  const headline = payload?.headline;
  const summary = payload?.summary;
  const url = payload?.url;
  const accessionNumber = payload?.accessionNumber;
  const cik = payload?.cik;
  const form = payload?.form;
  const filingDate = payload?.filingDate;
  const acceptedAt = payload?.acceptedAt;
  const primaryDocument = payload?.primaryDocument;
  const acceptedAtTimestamp =
    typeof acceptedAt === "string" ? Date.parse(acceptedAt) : Number.NaN;
  const providerRevisionTimestamp = Date.parse(
    event.providerUpdatedAt ?? event.publishedAt,
  );
  const receivedAtTimestamp = Date.parse(event.receivedAt);
  if (
    !payload ||
    typeof headline !== "string" ||
    headline.trim().length === 0 ||
    headline.length > 512 ||
    typeof summary !== "string" ||
    summary.length > 4_000 ||
    (url !== null && (typeof url !== "string" || url.length > 2_048)) ||
    typeof accessionNumber !== "string" ||
    accessionNumber !== event.sourceEventId ||
    !accessionPattern.test(accessionNumber) ||
    cik !== partition.cik ||
    typeof form !== "string" ||
    form.trim().length === 0 ||
    form.length > 64 ||
    typeof filingDate !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(filingDate) ||
    typeof acceptedAt !== "string" ||
    !Number.isFinite(acceptedAtTimestamp) ||
    new Date(acceptedAtTimestamp).toISOString() !== event.publishedAt ||
    !Number.isFinite(providerRevisionTimestamp) ||
    new Date(providerRevisionTimestamp).toISOString() !== event.publishedAt ||
    !Number.isFinite(receivedAtTimestamp) ||
    (primaryDocument !== null &&
      (typeof primaryDocument !== "string" ||
        primaryDocument.length === 0 ||
        primaryDocument.length > 256 ||
        !/^[A-Za-z0-9._-]+$/u.test(primaryDocument))) ||
    (primaryDocument === null) !== (url === null) ||
    !exactStringArray(payload.symbols, partition.symbols)
  ) {
    throw new IngestionTickError(
      "provider_payload_invalid",
      "page_validation",
      false,
    );
  }
  if (url !== null) {
    try {
      const parsed = new URL(url);
      if (
        parsed.protocol !== "https:" ||
        parsed.hostname !== "www.sec.gov" ||
        !parsed.pathname.startsWith("/Archives/edgar/data/")
      ) {
        throw new Error("invalid");
      }
    } catch {
      throw new IngestionTickError(
        "provider_payload_invalid",
        "page_validation",
        false,
      );
    }
  }
  return {
    payload,
    headline: headline.trim(),
    summary: summary.trim(),
    url,
  };
}

async function receiptForFiling(
  event: RawSourceEvent,
  partition: SecFilingIngestionPartition,
): Promise<RawSourceEventReceipt> {
  const { payload, headline, summary, url } = validatedFilingPayload(
    event,
    partition,
  );
  const publishedAt = new Date(event.publishedAt).toISOString();
  const observedAt = new Date(event.receivedAt).toISOString();
  const providerRevisionAt = new Date(
    event.providerUpdatedAt ?? event.publishedAt,
  ).toISOString();
  const contentDigest = await sha256(JSON.stringify(payload));
  const rawPayload = JSON.stringify({
    schema: "omnigaze.provider-receipt.v1",
    sourceKind: event.sourceKind,
    sourceEventId: event.sourceEventId,
    publishedAt,
    providerRevisionAt,
    symbolIds: [...partition.symbols].sort(),
    headline,
    summary: summary || null,
    url,
    contentDigest,
  });
  return {
    sourceKind: event.sourceKind,
    sourceEventId: event.sourceEventId,
    publishedAt,
    observedAt,
    payloadPolicy: "minimal_redacted_v1",
    rawPayloadHash: await sha256(rawPayload),
    rawPayload,
    status: "observed",
    symbolIds: [...partition.symbols].sort(),
    providerRevisionAt,
  };
}

export function createSecFilingIngestionService(
  dependencies: SecFilingIngestionDependencies,
) {
  const byPartition = new Map(
    dependencies.config.partitions.map((partition) => [
      partition.partitionKey,
      partition,
    ]),
  );
  return createBoundedProviderIngestionService({
    repository: dependencies.repository,
    provider: dependencies.provider,
    config: {
      provider: dependencies.config.provider,
      partitions: dependencies.config.partitions.map(
        ({ partitionKey, symbols }) => ({ partitionKey, symbols }),
      ),
      sourceKinds: ["sec_filing"],
      pageSize: dependencies.config.pageSize,
      cadenceSeconds: dependencies.config.cadenceSeconds,
      settlingDelayMs: SETTLING_DELAY_MS,
      lookbackMs: RECENT_CORRECTION_LOOKBACK_MS,
    },
    adapter: {
      createQueryFingerprint: ({ partition, windowStart, windowEnd, pageSize }) => {
        const configured = byPartition.get(partition.partitionKey);
        if (!configured) {
          throw new IngestionTickError("invalid_partition", "claim", false);
        }
        return createSecFilingQueryFingerprint({
          cik: configured.cik,
          symbols: partition.symbols,
          windowStart,
          windowEnd,
          pageSize,
        });
      },
      validateEvent: (event, { partition }) => {
        const configured = byPartition.get(partition.partitionKey);
        if (!configured) {
          throw new IngestionTickError(
            "invalid_partition",
            "page_validation",
            false,
          );
        }
        validatedFilingPayload(event, configured);
      },
      createReceipt: (event, { partition }) => {
        const configured = byPartition.get(partition.partitionKey);
        if (!configured) {
          throw new IngestionTickError(
            "invalid_partition",
            "page_validation",
            false,
          );
        }
        return receiptForFiling(event, configured);
      },
    },
    now: dependencies.now,
  });
}

export function createConfiguredSecFilingIngestionProvider(
  environment: Record<string, string | undefined> = process.env,
  coordinator: SecFairAccessCoordinator = createSecFairAccessCoordinator(),
) {
  return new SecEdgarProvider({
    enabled: environment.SEC_EDGAR_ENABLED === "true",
    userAgent: environment.SEC_USER_AGENT,
    coordinator,
    cikByTicker: SEC_KNOWN_CIK_BY_TICKER,
  });
}

function preflightError(code: string, retryable: boolean): never {
  throw new IngestionTickError(code, "claim", retryable);
}

export async function runSecFilingIngestionTick(
  environment: Record<string, string | undefined> = process.env,
  dependencies: SecFilingRuntimeDependencies = {},
) {
  let config: SecFilingIngestionRuntimeConfig;
  try {
    config = await readSecFilingIngestionRuntimeConfig(environment);
  } catch {
    preflightError("provider_unconfigured", false);
  }
  if (!config.enabled) preflightError("provider_unconfigured", false);
  if (
    environment.SEC_EDGAR_ENABLED !== "true" ||
    !isValidSecUserAgent(environment.SEC_USER_AGENT)
  ) {
    preflightError("provider_unconfigured", false);
  }
  const coordinator =
    dependencies.coordinator ?? createSecFairAccessCoordinator();
  const provider =
    dependencies.provider ??
    createConfiguredSecFilingIngestionProvider(environment, coordinator);
  let health: Awaited<ReturnType<typeof provider.getHealth>>;
  try {
    health = await provider.getHealth();
  } catch {
    preflightError("sec_fair_access_unavailable", true);
  }
  if (health.status === "unconfigured") {
    preflightError("provider_unconfigured", false);
  }
  if (health.status !== "healthy") {
    preflightError("sec_fair_access_unavailable", true);
  }
  const repository =
    dependencies.repository ??
    (await import("@/lib/ingestion/repository")).ingestionRepository;
  return createSecFilingIngestionService({
    repository,
    provider,
    config,
    now: dependencies.now,
  }).runTick();
}
