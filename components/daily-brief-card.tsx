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
import styles from "./daily-brief-card.module.css";

export type DailyBriefCardSession =
  | { isAuthenticated: false; signInPath: string }
  | { isAuthenticated: true; signInPath?: never };

interface DailyBriefCardProps {
  session: DailyBriefCardSession;
}

type DailyBriefResource =
  | { phase: "idle" | "loading"; data?: undefined; error?: undefined }
  | { phase: "ready"; data: DailyBriefEnvelope; error?: undefined }
  | {
      phase: "error";
      data?: undefined;
      error: string;
      code: string | null;
      retryMode: "new_request" | "same_request";
      retryAt: string | null;
      retryBlocked: boolean;
    };

const directionLabel = {
  positive: "Positive",
  negative: "Negative",
  mixed: "Mixed",
  unclear: "Unclear",
} as const;

function formatTimestamp(value: string) {
  if (!Number.isFinite(Date.parse(value))) return "Time unavailable";
  return new Intl.DateTimeFormat("en-US", {
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
  const fallback = "Your Daily Brief is temporarily unavailable.";
  const headerRetryAt = validTimestamp(
    response.headers.get("X-Omnigaze-AI-Budget-Retry-At"),
  );
  const headerRetryAfter = retryTimestampFromSeconds(
    response.headers.get("Retry-After"),
  );
  if (!value || typeof value !== "object") {
    return {
      message: fallback,
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
    message:
      typeof candidate.error === "string" && candidate.error.trim()
        ? candidate.error
        : fallback,
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
          body: JSON.stringify({ request_id: requestId }),
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
            error: failure.message,
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
          throw new Error(
            "The Daily Brief response failed its integrity checks. Please try again.",
          );
        }
        uncertainRequestIdRef.current = null;
        setResource({ phase: "ready", data: parsed });
      } catch (error) {
        if (requestNonce !== requestNonceRef.current) return;
        if (controller.signal.aborted && !timedOut) return;

        const uncertainOutcome = !receivedResponse;
        uncertainRequestIdRef.current = uncertainOutcome ? requestId : null;
        setResource({
          phase: "error",
          code: timedOut ? "request_timeout" : null,
          retryMode: uncertainOutcome ? "same_request" : "new_request",
          retryAt: null,
          retryBlocked: false,
          error: timedOut
            ? "The brief timed out before a verified result was ready."
            : error instanceof Error
              ? error.message
              : "Your Daily Brief is temporarily unavailable.",
        });
      } finally {
        window.clearTimeout(timeout);
        if (controllerRef.current === controller) {
          controllerRef.current = null;
          inFlightRef.current = false;
        }
      }
    },
    [session.isAuthenticated],
  );

  useEffect(() => () => cancelRequest(), [cancelRequest]);

  useEffect(() => {
    cancelRequest();
    const reset = window.setTimeout(() => setResource({ phase: "idle" }), 0);
    return () => window.clearTimeout(reset);
  }, [cancelRequest, session.isAuthenticated]);

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

  const ready = resource.phase === "ready" ? resource.data : null;
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
            <span className={styles.eyebrow}>PERSONAL MARKET INTELLIGENCE</span>
            <h2 id="daily-brief-title">Daily Brief</h2>
            <p>One cited read across the companies you track.</p>
          </div>
        </div>
        <div className={styles.manualBadge}>
          <ShieldCheck size={13} /> Manual only
        </div>
      </header>

      <div className={styles.body} aria-live="polite">
        {!session.isAuthenticated ? (
          <section className={styles.gate}>
            <div className={styles.stateIcon}><ShieldCheck size={21} /></div>
            <div>
              <strong>Sign in to brief your watchlist</strong>
              <p>
                Your brief uses only your saved symbols and fresh, cited market
                evidence. It never runs in the background.
              </p>
            </div>
            <a href={session.signInPath} target="_top">
              Sign in for Daily Brief <ArrowRight size={14} />
            </a>
          </section>
        ) : resource.phase === "idle" ? (
          <section className={styles.idle}>
            <div>
              <span className={styles.kicker}><Sparkles size={13} /> Ready when you are</span>
              <strong>Turn today’s evidence into a clear market read.</strong>
              <p>
                Omnigaze checks fresh evidence across your tracked companies,
                explains the important developments, and links every included
                development to its evidence.
              </p>
            </div>
            <button type="button" onClick={() => void loadBrief("new_request")}>
              <Sparkles size={15} /> Build my Daily Brief
            </button>
            <small>Starts one explicit AI request. No scheduled or background generation.</small>
          </section>
        ) : resource.phase === "loading" ? (
          <section className={styles.loading} role="status">
            <LoaderCircle className={styles.spinner} size={24} />
            <div>
              <strong>Building your evidence-backed brief</strong>
              <p>Checking watchlist coverage, freshness, and citation integrity.</p>
            </div>
          </section>
        ) : resource.phase === "error" ? (
          <section className={styles.error} role="alert">
            <div className={styles.errorIcon}><AlertTriangle size={21} /></div>
            <div>
              <strong>Daily Brief unavailable</strong>
              <p>{resource.error}</p>
              {resource.code === "ai_rate_limited" && (
                <p className={styles.rateLimitCopy}>
                  AI usage is temporarily at its limit. This budget manages model
                  requests—it is not investment confidence or a market signal.
                </p>
              )}
              {resource.retryAt && (
                <small className={styles.retryNotice}>
                  New model requests reset around {formatTimestamp(resource.retryAt)}.
                </small>
              )}
              {resource.code === "auth_required" ? (
                <a href="/signin-with-chatgpt?return_to=%2Fdashboard" target="_top">
                  Sign in again <ArrowRight size={14} />
                </a>
              ) : (
                <button
                  type="button"
                  disabled={resource.retryBlocked}
                  onClick={() => void loadBrief(resource.retryMode)}
                >
                  <RefreshCw size={14} />
                  {resource.retryMode === "same_request"
                    ? "Resume brief safely"
                    : "Try a new brief"}
                </button>
              )}
            </div>
          </section>
        ) : ready ? (
          <div className={styles.ready}>
            <section className={styles.hero}>
              <div className={styles.heroCopy}>
                <div className={styles.asOf}>
                  <span><CheckCircle2 size={12} /> Live evidence</span>
                  <span><Clock3 size={12} /> As of {formatTimestamp(ready.meta.freshness.asOf)}</span>
                </div>
                <h3>{ready.data.headline}</h3>
                <p>{ready.data.summary}</p>
              </div>
              <div className={styles.coverageScore}>
                <strong>{Math.round(ready.meta.evidenceCoverage.score * 100)}%</strong>
                <span>evidence coverage</span>
                <small>{ready.meta.evidenceCoverage.label} · not investment confidence</small>
              </div>
            </section>

            <section className={styles.truthStrip} aria-label="Brief provenance and usage">
              <div>
                <span>WATCHLIST COVERAGE</span>
                <strong>{ready.meta.includedSymbolCount} of {ready.meta.trackedSymbolCount} symbols</strong>
                <small>{ready.meta.omittedSymbolCount} not represented in this bounded brief</small>
              </div>
              <div>
                <span>EVIDENCE</span>
                <strong>{ready.meta.evidenceCount} citations · {ready.meta.sourceCount} sources</strong>
                <small>{ready.meta.providerCoverage} provider coverage</small>
              </div>
              <div>
                <span>AI REQUEST</span>
                <strong>
                  {ready.meta.cache.state === "generated"
                    ? "New analysis generated"
                    : ready.meta.cache.state === "deduplicated"
                      ? "Joined an in-progress request"
                      : "Verified cached brief reused"}
                </strong>
                <small>
                  {ready.meta.budget.consumed
                    ? `${ready.meta.budget.remaining} of ${ready.meta.budget.limit} requests remain until ${formatTimestamp(ready.meta.budget.resetsAt)}`
                    : "No additional model request used"}
                </small>
              </div>
            </section>

            <section className={styles.section} aria-labelledby="daily-developments-title">
              <div className={styles.sectionHeading}>
                <div>
                  <span>TODAY’S DEVELOPMENTS</span>
                  <h3 id="daily-developments-title">What changed across your watchlist</h3>
                </div>
                <small>{ready.data.developments.length} cited themes</small>
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
                        {directionLabel[development.direction]}
                      </span>
                    </div>
                    <h4>{development.title}</h4>
                    <p>{development.whyItMatters}</p>
                    <ul className={styles.evidenceLinks} aria-label={`Sources for ${development.title}`}>
                      {development.evidenceIds.map((evidenceId) => {
                        const citation = citationsById.get(evidenceId);
                        return (
                          <li key={evidenceId}>
                            {citation?.url ? (
                              <a href={citation.url} target="_blank" rel="noreferrer">
                                {citation.publisher} <ExternalLink size={11} />
                              </a>
                            ) : (
                              <span>{citation?.publisher ?? "Verified evidence"}</span>
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
                <span>WATCH NEXT</span>
                <ul>{ready.data.watchNext.map((item) => <li key={item}>{item}</li>)}</ul>
              </section>
              <section>
                <span>WHAT REMAINS UNKNOWN</span>
                <ul>{ready.data.unknowns.map((item) => <li key={item}>{item}</li>)}</ul>
              </section>
            </div>

            <details className={styles.sources}>
              <summary>
                Inspect {ready.meta.evidenceCount} cited sources
                <span>{ready.meta.omittedSymbolCount} tracked symbol{ready.meta.omittedSymbolCount === 1 ? "" : "s"} omitted</span>
              </summary>
              <ul>
                {ready.meta.citations.map((citation) => (
                  <li key={citation.id}>
                    <div>
                      <strong>{citation.title}</strong>
                      <span>{citation.publisher} · {formatTimestamp(citation.publishedAt)}</span>
                    </div>
                    {citation.url && (
                      <a href={citation.url} target="_blank" rel="noreferrer" aria-label={`Open source: ${citation.title}`}>
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
                <p>{ready.meta.disclaimer}</p>
              </div>
              <p>
                Evidence synthesis is not a return probability, recommendation, or
                substitute for your own research.
              </p>
              <button type="button" onClick={() => void loadBrief("new_request")}>
                <RefreshCw size={13} /> Refresh brief
              </button>
            </footer>
          </div>
        ) : null}
      </div>
    </section>
  );
}
