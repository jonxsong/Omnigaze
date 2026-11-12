"use client";

import { useMemo } from "react";
import { useAppLocale } from "@/components/app-locale";
import { marketContextCopy } from "@/components/market-context-copy";
import {
  marketContextProxies,
  type MarketContextResult,
} from "@/lib/market-context";

export type MarketContextResource = {
  data?: MarketContextResult;
  phase: "loading" | "ready" | "error";
};

function localeTag(locale: "en" | "zh-CN") {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

function formatPrice(value: number, locale: "en" | "zh-CN") {
  return new Intl.NumberFormat(localeTag(locale), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTimestamp(
  value: string | undefined,
  locale: "en" | "zh-CN",
  fallback: string,
) {
  if (!value || !Number.isFinite(Date.parse(value))) return fallback;
  const date = new Date(value);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  return new Intl.DateTimeFormat(localeTag(locale), {
    month: sameDay ? undefined : "short",
    day: sameDay ? undefined : "numeric",
    year: !sameDay && date.getFullYear() !== now.getFullYear() ? "numeric" : undefined,
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function MarketContextTicker({
  resource,
}: {
  resource: MarketContextResource;
}) {
  const { locale } = useAppLocale();
  const copy = marketContextCopy[locale];

  const items = useMemo(
    () =>
      marketContextProxies.map((proxy) => {
        const item = resource.data?.data.find(
          (candidate) => candidate.symbolId === proxy.symbolId,
        );
        return { proxy, item };
      }),
    [resource.data],
  );
  const status = resource.data?.meta.status;
  const statusLabel =
    resource.phase === "loading" && !resource.data
      ? copy.checking
      : resource.phase === "error" && resource.data
        ? copy.refreshDelayed
        : status === "live"
          ? copy.live
          : status === "partial"
            ? copy.partial
            : status === "stale"
              ? copy.stale
              : copy.unavailable;
  const statusClass =
    resource.phase === "error"
      ? "stale"
      : status === "live"
      ? "provider"
      : status === "partial" || status === "stale"
        ? "stale"
        : resource.phase === "loading"
          ? "loading"
          : "unavailable";
  const displayedSnapshots = items.flatMap(({ item }) =>
    item?.status === "live" || item?.status === "stale" ? [item.snapshot] : [],
  );
  const providers = Array.from(
    new Set(displayedSnapshots.map((snapshot) => snapshot.provider)),
  );
  const oldestObservation = displayedSnapshots
    .map((snapshot) => snapshot.asOf)
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0];
  const coverageLabel =
    displayedSnapshots.length === 0
      ? null
      : displayedSnapshots.every(
            (snapshot) => snapshot.marketCoverage === "consolidated",
          )
        ? copy.consolidatedCoverage
        : displayedSnapshots.every(
              (snapshot) => snapshot.marketCoverage === "limited-exchange",
            )
          ? copy.limitedCoverage
          : copy.mixedCoverage;
  const maximumDelaySeconds = displayedSnapshots.reduce(
    (maximum, snapshot) =>
      snapshot.isDelayed ? Math.max(maximum, snapshot.delaySeconds) : maximum,
    0,
  );
  const provenance = [
    providers.join(" / ") || null,
    coverageLabel,
    maximumDelaySeconds > 0
      ? copy.delayed.replace(
          "{minutes}",
          String(Math.max(1, Math.ceil(maximumDelaySeconds / 60))),
        )
      : null,
    oldestObservation
      ? copy.asOf.replace(
          "{time}",
          formatTimestamp(oldestObservation, locale, copy.timestampUnavailable),
        )
      : copy.checkedAt.replace(
          "{time}",
          formatTimestamp(
            resource.data?.meta.generatedAt,
            locale,
            copy.timestampUnavailable,
          ),
        ),
    copy.proxyNotice,
  ]
    .filter((value): value is string => Boolean(value))
    .join(" · ");

  return (
    <footer
      className="market-ticker"
      aria-label={copy.ariaLabel}
      data-testid="market-context-ticker"
      data-status={resource.phase === "error" ? "error" : status ?? "loading"}
    >
      <span className="ticker-status">
        <span className={`status-dot ${statusClass}`} /> {statusLabel}
      </span>
      {items.map(({ proxy, item }) => {
        const snapshot =
          item?.status === "live" || item?.status === "stale"
            ? item.snapshot
            : null;
        const change = snapshot?.changePercent;
        const priceLabel = snapshot ? formatPrice(snapshot.price, locale) : "—";
        const changeLabel =
          change == null
            ? "—"
            : `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
        const staleLabel = item?.status === "stale" ? copy.staleItem : null;
        const delayedLabel = snapshot?.isDelayed
          ? copy.delayed.replace(
              "{minutes}",
              String(Math.max(1, Math.ceil(snapshot.delaySeconds / 60))),
            )
          : null;
        return (
          <span
            className={`ticker-item${item?.status === "stale" ? " stale" : ""}`}
            key={proxy.symbolId}
            role="group"
            title={[copy.labels[proxy.key], staleLabel, delayedLabel]
              .filter(Boolean)
              .join(" · ")}
            aria-label={[
              proxy.ticker,
              copy.labels[proxy.key],
              priceLabel,
              changeLabel,
              staleLabel,
              delayedLabel,
            ]
              .filter(Boolean)
              .join(" · ")}
          >
            <strong>{proxy.ticker}</strong>
            <span>{priceLabel}</span>
            <small
              className={
                change == null
                  ? "market-unavailable"
                  : change >= 0
                    ? "market-positive"
                    : "market-negative"
              }
            >
              {changeLabel}
            </small>
            {staleLabel ? (
              <em className="ticker-stale-marker">{staleLabel}</em>
            ) : null}
          </span>
        );
      })}
      <span className="ticker-time" title={provenance}>
        {provenance}
      </span>
    </footer>
  );
}
