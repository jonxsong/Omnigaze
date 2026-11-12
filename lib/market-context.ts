import type { CanonicalSymbol, MarketSession } from "@/lib/market-types";

export const MARKET_CONTEXT_NOTICE =
  "Provider-backed ETF proxies. Values are not the underlying index, yield, volatility index, or spot commodity.";

export const marketContextProxies = [
  {
    key: "us-large-cap",
    symbolId: "ARCA:SPY",
    ticker: "SPY",
    label: "S&P 500 ETF proxy",
    assetType: "etf_proxy",
  },
  {
    key: "us-growth",
    symbolId: "NASDAQ:QQQ",
    ticker: "QQQ",
    label: "Nasdaq-100 ETF proxy",
    assetType: "etf_proxy",
  },
  {
    key: "us-small-cap",
    symbolId: "ARCA:IWM",
    ticker: "IWM",
    label: "Russell 2000 ETF proxy",
    assetType: "etf_proxy",
  },
  {
    key: "long-treasury",
    symbolId: "NASDAQ:TLT",
    ticker: "TLT",
    label: "20+ year Treasury ETF proxy",
    assetType: "etf_proxy",
  },
  {
    key: "oil",
    symbolId: "ARCA:USO",
    ticker: "USO",
    label: "Oil ETF proxy",
    assetType: "etf_proxy",
  },
  {
    key: "gold",
    symbolId: "ARCA:GLD",
    ticker: "GLD",
    label: "Gold ETF proxy",
    assetType: "etf_proxy",
  },
] as const satisfies readonly {
  key: string;
  symbolId: CanonicalSymbol;
  ticker: string;
  label: string;
  assetType: "etf_proxy";
}[];

export type MarketContextProxy = (typeof marketContextProxies)[number];
export type MarketContextProxyKey = MarketContextProxy["key"];
export type MarketContextStatus =
  | "live"
  | "partial"
  | "stale"
  | "demo"
  | "unavailable";
export type MarketContextUnavailableReason =
  | "snapshot_unavailable"
  | "identity_mismatch"
  | "invalid_provider_response"
  | "freshness_unverified"
  | "provider_unavailable";

export interface MarketContextSnapshot {
  symbolId: CanonicalSymbol;
  asOf: string;
  session: MarketSession;
  price: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  isDelayed: boolean;
  delaySeconds: number;
  provider: string;
  marketCoverage: "limited-exchange" | "consolidated";
}

type MarketContextItemBase = {
  key: MarketContextProxyKey;
  symbolId: CanonicalSymbol;
  ticker: string;
  label: string;
  assetType: "etf_proxy";
};

export type MarketContextItem =
  | (MarketContextItemBase & {
      status: "live" | "stale";
      snapshot: MarketContextSnapshot;
    })
  | (MarketContextItemBase & {
      status: "demo";
      reason: "demo_suppressed";
    })
  | (MarketContextItemBase & {
      status: "unavailable";
      reason: MarketContextUnavailableReason;
    });

export interface MarketContextResult {
  data: MarketContextItem[];
  meta: {
    status: MarketContextStatus;
    requestedCount: number;
    liveCount: number;
    staleCount: number;
    demoCount: number;
    unavailableCount: number;
    availabilityCoverage: "complete" | "partial" | "none";
    marketCoverage: "complete" | "partial" | "none";
    generatedAt: string;
    notice: typeof MARKET_CONTEXT_NOTICE;
  };
}

export function marketContextProxySymbols(): CanonicalSymbol[] {
  return marketContextProxies.map((proxy) => proxy.symbolId);
}

