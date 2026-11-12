import { defaultWatchlist } from "@/lib/demo-market-data";
import type { RawSourceEventReceipt } from "@/lib/ingestion/contracts";
import type { CanonicalSymbol } from "@/lib/market-types";
import type { RawSourceEvent } from "@/lib/pipeline/contracts";
import {
  AlpacaProvider,
  createAlpacaNewsQueryFingerprint,
} from "@/lib/providers/alpaca";
import type { PaginatedIntelligenceSourceProvider } from "@/lib/providers/contracts";
import {
  createProviderEgressGuard,
  type ProviderEgressAdmissionGuard,
} from "@/lib/providers/provider-egress-guard";
import {
  createBoundedProviderIngestionService,
  IngestionTickError,
  type IngestionRepositoryPort,
  type IngestionTickResult,
} from "@/lib/services/bounded-provider-ingestion";

export { IngestionTickError };
export type { IngestionRepositoryPort, IngestionTickResult };

const INGESTION_PROVIDER = "alpaca";
const PAGE_SIZE = 50;
const PROVIDER_SETTLING_DELAY_MS = 30_000;
const CORRECTION_LOOKBACK_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_CADENCE_SECONDS = 300;
const MAX_CONFIGURED_SYMBOLS = 50;

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

type IngestionDependencies = {
  repository: IngestionRepositoryPort;
  provider: PaginatedIntelligenceSourceProvider;
  config: IngestionRuntimeConfig;
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

export function createIntelligenceIngestionService(
  dependencies: IngestionDependencies,
) {
  return createBoundedProviderIngestionService({
    repository: dependencies.repository,
    provider: dependencies.provider,
    config: {
      provider: dependencies.config.provider,
      partitions: [
        {
          partitionKey: dependencies.config.partitionKey,
          symbols: dependencies.config.symbols,
        },
      ],
      sourceKinds: ["licensed_news"],
      pageSize: dependencies.config.pageSize,
      cadenceSeconds: dependencies.config.cadenceSeconds,
      settlingDelayMs: PROVIDER_SETTLING_DELAY_MS,
      lookbackMs: CORRECTION_LOOKBACK_MS,
    },
    adapter: {
      createQueryFingerprint: ({
        partition,
        windowStart,
        windowEnd,
        pageSize,
      }) =>
        createAlpacaNewsQueryFingerprint({
          symbols: partition.symbols,
          windowStart,
          windowEnd,
          pageSize,
        }),
      createReceipt: (event, { partition }) =>
        receiptForEvent(event, partition.symbols),
    },
    now: dependencies.now,
  });
}

export function createConfiguredAlpacaIngestionProvider(
  environment: Record<string, string | undefined> = process.env,
  dependencies: {
    createProviderEgressGuard?: () => ProviderEgressAdmissionGuard;
  } = {},
) {
  return new AlpacaProvider({
    keyId: environment.ALPACA_API_KEY_ID,
    secretKey: environment.ALPACA_API_SECRET_KEY,
    feed:
      environment.ALPACA_DATA_FEED === "sip" ||
      environment.ALPACA_DATA_FEED === "delayed_sip"
        ? environment.ALPACA_DATA_FEED
        : "iex",
    egressGuard:
      dependencies.createProviderEgressGuard?.() ??
      createProviderEgressGuard(),
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
