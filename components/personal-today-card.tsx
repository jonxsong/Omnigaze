"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Clock3,
  ExternalLink,
  Globe2,
  LoaderCircle,
  Newspaper,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useAppLocale } from "@/components/app-locale";
import {
  personalTodayCopy,
  personalTodayErrorMessage,
} from "@/components/personal-today-copy";
import {
  parsePersonalTodayEnvelope,
  type PersonalTodayEnvelope,
  type PersonalTodayReadyEnvelope,
} from "@/lib/api/personal-today-client";
import type { CanonicalSymbol } from "@/lib/market-types";
import styles from "./personal-today-card.module.css";

export type PersonalTodayCardSession =
  | { isAuthenticated: false; signInPath: string }
  | { isAuthenticated: true; signInPath?: never };

interface PersonalTodayCardProps {
  session: PersonalTodayCardSession;
  refreshToken: string;
  selectableSymbols: readonly CanonicalSymbol[];
  onSelectSymbol: (symbol: CanonicalSymbol) => void;
  onOpenInbox: () => void;
}

type PersonalTodayResource =
  | { phase: "idle"; previous?: undefined; data?: undefined; code?: undefined }
  | {
      phase: "loading";
      previous?: PersonalTodayEnvelope;
      data?: undefined;
      code?: undefined;
    }
  | { phase: "ready"; data: PersonalTodayEnvelope; previous?: undefined; code?: undefined }
  | {
      phase: "error";
      code: string | null;
      previous?: PersonalTodayEnvelope;
      data?: undefined;
    };

type ProvenanceNotice = {
  key: string;
  tone: "live" | "warning";
  title: string;
  detail: string;
};

function formatTimestamp(value: string, locale: string, unavailable: string) {
  if (!Number.isFinite(Date.parse(value))) return unavailable;
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function tickerFromSymbol(symbol: string) {
  return symbol.split(":").at(-1) ?? symbol;
}

function responseCode(value: unknown, status: number) {
  if (value && typeof value === "object" && "code" in value) {
    const code = (value as { code?: unknown }).code;
    if (typeof code === "string" && code.length <= 64) return code;
  }
  return status === 401 ? "auth_required" : null;
}

function noticesFor(
  envelope: PersonalTodayReadyEnvelope,
  copy: (typeof personalTodayCopy)["en"],
) {
  const notices: ProvenanceNotice[] = [];
  if (envelope.meta.readPlane.requestTimeFailed) {
    notices.push({
      key: "retained",
      tone: "warning",
      title: copy.retainedEvidence,
      detail: copy.retainedDetail,
    });
  } else if (envelope.meta.readPlane.collectedReadFailed) {
    notices.push({
      key: "current-only",
      tone: "warning",
      title: copy.currentOnly,
      detail: copy.currentOnlyDetail,
    });
  } else if (envelope.meta.freshness.state === "stale") {
    notices.push({
      key: "stale",
      tone: "warning",
      title: copy.staleEvidence,
      detail: copy.staleDetail,
    });
  } else if (envelope.meta.freshness.state !== "fresh") {
    notices.push({
      key: "unknown",
      tone: "warning",
      title: copy.unknownEvidence,
      detail: copy.unknownDetail,
    });
  } else {
    notices.push({
      key: "live",
      tone: "live",
      title: copy.liveEvidence,
      detail: copy.liveDetail,
    });
  }

  if (envelope.meta.readPlane.collectedTruncated) {
    notices.push({
      key: "bounded",
      tone: "warning",
      title: copy.boundedCoverage,
      detail: copy.boundedDetail,
    });
  }
  return notices;
}

function previousEnvelope(resource: PersonalTodayResource) {
  if (resource.phase === "ready") return resource.data;
  if (resource.phase === "loading" || resource.phase === "error") {
    return resource.previous ?? null;
  }
  return null;
}

function isReadyEnvelope(
  envelope: PersonalTodayEnvelope,
): envelope is PersonalTodayReadyEnvelope {
  return envelope.meta.status === "ready";
}

export function PersonalTodayCard({
  session,
  refreshToken,
  selectableSymbols,
  onSelectSymbol,
  onOpenInbox,
}: PersonalTodayCardProps) {
  const { locale } = useAppLocale();
  const copy = personalTodayCopy[locale];
  const [retryGeneration, setRetryGeneration] = useState(0);
  const [resource, setResource] = useState<PersonalTodayResource>({ phase: "idle" });
  const loadedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (!session.isAuthenticated) {
      loadedKeyRef.current = null;
      const reset = window.setTimeout(() => setResource({ phase: "idle" }), 0);
      return () => window.clearTimeout(reset);
    }

    const requestKey = `${refreshToken}:${retryGeneration}`;
    if (loadedKeyRef.current === requestKey) return;

    let stopped = false;
    let controller: AbortController | null = null;
    let timeout: number | undefined;
    const launch = window.setTimeout(() => {
      if (stopped || loadedKeyRef.current === requestKey) return;
      loadedKeyRef.current = requestKey;
      controller = new AbortController();
      setResource((current) => ({
        phase: "loading",
        previous: previousEnvelope(current) ?? undefined,
      }));
      timeout = window.setTimeout(() => controller?.abort("timeout"), 10_000);

      void fetch("/api/intelligence/today?limit=12", {
        cache: "no-store",
        credentials: "same-origin",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      })
        .then(async (response) => {
          let body: unknown = null;
          try {
            body = (await response.json()) as unknown;
          } catch {
            body = null;
          }
          if (stopped) return;
          if (!response.ok) {
            const code = responseCode(body, response.status);
            if (code === "auth_required") {
              loadedKeyRef.current = null;
              setResource({ phase: "error", code });
              return;
            }
            setResource((current) => ({
              phase: "error",
              code,
              previous: previousEnvelope(current) ?? undefined,
            }));
            return;
          }
          try {
            setResource({ phase: "ready", data: parsePersonalTodayEnvelope(body) });
          } catch {
            setResource((current) => ({
              phase: "error",
              code: "response_invalid",
              previous: previousEnvelope(current) ?? undefined,
            }));
          }
        })
        .catch((error: unknown) => {
          if (stopped) return;
          const timedOut =
            controller?.signal.aborted && controller.signal.reason === "timeout";
          setResource((current) => ({
            phase: "error",
            code: timedOut
              ? "request_timeout"
              : error instanceof DOMException && error.name === "AbortError"
                ? null
                : "network_error",
            previous: previousEnvelope(current) ?? undefined,
          }));
        })
        .finally(() => {
          if (timeout) window.clearTimeout(timeout);
        });
    }, 0);

    return () => {
      stopped = true;
      window.clearTimeout(launch);
      if (timeout) window.clearTimeout(timeout);
      controller?.abort();
    };
  }, [refreshToken, retryGeneration, session.isAuthenticated]);

  const verified = previousEnvelope(resource);
  const readyFeed = verified && isReadyEnvelope(verified) ? verified : null;
  const currentEvents = useMemo(
    () =>
      readyFeed?.meta.dataMode === "live"
        ? readyFeed.data.filter(
            (event) => event.isLive && event.sourceKind !== "demo_fixture",
          )
        : [],
    [readyFeed],
  );
  const displayedEvents = currentEvents.slice(0, 4);
  const trackedSymbols = useMemo(
    () => new Set<CanonicalSymbol>((readyFeed?.symbols ?? []) as CanonicalSymbol[]),
    [readyFeed],
  );
  const selectableSymbolSet = useMemo(
    () => new Set<CanonicalSymbol>(selectableSymbols),
    [selectableSymbols],
  );
  const representedSymbols = useMemo(() => {
    const represented = new Set<string>();
    for (const event of currentEvents) {
      for (const symbol of event.symbolIds) {
        if (trackedSymbols.has(symbol as CanonicalSymbol)) represented.add(symbol);
      }
    }
    return represented.size;
  }, [currentEvents, trackedSymbols]);
  const provenanceNotices = readyFeed ? noticesFor(readyFeed, copy) : [];
  const preservingVerified = Boolean(verified) && resource.phase !== "ready";
  const currentEvidenceUnavailable = Boolean(
    readyFeed?.meta.readPlane.requestTimeFailed &&
      readyFeed.meta.readPlane.origins.durable.selectedCount === 0,
  );
  const nonCurrentEvidenceOnly = Boolean(
    readyFeed && readyFeed.data.length > 0 && currentEvents.length === 0,
  );

  return (
    <section
      className={styles.card}
      aria-labelledby="personal-today-title"
      data-testid="personal-today-card"
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.icon} aria-hidden="true">
            <Newspaper size={18} />
          </span>
          <div>
            <span className={styles.eyebrow}>{copy.eyebrow}</span>
            <h2 id="personal-today-title">{copy.title}</h2>
            <p>{copy.subtitle}</p>
          </div>
        </div>
        <div className={styles.headerActions}>
          <span className={styles.noAiBadge}>
            <ShieldCheck size={13} /> {copy.noAi}
          </span>
          {session.isAuthenticated && resource.phase !== "loading" && (
            <button
              type="button"
              className={styles.iconButton}
              aria-label={copy.refresh}
              onClick={() => setRetryGeneration((current) => current + 1)}
            >
              <RefreshCw size={14} />
            </button>
          )}
        </div>
      </header>

      <div className={styles.body} aria-live="polite">
        {!session.isAuthenticated ? (
          <section className={styles.gate}>
            <span className={styles.stateIcon}><ShieldCheck size={21} /></span>
            <div>
              <strong>{copy.gateTitle}</strong>
              <p>{copy.gateBody}</p>
            </div>
            <a href={session.signInPath} target="_top">
              {copy.gateAction} <ArrowRight size={14} />
            </a>
          </section>
        ) : !verified && (resource.phase === "idle" || resource.phase === "loading") ? (
          <section className={styles.loading} role="status">
            <LoaderCircle className={styles.spinner} size={23} />
            <div>
              <strong>{copy.loadingTitle}</strong>
              <p>{copy.loadingBody}</p>
            </div>
          </section>
        ) : !verified && resource.phase === "error" ? (
          <section className={styles.error} role="alert">
            <span className={styles.errorIcon}><AlertTriangle size={20} /></span>
            <div>
              <strong>{copy.errorTitle}</strong>
              <p>{personalTodayErrorMessage(locale, resource.code)}</p>
            </div>
            {resource.code === "auth_required" ? (
              <a href="/signin-with-chatgpt?return_to=%2Fdashboard" target="_top">
                {copy.gateAction} <ArrowRight size={14} />
              </a>
            ) : (
              <button
                type="button"
                onClick={() => setRetryGeneration((current) => current + 1)}
              >
                <RefreshCw size={14} /> {copy.retry}
              </button>
            )}
          </section>
        ) : verified ? (
          <div className={styles.ready}>
            {preservingVerified && (
              <div
                className={`${styles.refreshStatus} ${resource.phase === "error" ? styles.failed : ""}`}
                role={resource.phase === "error" ? "alert" : "status"}
              >
                {resource.phase === "loading" ? (
                  <LoaderCircle className={styles.spinner} size={14} />
                ) : (
                  <AlertTriangle size={14} />
                )}
                <span>
                  <strong>
                    {resource.phase === "loading" ? copy.refresh : copy.refreshFailedTitle}
                  </strong>
                  {resource.phase === "loading"
                    ? copy.refreshing
                    : `${personalTodayErrorMessage(
                        locale,
                        resource.phase === "error" ? resource.code : null,
                      )} ${copy.refreshFailedBody}`}
                </span>
                {resource.phase === "error" && (
                  <button
                    type="button"
                    onClick={() => setRetryGeneration((current) => current + 1)}
                  >
                    <RefreshCw size={12} /> {copy.retry}
                  </button>
                )}
              </div>
            )}

            {verified.meta.status === "empty" ? (
              <section className={styles.empty}>
                <Globe2 size={21} />
                <div>
                  <strong>{copy.emptyWatchlistTitle}</strong>
                  <p>{copy.emptyWatchlistBody}</p>
                </div>
              </section>
            ) : readyFeed?.meta.dataMode === "demo" ? (
              <section className={`${styles.empty} ${styles.demo}`}>
                <AlertTriangle size={21} />
                <div>
                  <strong>{copy.demoUnavailableTitle}</strong>
                  <p>{copy.demoDetail}</p>
                </div>
              </section>
            ) : currentEvidenceUnavailable ? (
              <section className={`${styles.empty} ${styles.demo}`}>
                <AlertTriangle size={21} />
                <div>
                  <strong>{copy.currentUnavailableTitle}</strong>
                  <p>{copy.currentUnavailableBody}</p>
                </div>
              </section>
            ) : nonCurrentEvidenceOnly ? (
              <section className={`${styles.empty} ${styles.demo}`}>
                <AlertTriangle size={21} />
                <div>
                  <strong>{copy.currentUnavailableTitle}</strong>
                  <p>{copy.nonCurrentDetail}</p>
                </div>
              </section>
            ) : readyFeed && displayedEvents.length === 0 ? (
              <section className={styles.empty}>
                <Globe2 size={21} />
                <div>
                  <strong>{copy.emptyEventsTitle}</strong>
                  <p>{copy.emptyEventsBody}</p>
                </div>
              </section>
            ) : readyFeed ? (
              <>
                <div className={styles.summary}>
                  <div>
                    <strong>{copy.eventsShown(displayedEvents.length, currentEvents.length)}</strong>
                    <span>{copy.symbolCoverage(representedSymbols, readyFeed.symbols.length)}</span>
                  </div>
                  <span>
                    <Clock3 size={12} />{" "}
                    {copy.asOf(
                      formatTimestamp(
                        readyFeed.meta.freshness.asOf ?? readyFeed.meta.generatedAt,
                        copy.dateLocale,
                        copy.timeUnavailable,
                      ),
                    )}
                  </span>
                </div>

                <div className={styles.provenance} aria-label={copy.provenanceLabel}>
                  {provenanceNotices.map((notice) => (
                    <div className={styles[notice.tone]} key={notice.key} role="status">
                      {notice.tone === "live" ? (
                        <ShieldCheck size={14} />
                      ) : (
                        <AlertTriangle size={14} />
                      )}
                      <span><strong>{notice.title}</strong>{notice.detail}</span>
                    </div>
                  ))}
                </div>

                <div className={styles.eventGrid}>
                  {displayedEvents.map((event) => {
                    const eventSymbols = event.symbolIds.filter((symbol) =>
                      trackedSymbols.has(symbol as CanonicalSymbol),
                    );
                    return (
                      <article className={styles.event} key={event.id}>
                        <div className={styles.eventMeta}>
                          <div className={styles.symbols}>
                            {eventSymbols.map((symbol) => {
                              const ticker = tickerFromSymbol(symbol);
                              return selectableSymbolSet.has(symbol as CanonicalSymbol) ? (
                                <button
                                  type="button"
                                  key={symbol}
                                  aria-label={copy.selectSymbol(ticker)}
                                  onClick={() => onSelectSymbol(symbol as CanonicalSymbol)}
                                >
                                  {ticker}
                                </button>
                              ) : (
                                <span key={symbol}>{ticker}</span>
                              );
                            })}
                          </div>
                          <span className={`${styles.materiality} ${styles[event.materiality]}`}>
                            {copy.materiality[event.materiality]}
                          </span>
                        </div>
                        <h3>{event.headline}</h3>
                        {event.summary && <p>{event.summary}</p>}
                        <div className={styles.eventTruth}>
                          <span>{event.source}</span>
                          <span>
                            {formatTimestamp(
                              event.publishedAt,
                              copy.dateLocale,
                              copy.timeUnavailable,
                            )}
                          </span>
                          {event.claimStatus === "corrected" && (
                            <span className={styles.corrected}>{copy.corrected}</span>
                          )}
                          {event.isControversial && (
                            <span className={styles.controversial}>{copy.controversial}</span>
                          )}
                        </div>
                        <div className={styles.eventAction}>
                          {event.sourceUrl ? (
                            <a
                              href={event.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`${copy.openSource}: ${event.headline}`}
                            >
                              {copy.openSource} <ExternalLink size={11} />
                            </a>
                          ) : (
                            <span>{copy.sourceUnavailable}</span>
                          )}
                        </div>
                      </article>
                    );
                  })}
                </div>
              </>
            ) : null}

            <footer className={styles.footer}>
              <div>
                <p>{copy.sourceTextBoundary}</p>
                <p>{copy.researchBoundary}</p>
              </div>
              <button type="button" onClick={onOpenInbox}>
                {copy.openInbox} <ArrowRight size={13} />
              </button>
            </footer>
          </div>
        ) : null}
      </div>
    </section>
  );
}
