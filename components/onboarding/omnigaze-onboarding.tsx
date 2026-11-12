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
import { stockWorkspaces } from "@/lib/demo-market-data";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  createEmptyOnboardingDraft,
  createLocalOnboardingDraftAdapter,
  type OnboardingDraft,
  type OnboardingDraftAdapter,
  type OnboardingGoal,
  type OnboardingHorizon,
  type OnboardingLiquidityNeed,
  type OnboardingInstrument,
  type OnboardingPosition,
  type OnboardingRiskProfile,
  type OnboardingStep,
  ONBOARDING_MAX_SYMBOLS,
} from "@/lib/onboarding-draft";
import {
  isPortfolioDecimal,
  MAX_AVERAGE_COST_MICROS,
  MAX_QUANTITY_MICROS,
} from "@/lib/portfolio/decimal";
import styles from "./omnigaze-onboarding.module.css";

const steps = [
  {
    eyebrow: "YOUR MARKET",
    title: "Choose the stocks that matter to you",
    shortTitle: "Stocks",
    description:
      "Start with a focused watchlist. You can add or remove companies any time from the dashboard.",
  },
  {
    eyebrow: "YOUR CONTEXT",
    title: "Which of these do you own?",
    shortTitle: "Holdings",
    description:
      "Position details help Omnigaze frame concentration and exposure. They never authorize trades.",
  },
  {
    eyebrow: "YOUR PRIORITIES",
    title: "What should Omnigaze prioritize?",
    shortTitle: "Preferences",
    description:
      "Set the research lens for your feed. These choices rank context; they do not create trade recommendations.",
  },
  {
    eyebrow: "READY TO GO",
    title: "Your market, ready",
    shortTitle: "Review",
    description:
      "Review what will shape your workspace, then open your personalized dashboard.",
  },
] as const;

const goalOptions: Array<{
  value: OnboardingGoal;
  label: string;
  detail: string;
}> = [
  {
    value: "material-changes",
    label: "Stay ahead of material changes",
    detail: "Prioritize filings, guidance, and events that change the picture.",
  },
  {
    value: "downside-risk",
    label: "Monitor downside risk",
    detail: "Bring emerging contradictions and governance risks forward.",
  },
  {
    value: "long-term-thesis",
    label: "Track a long-term thesis",
    detail: "Connect new evidence to the durable drivers you care about.",
  },
  {
    value: "earnings-prep",
    label: "Prepare for earnings",
    detail: "Surface expectations, changes, and unresolved questions.",
  },
  {
    value: "portfolio-context",
    label: "Understand portfolio context",
    detail: "Keep concentration and cross-company signals visible.",
  },
];

const horizonOptions: Array<{
  value: OnboardingHorizon;
  label: string;
}> = [
  { value: "days-weeks", label: "Days to weeks" },
  { value: "months", label: "Several months" },
  { value: "one-three-years", label: "1–3 years" },
  { value: "three-plus-years", label: "3+ years" },
];

const riskOptions: Array<{
  value: OnboardingRiskProfile;
  label: string;
  detail: string;
}> = [
  {
    value: "early-warning",
    label: "Early warning",
    detail: "Show meaningful risks while evidence is still developing.",
  },
  {
    value: "balanced",
    label: "Balanced",
    detail: "Balance emerging signals with confirmed material changes.",
  },
  {
    value: "material-only",
    label: "Material changes only",
    detail: "Keep attention on the highest-consequence developments.",
  },
  {
    value: "prefer-not-to-say",
    label: "Prefer not to say",
    detail: "Use Omnigaze's neutral materiality-first ranking.",
  },
];

const liquidityOptions: Array<{
  value: OnboardingLiquidityNeed;
  label: string;
}> = [
  { value: "none-near-term", label: "No expected near-term need" },
  { value: "within-twelve-months", label: "Possible need within 12 months" },
  { value: "ongoing", label: "Ongoing liquidity needs" },
  { value: "prefer-not-to-say", label: "Prefer not to say" },
];

const goalLabels = new Map(goalOptions.map((option) => [option.value, option.label]));
const horizonLabels = new Map(
  horizonOptions.map((option) => [option.value, option.label]),
);
const riskLabels = new Map(riskOptions.map((option) => [option.value, option.label]));
const liquidityLabels = new Map(
  liquidityOptions.map((option) => [option.value, option.label]),
);

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
  const selectedById = new Map(
    draft.instruments.map((instrument) => [instrument.id, instrument]),
  );
  const selected = draft.symbols.flatMap((symbol) => {
    const instrument = selectedById.get(symbol);
    return instrument ? [instrument] : [];
  });
  const owned = draft.positions.filter((position) => position.owned);

  return (
    <aside className={styles.preview} aria-label="Personalization preview">
      <div className={styles.previewHeading}>
        <span className={styles.previewOrb}><Sparkles size={17} /></span>
        <div>
          <span>PERSONALIZATION PREVIEW</span>
          <strong>Your Omnigaze workspace</strong>
        </div>
      </div>

      <div className={styles.previewWatchlist}>
        <div className={styles.previewLabelRow}>
          <span>WATCHLIST</span>
          <small>{selected.length}/{ONBOARDING_MAX_SYMBOLS}</small>
        </div>
        {selected.length > 0 ? (
          <div className={styles.previewSymbols}>
            {selected.slice(0, 5).map((instrument) => (
              <div key={instrument.id}>
                <span className={styles.stockAvatar}>{instrument.ticker[0]}</span>
                <span><strong>{instrument.ticker}</strong><small>{instrument.sector ?? instrument.exchange}</small></span>
                {owned.some((position) => position.symbolId === instrument.id) && (
                  <span className={styles.ownedBadge}>OWNED</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.previewEmpty}>
            <Eye size={17} />
            <span>Your selected companies will appear here.</span>
          </div>
        )}
      </div>

      <div className={styles.previewSignalGrid}>
        <div>
          <span>Research horizon</span>
          <strong>{draft.horizon ? horizonLabels.get(draft.horizon) : "Not set"}</strong>
        </div>
        <div>
          <span>Holdings added</span>
          <strong>{owned.length}</strong>
        </div>
      </div>

      <div className={styles.previewLens}>
        <span>YOUR RESEARCH LENS</span>
        {draft.goals.length > 0 ? (
          <ul>
            {draft.goals.slice(0, 3).map((goal) => (
              <li key={goal}><Check size={13} />{goalLabels.get(goal)}</li>
            ))}
          </ul>
        ) : (
          <p>Choose goals to explain why an event is relevant to you.</p>
        )}
      </div>

      <div className={styles.previewTrust}>
        <ShieldCheck size={16} />
        <div>
          <strong>Transparent by default</strong>
          <span>Source, freshness, and demo labels remain visible after personalization.</span>
        </div>
      </div>
    </aside>
  );
}

export function OmnigazeOnboarding({
  isAuthenticated = false,
}: OmnigazeOnboardingProps) {
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
            throw new Error(
              typeof body?.error === "string"
                ? body.error
                : "Stock search is temporarily unavailable.",
            );
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
                : "Stock search is temporarily unavailable.",
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
      nextErrors.stocks = "Choose at least one stock to personalize your dashboard.";
    }

    if (draft.currentStep === 1) {
      for (const position of ownedPositions) {
        const instrument = selectedInstrumentById.get(position.symbolId);
        if (!isValidShareQuantity(position.shares)) {
          nextErrors[`shares-${position.symbolId}`] = `Enter a share quantity for ${instrument?.ticker ?? position.symbolId}.`;
        }
        if (position.averageCost && !isValidAverageCost(position.averageCost)) {
          nextErrors[`cost-${position.symbolId}`] = `Enter a valid average cost for ${instrument?.ticker ?? position.symbolId}, or leave it blank.`;
        }
      }
    }

    if (draft.currentStep === 2 && !draft.preferencesSkipped) {
      if (draft.goals.length === 0) {
        nextErrors.goals = "Choose at least one research goal.";
      }
      if (!draft.horizon) nextErrors.horizon = "Choose a research horizon.";
      if (!draft.riskProfile) nextErrors.risk = "Choose a risk sensitivity.";
      if (!draft.liquidityNeed) {
        nextErrors.liquidity = "Choose a liquidity preference.";
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
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        if (!response.ok) {
          throw new Error(body?.error || "Account setup could not be synced.");
        }
      }
      const completed = await adapterRef.current.complete(draft, {
        publishDashboardPreferences: !isAuthenticated,
      });
      setDraft(completed);
      setSaveState("saved");
      router.push("/dashboard");
    } catch (error) {
      setSaveState("error");
      setErrors({
        complete:
          error instanceof Error
            ? `${error.message} Your existing account data was not replaced; retrying is safe.`
            : "We could not save this setup. Your existing account data was not replaced; retrying is safe.",
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
              placeholder="Search any active U.S. stock"
              aria-label="Search active U.S. stocks"
              aria-describedby={errors.stocks ? "stocks-error" : "stock-search-note"}
              aria-invalid={Boolean(errors.stocks)}
            />
            <span>{draft.symbols.length}/{ONBOARDING_MAX_SYMBOLS}</span>
          </div>
          <p id="stock-search-note" className={styles.fieldNote}>
            Search the active U.S. equity catalog. Featured companies appear before you type; no brokerage connection is required.
          </p>
          {activeCatalogPhase === "loading" && (
            <p className={styles.fieldNote} role="status">
              <LoaderCircle size={13} className={styles.spinner} /> Searching the live asset catalog…
            </p>
          )}
          {activeCatalogPhase === "ready" && catalogSearch.freshness === "stale" && (
            <p className={styles.fieldNote} role="status">
              Catalog refresh is delayed; showing the latest verified cached matches.
            </p>
          )}
          {activeCatalogPhase === "error" && (
            <p className={styles.fieldError} role="alert">
              {catalogSearch.error ?? "Stock search is temporarily unavailable."} Your selected companies are still saved.
            </p>
          )}
          {errors.stocks && <p id="stocks-error" className={styles.fieldError}>{errors.stocks}</p>}

          {draft.symbols.length > 0 && (
            <div className={styles.selectedSection}>
              <div className={styles.miniHeading}>
                <span>SELECTED</span><small>{draft.symbols.length} stocks</small>
              </div>
              <div className={styles.selectedChips}>
                {selectedStocks.map((instrument) => (
                  <button
                    type="button"
                    key={instrument.id}
                    onClick={() => toggleInstrument(instrument)}
                    aria-label={`Remove ${instrument.ticker}`}
                  >
                    <span>{instrument.ticker}</span><Trash2 size={12} />
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className={styles.stockResults} aria-label={normalizedQuery ? "Asset catalog matches" : "Featured stocks"}>
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
                <div><strong>Searching the catalog</strong><span>Checking active U.S. equities.</span></div>
              </div>
            ) : activeCatalogPhase === "error" ? (
              <div className={styles.noResults}>
                <Search size={18} />
                <div><strong>Catalog unavailable</strong><span>Try again shortly; your draft is unchanged.</span></div>
              </div>
            ) : (
              <div className={styles.noResults}>
                <Search size={18} />
                <div><strong>No active U.S. equity match</strong><span>Try the full ticker or company name.</span></div>
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
              <strong>Private, optional context</strong>
              <span>Saved only in this browser during the anonymous alpha. Omnigaze cannot place trades.</span>
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
                      {position.owned ? "I own this" : "Watch only"}
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
                          <span>Shares <strong>Required</strong></span>
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
                          <span>Average cost per share <em>Optional</em></span>
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
            <p>Cost basis is used only for position context. Demo prices will never be presented as real portfolio value or profit and loss.</p>
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
            <legend>What brings you back to the market?</legend>
            <div className={styles.legendMeta}><span id="goals-note">Choose up to three</span><small>{draft.goals.length}/3</small></div>
            {errors.goals && <p id="goals-error" className={styles.fieldError}>{errors.goals}</p>}
            <div className={styles.goalGrid}>
              {goalOptions.map((option) => {
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
            <legend>Research horizon</legend>
            <p>Which time frame should contextualize new evidence?</p>
            {errors.horizon && <p className={styles.fieldError}>{errors.horizon}</p>}
            <div className={styles.segmentedChoices}>
              {horizonOptions.map((option) => (
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
            <legend>Risk sensitivity</legend>
            <p>How early should developing risk appear in your feed?</p>
            {errors.risk && <p className={styles.fieldError}>{errors.risk}</p>}
            <div className={styles.radioCards}>
              {riskOptions.map((option) => (
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
            <legend>Liquidity preference</legend>
            <p>Optional context for prioritizing near-term risks.</p>
            {errors.liquidity && <p className={styles.fieldError}>{errors.liquidity}</p>}
            <div className={styles.segmentedChoices}>
              {liquidityOptions.map((option) => (
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
            <p><strong>Research support, not financial advice.</strong> These answers tune ranking and explanation. They never trigger a trade or turn an inference into a fact.</p>
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
            <span>SETUP COMPLETE</span>
            <h2>{draft.symbols.length} stocks, one focused market view</h2>
            <p>Omnigaze will use this context to organize evidence—not to make decisions for you.</p>
          </div>
        </section>

        <div className={styles.reviewGrid}>
          <section className={styles.reviewCard}>
            <div className={styles.reviewCardHeading}>
              <div><Eye size={16} /><span>Watchlist</span></div>
              <button type="button" onClick={() => setStep(0)}>Edit</button>
            </div>
            <div className={styles.reviewSymbols}>
              {selectedStocks.map((instrument) => (
                <span key={instrument.id}>{instrument.ticker}</span>
              ))}
            </div>
          </section>

          <section className={styles.reviewCard}>
            <div className={styles.reviewCardHeading}>
              <div><WalletCards size={16} /><span>Holdings</span></div>
              <button type="button" onClick={() => setStep(1)}>Edit</button>
            </div>
            {ownedPositions.length > 0 ? (
              <ul className={styles.reviewList}>
                {ownedPositions.map((position) => (
                  <li key={position.symbolId}>
                    <strong>{selectedInstrumentById.get(position.symbolId)?.ticker}</strong>
                    <span>{position.shares} shares{position.averageCost ? ` · $${position.averageCost} avg.` : ""}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.reviewEmpty}>No position details added.</p>
            )}
          </section>

          <section className={`${styles.reviewCard} ${styles.reviewWide}`}>
            <div className={styles.reviewCardHeading}>
              <div><Target size={16} /><span>Research priorities</span></div>
              <button type="button" onClick={() => setStep(2)}>Edit</button>
            </div>
            {draft.preferencesSkipped ? (
              <p className={styles.reviewEmpty}>Neutral, materiality-first ranking.</p>
            ) : (
              <div className={styles.preferenceSummary}>
                <div><span>Goals</span><strong>{draft.goals.map((goal) => goalLabels.get(goal)).join(" · ")}</strong></div>
                <div><span>Horizon</span><strong>{draft.horizon ? horizonLabels.get(draft.horizon) : "Not set"}</strong></div>
                <div><span>Risk</span><strong>{draft.riskProfile ? riskLabels.get(draft.riskProfile) : "Not set"}</strong></div>
                <div><span>Liquidity</span><strong>{draft.liquidityNeed ? liquidityLabels.get(draft.liquidityNeed) : "Not set"}</strong></div>
              </div>
            )}
          </section>
        </div>

        <div className={styles.localStorageCard}>
          {isAuthenticated ? <ShieldCheck size={18} /> : <LockKeyhole size={18} />}
          <div>
            <strong>{isAuthenticated ? "Ready to sync safely" : "Saved on this device"}</strong>
            <p>
              {isAuthenticated
                ? "Completing setup adds these stocks and new positions to your account. Existing watchlists and holdings are preserved; research preferences stay on this device for now."
                : "This anonymous alpha stores setup in your browser. You can sign in from the dashboard to sync the watchlist across devices."}
            </p>
          </div>
          <span>{isAuthenticated ? "ACCOUNT" : "LOCAL"}</span>
        </div>
      </div>
    );
  }

  const currentStep = steps[draft.currentStep];
  const hasAnyPreferences =
    draft.goals.length > 0 ||
    Boolean(draft.horizon || draft.riskProfile || draft.liquidityNeed);

  if (!hydrated) {
    return (
      <main className={styles.loadingShell} aria-busy="true">
        <BrandMark />
        <LoaderCircle className={styles.spinner} size={20} />
        <strong>Restoring your Omnigaze setup</strong>
        <span>Saved only on this device</span>
      </main>
    );
  }

  return (
    <main className={styles.shell}>
      <header className={styles.header}>
        <Link href="/" className={styles.brand} aria-label="Omnigaze home">
          <BrandMark />
          <span>OMNIGAZE</span>
          <small>ALPHA</small>
        </Link>
        <div className={styles.headerProgress} aria-label={`Step ${draft.currentStep + 1} of ${steps.length}`}>
          <span>Step {draft.currentStep + 1} of {steps.length}</span>
          <div><i style={{ width: `${((draft.currentStep + 1) / steps.length) * 100}%` }} /></div>
        </div>
        <div className={styles.headerActions}>
          <span className={`${styles.saveStatus} ${styles[saveState]}`} role="status" aria-live="polite">
            {saveState === "restoring" || saveState === "saving" ? <LoaderCircle size={13} /> : saveState === "error" ? <span>!</span> : <Check size={13} />}
            {saveState === "restoring"
              ? "Restoring"
              : saveState === "saving"
                ? "Saving"
                : saveState === "error"
                  ? "Local save unavailable"
                  : "Saved on this device"}
          </span>
          <Link href="/">Exit setup</Link>
        </div>
      </header>

      <div className={styles.layout}>
        <nav className={styles.stepRail} aria-label="Onboarding progress">
          <span className={styles.railEyebrow}>PERSONALIZE OMNIGAZE</span>
          <ol>
            {steps.map((step, index) => {
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
            <span><strong>Local by default</strong>Setup stays in this browser.</span>
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
                  <ArrowLeft size={15} /> Back
                </button>
              )}
            </div>
            <div className={styles.actionGroup}>
              {draft.currentStep === 0 && (
                <button type="button" className={styles.skipButton} onClick={() => void skipSetup()}>
                  Skip setup for now
                </button>
              )}
              {draft.currentStep === 1 && ownedPositions.length === 0 && (
                <button type="button" className={styles.skipButton} onClick={skipHoldings}>
                  Skip holdings
                </button>
              )}
              {draft.currentStep === 2 && !hasAnyPreferences && (
                <button type="button" className={styles.skipButton} onClick={skipPreferences}>
                  Use neutral defaults
                </button>
              )}
              {draft.currentStep < 3 ? (
                <button type="button" className={styles.primaryButton} onClick={continueSetup}>
                  Continue <ArrowRight size={15} />
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.primaryButton}
                  disabled={isCompleting}
                  onClick={() => void completeSetup()}
                >
                  {isCompleting ? <LoaderCircle className={styles.spinner} size={15} /> : <Sparkles size={15} />}
                  Build my dashboard
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
