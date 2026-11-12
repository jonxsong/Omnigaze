"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  Clock3,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  parseOmnigazeViewEnvelope,
  type OmnigazeViewEnvelope,
} from "@/lib/ai/omnigaze-view-client-contract";
import styles from "./omnigaze-view-dialog.module.css";

export interface OmnigazeViewDialogInstrument {
  id: CanonicalSymbol;
  ticker: string;
  name: string;
}

export type OmnigazeViewDialogSession =
  | { isAuthenticated: false; signInPath: string }
  | { isAuthenticated: true; signInPath?: never };

interface OmnigazeViewDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  instrument: OmnigazeViewDialogInstrument;
  session: OmnigazeViewDialogSession;
}

type ViewResource =
  | { phase: "idle" | "loading"; key: string; data?: undefined; error?: undefined }
  | { phase: "ready"; key: string; data: OmnigazeViewEnvelope; error?: undefined }
  | {
      phase: "error";
      key: string;
      data?: undefined;
      error: string;
      code: string | null;
      retryMode: "new_request" | "same_request";
      retryAt: string | null;
      retryBlocked: boolean;
    };

const stanceLabel = {
  bullish: "Constructive",
  bearish: "Cautious",
  mixed: "Mixed",
  neutral: "Neutral",
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

function responseError(value: unknown, fallback: string, response: Response) {
  if (!value || typeof value !== "object") {
    return {
      message: fallback,
      code: null,
      retryAt: validTimestamp(
        response.headers.get("X-Omnigaze-AI-Budget-Retry-At"),
      ),
    };
  }
  const candidate = value as {
    error?: unknown;
    code?: unknown;
    retryAt?: unknown;
    retry_at?: unknown;
  };
  return {
    message:
      typeof candidate.error === "string" && candidate.error.trim()
        ? candidate.error
        : fallback,
    code: typeof candidate.code === "string" ? candidate.code : null,
    retryAt:
      validTimestamp(response.headers.get("X-Omnigaze-AI-Budget-Retry-At")) ??
      validTimestamp(candidate.retryAt) ??
      validTimestamp(candidate.retry_at),
  };
}

function validTimestamp(value: unknown) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

export function OmnigazeViewDialog({
  open,
  onOpenChange,
  instrument,
  session,
}: OmnigazeViewDialogProps) {
  const resourceKey = instrument.id;
  const [resource, setResource] = useState<ViewResource>({
    phase: "idle",
    key: resourceKey,
  });
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

  const loadView = useCallback(async (
    attemptMode: "new_request" | "same_request" = "new_request",
  ) => {
    if (!session.isAuthenticated || inFlightRef.current) return;
    inFlightRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    const requestNonce = ++requestNonceRef.current;
    const key = instrument.id;
    const requestId =
      attemptMode === "same_request" && uncertainRequestIdRef.current
        ? uncertainRequestIdRef.current
        : crypto.randomUUID();
    uncertainRequestIdRef.current = null;
    setResource({ phase: "loading", key });

    let timedOut = false;
    let receivedResponse = false;
    const timeout = window.setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 30_000);
    try {
      const response = await fetch("/api/ai/analyze", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          symbol_id: instrument.id,
          request_id: requestId,
        }),
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
        const failure = responseError(
          body,
          "The Omnigaze View is temporarily unavailable.",
          response,
        );
        uncertainRequestIdRef.current = null;
        setResource({
          phase: "error",
          key,
          error: failure.message,
          code: failure.code,
          retryMode: "new_request",
          retryAt: failure.retryAt,
          retryBlocked:
            failure.retryAt !== null && Date.parse(failure.retryAt) > Date.now(),
        });
        return;
      }
      const parsed = parseOmnigazeViewEnvelope(body);
      if (parsed.meta.symbolId !== instrument.id) {
        throw new Error("The returned analysis did not match this stock.");
      }
      uncertainRequestIdRef.current = null;
      setResource({ phase: "ready", key, data: parsed });
    } catch (error) {
      if (requestNonce !== requestNonceRef.current) {
        return;
      }
      if (controller.signal.aborted && !timedOut) return;
      const uncertainOutcome = !receivedResponse;
      uncertainRequestIdRef.current = uncertainOutcome ? requestId : null;
      setResource({
        phase: "error",
        key,
        code: timedOut ? "request_timeout" : null,
        retryMode: uncertainOutcome ? "same_request" : "new_request",
        retryAt: null,
        retryBlocked: false,
        error: timedOut
          ? "Analysis timed out before a verified view was ready. Try again."
          : error instanceof Error
            ? error.message
            : "The Omnigaze View is temporarily unavailable.",
      });
    } finally {
      window.clearTimeout(timeout);
      if (controllerRef.current === controller) {
        controllerRef.current = null;
        inFlightRef.current = false;
      }
    }
  }, [instrument.id, session.isAuthenticated]);

  useEffect(() => {
    if (open) return;
    cancelRequest();
    const reset = window.setTimeout(() => {
      setResource((current) =>
        current.phase === "loading"
          ? { phase: "idle", key: current.key }
          : current,
      );
    }, 0);
    return () => window.clearTimeout(reset);
  }, [cancelRequest, open]);

  useEffect(() => {
    cancelRequest();
  }, [cancelRequest, resourceKey]);

  useEffect(() => () => cancelRequest(), [cancelRequest]);

  const blockedRetryAt =
    resource.key === resourceKey &&
    resource.phase === "error" &&
    resource.retryBlocked
      ? resource.retryAt
      : null;

  useEffect(() => {
    if (!blockedRetryAt) return;
    const remainingMs = Date.parse(blockedRetryAt) - Date.now();
    const timer = window.setTimeout(
      () => {
        setResource((current) =>
          current.key === resourceKey &&
          current.phase === "error" &&
          current.retryAt === blockedRetryAt
            ? { ...current, retryBlocked: false }
            : current,
        );
      },
      Math.max(0, Math.min(remainingMs + 100, 2_147_483_647)),
    );
    return () => window.clearTimeout(timer);
  }, [blockedRetryAt, resourceKey]);

  const visibleResource = resource.key === resourceKey
    ? resource
    : ({ phase: "idle", key: resourceKey } as ViewResource);
  const ready = visibleResource.phase === "ready" ? visibleResource.data : null;
  const citationsById = useMemo(
    () => new Map(ready?.meta.citations.map((item) => [item.id, item]) ?? []),
    [ready],
  );

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          cancelRequest();
          setResource((current) =>
            current.phase === "loading"
              ? { phase: "idle", key: current.key }
              : current,
          );
        }
        onOpenChange(nextOpen);
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <DialogPrimitive.Content
          className={styles.dialog}
          aria-describedby="omnigaze-view-description"
          data-testid="omnigaze-view-dialog"
        >
          <header className={styles.header}>
            <div className={styles.identity}>
              <span aria-hidden="true">{instrument.ticker[0]}</span>
              <div>
                <small>LIVE OMNIGAZE VIEW</small>
                <DialogPrimitive.Title>
                  {instrument.ticker} intelligence
                </DialogPrimitive.Title>
                <p id="omnigaze-view-description">{instrument.name}</p>
              </div>
            </div>
            <DialogPrimitive.Close className={styles.closeButton}>
              <X size={18} />
              <span className="sr-only">Close Omnigaze View</span>
            </DialogPrimitive.Close>
          </header>

          <div className={styles.body} aria-live="polite">
            {!session.isAuthenticated ? (
              <section className={styles.gateCard}>
                <ShieldCheck size={25} />
                <div>
                  <strong>Sign in for a live evidence-backed view</strong>
                  <p>
                    Omnigaze verifies the stock, evidence freshness, and citation set
                    before asking the model to interpret anything.
                  </p>
                  <a href={session.signInPath} target="_top">
                    Sign in to analyze <ArrowRight size={14} />
                  </a>
                </div>
              </section>
            ) : visibleResource.phase === "idle" ? (
              <section className={styles.idleState}>
                <Sparkles size={27} />
                <strong>Generate a fresh Omnigaze View</strong>
                <p>
                  This starts one AI analysis using only currently verified, fresh
                  provider evidence. It will not run until you ask.
                </p>
                <button
                  type="button"
                  onClick={() => void loadView("new_request")}
                >
                  <Sparkles size={14} /> Analyze live evidence
                </button>
              </section>
            ) : visibleResource.phase === "loading" ? (
              <section className={styles.loadingState} role="status">
                <LoaderCircle className={styles.spinner} size={28} />
                <strong>Building a grounded view</strong>
                <p>Verifying live evidence, freshness, and citation integrity.</p>
              </section>
            ) : visibleResource.phase === "error" ? (
              <section className={styles.errorState} role="alert">
                <AlertTriangle size={24} />
                <div>
                  <strong>View unavailable</strong>
                  <p>{visibleResource.error}</p>
                  {visibleResource.retryAt && (
                    <small className={styles.retryNotice}>
                      Usage becomes available again around {formatTimestamp(visibleResource.retryAt)}.
                      This limit controls model requests, not investment confidence.
                    </small>
                  )}
                  {visibleResource.code === "auth_required" ? (
                    <a href="/dashboard" target="_top">
                      Sign in again <ArrowRight size={14} />
                    </a>
                  ) : (
                    <button
                      type="button"
                      disabled={visibleResource.retryBlocked}
                      onClick={() => void loadView(visibleResource.retryMode)}
                    >
                      <RefreshCw size={14} />
                      {visibleResource.retryMode === "same_request"
                        ? "Resume request safely"
                        : "Try a new analysis"}
                    </button>
                  )}
                </div>
              </section>
            ) : ready ? (
              <>
                <section className={styles.hero}>
                  <div>
                    <span className={`${styles.stance} ${styles[ready.data.stance]}`}>
                      {stanceLabel[ready.data.stance]}
                    </span>
                    <small>
                      <Clock3 size={12} />
                      {ready.meta.ai?.source === "cache" ? "Cached view from" : "Generated"}{" "}
                      {formatTimestamp(ready.meta.generatedAt)}
                    </small>
                    <h2>{ready.data.headline}</h2>
                    <p>{ready.data.summary}</p>
                  </div>
                  <div className={styles.confidenceGrid}>
                    <div>
                      <strong>{Math.round(ready.data.confidence * 100)}%</strong>
                      <span>interpretation confidence</span>
                      <small>not a return probability</small>
                    </div>
                    <div>
                      <strong>{Math.round(ready.meta.evidenceCoverage.score * 100)}%</strong>
                      <span>evidence coverage</span>
                      <small>{ready.meta.evidenceCoverage.label}</small>
                    </div>
                  </div>
                </section>

                {ready.meta.ai && (
                  <section className={styles.aiGuardrail} data-testid="omnigaze-ai-guardrail">
                    <div>
                      <ShieldCheck size={16} />
                      <strong>
                        {ready.meta.ai.source === "cache"
                          ? "Verified analysis cache reused"
                          : ready.meta.ai.deduplicated
                            ? "Joined an analysis already in progress"
                            : "Fresh model analysis generated"}
                      </strong>
                    </div>
                    <p>
                      {ready.meta.ai.budget.charged
                        ? `One model request used · ${ready.meta.ai.budget.remaining} of ${ready.meta.ai.budget.limit} remain until ${formatTimestamp(ready.meta.ai.budget.resetAt)}.`
                        : "No additional model request was charged for this view."}
                    </p>
                    <small>
                      Usage controls manage AI cost and abuse. They are not a market signal,
                      recommendation, or confidence score.
                    </small>
                  </section>
                )}

                <section className={styles.whyNow}>
                  <span>WHY NOW</span>
                  <p>{ready.data.whyNow}</p>
                </section>

                <section className={styles.section}>
                  <div className={styles.sectionHeading}>
                    <span>KEY DRIVERS</span>
                    <small>{ready.data.drivers.length} grounded signals</small>
                  </div>
                  <div className={styles.driverGrid}>
                    {ready.data.drivers.map((driver) => (
                      <article key={`${driver.label}-${driver.evidenceIds.join("-")}`}>
                        <div>
                          <i className={styles[driver.direction]} />
                          <strong>{driver.label}</strong>
                          <small>{driver.direction}</small>
                        </div>
                        <p>{driver.explanation}</p>
                        <ul>
                          {driver.evidenceIds.map((evidenceId) => {
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

                <section className={styles.section}>
                  <div className={styles.sectionHeading}>
                    <span>IMPORTANT UNKNOWNS</span>
                    <small>What the evidence cannot establish</small>
                  </div>
                  <ul className={styles.unknowns}>
                    {ready.data.unknowns.map((unknown) => (
                      <li key={unknown}>{unknown}</li>
                    ))}
                  </ul>
                </section>

                <section className={styles.section}>
                  <div className={styles.sectionHeading}>
                    <span>CITED EVIDENCE</span>
                    <small>
                      {ready.meta.evidenceCount} items · {ready.meta.evidenceCoverage.sourceCount} sources
                    </small>
                  </div>
                  <ul className={styles.citations}>
                    {ready.meta.citations.map((citation) => (
                      <li key={citation.id}>
                        <div>
                          <strong>{citation.title}</strong>
                          <span>
                            {citation.publisher} · {formatTimestamp(citation.publishedAt)}
                          </span>
                        </div>
                        {citation.url && (
                          <a
                            href={citation.url}
                            target="_blank"
                            rel="noreferrer"
                            aria-label={`Open source: ${citation.title}`}
                          >
                            <ExternalLink size={14} />
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>

                <footer className={styles.footer}>
                  <div>
                    <Sparkles size={14} />
                    <span>
                      Live · {ready.meta.providerCoverage} coverage · evidence as of {formatTimestamp(ready.meta.freshness.asOf)}
                    </span>
                  </div>
                  <p>{ready.meta.disclaimer}</p>
                  <button
                    type="button"
                    onClick={() => void loadView("new_request")}
                  >
                    <RefreshCw size={13} /> Refresh view
                  </button>
                </footer>
              </>
            ) : null}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
