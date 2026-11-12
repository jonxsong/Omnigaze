import {
  MARKET_CONTEXT_NOTICE,
  marketContextProxies,
  marketContextProxySymbols,
  type MarketContextItem,
  type MarketContextResult,
  type MarketContextSnapshot,
  type MarketContextStatus,
  type MarketContextUnavailableReason,
} from "@/lib/market-context";
import type { CanonicalSymbol, MarketSnapshot } from "@/lib/market-types";
import {
  liveMarketData,
  type OrchestratedSnapshot,
} from "@/lib/services/live-market-data";

export interface MarketContextDependencies {
  getSnapshots(
    symbols: CanonicalSymbol[],
  ): Promise<ReadonlyMap<CanonicalSymbol, OrchestratedSnapshot>>;
  now(): Date;
}

const defaultDependencies: MarketContextDependencies = {
  getSnapshots: (symbols) => liveMarketData.getSnapshots(symbols),
  now: () => new Date(),
};

function itemBase(proxy: (typeof marketContextProxies)[number]) {
  return {
    key: proxy.key,
    symbolId: proxy.symbolId,
    ticker: proxy.ticker,
    label: proxy.label,
    assetType: proxy.assetType,
  } as const;
}

function unavailableItem(
  proxy: (typeof marketContextProxies)[number],
  reason: MarketContextUnavailableReason,
): MarketContextItem {
  return { ...itemBase(proxy), status: "unavailable", reason };
}

function isSafeProviderName(value: string) {
  return (
    value.trim().length > 0 &&
    value.length <= 64 &&
    !/[\u0000-\u001F\u007F]/.test(value)
  );
}

function isValidLiveSnapshot(
  value: MarketSnapshot,
  expectedSymbol: CanonicalSymbol,
): value is MarketSnapshot & {
  marketCoverage: "limited-exchange" | "consolidated";
} {
  return (
    value.symbolId === expectedSymbol &&
    Number.isFinite(Date.parse(value.asOf)) &&
    Number.isFinite(value.price) &&
    value.price > 0 &&
    Number.isFinite(value.previousClose) &&
    value.previousClose > 0 &&
    Number.isFinite(value.change) &&
    Number.isFinite(value.changePercent) &&
    ["pre-market", "regular", "after-hours", "closed"].includes(
      value.session,
    ) &&
    Number.isInteger(value.volume) &&
    value.volume >= 0 &&
    typeof value.isDelayed === "boolean" &&
    Number.isInteger(value.delaySeconds) &&
    value.delaySeconds >= 0 &&
    isSafeProviderName(value.provider) &&
    (value.marketCoverage === "limited-exchange" ||
      value.marketCoverage === "consolidated")
  );
}

function publicSnapshot(
  snapshot: MarketSnapshot & {
    marketCoverage: "limited-exchange" | "consolidated";
  },
): MarketContextSnapshot {
  return {
    symbolId: snapshot.symbolId,
    asOf: snapshot.asOf,
    session: snapshot.session,
    price: snapshot.price,
    previousClose: snapshot.previousClose,
    change: snapshot.change,
    changePercent: snapshot.changePercent,
    volume: snapshot.volume,
    isDelayed: snapshot.isDelayed,
    delaySeconds: snapshot.delaySeconds,
    provider: snapshot.provider.trim(),
    marketCoverage: snapshot.marketCoverage,
  };
}

function classifySnapshot(
  proxy: (typeof marketContextProxies)[number],
  result: OrchestratedSnapshot | undefined,
): MarketContextItem {
  if (!result) return unavailableItem(proxy, "snapshot_unavailable");

  const demoMarker =
    result.meta.dataMode === "demo" ||
    result.meta.mode === "demo" ||
    result.meta.providerCoverage === "demo" ||
    result.meta.coverage === "demo" ||
    result.meta.freshness.state === "fixture" ||
    result.data?.marketCoverage === "fixture";
  if (demoMarker) {
    return {
      ...itemBase(proxy),
      status: "demo",
      reason: "demo_suppressed",
    };
  }

  if (!result.data) return unavailableItem(proxy, "snapshot_unavailable");
  if (result.data.symbolId !== proxy.symbolId) {
    return unavailableItem(proxy, "identity_mismatch");
  }
  if (
    result.meta.dataMode !== "live" ||
    result.meta.mode !== "live" ||
    result.meta.providerCoverage === "demo" ||
    result.meta.coverage === "demo" ||
    !isValidLiveSnapshot(result.data, proxy.symbolId)
  ) {
    return unavailableItem(proxy, "invalid_provider_response");
  }

  const freshness = result.meta.freshness;
  if (
    (freshness.state !== "fresh" && freshness.state !== "stale") ||
    freshness.asOf !== result.data.asOf ||
    typeof freshness.ageSeconds !== "number" ||
    !Number.isInteger(freshness.ageSeconds) ||
    freshness.ageSeconds < 0
  ) {
    return unavailableItem(proxy, "freshness_unverified");
  }

  return {
    ...itemBase(proxy),
    status: freshness.state === "fresh" ? "live" : "stale",
    snapshot: publicSnapshot(result.data),
  };
}

function overallStatus(items: readonly MarketContextItem[]): MarketContextStatus {
  const liveCount = items.filter((item) => item.status === "live").length;
  const staleCount = items.filter((item) => item.status === "stale").length;
  const demoCount = items.filter((item) => item.status === "demo").length;
  if (liveCount === items.length) return "live";
  if (liveCount > 0) return "partial";
  if (staleCount > 0) return "stale";
  if (demoCount > 0) return "demo";
  return "unavailable";
}

function response(
  items: MarketContextItem[],
  generatedAt: string,
): MarketContextResult {
  const liveCount = items.filter((item) => item.status === "live").length;
  const staleCount = items.filter((item) => item.status === "stale").length;
  const demoCount = items.filter((item) => item.status === "demo").length;
  const unavailableCount = items.length - liveCount - staleCount - demoCount;
  const available = liveCount + staleCount;
  const usableSnapshots = items.flatMap((item) =>
    item.status === "live" || item.status === "stale" ? [item.snapshot] : [],
  );
  const marketCoverage =
    usableSnapshots.length === 0
      ? "none"
      : usableSnapshots.every(
            (snapshot) => snapshot.marketCoverage === "consolidated",
          )
        ? "complete"
        : "partial";

  return {
    data: items,
    meta: {
      status: overallStatus(items),
      requestedCount: marketContextProxies.length,
      liveCount,
      staleCount,
      demoCount,
      unavailableCount,
      availabilityCoverage:
        available === marketContextProxies.length
          ? "complete"
          : available > 0
            ? "partial"
            : "none",
      marketCoverage,
      generatedAt,
      notice: MARKET_CONTEXT_NOTICE,
    },
  };
}

export async function getMarketContext(
  dependencies: MarketContextDependencies = defaultDependencies,
): Promise<MarketContextResult> {
  const generatedAt = dependencies.now().toISOString();
  let snapshots: ReadonlyMap<CanonicalSymbol, OrchestratedSnapshot>;
  try {
    snapshots = await dependencies.getSnapshots(marketContextProxySymbols());
  } catch {
    return response(
      marketContextProxies.map((proxy) =>
        unavailableItem(proxy, "provider_unavailable"),
      ),
      generatedAt,
    );
  }

  return response(
    marketContextProxies.map((proxy) =>
      classifySnapshot(proxy, snapshots.get(proxy.symbolId)),
    ),
    generatedAt,
  );
}

