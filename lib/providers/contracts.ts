import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import type { ProviderHealth, RawSourceEvent } from "@/lib/pipeline/contracts";

export interface MarketDataProvider {
  readonly name: string;
  getSnapshot(symbol: CanonicalSymbol): Promise<MarketSnapshot>;
  getSnapshots?(
    symbols: CanonicalSymbol[],
  ): Promise<ReadonlyMap<CanonicalSymbol, MarketSnapshot>>;
  getHealth(): Promise<ProviderHealth>;
}

export interface IntelligenceSourceProvider {
  readonly name: string;
  getLatestEvents(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
  }): Promise<IntelligenceSourceResult>;
  getHealth(): Promise<ProviderHealth>;
}

/**
 * A provider may retain successful peer results when only part of a bounded
 * batch failed. Consumers must surface partial coverage instead of silently
 * treating this envelope as a complete provider response.
 */
export type PartialIntelligenceSourceResult = {
  events: RawSourceEvent[];
  coverage: "partial";
};

export type IntelligenceSourceResult =
  | RawSourceEvent[]
  | PartialIntelligenceSourceResult;

export type IntelligenceEventPageCursor = {
  token: string;
  queryFingerprint: string;
};

export type IntelligenceEventPageRequest = {
  symbols: CanonicalSymbol[];
  windowStart: string;
  windowEnd: string;
  pageSize: number;
  cursor?: IntelligenceEventPageCursor | null;
  signal?: AbortSignal;
};

export type IntelligenceEventPage = {
  events: RawSourceEvent[];
  nextCursor: IntelligenceEventPageCursor | null;
  exhausted: boolean;
  queryFingerprint: string;
};

export interface PaginatedIntelligenceSourceProvider
  extends IntelligenceSourceProvider {
  getEventPage(
    options: IntelligenceEventPageRequest,
  ): Promise<IntelligenceEventPage>;
}

export class ProviderCursorMismatchError extends Error {
  constructor(provider: string) {
    super(`${provider} cursor does not match the frozen query window`);
    this.name = "ProviderCursorMismatchError";
  }
}

export class ProviderCursorRejectedError extends Error {
  constructor(provider: string) {
    super(`${provider} rejected the stored page cursor`);
    this.name = "ProviderCursorRejectedError";
  }
}

export class ProviderConfigurationError extends Error {
  constructor(provider: string, missingKeys: string[]) {
    super(`${provider} is not configured. Missing: ${missingKeys.join(", ")}`);
    this.name = "ProviderConfigurationError";
  }
}
