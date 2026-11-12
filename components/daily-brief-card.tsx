"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BookOpenText,
  CheckCircle2,
  Clock3,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import {
  parseDailyBriefEnvelope,
  type DailyBriefEnvelope,
} from "@/lib/ai/daily-brief-contract";
import { useAppLocale } from "@/components/app-locale";
import {
  dailyBriefCopy,
  dailyBriefErrorMessage,
} from "@/components/daily-brief-copy";
import styles from "./daily-brief-card.module.css";

export type DailyBriefCardSession =
  | { isAuthenticated: false; signInPath: string }
  | { isAuthenticated: true; signInPath?: never };

interface DailyBriefCardProps {
  session: DailyBriefCardSession;
}

type DailyBriefResource =
  | { phase: "idle" | "loading"; data?: undefined; error?: undefined }
  | {
      phase: "ready";
      locale: "en" | "zh-CN";
      data: DailyBriefEnvelope;
      error?: undefined;
    }
  | {
      phase: "error";
      data?: undefined;
      code: string | null;
      retryMode: "new_request" | "same_request";
      retryAt: string | null;
      retryBlocked: boolean;
    };

function formatTimestamp(
  value: string,
  dateLocale: string,
  unavailable: string,
) {
  if (!Number.isFinite(Date.parse(value))) return unavailable;
  return new Intl.DateTimeFormat(dateLocale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatSymbol(symbolId: string) {
  return symbolId.split(":").at(-1) ?? symbolId;
}

function validTimestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

function retryTimestampFromSeconds(value: unknown) {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(Date.now() + Math.ceil(seconds) * 1_000).toISOString()
    : null;
}

function responseError(value: unknown, response: Response) {
  const headerRetryAt = validTimestamp(
    response.headers.get("X-Omnigaze-AI-Budget-Retry-At"),
  );
  const headerRetryAfter = retryTimestampFromSeconds(
    response.headers.get("Retry-After"),
  );
  if (!value || typeof value !== "object") {
    return {
      code: null,
      retryAt: headerRetryAt ?? headerRetryAfter,
    };
  }
  const candidate = value as {
    error?: unknown;
    code?: unknown;
    retryAt?: unknown;
    retry_at?: unknown;
    retryAfterSeconds?: unknown;
  };
  return {
    code: typeof candidate.code === "string" ? candidate.code : null,
    retryAt:
      headerRetryAt ??
      validTimestamp(candidate.retryAt) ??
      validTimestamp(candidate.retry_at) ??
      retryTimestampFromSeconds(candidate.retryAfterSeconds) ??
      headerRetryAfter,
  };
}

export function DailyBriefCard({ session }: DailyBriefCardProps) {
  const { locale } = useAppLocale();
  const copy = dailyBriefCopy[locale];
  const [resource, setResource] = useState<DailyBriefResource>({ phase: "idle" });
  const controllerRef = useRef<AbortController | null>(null);
  const requestNonceRef = useRef(0);
  const inFlightRef = useRef(false);
  const uncertainRequestIdRef = useRef<string | null>(null);

  const cancelRequest = useCallback(() => {
    requestNonceRef.current += 1;
    controllerRef.current?.abort();
    controllerRef.current = null;
    inFlightRef.current = false;
    uncertainRequestIdRef.current = null;
  }, []);

  const loadBrief = useCallback(
    async (attemptMode: "new_request" | "same_request" = "new_request") => {
      if (!session.isAuthenticated || inFlightRef.current) return;

      inFlightRef.current = true;
      const controller = new AbortController();
      controllerRef.current = controller;
      const requestNonce = ++requestNonceRef.current;
      const requestId =
        attemptMode === "same_request" && uncertainRequestIdRef.current
          ? uncertainRequestIdRef.current
          : crypto.randomUUID();
      uncertainRequestIdRef.current = null;
      setResource({ phase: "loading" });

      let receivedResponse = false;
      let timedOut = false;
      const timeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, 45_000);

      try {
        const response = await fetch("/api/ai/daily-brief", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ request_id: requestId, locale }),
          signal: controller.signal,
        });

        let body: unknown;
        try {
          body = (await response.json()) as unknown;
        } catch (error) {
          if (controller.signal.aborted) throw error;
          body = null;
        }
        receivedResponse = true;
        if (requestNonce !== requestNonceRef.current) return;

        if (!response.ok) {
          const failure = responseError(body, response);
          uncertainRequestIdRef.current = null;
          setResource({
            phase: "error",
            code: failure.code,
            retryMode: "new_request",
            retryAt: failure.retryAt,
            retryBlocked:
              failure.retryAt !== null && Date.parse(failure.retryAt) > Date.now(),
          });
          return;
        }

        let parsed: DailyBriefEnvelope;
        try {
          parsed = parseDailyBriefEnvelope(body);
        } catch {
          throw new Error("response_invalid");
        }
        uncertainRequestIdRef.current = null;
        setResource({ phase: "ready", locale, data: parsed });
      } catch {
        if (requestNonce !== requestNonceRef.current) return;
        if (controller.signal.aborted && !timedOut) return;

        const uncertainOutcome = !receivedResponse;
        uncertainRequestIdRef.current = uncertainOutcome ? requestId : null;
        setResource({
          phase: "error",
          code: timedOut
            ? "request_timeout"
            : receivedResponse
              ? "response_invalid"
              : "network_error",
          retryMode: uncertainOutcome ? "same_request" : "new_request",
          retryAt: null,
          retryBlocked: false,
        });
      } finally {
        window.clearTimeout(timeout);
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          inFlightRef.current = false;
        }
      }
    },
    [locale, session.isAuthenticated],
  );

  useEffect(() => () => cancelRequest(), [cancelRequest]);

  useEffect(() => {
    cancelRequest();
    const reset = window.setTimeout(() => setResource({ phase: "idle" }), 0);
    return () => window.clearTimeout(reset);
  }, [cancelRequest, locale, session.isAuthenticated]);

  const blockedRetryAt =
    resource.phase === "error" && resource.retryBlocked ? resource.retryAt : null;

  useEffect(() => {
    if (!blockedRetryAt) return;
    const remainingMs = Date.parse(blockedRetryAt) - Date.now();
    const timer = window.setTimeout(
      () => {
        setResource((current) =>
          current.phase === "error" && current.retryAt === blockedRetryAt
            ? { ...current, retryBlocked: false }
            : current,
        );
      },
      Math.max(0, Math.min(remainingMs + 100, 2_147_483_647)),
    );
    return () => window.clearTimeout(timer);
  }, [blockedRetryAt]);

  const ready =
    resource.phase === "ready" && resource.locale === locale
      ? resource.data
      : null;
  const citationsById = useMemo(
    () => new Map(ready?.meta.citations.map((citation) => [citation.id, citation]) ?? []),
    [ready],
  );

  return (
    <section
      className={styles.card}
      aria-labelledby="daily-brief-title"
      data-testid="daily-brief-card"
    >
      <header className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.icon} aria-hidden="true">
            <BookOpenText size={18} />
          </span>
          <div>
            <span className={styles.eyebrow}>{copy.eyebrow}</span>
            <h2 id="daily-brief-title">{copy.title}</h2>
            <p>{copy.subtitle}</p>
          </div>
        </div>
        <div className={styles.manualBadge}>
          <ShieldCheck size={13} /> {copy.manualOnly}
        </div>
      </header>

      <div className={styles.body} aria-live="polite">
        {!session.isAuthenticated ? (
          <section className={styles.gate}>
            <div className={styles.stateIcon}><ShieldCheck size={21} /></div>
            <div>
              <strong>{copy.gateTitle}</strong>
              <p>{copy.gateBody}</p>
            </div>
            <a href={session.signInPath} target="_top">
              {copy.gateAction} <ArrowRight size={14} />
            </a>
          </section>
        ) : resource.phase === "idle" ? (
          <section className={styles.idle}>
            <div>
              <span className={styles.kicker}><Sparkles size={13} /> {copy.readyKicker}</span>
              <strong>{copy.readyTitle}</strong>
              <p>{copy.readyBody}</p>
            </div>
            <button type="button" onClick={() => void loadBrief("new_request")}>
              <Sparkles size={15} /> {copy.buildAction}
            </button>
            <small>{copy.manualRequestNote}</small>
          </section>
        ) : resource.phase === "loading" ? (
          <section className={styles.loading} role="status">
            <LoaderCircle className={styles.spinner} size={24} />
            <div>
              <strong>{copy.loadingTitle}</strong>
              <p>{copy.loadingBody}</p>
            </div>
          </section>
        ) : resource.phase === "error" ? (
          <section className={styles.error} role="alert">
            <div className={styles.errorIcon}><AlertTriangle size={21} /></div>
            <div>
              <strong>{copy.unavailableTitle}</strong>
              <p>{dailyBriefErrorMessage(locale, resource.code)}</p>
              {resource.code === "ai_rate_limited" && (
                <p className={styles.rateLimitCopy}>
                  {copy.rateLimitExplanation}
                </p>
              )}
              {resource.retryAt && (
                <small className={styles.retryNotice}>
                  {copy.retryAt(
                    formatTimestamp(
                      resource.retryAt,
                      copy.dateLocale,
                      copy.timeUnavailable,
                    ),
                  )}
                </small>
              )}
              {resource.code === "auth_required" ? (
                <a href="/signin-with-chatgpt?return_to=%2Fdashboard" target="_top">
                  {copy.signInAgain} <ArrowRight size={14} />
                </a>
              ) : (
                <button
                  type="button"
                  disabled={resource.retryBlocked}
                  onClick={() => void loadBrief(resource.retryMode)}
                >
                  <RefreshCw size={14} />
                  {resource.retryMode === "same_request"
                    ? copy.resumeSafely
                    : copy.tryNew}
                </button>
              )}
            </div>
          </section>
        ) : ready ? (
          <div className={styles.ready}>
            <section className={styles.hero}>
              <div className={styles.heroCopy}>
                <div className={styles.asOf}>
                  <span><CheckCircle2 size={12} /> {copy.liveEvidence}</span>
                  <span><Clock3 size={12} /> {copy.asOf(formatTimestamp(ready.meta.freshness.asOf, copy.dateLocale, copy.timeUnavailable))}</span>
                </div>
                <h3>{ready.data.headline}</h3>
                <p>{ready.data.summary}</p>
              </div>
              <div className={styles.coverageScore}>
                <strong>{Math.round(ready.meta.evidenceCoverage.score * 100)}%</strong>
                <span>{copy.evidenceCoverage}</span>
                <small>{copy.coverage[ready.meta.evidenceCoverage.label]} · {copy.notInvestmentConfidence}</small>
              </div>
            </section>

            <section className={styles.truthStrip} aria-label={copy.provenanceLabel}>
              <div>
                <span>{copy.watchlistCoverage}</span>
                <strong>{copy.symbolCoverage(ready.meta.includedSymbolCount, ready.meta.trackedSymbolCount)}</strong>
                <small>{copy.omittedSymbols(ready.meta.omittedSymbolCount)}</small>
              </div>
              <div>
                <span>{copy.evidence}</span>
                <strong>{copy.evidenceSummary(ready.meta.evidenceCount, ready.meta.sourceCount)}</strong>
                <small>{copy.providerCoverageSummary(copy.providerCoverage[ready.meta.providerCoverage])}</small>
              </div>
              <div>
                <span>{copy.aiRequest}</span>
                <strong>
                  {ready.meta.cache.state === "generated"
                    ? copy.cacheGenerated
                    : ready.meta.cache.state === "deduplicated"
                      ? copy.cacheDeduplicated
                      : copy.cacheHit}
                </strong>
                <small>
                  {ready.meta.budget.consumed
                    ? copy.requestsRemain(
                        ready.meta.budget.remaining,
                        ready.meta.budget.limit,
                        formatTimestamp(ready.meta.budget.resetsAt, copy.dateLocale, copy.timeUnavailable),
                      )
                    : copy.noAdditionalRequest}
                </small>
              </div>
            </section>

            <section className={styles.section} aria-labelledby="daily-developments-title">
              <div className={styles.sectionHeading}>
                <div>
                  <span>{copy.developmentsEyebrow}</span>
                  <h3 id="daily-developments-title">{copy.developmentsTitle}</h3>
                </div>
                <small>{copy.citedThemes(ready.data.developments.length)}</small>
              </div>
              <div className={styles.developmentGrid}>
                {ready.data.developments.map((development) => (
                  <article key={`${development.title}-${development.evidenceIds.join("-")}`}>
                    <div className={styles.developmentMeta}>
                      <div className={styles.symbols}>
                        {development.symbolIds.map((symbolId) => (
                          <span key={symbolId}>{formatSymbol(symbolId)}</span>
                        ))}
                      </div>
                      <span className={`${styles.direction} ${styles[development.direction]}`}>
                        {copy.direction[development.direction]}
                      </span>
                    </div>
                    <h4>{development.title}</h4>
                    <p>{development.whyItMatters}</p>
                    <ul className={styles.evidenceLinks} aria-label={copy.sourcesFor(development.title)}>
                      {development.evidenceIds.map((evidenceId) => {
                        const citation = citationsById.get(evidenceId);
                        return (
                          <li key={evidenceId}>
                            {citation?.url ? (
                              <a href={citation.url} target="_blank" rel="noreferrer">
                                {citation.publisher} <ExternalLink size={11} />
                              </a>
                            ) : (
                              <span>{citation?.publisher ?? copy.verifiedEvidence}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </article>
                ))}
              </div>
            </section>

            <div className={styles.followUpGrid}>
              <section>
                <span>{copy.watchNext}</span>
                <ul>{ready.data.watchNext.map((item) => <li key={item}>{item}</li>)}</ul>
              </section>
              <section>
                <span>{copy.unknowns}</span>
                <ul>{ready.data.unknowns.map((item) => <li key={item}>{item}</li>)}</ul>
              </section>
            </div>

            <details className={styles.sources}>
              <summary>
                {copy.inspectSources(ready.meta.evidenceCount)}
                <span>{copy.omittedTrackedSymbols(ready.meta.omittedSymbolCount)}</span>
              </summary>
              <ul>
                {ready.meta.citations.map((citation) => (
                  <li key={citation.id}>
                    <div>
                      <strong>{citation.title}</strong>
                      <span>{citation.publisher} · {formatTimestamp(citation.publishedAt, copy.dateLocale, copy.timeUnavailable)}</span>
                    </div>
                    {citation.url && (
                      <a href={citation.url} target="_blank" rel="noreferrer" aria-label={copy.openSource(citation.title)}>
                        <ExternalLink size={14} />
                      </a>
                    )}
                  </li>
                ))}
              </ul>
            </details>

            <footer className={styles.footer}>
              <div>
                <ShieldCheck size={14} />
                <p>{copy.disclaimer}</p>
              </div>
              <p>
                {copy.synthesisBoundary}
              </p>
              <button type="button" onClick={() => void loadBrief("new_request")}>
                <RefreshCw size={13} /> {copy.refresh}
              </button>
            </footer>
          </div>
        ) : null}
      </div>
    </section>
  );
}
