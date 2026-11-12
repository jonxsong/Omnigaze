"use client";

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
import type { ProjectionReadiness } from "@/lib/services/projection-health";
import type { IntelligenceReadPlaneMeta } from "@/lib/services/intelligence-read-plane";
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
import { PortfolioPulseCard } from "@/components/portfolio-pulse-card";
import { PersonalTodayCard } from "@/components/personal-today-card";
import { MoveLensCard } from "@/components/move-lens-card";
import { moveLensCopy } from "@/components/move-lens-copy";
import {
  MarketContextTicker,
  type MarketContextResource,
} from "@/components/market-context-ticker";
import { useAppLocale } from "@/components/app-locale";
import { parseMarketContextEnvelope } from "@/lib/api/market-context-client";
import {
  formatMarketDashboardCopy,
  formatWatchlistSyncMessage,
  localizeDemoIntelligenceEvent,
  type DashboardCopyKey,
  type WatchlistSyncMessageCode,
} from "@/components/market-dashboard-copy";
import type { AppLocale } from "@/lib/app-locale";
import {
  calculatePortfolioPulse,
  MAX_PORTFOLIO_PULSE_POSITIONS,
  type PortfolioPulseSnapshotInput,
} from "@/lib/portfolio/portfolio-pulse";
import { buildPortfolioPulseSnapshotBatches } from "@/lib/portfolio/portfolio-pulse-refresh";
import {
  buildMoveLens,
  moveLensBenchmarkSnapshotsFromMarketContext,
  type MoveLensSnapshotInput,
} from "@/lib/move-lens";

const MarketPriceChart = lazy(() => import("@/components/market-price-chart"));

const timeframes = ["1D", "1W", "1M", "3M", "1Y"] as const;
type Timeframe = (typeof timeframes)[number];

const DASHBOARD_PREFERENCES_KEY = "omnigaze:dashboard-preferences";
const DASHBOARD_PREFERENCES_VERSION = 2;
const canonicalSymbolPattern = /^[A-Z0-9._-]+:[A-Z0-9._-]+$/;

type DashboardTranslator = (
  key: DashboardCopyKey,
  values?: Record<string, string | number>,
) => string;

type DashboardIntelligenceEvent = IntelligenceEvent & {
  isControversial?: boolean;
};

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
  meta?: OrchestrationMeta & { readPlane?: IntelligenceReadPlaneMeta };
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
    projection?: ProjectionReadiness;
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
  t: DashboardTranslator,
): DashboardIntelligenceEvent {
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
    summary: item.summary ?? t("noProviderSummary"),
    occurredAt: item.publishedAt,
    materiality: item.materiality,
    possibleDirection: "unclear",
    status: item.isLive ? "verified" : "preliminary",
    evidenceIds: [],
    category: item.category ?? category,
    ...(item.claimStatus ? { claimStatus: item.claimStatus } : {}),
    ...(item.causalLink ? { causalLink: item.causalLink } : {}),
    ...(item.topicTags ? { topicTags: [...item.topicTags] } : {}),
    ...(item.isControversial !== undefined
      ? { isControversial: item.isControversial }
      : {}),
  };
}

function localeTag(locale: AppLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

function formatFreshness(
  value: string | undefined,
  now: number,
  locale: AppLocale,
  t: DashboardTranslator,
) {
  if (!value) return t("freshnessUnavailable");
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return t("freshnessUnavailable");
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 15) return t("updatedJustNow");
  if (seconds < 60) return t("updatedSeconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("updatedMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("updatedHours", { count: hours });
  return t("timestamped", { date: new Intl.DateTimeFormat(localeTag(locale), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp)) });
}

function formatTimestampAge(
  value: string | null | undefined,
  now: number,
  locale: AppLocale,
  t: DashboardTranslator,
) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1_000));
  if (seconds < 15) return t("justNow");
  if (seconds < 60) return t("secondsAgo", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("minutesAgo", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("hoursAgo", { count: hours });
  return t("onDate", { date: new Intl.DateTimeFormat(localeTag(locale), {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(timestamp)) });
}

function formatEvidenceTiming(
  observedAt: string | null | undefined,
  responseReceivedAt: string | undefined,
  now: number,
  locale: AppLocale,
  t: DashboardTranslator,
) {
  const observationAge = formatTimestampAge(observedAt, now, locale, t);
  if (observationAge) return t("evidenceObserved", { age: observationAge });

  const receiptAge = formatTimestampAge(responseReceivedAt, now, locale, t);
  return receiptAge
    ? t("evidenceReceipt", { age: receiptAge })
    : t("evidenceTimeUnavailable");
}

function formatHealthTiming(
  checkedAt: string | null | undefined,
  responseReceivedAt: string | undefined,
  now: number,
  locale: AppLocale,
  t: DashboardTranslator,
) {
  const checkAge = formatTimestampAge(checkedAt, now, locale, t);
  if (checkAge) return t("healthChecked", { age: checkAge });

  const receiptAge = formatTimestampAge(responseReceivedAt, now, locale, t);
  return receiptAge
    ? t("healthReceipt", { age: receiptAge })
    : t("healthTimeUnavailable");
}

function formatProviderTiming(
  provider: ProviderReport,
  now: number,
  locale: AppLocale,
  t: DashboardTranslator,
) {
  const observationAge = formatTimestampAge(provider.latestObservedAt, now, locale, t);
  const checkAge = formatTimestampAge(provider.checkedAt, now, locale, t);
  const observationLabel = observationAge
    ? t("evidenceObserved", { age: observationAge })
    : t("evidenceTimeUnavailable");
  const checkLabel = checkAge
    ? t("healthChecked", { age: checkAge })
    : t("healthTimeUnavailable");
  return t("providerTiming", { observation: observationLabel, health: checkLabel });
}

function formatIngestionMode(mode: IngestionReadiness["mode"], t: DashboardTranslator) {
  if (mode === "scheduled") return t("ingestionScheduled");
  if (mode === "request_time") return t("ingestionRequestTime");
  return t("ingestionUnavailable");
}

function formatProjectionMode(
  mode: ProjectionReadiness["mode"],
  t: DashboardTranslator,
) {
  if (mode === "scheduled") return t("ingestionScheduled");
  if (mode === "request_time") return t("projectionOperatorTriggered");
  return t("ingestionUnavailable");
}

function formatIngestionStatus(status: IngestionReadiness["status"], t: DashboardTranslator) {
  if (status === "catching_up") return t("statusCatchingUp");
  if (status === "idle") return t("statusIdle");
  if (status === "healthy") return t("statusHealthy");
  if (status === "delayed") return t("statusDelayed");
  if (status === "degraded") return t("statusDegraded");
  return t("ingestionUnavailable");
}

function ingestionStatusDescription(status: IngestionReadiness["status"], t: DashboardTranslator) {
  if (status === "healthy") return t("collectionHealthy");
  if (status === "catching_up") {
    return t("collectionCatchingUp");
  }
  if (status === "delayed") {
    return t("collectionDelayed");
  }
  if (status === "degraded") {
    return t("collectionDegraded");
  }
  if (status === "idle") return t("collectionIdle");
  return t("collectionUnreadable");
}

function projectionStatusDescription(
  status: ProjectionReadiness["status"],
  t: DashboardTranslator,
) {
  if (status === "healthy") return t("projectionHealthy");
  if (status === "catching_up") return t("projectionCatchingUp");
  if (status === "delayed") return t("projectionDelayed");
  if (status === "degraded") return t("projectionDegraded");
  if (status === "idle") return t("projectionIdle");
  return t("projectionUnreadable");
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
  t: DashboardTranslator,
) {
  if (mode === "request_time") return t("noBackgroundCadence");
  if (mode === "unavailable") return t("unavailable");
  if (!Number.isFinite(seconds) || seconds === null || seconds <= 0) {
    return t("notReported");
  }

  if (seconds % 3_600 === 0) {
    const hours = seconds / 3_600;
    return t("everyHours", { count: hours, unit: t(hours === 1 ? "hour" : "hours") });
  }
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return t("everyMinutes", { count: minutes, unit: t(minutes === 1 ? "minute" : "minutes") });
  }
  return t("everySeconds", { count: seconds, unit: t(seconds === 1 ? "second" : "seconds") });
}

function formatOperationalTimestamp(
  value: string | null | undefined,
  now: number,
  unavailableLabel: string,
  locale: AppLocale,
  t: DashboardTranslator,
) {
  const age = formatTimestampAge(value, now, locale, t);
  return age ?? unavailableLabel;
}

function sessionLabel(session: MarketSnapshot["session"], t: DashboardTranslator) {
  if (session === "regular") return t("sessionRegular");
  if (session === "pre-market") return t("sessionPreMarket");
  if (session === "after-hours") return t("sessionAfterHours");
  return t("sessionClosed");
}

function formatPrice(value: number, locale: AppLocale) {
  return new Intl.NumberFormat(localeTag(locale), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  }).format(value);
}

function formatCompact(value: number, locale: AppLocale) {
  return new Intl.NumberFormat(localeTag(locale), {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatTime(value: string, locale: AppLocale) {
  return new Intl.DateTimeFormat(localeTag(locale), {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatChartLabel(value: string, timeframe: Timeframe, locale: AppLocale) {
  const date = new Date(value);
  if (timeframe === "1D") {
    return new Intl.DateTimeFormat(localeTag(locale), {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }
  if (timeframe === "1W" || timeframe === "1M") {
    return new Intl.DateTimeFormat(localeTag(locale), {
      month: "short",
      day: "numeric",
      hour: timeframe === "1W" ? "numeric" : undefined,
    }).format(date);
  }
  return new Intl.DateTimeFormat(localeTag(locale), {
    month: "short",
    day: "numeric",
  }).format(date);
}

function movementClass(value: number) {
  return value >= 0 ? "market-positive" : "market-negative";
}

function evidenceLabel(classification: EvidenceClassification, t: DashboardTranslator) {
  if (classification === "derived") return t("evidenceDerived");
  if (classification === "inference") return t("evidenceInference");
  return t("evidenceFact");
}

function materialityLabel(materiality: Materiality, t: DashboardTranslator) {
  if (materiality === "critical") return t("materialityCritical");
  if (materiality === "high") return t("materialityHigh");
  if (materiality === "medium") return t("materialityMedium");
  return t("materialityLow");
}

function providerStatusLabel(
  status: ProviderReport["status"],
  t: DashboardTranslator,
) {
  if (status === "healthy") return t("statusHealthy");
  if (status === "degraded") return t("statusDegraded");
  return t("statusUnconfigured");
}

function applicationStatusLabel(value: string | undefined, t: DashboardTranslator) {
  if (value === "ok") return t("statusOk");
  if (value === "degraded") return t("statusDegraded");
  return value ?? t("responding");
}

function marketCoverageLabel(
  value: MarketSnapshot["marketCoverage"],
  t: DashboardTranslator,
) {
  if (value === "limited-exchange") return t("coverageLimited");
  if (value === "consolidated") return t("coverageConsolidated");
  return t("coverageFixture");
}

function stanceLabel(
  value: "bullish" | "bearish" | "mixed" | "neutral",
  t: DashboardTranslator,
) {
  if (value === "bullish") return t("stanceBullish");
  if (value === "bearish") return t("stanceBearish");
  if (value === "mixed") return t("stanceMixed");
  return t("stanceNeutral");
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
  const { hydrated, locale, setLocale } = useAppLocale();
  const moveCopy = moveLensCopy[locale];
  const t = useCallback<DashboardTranslator>(
    (key, values) => formatMarketDashboardCopy(locale, key, values),
    [locale],
  );
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
  const [todayWatchlistGeneration, setTodayWatchlistGeneration] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [snapshotResources, setSnapshotResources] = useState<
    Partial<Record<CanonicalSymbol, SnapshotResource>>
  >({});
  const [intelligenceResource, setIntelligenceResource] =
    useState<IntelligenceResource>({ data: [], phase: "loading" });
  const [healthResource, setHealthResource] = useState<HealthResource>({
    phase: "loading",
  });
  const [marketContextResource, setMarketContextResource] =
    useState<MarketContextResource>({ phase: "loading" });
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
  const [watchlistSyncMessageCode, setWatchlistSyncMessageCode] =
    useState<WatchlistSyncMessageCode | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const marketSymbolHeadingRef = useRef<HTMLHeadingElement>(null);
  const preferencesTouchedRef = useRef(false);
  const intelligenceInboxSaveNonceRef = useRef(0);
  const accountPersistenceEnabled =
    session.isAuthenticated && Boolean(accountWatchlist) && !accountSyncUnavailable;
  const watchlistName = accountWatchlist?.name ?? t("coreHoldings");
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
  const portfolioPulseState = useMemo(() => {
    const boundedHoldings = [...holdings]
      .sort((left, right) =>
        left.symbolId < right.symbolId
          ? -1
          : left.symbolId > right.symbolId
            ? 1
            : 0,
      )
      .slice(0, MAX_PORTFOLIO_PULSE_POSITIONS);
    const snapshots = new Map<CanonicalSymbol, PortfolioPulseSnapshotInput>();
    let loading = false;

    for (const holding of boundedHoldings) {
      const resource = snapshotResources[holding.symbolId];
      if (!resource || resource.phase === "loading") loading = true;
      if (!resource?.data || !resource.meta) continue;
      const quoteTimestamp = Date.parse(resource.data.asOf);
      const actualAgeSeconds = Number.isFinite(quoteTimestamp)
        ? Math.max(0, Math.round((now - quoteTimestamp) / 1_000))
        : resource.meta.freshness.ageSeconds;
      snapshots.set(holding.symbolId, {
        data: resource.data,
        meta: {
          ...resource.meta,
          freshness: {
            ...resource.meta.freshness,
            asOf: resource.data.asOf,
            ageSeconds: actualAgeSeconds,
            state:
              resource.phase === "error" &&
              resource.meta.freshness.state === "fresh"
                ? "stale"
                : resource.meta.freshness.state,
          },
        },
      });
    }

    try {
      return {
        data: calculatePortfolioPulse({
          holdings: boundedHoldings,
          snapshots,
          calculatedAt: new Date(now).toISOString(),
          sourcePositionCount: holdings.length,
        }),
        loading,
      };
    } catch {
      return { data: null, loading: false };
    }
  }, [holdings, now, snapshotResources]);
  const hasMarketSelection = visibleInstruments.some(
    ({ id }) => id === selectedSymbol,
  );

  useEffect(() => {
    if (!hydrated) return;
    document.title = t("documentTitle");
  }, [hydrated, t]);

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
    const controller = new AbortController();
    let stopped = false;
    let timedOut = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 10_000);

    void fetch("/api/market/context", {
      cache: "no-store",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) throw new Error("market_context_unavailable");
        return parseMarketContextEnvelope(await response.json());
      })
      .then((data) => {
        if (!stopped) setMarketContextResource({ data, phase: "ready" });
      })
      .catch(() => {
        if (stopped || (controller.signal.aborted && !timedOut)) return;
        setMarketContextResource((current) => ({
          ...current,
          phase: "error",
        }));
      })
      .finally(() => window.clearTimeout(timeout));

    return () => {
      stopped = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [refreshGeneration]);

  useEffect(() => {
    if (visibleInstruments.length === 0 && holdings.length === 0) return;
    let stopped = false;
    let timer: number | undefined;
    let activeController: AbortController | undefined;
    const batches = buildPortfolioPulseSnapshotBatches({
      holdingSymbols: holdings.map(({ symbolId }) => symbolId),
      selectedSymbol,
      visibleSymbols: visibleInstruments.map(({ id }) => id),
    });

    async function poll() {
      if (document.visibilityState === "hidden") {
        timer = window.setTimeout(poll, SNAPSHOT_POLL_MS);
        return;
      }

      activeController = new AbortController();
      const timeout = window.setTimeout(() => activeController?.abort(), 10_000);
      try {
        const results = await Promise.allSettled(
          batches.map((batch) =>
            fetchApi<SnapshotBatchResponse>(
              `/api/market/snapshots?symbols=${encodeURIComponent(batch.join(","))}`,
              activeController!.signal,
            ),
          ),
        );
        if (stopped) return;

        const receivedAt = new Date().toISOString();
        setSnapshotResources((current) => {
          const next = { ...current };
          for (let index = 0; index < batches.length; index += 1) {
            const batch = batches[index] ?? [];
            const result = results[index];
            if (!result || result.status === "rejected") {
              const message =
                result?.status === "rejected" && result.reason instanceof Error
                  ? result.reason.message
                  : "Snapshot request failed.";
              for (const symbol of batch) {
                next[symbol] = {
                  ...next[symbol],
                  phase: "error",
                  error: message,
                };
              }
              continue;
            }

            const itemsBySymbol = new Map(
              result.value.data.map((item) => [item.symbolId, item]),
            );
            for (const symbol of batch) {
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
          }
          return next;
        });
      } catch (error) {
        if (stopped) return;
        setSnapshotResources((current) => {
          const next = { ...current };
          for (const symbol of batches.flat()) {
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
  }, [holdings, refreshGeneration, selectedSymbol, visibleInstruments]);

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
      ? feedItems.map((item) => {
          const event = normalizeFeedItem(item, selectedSymbol, t);
          return intelligenceResource.meta?.dataMode === "demo"
            ? localizeDemoIntelligenceEvent(locale, event)
            : event;
        })
      : selectedWorkspace?.events.map((event) =>
          localizeDemoIntelligenceEvent(locale, event),
        ) ?? [];
  const feedItemById = new Map(feedItems.map((item) => [item.id, item]));
  const intelligenceReadPlane = intelligenceMatchesSelection
    ? intelligenceResource.meta?.readPlane
    : undefined;
  const intelligenceReadPlaneNotice = intelligenceReadPlane?.requestTimeFailed
    ? intelligenceReadPlane.origins.durable.selectedCount > 0
      ? {
          tone: "retained",
          title: t("retainedEvidenceTitle"),
          detail: t("retainedEvidenceDetail"),
        }
      : {
          tone: "unavailable",
          title: t("currentEvidenceUnavailableTitle"),
          detail: t("currentEvidenceUnavailableDetail"),
        }
    : intelligenceReadPlane?.collectedReadFailed
      ? {
          tone: "live-only",
          title: t("liveOnlyEvidenceTitle"),
          detail: t("liveOnlyEvidenceDetail"),
        }
      : intelligenceReadPlane?.collectedTruncated
        ? {
            tone: "limited",
            title: t("retainedHistoryLimitedTitle"),
            detail: t("retainedHistoryLimitedDetail"),
          }
        : null;
  const viewHeadline =
    selectedWorkspace?.events[0]?.headline ??
    t("awaitingHeadline", { ticker: selectedInstrument.ticker });
  const displayedViewHeadline =
    locale === "zh-CN" && selectedWorkspace
      ? t("fixtureViewTitle")
      : viewHeadline;
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
      ? t("sourceNoSelection")
      : sourceState === "provider"
      ? snapshot?.provider ?? t("sourceProviderQuote")
      : sourceState === "stale"
        ? t("lastKnownQuote")
      : sourceState === "fallback"
        ? t("sourceFallback")
        : sourceState === "unavailable"
          ? t("quoteUnavailable")
        : sourceState === "loading"
          ? t("sourceLoading")
          : t("sourceDemo");
  const freshness = formatFreshness(
    selectedSnapshotResource?.meta?.freshness.asOf ?? snapshot?.asOf,
    now,
    locale,
    t,
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
  const projectionReadiness = healthResource.data?.readiness?.projection;
  const projectionUnavailable =
    projectionReadiness?.mode === "unavailable" ||
    projectionReadiness?.status === "unavailable";
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
      ? t("modeNoSelection")
      : sourceState === "provider"
      ? t("modeProvider")
      : sourceState === "stale"
        ? t("modeStale")
      : sourceState === "unavailable"
        ? t("modeUnavailable")
      : sourceState === "loading"
        ? t("modeChecking")
        : t("modeDemo");
  const moveLensResult = useMemo(() => {
    const evaluatedAt = new Date(now).toISOString();
    const selectedMoveLensSnapshot: MoveLensSnapshotInput | undefined =
      selectedSnapshotResource?.meta
        ? {
            data: selectedSnapshotResource.data ?? null,
            meta: {
              dataMode: selectedSnapshotResource.meta.dataMode,
              mode: selectedSnapshotResource.meta.mode,
              providerCoverage:
                selectedSnapshotResource.meta.providerCoverage,
              coverage: selectedSnapshotResource.meta.coverage,
              freshness: {
                ...selectedSnapshotResource.meta.freshness,
                state:
                  selectedSnapshotResource.phase === "error"
                    ? "stale"
                    : selectedSnapshotResource.meta.freshness.state,
              },
            },
          }
        : undefined;
    const benchmarkSnapshots = marketContextResource.data
      ? moveLensBenchmarkSnapshotsFromMarketContext(
          marketContextResource.data,
          evaluatedAt,
        )
      : new Map<CanonicalSymbol, MoveLensSnapshotInput>();

    try {
      return buildMoveLens({
        selectedSymbolId: selectedSymbol,
        selectedSnapshot: selectedMoveLensSnapshot,
        benchmarkSnapshots,
        evidence:
          intelligenceMatchesSelection && intelligenceResource.phase === "ready"
            ? intelligenceResource.data
            : [],
        evidenceReadStatus:
          intelligenceMatchesSelection && intelligenceResource.phase === "ready"
            ? "verified"
            : "unavailable",
        evaluatedAt,
      });
    } catch {
      return null;
    }
  }, [
    intelligenceMatchesSelection,
    intelligenceResource.data,
    intelligenceResource.phase,
    marketContextResource.data,
    now,
    selectedSnapshotResource,
    selectedSymbol,
  ]);

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
      label: formatChartLabel(bar.timestamp, timeframe, locale),
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
  const displayedDemoDrivers =
    locale === "zh-CN"
      ? [
          {
            label: t("fixtureDriverOneLabel"),
            explanation: t("fixtureDriverOneBody"),
            direction: "positive" as const,
          },
          {
            label: t("fixtureDriverTwoLabel"),
            explanation: t("fixtureDriverTwoBody"),
            direction: "mixed" as const,
          },
        ]
      : selectedWorkspace?.view.drivers ?? [];
  const displayedDemoUnknowns =
    locale === "zh-CN"
      ? [t("fixtureUnknownOne"), t("fixtureUnknownTwo")]
      : selectedWorkspace?.view.unknowns ?? [];

  async function persistWatchlistMutation(
    operation: "add" | "remove",
    symbol: CanonicalSymbol,
    rollback: () => void,
  ) {
    if (!accountPersistenceEnabled || !accountWatchlist) return;

    setWatchlistSyncPhase("saving");
    setWatchlistSyncMessageCode(null);
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
      setTodayWatchlistGeneration((current) => current + 1);
    } catch {
      rollback();
      setWatchlistSyncPhase("error");
      setWatchlistSyncMessageCode("save_failed");
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

  function selectPulsePosition(symbol: CanonicalSymbol) {
    selectStock(symbol);
    window.requestAnimationFrame(() => {
      const heading = marketSymbolHeadingRef.current;
      heading?.focus({ preventScroll: true });
      document
        .getElementById("market-symbol-detail")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function openStockSearch() {
    setShowSearch(true);
    window.requestAnimationFrame(() => searchInputRef.current?.focus());
  }

  function addStock(instrument: DashboardInstrument) {
    if (watchlistSyncPhase === "saving") return;
    if (session.isAuthenticated && !accountPersistenceEnabled) {
      setWatchlistSyncMessageCode("account_unavailable");
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
      setWatchlistSyncMessageCode("account_unavailable");
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
    <main
      className="omnigaze-shell"
      data-hydrated={hydrated ? "true" : "false"}
      data-locale={locale}
      lang={locale}
    >
      <header className="topbar">
        <Link className="brand-lockup" href="/" aria-label={t("home")}>
          <BrandMark />
          <div>
            <span className="brand-name">OMNIGAZE</span>
            <span className="brand-beta">{t("alpha")}</span>
          </div>
        </Link>

        <button
          className="mobile-menu-button"
          type="button"
          aria-label={t("openWatchlist")}
          onClick={() => setShowMobileWatchlist(true)}
        >
          <Menu size={19} />
        </button>

        <div className="global-search-wrap">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchInputRef}
            data-testid="stock-search-input"
            aria-label={t("searchStocks")}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShowSearch(true);
            }}
            onFocus={() => setShowSearch(true)}
            placeholder={t("searchPlaceholder")}
          />
          <kbd>⌘ K</kbd>

          {showSearch && (
            <div className="search-results" role="listbox" aria-label={t("searchResults")}>
              <div className="search-results-header">
                <span>
                  {normalizedSearchQuery
                    ? catalogSearch.meta?.freshness.state === "stale" && catalogMatchesQuery
                      ? t("cachedCatalog")
                      : t("activeEquities")
                    : t("starterSymbols")}
                </span>
                <button
                  type="button"
                  aria-label={t("closeSearch")}
                  onClick={() => setShowSearch(false)}
                >
                  <X size={15} />
                </button>
              </div>
              {normalizedSearchQuery && activeSearchPhase === "loading" ? (
                <div className="search-empty-state" role="status" aria-live="polite">
                  <RefreshCw className="sync-spinner" size={17} />
                  <div>
                    <strong>{t("searchingCatalog")}</strong>
                    <span>{t("checkingNames")}</span>
                  </div>
                </div>
              ) : normalizedSearchQuery && activeSearchPhase === "error" ? (
                <div className="search-empty-state search-error-state" role="status" aria-live="polite">
                  <WifiOff size={17} />
                  <div>
                    <strong>{t("searchUnavailable")}</strong>
                    <span>{t("noCatalogSubstitute")}</span>
                    <button
                      type="button"
                      onClick={() => setSearchGeneration((current) => current + 1)}
                    >
                      {t("retrySearch")}
                    </button>
                  </div>
                </div>
              ) : searchResults.length > 0 ? (
                <>
                  {normalizedSearchQuery && catalogSearch.meta?.freshness.state === "stale" && (
                    <div className="search-catalog-notice" role="status">
                      <Clock3 size={13} /> {t("catalogDelayed", { freshness: formatFreshness(catalogSearch.meta.catalogAsOf, now, locale, t) })}
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
                              ? t("demo")
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
                  <div><strong>{t("noMatchingStocks")}</strong><span>{t("tryAnotherStock")}</span></div>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="topbar-actions">
          <div className="dashboard-locale-toggle" role="group" aria-label={t("localeGroup")}>
            <button
              type="button"
              aria-pressed={locale === "en"}
              onClick={() => setLocale("en")}
            >
              {t("english")}
            </button>
            <button
              type="button"
              aria-pressed={locale === "zh-CN"}
              onClick={() => setLocale("zh-CN")}
            >
              {t("chinese")}
            </button>
          </div>
          <div className="market-status">
            <span className={`status-dot ${sourceState}`} />
            <span>
              {sourceState === "empty"
                ? t("noSymbolsSelected")
                : sourceState === "provider" && snapshot
                ? sessionLabel(snapshot.session, t)
                : sourceState === "stale"
                  ? t("lastKnownQuote")
                : sourceState === "unavailable"
                  ? t("quoteUnavailable")
                  : sourceState === "loading" && !selectedWorkspace
                    ? t("loadingMarketContext")
                    : t("demoMarketContext")}
            </span>
            <small>
              {sourceState === "empty"
                ? t("addAStockShort")
                : sourceState === "provider" || sourceState === "stale"
                ? freshness
                : t("notLive")}
            </small>
          </div>
          <button
            type="button"
            className="top-add-stock"
            data-testid="top-add-stock"
            onClick={openStockSearch}
          >
            <Plus size={15} /><span>{t("addStock")}</span>
          </button>
          <button
            type="button"
            className="icon-button inbox-bell"
            aria-label={
              intelligenceInboxCounts.unread > 0
                ? t("openInboxUnread", { count: intelligenceInboxCounts.unread })
                : t("openInbox")
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
              aria-label={t("signOut", { name: session.displayName })}
              title={t("syncedAccount", { name: session.displayName })}
            >
              {session.initials}
            </a>
          ) : (
            <a
              className="topbar-sign-in"
              href={session.signInPath}
              target="_top"
            >
              <LogIn size={14} /> {t("signInToSync")}
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
            ? t("addStockMonitoring")
            : sourceState === "provider"
            ? `${snapshot?.provider} · ${snapshot?.isDelayed ? t("delayedMinutesShort", { minutes: Math.max(1, Math.ceil(snapshot.delaySeconds / 60)) }) : t("providerReportedQuote")} · ${freshness}`
            : sourceState === "stale"
              ? `${snapshot?.provider ?? t("provider")} · ${t("lastKnownQuoteShort")} · ${selectedSnapshotResource?.phase === "error" ? t("refreshFailed") : t("providerStaleUnknown")} · ${freshness}`
            : sourceState === "fallback"
              ? t("fallbackBanner")
              : sourceState === "unavailable"
                ? t("noCrossCompanyQuote", { ticker: selectedInstrument.ticker })
              : sourceState === "loading"
                ? selectedWorkspace
                  ? t("checkingFixture")
                  : t("loadingProviderQuote", { ticker: selectedInstrument.ticker })
                : t("demoFixtureBanner")}
        </span>
        <button
          type="button"
          aria-expanded={showDataStatus}
          aria-controls="data-status-panel"
          onClick={() => setShowDataStatus((current) => !current)}
        >
          {showDataStatus ? t("hideDataStatus") : t("viewDataStatus")}
        </button>
      </div>

      {showDataStatus && (
        <section id="data-status-panel" className="data-status-panel" aria-labelledby="data-status-title">
          <div className="data-status-heading">
            <div>
              <span className="eyebrow">{t("dataTransparency")}</span>
              <h2 id="data-status-title">{t("sourceProviderStatus")}</h2>
            </div>
            <button
              type="button"
              className="refresh-data-button"
              aria-label={t("refreshDisplayedData")}
              onClick={() => setRefreshGeneration((current) => current + 1)}
            >
              <RefreshCw size={14} /> {t("refreshView")}
            </button>
          </div>

          <dl className="data-status-grid">
            <div>
              <dt>{t("displayedQuote")}</dt>
              <dd><span className={`health-dot ${sourceState}`} />{sourceLabel}</dd>
              <small>
                {sourceState === "empty"
                  ? t("noQuoteUntilSelected")
                  : sourceState === "provider"
                  ? t("coverage", { freshness, coverage: snapshot ? marketCoverageLabel(snapshot.marketCoverage, t) : t("unavailable") })
                  : sourceState === "stale"
                    ? t("staleQuoteContext", { freshness })
                  : sourceState === "unavailable"
                    ? t("noQuoteDisplayed", { ticker: selectedInstrument.ticker })
                    : t("fixtureNeverLive")}
              </small>
            </div>
            <div>
              <dt>{t("applicationApi")}</dt>
              <dd>
                <span className={`health-dot ${applicationHealthDot}`} />
                {healthResource.phase === "ready"
                  ? `${healthResource.data?.service ?? t("omnigazeWeb")} · ${applicationStatusLabel(healthResource.data?.status, t)}`
                  : healthResource.phase === "loading"
                    ? t("checking")
                    : t("unreachable")}
              </dd>
              <small>
                {healthResource.phase === "error"
                  ? t("unreachable")
                  : formatHealthTiming(
                    healthResource.data?.checkedAt,
                    healthResource.receivedAt,
                    now,
                    locale,
                    t,
                  )}
              </small>
            </div>
            <div>
              <dt>{t("intelligenceFeed")}</dt>
              <dd>
                <span className={`health-dot ${intelligencePhase}`} />
                {intelligencePhase === "ready"
                  ? intelligenceResource.meta?.dataMode === "demo"
                    ? selectedWorkspace
                      ? t("demoIntelligenceAdapter")
                      : t("awaitingProviderEvidence")
                    : t("apiConnected")
                  : intelligencePhase === "loading"
                    ? t("checking")
                    : selectedWorkspace
                      ? t("bundledFallback")
                      : t("unavailable")}
              </dd>
              <small>
                {intelligenceMatchesSelection && intelligenceResource.phase === "error"
                  ? t("intelligenceUnavailable")
                  : intelligenceMatchesSelection &&
                  intelligenceResource.meta?.freshness.state === "fixture"
                    ? t("fixtureTimestamps")
                    : formatEvidenceTiming(
                        intelligenceMatchesSelection
                          ? intelligenceResource.meta?.freshness.asOf
                          : undefined,
                        intelligenceMatchesSelection
                          ? intelligenceResource.receivedAt
                          : undefined,
                        now,
                        locale,
                        t,
                      )}
              </small>
            </div>
            <div data-testid="ingestion-status">
              <dt>{t("evidenceCollection")}</dt>
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
                  ? t("checking")
                  : ingestionReadiness
                    ? ingestionUnavailable
                      ? t("statusUnavailable")
                      : `${formatIngestionMode(ingestionReadiness.mode, t)} · ${formatIngestionStatus(ingestionReadiness.status, t)}`
                    : t("statusUnavailable")}
              </dd>
              {ingestionReadiness ? (
                <small className="collection-status-details">
                  <span>
                    {ingestionUnavailable
                      ? t("collectionUnreadable")
                      : ingestionStatusDescription(ingestionReadiness.status, t)}
                  </span>
                  <span>
                    <strong>{t("lastSuccess")}</strong>{" "}
                    {formatOperationalTimestamp(
                      ingestionReadiness.lastSuccessAt,
                      now,
                      ingestionUnavailable
                        ? t("unavailable")
                        : t("noSuccessfulCollection"),
                      locale,
                      t,
                    )}
                  </span>
                  <span>
                    <strong>{t("latestEvidence")}</strong>{" "}
                    {formatOperationalTimestamp(
                      ingestionReadiness.latestEvidenceAt,
                      now,
                      ingestionUnavailable
                        ? t("unavailable")
                        : t("noCollectedEvidence"),
                      locale,
                      t,
                    )}
                  </span>
                  <span>
                    <strong>{t("expectedCadence")}</strong>{" "}
                    {formatCadence(
                      ingestionReadiness.expectedCadenceSeconds,
                      ingestionReadiness.mode,
                      t,
                    )}
                  </span>
                  <span>
                    <strong>{t("statusCalculated")}</strong>{" "}
                    {formatOperationalTimestamp(
                      ingestionReadiness.generatedAt,
                      now,
                      t("timestampUnavailable"),
                      locale,
                      t,
                    )}
                  </span>
                </small>
              ) : (
                <small>
                  {healthResource.phase === "loading"
                    ? t("waitingCollection")
                    : t("noCollectionStatus")}
                </small>
              )}
            </div>
            <div data-testid="projection-status">
              <dt>{t("alertDelivery")}</dt>
              <dd>
                <span
                  aria-hidden="true"
                  className={`health-dot ${
                    projectionReadiness
                      ? ingestionStatusDot(projectionReadiness.status)
                      : healthResource.phase === "loading"
                        ? "loading"
                        : "unavailable"
                  }`}
                />
                {healthResource.phase === "loading"
                  ? t("checking")
                  : projectionReadiness
                    ? projectionUnavailable
                      ? t("statusUnavailable")
                      : `${formatProjectionMode(projectionReadiness.mode, t)} · ${formatIngestionStatus(projectionReadiness.status, t)}`
                    : t("statusUnavailable")}
              </dd>
              {projectionReadiness ? (
                <small className="collection-status-details">
                  <span>
                    {projectionUnavailable
                      ? t("projectionUnreadable")
                      : projectionStatusDescription(projectionReadiness.status, t)}
                  </span>
                  <span>
                    <strong>{t("projectionQueue")}</strong>{" "}
                    {projectionUnavailable
                      ? t("unavailable")
                      : projectionReadiness.hasPendingWork
                        ? t("projectionPending")
                        : t("projectionCaughtUp")}
                  </span>
                  <span>
                    <strong>{t("lastProjectionAttempt")}</strong>{" "}
                    {formatOperationalTimestamp(
                      projectionReadiness.lastAttemptAt,
                      now,
                      projectionUnavailable
                        ? t("unavailable")
                        : t("noProjectionAttempt"),
                      locale,
                      t,
                    )}
                  </span>
                  <span>
                    <strong>{t("lastProjectionCompleted")}</strong>{" "}
                    {formatOperationalTimestamp(
                      projectionReadiness.lastCompletedAt,
                      now,
                      projectionUnavailable
                        ? t("unavailable")
                        : t("noProjectionCompletion"),
                      locale,
                      t,
                    )}
                  </span>
                  <span>
                    <strong>{t("expectedCadence")}</strong>{" "}
                    {formatCadence(
                      projectionReadiness.expectedCadenceSeconds,
                      projectionReadiness.mode,
                      t,
                    )}
                  </span>
                </small>
              ) : (
                <small>
                  {healthResource.phase === "loading"
                    ? t("waitingProjection")
                    : t("noProjectionStatus")}
                </small>
              )}
            </div>
            <div>
              <dt>{t("refreshPolicy")}</dt>
              <dd><span className="health-dot policy" />{t("requestTimeWhileOpen")}</dd>
              <small>{t("refreshPolicyDetail")}</small>
            </div>
          </dl>

          <div className="provider-health-list" aria-label={t("configuredProviders")}>
            {healthProviders.length > 0 ? (
              healthProviders.map((provider) => (
                <div key={provider.provider}>
                  <span className={`health-dot ${provider.status}`} />
                  <strong>{provider.provider}</strong>
                  <span>{providerStatusLabel(provider.status, t)}</span>
                  <small>
                    {provider.message
                      ? `${locale === "zh-CN" ? provider.status === "unconfigured" ? t("providerUnconfiguredDetail") : t("providerDegradedDetail") : provider.message} · `
                      : ""}
                    {formatProviderTiming(provider, now, locale, t)}
                  </small>
                </div>
              ))
            ) : (
              <p>
                <TriangleAlert size={14} /> {t("providerHealthUnavailable")}
              </p>
            )}
          </div>
        </section>
      )}

      <div className={`dashboard-grid ${watchlist.length === 0 ? "empty" : ""}`}>
        <aside className={`watchlist-panel ${showMobileWatchlist ? "mobile-open" : ""}`}>
          <div className="mobile-panel-header">
            <strong>{t("watchlist")}</strong>
            <button
              type="button"
              aria-label={t("closeWatchlist")}
              onClick={() => setShowMobileWatchlist(false)}
            >
              <X size={18} />
            </button>
          </div>

          <div className="panel-heading">
            <div>
              <span className="eyebrow">{t("myWatchlist")}</span>
              <div className="watchlist-title">{watchlistName}</div>
            </div>
            <button
              type="button"
              className="subtle-icon-button"
              aria-label={t("addStockAria")}
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
                ? t("savedOnDevice")
                : watchlistSyncPhase === "saving"
                  ? t("savingAccount")
                  : watchlistSyncPhase === "synced"
                    ? t("syncedDevices")
                    : watchlistSyncPhase === "error"
                       ? watchlistSyncMessageCode
                         ? formatWatchlistSyncMessage(locale, watchlistSyncMessageCode)
                         : t("syncFailedRollback")
                       : watchlistSyncMessageCode
                         ? formatWatchlistSyncMessage(locale, watchlistSyncMessageCode)
                         :
                        t("syncUnavailable")}
            </span>
            {!session.isAuthenticated && (
              <a href={session.signInPath} target="_top">{t("syncAcrossDevices")}</a>
            )}
          </div>

          <div className="watchlist-columns" aria-hidden="true">
            <span>{t("symbol")}</span>
            <span>{t("last")}</span>
            <span>{t("change")}</span>
          </div>

          <div className="watchlist-rows">
            {watchedStocks.length === 0 && (
              <div className="watchlist-empty-state">
                <span className="empty-icon"><Search size={17} /></span>
                <strong>{t("noStocks")}</strong>
                <p>{t("chooseCompany")}</p>
                <button type="button" onClick={openStockSearch}>{t("chooseStocks")}</button>
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
                ? `${formatPrice(rowSnapshot.price, locale)}, ${rowUsesFixture ? t("demoFixture") : rowIsStale ? t("staleQuoteLabel") : t("providerQuote")}`
                : rowResource?.phase === "error"
                  ? t("quoteUnavailable")
                  : t("quoteLoading");

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
                            ? t("demo")
                            : rowIsStale
                              ? t("stale")
                            : rowSnapshot
                              ? instrument.exchange
                              : rowResource?.phase === "error"
                                ? t("noQuote")
                                : t("loading")}
                        </small>
                        {holding && (
                          <span className="holding-badge">
                            {t("ownedQuantity", { quantity: holding.quantity })}
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
                      <span className="market-awaiting">{t("awaiting")}</span>
                    )}
                  </button>
                  {watchlistIds.has(instrument.id) && (
                    <button
                      type="button"
                      className="remove-stock"
                      aria-label={t("removeFromWatchlist", { ticker: instrument.ticker })}
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
            <Plus size={15} /> {t("addStock")}
          </button>

          <div className="watchlist-summary">
            <div className="panel-heading compact">
              <span className="eyebrow">{t("todayAcrossList")}</span>
              <Gauge size={15} />
            </div>
            <div className="summary-stat-grid">
              <div><strong>{materialEventCount}</strong><span>{t("materialEvents")}</span></div>
              <div><strong>{positiveMovers}</strong><span>{t("positiveMovers")}</span></div>
              <div><strong>{sourceState === "provider" ? "API" : sourceState === "stale" ? t("stale") : sourceState === "unavailable" || sourceState === "empty" ? "—" : t("demo")}</strong><span>{t("quoteSource")}</span></div>
              <div><strong>{watchlist.length}</strong><span>{t("trackedSymbols")}</span></div>
            </div>
          </div>

          <nav className="side-nav" aria-label={t("application")}>
            <button type="button"><Layers3 size={16} /> {t("intelligenceFeed")}</button>
            <button
              type="button"
              disabled={!hasMarketSelection}
              onClick={openLiveOmnigazeView}
            >
              <MessageSquareText size={16} /> {t("askOmnigaze")}
            </button>
            <button
              type="button"
              disabled={!hasMarketSelection}
              onClick={() => openPortfolioWorkspace("research")}
            >
              <Gauge size={16} /> {t("researchScenarios")}
            </button>
            <Link href="/onboarding"><Settings2 size={16} /> {t("preferences")}</Link>
            <Link href="/data-and-deletion"><ShieldCheck size={16} /> {t("dataPrivacy")}</Link>
            {session.isAuthenticated && (
              <a href={session.signOutPath} target="_top">
                <LogOut size={16} /> {t("signOutPlain")}
              </a>
            )}
          </nav>
        </aside>

        <section className="market-workspace">
          <section className="dashboard-overview" aria-labelledby="market-overview-title" data-testid="market-overview">
            <div className="overview-copy">
              <span className="eyebrow">{t("personalMarket")}</span>
              <h1 id="market-overview-title">{t("marketGlance")}</h1>
              <p>{t("overviewDescription")}</p>
            </div>
            <div className="overview-actions">
              <button
                type="button"
                className="primary-action"
                data-testid="overview-add-stock"
                onClick={openStockSearch}
              >
                <Plus size={16} /> {t("addAStock")}
              </button>
              <button
                type="button"
                className="secondary-action"
                aria-expanded={showDataStatus}
                aria-controls="data-status-panel"
                onClick={() => setShowDataStatus((current) => !current)}
              >
                <ShieldCheck size={15} /> {t("dataStatus")}
              </button>
              <Link className="secondary-action" href="/onboarding">
                <Settings2 size={15} /> {t("editSetup")}
              </Link>
            </div>
            <div className="overview-metrics" aria-label={t("watchlistOverview")}>
              <span><strong>{watchlist.length}</strong> {t("tracked")}</span>
              <span>
                <strong>{portfolioAvailability === "unavailable" ? "—" : holdings.length}</strong> {t("held")}
              </span>
              <span><strong>{materialEventCount}</strong> {t("materialEvents")}</span>
              <span className={`overview-source ${sourceState}`}><i />{dataModeLabel}</span>
              {session.isAuthenticated && portfolioAvailability === "unavailable" && (
                <span><TriangleAlert size={11} /> {t("holdingsSyncUnavailable")}</span>
              )}
            </div>
          </section>

          <PortfolioPulseCard
            locale={locale}
            pulse={portfolioPulseState.data}
            holdingCount={holdings.length}
            loading={portfolioPulseState.loading}
            unavailable={portfolioAvailability === "unavailable"}
            onAddPosition={() => {
              if (hasMarketSelection) openPortfolioWorkspace("position");
              else openStockSearch();
            }}
            onSelectPosition={selectPulsePosition}
          />

          <PersonalTodayCard
            session={session}
            refreshToken={`${refreshGeneration}:${todayWatchlistGeneration}`}
            selectableSymbols={visibleInstruments.map(({ id }) => id)}
            onSelectSymbol={selectPulsePosition}
            onOpenInbox={() => openIntelligenceInbox("inbox")}
          />

          <DailyBriefCard session={session} />

          {visibleInstruments.length === 0 ? (
            <section className="dashboard-empty-state" aria-labelledby="empty-watchlist-title">
              <span className="empty-illustration" aria-hidden="true"><Layers3 size={25} /></span>
              <span className="eyebrow">{t("buildDashboard")}</span>
              <h2 id="empty-watchlist-title">{t("startWatchlist")}</h2>
              <p>{t("emptyDescription")}</p>
              <button type="button" className="primary-action" onClick={openStockSearch}>
                <Plus size={16} /> {t("addFirstStock")} <ArrowRight size={15} />
              </button>
              <small>{t("searchAnyEquity")}</small>
            </section>
          ) : (
          <>
          <div id="market-symbol-detail" className="symbol-header" aria-live="polite">
            <div className="symbol-identity">
              <span className="symbol-avatar large">{selectedInstrument.ticker[0]}</span>
              <div>
                <div className="ticker-line">
                  <h2 ref={marketSymbolHeadingRef} tabIndex={-1}>
                    {selectedInstrument.ticker}
                  </h2>
                  <span>{selectedInstrument.exchange}</span>
                  <button type="button" aria-label={t("favoriteTicker", { ticker: selectedInstrument.ticker })}>
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
                      {t("ownShares", { quantity: selectedHolding.quantity })}
                      {hasSelectedAverageCost
                        ? ` · ${t("averageCost", { price: formatPrice(selectedAverageCost, locale) })}`
                        : ""}
                    </>
                  ) : (
                    <>{t("addPosition")}</>
                  )}
                </button>
              </div>
            </div>
            <div className="quote-block">
              <strong>{snapshot ? formatPrice(snapshot.price, locale) : "—"}</strong>
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
                    ? t("quoteUnavailable")
                    : t("loadingQuote")}
                </span>
              )}
              <small>
                {sourceState === "provider" && snapshot
                  ? `${snapshot.isDelayed ? t("delayedMinutes", { minutes: Math.max(1, Math.ceil(snapshot.delaySeconds / 60)) }) : t("providerTimestamp")} · ${freshness}`
                  : sourceState === "stale"
                    ? t("lastKnownNotCurrent", { freshness })
                  : sourceState === "unavailable"
                    ? t("noSubstituteTicker", { ticker: selectedInstrument.ticker })
                    : `${sourceLabel} · ${t("notLive")}`}
              </small>
            </div>
          </div>

          <div className="metric-strip">
            <div><span>{t("previousClose")}</span><strong>{snapshot ? formatPrice(snapshot.previousClose, locale) : t("unavailable")}</strong></div>
            <div><span>{t("volume")}</span><strong>{snapshot ? formatCompact(snapshot.volume, locale) : t("unavailable")}</strong></div>
            <div><span>{t("marketCap")}</span><strong>{snapshot?.marketCap ?? t("unavailable")}</strong></div>
            <div><span>{t("sector")}</span><strong>{selectedInstrument.sector ?? t("unavailable")}</strong></div>
          </div>

          <section className="chart-panel" aria-labelledby="price-chart-title">
            <div className="chart-toolbar">
              <div>
                <span className="eyebrow">{t("price")}</span>
                <h2 id="price-chart-title">{t("marketMovement")}</h2>
                <small className="chart-source-note">
                  {chartUsesProvider
                    ? `${chartResource?.data?.provider} · ${chartIsStale ? t("staleHistory") : t("adjustedHistory")} · ${formatFreshness(chartResource?.data?.asOf ?? undefined, now, locale, t)}`
                    : !chartResource || chartResource.phase === "loading"
                      ? t("loadingHistory")
                      : chartUsesFixture
                        ? t("fixtureHistory")
                        : t("historyUnavailableTicker", { ticker: selectedInstrument.ticker })}
                </small>
              </div>
              <div className="timeframe-control" aria-label={t("chartTimeframe")}>
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

            <div className="chart-wrap" aria-label={t("priceChart", { ticker: selectedInstrument.ticker, timeframe })}>
              {chartData.length > 0 ? (
                <Suspense
                  fallback={
                    <div className="chart-unavailable-state" role="status">
                      <Clock3 size={20} />
                      <strong>{t("renderingHistory")}</strong>
                      <span>{t("preparingChart")}</span>
                    </div>
                  }
                >
                  <MarketPriceChart color={chartColor} data={chartData} />
                </Suspense>
              ) : (
                <div className="chart-unavailable-state" role="status">
                  {chartUnavailable ? <WifiOff size={20} /> : <Clock3 size={20} />}
                  <strong>
                    {chartUnavailable ? t("historicalUnavailable") : t("loadingPriceHistory")}
                  </strong>
                  <span>
                    {chartUnavailable
                      ? t("noSubstituteSeries", { ticker: selectedInstrument.ticker })
                      : t("checkingProviderTicker", { ticker: selectedInstrument.ticker })}
                  </span>
                </div>
              )}
            </div>

            <table className="sr-only">
              <caption>
                {selectedInstrument.ticker} · {chartUsesProvider ? chartIsStale ? t("staleHistory") : t("providerHistory") : chartUsesFixture ? t("illustrativeFixture") : t("unavailable")}
              </caption>
              <thead><tr><th>{t("time")}</th><th>{t("price")}</th><th>{t("volume")}</th></tr></thead>
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
                <span className="eyebrow">{t("intelligenceTimeline")}</span>
                <h2 id="event-heading">{t("whatChanged")}</h2>
              </div>
              <button
                type="button"
                onClick={() => openIntelligenceInbox("inbox")}
              >
                {t("viewAllEvents")} <ChevronRight size={15} />
              </button>
            </div>

            {intelligenceReadPlaneNotice && (
              <div
                className={`intelligence-provenance-note ${intelligenceReadPlaneNotice.tone}`}
                role="status"
                data-testid="intelligence-read-plane-notice"
              >
                <TriangleAlert size={15} />
                <div>
                  <strong>{intelligenceReadPlaneNotice.title}</strong>
                  <span>{intelligenceReadPlaneNotice.detail}</span>
                </div>
              </div>
            )}

            <div className="event-workspace-grid">
              <MoveLensCard
                result={moveLensResult}
                contextResource={marketContextResource}
                evidencePhase={intelligencePhase}
              />
              <div className="event-list">
              {events.length > 0 ? (
                events.map((event) => {
                  const feedItem = feedItemById.get(event.id);
                  const eventIsLive = feedItem?.isLive === true;
                  const eventClaimStatus =
                    feedItem?.claimStatus ?? event.claimStatus;
                  const eventCausalLink =
                    feedItem?.causalLink ?? event.causalLink;
                  const eventIsControversial =
                    feedItem?.isControversial === true ||
                    ("isControversial" in event &&
                      event.isControversial === true);

                  return (
                    <article className="event-card" key={event.id}>
                      <div className={`event-icon ${event.category}`}>
                        {event.category === "filing" ? <FileText size={17} /> : <Globe2 size={17} />}
                      </div>
                      <div className="event-body">
                        <div className="event-meta">
                          <span className={`materiality ${event.materiality}`}>
                            {t("impact", { materiality: materialityLabel(event.materiality, t) })}
                          </span>
                          <span>{formatTime(event.occurredAt, locale)}</span>
                          <span className={`source-chip ${eventIsLive ? "live" : "fixture"}`}>
                            {eventIsLive ? feedItem?.source ?? t("provider") : t("demoFixtureSource")}
                          </span>
                          <span className="event-truth-chip">
                            {moveCopy.category[feedItem?.category ?? event.category]}
                          </span>
                          {eventClaimStatus && (
                            <span className="event-truth-chip claim">
                              {moveCopy.claimStatus[eventClaimStatus]}
                            </span>
                          )}
                          {eventCausalLink && (
                            <span className="event-truth-chip causal">
                              {moveCopy.causalLink[eventCausalLink]}
                            </span>
                          )}
                          {eventIsControversial && (
                            <span className="event-truth-chip controversy">
                              {moveCopy.controversy}
                            </span>
                          )}
                        </div>
                        <h3>{event.headline}</h3>
                        <p>{event.summary}</p>
                        <div className="event-actions">
                          {feedItem?.sourceUrl ? (
                            <a href={feedItem.sourceUrl} target="_blank" rel="noreferrer">
                              {t("openSource")}
                            </a>
                          ) : eventIsLive ? (
                            <span>{t("sourceUnavailable")}</span>
                          ) : (
                            <button type="button">{t("inspectDemoEvidence")}</button>
                          )}
                          <button
                            type="button"
                            onClick={() => saveTimelineEvent(event.id)}
                          >
                            {t("saveForThesis")}
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
                        ? t("checkingEvidence")
                        : intelligencePhase === "error"
                          ? t("intelligenceUnavailable")
                          : !selectedWorkspace && intelligenceResource.meta?.dataMode === "demo"
                            ? t("awaitingVerifiedEvidence")
                            : t("noRecentEvents")}
                    </strong>
                    <span>
                      {!selectedWorkspace
                        ? t("noFixtureEvents", { ticker: selectedInstrument.ticker })
                        : t("keepChecking")}
                    </span>
                  </div>
                </div>
              )}
              </div>
            </div>
          </section>
          </>
          )}
        </section>

        <aside className="intelligence-panel">
          <div className="intelligence-heading">
            <div className="ai-orb"><Bot size={20} /></div>
            <div>
              <span className="eyebrow">{t("omnigazeView")}</span>
              <strong>
                {selectedWorkspace
                  ? t("illustrativeAnalysis")
                  : t("awaitingAnalysis")}
              </strong>
            </div>
            <button type="button" aria-label={t("aboutViews")}><CircleHelp size={16} /></button>
          </div>

          <div className="view-source-note">
            {selectedWorkspace ? <Sparkles size={13} /> : <Clock3 size={13} />}
            {selectedWorkspace
              ? t("fixtureAnalysisNote")
              : t("noViewYet", { ticker: selectedInstrument.ticker })}
          </div>
          {locale === "zh-CN" && (
            <div className="view-source-note">{t("sourceOriginalLanguage")}</div>
          )}

          <div className="insight-tabs" role="tablist" aria-label={t("analysisTabs")}>
            <button
              type="button"
              role="tab"
              aria-selected={insightTab === "view"}
              className={insightTab === "view" ? "active" : ""}
              onClick={() => setInsightTab("view")}
            >
              {t("currentView")}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={insightTab === "evidence"}
              className={insightTab === "evidence" ? "active" : ""}
              onClick={() => setInsightTab("evidence")}
            >
              {t("evidenceCount", { count: selectedWorkspace?.evidence.length ?? 0 })}
            </button>
          </div>

          {!selectedWorkspace ? (
            <div className="view-unavailable-state" role="status">
              <span className="empty-icon"><Clock3 size={19} /></span>
              <strong>
                {insightTab === "view"
                  ? t("viewAwaitingEvidence")
                  : t("noVerifiedEvidence")}
              </strong>
              <p>
                {insightTab === "view"
                  ? t("viewAfterEvidence", { ticker: selectedInstrument.ticker })
                  : t("collectingSources", { ticker: selectedInstrument.ticker })}
              </p>
              <small>{t("noCrossCompanyAnalysis")}</small>
              {insightTab === "view" && (
                <button
                  type="button"
                  className="ask-button"
                  onClick={openLiveOmnigazeView}
                >
                  <Sparkles size={16} /> {t("generateLiveView", { ticker: selectedInstrument.ticker })}
                </button>
              )}
            </div>
          ) : insightTab === "view" ? (
            <div className="view-content">
              <div className="stance-row">
                <div>
                  <span>{t("nearTermStance")}</span>
                  <strong className={`stance ${selectedWorkspace.view.stance}`}>
                    {stanceLabel(selectedWorkspace.view.stance, t)}
                  </strong>
                </div>
                <div className="confidence-ring" style={{ "--confidence": `${selectedWorkspace.view.confidence * 100}%` } as React.CSSProperties}>
                  <span>{Math.round(selectedWorkspace.view.confidence * 100)}%</span>
                  <small>{t("confidence")}</small>
                </div>
              </div>

              <div className="view-summary">
                <h2>{displayedViewHeadline}</h2>
                <p>{locale === "zh-CN" ? t("fixtureViewBody") : selectedWorkspace.view.summary}</p>
              </div>

              <div className="why-now-card">
                <div><Clock3 size={15} /><span>{t("whyNow")}</span></div>
                <p>{locale === "zh-CN" ? t("fixtureWhyNowBody") : selectedWorkspace.view.whyNow}</p>
              </div>

              <div className="driver-list">
                <div className="mini-heading"><span>{t("keyDrivers")}</span><small>{t("twoSignals")}</small></div>
                {displayedDemoDrivers.map((driver) => (
                  <div className="driver-row" key={driver.label}>
                    <span className={`driver-dot ${driver.direction}`} />
                    <div><strong>{driver.label}</strong><p>{driver.explanation}</p></div>
                  </div>
                ))}
              </div>

              <div className="unknowns">
                <div className="mini-heading"><span>{t("remainsUnknown")}</span></div>
                {displayedDemoUnknowns.map((unknown) => (
                  <p key={unknown}><span>?</span>{unknown}</p>
                ))}
              </div>

              <button
                type="button"
                className="ask-button"
                onClick={openLiveOmnigazeView}
              >
                <Sparkles size={16} /> {t("generateLiveView", { ticker: selectedInstrument.ticker })}
              </button>
            </div>
          ) : (
            <div className="evidence-list">
              {selectedWorkspace.evidence.map((evidence) => (
                <article key={evidence.id} className="evidence-card">
                  <div className="evidence-card-top">
                    <span className={`evidence-type ${evidence.classification}`}>
                      {evidenceLabel(evidence.classification, t)}
                    </span>
                    <span>{formatTime(evidence.publishedAt, locale)}</span>
                  </div>
                  <h3>{evidence.title}</h3>
                  <p>{evidence.publisher}{evidence.locator ? ` · ${evidence.locator}` : ""}</p>
                  {evidence.excerpt && <blockquote>{evidence.excerpt}</blockquote>}
                  <button type="button">{t("openSource")} <ChevronRight size={14} /></button>
                </article>
              ))}
            </div>
          )}

          <div className="view-footer">
            <ShieldCheck size={15} />
            <span>{t("researchOnly")}</span>
          </div>
        </aside>
      </div>

      {watchlist.length > 0 && (
        <section className="mobile-intelligence-summary">
          <div className="ai-orb"><Bot size={18} /></div>
          <div>
            <span className="eyebrow">
              {selectedWorkspace ? t("viewDemo") : t("viewAwaiting")}
            </span>
            <strong>{displayedViewHeadline}</strong>
          </div>
          <button
            type="button"
            aria-label={t("generateViewAria", { ticker: selectedInstrument.ticker })}
            onClick={openLiveOmnigazeView}
          >
            <ChevronRight size={18} />
          </button>
        </section>
      )}

      <MarketContextTicker resource={marketContextResource} />

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
          aria-label={t("closeWatchlist")}
          onClick={() => setShowMobileWatchlist(false)}
        />
      )}
    </main>
  );
}
