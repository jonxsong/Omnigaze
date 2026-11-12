import type { CanonicalSymbol } from "@/lib/market-types";

const DEFAULT_BASE_URL = "https://paper-api.alpaca.markets";
const DEFAULT_TIMEOUT_MS = 8_000;

const ALLOWED_TRADING_ORIGINS = new Set([
  "https://api.alpaca.markets",
  "https://paper-api.alpaca.markets",
]);

export type AlpacaAssetProviderErrorCode =
  | "provider_unconfigured"
  | "provider_auth_failed"
  | "provider_rate_limited"
  | "provider_unavailable"
  | "provider_invalid_response"
  | "provider_request_rejected";

const ERROR_MESSAGES: Record<AlpacaAssetProviderErrorCode, string> = {
  provider_unconfigured: "The Alpaca asset provider is not configured.",
  provider_auth_failed: "The Alpaca asset provider could not authenticate.",
  provider_rate_limited: "The Alpaca asset provider is temporarily rate limited.",
  provider_unavailable: "The Alpaca asset provider is temporarily unavailable.",
  provider_invalid_response: "The Alpaca asset provider returned an invalid response.",
  provider_request_rejected: "The Alpaca asset provider rejected the request.",
};

export class AlpacaAssetProviderError extends Error {
  constructor(
    readonly code: AlpacaAssetProviderErrorCode,
    readonly status?: number,
    readonly retryAfterSeconds?: number,
  ) {
    super(ERROR_MESSAGES[code]);
    this.name = "AlpacaAssetProviderError";
  }
}

export interface AlpacaUsEquityAsset {
  id: string;
  symbolId: CanonicalSymbol;
  symbol: string;
  name: string;
  exchange: string;
  status: "active";
  assetClass: "us_equity";
  tradable: boolean;
  marginable: boolean;
  shortable: boolean;
  fractionable: boolean;
  borrowStatus: "easy_to_borrow" | "hard_to_borrow" | null;
  attributes: string[];
}

export interface AlpacaAssetCatalogClient {
  listActiveUsEquities(): Promise<AlpacaUsEquityAsset[]>;
  resolveExact(symbolOrAssetId: string): Promise<AlpacaUsEquityAsset | null>;
}

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

type AlpacaAssetProviderConfig = {
  keyId?: string;
  secretKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetcher?: FetchLike;
  now?: () => number;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const EXCHANGE_ALIASES: Record<string, string> = {
  NYSEARCA: "ARCA",
  NYSEMKT: "AMEX",
};

export function canonicalAlpacaExchange(value: string) {
  const normalized = value.trim().toUpperCase();
  return EXCHANGE_ALIASES[normalized] ?? normalized;
}

function parseRetryAfter(response: Response, now: number) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);

    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) {
      return Math.max(0, Math.ceil((timestamp - now) / 1_000));
    }
  }

  const reset = Number(response.headers.get("x-ratelimit-reset"));
  if (Number.isFinite(reset) && reset > 0) {
    return Math.max(0, Math.ceil(reset - now / 1_000));
  }

  return undefined;
}

function normalizeBaseUrl(value?: string) {
  let parsed: URL;
  try {
    parsed = new URL(value?.trim() || DEFAULT_BASE_URL);
  } catch {
    throw new AlpacaAssetProviderError("provider_unconfigured");
  }

  if (
    !ALLOWED_TRADING_ORIGINS.has(parsed.origin) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new AlpacaAssetProviderError("provider_unconfigured");
  }

  return parsed.origin;
}

function parseActiveUsEquity(value: unknown): AlpacaUsEquityAsset | null {
  if (!isRecord(value)) {
    throw new AlpacaAssetProviderError("provider_invalid_response");
  }

  if (value.class !== "us_equity" || value.status !== "active") return null;

  const id = typeof value.id === "string" ? value.id.trim() : "";
  const symbol = typeof value.symbol === "string" ? value.symbol.trim().toUpperCase() : "";
  const exchange =
    typeof value.exchange === "string" ? canonicalAlpacaExchange(value.exchange) : "";
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const attributes = value.attributes ?? [];
  const borrowStatus = value.borrow_status ?? null;

  if (
    !id ||
    !/^[A-Z0-9._-]{1,32}$/.test(symbol) ||
    !/^[A-Z0-9._-]{1,32}$/.test(exchange) ||
    !name ||
    typeof value.tradable !== "boolean" ||
    typeof value.marginable !== "boolean" ||
    typeof value.shortable !== "boolean" ||
    typeof value.fractionable !== "boolean" ||
    !Array.isArray(attributes) ||
    !attributes.every((attribute) => typeof attribute === "string") ||
    (borrowStatus !== null &&
      borrowStatus !== "easy_to_borrow" &&
      borrowStatus !== "hard_to_borrow")
  ) {
    throw new AlpacaAssetProviderError("provider_invalid_response");
  }

  return {
    id,
    symbolId: `${exchange}:${symbol}`,
    symbol,
    name,
    exchange,
    status: "active",
    assetClass: "us_equity",
    tradable: value.tradable,
    marginable: value.marginable,
    shortable: value.shortable,
    fractionable: value.fractionable,
    borrowStatus,
    attributes: [...attributes],
  };
}

export class AlpacaAssetCatalogProvider implements AlpacaAssetCatalogClient {
  private readonly fetcher: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;

  constructor(private readonly config: AlpacaAssetProviderConfig) {
    this.fetcher = config.fetcher ?? fetch;
    this.now = config.now ?? Date.now;
    this.timeoutMs =
      Number.isFinite(config.timeoutMs) && (config.timeoutMs ?? 0) > 0
        ? Math.min(config.timeoutMs as number, 30_000)
        : DEFAULT_TIMEOUT_MS;
  }

  private requestHeaders() {
    if (!this.config.keyId || !this.config.secretKey) {
      throw new AlpacaAssetProviderError("provider_unconfigured");
    }

    return {
      Accept: "application/json",
      "APCA-API-KEY-ID": this.config.keyId,
      "APCA-API-SECRET-KEY": this.config.secretKey,
    };
  }

  private async request(url: URL) {
    let response: Response;
    try {
      response = await this.fetcher(url, {
        headers: this.requestHeaders(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (error instanceof AlpacaAssetProviderError) throw error;
      throw new AlpacaAssetProviderError("provider_unavailable");
    }

    if (response.ok) return response;

    if (response.status === 401 || response.status === 403) {
      throw new AlpacaAssetProviderError("provider_auth_failed", response.status);
    }
    if (response.status === 429) {
      throw new AlpacaAssetProviderError(
        "provider_rate_limited",
        response.status,
        parseRetryAfter(response, this.now()),
      );
    }
    if (response.status >= 500) {
      throw new AlpacaAssetProviderError("provider_unavailable", response.status);
    }
    throw new AlpacaAssetProviderError("provider_request_rejected", response.status);
  }

  private endpoint(path: string) {
    const baseUrl = normalizeBaseUrl(this.config.baseUrl);
    return new URL(path, `${baseUrl}/`);
  }

  async listActiveUsEquities() {
    const url = this.endpoint("v2/assets");
    url.searchParams.set("status", "active");
    url.searchParams.set("asset_class", "us_equity");

    const response = await this.request(url);
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AlpacaAssetProviderError("provider_invalid_response");
    }

    if (!Array.isArray(payload)) {
      throw new AlpacaAssetProviderError("provider_invalid_response");
    }

    return payload
      .map(parseActiveUsEquity)
      .filter((asset): asset is AlpacaUsEquityAsset => asset !== null);
  }

  async resolveExact(symbolOrAssetId: string) {
    const identifier = symbolOrAssetId.trim();
    if (!identifier) return null;

    const url = this.endpoint(`v2/assets/${encodeURIComponent(identifier)}`);
    let response: Response;
    try {
      response = await this.request(url);
    } catch (error) {
      if (
        error instanceof AlpacaAssetProviderError &&
        error.code === "provider_request_rejected" &&
        error.status === 404
      ) {
        return null;
      }
      throw error;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AlpacaAssetProviderError("provider_invalid_response");
    }

    return parseActiveUsEquity(payload);
  }
}
