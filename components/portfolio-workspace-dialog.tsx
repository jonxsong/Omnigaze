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
import { useAppLocale } from "@/components/app-locale";
import {
  portfolioWorkspaceCopy,
  type PortfolioWorkspaceCopyKey,
} from "@/components/portfolio-workspace-copy";
import type { AppLocale } from "@/lib/app-locale";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  formatMicrosAsQuantity,
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
  | { kind: "idle"; messageKey: null }
  | {
      kind: "success" | "error" | "conflict" | "session";
      messageKey: PortfolioWorkspaceCopyKey;
    };

type ScenarioResource =
  | { phase: "idle"; data?: undefined; messageKey?: undefined }
  | { phase: "ready"; key: string; data: DecisionSupportEnvelope; messageKey?: undefined }
  | { phase: "loading"; key: string; data?: undefined; messageKey?: undefined }
  | {
      phase: "error";
      key: string;
      data?: undefined;
      messageKey: PortfolioWorkspaceCopyKey;
    };

function responseErrorKey(
  body: unknown,
  fallback: PortfolioWorkspaceCopyKey,
  messages: Record<string, PortfolioWorkspaceCopyKey>,
) {
  if (body && typeof body === "object" && "code" in body) {
    const code = (body as { code?: unknown }).code;
    if (typeof code === "string" && messages[code]) return messages[code];
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

function intlLocale(locale: AppLocale) {
  return locale === "zh-CN" ? "zh-CN" : "en-US";
}

function formatAsOf(
  value: string | undefined,
  locale: AppLocale,
  unavailable: string,
) {
  if (!value || !Number.isFinite(Date.parse(value))) return unavailable;
  return new Intl.DateTimeFormat(intlLocale(locale), {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatDistance(bps: number, locale: AppLocale) {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "percent",
    maximumFractionDigits: 2,
    signDisplay: "exceptZero",
  }).format(bps / 10_000);
}

function formatUsdMicros(value: number, locale: AppLocale) {
  return new Intl.NumberFormat(intlLocale(locale), {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value / 1_000_000);
}

function formatQuantityMicros(value: number, locale: AppLocale) {
  return new Intl.NumberFormat(intlLocale(locale), {
    maximumFractionDigits: 6,
  }).format(Number(formatMicrosAsQuantity(value)));
}

function formatStoredQuantity(value: string, locale: AppLocale) {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat(intlLocale(locale), {
        maximumFractionDigits: 6,
      }).format(number)
    : value;
}

function formatStoredUsd(value: string, locale: AppLocale) {
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat(intlLocale(locale), {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 6,
      }).format(number)
    : value;
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
  const { locale } = useAppLocale();
  const copy = portfolioWorkspaceCopy[locale];
  const portfolioReadErrors: Record<string, PortfolioWorkspaceCopyKey> = {
    auth_required: "authenticationRequired",
    portfolio_unavailable: "portfolioUnavailable",
  };
  const positionSaveErrors: Record<string, PortfolioWorkspaceCopyKey> = {
    auth_required: "sessionExpiredDraft",
    invalid_json: "positionSaveFailed",
    invalid_request: "positionSaveFailed",
    invalid_symbol: "positionSaveFailed",
    holding_not_found: "alreadyRemoved",
    symbol_not_supported: "positionSaveFailed",
    version_conflict: "positionChanged",
    holding_update_failed: "positionSaveFailed",
  };
  const positionRemoveErrors: Record<string, PortfolioWorkspaceCopyKey> = {
    auth_required: "authenticationRequired",
    invalid_query: "positionRemoveFailed",
    invalid_symbol: "positionRemoveFailed",
    holding_not_found: "alreadyRemoved",
    version_conflict: "positionChanged",
    holding_delete_failed: "positionRemoveFailed",
  };
  const scenarioErrors: Record<string, PortfolioWorkspaceCopyKey> = {
    auth_required: "authenticationRequired",
    invalid_json: "researchUnavailable",
    invalid_request: "researchUnavailable",
    asset_catalog_unavailable: "researchUnavailable",
    symbol_not_supported: "researchUnavailable",
    decision_support_unavailable: "researchUnavailable",
  };
  const suppressedReasonCopy: Record<string, string> = {
    live_market_data_required: copy.liveMarketRequired,
    fresh_market_data_required: copy.freshMarketRequired,
    valid_market_price_required: copy.validMarketRequired,
    market_data_unavailable: copy.validMarketRequired,
    insufficient_evidence: copy.insufficientEvidence,
    independent_sources_required: copy.independentSourcesRequired,
    live_evidence_required: copy.liveEvidenceRequired,
    fresh_evidence_required: copy.freshEvidenceRequired,
  };
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
    messageKey: null,
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
    setPositionStatus({ kind: "idle", messageKey: null });
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
          messageKey: "quoteExpired",
        }),
      Math.max(0, expiresAt - Date.now()),
    );
    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        setScenarioResource({
          phase: "error",
          key: scenarioKey,
          messageKey: "marketContextChanged",
        });
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearTimeout(timeout);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [copy.marketContextChanged, copy.quoteExpired, scenarioKey, visibleScenarioResource]);

  function clearPositionRetry() {
    setRetryPayload(null);
    if (positionStatus.kind === "conflict") return;
    setConflictHolding(undefined);
    if (positionStatus.kind !== "idle") {
      setPositionStatus({ kind: "idle", messageKey: null });
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
        responseErrorKey(body, "portfolioUnavailable", portfolioReadErrors),
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
        messageKey: latest
          ? "latestPositionLoaded"
          : "reconnectedNoPosition",
      });
    } catch {
      setPositionStatus({
        kind: "error",
        messageKey: "portfolioUnavailable",
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
        messageKey: "positionChanged",
      });
    } catch {
      setPositionStatus({
        kind: "conflict",
        messageKey: "positionChangedUnavailable",
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
      messageKey: conflictHolding
        ? "latestReview"
        : "latestNoPosition",
    });
  }

  async function savePosition() {
    if (!session.isAuthenticated || saving || removing) return;
    if (positionStatus.kind === "conflict") return;
    if (portfolioAvailability !== "ready") {
      setPositionStatus({
        kind: "error",
        messageKey: "reconnectBeforeChanges",
      });
      return;
    }
    const validated = validatePositionFields(quantity, averageCost);
    if (!validated.success) {
      setPositionStatus({
        kind: "error",
        messageKey:
          validated.error.startsWith("Enter a positive share")
            ? "invalidQuantity"
            : "invalidAverageCost",
      });
      return;
    }
    const expectedVersion = holding?.persistence === "server" ? holding.version : 0;
    if (expectedVersion === null || expectedVersion < 0) {
      setPositionStatus({
        kind: "error",
        messageKey: "savedVersionUnavailable",
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
    setPositionStatus({ kind: "idle", messageKey: null });

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
          messageKey: "sessionExpiredDraft",
        });
        return;
      }
      if (!response.ok) {
        setPositionStatus({
          kind: "error",
          messageKey: responseErrorKey(
            body,
            "positionSaveFailed",
            positionSaveErrors,
          ),
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
        messageKey: "positionSaved",
      });
    } catch {
      setPositionStatus({
        kind: "error",
        messageKey: "positionSaveFailed",
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
    setPositionStatus({ kind: "idle", messageKey: null });
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
            messageKey: "alreadyRemoved",
          });
          return;
        }
      }
      if (response.status === 401) {
        setPositionStatus({
          kind: "session",
          messageKey: "sessionExpiredRemove",
        });
        return;
      }
      if (!response.ok) {
        setPositionStatus({
          kind: "error",
          messageKey: responseErrorKey(
            body,
            "positionRemoveFailed",
            positionRemoveErrors,
          ),
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
        throw new Error(copy.removalMismatch);
      }
      onHoldingRemoved(instrument.id);
      setQuantity("");
      setAverageCost("");
      setConfirmRemove(false);
      setPositionStatus({
        kind: "success",
        messageKey: "positionRemoved",
      });
    } catch {
      setPositionStatus({
        kind: "error",
        messageKey: "positionRemoveFailed",
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
        messageKey: "freshQuoteRequiredBeforeNumbers",
      });
      return;
    }
    const normalizedBudget = budget.trim();
    const validatedBudget = validateScenarioBudget(normalizedBudget);
    if (!validatedBudget.success) {
      setScenarioResource({
        phase: "error",
        key: scenarioKey,
        messageKey: "invalidBudget",
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
          messageKey: responseErrorKey(
            body,
            "researchUnavailable",
            scenarioErrors,
          ),
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
          messageKey: "returnedQuoteStale",
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
          messageKey: "savedPositionChanged",
        });
        void fetchPortfolio().catch(() => undefined);
        return;
      }
      setScenarioResource({ phase: "ready", key: requestKey, data: parsed });
    } catch {
      if (controller.signal.aborted) return;
      setScenarioResource({
        phase: "error",
        key: requestKey,
        messageKey: "researchUnavailable",
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
                  {copy.workspaceTitle}
                </DialogPrimitive.Title>
                <p>{instrument.name}</p>
              </div>
            </div>
            <DialogPrimitive.Close className={styles.closeButton}>
              <X size={18} />
              <span className="sr-only">{copy.closeWorkspace}</span>
            </DialogPrimitive.Close>
          </header>

          <div className={styles.tabs} role="tablist" aria-label={copy.workspaceAria}>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "position"}
              className={activeView === "position" ? styles.activeTab : ""}
              onClick={() => setActiveView("position")}
            >
              <BriefcaseBusiness size={15} /> {copy.position}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeView === "research"}
              className={activeView === "research" ? styles.activeTab : ""}
              onClick={() => setActiveView("research")}
            >
              <Sparkles size={15} /> {copy.researchScenarios}
            </button>
          </div>

          <div className={styles.body}>
            {activeView === "position" ? (
              <section
                role="tabpanel"
                aria-label={copy.position}
                className={styles.positionPanel}
              >
                <div className={styles.sectionIntro}>
                  <span>{copy.yourPosition}</span>
                  <h2>{holding ? copy.updateWhatYouOwn : copy.addThisPosition}</h2>
                  <p>{copy.positionIntro}</p>
                </div>

                {!session.isAuthenticated ? (
                  <div className={styles.gateCard}>
                    <LockKeyhole size={22} />
                    <div>
                      <strong>
                        {holding?.persistence === "browser"
                          ? copy.devicePositionTitle
                          : copy.signInToSave}
                      </strong>
                      <p>
                        {holding?.persistence === "browser"
                          ? `${formatStoredQuantity(holding.quantity, locale)} ${copy.shares}${holding.averageCost ? ` · ${formatStoredUsd(holding.averageCost, locale)} ${copy.averageCost}` : ""}. ${copy.devicePositionSuffix}`
                          : copy.accountPositionsPrivate}
                      </p>
                      <div className={styles.gateActions}>
                        <a href={session.signInPath} target="_top">
                          {copy.signInToSync} <ArrowRight size={14} />
                        </a>
                        <Link href="/onboarding">{copy.editDeviceSetup}</Link>
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
                          ? copy.reconnectingPortfolio
                          : copy.portfolioSyncUnavailable}
                      </strong>
                      <p>{copy.reconnectBeforeEdit}</p>
                      <button
                        type="button"
                        className={styles.secondaryButton}
                        disabled={portfolioAvailability === "refreshing"}
                        onClick={() => void recoverPortfolio()}
                      >
                        <RefreshCw size={14} /> {copy.retry}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.formGrid} aria-busy={saving || removing}>
                      <label htmlFor={quantityId}>
                        <span>{copy.sharesOwned}</span>
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
                        <small>{copy.quantityHint}</small>
                      </label>
                      <label htmlFor={averageCostId}>
                        <span>{copy.averageCostPerShare} <i>{copy.optional}</i></span>
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
                        <small>{copy.quantityCurrentNow}</small>
                      </label>
                    </div>

                    {holding?.persistence === "server" && (
                      <div className={styles.savedContext}>
                        <Check size={14} />
                        <span>
                          {copy.accountPosition} · {copy.version} {holding.version}
                          {holding.quantityAsOf
                            ? ` · ${copy.asOf} ${formatAsOf(holding.quantityAsOf, locale, copy.timeUnavailable)}`
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
                          <span>{copy[positionStatus.messageKey]}</span>
                          {positionStatus.kind === "conflict" && conflictHolding !== undefined && (
                            <button type="button" onClick={loadConflictHolding}>
                              {copy.loadLatestPosition}
                            </button>
                          )}
                          {positionStatus.kind === "session" && (
                            <a href="/dashboard" target="_top">{copy.signInAgain}</a>
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
                          <><LoaderCircle className={styles.spinner} size={15} /> {copy.saving}</>
                        ) : (
                          <><BriefcaseBusiness size={15} /> {holding ? copy.saveChanges : copy.savePosition}</>
                        )}
                      </button>
                      {holding?.persistence === "server" &&
                        (confirmRemove ? (
                          <div className={styles.removeConfirm}>
                            <span>{copy.removeQuestion}</span>
                            <button
                              type="button"
                              onClick={() => setConfirmRemove(false)}
                              disabled={removing}
                            >
                              {copy.cancel}
                            </button>
                            <button
                              type="button"
                              onClick={() => void removePosition()}
                              disabled={removing}
                            >
                              {removing ? copy.removing : copy.remove}
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className={styles.removeButton}
                            onClick={() => setConfirmRemove(true)}
                            disabled={saving || removing}
                          >
                            <Trash2 size={14} /> {copy.removePosition}
                          </button>
                        ))}
                    </div>
                  </>
                )}
              </section>
            ) : (
              <section
                role="tabpanel"
                aria-label={copy.researchScenarios}
                className={styles.researchPanel}
              >
                <div className={styles.researchControls}>
                  <div className={styles.sectionIntro}>
                    <span>{copy.evidenceGated}</span>
                    <h2>{copy.researchScenarios}</h2>
                    <p>{copy.researchIntro}</p>
                  </div>

                  {!session.isAuthenticated ? (
                    <div className={styles.gateCard}>
                      <LockKeyhole size={22} />
                      <div>
                        <strong>{copy.signInForScenarios}</strong>
                        <p>{copy.privateScenarioIdentity}</p>
                        <a href={session.signInPath} target="_top">
                          {copy.signIn} <ArrowRight size={14} />
                        </a>
                      </div>
                    </div>
                  ) : (
                    <>
                      <fieldset className={styles.segmentField}>
                        <legend>{copy.reviewRange}</legend>
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
                              <span>{copy[value]}</span>
                            </label>
                          ))}
                        </div>
                      </fieldset>

                      <fieldset className={styles.segmentField}>
                        <legend>
                          {copy.researchHorizon} <small>{copy.contextOnly}</small>
                        </legend>
                        <div>
                          {([
                            ["near_term", copy.nearTerm],
                            ["long_term", copy.longTerm],
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
                        <span>{copy.hypotheticalBudget} <i>{copy.optional}</i></span>
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
                        <small>{copy.budgetHint}</small>
                      </label>

                      <div className={`${styles.quoteReadiness} ${styles[quoteState]}`}>
                        <span />
                        <div>
                          <strong>
                            {quoteState === "fresh"
                              ? copy.freshQuoteReady
                              : copy.freshQuoteRequired}
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
                          <><LoaderCircle className={styles.spinner} size={15} /> {copy.checkingEvidence}</>
                        ) : (
                          <><FileSearch size={15} /> {copy.checkAndCalculate}</>
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
                      <strong>{copy.noScenario}</strong>
                      <p>{copy.noScenarioDescription}</p>
                    </div>
                  ) : visibleScenarioResource.phase === "loading" ? (
                    <div className={styles.outputPlaceholder} role="status">
                      <LoaderCircle className={styles.spinner} size={24} />
                      <strong>{copy.checkingLiveContext}</strong>
                      <p>{copy.verifyingContext}</p>
                    </div>
                  ) : visibleScenarioResource.phase === "error" ? (
                    <div className={styles.outputAlert} role="alert">
                      <AlertTriangle size={20} />
                      <div>
                        <strong>{copy.scenarioUnavailable}</strong>
                        <p>{copy[visibleScenarioResource.messageKey]}</p>
                      </div>
                    </div>
                  ) : ineligibleDecision ? (
                    <div className={styles.ineligible} role="status">
                      <ShieldCheck size={20} />
                      <div>
                        <strong>{copy.numbersWithheld}</strong>
                        <p>{copy.numbersWithheldDescription}</p>
                        <ul>
                          {ineligibleDecision.suppressedReasons.map((reason) => (
                            <li key={reason}>
                              {suppressedReasonCopy[reason] ?? copy.safetyConditionMissing}
                            </li>
                          ))}
                        </ul>
                        <small>
                          {scenarioContext?.evidenceCount ?? 0} {copy.attributableItems} · {scenarioContext?.providerStreamCount ?? scenarioContext?.independentSourceCount ?? 0} {copy.providerStreams}
                        </small>
                      </div>
                    </div>
                  ) : eligibleDecision ? (
                    <div className={styles.results}>
                      <div className={styles.resultHeading}>
                        <div>
                          <span>{copy.researchNotRecommendation}</span>
                          <h3>{copy.reviewCheckpointsFor} {instrument.ticker}</h3>
                          <p>
                            {scenarioContext?.quote?.provider ?? copy.providerQuote} · {formatAsOf(eligibleDecision.asOf, locale, copy.timeUnavailable)}
                            {scenarioContext?.quote?.marketCoverage
                              ? ` · ${scenarioContext.quote.marketCoverage === "limited-exchange"
                                ? copy.partialCoverage
                                : scenarioContext.quote.marketCoverage === "consolidated"
                                  ? copy.consolidatedCoverage
                                  : copy.fixtureCoverage}`
                              : ""}
                          </p>
                        </div>
                        <div className={styles.coverageBadge}>
                          <strong>{Math.round(eligibleDecision.evidenceConfidence.score * 100)}%</strong>
                          <span>{copy.evidenceCoverage}</span>
                          <small>{copy[eligibleDecision.evidenceConfidence.label]}</small>
                        </div>
                      </div>

                      <p className={styles.sourceDiversityNotice}>
                        {(scenarioContext?.providerStreamCount ??
                          scenarioContext?.independentSourceCount ??
                          0) < 2
                          ? copy.singleStreamDisclosure
                          : `${scenarioContext?.providerStreamCount ?? scenarioContext?.independentSourceCount ?? 0} ${copy.multipleStreamsDisclosure}`}
                      </p>

                      <div className={styles.zoneGrid}>
                        {eligibleDecision.zones.map((zone) => (
                          <article key={zone.kind}>
                            <span>
                              {zone.kind === "pullback_review"
                                ? copy.pullbackReview
                                : zone.kind === "strength_review"
                                  ? copy.strengthReview
                                  : copy.downsideReview}
                            </span>
                            <strong>{formatUsdMicros(zone.priceMicros, locale)}</strong>
                            <small>{formatDistance(zone.distanceBps, locale)} {copy.fromCurrentQuote}</small>
                            <p>
                              {locale === "zh-CN"
                                ? zone.kind === "pullback_review"
                                  ? copy.pullbackExplanation
                                  : zone.kind === "strength_review"
                                    ? copy.strengthExplanation
                                    : copy.downsideExplanation
                                : zone.explanation}
                            </p>
                          </article>
                        ))}
                      </div>

                      {eligibleDecision.positionScenarios.length > 0 && (
                        <section className={styles.hypotheticalSection}>
                          <div><span>{copy.hypotheticalPositionSizes}</span><small>{copy.noOrderPlaced}</small></div>
                          <ul>
                            {eligibleDecision.positionScenarios.map((scenario) => (
                              <li key={`${scenario.kind}-${scenario.fractionBps}`}>
                                <span>
                                  {locale === "zh-CN"
                                    ? scenario.kind === "trim"
                                      ? `${scenario.fractionBps / 100}% 减仓情景`
                                      : `输入预算的 ${scenario.fractionBps / 100}%`
                                    : scenario.label}
                                </span>
                                <strong>{formatQuantityMicros(scenario.quantityMicros, locale)} {copy.shares}</strong>
                                <small>{scenario.kind === "trim" ? copy.reviewOnlyTrim : copy.budgetBasedAdd}</small>
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}

                      {scenarioContext?.evidence && scenarioContext.evidence.length > 0 && (
                        <section className={styles.citations}>
                          <div><span>{copy.citedEvidence}</span><small>{scenarioContext.evidence.length} {copy.items}</small></div>
                          <ul>
                            {scenarioContext.evidence.map((citation) => (
                              <li key={citation.id}>
                                <div>
                                  <strong>{citation.headline}</strong>
                                  <span>{citation.source} · {formatAsOf(citation.publishedAt, locale, copy.timeUnavailable)}</span>
                                </div>
                                {citation.sourceUrl && (
                                  <a href={citation.sourceUrl} target="_blank" rel="noreferrer" aria-label={`${copy.openSource}: ${citation.headline}`}>
                                    <ExternalLink size={14} />
                                  </a>
                                )}
                              </li>
                            ))}
                          </ul>
                        </section>
                      )}

                      <section className={styles.assumptions}>
                        <strong>{copy.assumptionsAndLimits}</strong>
                        <ul>
                          {(locale === "zh-CN"
                            ? [
                                `${copy[eligibleDecision.preset]}${copy.presetAssumptionSuffix}`,
                                copy.priceAssumption,
                                copy.quantityAssumption,
                              ]
                            : eligibleDecision.assumptions
                          ).map((assumption) => (
                            <li key={assumption}>{assumption}</li>
                          ))}
                          <li>{copy.evidenceNotProbability}</li>
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
            <span>{copy.researchOnly}</span>
            <span><Clock3 size={13} /> {copy.liveContextRevalidated}</span>
          </footer>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
