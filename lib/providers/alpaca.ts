import type {
  CanonicalSymbol,
  HistoricalBar,
  HistoricalMarketSeries,
  MarketSnapshot,
} from "@/lib/market-types";
import type { ProviderHealth, RawSourceEvent } from "@/lib/pipeline/contracts";
import {
  ProviderConfigurationError,
  ProviderCursorMismatchError,
  ProviderCursorRejectedError,
  type IntelligenceEventPage,
  type IntelligenceEventPageRequest,
  type MarketDataProvider,
  type PaginatedIntelligenceSourceProvider,
} from "./contracts";
import {
  boundedProviderRetryAfterSeconds,
  ProviderEgressGuardError,
  type ProviderEgressAdmissionGuard,
  type ProviderEgressBucket,
} from "./provider-egress-guard";

export type AlpacaProviderConfig = {
  keyId?: string;
  secretKey?: string;
  feed?: "iex" | "sip" | "delayed_sip";
  egressGuard?: ProviderEgressAdmissionGuard;
};

export type HistoricalRange = HistoricalMarketSeries["timeframe"];

type HistoricalBarsOptions = {
  range: HistoricalRange;
  timeframe: string;
  start: string;
  end: string;
  limit?: number;
};

const ALPACA_NEWS_PAGE_SIZE = 50;
const ALPACA_NEWS_RESULT_LIMIT = 100;
const ALPACA_NEWS_MAX_PAGES = 4;
const ALPACA_REQUEST_TIMEOUT_MS = 8_000;
const ALPACA_PAGE_TOKEN_MAX_LENGTH = 2_048;

type AlpacaNewsItem = {
  id: number | string;
  headline: string;
  summary?: string;
  created_at: string;
  updated_at: string;
  url?: string | null;
  symbols?: string[];
};

type AlpacaSnapshotPayload = {
  latestTrade?: { p?: number; t?: string };
  dailyBar?: { c?: number; v?: number; t?: string };
  prevDailyBar?: { c?: number };
};

function isAlpacaNewsItem(value: unknown): value is AlpacaNewsItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  const idIsValid =
    (typeof item.id === "number" && Number.isFinite(item.id)) ||
    (typeof item.id === "string" && item.id.trim().length > 0);
  return (
    idIsValid &&
    typeof item.headline === "string" &&
    item.headline.trim().length > 0 &&
    typeof item.created_at === "string" &&
    Number.isFinite(Date.parse(item.created_at))
  );
}

function tickerFromSymbol(symbol: CanonicalSymbol) {
  return symbol.split(":")[1];
}

function normalizeSnapshot(
  symbol: CanonicalSymbol,
  data: AlpacaSnapshotPayload,
  feed: NonNullable<AlpacaProviderConfig["feed"]>,
): MarketSnapshot {
  const price = data.latestTrade?.p ?? data.dailyBar?.c;
  const previousClose = data.prevDailyBar?.c;
  const asOf = data.latestTrade?.t ?? data.dailyBar?.t;
  if (
    typeof price !== "number" ||
    !Number.isFinite(price) ||
    typeof previousClose !== "number" ||
    !Number.isFinite(previousClose) ||
    previousClose === 0 ||
    typeof asOf !== "string" ||
    !Number.isFinite(Date.parse(asOf))
  ) {
    throw new Error("Alpaca returned an incomplete snapshot");
  }

  const change = price - previousClose;
  return {
    symbolId: symbol,
    asOf,
    session: "regular",
    price,
    previousClose,
    change,
    changePercent: (change / previousClose) * 100,
    volume:
      typeof data.dailyBar?.v === "number" && Number.isFinite(data.dailyBar.v)
        ? data.dailyBar.v
        : 0,
    marketCap: "Unavailable",
    isDelayed: feed === "delayed_sip",
    delaySeconds: feed === "delayed_sip" ? 900 : 0,
    provider: `Alpaca ${feed}`,
    marketCoverage: feed === "iex" ? "limited-exchange" : "consolidated",
  };
}

function normalizedTimestamp(value: string, field: string) {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Alpaca news ${field} must be a valid timestamp`);
  }
  return new Date(parsed).toISOString();
}

function retryAfterSeconds(response: Response) {
  const value = response.headers.get("retry-after");
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return boundedProviderRetryAfterSeconds(seconds);
    }
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return boundedProviderRetryAfterSeconds(
        Math.max(0, Math.ceil((timestamp - Date.now()) / 1_000)),
      );
    }
  }
  const resetAtSeconds = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(resetAtSeconds) && resetAtSeconds > 0) {
    return boundedProviderRetryAfterSeconds(
      Math.max(0, Math.ceil(resetAtSeconds - Date.now() / 1_000)),
    );
  }
  return boundedProviderRetryAfterSeconds(undefined);
}

function bytesToHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function createAlpacaNewsQueryFingerprint(options: {
  symbols: CanonicalSymbol[];
  windowStart: string;
  windowEnd: string;
  pageSize: number;
}) {
  const symbols = [
    ...new Set(
      options.symbols.map((symbol) => tickerFromSymbol(symbol).toUpperCase()),
    ),
  ].sort();
  const payload = JSON.stringify({
    provider: "alpaca",
    stream: "v1beta1/news",
    version: 1,
    symbols,
    windowStart: normalizedTimestamp(options.windowStart, "window start"),
    windowEnd: normalizedTimestamp(options.windowEnd, "window end"),
    pageSize: options.pageSize,
    sort: "asc",
  });
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return bytesToHex(digest);
}

export class AlpacaProvider
  implements MarketDataProvider, PaginatedIntelligenceSourceProvider
{
  readonly name = "alpaca";

  constructor(private readonly config: AlpacaProviderConfig) {}

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

  private async request(
    input: string | URL,
    bucket: ProviderEgressBucket,
    init: Omit<RequestInit, "headers">,
  ) {
    const headers = this.headers();
    await this.config.egressGuard?.acquire(bucket);
    const response = await fetch(input, { ...init, headers });
    if (response.status === 429 && this.config.egressGuard) {
      const retryAfter = retryAfterSeconds(response);
      await this.config.egressGuard.imposeCooldown(bucket, retryAfter);
      throw new ProviderEgressGuardError("cooldown", bucket, retryAfter);
    }
    return response;
  }

  async getSnapshot(symbol: CanonicalSymbol): Promise<MarketSnapshot> {
    const ticker = tickerFromSymbol(symbol);
    const feed = this.config.feed ?? "iex";
    const response = await this.request(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/snapshot?feed=${feed}`,
      "alpaca_quotes_interactive",
      { signal: AbortSignal.timeout(ALPACA_REQUEST_TIMEOUT_MS) },
    );

    if (!response.ok) {
      throw new Error(`Alpaca snapshot failed with ${response.status}`);
    }

    return normalizeSnapshot(symbol, (await response.json()) as AlpacaSnapshotPayload, feed);
  }

  async getSnapshots(
    symbols: CanonicalSymbol[],
  ): Promise<ReadonlyMap<CanonicalSymbol, MarketSnapshot>> {
    const uniqueSymbols = [...new Set(symbols)];
    if (uniqueSymbols.length === 0) return new Map();

    const feed = this.config.feed ?? "iex";
    const url = new URL("https://data.alpaca.markets/v2/stocks/snapshots");
    url.searchParams.set(
      "symbols",
      uniqueSymbols.map((symbol) => tickerFromSymbol(symbol)).join(","),
    );
    url.searchParams.set("feed", feed);

    const response = await this.request(url, "alpaca_quotes_interactive", {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`Alpaca snapshots failed with ${response.status}`);
    }

    const body = (await response.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Alpaca returned an incomplete snapshots response");
    }

    const snapshotsByTicker = body as Record<string, unknown>;
    const snapshots = new Map<CanonicalSymbol, MarketSnapshot>();
    for (const symbol of uniqueSymbols) {
      const payload = snapshotsByTicker[tickerFromSymbol(symbol)];
      if (!payload || typeof payload !== "object") continue;
      try {
        snapshots.set(
          symbol,
          normalizeSnapshot(symbol, payload as AlpacaSnapshotPayload, feed),
        );
      } catch {
        // One malformed or unavailable symbol must not discard valid peers.
      }
    }
    return snapshots;
  }

  async getHistoricalBars(
    symbol: CanonicalSymbol,
    options: HistoricalBarsOptions,
  ): Promise<HistoricalMarketSeries> {
    const ticker = tickerFromSymbol(symbol);
    const configuredFeed = this.config.feed ?? "iex";
    const feed = configuredFeed === "delayed_sip" ? "sip" : configuredFeed;
    const url = new URL(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/bars`,
    );
    url.searchParams.set("timeframe", options.timeframe);
    url.searchParams.set("start", options.start);
    url.searchParams.set("end", options.end);
    url.searchParams.set("limit", String(Math.min(Math.max(options.limit ?? 1_000, 1), 10_000)));
    url.searchParams.set("adjustment", "all");
    url.searchParams.set("feed", feed);
    url.searchParams.set("sort", "asc");

    const response = await this.request(url, "alpaca_bars_interactive", {
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) {
      throw new Error(`Alpaca historical bars failed with ${response.status}`);
    }

    const data = (await response.json()) as {
      bars?: Array<{
        t?: unknown;
        o?: unknown;
        h?: unknown;
        l?: unknown;
        c?: unknown;
        v?: unknown;
        n?: unknown;
        vw?: unknown;
      }>;
    };
    const bars = (data.bars ?? [])
      .map((bar): HistoricalBar | null => {
        if (
          typeof bar.t !== "string" ||
          !Number.isFinite(Date.parse(bar.t)) ||
          typeof bar.o !== "number" ||
          typeof bar.h !== "number" ||
          typeof bar.l !== "number" ||
          typeof bar.c !== "number" ||
          typeof bar.v !== "number"
        ) {
          return null;
        }
        return {
          timestamp: bar.t,
          open: bar.o,
          high: bar.h,
          low: bar.l,
          close: bar.c,
          volume: bar.v,
          tradeCount: typeof bar.n === "number" ? bar.n : null,
          volumeWeightedPrice: typeof bar.vw === "number" ? bar.vw : null,
        };
      })
      .filter((bar): bar is HistoricalBar => bar !== null)
      .sort((left, right) => left.timestamp.localeCompare(right.timestamp));

    return {
      symbolId: symbol,
      timeframe: options.range,
      asOf: bars.at(-1)?.timestamp ?? null,
      provider: `Alpaca ${configuredFeed}`,
      marketCoverage: feed === "iex" ? "limited-exchange" : "consolidated",
      isDelayed: configuredFeed === "delayed_sip",
      delaySeconds: configuredFeed === "delayed_sip" ? 900 : 0,
      adjustment: "all",
      bars,
    };
  }

  async getLatestEvents(options: {
    symbols: CanonicalSymbol[];
    since: string;
    limit: number;
  }): Promise<RawSourceEvent[]> {
    if (options.symbols.length === 0) return [];
    if (!Number.isFinite(options.limit) || options.limit < 1) return [];

    const requestedLimit = Math.min(
      Math.trunc(options.limit),
      ALPACA_NEWS_RESULT_LIMIT,
    );
    const requestedTickers = new Set(
      options.symbols.map((symbol) => tickerFromSymbol(symbol).toUpperCase()),
    );
    const symbols = [...requestedTickers].join(",");
    const signal = AbortSignal.timeout(ALPACA_REQUEST_TIMEOUT_MS);
    const itemsById = new Map<string, AlpacaNewsItem>();
    const seenPageTokens = new Set<string>();
    let pageToken: string | null = null;
    let pageCount = 0;

    while (itemsById.size < requestedLimit && pageCount < ALPACA_NEWS_MAX_PAGES) {
      const url = new URL("https://data.alpaca.markets/v1beta1/news");
      url.searchParams.set("symbols", symbols);
      url.searchParams.set("start", options.since);
      url.searchParams.set(
        "limit",
        String(
          Math.min(
            Math.max(requestedLimit - itemsById.size, 1),
            ALPACA_NEWS_PAGE_SIZE,
          ),
        ),
      );
      url.searchParams.set("sort", "desc");
      if (pageToken) url.searchParams.set("page_token", pageToken);

      const response = await this.request(url, "alpaca_news_interactive", {
        signal,
      });
      if (!response.ok) {
        throw new Error(`Alpaca news failed with ${response.status}`);
      }

      const data = (await response.json()) as {
        news?: unknown;
        next_page_token?: unknown;
      };
      if (!Array.isArray(data.news)) {
        throw new Error("Alpaca returned an incomplete news response");
      }

      for (const candidate of data.news) {
        if (!isAlpacaNewsItem(candidate)) continue;
        const itemSymbols = Array.isArray(candidate.symbols)
          ? candidate.symbols.filter(
              (symbol): symbol is string => typeof symbol === "string",
            )
          : [];
        if (
          !itemSymbols.some((symbol) => requestedTickers.has(symbol.toUpperCase()))
        ) {
          continue;
        }
        const id = String(candidate.id);
        if (!itemsById.has(id)) itemsById.set(id, candidate);
        if (itemsById.size >= requestedLimit) break;
      }

      pageCount += 1;
      const nextPageToken =
        typeof data.next_page_token === "string" &&
        data.next_page_token.trim().length > 0
          ? data.next_page_token
          : null;
      if (!nextPageToken || itemsById.size >= requestedLimit) {
        pageToken = null;
        break;
      }
      if (seenPageTokens.has(nextPageToken)) {
        throw new Error("Alpaca news pagination returned a repeated page token");
      }
      seenPageTokens.add(nextPageToken);
      pageToken = nextPageToken;
    }

    if (pageToken && itemsById.size < requestedLimit) {
      throw new Error("Alpaca news pagination exceeded the bounded page limit");
    }

    const receivedAt = new Date().toISOString();
    return [...itemsById.values()].map((item) => ({
      source: this.name,
      sourceKind: "licensed_news",
      sourceEventId: String(item.id),
      receivedAt,
      publishedAt: item.created_at,
      providerUpdatedAt:
        Number.isFinite(Date.parse(item.updated_at))
          ? item.updated_at
          : item.created_at,
      payload: item,
    }));
  }

  async getEventPage(
    options: IntelligenceEventPageRequest,
  ): Promise<IntelligenceEventPage> {
    if (options.symbols.length === 0) {
      throw new Error("Alpaca news page requires at least one symbol");
    }
    if (
      !Number.isInteger(options.pageSize) ||
      options.pageSize < 1 ||
      options.pageSize > ALPACA_NEWS_PAGE_SIZE
    ) {
      throw new Error(
        `Alpaca news page size must be between 1 and ${ALPACA_NEWS_PAGE_SIZE}`,
      );
    }

    const windowStart = normalizedTimestamp(options.windowStart, "window start");
    const windowEnd = normalizedTimestamp(options.windowEnd, "window end");
    if (windowStart >= windowEnd) {
      throw new Error("Alpaca news window start must precede window end");
    }

    const queryFingerprint = await createAlpacaNewsQueryFingerprint({
      symbols: options.symbols,
      windowStart,
      windowEnd,
      pageSize: options.pageSize,
    });
    const suppliedCursor = options.cursor ?? null;
    if (
      suppliedCursor &&
      suppliedCursor.queryFingerprint !== queryFingerprint
    ) {
      throw new ProviderCursorMismatchError(this.name);
    }
    const pageToken = suppliedCursor?.token.trim() ?? "";
    if (
      suppliedCursor &&
      (pageToken.length === 0 || pageToken.length > ALPACA_PAGE_TOKEN_MAX_LENGTH)
    ) {
      throw new Error("Alpaca news cursor token is invalid");
    }

    const requestedTickers = new Set(
      options.symbols.map((symbol) => tickerFromSymbol(symbol).toUpperCase()),
    );
    const url = new URL("https://data.alpaca.markets/v1beta1/news");
    url.searchParams.set("symbols", [...requestedTickers].sort().join(","));
    url.searchParams.set("start", windowStart);
    url.searchParams.set("end", windowEnd);
    url.searchParams.set("limit", String(options.pageSize));
    url.searchParams.set("sort", "asc");
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const timeoutSignal = AbortSignal.timeout(ALPACA_REQUEST_TIMEOUT_MS);
    const signal = options.signal
      ? AbortSignal.any([options.signal, timeoutSignal])
      : timeoutSignal;
    const response = await this.request(url, "alpaca_news_ingestion", {
      signal,
    });
    if (!response.ok) {
      if (
        suppliedCursor &&
        (response.status === 400 ||
          response.status === 404 ||
          response.status === 410)
      ) {
        throw new ProviderCursorRejectedError(this.name);
      }
      throw new Error(`Alpaca news failed with ${response.status}`);
    }

    const data = (await response.json()) as {
      news?: unknown;
      next_page_token?: unknown;
    };
    if (!Array.isArray(data.news)) {
      throw new Error("Alpaca returned an incomplete news response");
    }

    const itemsById = new Map<string, AlpacaNewsItem>();
    for (const candidate of data.news) {
      if (!isAlpacaNewsItem(candidate)) continue;
      const itemSymbols = Array.isArray(candidate.symbols)
        ? candidate.symbols.filter(
            (symbol): symbol is string => typeof symbol === "string",
          )
        : [];
      if (
        !itemSymbols.some((symbol) => requestedTickers.has(symbol.toUpperCase()))
      ) {
        continue;
      }
      const id = String(candidate.id);
      if (!itemsById.has(id)) itemsById.set(id, candidate);
    }

    const nextPageToken =
      typeof data.next_page_token === "string"
        ? data.next_page_token.trim()
        : "";
    if (nextPageToken.length > ALPACA_PAGE_TOKEN_MAX_LENGTH) {
      throw new Error("Alpaca news returned an invalid page token");
    }

    const receivedAt = new Date().toISOString();
    const events = [...itemsById.values()].map((item) => ({
      source: this.name,
      sourceKind: "licensed_news" as const,
      sourceEventId: String(item.id),
      receivedAt,
      publishedAt: item.created_at,
      providerUpdatedAt: Number.isFinite(Date.parse(item.updated_at))
        ? item.updated_at
        : item.created_at,
      payload: item,
    }));

    return {
      events,
      nextCursor: nextPageToken
        ? { token: nextPageToken, queryFingerprint }
        : null,
      exhausted: nextPageToken.length === 0,
      queryFingerprint,
    };
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
