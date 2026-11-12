"use client";

import Link from "next/link";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowRight,
  BriefcaseBusiness,
  Check,
  Clock3,
  ExternalLink,
  FileSearch,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  formatMicrosAsQuantity,
  formatMicrosAsUsd,
  isEligibleDecisionCurrent,
  parseDecisionSupportEnvelope,
  parseHoldingMutationEnvelope,
  parsePortfolioReadEnvelope,
  type ClientPortfolioHolding,
  type DecisionSupportEnvelope,
  validateScenarioBudget,
  validatePositionFields,
} from "@/lib/portfolio/client-contracts";
import styles from "./portfolio-workspace-dialog.module.css";

export interface PortfolioWorkspaceInstrument {
  id: CanonicalSymbol;
  ticker: string;
  exchange: string;
  name: string;
}

export interface PortfolioWorkspaceHolding {
  symbolId: CanonicalSymbol;
  ticker?: string;
  exchange?: string;
  name?: string;
  quantity: string;
  averageCost: string | null;
  totalCostBasis?: string | null;
  costCurrency?: string;
  quantityAsOf?: string;
  version: number | null;
  persistence: "server" | "browser";
}

type WorkspaceSession =
  | { isAuthenticated: false; signInPath: string }
  | { isAuthenticated: true };

export type PortfolioAvailability = "ready" | "refreshing" | "unavailable";
export type WorkspaceQuoteState =
  | "fresh"
  | "stale"
  | "fixture"
  | "unavailable"
  | "loading";

interface PortfolioWorkspaceDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  initialView: "position" | "research";
  instrument: PortfolioWorkspaceInstrument;
  holding?: PortfolioWorkspaceHolding;
  session: WorkspaceSession;
  portfolioAvailability: PortfolioAvailability;
  quoteState: WorkspaceQuoteState;
  quoteLabel: string;
  onPortfolioAvailabilityChange(next: PortfolioAvailability): void;
  onHoldingUpsert(holding: PortfolioWorkspaceHolding): void;
  onHoldingRemoved(symbolId: CanonicalSymbol): void;
  onPortfolioReloaded(holdings: PortfolioWorkspaceHolding[]): void;
}

type HoldingMutationPayload = {
  quantity: string;
  average_cost: string | null;
  cost_currency: "USD";
  quantity_as_of: string;
  expected_version: number;
};

type PositionStatus =
  | { kind: "idle"; message: "" }
  | { kind: "success" | "error" | "conflict" | "session"; message: string };

type ScenarioResource =
  | { phase: "idle"; data?: undefined; message?: undefined }
  | { phase: "ready"; key: string; data: DecisionSupportEnvelope; message?: undefined }
  | { phase: "loading"; key: string; data?: undefined; message?: undefined }
  | { phase: "error"; key: string; data?: undefined; message: string };

const suppressedReasonCopy: Record<string, string> = {
  live_market_data_required:
    "Live provider data is unavailable. Demo prices are never used.",
  fresh_market_data_required:
    "The latest quote is stale or its freshness is unknown.",
  valid_market_price_required: "No valid market price is available.",
  market_data_unavailable: "No valid market price is available.",
  insufficient_evidence:
    "At least two attributable evidence items are required.",
  independent_sources_required:
    "At least two distinct provider streams are required.",
  live_evidence_required:
    "Live intelligence evidence is unavailable. Demo events never qualify.",
  fresh_evidence_required:
    "The newest intelligence evidence is stale or its freshness is unknown.",
};

function responseError(body: unknown, fallback: string) {
  if (body && typeof body === "object" && "error" in body) {
    const error = (body as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) return error;
  }
  return fallback;
}

function asWorkspaceHolding(
  holding: ClientPortfolioHolding,
): PortfolioWorkspaceHolding {
  return {
    ...holding,
    version: holding.version,
    persistence: "server",
  };
}

function formatAsOf(value: string | undefined) {
  if (!value || !Number.isFinite(Date.parse(value))) return "time unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDistance(bps: number) {
  const sign = bps > 0 ? "+" : bps < 0 ? "−" : "";
  const absolute = Math.abs(bps);
  const whole = Math.floor(absolute / 100);
  const remainder = absolute % 100;
  return `${sign}${whole}${remainder ? `.${remainder.toString().padStart(2, "0")}` : ""}%`;
}

function zoneLabel(kind: string) {
  if (kind === "pullback_review") return "Pullback review";
  if (kind === "strength_review") return "Strength review";
  return "Downside review";
}

export function PortfolioWorkspaceDialog({
  open,
  onOpenChange,
  initialView,
  instrument,
  holding,
  session,
  portfolioAvailability,
  quoteState,
  quoteLabel,
  onPortfolioAvailabilityChange,
  onHoldingUpsert,
  onHoldingRemoved,
  onPortfolioReloaded,
}: PortfolioWorkspaceDialogProps) {
  const quantityId = useId();
  const averageCostId = useId();
  const budgetId = useId();
  const [activeView, setActiveView] = useState<"position" | "research">(
    initialView,
  );
  const [quantity, setQuantity] = useState(holding?.quantity ?? "");
  const [averageCost, setAverageCost] = useState(holding?.averageCost ?? "");
  const [positionStatus, setPositionStatus] = useState<PositionStatus>({
    kind: "idle",
    message: "",
  });
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [retryPayload, setRetryPayload] =
    useState<HoldingMutationPayload | null>(null);
  const [conflictHolding, setConflictHolding] =
    useState<PortfolioWorkspaceHolding | null | undefined>(undefined);
  const [horizon, setHorizon] = useState<"near_term" | "long_term">(
    "near_term",
  );
  const [preset, setPreset] = useState<"tight" | "balanced" | "wide">(
    "balanced",
  );
  const [budget, setBudget] = useState("");
  const [scenarioResource, setScenarioResource] = useState<ScenarioResource>({
    phase: "idle",
  });
  const openedForRef = useRef<CanonicalSymbol | null>(null);
  const scenarioControllerRef = useRef<AbortController | null>(null);
  const scenarioKey = [
    instrument.id,
    horizon,
    preset,
    budget.trim(),
    holding?.persistence ?? "none",
    holding?.version ?? "none",
    holding?.quantity ?? "none",
    quoteState,
  ].join("|");
  const scenarioKeyRef = useRef(scenarioKey);
  const visibleScenarioResource = useMemo<ScenarioResource>(
    () =>
      scenarioResource.phase === "idle" ||
      ("key" in scenarioResource && scenarioResource.key === scenarioKey)
        ? scenarioResource
        : { phase: "idle" },
    [scenarioKey, scenarioResource],
  );

  useEffect(() => {
    scenarioKeyRef.current = scenarioKey;
    scenarioControllerRef.current?.abort();
  }, [scenarioKey]);

  useEffect(() => {
    if (!open) {
      openedForRef.current = null;
      scenarioControllerRef.current?.abort();
      return;
    }
    if (openedForRef.current === instrument.id) return;
    openedForRef.current = instrument.id;
    setActiveView(initialView);
    setQuantity(holding?.quantity ?? "");
    setAverageCost(holding?.averageCost ?? "");
    setPositionStatus({ kind: "idle", message: "" });
    setRetryPayload(null);
    setConflictHolding(undefined);
    setConfirmRemove(false);
    setScenarioResource({ phase: "idle" });
  }, [holding?.averageCost, holding?.quantity, initialView, instrument.id, open]);

  useEffect(() => {
    if (visibleScenarioResource.phase !== "ready") return;
    const decision = visibleScenarioResource.data.decision;
    if (!decision.eligible) return;
    const contextExpiry = visibleScenarioResource.data.context.quote?.freshUntil;
    const fallbackExpiry = Date.parse(decision.asOf) + 20 * 60 * 1_000;
    const expiresAt = contextExpiry ? Date.parse(contextExpiry) : fallbackExpiry;
    const timeout = window.setTimeout(
      () =>
        setScenarioResource({
          phase: "error",
          key: scenarioKey,
          message: "Quote context expired. Recheck the evidence before viewing numbers.",
        }),
      Math.max(0, expiresAt - Date.now()),
    );
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        setScenarioResource({
          phase: "error",
          key: scenarioKey,
          message: "Market context may have changed. Recheck the evidence to refresh scenarios.",
        });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [scenarioKey, visibleScenarioResource]);

  function clearPositionRetry() {
    setRetryPayload(null);
    if (positionStatus.kind === "conflict") return;
    setConflictHolding(undefined);
    if (positionStatus.kind !== "idle") {
      setPositionStatus({ kind: "idle", message: "" });
    }
  }

  async function fetchPortfolio() {
    onPortfolioAvailabilityChange("refreshing");
    const response = await fetch("/api/portfolio", {
      cache: "no-store",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    const body = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      onPortfolioAvailabilityChange("unavailable");
      throw new Error(
        responseError(body, "Your portfolio is temporarily unavailable."),
      );
    }
    const next = parsePortfolioReadEnvelope(body).map(asWorkspaceHolding);
    onPortfolioReloaded(next);
    onPortfolioAvailabilityChange("ready");
    return next;
  }

  async function recoverPortfolio() {
    try {
      const next = await fetchPortfolio();
      const latest = next.find(({ symbolId }) => symbolId === instrument.id);
      setPositionStatus({
        kind: "success",
        message: latest
          ? "Latest account position loaded."
          : "Portfolio reconnected. No saved position exists for this stock.",
      });
    } catch (error) {
      setPositionStatus({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Your portfolio is temporarily unavailable.",
      });
    }
  }

  async function handleConflict() {
    try {
      const next = await fetchPortfolio();
      const latest =
        next.find(({ symbolId }) => symbolId === instrument.id) ?? null;
      setConflictHolding(latest);
      setPositionStatus({
        kind: "conflict",
        message:
          "This position changed elsewhere. Your draft is preserved; load the latest version before saving again.",
      });
    } catch {
      setPositionStatus({
        kind: "conflict",
        message:
          "This position changed elsewhere. Your draft is preserved, but the latest version could not be loaded yet.",
      });
    }
  }

  function loadConflictHolding() {
    if (conflictHolding === undefined) return;
    setQuantity(conflictHolding?.quantity ?? "");
    setAverageCost(conflictHolding?.averageCost ?? "");
    setRetryPayload(null);
    setConflictHolding(undefined);
    setPositionStatus({
      kind: "success",
      message: conflictHolding
        ? "Latest position loaded. Review it before saving."
        : "The latest account has no position for this stock. Review before saving a new one.",
    });
  }

  async function savePosition() {
    if (!session.isAuthenticated || saving || removing) return;
    if (positionStatus.kind === "conflict") return;
    if (portfolioAvailability !== "ready") {
      setPositionStatus({
        kind: "error",
        message: "Reconnect your portfolio before making changes.",
      });
      return;
    }
    const validated = validatePositionFields(quantity, averageCost);
    if (!validated.success) {
      setPositionStatus({ kind: "error", message: validated.error });
      return;
    }
    const expectedVersion = holding?.persistence === "server" ? holding.version : 0;
    if (expectedVersion === null || expectedVersion < 0) {
      setPositionStatus({
        kind: "error",
        message: "The saved position version is unavailable. Refresh before saving.",
      });
      return;
    }

    const payload =
      retryPayload ??
      ({
        quantity: validated.quantity,
        average_cost: validated.averageCost,
        cost_currency: "USD",
        quantity_as_of: new Date().toISOString(),
        expected_version: expectedVersion,
      } satisfies HoldingMutationPayload);
    setRetryPayload(payload);
    setSaving(true);
    setPositionStatus({ kind: "idle", message: "" });

    try {
      const response = await fetch(
        `/api/portfolio/holdings/${encodeURIComponent(instrument.id)}`,
        {
          method: "PUT",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.status === 409) {
        setRetryPayload(null);
        await handleConflict();
        return;
      }
      if (response.status === 401) {
        setPositionStatus({
          kind: "session",
          message: "Your session expired. Sign in again; your draft is still here.",
        });
        return;
      }
      if (!response.ok) {
        setPositionStatus({
          kind: "error",
          message: responseError(body, "Position could not be saved."),
        });
        return;
      }
      const saved = asWorkspaceHolding(
        parseHoldingMutationEnvelope(body, instrument.id),
      );
      onHoldingUpsert(saved);
      onPortfolioAvailabilityChange("ready");
      setRetryPayload(null);
      setQuantity(saved.quantity);
      setAverageCost(saved.averageCost ?? "");
      setPositionStatus({
        kind: "success",
        message: "Position saved to your account.",
      });
    } catch (error) {
      setPositionStatus({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Position could not be saved.",
      });
    } finally {
      setSaving(false);
    }
  }

  async function removePosition() {
    if (
      !session.isAuthenticated ||
      removing ||
      holding?.persistence !== "server" ||
      !holding.version
    ) {
      return;
    }
    setRemoving(true);
    setPositionStatus({ kind: "idle", message: "" });
    try {
      const response = await fetch(
        `/api/portfolio/holdings/${encodeURIComponent(instrument.id)}?expected_version=${holding.version}`,
        {
          method: "DELETE",
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
        },
      );
      const body = (await response.json().catch(() => null)) as unknown;
      if (response.status === 409) {
        await handleConflict();
        return;
      }
      if (response.status === 404) {
        const next = await fetchPortfolio();
        if (!next.some(({ symbolId }) => symbolId === instrument.id)) {
          onHoldingRemoved(instrument.id);
          setQuantity("");
          setAverageCost("");
          setConfirmRemove(false);
          setPositionStatus({
            kind: "success",
            message: "Position was already removed. The stock remains on your watchlist.",
          });
          return;
        }
      }
      if (response.status === 401) {
        setPositionStatus({
          kind: "session",
          message: "Your session expired. Sign in again to remove this position.",
        });
        return;
      }
      if (!response.ok) {
        setPositionStatus({
          kind: "error",
          message: responseError(body, "Position could not be removed."),
        });
        return;
      }
      const candidate = body as {
        data?: { symbolId?: unknown; deleted?: unknown };
      } | null;
      if (
        candidate?.data?.symbolId !== instrument.id ||
        candidate.data.deleted !== true
      ) {
        throw new Error("The removal response did not match this stock.");
      }
      onHoldingRemoved(instrument.id);
      setQuantity("");
      setAverageCost("");
      setConfirmRemove(false);
      setPositionStatus({
        kind: "success",
        message: "Position removed. The stock remains on your watchlist.",
      });
    } catch (error) {
      setPositionStatus({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Position could not be removed.",
      });
    } finally {
      setRemoving(false);
    }
  }

  async function runScenario() {
    if (!session.isAuthenticated || visibleScenarioResource.phase === "loading") return;
    if (quoteState !== "fresh") {
      setScenarioResource({
        phase: "error",
        key: scenarioKey,
        message: "A fresh provider quote is required before scenario numbers can be shown.",
      });
      return;
    }
    const normalizedBudget = budget.trim();
    const validatedBudget = validateScenarioBudget(normalizedBudget);
    if (!validatedBudget.success) {
      setScenarioResource({
        phase: "error",
        key: scenarioKey,
        message: validatedBudget.error,
      });
      return;
    }

    scenarioControllerRef.current?.abort();
    const controller = new AbortController();
    scenarioControllerRef.current = controller;
    const requestKey = scenarioKey;
    setScenarioResource({ phase: "loading", key: requestKey });
    try {
      const response = await fetch("/api/portfolio/decision-support", {
        method: "POST",
        cache: "no-store",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          symbol_id: instrument.id,
          horizon,
          preset,
          budget: validatedBudget.budget,
        }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => null)) as unknown;
      if (scenarioKeyRef.current !== requestKey) return;
      if (!response.ok) {
        setScenarioResource({
          phase: "error",
          key: requestKey,
          message: responseError(body, "Research scenarios are temporarily unavailable."),
        });
        return;
      }
      const parsed = parseDecisionSupportEnvelope(body, instrument.id);
      const decision = parsed.decision;
      const quoteExpiry = parsed.context.quote?.freshUntil;
      if (
        decision.eligible &&
        (!isEligibleDecisionCurrent(decision, {
          expectedSymbol: instrument.id,
          quoteState,
        }) ||
          !quoteExpiry ||
          Date.parse(quoteExpiry) <= Date.now())
      ) {
        setScenarioResource({
          phase: "error",
          key: requestKey,
          message: "The returned quote context is no longer fresh. Recheck before viewing numbers.",
        });
        return;
      }
      const returnedHolding = parsed.context.holding;
      const localVersion =
        holding?.persistence === "server" ? holding.version : null;
      if (
        Boolean(returnedHolding) !== Boolean(localVersion) ||
        (returnedHolding && returnedHolding.version !== localVersion)
      ) {
        setScenarioResource({
          phase: "error",
          key: requestKey,
          message: "Your saved position changed. Refresh it before calculating scenarios.",
        });
        void fetchPortfolio().catch(() => undefined);
        return;
      }
      setScenarioResource({ phase: "ready", key: requestKey, data: parsed });
    } catch (error) {
      if (controller.signal.aborted) return;
      setScenarioResource({
        phase: "error",
        key: requestKey,
        message:
          error instanceof Error
            ? error.message
            : "Research scenarios are temporarily unavailable.",
      });
    }
  }

  const readyScenario =
    visibleScenarioResource.phase === "ready"
      ? visibleScenarioResource.data
      : null;
  const eligibleDecision =
    readyScenario?.decision.eligible ? readyScenario.decision : null;
  const ineligibleDecision =
    readyScenario && !readyScenario.decision.eligible
      ? readyScenario.decision
      : null;
  const scenarioContext = readyScenario?.context ?? null;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className={styles.overlay} />
        <DialogPrimitive.Content
          className={styles.dialog}
          data-testid="portfolio-workspace"
          aria-describedby={undefined}
        >
          <header className={styles.header}>
            <div className={styles.identity}>
              <span className={styles.avatar} aria-hidden="true">
                {instrument.ticker[0]}
              </span>
              <div>
                <span>{instrument.exchange}:{instrument.ticker}</span>
                <DialogPrimitive.Title>
                  Position &amp; research workspace
                </DialogPrimitive.Title>
                <p>{instrument.name}</p>
              </div>
            </div>
            <DialogPrimitive.Close className={styles.closeButton}>
              <X size={18} />
              <span className="sr-only">Close workspace</span>
            </DialogPrimitive.Close>
          </header>

          <div className={styles.tabs} role="tablist" aria-label="Portfolio workspace">
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "position"}
              className={activeView === "position" ? styles.activeTab : ""}
              onClick={() => setActiveView("position")}
            >
              <BriefcaseBusiness size={15} /> Position
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "research"}
              className={activeView === "research" ? styles.activeTab : ""}
              onClick={() => setActiveView("research")}
            >
              <Sparkles size={15} /> Research scenarios
            </button>
          </div>

          <div className={styles.body}>
            {activeView === "position" ? (
              <section
                role="tabpanel"
                aria-label="Position"
                className={styles.positionPanel}
              >
                <div className={styles.sectionIntro}>
                  <span>YOUR POSITION</span>
                  <h2>{holding ? "Update what you own" : "Add this position"}</h2>
                  <p>
                    This context helps Omnigaze frame concentration and hypothetical
                    scenarios. It never places an order.
                  </p>
                </div>

                {!session.isAuthenticated ? (
                  <div className={styles.gateCard}>
                    <LockKeyhole size={22} />
                    <div>
                      <strong>
                        {holding?.persistence === "browser"
                          ? "This position is saved on this device"
                          : "Sign in to save positions"}
                      </strong>
                      <p>
                        {holding?.persistence === "browser"
                          ? `${holding.quantity} shares${holding.averageCost ? ` · $${holding.averageCost} average cost` : ""}. Edit browser-only setup from onboarding, or sign in to sync across devices.`
                          : "Account positions are private, versioned, and available across your devices."}
                      </p>
                      <div className={styles.gateActions}>
                        <a href={session.signInPath} target="_top">
                          Sign in to sync <ArrowRight size={14} />
                        </a>
                        <Link href="/onboarding">Edit device setup</Link>
                      </div>
                    </div>
                  </div>
                ) : portfolioAvailability !== "ready" ? (
                  <div className={styles.gateCard}>
                    {portfolioAvailability === "refreshing" ? (
                      <LoaderCircle className={styles.spinner} size={22} />
                    ) : (
                      <AlertTriangle size={22} />
                    )}
                    <div>
                      <strong>
                        {portfolioAvailability === "refreshing"
                          ? "Reconnecting your portfolio"
                          : "Portfolio sync is unavailable"}
                      </strong>
                      <p>
                        Existing data is not treated as empty. Reconnect before adding
                        or editing a position.
                      </p>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        disabled={portfolioAvailability === "refreshing"}
                        onClick={() => void recoverPortfolio()}
                      >
                        <RefreshCw size={14} /> Retry
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.formGrid} aria-busy={saving || removing}>
                      <label htmlFor={quantityId}>
                        <span>Shares owned</span>
                        <input
                          id={quantityId}
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="15"
                          value={quantity}
                          onChange={(event) => {
                            setQuantity(event.target.value);
                            clearPositionRetry();
                          }}
                        />
                        <small>Positive amount · up to six decimal places</small>
                      </label>
                      <label htmlFor={averageCostId}>
                        <span>Average cost per share <i>optional</i></span>
                        <div className={styles.moneyInput}>
                          <b>$</b>
                          <input
                            id={averageCostId}
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder="140.25"
                            value={averageCost}
                            onChange={(event) => {
                              setAverageCost(event.target.value);
                              clearPositionRetry();
                            }}
                          />
                          <b>USD</b>
                        </div>
                        <small>Quantity will be marked current as of now</small>
                      </label>
                    </div>

                    {holding?.persistence === "server" && (
                      <div className={styles.savedContext}>
                        <Check size={14} />
                        <span>
                          Account position · version {holding.version}
                          {holding.quantityAsOf
                            ? ` · as of ${formatAsOf(holding.quantityAsOf)}`
                            : ""}
                        </span>
                      </div>
                    )}

                    {positionStatus.kind !== "idle" && (
                      <div
                        className={`${styles.status} ${styles[positionStatus.kind]}`}
                        role={positionStatus.kind === "success" ? "status" : "alert"}
                      >
                        {positionStatus.kind === "success" ? (
                          <Check size={16} />
                        ) : (
                          <AlertTriangle size={16} />
                        )}
                        <div>
                          <span>{positionStatus.message}</span>
                          {positionStatus.kind === "conflict" && conflictHolding !== undefined && (
                            <button type="button" onClick={loadConflictHolding}>
                              Load latest position
                            </button>
                          )}
                          {positionStatus.kind === "session" && (
                            <a href="/dashboard" target="_top">Sign in again</a>
                          )}
                        </div>
                      </div>
                    )}

                    <div className={styles.positionActions}>
                      <button
                        type="button"
                        className={styles.primaryButton}
                        disabled={saving || removing || positionStatus.kind === "conflict"}
                        onClick={() => void savePosition()}
                      >
                        {saving ? (
                          <><LoaderCircle className={styles.spinner} size={15} /> Saving…</>
                        ) : (
                          <><BriefcaseBusiness size={15} /> {holding ? "Save changes" : "Save position"}</>
                        )}
                      </button>
                      {holding?.persistence === "server" &&
                        (confirmRemove ? (
                          <div className={styles.removeConfirm}>
                            <span>Remove this position?</span>
                            <button
                              type="button"
                              onClick={() => setConfirmRemove(false)}
                              disabled={removing}
                            >
                              Cancel
                            </button>
                            <button
                              type="button"
                              onClick={() => void removePosition()}
                              disabled={removing}
                            >
                              {removing ? "Removing…" : "Remove"}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className={styles.removeButton}
                            onClick={() => setConfirmRemove(true)}
                            disabled={saving || removing}
                          >
                            <Trash2 size={14} /> Remove position
                          </button>
                        ))}
                    </div>
                  </>
                )}
              </section>
            ) : (
              <section
                role="tabpanel"
                aria-label="Research scenarios"
                className={styles.researchPanel}
              >
                <div className={styles.researchControls}>
                  <div className={styles.sectionIntro}>
                    <span>EVIDENCE-GATED</span>
                    <h2>Research scenarios</h2>
                    <p>
                      Calculate review checkpoints from a fresh quote and corroborated
                      evidence. These are not targets or recommendations.
                    </p>
                  </div>

                  {!session.isAuthenticated ? (
                    <div className={styles.gateCard}>
                      <LockKeyhole size={22} />
                      <div>
                        <strong>Sign in to run evidence-gated scenarios</strong>
                        <p>
                          The service derives your saved holding privately and never
                          accepts a caller-supplied account identity.
                        </p>
                        <a href={session.signInPath} target="_top">
                          Sign in <ArrowRight size={14} />
                        </a>
                      </div>
                    </div>
                  ) : (
                    <>
                      <fieldset className={styles.segmentField}>
                        <legend>Review range</legend>
                        <div>
                          {(["tight", "balanced", "wide"] as const).map((value) => (
                            <label key={value}>
                              <input
                                type="radio"
                                name="scenario-preset"
                                value={value}
                                checked={preset === value}
                                onChange={() => setPreset(value)}
                              />
                              <span>{value[0].toUpperCase() + value.slice(1)}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>

                      <fieldset className={styles.segmentField}>
                        <legend>
                          Research horizon <small>context only</small>
                        </legend>
                        <div>
                          {([
                            ["near_term", "Near term"],
                            ["long_term", "Long term"],
                          ] as const).map(([value, label]) => (
                            <label key={value}>
                              <input
                                type="radio"
                                name="scenario-horizon"
                                value={value}
                                checked={horizon === value}
                                onChange={() => setHorizon(value)}
                              />
                              <span>{label}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>

                      <label className={styles.budgetField} htmlFor={budgetId}>
                        <span>Hypothetical USD budget <i>optional</i></span>
                        <div className={styles.moneyInput}>
                          <b>$</b>
                          <input
                            id={budgetId}
                            inputMode="decimal"
                            autoComplete="off"
                            placeholder="1,000"
                            value={budget}
                            onChange={(event) => setBudget(event.target.value.replaceAll(",", ""))}
                          />
                          <b>USD</b>
                        </div>
                        <small>Add scenarios appear only when a budget is entered.</small>
                      </label>

                      <div className={`${styles.quoteReadiness} ${styles[quoteState]}`}>
                        <span />
                        <div>
                          <strong>
                            {quoteState === "fresh"
                              ? "Fresh provider quote ready"
                              : "Fresh provider quote required"}
                          </strong>
                          <small>{quoteLabel}</small>
                        </div>
                      </div>

                      <button
                        type="button"
                        className={styles.primaryButton}
                        disabled={visibleScenarioResource.phase === "loading" || quoteState !== "fresh"}
                        onClick={() => void runScenario()}
                      >
                        {visibleScenarioResource.phase === "loading" ? (
                          <><LoaderCircle className={styles.spinner} size={15} /> Checking evidence…</>
                        ) : (
                          <><FileSearch size={15} /> Check evidence &amp; calculate</>
                        )}
                      </button>
                    </>
                  )}
                </div>

                <div
                  className={styles.scenarioOutput}
                  data-testid="decision-support-state"
                  aria-live="polite"
                >
                  {visibleScenarioResource.phase === "idle" ? (
                    <div className={styles.outputPlaceholder}>
                      <Sparkles size={24} />
                      <strong>No scenario calculated yet</strong>
                      <p>
                        Omnigaze will first verify quote freshness and evidence coverage.
                        If either is insufficient, no price or quantity numbers appear.
                      </p>
                    </div>
                  ) : visibleScenarioResource.phase === "loading" ? (
                    <div className={styles.outputPlaceholder} role="status">
                      <LoaderCircle className={styles.spinner} size={24} />
                      <strong>Checking live context</strong>
                      <p>Verifying market freshness and attributable evidence.</p>
                    </div>
                  ) : visibleScenarioResource.phase === "error" ? (
                    <div className={styles.outputAlert} role="alert">
                      <AlertTriangle size={20} />
                      <div><strong>Scenario unavailable</strong><p>{visibleScenarioResource.message}</p></div>
                    </div>
                  ) : ineligibleDecision ? (
                    <div className={styles.ineligible} role="status">
                      <ShieldCheck size={20} />
                      <div>
                        <strong>Numbers withheld by the evidence gate</strong>
                        <p>
                          Omnigaze will not calculate from stale, demo, or under-sourced context.
                        </p>
                        <ul>
                          {ineligibleDecision.suppressedReasons.map((reason) => (
                            <li key={reason}>
                              {suppressedReasonCopy[reason] ?? "A required safety condition was not met."}
                            </li>
                          ))}
                        </ul>
                        <small>
                          {scenarioContext?.evidenceCount ?? 0} attributable items · {scenarioContext?.providerStreamCount ?? scenarioContext?.independentSourceCount ?? 0} provider streams
                        </small>
                      </div>
                    </div>
                  ) : eligibleDecision ? (
                    <div className={styles.results}>
                      <div className={styles.resultHeading}>
                        <div>
                          <span>RESEARCH SCENARIO · NOT A RECOMMENDATION</span>
                          <h3>Review checkpoints for {instrument.ticker}</h3>
                          <p>
                            {scenarioContext?.quote?.provider ?? "Provider quote"} · {formatAsOf(eligibleDecision.asOf)}
                            {scenarioContext?.quote?.marketCoverage
                              ? ` · ${scenarioContext.quote.marketCoverage.replaceAll("-", " ")} coverage`
                              : ""}
                          </p>
                        </div>
                        <div className={styles.coverageBadge}>
                          <strong>{Math.round(eligibleDecision.evidenceConfidence.score * 100)}%</strong>
                          <span>evidence coverage</span>
                          <small>{eligibleDecision.evidenceConfidence.label}</small>
                        </div>
                      </div>

                      <div className={styles.zoneGrid}>
                        {eligibleDecision.zones.map((zone) => (
                          <article key={zone.kind}>
                            <span>{zoneLabel(zone.kind)}</span>
                            <strong>{formatMicrosAsUsd(zone.priceMicros)}</strong>
                            <small>{formatDistance(zone.distanceBps)} from current quote</small>
                            <p>{zone.explanation}</p>
                          </article>
                        ))}
                      </div>

                      {eligibleDecision.positionScenarios.length > 0 && (
                        <section className={styles.hypotheticalSection}>
                          <div><span>HYPOTHETICAL POSITION SIZES</span><small>No order is placed</small></div>
                          <ul>
                            {eligibleDecision.positionScenarios.map((scenario) => (
                              <li key={`${scenario.kind}-${scenario.fractionBps}`}>
                                <span>{scenario.label}</span>
                                <strong>{formatMicrosAsQuantity(scenario.quantityMicros)} shares</strong>
                                <small>{scenario.kind === "trim" ? "Review-only trim" : "Budget-based add"}</small>
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}

                      {scenarioContext?.evidence && scenarioContext.evidence.length > 0 && (
                        <section className={styles.citations}>
                          <div><span>CITED EVIDENCE</span><small>{scenarioContext.evidence.length} items</small></div>
                          <ul>
                            {scenarioContext.evidence.map((citation) => (
                              <li key={citation.id}>
                                <div>
                                  <strong>{citation.headline}</strong>
                                  <span>{citation.source} · {formatAsOf(citation.publishedAt)}</span>
                                </div>
                                {citation.sourceUrl && (
                                  <a href={citation.sourceUrl} target="_blank" rel="noreferrer" aria-label={`Open source: ${citation.headline}`}>
                                    <ExternalLink size={14} />
                                  </a>
                                )}
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}

                      <section className={styles.assumptions}>
                        <strong>Assumptions &amp; limits</strong>
                        <ul>
                          {eligibleDecision.assumptions.map((assumption) => (
                            <li key={assumption}>{assumption}</li>
                          ))}
                          <li>
                            Evidence coverage is not a probability of direction or return.
                          </li>
                        </ul>
                      </section>
                    </div>
                  ) : null}
                </div>
              </section>
            )}
          </div>

          <footer className={styles.footer}>
            <ShieldCheck size={14} />
            <span>Research support only · Not investment advice · No trade execution</span>
            <span><Clock3 size={13} /> Live context is revalidated on demand</span>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
