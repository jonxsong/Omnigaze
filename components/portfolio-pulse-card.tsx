"use client";

import Activity from "lucide-react/icons/activity";
import ArrowDownRight from "lucide-react/icons/arrow-down-right";
import ArrowUpRight from "lucide-react/icons/arrow-up-right";
import BriefcaseBusiness from "lucide-react/icons/briefcase-business";
import Clock3 from "lucide-react/icons/clock-3";
import Plus from "lucide-react/icons/plus";
import ShieldCheck from "lucide-react/icons/shield-check";
import TriangleAlert from "lucide-react/icons/triangle-alert";
import { useState } from "react";
import type { AppLocale } from "@/lib/app-locale";
import type { CanonicalSymbol } from "@/lib/market-types";
import type {
  PortfolioPulse,
  PortfolioPulseExclusionReason,
  PortfolioPulsePosition,
} from "@/lib/portfolio/portfolio-pulse";
import {
  formatPortfolioPulseCopy,
  type PortfolioPulseCopyKey,
} from "./portfolio-pulse-copy";
import styles from "./portfolio-pulse-card.module.css";

const VISIBLE_POSITION_LIMIT = 8;

type PortfolioPulseCardProps = {
  locale: AppLocale;
  pulse: PortfolioPulse | null;
  holdingCount: number;
  loading: boolean;
  unavailable: boolean;
  onAddPosition(): void;
  onSelectPosition(symbolId: CanonicalSymbol): void;
};

function decimalParts(value: string) {
  const match = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) return null;
  return {
    negative: match[1] === "-",
    whole: match[2],
    fraction: (match[3] ?? "").padEnd(6, "0"),
  };
}

function decimalMicros(value: string) {
  const parts = decimalParts(value);
  if (!parts) return null;
  const micros =
    BigInt(parts.whole) * BigInt(1_000_000) + BigInt(parts.fraction);
  return parts.negative ? -micros : micros;
}

function formatUsd(value: string | null, locale: AppLocale, signed = false) {
  if (value === null) return "—";
  const micros = decimalMicros(value);
  if (micros === null) return "—";
  const negative = micros < BigInt(0);
  const absolute = negative ? -micros : micros;
  const roundedCents = (absolute + BigInt(5_000)) / BigInt(10_000);
  const whole = roundedCents / BigInt(100);
  const cents = (roundedCents % BigInt(100)).toString().padStart(2, "0");
  const grouped = new Intl.NumberFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    maximumFractionDigits: 0,
  }).format(whole);
  const sign = negative ? "-" : signed && micros > BigInt(0) ? "+" : "";
  return `${sign}$${grouped}.${cents}`;
}

export function formatPortfolioPulsePercent(
  value: string | null,
  signed = false,
) {
  if (value === null) return "—";
  const micros = decimalMicros(value);
  if (micros === null) return "—";
  const negative = micros < BigInt(0);
  const absolute = negative ? -micros : micros;
  const roundedHundredths = (absolute + BigInt(5_000)) / BigInt(10_000);
  const whole = roundedHundredths / BigInt(100);
  const hundredths = (roundedHundredths % BigInt(100))
    .toString()
    .padStart(2, "0");
  const sign =
    roundedHundredths === BigInt(0)
      ? ""
      : negative
        ? "-"
        : signed
          ? "+"
          : "";
  return `${sign}${whole.toString()}.${hundredths}%`;
}

function formatQuantity(value: string, locale: AppLocale) {
  const parts = decimalParts(value);
  if (!parts) return value;
  const grouped = new Intl.NumberFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    maximumFractionDigits: 0,
  }).format(BigInt(parts.whole));
  const fraction = parts.fraction.replace(/0+$/, "");
  return `${parts.negative ? "-" : ""}${grouped}${fraction ? `.${fraction}` : ""}`;
}

function movementClass(value: string | null) {
  const micros = value === null ? null : decimalMicros(value);
  if (micros === null || micros === BigInt(0)) return styles.neutral;
  return micros > BigInt(0) ? styles.positive : styles.negative;
}

function exclusionCopyKey(reason: PortfolioPulseExclusionReason | null): PortfolioPulseCopyKey {
  if (reason === "stale_quote") return "staleQuote";
  if (reason === "demo_quote" || reason === "fixture_quote") return "demoQuote";
  if (reason === "missing_quote") return "quoteUnavailable";
  if (reason === "value_below_minimum_precision") return "belowPrecision";
  if (
    reason === "invalid_quantity" ||
    reason === "invalid_average_cost" ||
    reason === "unsupported_currency" ||
    reason === "duplicate_symbol"
  ) {
    return "invalidHolding";
  }
  return "quoteExcluded";
}

function formatAsOf(value: string | null, locale: AppLocale) {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(timestamp);
}

function PositionRow({
  locale,
  position,
  onSelect,
}: {
  locale: AppLocale;
  position: PortfolioPulsePosition;
  onSelect(): void;
}) {
  const copy = (key: PortfolioPulseCopyKey, values?: Record<string, string | number>) =>
    formatPortfolioPulseCopy(locale, key, values);
  return (
    <tr
      className={`${styles.row} ${position.included ? "" : styles.excluded}`}
      data-testid={`portfolio-pulse-position-${position.ticker}`}
    >
      <th scope="row">
        <button
          type="button"
          className={styles.symbol}
          aria-label={copy("selectPosition", { ticker: position.ticker })}
          onClick={onSelect}
        >
          <span className={styles.symbolMark}>{position.ticker.slice(0, 1)}</span>
          <span>
            <strong>{position.ticker}</strong>
            <small>
              {position.included
                ? copy("coveredWeight", {
                    weight: ((position.weightBps ?? 0) / 100).toFixed(2),
                  })
                : copy(exclusionCopyKey(position.exclusionReason))}
            </small>
          </span>
        </button>
      </th>
      <td>{formatQuantity(position.quantity, locale)}</td>
      <td>{formatUsd(position.currentValue, locale)}</td>
      <td className={movementClass(position.dayPnl)}>{formatUsd(position.dayPnl, locale, true)}</td>
      <td className={movementClass(position.unrealizedPnl)}>
        {position.unrealizedPnl === null
          ? position.included
            ? copy("noCostBasis")
            : "—"
          : formatUsd(position.unrealizedPnl, locale, true)}
      </td>
    </tr>
  );
}

export function PortfolioPulseCard({
  locale,
  pulse,
  holdingCount,
  loading,
  unavailable,
  onAddPosition,
  onSelectPosition,
}: PortfolioPulseCardProps) {
  const [showAllPositions, setShowAllPositions] = useState(false);
  const copy = (key: PortfolioPulseCopyKey, values?: Record<string, string | number>) =>
    formatPortfolioPulseCopy(locale, key, values);
  const ready = Boolean(pulse && pulse.coverage.includedPositions > 0);
  const included = pulse?.positions.filter((position) => position.included) ?? [];
  const excluded = pulse?.positions.filter((position) => !position.included) ?? [];
  const orderedPositions = [...included, ...excluded];
  const positions = showAllPositions
    ? orderedPositions
    : orderedPositions.slice(0, VISIBLE_POSITION_LIMIT);
  const largest = included.reduce<PortfolioPulsePosition | null>(
    (current, position) =>
      !current || (position.weightBps ?? -1) > (current.weightBps ?? -1)
        ? position
        : current,
    null,
  );
  const top = pulse?.contributors.positive[0] ?? null;
  const bottom = pulse?.contributors.negative[0] ?? null;
  const providers = new Set(
    included.flatMap((position) => (position.quote.provider ? [position.quote.provider] : [])),
  );
  const asOf = formatAsOf(pulse?.asOf ?? null, locale);
  const maximumDelay = included.reduce(
    (maximum, position) => Math.max(maximum, position.quote.delaySeconds ?? 0),
    0,
  );
  const marketCoverageLabel = included.some(
    (position) => position.quote.marketCoverage === "limited-exchange",
  )
    ? copy("limitedExchange")
    : included.some(
          (position) => position.quote.marketCoverage === "consolidated",
        )
      ? copy("consolidated")
      : null;
  const exclusionSummary = excluded
    .slice(0, 4)
    .map(
      (position) =>
        `${position.ticker}: ${copy(exclusionCopyKey(position.exclusionReason))}`,
    )
    .join(" · ");

  return (
    <section className={styles.card} aria-labelledby="portfolio-pulse-title" data-testid="portfolio-pulse">
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.icon} aria-hidden="true"><Activity size={20} /></span>
          <div>
            <span className={styles.eyebrow}>{copy("eyebrow")}</span>
            <h2 id="portfolio-pulse-title">{copy("title")}</h2>
            <p>{copy("description")}</p>
          </div>
        </div>
        {pulse && holdingCount > 0 && (
          <span className={`${styles.coverageBadge} ${pulse.coverage.status === "complete" ? "" : styles.partial}`}>
            <i />
            {pulse.coverage.status === "complete" ? copy("completeCoverage") : copy("partialCoverage")}
          </span>
        )}
      </header>

      <div className={styles.body}>
        {unavailable ? (
          <div className={styles.state} role="status" data-testid="portfolio-pulse-unavailable">
            <div>
              <span className={styles.stateIcon}><TriangleAlert size={19} /></span>
              <strong>{copy("unavailableTitle")}</strong>
              <p>{copy("unavailableBody")}</p>
            </div>
          </div>
        ) : holdingCount === 0 ? (
          <div className={styles.state} data-testid="portfolio-pulse-empty">
            <div>
              <span className={styles.stateIcon}><BriefcaseBusiness size={19} /></span>
              <strong>{copy("emptyTitle")}</strong>
              <p>{copy("emptyBody")}</p>
              <button type="button" onClick={onAddPosition}><Plus size={14} /> {copy("addPosition")}</button>
            </div>
          </div>
        ) : loading && !ready ? (
          <div className={styles.state} role="status" data-testid="portfolio-pulse-loading">
            <div>
              <span className={styles.stateIcon}><Clock3 size={19} /></span>
              <strong>{copy("waitingTitle")}</strong>
              <p>{copy("waitingBody")}</p>
            </div>
          </div>
        ) : pulse && pulse.positions.length > 0 && !ready ? (
          <div className={styles.state} role="status" data-testid="portfolio-pulse-excluded">
            <div>
              <span className={styles.stateIcon}><TriangleAlert size={19} /></span>
              <strong>{copy("noVerifiedQuotesTitle")}</strong>
              <p>{copy("noVerifiedQuotesBody", { count: pulse.coverage.excludedPositions })}</p>
              {exclusionSummary && <small>{exclusionSummary}</small>}
            </div>
          </div>
        ) : !pulse || !ready ? (
          <div className={styles.state} role="status" data-testid="portfolio-pulse-unavailable">
            <div>
              <span className={styles.stateIcon}><TriangleAlert size={19} /></span>
              <strong>{copy("unavailableTitle")}</strong>
              <p>{copy("unavailableBody")}</p>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.metrics}>
              <div className={styles.metric}>
                <span>{copy("marketValue")}</span>
                <strong>{formatUsd(pulse.totals.currentValue, locale)}</strong>
                <small>{copy("coverage", { covered: pulse.coverage.includedPositions, total: pulse.coverage.totalPositions })}</small>
              </div>
              <div className={styles.metric}>
                <span>{copy("todayChange")}</span>
                <strong className={movementClass(pulse.totals.dayPnl)}>{formatUsd(pulse.totals.dayPnl, locale, true)}</strong>
                <small className={movementClass(pulse.totals.dayPnl)}>{formatPortfolioPulsePercent(pulse.totals.dayChangePercent, true)}</small>
              </div>
              <div className={styles.metric}>
                <span>{copy("unrealizedPnl")}</span>
                <strong className={movementClass(pulse.totals.coveredUnrealizedPnl)}>{formatUsd(pulse.totals.coveredUnrealizedPnl, locale, true)}</strong>
                <small>{copy("costCoverage", { covered: pulse.coverage.costBasisPositions, total: pulse.coverage.includedPositions })}</small>
              </div>
              <div className={styles.metric}>
                <span>{copy("largestPosition")}</span>
                <strong>{largest?.ticker ?? "—"}</strong>
                <small>
                  {largest?.weightBps === null || largest?.weightBps === undefined
                    ? "—"
                    : copy("coveredWeight", {
                        weight: (largest.weightBps / 100).toFixed(2),
                      })}
                </small>
              </div>
            </div>

            <div className={styles.contentGrid}>
              <section className={styles.positions} aria-label={copy("positions")}>
                <div className={styles.sectionHeader}>
                  <strong>{copy("positions")}</strong>
                  <span>{copy("coverage", { covered: pulse.coverage.includedPositions, total: pulse.coverage.totalPositions })}</span>
                </div>
                <div className={styles.tableWrap}>
                  <table className={styles.table}>
                    <thead>
                      <tr>
                        <th scope="col">{copy("positions")}</th>
                        <th scope="col">{copy("quantity")}</th>
                        <th scope="col">{copy("value")}</th>
                        <th scope="col">{copy("today")}</th>
                        <th scope="col">{copy("unrealized")}</th>
                      </tr>
                    </thead>
                    <tbody id="portfolio-pulse-position-rows">
                      {positions.map((position) => (
                        <PositionRow
                          key={position.symbolId}
                          locale={locale}
                          position={position}
                          onSelect={() => onSelectPosition(position.symbolId)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                {orderedPositions.length > VISIBLE_POSITION_LIMIT && (
                  <div className={styles.positionToggleWrap}>
                    <button
                      type="button"
                      className={styles.positionToggle}
                      aria-controls="portfolio-pulse-position-rows"
                      aria-expanded={showAllPositions}
                      onClick={() => setShowAllPositions((current) => !current)}
                    >
                      {showAllPositions
                        ? copy("showLessPositions")
                        : copy("showAllPositions", {
                            count: orderedPositions.length,
                          })}
                    </button>
                  </div>
                )}
                {pulse.coverage.omittedPositions > 0 && (
                  <div className={styles.sectionHeader}>
                    <span>{copy("omittedPositions", { count: pulse.coverage.omittedPositions })}</span>
                  </div>
                )}
              </section>

              <aside className={styles.contributors} aria-label={`${copy("topContributor")} / ${copy("bottomContributor")}`}>
                <div className={styles.sectionHeader}><strong>{copy("todayChange")}</strong></div>
                <div className={styles.contributor}>
                  <div><span>{copy("topContributor")}</span><strong>{top?.ticker ?? copy("noPositiveContributor")}</strong></div>
                  <strong className={styles.positive}>{top ? formatUsd(top.dayPnl, locale, true) : "—"}</strong>
                </div>
                <div className={styles.contributor}>
                  <div><span>{copy("bottomContributor")}</span><strong>{bottom?.ticker ?? copy("noNegativeContributor")}</strong></div>
                  <strong className={styles.negative}>{bottom ? formatUsd(bottom.dayPnl, locale, true) : "—"}</strong>
                </div>
              </aside>
            </div>

            <div className={styles.metadata}>
              {providers.size === 1 ? (
                <span><ShieldCheck size={11} /> {copy("provider", { provider: [...providers][0] })}</span>
              ) : providers.size > 1 ? (
                <span><ShieldCheck size={11} /> {copy("multipleProviders", { count: providers.size })}</span>
              ) : null}
              {asOf && <span><Clock3 size={11} /> {copy("asOf", { time: asOf })}</span>}
              {marketCoverageLabel && <span><ShieldCheck size={11} /> {marketCoverageLabel}</span>}
              <span>
                {maximumDelay > 0 ? <ArrowDownRight size={11} /> : <ArrowUpRight size={11} />}
                {maximumDelay > 0 ? copy("delayed", { seconds: maximumDelay }) : copy("realTime")}
              </span>
              <span className={styles.disclaimer}>{copy("researchOnly")}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
