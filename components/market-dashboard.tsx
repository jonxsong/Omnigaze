"use client";

import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowRight,
  Bell,
  Bot,
  ChevronRight,
  CircleHelp,
  Cloud,
  Clock3,
  FileText,
  Gauge,
  Globe2,
  Layers3,
  LogIn,
  LogOut,
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
import {
  defaultWatchlist,
  stockWorkspaces,
  workspaceBySymbol,
} from "@/lib/demo-market-data";
import type {
  CanonicalSymbol,
  EvidenceClassification,
  HistoricalMarketSeries,
  IntelligenceEvent,
  MarketPoint,
  MarketSnapshot,
  Materiality,
} from "@/lib/market-types";
import type { IngestionReadiness } from "@/lib/services/ingestion-health";
import type {
  IntelligenceFeedItem,
  OrchestrationMeta,
  ProviderReport,
} from "@/lib/services/live-market-data";
import {
  ONBOARDING_DRAFT_KEY,
  parseOnboardingDraft,
} from "@/lib/onboarding-draft";
import {
  isPortfolioDecimal,
  MAX_AVERAGE_COST_MICROS,
  MAX_QUANTITY_MICROS,
} from "@/lib/portfolio/decimal";
import {
  PortfolioWorkspaceDialog,
  type PortfolioAvailability,
  type PortfolioWorkspaceHolding,
  type WorkspaceQuoteState,
} from "@/components/portfolio-workspace-dialog";
import {
  IntelligenceInboxDrawer,
  type IntelligenceInboxSaveRequest,
  type IntelligenceInboxTab,
} from "@/components/intelligence-inbox-drawer";
import type { IntelligenceInboxCounts } from "@/lib/intelligence-inbox/contracts";
import { OmnigazeViewDialog } from "@/components/omnigaze-view-dialog";
import { DailyBriefCard } from "@/components/daily-brief-card";

const MarketPriceChart = lazy(() => import("@/components/market-price-chart"));

const timeframes = ["1D", "1W", "1M", "3M", "1Y"] as const;
type Timeframe = (typeof timeframes)[number];

const DASHBOARD_PREFERENCES_KEY = "omnigaze:dashboard-preferences";
const DASHBOARD_PREFERENCES_VERSION = 2;
const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;

export interface DashboardInstrument {
  id: CanonicalSymbol;
  ticker: string;
  exchange: string;
  name: string;
  sector: string | null;
  currency: "USD";
}

export type DashboardHolding = PortfolioWorkspaceHolding;

export interface DashboardPreferences {
  version: typeof DASHBOARD_PREFERENCES_VERSION;
  instruments: DashboardInstrument[];
  selectedSymbol: CanonicalSymbol;
  timeframe: Timeframe;
}

interface LegacyDashboardPreferences {
  version: 1;
  watchlist: CanonicalSymbol[];
  selectedSymbol: CanonicalSymbol;
  timeframe: Timeframe;
}

type DashboardSession =
  | {
      isAuthenticated: false;
      signInPath: string;
    }
  | {
      isAuthenticated: true;
      displayName: string;
      initials: string;
      signOutPath: string;
    };

interface AccountWatchlist {
  id: string;
  name: string;
  instruments: DashboardInstrument[];
}

interface MarketDashboardProps {
  session: DashboardSession;
  accountWatchlist?: AccountWatchlist | null;
  accountSyncUnavailable?: boolean;
  accountHoldings?: DashboardHolding[] | null;
  accountPortfolioUnavailable?: boolean;
}

type WatchlistSyncPhase =
  | "local"
  | "synced"
  | "saving"
  | "error"
  | "unavailable";

const fixtureInstruments = stockWorkspaces.map(({ instrument }) => ({
  ...instrument,
  currency: "USD" as const,
}));

function isCanonicalSymbol(value: unknown): value is CanonicalSymbol {
  return typeof value === "string" && canonicalSymbolPattern.test(value);
}

function isTimeframe(value: unknown): value is Timeframe {
  return typeof value === "string" && timeframes.includes(value as Timeframe);
}

function normalizeDashboardInstrument(value: unknown): DashboardInstrument | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DashboardInstrument>;
  const id = typeof candidate.id === "string" ? candidate.id.trim().toUpperCase() : "";
  const ticker =
    typeof candidate.ticker === "string" ? candidate.ticker.trim().toUpperCase() : "";
  const exchange =
    typeof candidate.exchange === "string"
      ? candidate.exchange.trim().toUpperCase()
      : "";
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";

  if (
    !isCanonicalSymbol(id) ||
    !ticker ||
    !exchange ||
    `${exchange}:${ticker}` !== id ||
    !name
  ) {
    return null;
  }

  return {
    id,
    ticker,
    exchange,
    name,
    sector:
      typeof candidate.sector === "string" && candidate.sector.trim()
        ? candidate.sector.trim()
        : null,
    currency: "USD",
  };
}

function dedupeInstruments(instruments: DashboardInstrument[]) {
  return Array.from(
    new Map(instruments.map((instrument) => [instrument.id, instrument])).values(),
  );
}

export function parseDashboardPreferences(raw: string | null): DashboardPreferences | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as
      | Partial<DashboardPreferences>
      | Partial<LegacyDashboardPreferences>;
    let instruments: DashboardInstrument[];

    if (value.version === 1 && Array.isArray(value.watchlist)) {
      instruments = value.watchlist.flatMap((symbol) => {
        const workspace = isCanonicalSymbol(symbol)
          ? workspaceBySymbol.get(symbol)
          : undefined;
        return workspace ? [{ ...workspace.instrument, currency: "USD" as const }] : [];
      });
    } else if (
      value.version === DASHBOARD_PREFERENCES_VERSION &&
      Array.isArray(value.instruments)
    ) {
      instruments = value.instruments
        .map(normalizeDashboardInstrument)
        .filter((instrument): instrument is DashboardInstrument => instrument !== null);
    } else {
      return null;
    }

    instruments = dedupeInstruments(instruments);
    const instrumentIds = new Set(instruments.map(({ id }) => id));
    const selectedSymbol = isCanonicalSymbol(value.selectedSymbol)
      ? instruments.length === 0 || instrumentIds.has(value.selectedSymbol)
        ? value.selectedSymbol
        : instruments[0].id
      : instruments[0]?.id ?? defaultWatchlist[0];

    return {
      version: DASHBOARD_PREFERENCES_VERSION,
      instruments,
      selectedSymbol,
      timeframe: isTimeframe(value.timeframe) ? value.timeframe : "1D",
    };
  } catch {
    return null;
  }
}

function readDashboardPreferences(): DashboardPreferences | null {
  if (typeof window === "undefined") return null;
  try {
    return parseDashboardPreferences(
      window.localStorage.getItem(DASHBOARD_PREFERENCES_KEY),
    );
  } catch {
    return null;
  }
}

function writeDashboardPreferences(
  instruments: DashboardInstrument[],
  selectedSymbol: CanonicalSymbol,
  timeframe: Timeframe,
) {
  if (typeof window === "undefined") return;

  const value: DashboardPreferences = {
    version: DASHBOARD_PREFERENCES_VERSION,
    instruments,
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

interface SnapshotBatchResponse {
  data: Array<
    | {
        symbolId: CanonicalSymbol;
        status: "ready";
        data: MarketSnapshot;
        meta: OrchestrationMeta;
      }
    | {
        symbolId: CanonicalSymbol;
        status: "error";
        code: string;
        error: string;
      }
  >;
  meta: {
    requestedCount: number;
    readyCount: number;
    errorCount: number;
    partial: boolean;
    generatedAt: string;
  };
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
  readiness?: {
    ingestion?: IngestionReadiness;
  };
}

interface HealthResource {
  data?: HealthResponse;
  phase: FetchPhase;
  receivedAt?: string;
  error?: string;
}

interface ChartResource {
  data?: HistoricalMarketSeries;
  phase: FetchPhase;
  receivedAt?: string;
  error?: string;
}

interface CatalogSearchResponse {
  data: Array<{
    symbolId: CanonicalSymbol;
    symbol: string;
    name: string;
    exchange: string;
  }>;
  meta: {
    catalogAsOf: string;
    totalMatches: number;
    freshness: {
      state: "fresh" | "stale";
      ageSeconds: number;
    };
  };
}

interface CatalogSearchResource {
  data: DashboardInstrument[];
  phase: "idle" | FetchPhase;
  query: string;
  meta?: CatalogSearchResponse["meta"];
  error?: string;
}

const SNAPSHOT_POLL_MS = 30_000;
const INTELLIGENCE_POLL_MS = 60_000;
const HEALTH_POLL_MS = 60_000;
const INBOX_COUNT_POLL_MS = 60_000;

const emptyInboxCounts: IntelligenceInboxCounts = {
  all: 0,
  unread: 0,
  saved: 0,
  alerts: 0,
};

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

function formatTimestampAge(value: string | null | undefined, now: number) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 15) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `on ${new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp))}`;
}

function formatEvidenceTiming(
  observedAt: string | null | undefined,
  responseReceivedAt: string | undefined,
  now: number,
) {
  const observationAge = formatTimestampAge(observedAt, now);
  if (observationAge) return `Evidence observed ${observationAge}`;

  const receiptAge = formatTimestampAge(responseReceivedAt, now);
  return receiptAge
    ? `Evidence time unavailable · Response received ${receiptAge}`
    : "Evidence time unavailable";
}

function formatHealthTiming(
  checkedAt: string | null | undefined,
  responseReceivedAt: string | undefined,
  now: number,
) {
  const checkAge = formatTimestampAge(checkedAt, now);
  if (checkAge) return `Health checked ${checkAge}`;

  const receiptAge = formatTimestampAge(responseReceivedAt, now);
  return receiptAge
    ? `Health check time unavailable · Response received ${receiptAge}`
    : "Health check time unavailable";
}

function formatProviderTiming(provider: ProviderReport, now: number) {
  const observationAge = formatTimestampAge(provider.latestObservedAt, now);
  const checkAge = formatTimestampAge(provider.checkedAt, now);
  const observationLabel = observationAge
    ? `Evidence observed ${observationAge}`
    : "Evidence time unavailable";
  const checkLabel = checkAge
    ? `Health checked ${checkAge}`
    : "Health check time unavailable";
  return `${observationLabel} · ${checkLabel}`;
}

function formatIngestionMode(mode: IngestionReadiness["mode"]) {
  if (mode === "scheduled") return "Scheduled";
  if (mode === "request_time") return "Request-time";
  return "Unavailable";
}

function formatIngestionStatus(status: IngestionReadiness["status"]) {
  if (status === "catching_up") return "Catching up";
  if (status === "idle") return "Idle";
  if (status === "unavailable") return "Unavailable";
  return `${status.charAt(0).toUpperCase()}${status.slice(1)}`;
}

function ingestionStatusDescription(status: IngestionReadiness["status"]) {
  if (status === "healthy") return "Recent collection runs completed.";
  if (status === "catching_up") {
    return "Provider work is due, running, or resuming.";
  }
  if (status === "delayed") {
    return "Collection is overdue beyond its declared cadence.";
  }
  if (status === "degraded") {
    return "A recent run or provider partition is failing.";
  }
  if (status === "idle") return "No collection run has completed yet.";
  return "Collection status could not be read.";
}

function ingestionStatusDot(status: IngestionReadiness["status"]) {
  if (status === "healthy") return "healthy";
  if (status === "catching_up") return "policy";
  if (status === "delayed") return "stale";
  if (status === "degraded" || status === "unavailable") return "degraded";
  return "empty";
}

function formatCadence(
  seconds: number | null,
  mode: IngestionReadiness["mode"],
) {
  if (mode === "request_time") return "No background cadence";
  if (mode === "unavailable") return "Unavailable";
  if (!Number.isFinite(seconds) || seconds === null || seconds <= 0) {
    return "Not reported";
  }

  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return `Every ${hours} ${hours === 1 ? "hour" : "hours"}`;
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `Every ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  return `Every ${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function formatOperationalTimestamp(
  value: string | null | undefined,
  now: number,
  unavailableLabel: string,
) {
  const age = formatTimestampAge(value, now);
  return age ?? unavailableLabel;
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

function formatChartLabel(value: string, timeframe: Timeframe) {
  const date = new Date(value);
  if (timeframe === "1D") {
    return new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  if (timeframe === "1W" || timeframe === "1M") {
    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: timeframe === "1W" ? "numeric" : undefined,
    }).format(date);
  }
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(date);
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

function BrandMark() {
  return (
    <div className="brand-mark" aria-hidden="true">
      <span />
      <span />
      <span />
    </div>
  );
}

export function MarketDashboard({
  session,
  accountWatchlist = null,
  accountSyncUnavailable = false,
  accountHoldings = null,
  accountPortfolioUnavailable = false,
}: MarketDashboardProps) {
  const authoritativeWatchlist = useMemo(
    () => {
      if (!session.isAuthenticated) return null;
      return (accountWatchlist?.instruments ?? [])
        .map(normalizeDashboardInstrument)
        .filter(
          (instrument): instrument is DashboardInstrument => instrument !== null,
        );
    },
    [accountWatchlist, session.isAuthenticated],
  );
  const initialWatchlist = session.isAuthenticated
    ? authoritativeWatchlist ?? []
    : fixtureInstruments;
  const [watchlist, setWatchlist] =
    useState<DashboardInstrument[]>(initialWatchlist);
  const [holdings, setHoldings] = useState<DashboardHolding[]>(
    accountHoldings ?? [],
  );
  const [selectedSymbol, setSelectedSymbol] = useState<CanonicalSymbol>(
    initialWatchlist[0]?.id ?? accountHoldings?.[0]?.symbolId ?? defaultWatchlist[0],
  );
  const [timeframe, setTimeframe] = useState<Timeframe>("1D");
  const [query, setQuery] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [showMobileWatchlist, setShowMobileWatchlist] = useState(false);
  const [insightTab, setInsightTab] = useState<"view" | "evidence">("view");
  const [omnigazeViewOpen, setOmnigazeViewOpen] = useState(false);
  const [portfolioWorkspaceOpen, setPortfolioWorkspaceOpen] = useState(false);
  const [portfolioWorkspaceInitialView, setPortfolioWorkspaceInitialView] =
    useState<"position" | "research">("position");
  const [intelligenceInboxOpen, setIntelligenceInboxOpen] = useState(false);
  const [intelligenceInboxInitialTab, setIntelligenceInboxInitialTab] =
    useState<IntelligenceInboxTab>("inbox");
  const [intelligenceInboxFocusEventId, setIntelligenceInboxFocusEventId] =
    useState<string | null>(null);
  const [intelligenceInboxSaveRequest, setIntelligenceInboxSaveRequest] =
    useState<IntelligenceInboxSaveRequest | null>(null);
  const [intelligenceInboxCounts, setIntelligenceInboxCounts] =
    useState<IntelligenceInboxCounts>(emptyInboxCounts);
  const [portfolioAvailability, setPortfolioAvailability] =
    useState<PortfolioAvailability>(
      accountPortfolioUnavailable ? "unavailable" : "ready",
    );
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
  const [chartResources, setChartResources] = useState<Record<string, ChartResource>>(
    {},
  );
  const [catalogSearch, setCatalogSearch] = useState<CatalogSearchResource>({
    data: [],
    phase: "idle",
    query: "",
  });
  const [searchGeneration, setSearchGeneration] = useState(0);
  const [watchlistSyncPhase, setWatchlistSyncPhase] =
    useState<WatchlistSyncPhase>(() => {
      if (!session.isAuthenticated) return "local";
      if (accountSyncUnavailable || !accountWatchlist) return "unavailable";
      return "synced";
    });
  const [watchlistSyncMessage, setWatchlistSyncMessage] = useState<string | null>(
    null,
  );
  const searchInputRef = useRef<HTMLInputElement>(null);
  const preferencesTouchedRef = useRef(false);
  const intelligenceInboxSaveNonceRef = useRef(0);
  const shellRef = useRef<HTMLElement>(null);
  const accountPersistenceEnabled =
    session.isAuthenticated && Boolean(accountWatchlist) && !accountSyncUnavailable;
  const watchlistName = accountWatchlist?.name ?? "Core holdings";
  const watchlistIds = useMemo(
    () => new Set(watchlist.map(({ id }) => id)),
    [watchlist],
  );
  const holdingsBySymbol = useMemo(
    () => new Map(holdings.map((holding) => [holding.symbolId, holding])),
    [holdings],
  );
  const visibleInstruments = useMemo(() => {
    const visible = new Map(watchlist.map((instrument) => [instrument.id, instrument]));
    for (const holding of holdings) {
      if (visible.has(holding.symbolId)) continue;
      const workspace = workspaceBySymbol.get(holding.symbolId);
      const [canonicalExchange, canonicalTicker] = holding.symbolId.split(":");
      const ticker = holding.ticker ?? workspace?.instrument.ticker ?? canonicalTicker;
      const exchange =
        holding.exchange ?? workspace?.instrument.exchange ?? canonicalExchange;
      const name = holding.name ?? workspace?.instrument.name ?? ticker;
      if (!ticker || !exchange || !name) continue;
      visible.set(holding.symbolId, {
        id: holding.symbolId,
        ticker,
        exchange,
        name,
        sector: workspace?.instrument.sector ?? null,
        currency: "USD",
      });
    }
    return [...visible.values()];
  }, [holdings, watchlist]);
  const hasMarketSelection = visibleInstruments.some(
    ({ id }) => id === selectedSymbol,
  );

  useEffect(() => {
    shellRef.current?.setAttribute("data-hydrated", "true");
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (preferencesTouchedRef.current) return;
      if (session.isAuthenticated) {
        const nextWatchlist = authoritativeWatchlist ?? [];
        setWatchlist(nextWatchlist);
        setSelectedSymbol((current) =>
          nextWatchlist.some(({ id }) => id === current) ||
          accountHoldings?.some(({ symbolId }) => symbolId === current)
            ? current
            : nextWatchlist[0]?.id ??
              accountHoldings?.[0]?.symbolId ??
              defaultWatchlist[0],
        );
        return;
      }
      const preferences = readDashboardPreferences();
      if (!preferences) return;
      setWatchlist(preferences.instruments);
      setSelectedSymbol(preferences.selectedSymbol);
      setTimeframe(preferences.timeframe);
      writeDashboardPreferences(
        preferences.instruments,
        preferences.selectedSymbol,
        preferences.timeframe,
      );
    }, 0);

    return () => window.clearTimeout(timer);
  }, [accountHoldings, authoritativeWatchlist, session.isAuthenticated]);

  useEffect(() => {
    if (session.isAuthenticated || typeof window === "undefined") return;
    const timer = window.setTimeout(() => {
      const draft = parseOnboardingDraft(
        window.localStorage.getItem(ONBOARDING_DRAFT_KEY),
        fixtureInstruments.map(({ id }) => id),
      );
      const nextHoldings = draft?.completedAt
        ? draft.positions
          .filter(
            (position) =>
              position.owned &&
              isPortfolioDecimal(position.shares, {
                allowZero: false,
                maxMicros: MAX_QUANTITY_MICROS,
              }) &&
              (!position.averageCost ||
                isPortfolioDecimal(position.averageCost, {
                  allowZero: true,
                  maxMicros: MAX_AVERAGE_COST_MICROS,
                })),
          )
          .map((position) => ({
            symbolId: position.symbolId,
            quantity: position.shares,
            averageCost: position.averageCost || null,
            version: null,
            persistence: "browser" as const,
          }))
        : [];
      setHoldings((current) =>
        current.length === nextHoldings.length &&
        current.every(
          (holding, index) =>
            holding.symbolId === nextHoldings[index]?.symbolId &&
            holding.quantity === nextHoldings[index]?.quantity &&
            holding.averageCost === nextHoldings[index]?.averageCost,
        )
          ? current
          : nextHoldings,
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [session.isAuthenticated]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!showSearch || !normalizedQuery) return;

    const controller = new AbortController();
    let stopped = false;
    const timer = window.setTimeout(() => {
      setCatalogSearch({ data: [], phase: "loading", query: normalizedQuery });
      void fetchApi<CatalogSearchResponse>(
        `/api/assets/search?q=${encodeURIComponent(normalizedQuery)}&limit=20`,
        controller.signal,
      )
        .then((result) => {
          if (stopped) return;
          setCatalogSearch({
            data: result.data.map((instrument) => ({
              id: instrument.symbolId,
              ticker: instrument.symbol,
              exchange: instrument.exchange,
              name: instrument.name,
              sector: null,
              currency: "USD",
            })),
            phase: "ready",
            query: normalizedQuery,
            meta: result.meta,
          });
        })
        .catch((error) => {
          if (stopped || controller.signal.aborted) return;
          setCatalogSearch({
            data: [],
            phase: "error",
            query: normalizedQuery,
            error:
              error instanceof Error
                ? error.message
                : "Stock search is temporarily unavailable.",
          });
        });
    }, 250);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchGeneration, showSearch]);

  useEffect(() => {
    if (visibleInstruments.length === 0) return;
    let stopped = false;
    let timer: number | undefined;
    let activeController: AbortController | undefined;
    const symbols = Array.from(
      new Set([selectedSymbol, ...visibleInstruments.map(({ id }) => id)]),
    ).slice(0, 12);

    async function poll() {
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(poll, SNAPSHOT_POLL_MS);
        return;
      }

      activeController = new AbortController();
      const timeout = window.setTimeout(() => activeController?.abort(), 10_000);
      try {
        const envelope = await fetchApi<SnapshotBatchResponse>(
          `/api/market/snapshots?symbols=${encodeURIComponent(symbols.join(","))}`,
          activeController.signal,
        );
        if (stopped) return;

        const itemsBySymbol = new Map(
          envelope.data.map((item) => [item.symbolId, item]),
        );
        const receivedAt = new Date().toISOString();
        setSnapshotResources((current) => {
          const next = { ...current };
          for (const symbol of symbols) {
            const item = itemsBySymbol.get(symbol);
            if (
              item?.status === "ready" &&
              item.data.symbolId === symbol
            ) {
              next[symbol] = {
                data: item.data,
                meta: item.meta,
                phase: "ready",
                receivedAt,
              };
              continue;
            }
            next[symbol] = {
              ...next[symbol],
              phase: "error",
              error:
                item?.status === "error"
                  ? item.error
                  : "Snapshot identity did not match the requested symbol.",
            };
          }
          return next;
        });
      } catch (error) {
        if (stopped) return;
        setSnapshotResources((current) => {
          const next = { ...current };
          for (const symbol of symbols) {
            next[symbol] = {
              ...next[symbol],
              phase: "error",
              error:
                error instanceof Error
                  ? error.message
                  : "Snapshot request failed.",
            };
          }
          return next;
        });
      } finally {
        window.clearTimeout(timeout);
        if (!stopped) {
          setNow(Date.now());
          timer = window.setTimeout(poll, SNAPSHOT_POLL_MS);
        }
      }
    }

    void poll();
    return () => {
      stopped = true;
      activeController?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [refreshGeneration, selectedSymbol, visibleInstruments]);

  useEffect(() => {
    if (!hasMarketSelection) return;
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
            data: envelope.data.filter((item) =>
              item.symbolIds.includes(selectedSymbol),
            ),
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
  }, [hasMarketSelection, refreshGeneration, selectedSymbol]);

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

  useEffect(() => {
    if (!session.isAuthenticated || intelligenceInboxOpen) return;
    let stopped = false;
    let timer: number | undefined;
    let activeController: AbortController | undefined;

    async function poll() {
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(poll, INBOX_COUNT_POLL_MS);
        return;
      }

      activeController = new AbortController();
      const timeout = window.setTimeout(() => activeController?.abort(), 10_000);
      let nextPollMs = INBOX_COUNT_POLL_MS;
      try {
        const envelope = await fetchApi<{
          data: { counts: IntelligenceInboxCounts };
          meta?: { sync?: { hasMoreCandidates?: boolean } };
        }>(
          "/api/intelligence/inbox?filter=all&limit=1",
          activeController.signal,
        );
        if (!stopped) {
          setIntelligenceInboxCounts(envelope.data.counts);
          if (envelope.meta?.sync?.hasMoreCandidates) nextPollMs = 2_000;
        }
      } catch {
        // Keep the last verified count. The drawer exposes detailed sync status.
      } finally {
        window.clearTimeout(timeout);
        if (!stopped) timer = window.setTimeout(poll, nextPollMs);
      }
    }

    void poll();
    return () => {
      stopped = true;
      activeController?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [intelligenceInboxOpen, refreshGeneration, session.isAuthenticated]);

  useEffect(() => {
    if (!hasMarketSelection) return;
    const key = `${selectedSymbol}:${timeframe}`;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    void fetchApi<{
      data: HistoricalMarketSeries;
      meta: { dataMode: "live"; freshness: { state: string; asOf: string | null } };
    }>(
      `/api/market/bars?symbol=${encodeURIComponent(selectedSymbol)}&timeframe=${timeframe}`,
      controller.signal,
    )
      .then((envelope) => {
        if (envelope.data.symbolId !== selectedSymbol) {
          throw new Error("History identity did not match the requested symbol.");
        }
        setChartResources((current) => ({
          ...current,
          [key]: {
            data: envelope.data,
            phase: "ready",
            receivedAt: new Date().toISOString(),
          },
        }));
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setChartResources((current) => ({
          ...current,
          [key]: {
            ...current[key],
            phase: "error",
            error:
              error instanceof Error
                ? error.message
                : "Historical market data is unavailable.",
          },
        }));
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [hasMarketSelection, refreshGeneration, selectedSymbol, timeframe]);

  const selectedWorkspace = hasMarketSelection
    ? workspaceBySymbol.get(selectedSymbol)
    : undefined;
  const selectedInstrument =
    visibleInstruments.find(({ id }) => id === selectedSymbol) ??
    (selectedWorkspace
      ? { ...selectedWorkspace.instrument, currency: "USD" as const }
      : {
          id: selectedSymbol,
          ticker: selectedSymbol.split(":")[1] ?? selectedSymbol,
          exchange: selectedSymbol.split(":")[0] ?? "UNKNOWN",
          name: selectedSymbol.split(":")[1] ?? selectedSymbol,
          sector: null,
          currency: "USD" as const,
        });
  const watchedStocks = visibleInstruments.map((instrument) => ({
    instrument,
    workspace: workspaceBySymbol.get(instrument.id),
    holding: holdingsBySymbol.get(instrument.id),
  }));
  const selectedHolding = holdingsBySymbol.get(selectedSymbol);
  const selectedAverageCost = selectedHolding?.averageCost
    ? Number(selectedHolding.averageCost)
    : null;
  const hasSelectedAverageCost =
    selectedAverageCost !== null &&
    Number.isFinite(selectedAverageCost) &&
    selectedAverageCost >= 0;
  const selectedSnapshotResource = snapshotResources[selectedSymbol];
  const snapshot = selectedSnapshotResource?.data ?? selectedWorkspace?.snapshot;
  const intelligenceMatchesSelection =
    intelligenceResource.symbolId === selectedSymbol;
  const intelligencePhase: FetchPhase = intelligenceMatchesSelection
    ? intelligenceResource.phase
    : "loading";
  const feedItems =
    hasMarketSelection &&
    intelligenceMatchesSelection &&
    intelligenceResource.phase === "ready"
      ? intelligenceResource.data.filter((item) =>
          item.symbolIds.includes(selectedSymbol),
        )
      : [];
  const events =
    hasMarketSelection &&
    intelligenceMatchesSelection &&
    intelligenceResource.phase === "ready"
      ? feedItems.map((item) => normalizeFeedItem(item, selectedSymbol))
      : selectedWorkspace?.events ?? [];
  const feedItemById = new Map(feedItems.map((item) => [item.id, item]));
  const viewHeadline =
    selectedWorkspace?.events[0]?.headline ??
    `Awaiting evidence-backed analysis for ${selectedInstrument.ticker}`;
  const snapshotUsesApi = Boolean(selectedSnapshotResource?.data);
  const fixtureData = snapshot
    ? isFixtureSource(selectedSnapshotResource?.meta, snapshot)
    : false;
  const hasProviderSnapshot = snapshotUsesApi && !fixtureData;
  const providerSnapshotIsStale =
    hasProviderSnapshot &&
    (selectedSnapshotResource?.phase === "error" ||
      selectedSnapshotResource?.meta?.freshness.state !== "fresh");
  const sourceState =
    !hasMarketSelection
      ? "empty"
      : providerSnapshotIsStale
      ? "stale"
      : hasProviderSnapshot
      ? "provider"
      : selectedSnapshotResource?.phase === "error"
        ? selectedWorkspace
          ? "fallback"
          : "unavailable"
        : Boolean(selectedSnapshotResource?.meta?.fallbackReason)
          ? selectedWorkspace
            ? "fallback"
            : "unavailable"
          : fixtureData
            ? "fixture"
            : "loading";
  const sourceLabel =
    sourceState === "empty"
      ? "No symbol selected"
      : sourceState === "provider"
      ? snapshot?.provider ?? "Provider quote"
      : sourceState === "stale"
        ? "Last known provider quote"
      : sourceState === "fallback"
        ? "Bundled demo fallback"
        : sourceState === "unavailable"
          ? "Quote unavailable"
        : sourceState === "loading"
          ? "Loading provider status"
          : "Omnigaze demo fixture";
  const freshness = formatFreshness(
    selectedSnapshotResource?.meta?.freshness.asOf ?? snapshot?.asOf,
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
  const ingestionReadiness = healthResource.data?.readiness?.ingestion;
  const ingestionUnavailable =
    ingestionReadiness?.mode === "unavailable" ||
    ingestionReadiness?.status === "unavailable";
  const applicationHealthDot =
    healthResource.phase === "ready" && healthResource.data?.status === "degraded"
      ? "degraded"
      : healthResource.phase;
  const positiveMovers = watchedStocks.filter(({ instrument, workspace }) => {
    return (
      (snapshotResources[instrument.id]?.data ?? workspace?.snapshot)?.change ?? 0
    ) > 0;
  }).length;
  const materialEventCount = events.filter((event) =>
    ["high", "critical"].includes(event.materiality),
  ).length;
  const dataModeLabel =
    sourceState === "empty"
      ? "No symbols selected"
      : sourceState === "provider"
      ? "Provider data"
      : sourceState === "stale"
        ? "Provider quote · stale"
      : sourceState === "unavailable"
        ? "Quote unavailable"
      : sourceState === "loading"
        ? "Checking source"
        : "Demo data";

  const normalizedSearchQuery = query.trim();
  const catalogMatchesQuery = catalogSearch.query === normalizedSearchQuery;
  const activeSearchPhase = normalizedSearchQuery
    ? catalogMatchesQuery
      ? catalogSearch.phase
      : "loading"
    : "idle";
  const searchResults = normalizedSearchQuery && catalogMatchesQuery
    ? catalogSearch.data
    : normalizedSearchQuery
      ? []
      : fixtureInstruments;

  const chartResource = chartResources[`${selectedSymbol}:${timeframe}`];
  const providerChartData: MarketPoint[] =
    chartResource?.data?.bars.map((bar) => ({
      timestamp: bar.timestamp,
      label: formatChartLabel(bar.timestamp, timeframe),
      price: bar.close,
      volume: bar.volume,
    })) ?? [];
  const chartUsesProvider = providerChartData.length > 0;
  const chartIsStale =
    chartUsesProvider && chartResource?.phase === "error";
  const chartUsesFixture =
    !chartUsesProvider && Boolean(selectedWorkspace?.chart[timeframe].length);
  const chartData = chartUsesProvider
    ? providerChartData
    : selectedWorkspace?.chart[timeframe] ?? [];
  const chartUnavailable =
    !chartUsesProvider &&
    (chartResource?.phase === "error" ||
      (chartResource?.phase === "ready" && providerChartData.length === 0));
  const positive = snapshot ? snapshot.change >= 0 : true;
  const chartColor = positive ? "#22d3a7" : "#ff6b7d";

  async function persistWatchlistMutation(
    operation: "add" | "remove",
    symbol: CanonicalSymbol,
    rollback: () => void,
  ) {
    if (!accountPersistenceEnabled || !accountWatchlist) return;

    setWatchlistSyncPhase("saving");
    setWatchlistSyncMessage(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);

    try {
      const response = await fetch("/api/watchlists", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          operation,
          watchlist_id: accountWatchlist.id,
          symbol_id: symbol,
        }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as
        | { error?: string }
        | null;
      if (!response.ok) {
        throw new Error(body?.error || `Watchlist save failed with ${response.status}.`);
      }
      setWatchlistSyncPhase("synced");
    } catch (error) {
      rollback();
      setWatchlistSyncPhase("error");
      setWatchlistSyncMessage(
        error instanceof Error
          ? `${error.message} Your last change was rolled back.`
          : "Watchlist sync failed. Your last change was rolled back.",
      );
    } finally {
      window.clearTimeout(timeout);
    }
  }

  function persistAnonymousPreferences(
    instruments: DashboardInstrument[],
    symbol: CanonicalSymbol,
    nextTimeframe: Timeframe,
  ) {
    if (session.isAuthenticated) return;
    writeDashboardPreferences(instruments, symbol, nextTimeframe);
  }

  function selectStock(symbol: CanonicalSymbol) {
    preferencesTouchedRef.current = true;
    setSelectedSymbol(symbol);
    setShowSearch(false);
    setShowMobileWatchlist(false);
    persistAnonymousPreferences(watchlist, symbol, timeframe);
  }

  function openStockSearch() {
    setShowSearch(true);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  function addStock(instrument: DashboardInstrument) {
    if (watchlistSyncPhase === "saving") return;
    if (session.isAuthenticated && !accountPersistenceEnabled) {
      setWatchlistSyncMessage(
        "Your account watchlist is unavailable, so this change was not applied.",
      );
      return;
    }
    const symbol = instrument.id;
    preferencesTouchedRef.current = true;
    const previousWatchlist = watchlist;
    const previousSelected = selectedSymbol;
    const nextWatchlist = watchlistIds.has(symbol)
      ? watchlist
      : [...watchlist, instrument];
    setWatchlist(nextWatchlist);
    setSelectedSymbol(symbol);
    setShowSearch(false);
    setShowMobileWatchlist(false);
    persistAnonymousPreferences(nextWatchlist, symbol, timeframe);
    if (!watchlistIds.has(symbol)) {
      void persistWatchlistMutation("add", symbol, () => {
        setWatchlist(previousWatchlist);
        setSelectedSymbol(previousSelected);
        persistAnonymousPreferences(previousWatchlist, previousSelected, timeframe);
      });
    }
  }

  function removeStock(symbol: CanonicalSymbol) {
    if (watchlistSyncPhase === "saving") return;
    if (session.isAuthenticated && !accountPersistenceEnabled) {
      setWatchlistSyncMessage(
        "Your account watchlist is unavailable, so this change was not applied.",
      );
      return;
    }
    preferencesTouchedRef.current = true;
    const previousWatchlist = watchlist;
    const previousSelected = selectedSymbol;
    const nextWatchlist = watchlist.filter((item) => item.id !== symbol);
    const nextSelected =
      symbol === selectedSymbol && nextWatchlist[0]
        ? nextWatchlist[0].id
        : selectedSymbol;
    setWatchlist(nextWatchlist);
    if (nextSelected !== selectedSymbol) setSelectedSymbol(nextSelected);
    persistAnonymousPreferences(nextWatchlist, nextSelected, timeframe);
    void persistWatchlistMutation("remove", symbol, () => {
      setWatchlist(previousWatchlist);
      setSelectedSymbol(previousSelected);
      persistAnonymousPreferences(previousWatchlist, previousSelected, timeframe);
    });
  }

  function chooseTimeframe(nextTimeframe: Timeframe) {
    preferencesTouchedRef.current = true;
    setTimeframe(nextTimeframe);
    persistAnonymousPreferences(watchlist, selectedSymbol, nextTimeframe);
  }

  function openPortfolioWorkspace(view: "position" | "research") {
    if (!hasMarketSelection) return;
    setPortfolioWorkspaceInitialView(view);
    setPortfolioWorkspaceOpen(true);
  }

  function openLiveOmnigazeView() {
    if (!hasMarketSelection) return;
    setOmnigazeViewOpen(true);
  }

  function openIntelligenceInbox(
    tab: IntelligenceInboxTab = "inbox",
    focusEventId: string | null = null,
  ) {
    setIntelligenceInboxInitialTab(tab);
    setIntelligenceInboxFocusEventId(focusEventId);
    setIntelligenceInboxSaveRequest(null);
    setIntelligenceInboxOpen(true);
  }

  function saveTimelineEvent(eventId: string) {
    intelligenceInboxSaveNonceRef.current += 1;
    setIntelligenceInboxInitialTab("inbox");
    setIntelligenceInboxFocusEventId(eventId);
    setIntelligenceInboxSaveRequest({
      eventId,
      nonce: intelligenceInboxSaveNonceRef.current,
    });
    setIntelligenceInboxOpen(true);
  }

  function upsertHolding(nextHolding: PortfolioWorkspaceHolding) {
    setHoldings((current) => {
      const remaining = current.filter(
        ({ symbolId }) => symbolId !== nextHolding.symbolId,
      );
      return [...remaining, nextHolding].sort((left, right) =>
        left.symbolId.localeCompare(right.symbolId),
      );
    });
    setPortfolioAvailability("ready");
  }

  function removeHolding(symbolId: CanonicalSymbol) {
    setHoldings((current) =>
      current.filter((holding) => holding.symbolId !== symbolId),
    );
    setPortfolioAvailability("ready");
  }

  function reloadPortfolio(nextHoldings: PortfolioWorkspaceHolding[]) {
    setHoldings(nextHoldings);
    setPortfolioAvailability("ready");
  }

  return (
    <main ref={shellRef} className="omnigaze-shell" data-hydrated="false">
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
            <div className="search-results" role="listbox" aria-label="Stock search results">
              <div className="search-results-header">
                <span>
                  {normalizedSearchQuery
                    ? catalogSearch.meta?.freshness.state === "stale" && catalogMatchesQuery
                      ? "Stocks · cached catalog"
                      : "Stocks · active US equities"
                    : "Starter symbols · demo fixtures"}
                </span>
                <button
                  type="button"
                  aria-label="Close search"
                  onClick={() => setShowSearch(false)}
                >
                  <X size={15} />
                </button>
              </div>
              {normalizedSearchQuery && activeSearchPhase === "loading" ? (
                <div className="search-empty-state" role="status" aria-live="polite">
                  <RefreshCw className="sync-spinner" size={17} />
                  <div>
                    <strong>Searching the active catalog</strong>
                    <span>Checking symbols and company names…</span>
                  </div>
                </div>
              ) : normalizedSearchQuery && activeSearchPhase === "error" ? (
                <div className="search-empty-state search-error-state" role="status" aria-live="polite">
                  <WifiOff size={17} />
                  <div>
                    <strong>Stock search is temporarily unavailable</strong>
                    <span>{catalogSearch.error ?? "No catalog results are being substituted."}</span>
                    <button
                      type="button"
                      onClick={() => setSearchGeneration((current) => current + 1)}
                    >
                      Retry search
                    </button>
                  </div>
                </div>
              ) : searchResults.length > 0 ? (
                <>
                  {normalizedSearchQuery && catalogSearch.meta?.freshness.state === "stale" && (
                    <div className="search-catalog-notice" role="status">
                      <Clock3 size={13} /> Catalog refresh delayed; showing the last verified list ({formatFreshness(catalogSearch.meta.catalogAsOf, now)}).
                    </div>
                  )}
                  {searchResults.map((instrument) => {
                    const alreadyWatched = watchlistIds.has(instrument.id);
                    const fixture = workspaceBySymbol.get(instrument.id);
                    return (
                      <button
                        key={instrument.id}
                        type="button"
                        role="option"
                        aria-selected={alreadyWatched}
                        className="search-result-row"
                        disabled={watchlistSyncPhase === "saving"}
                        onClick={() => addStock(instrument)}
                      >
                        <span className="symbol-avatar">{instrument.ticker[0]}</span>
                        <span className="search-result-name">
                          <strong>{instrument.ticker}</strong>
                          <small>{instrument.name}</small>
                        </span>
                        <span className="search-result-meta">
                          {normalizedSearchQuery
                            ? instrument.exchange
                            : fixture
                              ? "DEMO"
                              : instrument.exchange}
                        </span>
                        {alreadyWatched ? <Star size={14} fill="currentColor" /> : <Plus size={15} />}
                      </button>
                    );
                  })}
                </>
              ) : (
                <div className="search-empty-state" role="status">
                  <Search size={17} />
                  <div><strong>No matching stocks</strong><span>Try another active US ticker or company name.</span></div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="topbar-actions">
          <div className="market-status">
            <span className={`status-dot ${sourceState}`} />
            <span>
              {sourceState === "empty"
                ? "No symbols selected"
                : sourceState === "provider" && snapshot
                ? sessionLabel(snapshot.session)
                : sourceState === "stale"
                  ? "Last known provider quote"
                : sourceState === "unavailable"
                  ? "Quote unavailable"
                  : sourceState === "loading" && !selectedWorkspace
                    ? "Loading market context"
                    : "Demo market context"}
            </span>
            <small>
              {sourceState === "empty"
                ? "add a stock"
                : sourceState === "provider" || sourceState === "stale"
                ? freshness
                : "not live"}
            </small>
          </div>
          <button
            type="button"
            className="top-add-stock"
            data-testid="top-add-stock"
            onClick={openStockSearch}
          >
            <Plus size={15} /><span>Add stock</span>
          </button>
          <button
            type="button"
            className="icon-button inbox-bell"
            aria-label={
              intelligenceInboxCounts.unread > 0
                ? `Open intelligence inbox, ${intelligenceInboxCounts.unread} unread`
                : "Open intelligence inbox"
            }
            aria-haspopup="dialog"
            aria-expanded={intelligenceInboxOpen}
            data-testid="intelligence-inbox-trigger"
            onClick={() => openIntelligenceInbox("inbox")}
          >
            <Bell size={18} />
            {intelligenceInboxCounts.unread > 0 && (
              <span className="inbox-badge" aria-hidden="true">
                {intelligenceInboxCounts.unread > 99
                  ? "99+"
                  : intelligenceInboxCounts.unread}
              </span>
            )}
          </button>
          {session.isAuthenticated ? (
            <a
              className="profile-button"
              href={session.signOutPath}
              target="_top"
              aria-label={`Sign out ${session.displayName}`}
              title={`${session.displayName} · synced account`}
            >
              {session.initials}
            </a>
          ) : (
            <a
              className="topbar-sign-in"
              href={session.signInPath}
              target="_top"
            >
              <LogIn size={14} /> Sign in to sync
            </a>
          )}
        </div>
      </header>

      <div className={`demo-banner ${sourceState}`} role="status" aria-live="polite">
        {sourceState === "empty" ? (
          <Plus size={14} />
        ) : sourceState === "fallback" ||
        sourceState === "unavailable" ||
        sourceState === "stale" ? (
          <WifiOff size={14} />
        ) : sourceState === "provider" ? (
          <RefreshCw size={14} />
        ) : sourceState === "loading" ? (
          <Server size={14} />
        ) : (
          <Sparkles size={14} />
        )}
        <span>
          {sourceState === "empty"
            ? "Add a stock to start provider-backed market and intelligence monitoring."
            : sourceState === "provider"
            ? `${snapshot?.provider} · ${snapshot?.isDelayed ? `delayed ${Math.max(1, Math.ceil(snapshot.delaySeconds / 60))}m` : "provider-reported quote"} · ${freshness}`
            : sourceState === "stale"
              ? `${snapshot?.provider ?? "Provider"} · last known quote · ${selectedSnapshotResource?.phase === "error" ? "refresh failed" : "provider marked stale or freshness is unknown"} · ${freshness}`
            : sourceState === "fallback"
              ? "Provider API unavailable — bundled demo fixture shown. This is not live market data."
              : sourceState === "unavailable"
                ? `Live quote unavailable for ${selectedInstrument.ticker} — Omnigaze is not substituting another company's data.`
              : sourceState === "loading"
                ? selectedWorkspace
                  ? "Checking market data API — this symbol's bundled demo fixture is shown meanwhile. It is not live market data."
                  : `Loading a provider quote for ${selectedInstrument.ticker}. No substitute quote is being shown.`
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
              aria-label="Refresh displayed data and status"
              onClick={() => setRefreshGeneration((current) => current + 1)}
            >
              <RefreshCw size={14} /> Refresh view
            </button>
          </div>

          <dl className="data-status-grid">
            <div>
              <dt>Displayed quote</dt>
              <dd><span className={`health-dot ${sourceState}`} />{sourceLabel}</dd>
              <small>
                {sourceState === "empty"
                  ? "No quote is displayed until a stock is selected."
                  : sourceState === "provider"
                  ? `${freshness} · ${snapshot?.marketCoverage.replaceAll("-", " ")} coverage`
                  : sourceState === "stale"
                    ? `${freshness} · retained for context after freshness degraded; this is not a current quote.`
                  : sourceState === "unavailable"
                    ? `No quote is displayed for ${selectedInstrument.ticker}; another symbol's fixture is never substituted.`
                    : "Fixture values are never presented as live."}
              </small>
            </div>
            <div>
              <dt>Application API</dt>
              <dd>
                <span className={`health-dot ${applicationHealthDot}`} />
                {healthResource.phase === "ready"
                  ? `${healthResource.data?.service ?? "Omnigaze web"} · ${healthResource.data?.status ?? "responding"}`
                  : healthResource.phase === "loading"
                    ? "Checking"
                    : "Unreachable"}
              </dd>
              <small>
                {healthResource.error ??
                  formatHealthTiming(
                    healthResource.data?.checkedAt,
                    healthResource.receivedAt,
                    now,
                  )}
              </small>
            </div>
            <div>
              <dt>Intelligence feed</dt>
              <dd>
                <span className={`health-dot ${intelligencePhase}`} />
                {intelligencePhase === "ready"
                  ? intelligenceResource.meta?.dataMode === "demo"
                    ? selectedWorkspace
                      ? "Demo intelligence adapter"
                      : "Awaiting provider evidence"
                    : "API connected"
                  : intelligencePhase === "loading"
                    ? "Checking"
                    : selectedWorkspace
                      ? "Bundled fallback"
                      : "Unavailable"}
              </dd>
              <small>
                {(intelligenceMatchesSelection ? intelligenceResource.error : undefined) ??
                  (intelligenceMatchesSelection &&
                  intelligenceResource.meta?.freshness.state === "fixture"
                    ? "Fixture timestamps are illustrative."
                    : formatEvidenceTiming(
                        intelligenceMatchesSelection
                          ? intelligenceResource.meta?.freshness.asOf
                          : undefined,
                        intelligenceMatchesSelection
                          ? intelligenceResource.receivedAt
                          : undefined,
                        now,
                      ))}
              </small>
            </div>
            <div data-testid="ingestion-status">
              <dt>Evidence collection</dt>
              <dd>
                <span
                  aria-hidden="true"
                  className={`health-dot ${
                    ingestionReadiness
                      ? ingestionStatusDot(ingestionReadiness.status)
                      : healthResource.phase === "loading"
                        ? "loading"
                        : "unavailable"
                  }`}
                />
                {healthResource.phase === "loading"
                  ? "Checking"
                  : ingestionReadiness
                    ? ingestionUnavailable
                      ? "Status unavailable"
                      : `${formatIngestionMode(ingestionReadiness.mode)} · ${formatIngestionStatus(ingestionReadiness.status)}`
                    : "Status unavailable"}
              </dd>
              {ingestionReadiness ? (
                <small className="collection-status-details">
                  <span>
                    {ingestionUnavailable
                      ? "Collection status could not be read."
                      : ingestionStatusDescription(ingestionReadiness.status)}
                  </span>
                  <span>
                    <strong>Last success:</strong>{" "}
                    {formatOperationalTimestamp(
                      ingestionReadiness.lastSuccessAt,
                      now,
                      ingestionUnavailable
                        ? "Unavailable"
                        : "No successful collection recorded",
                    )}
                  </span>
                  <span>
                    <strong>Latest evidence:</strong>{" "}
                    {formatOperationalTimestamp(
                      ingestionReadiness.latestEvidenceAt,
                      now,
                      ingestionUnavailable
                        ? "Unavailable"
                        : "No collected evidence timestamp",
                    )}
                  </span>
                  <span>
                    <strong>Expected cadence:</strong>{" "}
                    {formatCadence(
                      ingestionReadiness.expectedCadenceSeconds,
                      ingestionReadiness.mode,
                    )}
                  </span>
                  <span>
                    <strong>Status calculated:</strong>{" "}
                    {formatOperationalTimestamp(
                      ingestionReadiness.generatedAt,
                      now,
                      "Timestamp unavailable",
                    )}
                  </span>
                </small>
              ) : (
                <small>
                  {healthResource.phase === "loading"
                    ? "Waiting for collection status."
                    : "This environment did not return collection status."}
                </small>
              )}
            </div>
            <div>
              <dt>Refresh policy</dt>
              <dd><span className="health-dot policy" />Request-time while open</dd>
              <small>Quotes refresh every 30s and intelligence every 60s while this tab is visible; requests time out safely. Alerts are in-app only.</small>
            </div>
          </dl>

          <div className="provider-health-list" aria-label="Configured providers">
            {healthProviders.length > 0 ? (
              healthProviders.map((provider) => (
                <div key={provider.provider}>
                  <span className={`health-dot ${provider.status}`} />
                  <strong>{provider.provider}</strong>
                  <span>{provider.status}</span>
                  <small>
                    {provider.message ? `${provider.message} · ` : ""}
                    {formatProviderTiming(provider, now)}
                  </small>
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
              <span className="eyebrow">MY WATCHLIST</span>
              <div className="watchlist-title">{watchlistName}</div>
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

          <div
            className={`watchlist-sync-status ${watchlistSyncPhase}`}
            role="status"
            aria-live="polite"
          >
            {watchlistSyncPhase === "saving" ? (
              <RefreshCw className="sync-spinner" size={13} />
            ) : watchlistSyncPhase === "error" ||
              watchlistSyncPhase === "unavailable" ? (
              <WifiOff size={13} />
            ) : (
              <Cloud size={13} />
            )}
            <span>
              {watchlistSyncPhase === "local"
                ? "Saved on this device"
                : watchlistSyncPhase === "saving"
                  ? "Saving to your account…"
                  : watchlistSyncPhase === "synced"
                    ? "Synced across your devices"
                    : watchlistSyncPhase === "error"
                      ? watchlistSyncMessage ?? "Account sync failed; change rolled back."
                      : watchlistSyncMessage ??
                        "Account sync unavailable; local account data is not shown."}
            </span>
            {!session.isAuthenticated && (
              <a href={session.signInPath} target="_top">Sync across devices</a>
            )}
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
            {watchedStocks.map(({ instrument, workspace, holding }) => {
              const rowResource = snapshotResources[instrument.id];
              const rowSnapshot = rowResource?.data ?? workspace?.snapshot;
              const rowUsesFixture = rowSnapshot
                ? isFixtureSource(rowResource?.meta, rowSnapshot)
                : false;
              const rowIsStale =
                Boolean(rowResource?.data) &&
                !rowUsesFixture &&
                (rowResource?.phase === "error" ||
                  rowResource?.meta?.freshness.state !== "fresh");
              const rowQuoteLabel = rowSnapshot
                ? `${formatPrice(rowSnapshot.price)}, ${rowUsesFixture ? "demo fixture" : rowIsStale ? "last known provider quote, refresh failed or stale" : "provider quote"}`
                : rowResource?.phase === "error"
                  ? "quote unavailable"
                  : "quote loading";

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
                    aria-label={`${instrument.ticker}, ${rowQuoteLabel}`}
                  >
                    <span className="symbol-cell">
                      <span className="symbol-avatar small">{instrument.ticker[0]}</span>
                      <span>
                        <strong>{instrument.ticker}</strong>
                        <small>
                          {rowUsesFixture
                            ? "DEMO"
                            : rowIsStale
                              ? "STALE"
                            : rowSnapshot
                              ? instrument.exchange
                              : rowResource?.phase === "error"
                                ? "NO QUOTE"
                                : "LOADING"}
                        </small>
                        {holding && (
                          <span className="holding-badge">
                            Owned · {holding.quantity}
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="price-cell">
                      {rowSnapshot ? rowSnapshot.price.toFixed(2) : "—"}
                    </span>
                    {rowSnapshot ? (
                      <span className={movementClass(rowSnapshot.change)}>
                        <span aria-hidden="true">{rowSnapshot.change >= 0 ? "↗" : "↘"}</span>{" "}
                        {rowSnapshot.changePercent >= 0 ? "+" : ""}
                        {rowSnapshot.changePercent.toFixed(2)}%
                      </span>
                    ) : (
                      <span className="market-awaiting">Awaiting</span>
                    )}
                  </button>
                  {watchlistIds.has(instrument.id) && (
                    <button
                      type="button"
                      className="remove-stock"
                      aria-label={`Remove ${instrument.ticker} from watchlist`}
                      disabled={watchlistSyncPhase === "saving"}
                      onClick={() => removeStock(instrument.id)}
                    >
                      <X size={13} />
                    </button>
                  )}
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
              <div><strong>{sourceState === "provider" ? "API" : sourceState === "stale" ? "STALE" : sourceState === "unavailable" || sourceState === "empty" ? "—" : "DEMO"}</strong><span>quote source</span></div>
              <div><strong>{watchlist.length}</strong><span>tracked symbols</span></div>
            </div>
          </div>

          <nav className="side-nav" aria-label="Application">
            <button type="button"><Layers3 size={16} /> Intelligence feed</button>
            <button
              type="button"
              disabled={!hasMarketSelection}
              onClick={openLiveOmnigazeView}
            >
              <MessageSquareText size={16} /> Ask Omnigaze
            </button>
            <button
              type="button"
              disabled={!hasMarketSelection}
              onClick={() => openPortfolioWorkspace("research")}
            >
              <Gauge size={16} /> Research scenarios
            </button>
            <Link href="/onboarding"><Settings2 size={16} /> Preferences</Link>
            {session.isAuthenticated && (
              <a href={session.signOutPath} target="_top">
                <LogOut size={16} /> Sign out
              </a>
            )}
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
              <Link className="secondary-action" href="/onboarding">
                <Settings2 size={15} /> Edit setup
              </Link>
            </div>
            <div className="overview-metrics" aria-label="Watchlist overview">
              <span><strong>{watchlist.length}</strong> tracked</span>
              <span>
                <strong>{portfolioAvailability === "unavailable" ? "—" : holdings.length}</strong> held
              </span>
              <span><strong>{materialEventCount}</strong> material events</span>
              <span className={`overview-source ${sourceState}`}><i />{dataModeLabel}</span>
              {session.isAuthenticated && portfolioAvailability === "unavailable" && (
                <span><TriangleAlert size={11} /> Holdings sync unavailable</span>
              )}
            </div>
          </section>

          <DailyBriefCard session={session} />

          {visibleInstruments.length === 0 ? (
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
              <small>Search any active US equity by ticker or company name.</small>
            </section>
          ) : (
          <>
          <div className="symbol-header">
            <div className="symbol-identity">
              <span className="symbol-avatar large">{selectedInstrument.ticker[0]}</span>
              <div>
                <div className="ticker-line">
                  <h2>{selectedInstrument.ticker}</h2>
                  <span>{selectedInstrument.exchange}</span>
                  <button type="button" aria-label={`Favorite ${selectedInstrument.ticker}`}>
                    <Star size={16} />
                  </button>
                </div>
                <p>{selectedInstrument.name}</p>
                <button
                  type="button"
                  className="position-context position-context-button"
                  onClick={() => openPortfolioWorkspace("position")}
                >
                  <Settings2 size={11} />
                  {selectedHolding ? (
                    <>
                      Own {selectedHolding.quantity} shares
                      {hasSelectedAverageCost
                        ? ` · ${formatPrice(selectedAverageCost)} average cost`
                        : ""}
                    </>
                  ) : (
                    <>Add position</>
                  )}
                </button>
              </div>
            </div>
            <div className="quote-block">
              <strong>{snapshot ? formatPrice(snapshot.price) : "—"}</strong>
              {snapshot ? (
                <span className={movementClass(snapshot.change)}>
                  {snapshot.change >= 0 ? (
                    <TrendingUp size={16} aria-hidden="true" />
                  ) : (
                    <TrendingDown size={16} aria-hidden="true" />
                  )}
                  {snapshot.change >= 0 ? "+" : ""}
                  {snapshot.change.toFixed(2)} ({snapshot.changePercent.toFixed(2)}%)
                </span>
              ) : (
                <span className="market-awaiting">
                  {selectedSnapshotResource?.phase === "error"
                    ? "Quote unavailable"
                    : "Loading quote"}
                </span>
              )}
              <small>
                {sourceState === "provider" && snapshot
                  ? `${snapshot.isDelayed ? `Delayed ${Math.max(1, Math.ceil(snapshot.delaySeconds / 60))} min` : "Provider timestamp"} · ${freshness}`
                  : sourceState === "stale"
                    ? `Last known provider quote · ${freshness} · not current`
                  : sourceState === "unavailable"
                    ? `No substitute data shown for ${selectedInstrument.ticker}`
                  : `${sourceLabel} · not live`}
              </small>
            </div>
          </div>

          <div className="metric-strip">
            <div><span>Previous close</span><strong>{snapshot ? formatPrice(snapshot.previousClose) : "Unavailable"}</strong></div>
            <div><span>Volume</span><strong>{snapshot ? formatCompact(snapshot.volume) : "Unavailable"}</strong></div>
            <div><span>Market cap</span><strong>{snapshot?.marketCap ?? "Unavailable"}</strong></div>
            <div><span>Sector</span><strong>{selectedInstrument.sector ?? "Unavailable"}</strong></div>
          </div>

          <section className="chart-panel" aria-labelledby="price-chart-title">
            <div className="chart-toolbar">
              <div>
                <span className="eyebrow">PRICE</span>
                <h2 id="price-chart-title">Market movement</h2>
                <small className="chart-source-note">
                  {chartUsesProvider
                    ? `${chartResource?.data?.provider} · ${chartIsStale ? "last known history; refresh failed" : "corporate-action adjusted"} · ${formatFreshness(chartResource?.data?.asOf ?? undefined, now)}`
                    : !chartResource || chartResource.phase === "loading"
                      ? "Loading provider history…"
                      : chartUsesFixture
                        ? "Provider history unavailable · this symbol's illustrative fixture history is shown"
                        : `History unavailable for ${selectedInstrument.ticker} · no substitute series is shown`}
                </small>
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

            <div className="chart-wrap" aria-label={`${selectedInstrument.ticker} ${timeframe} price chart`}>
              {chartData.length > 0 ? (
                <Suspense
                  fallback={
                    <div className="chart-unavailable-state" role="status">
                      <Clock3 size={20} />
                      <strong>Rendering price history</strong>
                      <span>Preparing the interactive chart.</span>
                    </div>
                  }
                >
                  <MarketPriceChart color={chartColor} data={chartData} />
                </Suspense>
              ) : (
                <div className="chart-unavailable-state" role="status">
                  {chartUnavailable ? <WifiOff size={20} /> : <Clock3 size={20} />}
                  <strong>
                    {chartUnavailable ? "Historical data unavailable" : "Loading price history"}
                  </strong>
                  <span>
                    {chartUnavailable
                      ? `No substitute series is shown for ${selectedInstrument.ticker}.`
                      : `Checking the provider for ${selectedInstrument.ticker}.`}
                  </span>
                </div>
              )}
            </div>

            <table className="sr-only">
              <caption>
                {selectedInstrument.ticker} price observations · {chartUsesProvider ? chartIsStale ? "last known provider history; refresh failed" : "provider history" : chartUsesFixture ? "illustrative fixture" : "unavailable"}
              </caption>
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
              <button
                type="button"
                onClick={() => openIntelligenceInbox("inbox")}
              >
                View all events <ChevronRight size={15} />
              </button>
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
                          <button
                            type="button"
                            onClick={() => saveTimelineEvent(event.id)}
                          >
                            Save for thesis
                          </button>
                        </div>
                      </div>
                      <ChevronRight className="event-chevron" size={18} />
                    </article>
                  );
                })
              ) : (
                <div className="event-empty-state">
                  {intelligencePhase === "error" ? <WifiOff size={18} /> : <Globe2 size={18} />}
                  <div>
                    <strong>
                      {intelligencePhase === "loading"
                        ? "Checking for relevant evidence"
                        : intelligencePhase === "error"
                          ? "Intelligence temporarily unavailable"
                          : !selectedWorkspace && intelligenceResource.meta?.dataMode === "demo"
                            ? "Awaiting verified provider evidence"
                            : "No recent provider events"}
                    </strong>
                    <span>
                      {!selectedWorkspace
                        ? `No fixture events are substituted for ${selectedInstrument.ticker}.`
                        : "Omnigaze will keep checking this symbol."}
                    </span>
                  </div>
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
              <strong>
                {selectedWorkspace
                  ? "Illustrative foundation analysis"
                  : "Awaiting evidence-backed analysis"}
              </strong>
            </div>
            <button type="button" aria-label="About Omnigaze views"><CircleHelp size={16} /></button>
          </div>

          <div className="view-source-note">
            {selectedWorkspace ? <Sparkles size={13} /> : <Clock3 size={13} />}
            {selectedWorkspace
              ? "Demo fixture analysis · not generated from the current provider feed"
              : `No Omnigaze View yet for ${selectedInstrument.ticker} · no fixture analysis substituted`}
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
              Evidence ({selectedWorkspace?.evidence.length ?? 0})
            </button>
          </div>

          {!selectedWorkspace ? (
            <div className="view-unavailable-state" role="status">
              <span className="empty-icon"><Clock3 size={19} /></span>
              <strong>
                {insightTab === "view"
                  ? "Omnigaze View awaiting evidence"
                  : "No verified evidence collected yet"}
              </strong>
              <p>
                {insightTab === "view"
                  ? `A view for ${selectedInstrument.ticker} will appear after provider evidence is available for analysis.`
                  : `Omnigaze is still collecting attributable sources for ${selectedInstrument.ticker}.`}
              </p>
              <small>No analysis or evidence from another company is substituted.</small>
              {insightTab === "view" && (
                <button
                  type="button"
                  className="ask-button"
                  onClick={openLiveOmnigazeView}
                >
                  <Sparkles size={16} /> Generate live view for {selectedInstrument.ticker}
                </button>
              )}
            </div>
          ) : insightTab === "view" ? (
            <div className="view-content">
              <div className="stance-row">
                <div>
                  <span>Near-term stance</span>
                  <strong className={`stance ${selectedWorkspace.view.stance}`}>
                    {selectedWorkspace.view.stance}
                  </strong>
                </div>
                <div className="confidence-ring" style={{ "--confidence": `${selectedWorkspace.view.confidence * 100}%` } as React.CSSProperties}>
                  <span>{Math.round(selectedWorkspace.view.confidence * 100)}%</span>
                  <small>confidence</small>
                </div>
              </div>

              <div className="view-summary">
                <h2>{viewHeadline}</h2>
                <p>{selectedWorkspace.view.summary}</p>
              </div>

              <div className="why-now-card">
                <div><Clock3 size={15} /><span>Why now</span></div>
                <p>{selectedWorkspace.view.whyNow}</p>
              </div>

              <div className="driver-list">
                <div className="mini-heading"><span>Key drivers</span><small>2 signals</small></div>
                {selectedWorkspace.view.drivers.map((driver) => (
                  <div className="driver-row" key={driver.label}>
                    <span className={`driver-dot ${driver.direction}`} />
                    <div><strong>{driver.label}</strong><p>{driver.explanation}</p></div>
                  </div>
                ))}
              </div>

              <div className="unknowns">
                <div className="mini-heading"><span>What remains unknown</span></div>
                {selectedWorkspace.view.unknowns.map((unknown) => (
                  <p key={unknown}><span>?</span>{unknown}</p>
                ))}
              </div>

              <button
                type="button"
                className="ask-button"
                onClick={openLiveOmnigazeView}
              >
                <Sparkles size={16} /> Generate live view for {selectedInstrument.ticker}
              </button>
            </div>
          ) : (
            <div className="evidence-list">
              {selectedWorkspace.evidence.map((evidence) => (
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
          <div>
            <span className="eyebrow">
              {selectedWorkspace ? "OMNIGAZE VIEW · DEMO" : "OMNIGAZE VIEW · AWAITING EVIDENCE"}
            </span>
            <strong>{viewHeadline}</strong>
          </div>
          <button
            type="button"
            aria-label={`Generate a live Omnigaze View for ${selectedInstrument.ticker}`}
            onClick={openLiveOmnigazeView}
          >
            <ChevronRight size={18} />
          </button>
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

      {hasMarketSelection && (
        <OmnigazeViewDialog
          open={omnigazeViewOpen}
          onOpenChange={setOmnigazeViewOpen}
          instrument={selectedInstrument}
          session={session}
        />
      )}

      {hasMarketSelection && (
        <PortfolioWorkspaceDialog
          open={portfolioWorkspaceOpen}
          onOpenChange={setPortfolioWorkspaceOpen}
          initialView={portfolioWorkspaceInitialView}
          instrument={selectedInstrument}
          holding={selectedHolding}
          session={session}
          portfolioAvailability={portfolioAvailability}
          quoteState={
            (sourceState === "provider"
              ? "fresh"
              : sourceState === "stale"
                ? "stale"
                : sourceState === "fixture" || sourceState === "fallback"
                  ? "fixture"
                  : sourceState === "loading"
                    ? "loading"
                    : "unavailable") satisfies WorkspaceQuoteState
          }
          quoteLabel={`${sourceLabel} · ${freshness}`}
          onPortfolioAvailabilityChange={setPortfolioAvailability}
          onHoldingUpsert={upsertHolding}
          onHoldingRemoved={removeHolding}
          onPortfolioReloaded={reloadPortfolio}
        />
      )}

      <IntelligenceInboxDrawer
        open={intelligenceInboxOpen}
        onOpenChange={(open) => {
          setIntelligenceInboxOpen(open);
          if (!open) {
            setIntelligenceInboxFocusEventId(null);
            setIntelligenceInboxSaveRequest(null);
          }
        }}
        isAuthenticated={session.isAuthenticated}
        signInPath={session.isAuthenticated ? "/dashboard" : session.signInPath}
        instruments={watchlist.map((instrument) => ({
          id: instrument.id,
          ticker: instrument.ticker,
          name: instrument.name,
        }))}
        initialTab={intelligenceInboxInitialTab}
        focusEventId={intelligenceInboxFocusEventId}
        saveRequest={intelligenceInboxSaveRequest}
        onSaveRequestHandled={(request) => {
          setIntelligenceInboxSaveRequest((current) =>
            current?.nonce === request.nonce ? null : current,
          );
        }}
        onCountsChange={setIntelligenceInboxCounts}
      />

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
