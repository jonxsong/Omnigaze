import type { CanonicalSymbol } from "@/lib/market-types";
import {
  AlpacaAssetCatalogProvider,
  AlpacaAssetProviderError,
  type AlpacaAssetCatalogClient,
  type AlpacaAssetProviderErrorCode,
  type AlpacaUsEquityAsset,
} from "@/lib/providers/alpaca-assets";

export const ASSET_CATALOG_FRESH_MS = 60 * 60 * 1_000;
export const ASSET_CATALOG_MAX_STALE_MS = 24 * 60 * 60 * 1_000;

export interface AssetSearchItem {
  id: string;
  symbolId: CanonicalSymbol;
  symbol: string;
  name: string;
  exchange: string;
  status: "active";
  tradable: boolean;
  marginable: boolean;
  shortable: boolean;
  fractionable: boolean;
  attributes: string[];
  provider: "alpaca";
}

export interface AssetSearchResult {
  data: AssetSearchItem[];
  meta: {
    source: "alpaca";
    catalogAsOf: string;
    totalMatches: number;
    freshness: {
      state: "fresh" | "stale";
      ageSeconds: number;
    };
    fallbackReason?: AlpacaAssetProviderErrorCode;
  };
}

type CatalogCache = {
  assets: AlpacaUsEquityAsset[];
  fetchedAt: number;
};

type CatalogView = {
  cache: CatalogCache;
  state: "fresh" | "stale";
  fallbackReason?: AlpacaAssetProviderErrorCode;
};

type RankedAsset = {
  asset: AlpacaUsEquityAsset;
  rank: number;
};

function normalizeSearchText(value: string) {
  return value.trim().replace(/\s+/g, " ").toUpperCase();
}

function rankAsset(asset: AlpacaUsEquityAsset, query: string): number | null {
  if (!query) return null;

  const symbol = normalizeSearchText(asset.symbol);
  const name = normalizeSearchText(asset.name);
  const nameWords = name.split(/[^A-Z0-9]+/).filter(Boolean);

  if (symbol === query) return 0;
  if (symbol.startsWith(query)) return 1;
  if (name === query) return 2;
  if (name.startsWith(query)) return 3;
  if (nameWords.some((word) => word.startsWith(query))) return 4;
  if (symbol.includes(query)) return 5;
  if (name.includes(query)) return 6;
  return null;
}

function publicAsset(asset: AlpacaUsEquityAsset): AssetSearchItem {
  return {
    id: asset.id,
    symbolId: asset.symbolId,
    symbol: asset.symbol,
    name: asset.name,
    exchange: asset.exchange,
    status: asset.status,
    tradable: asset.tradable,
    marginable: asset.marginable,
    shortable: asset.shortable,
    fractionable: asset.fractionable,
    attributes: [...asset.attributes],
    provider: "alpaca",
  };
}

function sanitizedProviderError(error: unknown) {
  return error instanceof AlpacaAssetProviderError
    ? error
    : new AlpacaAssetProviderError("provider_unavailable");
}

export class AssetSearchService {
  private cache: CatalogCache | null = null;
  private inFlight: Promise<CatalogCache> | null = null;

  constructor(
    private readonly provider: AlpacaAssetCatalogClient,
    private readonly now: () => number = Date.now,
  ) {}

  private ageMs(cache: CatalogCache) {
    return Math.max(0, this.now() - cache.fetchedAt);
  }

  private async refreshCatalog() {
    if (this.inFlight) return this.inFlight;

    const refresh = (async () => {
      const assets = await this.provider.listActiveUsEquities();
      const next = { assets, fetchedAt: this.now() };
      this.cache = next;
      return next;
    })();
    this.inFlight = refresh;

    try {
      return await refresh;
    } finally {
      if (this.inFlight === refresh) this.inFlight = null;
    }
  }

  private async catalog(): Promise<CatalogView> {
    const cached = this.cache;
    if (cached && this.ageMs(cached) <= ASSET_CATALOG_FRESH_MS) {
      return { cache: cached, state: "fresh" };
    }

    try {
      return { cache: await this.refreshCatalog(), state: "fresh" };
    } catch (error) {
      const providerError = sanitizedProviderError(error);
      if (cached && this.ageMs(cached) <= ASSET_CATALOG_MAX_STALE_MS) {
        return {
          cache: cached,
          state: "stale",
          fallbackReason: providerError.code,
        };
      }
      throw providerError;
    }
  }

  async search(query: string, limit = 20): Promise<AssetSearchResult> {
    const normalizedQuery = normalizeSearchText(query);
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 50));
    const catalog = await this.catalog();

    const ranked = catalog.cache.assets
      .map((asset): RankedAsset | null => {
        const rank = rankAsset(asset, normalizedQuery);
        return rank === null ? null : { asset, rank };
      })
      .filter((value): value is RankedAsset => value !== null)
      .sort(
        (left, right) =>
          left.rank - right.rank ||
          left.asset.symbol.localeCompare(right.asset.symbol) ||
          left.asset.exchange.localeCompare(right.asset.exchange),
      );

    const ageSeconds = Math.floor(this.ageMs(catalog.cache) / 1_000);
    return {
      data: ranked.slice(0, boundedLimit).map(({ asset }) => publicAsset(asset)),
      meta: {
        source: "alpaca",
        catalogAsOf: new Date(catalog.cache.fetchedAt).toISOString(),
        totalMatches: ranked.length,
        freshness: {
          state: catalog.state,
          ageSeconds,
        },
        ...(catalog.fallbackReason
          ? { fallbackReason: catalog.fallbackReason }
          : {}),
      },
    };
  }

  async resolveExact(symbolOrAssetId: string) {
    return this.provider.resolveExact(symbolOrAssetId);
  }
}

export function createAssetSearchService(
  environment: Record<string, string | undefined> = process.env,
) {
  const provider = new AlpacaAssetCatalogProvider({
    keyId: environment.ALPACA_API_KEY_ID,
    secretKey: environment.ALPACA_API_SECRET_KEY,
    baseUrl: environment.ALPACA_TRADING_API_BASE_URL,
  });
  return new AssetSearchService(provider);
}

let defaultService: AssetSearchService | undefined;

export function getAssetSearchService() {
  defaultService ??= createAssetSearchService();
  return defaultService;
}
