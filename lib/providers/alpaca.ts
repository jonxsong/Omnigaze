import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import type { ProviderHealth, RawSourceEvent } from "@/lib/pipeline/contracts";
import {
  ProviderConfigurationError,
  type IntelligenceSourceProvider,
  type MarketDataProvider,
} from "./contracts";

type AlpacaConfig = {
  keyId?: string;
  secretKey?: string;
  feed?: "iex" | "sip";
};

function tickerFromSymbol(symbol: CanonicalSymbol) {
  return symbol.split(":")[1];
}

export class AlpacaProvider
  implements MarketDataProvider, IntelligenceSourceProvider
{
  readonly name = "alpaca";

  constructor(private readonly config: AlpacaConfig) {}

  private headers() {
    if (!this.config.keyId || !this.config.secretKey) {
      throw new ProviderConfigurationError(this.name, [
        "ALPACA_API_KEY_ID",
        "ALPACA_API_SECRET_KEY",
      ]);
    }

    return {
      "APCA-API-KEY-ID": this.config.keyId,
      "APCA-API-SECRET-KEY": this.config.secretKey,
    };
  }

  async getSnapshot(symbol: CanonicalSymbol): Promise<MarketSnapshot> {
    const ticker = tickerFromSymbol(symbol);
    const response = await fetch(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/snapshot?feed=${this.config.feed ?? "iex"}`,
      { headers: this.headers(), signal: AbortSignal.timeout(8_000) },
    );

    if (!response.ok) {
      throw new Error(`Alpaca snapshot failed with ${response.status}`);
    }

    const data = (await response.json()) as {
      latestTrade?: { p?: number; t?: string };
      dailyBar?: { c?: number; v?: number };
      prevDailyBar?: { c?: number };
    };
    const price = data.latestTrade?.p ?? data.dailyBar?.c;
    const previousClose = data.prevDailyBar?.c;
    if (typeof price !== "number" || typeof previousClose !== "number") {
      throw new Error("Alpaca returned an incomplete snapshot");
    }

    const change = price - previousClose;
    return {
      symbolId: symbol,
      asOf: data.latestTrade?.t ?? new Date().toISOString(),
      session: "regular",
      price,
      previousClose,
      change,
      changePercent: (change / previousClose) * 100,
      volume: data.dailyBar?.v ?? 0,
      marketCap: "Unavailable",
      isDelayed: this.config.feed !== "sip",
      delaySeconds: this.config.feed === "sip" ? 0 : 900,
      provider: `Alpaca ${this.config.feed ?? "iex"}`,
    };
  }

  async getLatestEvents(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
  }): Promise<RawSourceEvent[]> {
    const symbols = options.symbols.map(tickerFromSymbol).join(",");
    const url = new URL("https://data.alpaca.markets/v1beta1/news");
    url.searchParams.set("symbols", symbols);
    url.searchParams.set("start", options.since);
    url.searchParams.set("limit", String(Math.min(options.limit, 50)));
    url.searchParams.set("sort", "desc");

    const response = await fetch(url, {
      headers: this.headers(),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error(`Alpaca news failed with ${response.status}`);

    const data = (await response.json()) as {
      news?: Array<{
        id: number;
        headline: string;
        summary?: string;
        created_at: string;
        updated_at: string;
        url?: string;
        symbols?: string[];
      }>;
    };

    return (data.news ?? []).map((item) => ({
      source: this.name,
      sourceKind: "licensed_news",
      sourceEventId: String(item.id),
      receivedAt: new Date().toISOString(),
      publishedAt: item.created_at,
      payload: item,
    }));
  }

  async getHealth(): Promise<ProviderHealth> {
    const configured = Boolean(this.config.keyId && this.config.secretKey);
    return {
      provider: this.name,
      status: configured ? "healthy" : "unconfigured",
      checkedAt: new Date().toISOString(),
      latestObservedAt: null,
      message: configured ? undefined : "API credentials have not been configured.",
    };
  }
}
