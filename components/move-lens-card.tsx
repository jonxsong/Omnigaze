"use client";

import {
  Activity,
  AlertTriangle,
  Clock3,
  ExternalLink,
  FileSearch,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useAppLocale } from "@/components/app-locale";
import type { MarketContextResource } from "@/components/market-context-ticker";
import { moveLensCopy } from "@/components/move-lens-copy";
import type {
  MoveLensBenchmarkResult,
  MoveLensComparisonUnavailableReason,
  MoveLensLeg,
  MoveLensResult,
  MoveLensUnavailableReason,
} from "@/lib/move-lens";
import styles from "./move-lens-card.module.css";

type EvidencePhase = "loading" | "ready" | "error";

export interface MoveLensCardProps {
  result: MoveLensResult | null;
  contextResource: MarketContextResource;
  evidencePhase: EvidencePhase;
}

function signedPercent(basisPoints: number) {
  const value = basisPoints / 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function signedPoints(basisPoints: number) {
  const value = basisPoints / 100;
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}`;
}

function movementClass(basisPoints: number) {
  return basisPoints > 0
    ? styles.positive
    : basisPoints < 0
      ? styles.negative
      : styles.flat;
}

function formatTimestamp(value: string, locale: string, fallback: string) {
  if (!Number.isFinite(Date.parse(value))) return fallback;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function unavailableDetail(
  reason: MoveLensUnavailableReason,
  copy: (typeof moveLensCopy)["en"],
) {
  if (reason === "demo_suppressed") return copy.fixtureSuppressed;
  if (reason === "freshness_unverified") return copy.staleComparison;
  return copy.providerUnavailable;
}

function comparisonDetail(
  reason: MoveLensComparisonUnavailableReason | null,
  copy: (typeof moveLensCopy)["en"],
) {
  if (reason === "session_mismatch") return copy.incompatibleSession;
  if (reason === "observation_skew") return copy.observationMismatch;
  if (reason === "delay_mismatch" || reason === "coverage_mismatch") {
    return copy.metadataMismatch;
  }
  return copy.providerUnavailable;
}

function observationProvenance(
  leg: MoveLensLeg,
  locale: "en" | "zh-CN",
) {
  const copy = moveLensCopy[locale];
  if (leg.status !== "available") {
    return [unavailableDetail(leg.reason, copy)];
  }
  const observation = leg.observation;
  return [
    copy.providerAndTime(
      observation.provider,
      formatTimestamp(
        observation.asOf,
        copy.dateLocale,
        copy.timestampUnavailable,
      ),
    ),
    observation.isDelayed
      ? copy.delayed(Math.max(1, Math.ceil(observation.delaySeconds / 60)))
      : null,
    observation.marketCoverage === "consolidated"
      ? copy.consolidatedCoverage
      : copy.limitedCoverage,
  ].filter((value): value is string => Boolean(value));
}

function MoveValue({
  leg,
  label,
}: {
  leg: MoveLensLeg;
  label: string;
}) {
  const { locale } = useAppLocale();
  const copy = moveLensCopy[locale];
  if (leg.status !== "available") {
    return (
      <span
        className={`${styles.value} ${styles.unavailable}`}
        aria-label={`${label}: ${unavailableDetail(leg.reason, copy)}`}
      >
        —
      </span>
    );
  }
  const formatted = signedPercent(leg.observation.absoluteMoveBps);
  return (
    <span
      className={`${styles.value} ${movementClass(
        leg.observation.absoluteMoveBps,
      )}`}
      aria-label={copy.moveAria(leg.ticker, formatted)}
    >
      {formatted}
    </span>
  );
}

function SelectedMove({ leg }: { leg: MoveLensLeg }) {
  const { locale } = useAppLocale();
  const copy = moveLensCopy[locale];
  return (
    <div className={`${styles.moveItem} ${styles.selected}`}>
      <div className={styles.moveHeading}>
        <strong>{leg.ticker}</strong>
        <span>{copy.selectedMove}</span>
      </div>
      <MoveValue leg={leg} label={leg.ticker} />
      <div className={styles.provenance}>
        {observationProvenance(leg, locale).map((line) => (
          <span key={line}>{line}</span>
        ))}
      </div>
    </div>
  );
}

function BenchmarkMove({
  benchmark,
  selectedTicker,
}: {
  benchmark: MoveLensBenchmarkResult;
  selectedTicker: string;
}) {
  const { locale } = useAppLocale();
  const copy = moveLensCopy[locale];
  const label = copy.benchmarkLabels[benchmark.key];
  return (
    <div className={styles.moveItem}>
      <div className={styles.moveHeading}>
        <strong>{benchmark.ticker}</strong>
        <span>{label}</span>
      </div>
      <MoveValue leg={benchmark} label={label} />
      <div className={styles.gap}>
        <span>{copy.relativeGap}</span>
        {benchmark.relativeMoveBps !== null ? (
          <strong
            aria-label={copy.gapAria(
              selectedTicker,
              label,
              signedPoints(benchmark.relativeMoveBps),
            )}
          >
            {copy.percentagePoints(signedPoints(benchmark.relativeMoveBps))}
          </strong>
        ) : (
          <strong
            className={styles.withheld}
            title={comparisonDetail(
              benchmark.comparisonUnavailableReason,
              copy,
            )}
          >
            {copy.comparisonWithheld}
          </strong>
        )}
      </div>
      <div className={styles.provenance}>
        {observationProvenance(benchmark, locale).map((line) => (
          <span key={line}>{line}</span>
        ))}
        {benchmark.relativeMoveBps === null && (
          <span>{comparisonDetail(benchmark.comparisonUnavailableReason, copy)}</span>
        )}
      </div>
    </div>
  );
}

export function MoveLensCard({
  result,
  contextResource,
  evidencePhase,
}: MoveLensCardProps) {
  const { locale } = useAppLocale();
  const copy = moveLensCopy[locale];
  const ticker = result?.data.selected.ticker ?? "—";
  const contextRetained = Boolean(contextResource.data);
  const contextLoading = contextResource.phase === "loading" && !contextRetained;
  const refreshDelayed = contextResource.phase === "error" && contextRetained;
  const contextUnavailable =
    contextResource.phase === "error" && !contextRetained;
  const retainedRefreshDelayed =
    refreshDelayed && result?.data.status !== "unavailable";
  const partial = result?.data.status === "partial";
  const statusText = contextLoading
    ? copy.loadingTitle
    : contextUnavailable || !result || result.data.status === "unavailable"
        ? copy.unavailableTitle
      : retainedRefreshDelayed
        ? copy.refreshDelayed
        : partial
          ? copy.partialTitle
          : copy.verifiedContext;
  const statusTone =
    contextUnavailable || !result || result.data.status === "unavailable"
      ? styles.error
      : retainedRefreshDelayed || partial || contextLoading
        ? styles.warning
        : "";
  const relatedEvent = result?.data.latestRelatedEvent ?? null;

  return (
    <section
      className={styles.card}
      aria-label={copy.cardAria(ticker)}
      data-testid="move-lens-card"
      data-status={
        retainedRefreshDelayed
          ? "refresh-delayed"
          : contextLoading
            ? "loading"
            : result?.data.status ?? "unavailable"
      }
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.icon} aria-hidden="true">
            <Activity size={17} />
          </span>
          <div>
            <span className={styles.eyebrow}>{copy.eyebrow}</span>
            <h3>{copy.title(ticker)}</h3>
            <p>{copy.subtitle}</p>
          </div>
        </div>
        <span
          className={`${styles.status} ${statusTone}`}
          role={contextUnavailable ? "alert" : "status"}
        >
          {contextLoading ? (
            <LoaderCircle className={styles.spinner} size={11} />
          ) : retainedRefreshDelayed || partial ? (
            <AlertTriangle size={11} />
          ) : contextUnavailable || result?.data.status === "unavailable" ? (
            <AlertTriangle size={11} />
          ) : (
            <ShieldCheck size={11} />
          )}
          {statusText}
        </span>
      </header>

      <div className={styles.body}>
        {(contextLoading ||
          retainedRefreshDelayed ||
          contextUnavailable ||
          !result ||
          result.data.status === "unavailable" ||
          partial) && (
          <div
            className={styles.notice}
            role={contextUnavailable ? "alert" : "status"}
          >
            {contextLoading ? (
              <LoaderCircle className={styles.spinner} size={13} />
            ) : (
              <AlertTriangle size={13} />
            )}
            <span>
              <strong>{statusText}. </strong>
              {contextLoading
                ? copy.loadingBody
                : retainedRefreshDelayed
                  ? copy.retainedDetail
                  : contextUnavailable ||
                      !result ||
                      result.data.status === "unavailable"
                    ? copy.unavailableBody
                    : copy.partialDetail}
            </span>
          </div>
        )}

        {result ? (
          <div className={styles.moveGrid} aria-label={copy.title(ticker)}>
            <SelectedMove leg={result.data.selected} />
            {result.data.benchmarks.map((benchmark) => (
              <BenchmarkMove
                benchmark={benchmark}
                key={benchmark.key}
                selectedTicker={result.data.selected.ticker}
              />
            ))}
          </div>
        ) : (
          <div className={styles.empty} role="status">
            <Clock3 size={16} />
            <div>
              <strong>{copy.unavailableTitle}</strong>
              <span>{copy.unavailableBody}</span>
            </div>
          </div>
        )}

        <section className={styles.evidence} aria-label={copy.latestEvidence}>
          <div className={styles.evidenceTitle}>
            <strong>{copy.latestEvidence}</strong>
            {relatedEvent && (
              <span>
                {formatTimestamp(
                  relatedEvent.publishedAt,
                  copy.dateLocale,
                  copy.timestampUnavailable,
                )}
              </span>
            )}
          </div>
          {relatedEvent ? (
            <>
              <div className={styles.badges}>
                {relatedEvent.claimStatus && (
                  <span className={styles.badge}>
                    {copy.claimStatus[relatedEvent.claimStatus]}
                  </span>
                )}
                <span className={`${styles.badge} ${styles.causal}`}>
                  {copy.causalLink.unassessed}
                </span>
                {relatedEvent.isControversial && (
                  <span className={`${styles.badge} ${styles.controversy}`}>
                    {copy.controversy}
                  </span>
                )}
              </div>
              <h4 className={styles.headline}>{relatedEvent.headline}</h4>
              {relatedEvent.summary && (
                <p className={styles.summary}>{relatedEvent.summary}</p>
              )}
              <div className={styles.sourceRow}>
                <span>{relatedEvent.source}</span>
                {relatedEvent.sourceUrl ? (
                  <a
                    href={relatedEvent.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={`${copy.openSource}: ${relatedEvent.headline}`}
                  >
                    {copy.openSource} <ExternalLink size={10} />
                  </a>
                ) : (
                  <span>{copy.sourceUnavailable}</span>
                )}
                <span>{copy.originalLanguage}</span>
              </div>
            </>
          ) : (
            <div className={styles.empty} role="status">
              {evidencePhase === "loading" ? (
                <LoaderCircle className={styles.spinner} size={16} />
              ) : (
                <FileSearch size={16} />
              )}
              <div>
                <strong>{copy.noEvidenceTitle}</strong>
                <span>
                  {evidencePhase === "loading"
                    ? copy.evidenceLoading
                    : evidencePhase === "error"
                      ? copy.evidenceUnavailable
                      : copy.noEvidenceBody}
                </span>
              </div>
            </div>
          )}
        </section>

        <p className={styles.disclosure}>
          <ShieldCheck size={13} aria-hidden="true" />
          <span>{copy.disclosure}</span>
        </p>
      </div>
    </section>
  );
}
