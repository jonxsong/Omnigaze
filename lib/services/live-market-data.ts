import { defaultWatchlist } from "@/lib/demo-market-data";
import { decodeHtmlEntities } from "@/lib/decode-html-entities";
import type {
  CanonicalSymbol,
  CausalLink,
  ClaimStatus,
  IntelligenceEvent,
  MarketSnapshot,
  Materiality,
} from "@/lib/market-types";
import { classifyPublicEvent } from "@/lib/pipeline/classify-public-event";
import type { ProviderHealth, RawSourceEvent, SourceKind } from "@/lib/pipeline/contracts";
import { AlpacaProvider } from "@/lib/providers/alpaca";
import type {
  IntelligenceSourceResult,
  IntelligenceSourceProvider,
  MarketDataProvider,
} from "@/lib/providers/contracts";
import { SecEdgarProvider } from "@/lib/providers/sec-edgar";
import {
  getIntelligenceFeed as getDemoIntelligenceFeed,
  getMarketSnapshot as getDemoMarketSnapshot,
} from "@/lib/services/market-intelligence";

export type ProviderCapability = "market-snapshot" | "market-news" | "sec-filings";
export type DataMode = "live" | "demo";
export type ProviderCoverage = "complete" | "partial" | "demo";
export type FreshnessState = "fresh" | "stale" | "unknown" | "fixture";

export interface ProviderReport extends ProviderHealth {
  capabilities: ProviderCapability[];
  attempted: boolean;
}

export interface FreshnessReport {
  state: FreshnessState;
  asOf: string | null;
  ageSeconds: number | null;
}

export interface OrchestrationMeta {
  dataMode: DataMode;
  mode: DataMode;
  providerCoverage: ProviderCoverage;
  coverage: ProviderCoverage;
  generatedAt: string;
  freshness: FreshnessReport;
  providers: ProviderReport[];
  fallbackReason?: "provider_unconfigured" | "provider_request_failed";
  notice: string;
}

export interface OrchestratedSnapshot {
  data: MarketSnapshot | null;
  meta: OrchestrationMeta;
}

export interface IntelligenceFeedItem {
  id: string;
  symbolIds: CanonicalSymbol[];
  source: string;
  sourceKind: SourceKind | "demo_fixture";
  headline: string;
  summary: string | null;
  publishedAt: string;
  receivedAt: string;
  providerUpdatedAt?: string;
  sourceUrl: string | null;
  materiality: Materiality;
  isLive: boolean;
  category?: IntelligenceEvent["category"];
  claimStatus?: ClaimStatus;
  causalLink?: CausalLink;
  topicTags?: string[];
  isControversial?: boolean;
}

export interface OrchestratedIntelligenceFeed {
  data: IntelligenceFeedItem[];
  meta: OrchestrationMeta;
}

type IntelligenceProviderRegistration = {
  provider: IntelligenceSourceProvider;
  capabilities: ProviderCapability[];
};

type OrchestratorDependencies = {
  marketProvider: MarketDataProvider;
  marketCapabilities?: ProviderCapability[];
  intelligenceProviders: IntelligenceProviderRegistration[];
  getDemoSnapshot?: (symbol: CanonicalSymbol) => MarketSnapshot | null;
  getDemoEvents?: (options: {
    symbolId?: CanonicalSymbol;
    minimumMateriality?: Materiality;
    limit?: number;
  }) => IntelligenceEvent[];
  now?: () => Date;
};

const SEC_CIK_BY_TICKER: Record<string, string> = {
  AAPL: "320193",
  AMD: "2488",
  MSFT: "789019",
  NVDA: "1045810",
  TSLA: "1318605",
};

const LIVE_NOTICE =
  "Live public or licensed provider data. Verify source timestamps before relying on time-sensitive information.";
const DEMO_NOTICE =
  "Demo fixture data is being shown because live providers are unavailable. It is not current market data.";
const MAX_PROVIDER_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const materialityRank: Record<Materiality, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function errorMessage(provider: string) {
  return `${provider} could not be reached. Omnigaze did not treat fixture data as live.`;
}

function partialCoverageMessage(provider: string) {
  return `${provider} returned partial live coverage; successful results were retained.`;
}

function tickerFromSymbol(symbol: CanonicalSymbol) {
  return symbol.split(":")[1];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function asHttpUrl(value: unknown) {
  const candidate = asString(value);
  if (!candidate) return null;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function eventObservationAt(
  event: { publishedAt: string; providerUpdatedAt?: string },
  now: Date,
) {
  const publishedTimestamp = Date.parse(event.publishedAt);
  const providerTimestamp = event.providerUpdatedAt
    ? Date.parse(event.providerUpdatedAt)
    : Number.NaN;
  const providerTimestampIsUsable =
    Number.isFinite(providerTimestamp) &&
    providerTimestamp <= now.getTime() + MAX_PROVIDER_CLOCK_SKEW_MS;
  return providerTimestampIsUsable &&
    (!Number.isFinite(publishedTimestamp) || providerTimestamp > publishedTimestamp)
    ? event.providerUpdatedAt!
    : event.publishedAt;
}

function laterObservation(latest: string | null, candidate: string) {
  if (!latest) return candidate;
  const latestTimestamp = Date.parse(latest);
  const candidateTimestamp = Date.parse(candidate);
  return Number.isFinite(candidateTimestamp) &&
    (!Number.isFinite(latestTimestamp) || candidateTimestamp > latestTimestamp)
    ? candidate
    : latest;
}

function freshnessFor(
  asOf: string | null,
  now: Date,
  options: { fixture?: boolean; allowedAgeSeconds?: number } = {},
): FreshnessReport {
  if (options.fixture) return { state: "fixture", asOf, ageSeconds: null };
  if (!asOf) return { state: "unknown", asOf: null, ageSeconds: null };

  const timestamp = Date.parse(asOf);
  if (!Number.isFinite(timestamp)) return { state: "unknown", asOf, ageSeconds: null };
  if (timestamp > now.getTime() + MAX_PROVIDER_CLOCK_SKEW_MS) {
    return { state: "unknown", asOf, ageSeconds: null };
  }

  const ageSeconds = Math.max(0, Math.round((now.getTime() - timestamp) / 1_000));
  return {
    state: ageSeconds <= (options.allowedAgeSeconds ?? 1_200) ? "fresh" : "stale",
    asOf,
    ageSeconds,
  };
}

async function safeHealth(
  provider: MarketDataProvider | IntelligenceSourceProvider,
  capabilities: ProviderCapability[],
  now: Date,
): Promise<ProviderReport> {
  try {
    return {
      ...(await provider.getHealth()),
      capabilities,
      attempted: false,
    };
  } catch {
    return {
      provider: provider.name,
      status: "degraded",
      checkedAt: now.toISOString(),
      latestObservedAt: null,
      message: errorMessage(provider.name),
      capabilities,
      attempted: false,
    };
  }
}

function normalizeRawEvent(
  event: RawSourceEvent,
  requestedSymbols: CanonicalSymbol[],
): IntelligenceFeedItem {
  const payload = asRecord(event.payload);
  const tickerMap = new Map(requestedSymbols.map((symbol) => [tickerFromSymbol(symbol), symbol]));

  if (event.sourceKind === "sec_filing") {
    const requested = new Set(requestedSymbols);
    const legacySymbol = asString(payload.symbol);
    const rawSymbols = Array.isArray(payload.symbols)
      ? payload.symbols
      : legacySymbol
        ? [legacySymbol]
        : [];
    const symbolIds = [
      ...new Set(
        rawSymbols.flatMap((rawSymbol) => {
          if (typeof rawSymbol !== "string") return [];
          const candidate = rawSymbol.trim().toUpperCase() as CanonicalSymbol;
          if (requested.has(candidate)) return [candidate];
          const mapped = tickerMap.get(candidate);
          return mapped ? [mapped] : [];
        }),
      ),
    ].sort();
    const form = asString(payload.form) ?? "SEC filing";
    const accession = asString(payload.accessionNumber);
    const cik = asString(payload.cik)?.replace(/^0+/, "");
    const document = asString(payload.primaryDocument);
    const sourceUrl =
      cik && accession && document
        ? `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replaceAll("-", "")}/${document}`
        : null;

    return {
      id: `${event.source}:${event.sourceEventId}`,
      symbolIds,
      source: event.source,
      sourceKind: event.sourceKind,
      headline: `${form} filed with the SEC`,
      summary: "A new regulatory filing is available for evidence review.",
      publishedAt: event.publishedAt,
      receivedAt: event.receivedAt,
      providerUpdatedAt: event.providerUpdatedAt ?? event.publishedAt,
      sourceUrl,
      materiality: ["10-K", "10-Q", "8-K"].includes(form) ? "high" : "medium",
      isLive: true,
      category: "filing",
      claimStatus: "confirmed",
      causalLink: "unassessed",
      topicTags: ["filing"],
      isControversial: false,
    };
  }

  const payloadSymbols = Array.isArray(payload.symbols)
    ? payload.symbols
        .filter((value): value is string => typeof value === "string")
        .map((ticker) => tickerMap.get(ticker))
        .filter((symbol): symbol is CanonicalSymbol => Boolean(symbol))
    : [];

  const decodedHeadline = decodeHtmlEntities(
    asString(payload.headline) ?? "",
  ).trim();
  const headline = decodedHeadline || "Market intelligence update";
  const rawSummary = asString(payload.summary);
  const decodedSummary = rawSummary
    ? decodeHtmlEntities(rawSummary).trim()
    : "";
  const summary = decodedSummary || null;
  const classification = classifyPublicEvent({
    headline,
    summary,
    sourceKind: event.sourceKind,
  });

  return {
    id: `${event.source}:${event.sourceEventId}`,
    symbolIds: payloadSymbols,
    source: event.source,
    sourceKind: event.sourceKind,
    headline,
    summary,
    publishedAt: event.publishedAt,
    receivedAt: event.receivedAt,
    providerUpdatedAt: event.providerUpdatedAt ?? event.publishedAt,
    sourceUrl: asHttpUrl(payload.url),
    materiality: classification.materiality,
    isLive: true,
    category: classification.category,
    claimStatus: classification.claimStatus,
    causalLink: classification.causalLink,
    topicTags: classification.topicTags,
    isControversial: classification.isControversial,
  };
}

function demoFeedItem(event: IntelligenceEvent): IntelligenceFeedItem {
  return {
    id: `demo:${event.id}`,
    symbolIds: [event.symbolId],
    source: "omnigaze-demo",
    sourceKind: "demo_fixture",
    headline: event.headline,
    summary: event.summary,
    publishedAt: event.occurredAt,
    receivedAt: event.occurredAt,
    providerUpdatedAt: event.occurredAt,
    sourceUrl: null,
    materiality: event.materiality,
    isLive: false,
    category: event.category,
    claimStatus: event.claimStatus,
    causalLink: event.causalLink,
    topicTags: event.topicTags,
    isControversial: ["governance", "executive", "legal", "regulatory", "reputation"].includes(
      event.category,
    ),
  };
}

function mergeProviderReports(reports: ProviderReport[]) {
  const statusRank: Record<ProviderHealth["status"], number> = {
    healthy: 0,
    unconfigured: 1,
    degraded: 2,
  };
  const merged = new Map<string, ProviderReport>();

  for (const report of reports) {
    const current = merged.get(report.provider);
    if (!current) {
      merged.set(report.provider, report);
      continue;
    }

    const status =
      statusRank[report.status] > statusRank[current.status] ? report.status : current.status;
    merged.set(report.provider, {
      ...current,
      status,
      checkedAt: report.checkedAt > current.checkedAt ? report.checkedAt : current.checkedAt,
      latestObservedAt:
        report.latestObservedAt &&
        (!current.latestObservedAt || report.latestObservedAt > current.latestObservedAt)
          ? report.latestObservedAt
          : current.latestObservedAt,
      message: report.message ?? current.message,
      capabilities: [...new Set([...current.capabilities, ...report.capabilities])],
      attempted: current.attempted || report.attempted,
    });
  }

  return [...merged.values()];
}

export class LiveMarketDataOrchestrator {
  private readonly marketCapabilities: ProviderCapability[];
  private readonly getDemoSnapshot: NonNullable<OrchestratorDependencies["getDemoSnapshot"]>;
  private readonly getDemoEvents: NonNullable<OrchestratorDependencies["getDemoEvents"]>;
  private readonly now: () => Date;

  constructor(private readonly dependencies: OrchestratorDependencies) {
    this.marketCapabilities = dependencies.marketCapabilities ?? ["market-snapshot"];
    this.getDemoSnapshot = dependencies.getDemoSnapshot ?? getDemoMarketSnapshot;
    this.getDemoEvents = dependencies.getDemoEvents ?? getDemoIntelligenceFeed;
    this.now = dependencies.now ?? (() => new Date());
  }

  async getProviderStatus() {
    const now = this.now();
    const reports = mergeProviderReports(await Promise.all([
      safeHealth(this.dependencies.marketProvider, this.marketCapabilities, now),
      ...this.dependencies.intelligenceProviders.map(({ provider, capabilities }) =>
        safeHealth(provider, capabilities, now),
      ),
    ]));

    return {
      checkedAt: now.toISOString(),
      providers: reports,
      liveCapabilities: reports
        .filter((report) => report.status === "healthy")
        .flatMap((report) => report.capabilities),
    };
  }

  async getSnapshot(symbol: CanonicalSymbol): Promise<OrchestratedSnapshot> {
    const now = this.now();
    let report = await safeHealth(
      this.dependencies.marketProvider,
      this.marketCapabilities,
      now,
    );
    let fallbackReason: OrchestrationMeta["fallbackReason"] = "provider_unconfigured";

    if (report.status === "healthy") {
      try {
        const snapshot = await this.dependencies.marketProvider.getSnapshot(symbol);
        report = {
          ...report,
          attempted: true,
          latestObservedAt: snapshot.asOf,
        };
        return {
          data: snapshot,
          meta: {
            dataMode: "live",
            mode: "live",
            providerCoverage:
              snapshot.marketCoverage === "limited-exchange" ? "partial" : "complete",
            coverage:
              snapshot.marketCoverage === "limited-exchange" ? "partial" : "complete",
            generatedAt: now.toISOString(),
            freshness: freshnessFor(snapshot.asOf, now, {
              allowedAgeSeconds: Math.max(1_200, snapshot.delaySeconds + 300),
            }),
            providers: [report],
            notice: LIVE_NOTICE,
          },
        };
      } catch {
        fallbackReason = "provider_request_failed";
        report = {
          ...report,
          status: "degraded",
          attempted: true,
          message: errorMessage(report.provider),
        };
      }
    }

    const fixture = this.getDemoSnapshot(symbol);
    return {
      data: fixture,
      meta: {
        dataMode: "demo",
        mode: "demo",
        providerCoverage: "demo",
        coverage: "demo",
        generatedAt: now.toISOString(),
        freshness: freshnessFor(fixture?.asOf ?? null, now, { fixture: true }),
        providers: [report],
        fallbackReason,
        notice: DEMO_NOTICE,
      },
    };
  }

  async getSnapshots(
    symbols: CanonicalSymbol[],
  ): Promise<ReadonlyMap<CanonicalSymbol, OrchestratedSnapshot>> {
    const uniqueSymbols = [...new Set(symbols)];
    const results = new Map<CanonicalSymbol, OrchestratedSnapshot>();
    if (uniqueSymbols.length === 0) return results;

    const now = this.now();
    const initialReport = await safeHealth(
      this.dependencies.marketProvider,
      this.marketCapabilities,
      now,
    );

    const fixtureResult = (
      symbol: CanonicalSymbol,
      report: ProviderReport,
      fallbackReason: NonNullable<OrchestrationMeta["fallbackReason"]>,
    ): OrchestratedSnapshot => {
      const fixture = this.getDemoSnapshot(symbol);
      return {
        data: fixture,
        meta: {
          dataMode: "demo",
          mode: "demo",
          providerCoverage: "demo",
          coverage: "demo",
          generatedAt: now.toISOString(),
          freshness: freshnessFor(fixture?.asOf ?? null, now, { fixture: true }),
          providers: [report],
          fallbackReason,
          notice: DEMO_NOTICE,
        },
      };
    };

    if (initialReport.status !== "healthy") {
      for (const symbol of uniqueSymbols) {
        results.set(
          symbol,
          fixtureResult(symbol, initialReport, "provider_unconfigured"),
        );
      }
      return results;
    }

    const snapshots = new Map<CanonicalSymbol, MarketSnapshot>();
    const batchMethod = this.dependencies.marketProvider.getSnapshots;

    if (batchMethod) {
      try {
        const batch = await batchMethod.call(
          this.dependencies.marketProvider,
          uniqueSymbols,
        );
        for (const symbol of uniqueSymbols) {
          const snapshot = batch.get(symbol);
          if (snapshot?.symbolId === symbol) snapshots.set(symbol, snapshot);
        }
      } catch {
        // A failed batch degrades every requested symbol independently below.
      }
    } else {
      const outcomes = await Promise.allSettled(
        uniqueSymbols.map((symbol) =>
          this.dependencies.marketProvider.getSnapshot(symbol),
        ),
      );
      outcomes.forEach((outcome, index) => {
        const symbol = uniqueSymbols[index];
        if (
          outcome.status === "fulfilled" &&
          outcome.value.symbolId === symbol
        ) {
          snapshots.set(symbol, outcome.value);
        }
      });
    }

    for (const symbol of uniqueSymbols) {
      const snapshot = snapshots.get(symbol);
      if (snapshot) {
        const report: ProviderReport = {
          ...initialReport,
          attempted: true,
          latestObservedAt: snapshot.asOf,
        };
        const coverage =
          snapshot.marketCoverage === "limited-exchange" ? "partial" : "complete";
        results.set(symbol, {
          data: snapshot,
          meta: {
            dataMode: "live",
            mode: "live",
            providerCoverage: coverage,
            coverage,
            generatedAt: now.toISOString(),
            freshness: freshnessFor(snapshot.asOf, now, {
              allowedAgeSeconds: Math.max(1_200, snapshot.delaySeconds + 300),
            }),
            providers: [report],
            notice: LIVE_NOTICE,
          },
        });
        continue;
      }

      const report: ProviderReport = {
        ...initialReport,
        status: "degraded",
        attempted: true,
        message: errorMessage(initialReport.provider),
      };
      results.set(
        symbol,
        fixtureResult(symbol, report, "provider_request_failed"),
      );
    }

    return results;
  }

  async getIntelligenceFeed(options: {
    symbols?: CanonicalSymbol[];
    since: string;
    limit: number;
    minimumMateriality?: Materiality;
  }): Promise<OrchestratedIntelligenceFeed> {
    const now = this.now();
    const symbols = options.symbols?.length ? options.symbols : defaultWatchlist;
    const registrations = this.dependencies.intelligenceProviders;
    const initialReports = await Promise.all(
      registrations.map(({ provider, capabilities }) => safeHealth(provider, capabilities, now)),
    );

    const outcomes = await Promise.all(
      registrations.map(async ({ provider }, index) => {
        const report = initialReports[index];
        if (report.status !== "healthy") return { report, events: null };

        try {
          const result: IntelligenceSourceResult = await provider.getLatestEvents({
            symbols,
            since: options.since,
            limit: options.limit,
          });
          const events = Array.isArray(result) ? result : result.events;
          const partial = !Array.isArray(result) && result.coverage === "partial";
          const latestObservedAt = events.reduce<string | null>((latest, event) => {
            const observedAt = eventObservationAt(event, now);
            return laterObservation(latest, observedAt);
          }, null);
          return {
            report: {
              ...report,
              ...(partial
                ? {
                    status: "degraded" as const,
                    message: partialCoverageMessage(report.provider),
                  }
                : {}),
              attempted: true,
              latestObservedAt,
            },
            events,
          };
        } catch {
          return {
            report: {
              ...report,
              status: "degraded" as const,
              attempted: true,
              message: errorMessage(report.provider),
            },
            events: null,
          };
        }
      }),
    );

    const successfulOutcomes = outcomes.filter(
      (outcome): outcome is typeof outcome & { events: RawSourceEvent[] } => outcome.events !== null,
    );
    const reports = outcomes.map(({ report }) => report);

    if (successfulOutcomes.length > 0) {
      const items = successfulOutcomes
        .flatMap(({ events }) => events.map((event) => normalizeRawEvent(event, symbols)))
        .filter(
          (item) =>
            materialityRank[item.materiality] >=
            materialityRank[options.minimumMateriality ?? "low"],
        )
        .sort((left, right) => {
          const leftObservedAt = Date.parse(eventObservationAt(left, now));
          const rightObservedAt = Date.parse(eventObservationAt(right, now));
          const byObservation =
            (Number.isFinite(rightObservedAt) ? rightObservedAt : Number.NEGATIVE_INFINITY) -
            (Number.isFinite(leftObservedAt) ? leftObservedAt : Number.NEGATIVE_INFINITY);
          return (
            byObservation ||
            right.publishedAt.localeCompare(left.publishedAt) ||
            left.id.localeCompare(right.id)
          );
        })
        .slice(0, Math.max(1, Math.min(options.limit, 100)));
      const newest = items.reduce<string | null>((latest, item) => {
        const observedAt = eventObservationAt(item, now);
        return laterObservation(latest, observedAt);
      }, null);

      return {
        data: items,
        meta: {
          dataMode: "live",
          mode: "live",
          providerCoverage:
            successfulOutcomes.length === registrations.length &&
            reports.every((report) => report.status === "healthy")
              ? "complete"
              : "partial",
          coverage:
            successfulOutcomes.length === registrations.length &&
            reports.every((report) => report.status === "healthy")
              ? "complete"
              : "partial",
          generatedAt: now.toISOString(),
          freshness: freshnessFor(newest, now, { allowedAgeSeconds: 86_400 }),
          providers: reports,
          notice: LIVE_NOTICE,
        },
      };
    }

    const symbolFilter = symbols.length === 1 ? symbols[0] : undefined;
    const fixtures = this.getDemoEvents({
      symbolId: symbolFilter,
      minimumMateriality: options.minimumMateriality,
      limit: options.limit,
    }).map(demoFeedItem);

    return {
      data: fixtures,
      meta: {
        dataMode: "demo",
        mode: "demo",
        providerCoverage: "demo",
        coverage: "demo",
        generatedAt: now.toISOString(),
        freshness: freshnessFor(fixtures[0]?.publishedAt ?? null, now, { fixture: true }),
        providers: reports,
        fallbackReason: reports.some((report) => report.attempted)
          ? "provider_request_failed"
          : "provider_unconfigured",
        notice: DEMO_NOTICE,
      },
    };
  }
}

export function createLiveMarketDataOrchestrator(
  environment: Record<string, string | undefined> = process.env,
) {
  const alpaca = new AlpacaProvider({
    keyId: environment.ALPACA_API_KEY_ID,
    secretKey: environment.ALPACA_API_SECRET_KEY,
    feed:
      environment.ALPACA_DATA_FEED === "sip" ||
      environment.ALPACA_DATA_FEED === "delayed_sip"
        ? environment.ALPACA_DATA_FEED
        : "iex",
  });
  const sec = new SecEdgarProvider({
    // A truthful user agent is necessary but not sufficient for activation.
    // Keep production egress fail-closed until requests use a distributed
    // Fair Access coordinator shared by every Worker isolate.
    enabled: false,
    userAgent: environment.SEC_USER_AGENT,
    cikByTicker: SEC_CIK_BY_TICKER,
  });

  return new LiveMarketDataOrchestrator({
    marketProvider: alpaca,
    marketCapabilities: ["market-snapshot"],
    intelligenceProviders: [
      { provider: alpaca, capabilities: ["market-news"] },
      { provider: sec, capabilities: ["sec-filings"] },
    ],
  });
}

export const liveMarketData = createLiveMarketDataOrchestrator();
