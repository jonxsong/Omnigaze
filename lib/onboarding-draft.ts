import type { CanonicalSymbol } from "@/lib/market-types";

export const ONBOARDING_DRAFT_KEY = "omnigaze:onboarding-draft";
export const ONBOARDING_DRAFT_VERSION = 1;
export const ONBOARDING_MAX_SYMBOLS = 12;
export const DASHBOARD_PREFERENCES_KEY = "omnigaze:dashboard-preferences";

export const onboardingGoals = [
  "material-changes",
  "downside-risk",
  "long-term-thesis",
  "earnings-prep",
  "portfolio-context",
] as const;

export const onboardingHorizons = [
  "days-weeks",
  "months",
  "one-three-years",
  "three-plus-years",
] as const;

export const onboardingRiskProfiles = [
  "early-warning",
  "balanced",
  "material-only",
  "prefer-not-to-say",
] as const;

export const onboardingLiquidityNeeds = [
  "none-near-term",
  "within-twelve-months",
  "ongoing",
  "prefer-not-to-say",
] as const;

export type OnboardingGoal = (typeof onboardingGoals)[number];
export type OnboardingHorizon = (typeof onboardingHorizons)[number];
export type OnboardingRiskProfile = (typeof onboardingRiskProfiles)[number];
export type OnboardingLiquidityNeed = (typeof onboardingLiquidityNeeds)[number];
export type OnboardingStep = 0 | 1 | 2 | 3;

export interface OnboardingPosition {
  symbolId: CanonicalSymbol;
  owned: boolean;
  shares: string;
  averageCost: string;
}

export interface OnboardingDraft {
  version: typeof ONBOARDING_DRAFT_VERSION;
  currentStep: OnboardingStep;
  highestStep: OnboardingStep;
  symbols: CanonicalSymbol[];
  positions: OnboardingPosition[];
  goals: OnboardingGoal[];
  horizon: OnboardingHorizon | null;
  riskProfile: OnboardingRiskProfile | null;
  liquidityNeed: OnboardingLiquidityNeed | null;
  holdingsSkipped: boolean;
  preferencesSkipped: boolean;
  updatedAt: string;
  completedAt: string | null;
}

export interface OnboardingStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface OnboardingDraftAdapter {
  load(): Promise<OnboardingDraft | null>;
  save(draft: OnboardingDraft): Promise<void>;
  complete(
    draft: OnboardingDraft,
    options?: { publishDashboardPreferences?: boolean },
  ): Promise<OnboardingDraft>;
  clear(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOneOf<T extends readonly string[]>(
  options: T,
  value: unknown,
): value is T[number] {
  return typeof value === "string" && options.includes(value as T[number]);
}

function safeText(value: unknown) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 32);
}

function safeIso(value: unknown, fallback: string) {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
    ? value
    : fallback;
}

export function createEmptyOnboardingDraft(
  now = new Date().toISOString(),
): OnboardingDraft {
  return {
    version: ONBOARDING_DRAFT_VERSION,
    currentStep: 0,
    highestStep: 0,
    symbols: [],
    positions: [],
    goals: [],
    horizon: null,
    riskProfile: null,
    liquidityNeed: null,
    holdingsSkipped: false,
    preferencesSkipped: false,
    updatedAt: now,
    completedAt: null,
  };
}

export function parseOnboardingDraft(
  raw: string | null,
  allowedSymbols: readonly CanonicalSymbol[],
  now = new Date().toISOString(),
): OnboardingDraft | null {
  if (!raw) return null;

  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(input) || input.version !== ONBOARDING_DRAFT_VERSION) {
    return null;
  }

  const allowed = new Set(allowedSymbols);
  const symbols = Array.isArray(input.symbols)
    ? Array.from(
        new Set(
          input.symbols.filter(
            (symbol): symbol is CanonicalSymbol =>
              typeof symbol === "string" && allowed.has(symbol as CanonicalSymbol),
          ),
        ),
      ).slice(0, ONBOARDING_MAX_SYMBOLS)
    : [];
  const selected = new Set(symbols);

  const positions = Array.isArray(input.positions)
    ? input.positions
        .filter(isRecord)
        .filter(
          (position) =>
            typeof position.symbolId === "string" &&
            selected.has(position.symbolId as CanonicalSymbol),
        )
        .map((position) => ({
          symbolId: position.symbolId as CanonicalSymbol,
          owned: position.owned === true,
          shares: safeText(position.shares),
          averageCost: safeText(position.averageCost),
        }))
        .filter(
          (position, index, all) =>
            all.findIndex((candidate) => candidate.symbolId === position.symbolId) ===
            index,
        )
    : [];

  const goals = Array.isArray(input.goals)
    ? Array.from(
        new Set(
          input.goals.filter((goal): goal is OnboardingGoal =>
            isOneOf(onboardingGoals, goal),
          ),
        ),
      ).slice(0, 3)
    : [];

  const currentStep: OnboardingStep =
    typeof input.currentStep === "number" &&
    Number.isInteger(input.currentStep) &&
    input.currentStep >= 0 &&
    input.currentStep <= 3
      ? (input.currentStep as OnboardingStep)
      : 0;
  const highestStep: OnboardingStep =
    typeof input.highestStep === "number" &&
    Number.isInteger(input.highestStep) &&
    input.highestStep >= currentStep &&
    input.highestStep <= 3
      ? (input.highestStep as OnboardingStep)
      : currentStep;

  return {
    version: ONBOARDING_DRAFT_VERSION,
    currentStep,
    highestStep,
    symbols,
    positions,
    goals,
    horizon: isOneOf(onboardingHorizons, input.horizon) ? input.horizon : null,
    riskProfile: isOneOf(onboardingRiskProfiles, input.riskProfile)
      ? input.riskProfile
      : null,
    liquidityNeed: isOneOf(onboardingLiquidityNeeds, input.liquidityNeed)
      ? input.liquidityNeed
      : null,
    holdingsSkipped: input.holdingsSkipped === true,
    preferencesSkipped: input.preferencesSkipped === true,
    updatedAt: safeIso(input.updatedAt, now),
    completedAt:
      input.completedAt === null
        ? null
        : safeIso(input.completedAt, now),
  };
}

export function createLocalOnboardingDraftAdapter(
  storage: OnboardingStorage,
  allowedSymbols: readonly CanonicalSymbol[],
  clock: () => Date = () => new Date(),
): OnboardingDraftAdapter {
  return {
    async load() {
      return parseOnboardingDraft(
        storage.getItem(ONBOARDING_DRAFT_KEY),
        allowedSymbols,
        clock().toISOString(),
      );
    },

    async save(draft) {
      storage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(draft));
    },

    async complete(draft, options) {
      const completedAt = clock().toISOString();
      const completed: OnboardingDraft = {
        ...draft,
        currentStep: 3,
        highestStep: 3,
        updatedAt: completedAt,
        completedAt,
      };
      storage.setItem(ONBOARDING_DRAFT_KEY, JSON.stringify(completed));

      if (
        completed.symbols.length > 0 &&
        options?.publishDashboardPreferences !== false
      ) {
        storage.setItem(
          DASHBOARD_PREFERENCES_KEY,
          JSON.stringify({
            version: 1,
            watchlist: completed.symbols,
            selectedSymbol: completed.symbols[0],
            timeframe: "1D",
          }),
        );
      }

      return completed;
    },

    async clear() {
      storage.removeItem(ONBOARDING_DRAFT_KEY);
    },
  };
}
