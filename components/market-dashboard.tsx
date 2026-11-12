"use client";

import { useMemo, useState } from "react";
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
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Star,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { defaultWatchlist, stockWorkspaces } from "@/lib/demo-market-data";
import type {
  CanonicalSymbol,
  EvidenceClassification,
  MarketPoint,
  Materiality,
} from "@/lib/market-types";

const timeframes = ["1D", "1W", "1M", "3M", "1Y"] as const;
type Timeframe = (typeof timeframes)[number];

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

  const selected =
    stockWorkspaces.find(
      (workspace) => workspace.instrument.id === selectedSymbol,
    ) ?? stockWorkspaces[0];

  const watchedStocks = watchlist
    .map((symbol) =>
      stockWorkspaces.find((workspace) => workspace.instrument.id === symbol),
    )
    .filter(Boolean) as typeof stockWorkspaces;

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
  const positive = selected.snapshot.change >= 0;
  const chartColor = positive ? "#22d3a7" : "#ff6b7d";

  function selectStock(symbol: CanonicalSymbol) {
    setSelectedSymbol(symbol);
    setShowSearch(false);
    setShowMobileWatchlist(false);
  }

  function addStock(symbol: CanonicalSymbol) {
    setWatchlist((current) =>
      current.includes(symbol) ? current : [...current, symbol],
    );
    selectStock(symbol);
  }

  function removeStock(symbol: CanonicalSymbol) {
    setWatchlist((current) => {
      const next = current.filter((item) => item !== symbol);
      if (symbol === selectedSymbol && next[0]) setSelectedSymbol(next[0]);
      return next;
    });
  }

  return (
    <main className="omnigaze-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <BrandMark />
          <div>
            <span className="brand-name">OMNIGAZE</span>
            <span className="brand-beta">ALPHA</span>
          </div>
        </div>

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
            aria-label="Search stocks"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setShowSearch(true);
            }}
            onFocus={() => setShowSearch(true)}
            placeholder="Search stocks, events, filings…"
          />
          <kbd>⌘ K</kbd>

          {showSearch && (
            <div className="search-results" role="listbox">
              <div className="search-results-header">
                <span>Stocks</span>
                <button
                  type="button"
                  aria-label="Close search"
                  onClick={() => setShowSearch(false)}
                >
                  <X size={15} />
                </button>
              </div>
              {searchResults.map(({ instrument, snapshot }) => {
                const alreadyWatched = watchlist.includes(instrument.id);
                return (
                  <button
                    key={instrument.id}
                    type="button"
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
              })}
            </div>
          )}
        </div>

        <div className="topbar-actions">
          <div className="market-status">
            <span className="status-dot" />
            <span>US market open</span>
            <small>3h 18m left</small>
          </div>
          <button type="button" className="icon-button" aria-label="Notifications">
            <Bell size={18} />
            <span className="notification-dot" />
          </button>
          <button type="button" className="profile-button" aria-label="Open profile">
            JZ
          </button>
        </div>
      </header>

      <div className="demo-banner" role="status">
        <Sparkles size={14} />
        <span>
          Interactive foundation preview — prices and analysis are clearly labeled demo data.
        </span>
        <button type="button">View data status</button>
      </div>

      <div className="dashboard-grid">
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
              onClick={() => setShowSearch(true)}
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
            {watchedStocks.map(({ instrument, snapshot }) => (
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
                >
                  <span className="symbol-cell">
                    <span className="symbol-avatar small">{instrument.ticker[0]}</span>
                    <span>
                      <strong>{instrument.ticker}</strong>
                      <small>{instrument.exchange}</small>
                    </span>
                  </span>
                  <span className="price-cell">{snapshot.price.toFixed(2)}</span>
                  <span className={movementClass(snapshot.change)}>
                    <span aria-hidden="true">{snapshot.change >= 0 ? "↗" : "↘"}</span>{" "}
                    {snapshot.changePercent >= 0 ? "+" : ""}
                    {snapshot.changePercent.toFixed(2)}%
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
            ))}
          </div>

          <button className="add-symbol-button" type="button" onClick={() => setShowSearch(true)}>
            <Plus size={15} /> Add symbol
          </button>

          <div className="watchlist-summary">
            <div className="panel-heading compact">
              <span className="eyebrow">TODAY ACROSS YOUR LIST</span>
              <Gauge size={15} />
            </div>
            <div className="summary-stat-grid">
              <div><strong>3</strong><span>material events</span></div>
              <div><strong>2</strong><span>positive movers</span></div>
              <div><strong>1</strong><span>thesis alert</span></div>
              <div><strong>72%</strong><span>tech exposure</span></div>
            </div>
          </div>

          <nav className="side-nav" aria-label="Application">
            <button type="button"><Layers3 size={16} /> Intelligence feed</button>
            <button type="button"><MessageSquareText size={16} /> Ask Omnigaze</button>
            <button type="button"><Settings2 size={16} /> Preferences</button>
          </nav>
        </aside>

        <section className="market-workspace">
          <div className="symbol-header">
            <div className="symbol-identity">
              <span className="symbol-avatar large">{selected.instrument.ticker[0]}</span>
              <div>
                <div className="ticker-line">
                  <h1>{selected.instrument.ticker}</h1>
                  <span>{selected.instrument.exchange}</span>
                  <button type="button" aria-label={`Favorite ${selected.instrument.ticker}`}>
                    <Star size={16} />
                  </button>
                </div>
                <p>{selected.instrument.name}</p>
              </div>
            </div>
            <div className="quote-block">
              <strong>{formatPrice(selected.snapshot.price)}</strong>
              <span className={movementClass(selected.snapshot.change)}>
                {selected.snapshot.change >= 0 ? (
                  <TrendingUp size={16} aria-hidden="true" />
                ) : (
                  <TrendingDown size={16} aria-hidden="true" />
                )}
                {selected.snapshot.change >= 0 ? "+" : ""}
                {selected.snapshot.change.toFixed(2)} ({selected.snapshot.changePercent.toFixed(2)}%)
              </span>
              <small>Delayed 15 min · {formatTime(selected.snapshot.asOf)}</small>
            </div>
          </div>

          <div className="metric-strip">
            <div><span>Previous close</span><strong>{formatPrice(selected.snapshot.previousClose)}</strong></div>
            <div><span>Volume</span><strong>{formatCompact(selected.snapshot.volume)}</strong></div>
            <div><span>Market cap</span><strong>{selected.snapshot.marketCap}</strong></div>
            <div><span>Sector</span><strong>{selected.instrument.sector}</strong></div>
          </div>

          <section className="chart-panel" aria-labelledby="price-chart-title">
            <div className="chart-toolbar">
              <div>
                <span className="eyebrow">PRICE</span>
                <h2 id="price-chart-title">Market movement</h2>
              </div>
              <div className="timeframe-control" aria-label="Chart timeframe">
                {timeframes.map((range) => (
                  <button
                    key={range}
                    type="button"
                    className={timeframe === range ? "active" : ""}
                    aria-pressed={timeframe === range}
                    onClick={() => setTimeframe(range)}
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
              {selected.events.map((event) => (
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
                      <span>{event.status}</span>
                    </div>
                    <h3>{event.headline}</h3>
                    <p>{event.summary}</p>
                    <div className="event-actions">
                      <button type="button">Inspect evidence</button>
                      <button type="button">Add to thesis</button>
                    </div>
                  </div>
                  <ChevronRight className="event-chevron" size={18} />
                </article>
              ))}
            </div>
          </section>
        </section>

        <aside className="intelligence-panel">
          <div className="intelligence-heading">
            <div className="ai-orb"><Bot size={20} /></div>
            <div>
              <span className="eyebrow">OMNIGAZE VIEW</span>
              <strong>Evidence-backed interpretation</strong>
            </div>
            <button type="button" aria-label="About Omnigaze views"><CircleHelp size={16} /></button>
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
                <h2>{selected.events[0].headline}</h2>
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

      <section className="mobile-intelligence-summary">
        <div className="ai-orb"><Bot size={18} /></div>
        <div><span className="eyebrow">OMNIGAZE VIEW</span><strong>{selected.events[0].headline}</strong></div>
        <button type="button"><ChevronRight size={18} /></button>
      </section>

      <footer className="market-ticker" aria-label="Market summary">
        <span className="ticker-status"><span className="status-dot" /> LIVE CONTEXT</span>
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
        <span className="ticker-time">Demo snapshot · Nov 11, 2026</span>
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
