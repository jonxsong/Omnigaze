import type { CanonicalSymbol } from "@/lib/market-types";
import type { ProviderHealth, RawSourceEvent } from "@/lib/pipeline/contracts";
import type { IntelligenceSourceProvider } from "./contracts";

type SecEdgarConfig = {
  userAgent?: string;
  cikByTicker?: Record<string, string>;
  fetcher?: typeof fetch;
  now?: () => number;
};

const MAX_REQUESTS_PER_WINDOW = 8;
const RATE_LIMIT_WINDOW_MS = 1_000;
const TICKER_CATALOG_TTL_MS = 24 * 60 * 60 * 1_000;
const TICKER_CATALOG_URL = "https://www.sec.gov/files/company_tickers.json";

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class SecEdgarProvider implements IntelligenceSourceProvider {
  readonly name = "sec-edgar";
  private tickerCatalog: { fetchedAt: number; cikByTicker: Map<string, string> } | null =
    null;
  private tickerCatalogRequest: Promise<Map<string, string>> | null = null;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly config: SecEdgarConfig) {
    this.fetcher = config.fetcher ?? fetch;
    this.now = config.now ?? Date.now;
  }

  private headers() {
    if (!this.config.userAgent) {
      throw new Error("SEC_USER_AGENT must identify the Omnigaze application and operator.");
    }
    return { "User-Agent": this.config.userAgent, Accept: "application/json" };
  }

  private async loadTickerCatalog() {
    const cached = this.tickerCatalog;
    if (cached && this.now() - cached.fetchedAt <= TICKER_CATALOG_TTL_MS) {
      return cached.cikByTicker;
    }
    if (this.tickerCatalogRequest) return this.tickerCatalogRequest;

    const request = (async () => {
      const response = await this.fetcher(TICKER_CATALOG_URL, {
        headers: this.headers(),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) {
        throw new Error(`SEC ticker catalog failed with ${response.status}`);
      }
      const payload = (await response.json()) as unknown;
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new Error("SEC ticker catalog returned an invalid response");
      }

      const cikByTicker = new Map<string, string>();
      for (const value of Object.values(payload as Record<string, unknown>)) {
        if (!value || typeof value !== "object" || Array.isArray(value)) continue;
        const record = value as Record<string, unknown>;
        if (
          typeof record.ticker !== "string" ||
          (typeof record.cik_str !== "number" && typeof record.cik_str !== "string")
        ) {
          continue;
        }
        const ticker = record.ticker.trim().toUpperCase();
        const cik = String(record.cik_str).replace(/^0+/, "");
        if (/^[A-Z0-9._-]+$/.test(ticker) && /^\d+$/.test(cik)) {
          cikByTicker.set(ticker, cik);
        }
      }
      if (cikByTicker.size === 0) {
        throw new Error("SEC ticker catalog returned an invalid response");
      }
      this.tickerCatalog = { fetchedAt: this.now(), cikByTicker };
      return cikByTicker;
    })();
    this.tickerCatalogRequest = request;

    try {
      return await request;
    } catch (error) {
      if (cached) return cached.cikByTicker;
      throw error;
    } finally {
      if (this.tickerCatalogRequest === request) this.tickerCatalogRequest = null;
    }
  }

  private async resolveCik(ticker: string) {
    const configured = this.config.cikByTicker?.[ticker];
    if (configured) return configured;
    return (await this.loadTickerCatalog()).get(ticker) ?? null;
  }

  async getLatestEvents(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
  }): Promise<RawSourceEvent[]> {
    this.headers();

    const fetchSymbol = async (symbol: CanonicalSymbol) => {
        const ticker = symbol.split(":")[1];
        const resolvedCik = await this.resolveCik(ticker);
        const cik = resolvedCik?.padStart(10, "0");
        if (!cik) return [];

        const response = await this.fetcher(`https://data.sec.gov/submissions/CIK${cik}.json`, {
          headers: this.headers(),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new Error(`SEC submissions failed with ${response.status}`);

        const data = (await response.json()) as {
          filings?: {
            recent?: {
              accessionNumber?: string[];
              filingDate?: string[];
              acceptanceDateTime?: string[];
              form?: string[];
              primaryDocument?: string[];
            };
          };
        };
        const recent = data.filings?.recent;
        if (!recent?.accessionNumber) return [];

        return recent.accessionNumber
          .map((accessionNumber, index) => ({
            accessionNumber,
            filingDate: recent.filingDate?.[index],
            acceptedAt: recent.acceptanceDateTime?.[index],
            form: recent.form?.[index],
            primaryDocument: recent.primaryDocument?.[index],
            symbol,
            cik,
          }))
          .filter((filing) => (filing.acceptedAt ?? filing.filingDate ?? "") >= options.since)
          .slice(0, options.limit)
          .map<RawSourceEvent>((filing) => ({
            source: this.name,
            sourceKind: "sec_filing",
            sourceEventId: filing.accessionNumber,
            receivedAt: new Date().toISOString(),
            publishedAt: filing.acceptedAt ?? `${filing.filingDate}T00:00:00.000Z`,
            payload: filing,
          }));
      };

    const results: RawSourceEvent[][] = [];
    for (let offset = 0; offset < options.symbols.length; offset += MAX_REQUESTS_PER_WINDOW) {
      if (offset > 0) await wait(RATE_LIMIT_WINDOW_MS);
      const batch = options.symbols.slice(offset, offset + MAX_REQUESTS_PER_WINDOW);
      results.push(...(await Promise.all(batch.map(fetchSymbol))));
    }

    return results.flat().slice(0, options.limit);
  }

  async getHealth(): Promise<ProviderHealth> {
    return {
      provider: this.name,
      status: this.config.userAgent ? "healthy" : "unconfigured",
      checkedAt: new Date().toISOString(),
      latestObservedAt: null,
      message: this.config.userAgent ? undefined : "SEC_USER_AGENT is not configured.",
    };
  }
}
