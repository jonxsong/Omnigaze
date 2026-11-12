"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  CircleDollarSign,
  Eye,
  LoaderCircle,
  LockKeyhole,
  Search,
  ShieldCheck,
  Sparkles,
  Target,
  Trash2,
  WalletCards,
} from "lucide-react";
import { useAppLocale } from "@/components/app-locale";
import { stockWorkspaces } from "@/lib/demo-market-data";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  createEmptyOnboardingDraft,
  createLocalOnboardingDraftAdapter,
  type OnboardingDraft,
  type OnboardingDraftAdapter,
  type OnboardingGoal,
  type OnboardingInstrument,
  type OnboardingPosition,
  type OnboardingStep,
  ONBOARDING_MAX_SYMBOLS,
} from "@/lib/onboarding-draft";
import {
  isPortfolioDecimal,
  MAX_AVERAGE_COST_MICROS,
  MAX_QUANTITY_MICROS,
} from "@/lib/portfolio/decimal";
import { onboardingCopy } from "./onboarding-copy";
import styles from "./omnigaze-onboarding.module.css";

const featuredInstruments: OnboardingInstrument[] = stockWorkspaces.map(
  ({ instrument }) => ({
    id: instrument.id,
    ticker: instrument.ticker,
    exchange: instrument.exchange,
    name: instrument.name,
    sector: instrument.sector || null,
    currency: "USD",
  }),
);

type CatalogSearchResource = {
  query: string;
  phase: "idle" | "loading" | "ready" | "error";
  data: OnboardingInstrument[];
  catalogAsOf?: string;
  freshness?: "fresh" | "stale";
  error?: string;
};

type SaveState = "restoring" | "saving" | "saved" | "error";

interface OmnigazeOnboardingProps {
  isAuthenticated?: boolean;
}

function BrandMark() {
  return (
    <span className={styles.brandMark} aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

function OnboardingLocaleToggle({
  onLocaleChange,
}: {
  onLocaleChange: () => void;
}) {
  const { locale, setLocale } = useAppLocale();
  const copy = onboardingCopy[locale].locale;

  return (
    <div className={styles.localeToggle} role="group" aria-label={copy.group}>
      <button
        type="button"
        lang="en"
        aria-pressed={locale === "en"}
        onClick={() => {
          onLocaleChange();
          setLocale("en");
        }}
      >
        {copy.english}
      </button>
      <span aria-hidden="true">/</span>
      <button
        type="button"
        lang="zh-CN"
        aria-pressed={locale === "zh-CN"}
        onClick={() => {
          onLocaleChange();
          setLocale("zh-CN");
        }}
      >
        {copy.chinese}
      </button>
    </div>
  );
}

function positionFor(
  draft: OnboardingDraft,
  symbolId: CanonicalSymbol,
): OnboardingPosition {
  return (
    draft.positions.find((position) => position.symbolId === symbolId) ?? {
      symbolId,
      owned: false,
      shares: "",
      averageCost: "",
    }
  );
}

function isValidShareQuantity(value: string) {
  return isPortfolioDecimal(value.trim(), {
    allowZero: false,
    maxMicros: MAX_QUANTITY_MICROS,
  });
}

function isValidAverageCost(value: string) {
  return isPortfolioDecimal(value.trim(), {
    allowZero: true,
    maxMicros: MAX_AVERAGE_COST_MICROS,
  });
}

function cleanNumericInput(value: string, decimalPlaces: number) {
  const cleaned = value.replace(/[^\d.,]/g, "").replaceAll(",", "");
  const [whole = "", ...decimalParts] = cleaned.split(".");
  if (decimalParts.length === 0) return whole.slice(0, 12);
  return `${whole.slice(0, 12)}.${decimalParts.join("").slice(0, decimalPlaces)}`;
}

function StockIdentity({ instrument }: { instrument: OnboardingInstrument }) {
  return (
    <span className={styles.stockIdentity}>
      <span className={styles.stockAvatar}>{instrument.ticker[0]}</span>
      <span>
        <strong>{instrument.ticker}</strong>
        <small>{instrument.name}</small>
      </span>
    </span>
  );
}

function SetupPreview({ draft }: { draft: OnboardingDraft }) {
  const { locale } = useAppLocale();
  const copy = onboardingCopy[locale];
  const goalLabels = new Map(
    copy.goals.map((option) => [option.value, option.label]),
  );
  const horizonLabels = new Map(
    copy.horizons.map((option) => [option.value, option.label]),
  );
  const selectedById = new Map(
    draft.instruments.map((instrument) => [instrument.id, instrument]),
  );
  const selected = draft.symbols.flatMap((symbol) => {
    const instrument = selectedById.get(symbol);
    return instrument ? [instrument] : [];
  });
  const owned = draft.positions.filter((position) => position.owned);

  return (
    <aside className={styles.preview} aria-label={copy.preview.aria}>
      <div className={styles.previewHeading}>
        <span className={styles.previewOrb}><Sparkles size={17} /></span>
        <div>
          <span>{copy.preview.eyebrow}</span>
          <strong>{copy.preview.title}</strong>
        </div>
      </div>

      <div className={styles.previewWatchlist}>
        <div className={styles.previewLabelRow}>
          <span>{copy.preview.watchlist}</span>
          <small>{selected.length}/{ONBOARDING_MAX_SYMBOLS}</small>
        </div>
        {selected.length > 0 ? (
          <div className={styles.previewSymbols}>
            {selected.slice(0, 5).map((instrument) => (
              <div key={instrument.id}>
                <span className={styles.stockAvatar}>{instrument.ticker[0]}</span>
                <span><strong>{instrument.ticker}</strong><small>{instrument.sector ?? instrument.exchange}</small></span>
                {owned.some((position) => position.symbolId === instrument.id) && (
                  <span className={styles.ownedBadge}>{copy.preview.owned}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.previewEmpty}>
            <Eye size={17} />
            <span>{copy.preview.empty}</span>
          </div>
        )}
      </div>

      <div className={styles.previewSignalGrid}>
        <div>
          <span>{copy.preview.researchHorizon}</span>
          <strong>{draft.horizon ? horizonLabels.get(draft.horizon) : copy.preview.notSet}</strong>
        </div>
        <div>
          <span>{copy.preview.holdingsAdded}</span>
          <strong>{owned.length}</strong>
        </div>
      </div>

      <div className={styles.previewLens}>
        <span>{copy.preview.researchLens}</span>
        {draft.goals.length > 0 ? (
          <ul>
            {draft.goals.slice(0, 3).map((goal) => (
              <li key={goal}><Check size={13} />{goalLabels.get(goal)}</li>
            ))}
          </ul>
        ) : (
          <p>{copy.preview.emptyLens}</p>
        )}
      </div>

      <div className={styles.previewTrust}>
        <ShieldCheck size={16} />
        <div>
          <strong>{copy.preview.trustTitle}</strong>
          <span>{copy.preview.trustBody}</span>
        </div>
      </div>
    </aside>
  );
}

export function OmnigazeOnboarding({
  isAuthenticated = false,
}: OmnigazeOnboardingProps) {
  const { hydrated: localeHydrated, locale } = useAppLocale();
  const copy = onboardingCopy[locale];
  const router = useRouter();
  const reduceMotion = useReducedMotion();
  const adapterRef = useRef<OnboardingDraftAdapter | null>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [draft, setDraft] = useState<OnboardingDraft>(() =>
    createEmptyOnboardingDraft(),
  );
  const [hydrated, setHydrated] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("restoring");
  const [query, setQuery] = useState("");
  const [catalogSearch, setCatalogSearch] = useState<CatalogSearchResource>({
    query: "",
    phase: "idle",
    data: [],
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isCompleting, setIsCompleting] = useState(false);
  const goalLabels = useMemo(
    () => new Map(copy.goals.map((option) => [option.value, option.label])),
    [copy.goals],
  );
  const horizonLabels = useMemo(
    () => new Map(copy.horizons.map((option) => [option.value, option.label])),
    [copy.horizons],
  );
  const riskLabels = useMemo(
    () => new Map(copy.risks.map((option) => [option.value, option.label])),
    [copy.risks],
  );
  const liquidityLabels = useMemo(
    () => new Map(copy.liquidity.map((option) => [option.value, option.label])),
    [copy.liquidity],
  );

  useEffect(() => {
    if (localeHydrated) document.title = copy.pageTitle;
  }, [copy.pageTitle, localeHydrated]);

  useEffect(() => {
    let active = true;
    const adapter = createLocalOnboardingDraftAdapter(
      window.localStorage,
      featuredInstruments,
    );
    adapterRef.current = adapter;

    void adapter
      .load()
      .then((saved) => {
        if (!active) return;
        if (saved) setDraft(saved);
        setSaveState("saved");
        setHydrated(true);
      })
      .catch(() => {
        if (!active) return;
        setSaveState("error");
        setHydrated(true);
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!hydrated || !adapterRef.current) return;
    const adapter = adapterRef.current;
    const timer = window.setTimeout(() => {
      void adapter
        .save(draft)
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"));
    }, 350);

    return () => window.clearTimeout(timer);
  }, [draft, hydrated]);

  useEffect(() => {
    if (!hydrated) return;
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }, [draft.currentStep, hydrated]);

  useEffect(() => {
    const normalizedQuery = query.trim();
    if (!normalizedQuery) return;

    const controller = new AbortController();
    let stopped = false;
    const timer = window.setTimeout(() => {
      setCatalogSearch((current) => ({
        ...current,
        query: normalizedQuery,
        phase: "loading",
        error: undefined,
      }));
      void fetch(
        `/api/assets/search?q=${encodeURIComponent(normalizedQuery)}&limit=20`,
        {
          cache: "no-store",
          credentials: "same-origin",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        },
      )
        .then(async (response) => {
          const body = (await response.json().catch(() => null)) as
            | {
                data?: Array<{
                  symbolId?: unknown;
                  symbol?: unknown;
                  exchange?: unknown;
                  name?: unknown;
                }>;
                meta?: {
                  catalogAsOf?: unknown;
                  freshness?: { state?: unknown };
                };
                error?: unknown;
              }
            | null;
          if (!response.ok) {
            throw new Error("catalog-search-unavailable");
          }
          const data = Array.isArray(body?.data)
            ? body.data.flatMap((candidate): OnboardingInstrument[] => {
                const id =
                  typeof candidate.symbolId === "string"
                    ? candidate.symbolId.trim().toUpperCase()
                    : "";
                const ticker =
                  typeof candidate.symbol === "string"
                    ? candidate.symbol.trim().toUpperCase()
                    : "";
                const exchange =
                  typeof candidate.exchange === "string"
                    ? candidate.exchange.trim().toUpperCase()
                    : "";
                const name =
                  typeof candidate.name === "string"
                    ? candidate.name.trim()
                    : "";
                if (
                  !/^[A-Z0-9._-]+:[A-Z0-9._-]+$/.test(id) ||
                  !ticker ||
                  !exchange ||
                  `${exchange}:${ticker}` !== id ||
                  !name
                ) {
                  return [];
                }
                return [{
                  id: id as CanonicalSymbol,
                  ticker,
                  exchange,
                  name,
                  sector: null,
                  currency: "USD",
                }];
              })
            : [];
          if (stopped) return;
          setCatalogSearch({
            query: normalizedQuery,
            phase: "ready",
            data,
            catalogAsOf:
              typeof body?.meta?.catalogAsOf === "string"
                ? body.meta.catalogAsOf
                : undefined,
            freshness:
              body?.meta?.freshness?.state === "stale" ? "stale" : "fresh",
          });
        })
        .catch((error) => {
          if (stopped || controller.signal.aborted) return;
          setCatalogSearch({
            query: normalizedQuery,
            phase: "error",
            data: [],
            error:
              error instanceof Error
                ? error.message
                : "catalog-search-unavailable",
          });
        });
    }, 250);

    return () => {
      stopped = true;
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  const selectedStocks = useMemo(
    () => {
      const selectedById = new Map(
        draft.instruments.map((instrument) => [instrument.id, instrument]),
      );
      return draft.symbols.flatMap((symbol) => {
        const instrument = selectedById.get(symbol);
        return instrument ? [instrument] : [];
      });
    },
    [draft.instruments, draft.symbols],
  );

  const normalizedQuery = query.trim();
  const catalogMatchesQuery = catalogSearch.query === normalizedQuery;
  const activeCatalogPhase = normalizedQuery
    ? catalogMatchesQuery
      ? catalogSearch.phase
      : "loading"
    : "idle";
  const visibleStocks = normalizedQuery
    ? catalogMatchesQuery
      ? catalogSearch.data
      : []
    : featuredInstruments;
  const selectedInstrumentById = useMemo(
    () => new Map(selectedStocks.map((instrument) => [instrument.id, instrument])),
    [selectedStocks],
  );

  const ownedPositions = draft.positions.filter((position) => position.owned);

  const updateDraft = useCallback(
    (updater: (current: OnboardingDraft) => OnboardingDraft) => {
      setSaveState("saving");
      setErrors({});
      setDraft((current) => ({
        ...updater(current),
        updatedAt: new Date().toISOString(),
        completedAt: null,
      }));
    },
    [],
  );

  function toggleInstrument(instrument: OnboardingInstrument) {
    const symbolId = instrument.id;
    updateDraft((current) => {
      if (current.symbols.includes(symbolId)) {
        return {
          ...current,
          symbols: current.symbols.filter((symbol) => symbol !== symbolId),
          instruments: current.instruments.filter(
            (candidate) => candidate.id !== symbolId,
          ),
          positions: current.positions.filter(
            (position) => position.symbolId !== symbolId,
          ),
        };
      }
      if (current.symbols.length >= ONBOARDING_MAX_SYMBOLS) return current;
      return {
        ...current,
        symbols: [...current.symbols, symbolId],
        instruments: [
          ...current.instruments.filter(
            (candidate) => candidate.id !== symbolId,
          ),
          instrument,
        ],
      };
    });
  }

  function updatePosition(
    symbolId: CanonicalSymbol,
    patch: Partial<OnboardingPosition>,
  ) {
    updateDraft((current) => {
      const existing = positionFor(current, symbolId);
      const next = { ...existing, ...patch, symbolId };
      const positions = current.positions.some(
        (position) => position.symbolId === symbolId,
      )
        ? current.positions.map((position) =>
            position.symbolId === symbolId ? next : position,
          )
        : [...current.positions, next];
      return { ...current, positions, holdingsSkipped: false };
    });
  }

  function toggleGoal(goal: OnboardingGoal) {
    updateDraft((current) => {
      const selected = current.goals.includes(goal);
      if (!selected && current.goals.length >= 3) return current;
      return {
        ...current,
        goals: selected
          ? current.goals.filter((candidate) => candidate !== goal)
          : [...current.goals, goal],
        preferencesSkipped: false,
      };
    });
  }

  function setStep(step: OnboardingStep) {
    if (step > draft.highestStep) return;
    updateDraft((current) => ({ ...current, currentStep: step }));
  }

  function focusError(id: string) {
    window.requestAnimationFrame(() => document.getElementById(id)?.focus());
  }

  function validateCurrentStep() {
    const nextErrors: Record<string, string> = {};

    if (draft.currentStep === 0 && draft.symbols.length === 0) {
      nextErrors.stocks = copy.validation.stocks;
    }

    if (draft.currentStep === 1) {
      for (const position of ownedPositions) {
        const instrument = selectedInstrumentById.get(position.symbolId);
        if (!isValidShareQuantity(position.shares)) {
          nextErrors[`shares-${position.symbolId}`] = copy.validation.shares(
            instrument?.ticker ?? position.symbolId,
          );
        }
        if (position.averageCost && !isValidAverageCost(position.averageCost)) {
          nextErrors[`cost-${position.symbolId}`] = copy.validation.averageCost(
            instrument?.ticker ?? position.symbolId,
          );
        }
      }
    }

    if (draft.currentStep === 2 && !draft.preferencesSkipped) {
      if (draft.goals.length === 0) {
        nextErrors.goals = copy.validation.goals;
      }
      if (!draft.horizon) nextErrors.horizon = copy.validation.horizon;
      if (!draft.riskProfile) nextErrors.risk = copy.validation.risk;
      if (!draft.liquidityNeed) {
        nextErrors.liquidity = copy.validation.liquidity;
      }
    }

    setErrors(nextErrors);
    const firstError = Object.keys(nextErrors)[0];
    if (firstError) focusError(firstError);
    return Object.keys(nextErrors).length === 0;
  }

  function continueSetup() {
    if (!validateCurrentStep() || draft.currentStep === 3) return;
    const nextStep = (draft.currentStep + 1) as OnboardingStep;
    updateDraft((current) => ({
      ...current,
      currentStep: nextStep,
      highestStep: Math.max(current.highestStep, nextStep) as OnboardingStep,
    }));
  }

  function goBack() {
    if (draft.currentStep === 0) return;
    updateDraft((current) => ({
      ...current,
      currentStep: (current.currentStep - 1) as OnboardingStep,
    }));
  }

  function skipHoldings() {
    updateDraft((current) => ({
      ...current,
      holdingsSkipped: true,
      currentStep: 2,
      highestStep: Math.max(current.highestStep, 2) as OnboardingStep,
    }));
  }

  function skipPreferences() {
    updateDraft((current) => ({
      ...current,
      goals: [],
      horizon: null,
      riskProfile: null,
      liquidityNeed: null,
      preferencesSkipped: true,
      currentStep: 3,
      highestStep: 3,
    }));
  }

  async function skipSetup() {
    if (adapterRef.current) {
      await adapterRef.current.save(draft).catch(() => undefined);
    }
    router.push("/dashboard");
  }

  async function completeSetup() {
    if (!adapterRef.current || isCompleting) return;
    setIsCompleting(true);
    setSaveState("saving");
    try {
      if (isAuthenticated) {
        const response = await fetch("/api/onboarding/complete", {
          method: "POST",
          cache: "no-store",
          credentials: "same-origin",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify(draft),
        });
        if (!response.ok) {
          throw new Error("onboarding-sync-failed");
        }
      }
      const completed = await adapterRef.current.complete(draft, {
        publishDashboardPreferences: !isAuthenticated,
      });
      setDraft(completed);
      setSaveState("saved");
      router.push("/dashboard");
    } catch {
      setSaveState("error");
      setErrors({
        complete: isAuthenticated
          ? copy.validation.syncFailed
          : copy.validation.saveFailed,
      });
      focusError("complete");
    } finally {
      setIsCompleting(false);
    }
  }

  function renderStep() {
    if (draft.currentStep === 0) {
      return (
        <div className={styles.stepBody}>
          <div className={styles.searchBox}>
            <Search size={17} aria-hidden="true" />
            <input
              id="stocks"
              type="search"
              maxLength={64}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={copy.search.placeholder}
              aria-label={copy.search.aria}
              aria-describedby={errors.stocks ? "stocks-error" : "stock-search-note"}
              aria-invalid={Boolean(errors.stocks)}
            />
            <span>{draft.symbols.length}/{ONBOARDING_MAX_SYMBOLS}</span>
          </div>
          <p id="stock-search-note" className={styles.fieldNote}>
            {copy.search.note}
          </p>
          {activeCatalogPhase === "loading" && (
            <p className={styles.fieldNote} role="status">
              <LoaderCircle size={13} className={styles.spinner} /> {copy.search.searching}
            </p>
          )}
          {activeCatalogPhase === "ready" && catalogSearch.freshness === "stale" && (
            <p className={styles.fieldNote} role="status">
              {copy.search.stale}
            </p>
          )}
          {activeCatalogPhase === "error" && (
            <p className={styles.fieldError} role="alert">
              {copy.search.errorAlert}
            </p>
          )}
          {errors.stocks && <p id="stocks-error" className={styles.fieldError}>{errors.stocks}</p>}

          {draft.symbols.length > 0 && (
            <div className={styles.selectedSection}>
              <div className={styles.miniHeading}>
                <span>{copy.search.selected}</span><small>{copy.search.selectedCount(draft.symbols.length)}</small>
              </div>
              <div className={styles.selectedChips}>
                {selectedStocks.map((instrument) => (
                  <button
                    type="button"
                    key={instrument.id}
                    onClick={() => toggleInstrument(instrument)}
                    aria-label={copy.search.remove(instrument.ticker)}
                  >
                    <span>{instrument.ticker}</span><Trash2 size={12} />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className={styles.stockResults} aria-label={normalizedQuery ? copy.search.matchesAria : copy.search.featuredAria}>
            {visibleStocks.length > 0 ? (
              visibleStocks.map((instrument) => {
                const selected = draft.symbols.includes(instrument.id);
                return (
                  <button
                    type="button"
                    key={instrument.id}
                    className={selected ? styles.stockSelected : undefined}
                    aria-pressed={selected}
                    onClick={() => toggleInstrument(instrument)}
                  >
                    <StockIdentity instrument={instrument} />
                    <span className={styles.stockMeta}>
                      <small>{instrument.exchange}{instrument.sector ? ` · ${instrument.sector}` : ""}</small>
                      <span className={styles.selectionMark}>
                        {selected ? <Check size={14} /> : <span>+</span>}
                      </span>
                    </span>
                  </button>
                );
              })
            ) : activeCatalogPhase === "loading" ? (
              <div className={styles.noResults} role="status">
                <LoaderCircle className={styles.spinner} size={18} />
                <div><strong>{copy.search.searchingTitle}</strong><span>{copy.search.searchingBody}</span></div>
              </div>
            ) : activeCatalogPhase === "error" ? (
              <div className={styles.noResults}>
                <Search size={18} />
                <div><strong>{copy.search.unavailableTitle}</strong><span>{copy.search.unavailableBody}</span></div>
              </div>
            ) : (
              <div className={styles.noResults}>
                <Search size={18} />
                <div><strong>{copy.search.noMatchTitle}</strong><span>{copy.search.noMatchBody}</span></div>
              </div>
            )}
          </div>
        </div>
      );
    }

    if (draft.currentStep === 1) {
      return (
        <div className={styles.stepBody}>
          <div className={styles.privacyNotice}>
            <LockKeyhole size={17} />
            <div>
              <strong>{copy.holdings.privacyTitle}</strong>
              <span>{copy.holdings.privacyBody}</span>
            </div>
          </div>

          <div className={styles.holdingList}>
            {selectedStocks.map((instrument) => {
              const position = positionFor(draft, instrument.id);
              const sharesError = errors[`shares-${instrument.id}`];
              const costError = errors[`cost-${instrument.id}`];
              return (
                <article className={styles.holdingCard} key={instrument.id}>
                  <div className={styles.holdingTop}>
                    <StockIdentity instrument={instrument} />
                    <button
                      type="button"
                      role="switch"
                      aria-checked={position.owned}
                      className={position.owned ? styles.ownershipActive : styles.ownershipToggle}
                      onClick={() =>
                        updatePosition(instrument.id, {
                          owned: !position.owned,
                          shares: position.owned ? "" : position.shares,
                          averageCost: position.owned ? "" : position.averageCost,
                        })
                      }
                    >
                      <span aria-hidden="true" />
                      {position.owned ? copy.holdings.owned : copy.holdings.watchOnly}
                    </button>
                  </div>

                  <AnimatePresence initial={false}>
                    {position.owned && (
                      <motion.div
                        className={styles.positionFields}
                        initial={reduceMotion ? false : { opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        exit={reduceMotion ? undefined : { opacity: 0, height: 0 }}
                        transition={{ duration: reduceMotion ? 0 : 0.18 }}
                      >
                        <label>
                          <span>{copy.holdings.shares} <strong>{copy.holdings.required}</strong></span>
                          <input
                            id={`shares-${instrument.id}`}
                            inputMode="decimal"
                            autoComplete="off"
                            value={position.shares}
                            onChange={(event) =>
                              updatePosition(instrument.id, {
                                shares: cleanNumericInput(event.target.value, 6),
                              })
                            }
                            placeholder="0"
                            aria-invalid={Boolean(sharesError)}
                            aria-describedby={sharesError ? `shares-error-${instrument.ticker}` : undefined}
                          />
                          {sharesError && <small id={`shares-error-${instrument.ticker}`} className={styles.fieldError}>{sharesError}</small>}
                        </label>
                        <label>
                          <span>{copy.holdings.averageCost} <em>{copy.holdings.optional}</em></span>
                          <div className={styles.currencyInput}>
                            <span>$</span>
                            <input
                              id={`cost-${instrument.id}`}
                              inputMode="decimal"
                              autoComplete="off"
                              value={position.averageCost}
                              onChange={(event) =>
                                updatePosition(instrument.id, {
                                  averageCost: cleanNumericInput(event.target.value, 6),
                                })
                              }
                              placeholder="0.00"
                              aria-invalid={Boolean(costError)}
                              aria-describedby={costError ? `cost-error-${instrument.ticker}` : undefined}
                            />
                          </div>
                          {costError && <small id={`cost-error-${instrument.ticker}`} className={styles.fieldError}>{costError}</small>}
                        </label>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </article>
              );
            })}
          </div>

          <div className={styles.contextNote}>
            <CircleDollarSign size={16} />
            <p>{copy.holdings.contextNote}</p>
          </div>
        </div>
      );
    }

    if (draft.currentStep === 2) {
      return (
        <div className={styles.stepBody}>
          <fieldset
            id="goals"
            tabIndex={-1}
            className={styles.choiceSection}
            aria-describedby={errors.goals ? "goals-error" : "goals-note"}
          >
            <legend>{copy.preferences.goalsLegend}</legend>
            <div className={styles.legendMeta}><span id="goals-note">{copy.preferences.chooseUpToThree}</span><small>{draft.goals.length}/3</small></div>
            {errors.goals && <p id="goals-error" className={styles.fieldError}>{errors.goals}</p>}
            <div className={styles.goalGrid}>
              {copy.goals.map((option) => {
                const checked = draft.goals.includes(option.value);
                const disabled = !checked && draft.goals.length >= 3;
                return (
                  <label className={checked ? styles.choiceSelected : styles.choiceCard} key={option.value}>
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleGoal(option.value)}
                    />
                    <span className={styles.checkboxMark}>{checked && <Check size={13} />}</span>
                    <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          <fieldset id="horizon" tabIndex={-1} className={styles.choiceSection}>
            <legend>{copy.preferences.horizonLegend}</legend>
            <p>{copy.preferences.horizonPrompt}</p>
            {errors.horizon && <p className={styles.fieldError}>{errors.horizon}</p>}
            <div className={styles.segmentedChoices}>
              {copy.horizons.map((option) => (
                <label key={option.value} data-selected={draft.horizon === option.value}>
                  <input
                    type="radio"
                    name="horizon"
                    value={option.value}
                    checked={draft.horizon === option.value}
                    onChange={() =>
                      updateDraft((current) => ({
                        ...current,
                        horizon: option.value,
                        preferencesSkipped: false,
                      }))
                    }
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset id="risk" tabIndex={-1} className={styles.choiceSection}>
            <legend>{copy.preferences.riskLegend}</legend>
            <p>{copy.preferences.riskPrompt}</p>
            {errors.risk && <p className={styles.fieldError}>{errors.risk}</p>}
            <div className={styles.radioCards}>
              {copy.risks.map((option) => (
                <label key={option.value} data-selected={draft.riskProfile === option.value}>
                  <input
                    type="radio"
                    name="risk-profile"
                    value={option.value}
                    checked={draft.riskProfile === option.value}
                    onChange={() =>
                      updateDraft((current) => ({
                        ...current,
                        riskProfile: option.value,
                        preferencesSkipped: false,
                      }))
                    }
                  />
                  <span className={styles.radioMark} />
                  <span><strong>{option.label}</strong><small>{option.detail}</small></span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset id="liquidity" tabIndex={-1} className={styles.choiceSection}>
            <legend>{copy.preferences.liquidityLegend}</legend>
            <p>{copy.preferences.liquidityPrompt}</p>
            {errors.liquidity && <p className={styles.fieldError}>{errors.liquidity}</p>}
            <div className={styles.segmentedChoices}>
              {copy.liquidity.map((option) => (
                <label key={option.value} data-selected={draft.liquidityNeed === option.value}>
                  <input
                    type="radio"
                    name="liquidity"
                    value={option.value}
                    checked={draft.liquidityNeed === option.value}
                    onChange={() =>
                      updateDraft((current) => ({
                        ...current,
                        liquidityNeed: option.value,
                        preferencesSkipped: false,
                      }))
                    }
                  />
                  <span>{option.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className={styles.researchBoundary}>
            <ShieldCheck size={17} />
            <p><strong>{copy.preferences.boundaryTitle}</strong> {copy.preferences.boundaryBody}</p>
          </div>
        </div>
      );
    }

    return (
      <div className={styles.stepBody}>
        {errors.complete && (
          <div id="complete" tabIndex={-1} role="alert" className={styles.completionError}>
            {errors.complete}
          </div>
        )}

        <section className={styles.reviewHero}>
          <span className={styles.reviewIcon}><CheckCircle2 size={24} /></span>
          <div>
            <span>{copy.review.complete}</span>
            <h2>{copy.review.title(draft.symbols.length)}</h2>
            <p>{copy.review.body}</p>
          </div>
        </section>

        <div className={styles.reviewGrid}>
          <section className={styles.reviewCard}>
            <div className={styles.reviewCardHeading}>
              <div><Eye size={16} /><span>{copy.review.watchlist}</span></div>
              <button type="button" onClick={() => setStep(0)}>{copy.review.edit}</button>
            </div>
            <div className={styles.reviewSymbols}>
              {selectedStocks.map((instrument) => (
                <span key={instrument.id}>{instrument.ticker}</span>
              ))}
            </div>
          </section>

          <section className={styles.reviewCard}>
            <div className={styles.reviewCardHeading}>
              <div><WalletCards size={16} /><span>{copy.review.holdings}</span></div>
              <button type="button" onClick={() => setStep(1)}>{copy.review.edit}</button>
            </div>
            {ownedPositions.length > 0 ? (
              <ul className={styles.reviewList}>
                {ownedPositions.map((position) => (
                  <li key={position.symbolId}>
                    <strong>{selectedInstrumentById.get(position.symbolId)?.ticker}</strong>
                    <span>{copy.review.position(position.shares, position.averageCost)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.reviewEmpty}>{copy.review.noPositions}</p>
            )}
          </section>

          <section className={`${styles.reviewCard} ${styles.reviewWide}`}>
            <div className={styles.reviewCardHeading}>
              <div><Target size={16} /><span>{copy.review.priorities}</span></div>
              <button type="button" onClick={() => setStep(2)}>{copy.review.edit}</button>
            </div>
            {draft.preferencesSkipped ? (
              <p className={styles.reviewEmpty}>{copy.review.neutral}</p>
            ) : (
              <div className={styles.preferenceSummary}>
                <div><span>{copy.review.goals}</span><strong>{draft.goals.map((goal) => goalLabels.get(goal)).join(" · ")}</strong></div>
                <div><span>{copy.review.horizon}</span><strong>{draft.horizon ? horizonLabels.get(draft.horizon) : copy.preview.notSet}</strong></div>
                <div><span>{copy.review.risk}</span><strong>{draft.riskProfile ? riskLabels.get(draft.riskProfile) : copy.preview.notSet}</strong></div>
                <div><span>{copy.review.liquidity}</span><strong>{draft.liquidityNeed ? liquidityLabels.get(draft.liquidityNeed) : copy.preview.notSet}</strong></div>
              </div>
            )}
          </section>
        </div>

        <div className={styles.localStorageCard}>
          {isAuthenticated ? <ShieldCheck size={18} /> : <LockKeyhole size={18} />}
          <div>
            <strong>{isAuthenticated ? copy.review.authenticatedTitle : copy.review.localTitle}</strong>
            <p>
              {isAuthenticated
                ? copy.review.authenticatedBody
                : copy.review.localBody}
            </p>
          </div>
          <span>{isAuthenticated ? copy.review.accountBadge : copy.review.localBadge}</span>
        </div>
      </div>
    );
  }

  const currentStep = copy.steps[draft.currentStep];
  const hasAnyPreferences =
    draft.goals.length > 0 ||
    Boolean(draft.horizon || draft.riskProfile || draft.liquidityNeed);

  if (!localeHydrated || !hydrated) {
    return (
      <main
        className={styles.loadingShell}
        lang={locale}
        data-locale={locale}
        data-hydrated="false"
        aria-busy="true"
      >
        <BrandMark />
        <LoaderCircle className={styles.spinner} size={20} />
        <strong>{copy.loading.title}</strong>
        <span>{copy.loading.subtitle}</span>
      </main>
    );
  }

  return (
    <main
      className={styles.shell}
      lang={locale}
      data-locale={locale}
      data-hydrated="true"
    >
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label={copy.chrome.homeAria}>
          <BrandMark />
          <span>OMNIGAZE</span>
          <small>{copy.chrome.alpha}</small>
        </Link>
        <div className={styles.headerProgress} aria-label={copy.chrome.progressAria(draft.currentStep + 1, copy.steps.length)}>
          <span>{copy.chrome.progress(draft.currentStep + 1, copy.steps.length)}</span>
          <div><i style={{ width: `${((draft.currentStep + 1) / copy.steps.length) * 100}%` }} /></div>
        </div>
        <div className={styles.headerActions}>
          <span className={`${styles.saveStatus} ${styles[saveState]}`} role="status" aria-live="polite">
            {saveState === "restoring" || saveState === "saving" ? <LoaderCircle size={13} /> : saveState === "error" ? <span>!</span> : <Check size={13} />}
            {saveState === "restoring"
              ? copy.chrome.restoring
              : saveState === "saving"
                ? copy.chrome.saving
                : saveState === "error"
                  ? copy.chrome.saveError
                  : copy.chrome.saved}
          </span>
          <OnboardingLocaleToggle onLocaleChange={() => setErrors({})} />
          <Link href="/">{copy.chrome.exit}</Link>
        </div>
      </header>

      <div className={styles.layout}>
        <nav className={styles.stepRail} aria-label={copy.chrome.railAria}>
          <span className={styles.railEyebrow}>{copy.chrome.railEyebrow}</span>
          <ol>
            {copy.steps.map((step, index) => {
              const available = index <= draft.highestStep;
              const active = index === draft.currentStep;
              const complete = index < draft.highestStep || draft.completedAt;
              return (
                <li key={step.shortTitle}>
                  <button
                    type="button"
                    disabled={!available}
                    aria-current={active ? "step" : undefined}
                    onClick={() => setStep(index as OnboardingStep)}
                  >
                    <span>{complete && !active ? <Check size={13} /> : index + 1}</span>
                    <span><strong>{step.shortTitle}</strong><small>{step.eyebrow.toLowerCase()}</small></span>
                  </button>
                </li>
              );
            })}
          </ol>
          <div className={styles.railTrust}>
            <LockKeyhole size={15} />
            <span><strong>{copy.chrome.localTitle}</strong>{copy.chrome.localBody}</span>
          </div>
        </nav>

        <section className={styles.workspace}>
          <div className={styles.stepHeading}>
            <span>{currentStep.eyebrow}</span>
            <h1 ref={headingRef} tabIndex={-1}>{currentStep.title}</h1>
            <p>{currentStep.description}</p>
          </div>

          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={draft.currentStep}
              className={styles.motionStep}
              initial={reduceMotion ? false : { opacity: 0, x: 18 }}
              animate={{ opacity: 1, x: 0 }}
              exit={reduceMotion ? undefined : { opacity: 0, x: -12 }}
              transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
            >
              {renderStep()}
            </motion.div>
          </AnimatePresence>

          <div className={styles.actionBar}>
            <div>
              {draft.currentStep > 0 && (
                <button type="button" className={styles.backButton} onClick={goBack}>
                  <ArrowLeft size={15} /> {copy.actions.back}
                </button>
              )}
            </div>
            <div className={styles.actionGroup}>
              {draft.currentStep === 0 && (
                <button type="button" className={styles.skipButton} onClick={() => void skipSetup()}>
                  {copy.actions.skipSetup}
                </button>
              )}
              {draft.currentStep === 1 && ownedPositions.length === 0 && (
                <button type="button" className={styles.skipButton} onClick={skipHoldings}>
                  {copy.actions.skipHoldings}
                </button>
              )}
              {draft.currentStep === 2 && !hasAnyPreferences && (
                <button type="button" className={styles.skipButton} onClick={skipPreferences}>
                  {copy.actions.neutralDefaults}
                </button>
              )}
              {draft.currentStep < 3 ? (
                <button type="button" className={styles.primaryButton} onClick={continueSetup}>
                  {copy.actions.continue} <ArrowRight size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={isCompleting}
                  onClick={() => void completeSetup()}
                >
                  {isCompleting ? <LoaderCircle className={styles.spinner} size={15} /> : <Sparkles size={15} />}
                  {copy.actions.buildDashboard}
                </button>
              )}
            </div>
          </div>
        </section>

        <SetupPreview draft={draft} />
      </div>
    </main>
  );
}
