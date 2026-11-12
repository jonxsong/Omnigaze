import type { CanonicalSymbol } from "@/lib/market-types";
import type { ProviderHealth, RawSourceEvent } from "@/lib/pipeline/contracts";
import type { IntelligenceSourceProvider } from "./contracts";

type SecEdgarConfig = {
  userAgent?: string;
  cikByTicker: Record<string, string>;
};

const MAX_REQUESTS_PER_WINDOW = 8;
const RATE_LIMIT_WINDOW_MS = 1_000;

function wait(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class SecEdgarProvider implements IntelligenceSourceProvider {
  readonly name = "sec-edgar";

  constructor(private readonly config: SecEdgarConfig) {}

  async getLatestEvents(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
  }): Promise<RawSourceEvent[]> {
    if (!this.config.userAgent) {
      throw new Error("SEC_USER_AGENT must identify the Omnigaze application and operator.");
    }

    const fetchSymbol = async (symbol: CanonicalSymbol) => {
        const ticker = symbol.split(":")[1];
        const cik = this.config.cikByTicker[ticker]?.padStart(10, "0");
        if (!cik) return [];

        const response = await fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, {
          headers: { "User-Agent": this.config.userAgent!, Accept: "application/json" },
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
