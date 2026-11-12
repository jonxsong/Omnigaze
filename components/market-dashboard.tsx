"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  ArrowRight,
  Bell,
  Bot,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  Clock3,
  FileText,
  Gauge,
  Globe2,
  Layers3,
  Menu,
  MessageSquareText,
  Plus,
  RefreshCw,
  Search,
  Server,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  TriangleAlert,
  TrendingDown,
  TrendingUp,
  WifiOff,
  X,
} from "lucide-react";
import { defaultWatchlist, stockWorkspaces } from "@/lib/demo-market-data";
import type {
  CanonicalSymbol,
  EvidenceClassification,
  IntelligenceEvent,
  MarketPoint,
  MarketSnapshot,
  Materiality,
} from "@/lib/market-types";
import type {
  IntelligenceFeedItem,
  OrchestrationMeta,
  ProviderReport,
} from "@/lib/services/live-market-data";

const timeframes = ["1D", "1W", "1M", "3M", "1Y"] as const;
type Timeframe = (typeof timeframes)[number];

const DASHBOARD_PREFERENCES_KEY = "omnigaze:dashboard-preferences";
const DASHBOARD_PREFERENCES_VERSION = 1;

interface DashboardPreferences {
  version: typeof DASHBOARD_PREFERENCES_VERSION;
  watchlist: CanonicalSymbol[];
  selectedSymbol: CanonicalSymbol;
  timeframe: Timeframe;
}

const supportedSymbols = new Set<CanonicalSymbol>(
  stockWorkspaces.map(({ instrument }) => instrument.id),
);

function isSupportedSymbol(value: unknown): value is CanonicalSymbol {
  return typeof value === "string" && supportedSymbols.has(value as CanonicalSymbol);
}

function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && timeframes.includes(value as Timeframe);
}

function readDashboardPreferences(): DashboardPreferences | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.localStorage.getItem(DASHBOARD_PREFERENCES_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<DashboardPreferences>;
    if (
      value.version !== DASHBOARD_PREFERENCES_VERSION ||
      !Array.isArray(value.watchlist)
    ) {
      return null;
    }

    const watchlist = Array.from(new Set(value.watchlist.filter(isSupportedSymbol)));
    const selectedSymbol = isSupportedSymbol(value.selectedSymbol)
      ? watchlist.length === 0 || watchlist.includes(value.selectedSymbol)
        ? value.selectedSymbol
        : watchlist[0]
      : watchlist[0] ?? defaultWatchlist[0];

    return {
      version: DASHBOARD_PREFERENCES_VERSION,
      watchlist,
      selectedSymbol,
      timeframe: isTimeframe(value.timeframe) ? value.timeframe : "1D",
    };
  } catch {
    return null;
  }
}

function writeDashboardPreferences(
  watchlist: CanonicalSymbol[],
  selectedSymbol: CanonicalSymbol,
  timeframe: Timeframe,
) {
  if (typeof window === "undefined") return;

  const value: DashboardPreferences = {
    version: DASHBOARD_PREFERENCES_VERSION,
    watchlist,
    selectedSymbol,
    timeframe,
  };

  try {
    window.localStorage.setItem(DASHBOARD_PREFERENCES_KEY, JSON.stringify(value));
  } catch {
    // Storage may be unavailable in private or constrained browser contexts.
  }
}

type FetchPhase = "loading" | "ready" | "error";

interface SnapshotResource {
  data?: MarketSnapshot;
  meta?: OrchestrationMeta;
  phase: FetchPhase;
  receivedAt?: string;
  error?: string;
}

interface IntelligenceResource {
  symbolId?: CanonicalSymbol;
  data: IntelligenceFeedItem[];
  meta?: OrchestrationMeta;
  phase: FetchPhase;
  receivedAt?: string;
  error?: string;
}

interface HealthResponse {
  service?: string;
  status?: string;
  mode?: string;
  version?: string;
  checkedAt?: string;
  providers?: ProviderReport[];
  providerHealth?: ProviderReport[];
}

interface HealthResource {
  data?: HealthResponse;
  phase: FetchPhase;
  receivedAt?: string;
  error?: string;
}

const SNAPSHOT_POLL_MS = 30_000;
const INTELLIGENCE_POLL_MS = 60_000;
const HEALTH_POLL_MS = 60_000;

async function fetchApi<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
    signal,
  });
  const body = (await response.json().catch(() => null)) as T | { error?: string } | null;

  if (!response.ok) {
    const message =
      body && typeof body === "object" && "error" in body
        ? (body as { error?: string }).error
        : undefined;
    throw new Error(message || `Request failed with ${response.status}`);
  }
  if (!body) throw new Error("The API returned an empty response.");
  return body as T;
}

function isFixtureSource(meta: OrchestrationMeta | undefined, snapshot: MarketSnapshot) {
  const source = snapshot.provider.toLowerCase();
  return (
    meta?.dataMode === "demo" ||
    snapshot.marketCoverage === "fixture" ||
    source.includes("fixture") ||
    source.includes("demo")
  );
}

function normalizeFeedItem(
  item: IntelligenceFeedItem,
  selectedSymbol: CanonicalSymbol,
): IntelligenceEvent {
  const category: IntelligenceEvent["category"] =
    item.sourceKind === "sec_filing"
      ? "filing"
      : item.sourceKind === "company_release"
        ? "product"
        : item.sourceKind === "macro_series"
          ? "macro"
          : "market";

  return {
    id: item.id,
    symbolId: item.symbolIds[0] ?? selectedSymbol,
    headline: item.headline,
    summary: item.summary ?? "No provider summary was supplied for this event.",
    occurredAt: item.publishedAt,
    materiality: item.materiality,
    possibleDirection: "unclear",
    status: item.isLive ? "verified" : "preliminary",
    evidenceIds: [],
    category,
  };
}

function formatFreshness(value: string | undefined, now: number) {
  if (!value) return "freshness unavailable";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "freshness unavailable";
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 15) return "updated just now";
  if (seconds < 60) return `updated ${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `updated ${hours}h ago`;
  return `timestamped ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp))}`;
}

function sessionLabel(session: MarketSnapshot["session"]) {
  if (session === "regular") return "Provider session · Regular";
  if (session === "pre-market") return "Provider session · Pre-market";
  if (session === "after-hours") return "Provider session · After hours";
  return "Provider session · Closed";
}

function formatPrice(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

function formatCompact(value: number) {
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatTime(value: string) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function movementClass(value: number) {
  return value >= 0 ? "market-positive" : "market-negative";
}

function evidenceLabel(classification: EvidenceClassification) {
  if (classification === "derived") return "Derived";
  if (classification === "inference") return "Omnigaze inference";
  return "Fact";
}

function materialityLabel(materiality: Materiality) {
  return materiality === "critical"
    ? "Critical"
    : `${materiality[0].toUpperCase()}${materiality.slice(1)}`;
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: MarketPoint }>;
}) {
  if (!active || !payload?.[0]) return null;
  const point = payload[0].payload;

  return (
    <div className="chart-tooltip">
      <span>{point.label}</span>
      <strong>{formatPrice(point.price)}</strong>
      <small>{formatCompact(point.volume)} volume</small>
    </div>
  );
}

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

export function MarketDashboard() {
  const [watchlist, setWatchlist] = useState<CanonicalSymbol[]>(defaultWatchlist);
  const [selectedSymbol, setSelectedSymbol] = useState<CanonicalSymbol>(
    defaultWatchlist[0],
  );
  const [timeframe, setTimeframe] = useState<Timeframe>("1D");
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [showMobileWatchlist, setShowMobileWatchlist] = useState(false);
  const [insightTab, setInsightTab] = useState<"view" | "evidence">("view");
  const [showDataStatus, setShowDataStatus] = useState(false);
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [snapshotResources, setSnapshotResources] = useState<
    Partial<Record<CanonicalSymbol, SnapshotResource>>
  >({});
  const [intelligenceResource, setIntelligenceResource] =
    useState<IntelligenceResource>({ data: [], phase: "loading" });
  const [healthResource, setHealthResource] = useState<HealthResource>({
    phase: "loading",
  });
  const searchInputRef = useRef<HTMLInputElement>(null);
  const preferencesTouchedRef = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (preferencesTouchedRef.current) return;
      const preferences = readDashboardPreferences();
      if (!preferences) return;
      setWatchlist(preferences.watchlist);
      setSelectedSymbol(preferences.selectedSymbol);
      setTimeframe(preferences.timeframe);
    }, 0);

    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let activeController: AbortController | undefined;
    const symbols = Array.from(new Set([selectedSymbol, ...watchlist])).slice(0, 12);

    async function poll() {
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(poll, SNAPSHOT_POLL_MS);
        return;
      }

      activeController = new AbortController();
      const timeout = window.setTimeout(() => activeController?.abort(), 10_000);
      const results = await Promise.allSettled(
        symbols.map(async (symbol) => ({
          symbol,
          envelope: await fetchApi<{ data: MarketSnapshot; meta: OrchestrationMeta }>(
            `/api/market/snapshot?symbol=${encodeURIComponent(symbol)}`,
            activeController!.signal,
          ),
        })),
      );
      window.clearTimeout(timeout);
      if (stopped) return;

      setSnapshotResources((current) => {
        const next = { ...current };
        results.forEach((result, index) => {
          const symbol = symbols[index];
          if (result.status === "fulfilled") {
            next[symbol] = {
              data: result.value.envelope.data,
              meta: result.value.envelope.meta,
              phase: "ready",
              receivedAt: new Date().toISOString(),
            };
          } else {
            next[symbol] = {
              ...next[symbol],
              phase: "error",
              error:
                result.reason instanceof Error
                  ? result.reason.message
                  : "Snapshot request failed.",
            };
          }
        });
        return next;
      });
      setNow(Date.now());
      timer = window.setTimeout(poll, SNAPSHOT_POLL_MS);
    }

    void poll();
    return () => {
      stopped = true;
      activeController?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshGeneration, selectedSymbol, watchlist]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let activeController: AbortController | undefined;

    async function poll() {
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(poll, INTELLIGENCE_POLL_MS);
        return;
      }

      activeController = new AbortController();
      const timeout = window.setTimeout(() => activeController?.abort(), 10_000);
      try {
        const envelope = await fetchApi<{
          data: IntelligenceFeedItem[];
          meta: OrchestrationMeta;
        }>(
          `/api/intelligence?symbol=${encodeURIComponent(selectedSymbol)}&limit=12`,
          activeController.signal,
        );
        if (!stopped) {
          setIntelligenceResource({
            symbolId: selectedSymbol,
            data: envelope.data,
            meta: envelope.meta,
            phase: "ready",
            receivedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        if (!stopped) {
          setIntelligenceResource({
            symbolId: selectedSymbol,
            data: [],
            phase: "error",
            error: error instanceof Error ? error.message : "Intelligence request failed.",
          });
        }
      } finally {
        window.clearTimeout(timeout);
        if (!stopped) timer = window.setTimeout(poll, INTELLIGENCE_POLL_MS);
      }
    }

    void poll();
    return () => {
      stopped = true;
      activeController?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshGeneration, selectedSymbol]);

  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    let activeController: AbortController | undefined;

    async function poll() {
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(poll, HEALTH_POLL_MS);
        return;
      }

      activeController = new AbortController();
      const timeout = window.setTimeout(() => activeController?.abort(), 8_000);
      try {
        const data = await fetchApi<HealthResponse>("/api/health", activeController.signal);
        if (!stopped) {
          setHealthResource({
            data,
            phase: "ready",
            receivedAt: new Date().toISOString(),
          });
        }
      } catch (error) {
        if (!stopped) {
          setHealthResource({
            phase: "error",
            error: error instanceof Error ? error.message : "Health request failed.",
          });
        }
      } finally {
        window.clearTimeout(timeout);
        if (!stopped) timer = window.setTimeout(poll, HEALTH_POLL_MS);
      }
    }

    void poll();
    return () => {
      stopped = true;
      activeController?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshGeneration]);

  const selected =
    stockWorkspaces.find(
      (workspace) => workspace.instrument.id === selectedSymbol,
    ) ?? stockWorkspaces[0];

  const watchedStocks = watchlist
    .map((symbol) =>
      stockWorkspaces.find((workspace) => workspace.instrument.id === symbol),
    )
    .filter(Boolean) as typeof stockWorkspaces;

  const selectedSnapshotResource = snapshotResources[selectedSymbol];
  const snapshot = selectedSnapshotResource?.data ?? selected.snapshot;
  const intelligenceMatchesSelection =
    intelligenceResource.symbolId === selectedSymbol;
  const intelligencePhase: FetchPhase = intelligenceMatchesSelection
    ? intelligenceResource.phase
    : "loading";
  const feedItems =
    intelligenceMatchesSelection && intelligenceResource.phase === "ready"
      ? intelligenceResource.data
      : [];
  const events =
    intelligenceMatchesSelection && intelligenceResource.phase === "ready"
      ? feedItems.map((item) => normalizeFeedItem(item, selectedSymbol))
      : selected.events;
  const feedItemById = new Map(feedItems.map((item) => [item.id, item]));
  const viewHeadline = selected.events[0]?.headline ?? "Illustrative Omnigaze view";
  const snapshotUsesApi = Boolean(selectedSnapshotResource?.data);
  const fixtureData = isFixtureSource(selectedSnapshotResource?.meta, snapshot);
  const sourceState =
    selectedSnapshotResource?.phase === "error" ||
    Boolean(selectedSnapshotResource?.meta?.fallbackReason)
      ? "fallback"
      : fixtureData
        ? "fixture"
        : snapshotUsesApi
          ? "provider"
          : "loading";
  const sourceLabel =
    sourceState === "provider"
      ? snapshot.provider
      : sourceState === "fallback"
        ? "Bundled demo fallback"
        : sourceState === "loading"
          ? "Loading provider status"
          : "Omnigaze demo fixture";
  const freshness = formatFreshness(
    selectedSnapshotResource?.meta?.freshness.asOf ?? snapshot.asOf,
    now,
  );
  const providerReports = [
    ...(healthResource.data?.providers ?? healthResource.data?.providerHealth ?? []),
    ...(selectedSnapshotResource?.meta?.providers ?? []),
    ...(intelligenceMatchesSelection ? intelligenceResource.meta?.providers ?? [] : []),
  ];
  const healthProviders = Array.from(
    new Map(providerReports.map((provider) => [provider.provider, provider])).values(),
  );
  const positiveMovers = watchedStocks.filter(({ instrument, snapshot: fallback }) => {
    return (snapshotResources[instrument.id]?.data ?? fallback).change > 0;
  }).length;
  const materialEventCount = events.filter((event) =>
    ["high", "critical"].includes(event.materiality),
  ).length;
  const dataModeLabel =
    sourceState === "provider"
      ? "Provider data"
      : sourceState === "loading"
        ? "Checking source"
        : "Demo data";

  const searchResults = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return stockWorkspaces;

    return stockWorkspaces.filter(
      ({ instrument }) =>
        instrument.ticker.toLowerCase().includes(normalized) ||
        instrument.name.toLowerCase().includes(normalized),
    );
  }, [query]);

  const chartData = selected.chart[timeframe];
  const positive = snapshot.change >= 0;
  const chartColor = positive ? "#22d3a7" : "#ff6b7d";

  function selectStock(symbol: CanonicalSymbol) {
    preferencesTouchedRef.current = true;
    setSelectedSymbol(symbol);
    setShowSearch(false);
    setShowMobileWatchlist(false);
    writeDashboardPreferences(watchlist, symbol, timeframe);
  }

  function openStockSearch() {
    setShowSearch(true);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  function addStock(symbol: CanonicalSymbol) {
    preferencesTouchedRef.current = true;
    const nextWatchlist = watchlist.includes(symbol)
      ? watchlist
      : [...watchlist, symbol];
    setWatchlist(nextWatchlist);
    setSelectedSymbol(symbol);
    setShowSearch(false);
    setShowMobileWatchlist(false);
    writeDashboardPreferences(nextWatchlist, symbol, timeframe);
  }

  function removeStock(symbol: CanonicalSymbol) {
    preferencesTouchedRef.current = true;
    const nextWatchlist = watchlist.filter((item) => item !== symbol);
    const nextSelected =
      symbol === selectedSymbol && nextWatchlist[0]
        ? nextWatchlist[0]
        : selectedSymbol;
    setWatchlist(nextWatchlist);
    if (nextSelected !== selectedSymbol) setSelectedSymbol(nextSelected);
    writeDashboardPreferences(nextWatchlist, nextSelected, timeframe);
  }

  function chooseTimeframe(nextTimeframe: Timeframe) {
    preferencesTouchedRef.current = true;
    setTimeframe(nextTimeframe);
    writeDashboardPreferences(watchlist, selectedSymbol, nextTimeframe);
  }

  return (
    <main className="omnigaze-shell">
      <header className="topbar">
        <Link className="brand-lockup" href="/" aria-label="Omnigaze home">
          <BrandMark />
          <div>
            <span className="brand-name">OMNIGAZE</span>
            <span className="brand-beta">ALPHA</span>
          </div>
        </Link>

        <button
          className="mobile-menu-button"
          type="button"
          aria-label="Open watchlist"
          onClick={() => setShowMobileWatchlist(true)}
        >
          <Menu size={19} />
        </button>

        <div className="global-search-wrap">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchInputRef}
            data-testid="stock-search-input"
            aria-label="Search stocks"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShowSearch(true);
            }}
            onFocus={() => setShowSearch(true)}
            placeholder="Search a company or ticker"
          />
          <kbd>⌘ K</kbd>

          {showSearch && (
            <div className="search-results" role="listbox">
              <div className="search-results-header">
                <span>Stocks · demo search universe</span>
                <button
                  type="button"
                  aria-label="Close search"
                  onClick={() => setShowSearch(false)}
                >
                  <X size={15} />
                </button>
              </div>
              {searchResults.length > 0 ? (
                searchResults.map(({ instrument, snapshot }) => {
                  const alreadyWatched = watchlist.includes(instrument.id);
                  return (
                    <button
                      key={instrument.id}
                      type="button"
                      role="option"
                      aria-selected={alreadyWatched}
                      className="search-result-row"
                      onClick={() => addStock(instrument.id)}
                    >
                      <span className="symbol-avatar">{instrument.ticker[0]}</span>
                      <span className="search-result-name">
                        <strong>{instrument.ticker}</strong>
                        <small>{instrument.name}</small>
                      </span>
                      <span className={movementClass(snapshot.change)}>
                        {snapshot.changePercent >= 0 ? "+" : ""}
                        {snapshot.changePercent.toFixed(2)}%
                      </span>
                      {alreadyWatched ? <Star size={14} fill="currentColor" /> : <Plus size={15} />}
                    </button>
                  );
                })
              ) : (
                <div className="search-empty-state" role="status">
                  <Search size={17} />
                  <div><strong>No matching stocks</strong><span>Try a company name or ticker from the demo universe.</span></div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="topbar-actions">
          <div className="market-status">
            <span className={`status-dot ${sourceState}`} />
            <span>{sourceState === "provider" ? sessionLabel(snapshot.session) : "Demo market context"}</span>
            <small>{sourceState === "provider" ? freshness : "not live"}</small>
          </div>
          <button
            type="button"
            className="top-add-stock"
            data-testid="top-add-stock"
            onClick={openStockSearch}
          >
            <Plus size={15} /><span>Add stock</span>
          </button>
          <button type="button" className="icon-button" aria-label="Notifications">
            <Bell size={18} />
            <span className="notification-dot" />
          </button>
          <button type="button" className="profile-button" aria-label="Open profile">
            JZ
          </button>
        </div>
      </header>

      <div className={`demo-banner ${sourceState}`} role="status" aria-live="polite">
        {sourceState === "fallback" ? (
          <WifiOff size={14} />
        ) : sourceState === "provider" ? (
          <RefreshCw size={14} />
        ) : sourceState === "loading" ? (
          <Server size={14} />
        ) : (
          <Sparkles size={14} />
        )}
        <span>
          {sourceState === "provider"
            ? `${snapshot.provider} · ${snapshot.isDelayed ? `delayed ${Math.max(1, Math.ceil(snapshot.delaySeconds / 60))}m` : "provider-reported quote"} · ${freshness}`
            : sourceState === "fallback"
              ? "Provider API unavailable — bundled demo fixture shown. This is not live market data."
              : sourceState === "loading"
                ? "Checking market data API — bundled demo fixture shown meanwhile. This is not live market data."
                : "Demo fixture data — prices, chart history, and analysis are illustrative, not live."}
        </span>
        <button
          type="button"
          aria-expanded={showDataStatus}
          aria-controls="data-status-panel"
          onClick={() => setShowDataStatus((current) => !current)}
        >
          {showDataStatus ? "Hide data status" : "View data status"}
        </button>
      </div>

      {showDataStatus && (
        <section id="data-status-panel" className="data-status-panel" aria-labelledby="data-status-title">
          <div className="data-status-heading">
            <div>
              <span className="eyebrow">DATA TRANSPARENCY</span>
              <h2 id="data-status-title">Source and provider status</h2>
            </div>
            <button
              type="button"
              className="refresh-data-button"
              onClick={() => setRefreshGeneration((current) => current + 1)}
            >
              <RefreshCw size={14} /> Refresh now
            </button>
          </div>

          <dl className="data-status-grid">
            <div>
              <dt>Displayed quote</dt>
              <dd><span className={`health-dot ${sourceState}`} />{sourceLabel}</dd>
              <small>
                {sourceState === "provider"
                  ? `${freshness} · ${snapshot.marketCoverage.replaceAll("-", " ")} coverage`
                  : "Fixture values are never presented as live."}
              </small>
            </div>
            <div>
              <dt>Application API</dt>
              <dd>
                <span className={`health-dot ${healthResource.phase}`} />
                {healthResource.phase === "ready"
                  ? `${healthResource.data?.service ?? "Omnigaze web"} · ${healthResource.data?.status ?? "responding"}`
                  : healthResource.phase === "loading"
                    ? "Checking"
                    : "Unreachable"}
              </dd>
              <small>{healthResource.error ?? formatFreshness(healthResource.data?.checkedAt ?? healthResource.receivedAt, now)}</small>
            </div>
            <div>
              <dt>Intelligence feed</dt>
              <dd>
                <span className={`health-dot ${intelligencePhase}`} />
                {intelligencePhase === "ready"
                  ? intelligenceResource.meta?.dataMode === "demo"
                    ? "Demo intelligence adapter"
                    : "API connected"
                  : intelligencePhase === "loading"
                    ? "Checking"
                    : "Bundled fallback"}
              </dd>
              <small>
                {(intelligenceMatchesSelection ? intelligenceResource.error : undefined) ??
                  (intelligenceMatchesSelection &&
                  intelligenceResource.meta?.freshness.state === "fixture"
                    ? "Fixture timestamps are illustrative."
                    : formatFreshness(
                        intelligenceMatchesSelection
                          ? intelligenceResource.meta?.freshness.asOf ?? intelligenceResource.receivedAt
                          : undefined,
                        now,
                      ))}
              </small>
            </div>
            <div>
              <dt>Polling policy</dt>
              <dd><span className="health-dot policy" />30s quotes · 60s intelligence</dd>
              <small>Polling pauses while this tab is hidden and requests time out safely.</small>
            </div>
          </dl>

          <div className="provider-health-list" aria-label="Configured providers">
            {healthProviders.length > 0 ? (
              healthProviders.map((provider) => (
                <div key={provider.provider}>
                  <span className={`health-dot ${provider.status}`} />
                  <strong>{provider.provider}</strong>
                  <span>{provider.status}</span>
                  <small>{provider.message ?? formatFreshness(provider.latestObservedAt ?? provider.checkedAt, now)}</small>
                </div>
              ))
            ) : (
              <p>
                <TriangleAlert size={14} /> Provider-level health is not exposed by this environment yet; source labels above reflect the responses actually received.
              </p>
            )}
          </div>
        </section>
      )}

      <div className={`dashboard-grid ${watchlist.length === 0 ? "empty" : ""}`}>
        <aside className={`watchlist-panel ${showMobileWatchlist ? "mobile-open" : ""}`}>
          <div className="mobile-panel-header">
            <strong>Watchlist</strong>
            <button
              type="button"
              aria-label="Close watchlist"
              onClick={() => setShowMobileWatchlist(false)}
            >
              <X size={18} />
            </button>
          </div>

          <div className="panel-heading">
            <div>
              <span className="eyebrow">MY WATCHLISTS</span>
              <button className="watchlist-title" type="button">
                Core holdings <ChevronDown size={14} />
              </button>
            </div>
            <button
              type="button"
              className="subtle-icon-button"
              aria-label="Add stock"
              onClick={openStockSearch}
            >
              <Plus size={17} />
            </button>
          </div>

          <div className="watchlist-columns" aria-hidden="true">
            <span>Symbol</span>
            <span>Last</span>
            <span>Change</span>
          </div>

          <div className="watchlist-rows">
            {watchedStocks.length === 0 && (
              <div className="watchlist-empty-state">
                <span className="empty-icon"><Search size={17} /></span>
                <strong>No stocks here yet</strong>
                <p>Choose a company to start your personal market view.</p>
                <button type="button" onClick={openStockSearch}>Choose stocks</button>
              </div>
            )}
            {watchedStocks.map(({ instrument, snapshot: fallbackSnapshot }) => {
              const rowSnapshot = snapshotResources[instrument.id]?.data ?? fallbackSnapshot;
              const rowUsesFixture = isFixtureSource(
                snapshotResources[instrument.id]?.meta,
                rowSnapshot,
              );

              return (
                <div
                  key={instrument.id}
                  className={`watchlist-row ${
                    selectedSymbol === instrument.id ? "selected" : ""
                  }`}
                >
                  <button
                    type="button"
                    className="watchlist-select"
                    onClick={() => selectStock(instrument.id)}
                    aria-pressed={selectedSymbol === instrument.id}
                    aria-label={`${instrument.ticker}, ${formatPrice(rowSnapshot.price)}, ${rowUsesFixture ? "demo fixture" : "provider quote"}`}
                  >
                    <span className="symbol-cell">
                      <span className="symbol-avatar small">{instrument.ticker[0]}</span>
                      <span>
                        <strong>{instrument.ticker}</strong>
                        <small>{rowUsesFixture ? "DEMO" : instrument.exchange}</small>
                      </span>
                    </span>
                    <span className="price-cell">{rowSnapshot.price.toFixed(2)}</span>
                    <span className={movementClass(rowSnapshot.change)}>
                      <span aria-hidden="true">{rowSnapshot.change >= 0 ? "↗" : "↘"}</span>{" "}
                      {rowSnapshot.changePercent >= 0 ? "+" : ""}
                      {rowSnapshot.changePercent.toFixed(2)}%
                    </span>
                  </button>
                  <button
                    type="button"
                    className="remove-stock"
                    aria-label={`Remove ${instrument.ticker} from watchlist`}
                    onClick={() => removeStock(instrument.id)}
                  >
                    <X size={13} />
                  </button>
                </div>
              );
            })}
          </div>

          <button className="add-symbol-button" type="button" onClick={openStockSearch}>
            <Plus size={15} /> Add stock
          </button>

          <div className="watchlist-summary">
            <div className="panel-heading compact">
              <span className="eyebrow">TODAY ACROSS YOUR LIST</span>
              <Gauge size={15} />
            </div>
            <div className="summary-stat-grid">
              <div><strong>{materialEventCount}</strong><span>material events</span></div>
              <div><strong>{positiveMovers}</strong><span>positive movers</span></div>
              <div><strong>{sourceState === "provider" ? "API" : "DEMO"}</strong><span>quote source</span></div>
              <div><strong>{watchlist.length}</strong><span>tracked symbols</span></div>
            </div>
          </div>

          <nav className="side-nav" aria-label="Application">
            <button type="button"><Layers3 size={16} /> Intelligence feed</button>
            <button type="button"><MessageSquareText size={16} /> Ask Omnigaze</button>
            <button type="button"><Settings2 size={16} /> Preferences</button>
          </nav>
        </aside>

        <section className="market-workspace">
          <section className="dashboard-overview" aria-labelledby="market-overview-title" data-testid="market-overview">
            <div className="overview-copy">
              <span className="eyebrow">YOUR PERSONAL MARKET</span>
              <h1 id="market-overview-title">Your market at a glance</h1>
              <p>
                Track the companies you care about, see what changed, and inspect the evidence behind every Omnigaze view.
              </p>
            </div>
            <div className="overview-actions">
              <button
                type="button"
                className="primary-action"
                data-testid="overview-add-stock"
                onClick={openStockSearch}
              >
                <Plus size={16} /> Add a stock
              </button>
              <button
                type="button"
                className="secondary-action"
                aria-expanded={showDataStatus}
                aria-controls="data-status-panel"
                onClick={() => setShowDataStatus((current) => !current)}
              >
                <ShieldCheck size={15} /> Data status
              </button>
            </div>
            <div className="overview-metrics" aria-label="Watchlist overview">
              <span><strong>{watchlist.length}</strong> tracked</span>
              <span><strong>{materialEventCount}</strong> material events</span>
              <span className={`overview-source ${sourceState}`}><i />{dataModeLabel}</span>
            </div>
          </section>

          {watchlist.length === 0 ? (
            <section className="dashboard-empty-state" aria-labelledby="empty-watchlist-title">
              <span className="empty-illustration" aria-hidden="true"><Layers3 size={25} /></span>
              <span className="eyebrow">BUILD YOUR DASHBOARD</span>
              <h2 id="empty-watchlist-title">Start your watchlist</h2>
              <p>
                Add your first company to unlock price context, relevant evidence, and an Omnigaze View in one workspace.
              </p>
              <button type="button" className="primary-action" onClick={openStockSearch}>
                <Plus size={16} /> Add your first stock <ArrowRight size={15} />
              </button>
              <small>Start with NVDA, MSFT, AMD, AAPL, or TSLA in the current demo universe.</small>
            </section>
          ) : (
          <>
          <div className="symbol-header">
            <div className="symbol-identity">
              <span className="symbol-avatar large">{selected.instrument.ticker[0]}</span>
              <div>
                <div className="ticker-line">
                  <h2>{selected.instrument.ticker}</h2>
                  <span>{selected.instrument.exchange}</span>
                  <button type="button" aria-label={`Favorite ${selected.instrument.ticker}`}>
                    <Star size={16} />
                  </button>
                </div>
                <p>{selected.instrument.name}</p>
              </div>
            </div>
            <div className="quote-block">
              <strong>{formatPrice(snapshot.price)}</strong>
              <span className={movementClass(snapshot.change)}>
                {snapshot.change >= 0 ? (
                  <TrendingUp size={16} aria-hidden="true" />
                ) : (
                  <TrendingDown size={16} aria-hidden="true" />
                )}
                {snapshot.change >= 0 ? "+" : ""}
                {snapshot.change.toFixed(2)} ({snapshot.changePercent.toFixed(2)}%)
              </span>
              <small>
                {sourceState === "provider"
                  ? `${snapshot.isDelayed ? `Delayed ${Math.max(1, Math.ceil(snapshot.delaySeconds / 60))} min` : "Provider timestamp"} · ${freshness}`
                  : `${sourceLabel} · not live`}
              </small>
            </div>
          </div>

          <div className="metric-strip">
            <div><span>Previous close</span><strong>{formatPrice(snapshot.previousClose)}</strong></div>
            <div><span>Volume</span><strong>{formatCompact(snapshot.volume)}</strong></div>
            <div><span>Market cap</span><strong>{snapshot.marketCap}</strong></div>
            <div><span>Sector</span><strong>{selected.instrument.sector}</strong></div>
          </div>

          <section className="chart-panel" aria-labelledby="price-chart-title">
            <div className="chart-toolbar">
              <div>
                <span className="eyebrow">PRICE</span>
                <h2 id="price-chart-title">Market movement</h2>
                <small className="chart-source-note">Illustrative fixture history · not live</small>
              </div>
              <div className="timeframe-control" aria-label="Chart timeframe">
                {timeframes.map((range) => (
                  <button
                    key={range}
                    type="button"
                    className={timeframe === range ? "active" : ""}
                    aria-pressed={timeframe === range}
                    onClick={() => chooseTimeframe(range)}
                  >
                    {range}
                  </button>
                ))}
              </div>
            </div>

            <div className="chart-wrap" aria-label={`${selected.instrument.ticker} ${timeframe} price chart`}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={chartColor} stopOpacity={0.24} />
                      <stop offset="100%" stopColor={chartColor} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="#172331" strokeDasharray="2 5" vertical={false} />
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "#677688", fontSize: 10 }}
                    minTickGap={28}
                  />
                  <YAxis
                    orientation="right"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: "#677688", fontSize: 10 }}
                    domain={["dataMin - 2", "dataMax + 2"]}
                    tickFormatter={(value) => `$${Number(value).toFixed(0)}`}
                    width={48}
                  />
                  <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#3a4b5f" }} />
                  <Area
                    type="monotone"
                    dataKey="price"
                    stroke={chartColor}
                    strokeWidth={2}
                    fill="url(#priceFill)"
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            <table className="sr-only">
              <caption>{selected.instrument.ticker} price observations</caption>
              <thead><tr><th>Time</th><th>Price</th><th>Volume</th></tr></thead>
              <tbody>
                {chartData.map((point) => (
                  <tr key={`${point.timestamp}-${point.label}`}>
                    <td>{point.label}</td><td>{point.price}</td><td>{point.volume}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="event-section" aria-labelledby="event-heading">
            <div className="section-heading-row">
              <div>
                <span className="eyebrow">INTELLIGENCE TIMELINE</span>
                <h2 id="event-heading">What changed</h2>
              </div>
              <button type="button">View all events <ChevronRight size={15} /></button>
            </div>

            <div className="event-list">
              {events.length > 0 ? (
                events.map((event) => {
                  const feedItem = feedItemById.get(event.id);
                  const eventIsLive = feedItem?.isLive === true;

                  return (
                    <article className="event-card" key={event.id}>
                      <div className={`event-icon ${event.category}`}>
                        {event.category === "filing" ? <FileText size={17} /> : <Globe2 size={17} />}
                      </div>
                      <div className="event-body">
                        <div className="event-meta">
                          <span className={`materiality ${event.materiality}`}>
                            {materialityLabel(event.materiality)} impact
                          </span>
                          <span>{formatTime(event.occurredAt)}</span>
                          <span className={`source-chip ${eventIsLive ? "live" : "fixture"}`}>
                            {eventIsLive ? feedItem?.source ?? "Provider" : "Demo fixture"}
                          </span>
                        </div>
                        <h3>{event.headline}</h3>
                        <p>{event.summary}</p>
                        <div className="event-actions">
                          {feedItem?.sourceUrl ? (
                            <a href={feedItem.sourceUrl} target="_blank" rel="noreferrer">
                              Open source
                            </a>
                          ) : (
                            <button type="button">Inspect demo evidence</button>
                          )}
                          <button type="button">Add to thesis</button>
                        </div>
                      </div>
                      <ChevronRight className="event-chevron" size={18} />
                    </article>
                  );
                })
              ) : (
                <div className="event-empty-state">
                  <Globe2 size={18} />
                  <div><strong>No recent provider events</strong><span>Omnigaze will keep checking this symbol.</span></div>
                </div>
              )}
            </div>
          </section>
          </>
          )}
        </section>

        <aside className="intelligence-panel">
          <div className="intelligence-heading">
            <div className="ai-orb"><Bot size={20} /></div>
            <div>
              <span className="eyebrow">OMNIGAZE VIEW</span>
              <strong>Illustrative foundation analysis</strong>
            </div>
            <button type="button" aria-label="About Omnigaze views"><CircleHelp size={16} /></button>
          </div>

          <div className="view-source-note">
            <Sparkles size={13} /> Demo fixture analysis · not generated from the current provider feed
          </div>

          <div className="insight-tabs" role="tablist" aria-label="Omnigaze analysis">
            <button
              type="button"
              role="tab"
              aria-selected={insightTab === "view"}
              className={insightTab === "view" ? "active" : ""}
              onClick={() => setInsightTab("view")}
            >
              Current view
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={insightTab === "evidence"}
              className={insightTab === "evidence" ? "active" : ""}
              onClick={() => setInsightTab("evidence")}
            >
              Evidence ({selected.evidence.length})
            </button>
          </div>

          {insightTab === "view" ? (
            <div className="view-content">
              <div className="stance-row">
                <div>
                  <span>Near-term stance</span>
                  <strong className={`stance ${selected.view.stance}`}>
                    {selected.view.stance}
                  </strong>
                </div>
                <div className="confidence-ring" style={{ "--confidence": `${selected.view.confidence * 100}%` } as React.CSSProperties}>
                  <span>{Math.round(selected.view.confidence * 100)}%</span>
                  <small>confidence</small>
                </div>
              </div>

              <div className="view-summary">
                <h2>{viewHeadline}</h2>
                <p>{selected.view.summary}</p>
              </div>

              <div className="why-now-card">
                <div><Clock3 size={15} /><span>Why now</span></div>
                <p>{selected.view.whyNow}</p>
              </div>

              <div className="driver-list">
                <div className="mini-heading"><span>Key drivers</span><small>2 signals</small></div>
                {selected.view.drivers.map((driver) => (
                  <div className="driver-row" key={driver.label}>
                    <span className={`driver-dot ${driver.direction}`} />
                    <div><strong>{driver.label}</strong><p>{driver.explanation}</p></div>
                  </div>
                ))}
              </div>

              <div className="unknowns">
                <div className="mini-heading"><span>What remains unknown</span></div>
                {selected.view.unknowns.map((unknown) => (
                  <p key={unknown}><span>?</span>{unknown}</p>
                ))}
              </div>

              <button type="button" className="ask-button">
                <Sparkles size={16} /> Ask Omnigaze about {selected.instrument.ticker}
              </button>
            </div>
          ) : (
            <div className="evidence-list">
              {selected.evidence.map((evidence) => (
                <article key={evidence.id} className="evidence-card">
                  <div className="evidence-card-top">
                    <span className={`evidence-type ${evidence.classification}`}>
                      {evidenceLabel(evidence.classification)}
                    </span>
                    <span>{formatTime(evidence.publishedAt)}</span>
                  </div>
                  <h3>{evidence.title}</h3>
                  <p>{evidence.publisher}{evidence.locator ? ` · ${evidence.locator}` : ""}</p>
                  {evidence.excerpt && <blockquote>{evidence.excerpt}</blockquote>}
                  <button type="button">Open source <ChevronRight size={14} /></button>
                </article>
              ))}
            </div>
          )}

          <div className="view-footer">
            <ShieldCheck size={15} />
            <span>Research support only · Not investment advice</span>
          </div>
        </aside>
      </div>

      {watchlist.length > 0 && (
        <section className="mobile-intelligence-summary">
          <div className="ai-orb"><Bot size={18} /></div>
          <div><span className="eyebrow">OMNIGAZE VIEW · DEMO</span><strong>{viewHeadline}</strong></div>
          <button type="button"><ChevronRight size={18} /></button>
        </section>
      )}

      <footer className="market-ticker" aria-label="Market summary">
        <span className="ticker-status"><span className="status-dot fixture" /> DEMO CONTEXT</span>
        {[
          ["S&P 500", "7,141.20", "+0.82%"],
          ["NASDAQ", "25,418.60", "+1.14%"],
          ["US 10Y", "4.18%", "+3 bps"],
          ["VIX", "16.72", "-2.34%"],
          ["WTI", "$78.16", "+0.42%"],
        ].map(([name, value, change]) => (
          <span className="ticker-item" key={name}>
            <strong>{name}</strong><span>{value}</span><small className={change.startsWith("+") ? "market-positive" : "market-negative"}>{change}</small>
          </span>
        ))}
        <span className="ticker-time">Illustrative index fixture · not live</span>
      </footer>

      {showMobileWatchlist && (
        <button
          className="mobile-scrim"
          aria-label="Close watchlist"
          onClick={() => setShowMobileWatchlist(false)}
        />
      )}
    </main>
  );
}
