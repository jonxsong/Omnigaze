import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import type { ProviderHealth, RawSourceEvent } from "@/lib/pipeline/contracts";

export interface MarketDataProvider {
  readonly name: string;
  getSnapshot(symbol: CanonicalSymbol): Promise<MarketSnapshot>;
  getHealth(): Promise<ProviderHealth>;
}

export interface IntelligenceSourceProvider {
  readonly name: string;
  getLatestEvents(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
  }): Promise<RawSourceEvent[]>;
  getHealth(): Promise<ProviderHealth>;
}

export class ProviderConfigurationError extends Error {
  constructor(provider: string, missingKeys: string[]) {
    super(`${provider} is not configured. Missing: ${missingKeys.join(", ")}`);
    this.name = "ProviderConfigurationError";
  }
}
