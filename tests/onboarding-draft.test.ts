import { describe, expect, it } from "vitest";
import type { CanonicalSymbol } from "@/lib/market-types";
import {
  createEmptyOnboardingDraft,
  createLocalOnboardingDraftAdapter,
  DASHBOARD_PREFERENCES_KEY,
  ONBOARDING_DRAFT_KEY,
  parseOnboardingDraft,
  type OnboardingStorage,
} from "@/lib/onboarding-draft";

const supported = [
  "NASDAQ:NVDA",
  "NASDAQ:MSFT",
  "NASDAQ:AMD",
] as const satisfies readonly CanonicalSymbol[];

function memoryStorage(): OnboardingStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  };
}

describe("anonymous onboarding draft", () => {
  it("rejects malformed and unsupported draft versions", () => {
    expect(parseOnboardingDraft("not-json", supported)).toBeNull();
    expect(
      parseOnboardingDraft(JSON.stringify({ version: 99 }), supported),
    ).toBeNull();
  });

  it("restores only supported, deduplicated symbols and safe preferences", () => {
    const parsed = parseOnboardingDraft(
      JSON.stringify({
        version: 1,
        currentStep: 2,
        highestStep: 3,
        symbols: ["NASDAQ:NVDA", "NASDAQ:NVDA", "NYSE:UNKNOWN", "NASDAQ:MSFT"],
        positions: [
          {
            symbolId: "NASDAQ:NVDA",
            owned: true,
            shares: "12.25",
            averageCost: "104.50",
          },
          {
            symbolId: "NYSE:UNKNOWN",
            owned: true,
            shares: "999",
            averageCost: "1",
          },
        ],
        goals: ["material-changes", "material-changes", "not-a-goal"],
        horizon: "one-three-years",
        riskProfile: "balanced",
        liquidityNeed: "prefer-not-to-say",
        holdingsSkipped: false,
        preferencesSkipped: false,
        updatedAt: "2026-11-11T20:00:00.000Z",
        completedAt: null,
      }),
      supported,
    );

    expect(parsed).toMatchObject({
      version: 2,
      currentStep: 2,
      highestStep: 3,
      symbols: ["NASDAQ:NVDA", "NASDAQ:MSFT"],
      goals: ["material-changes"],
      horizon: "one-three-years",
      riskProfile: "balanced",
      liquidityNeed: "prefer-not-to-say",
    });
    expect(parsed?.positions).toEqual([
      {
        symbolId: "NASDAQ:NVDA",
        owned: true,
        shares: "12.25",
        averageCost: "104.50",
      },
    ]);
    expect(parsed?.instruments).toEqual([
      {
        id: "NASDAQ:NVDA",
        ticker: "NVDA",
        exchange: "NASDAQ",
        name: "NVDA",
        sector: null,
        currency: "USD",
      },
      {
        id: "NASDAQ:MSFT",
        ticker: "MSFT",
        exchange: "NASDAQ",
        name: "MSFT",
        sector: null,
        currency: "USD",
      },
    ]);
  });

  it("retains safe arbitrary catalog instruments in v2 and drops mismatched descriptors", () => {
    const parsed = parseOnboardingDraft(
      JSON.stringify({
        version: 2,
        currentStep: 1,
        highestStep: 1,
        symbols: ["NYSE:IBM", "NASDAQ:BAD", "NYSE:IBM"],
        instruments: [
          {
            id: "NYSE:IBM",
            ticker: "IBM",
            exchange: "NYSE",
            name: "International Business Machines Corporation",
            sector: null,
            currency: "USD",
          },
          {
            id: "NASDAQ:BAD",
            ticker: "OTHER",
            exchange: "NYSE",
            name: "Mismatched identity",
            sector: null,
            currency: "USD",
          },
        ],
        positions: [
          {
            symbolId: "NYSE:IBM",
            owned: true,
            shares: "3.5",
            averageCost: "210.25",
          },
        ],
        goals: [],
        horizon: null,
        riskProfile: null,
        liquidityNeed: null,
        holdingsSkipped: false,
        preferencesSkipped: false,
        updatedAt: "2026-11-11T20:00:00.000Z",
        completedAt: null,
      }),
      supported,
    );

    expect(parsed).toMatchObject({
      version: 2,
      symbols: ["NYSE:IBM"],
      instruments: [
        {
          id: "NYSE:IBM",
          ticker: "IBM",
          exchange: "NYSE",
          name: "International Business Machines Corporation",
          currency: "USD",
        },
      ],
      positions: [{ symbolId: "NYSE:IBM", shares: "3.5" }],
    });
  });

  it("persists a resumable draft and hands its watchlist to the dashboard", async () => {
    const storage = memoryStorage();
    const clock = () => new Date("2026-11-11T22:00:00.000Z");
    const adapter = createLocalOnboardingDraftAdapter(storage, supported, clock);
    const draft = {
      ...createEmptyOnboardingDraft("2026-11-11T21:00:00.000Z"),
      currentStep: 3 as const,
      highestStep: 3 as const,
      symbols: ["NASDAQ:NVDA", "NASDAQ:MSFT"] as CanonicalSymbol[],
      instruments: [
        {
          id: "NASDAQ:NVDA" as const,
          ticker: "NVDA",
          exchange: "NASDAQ",
          name: "NVIDIA Corporation",
          sector: "Technology",
          currency: "USD" as const,
        },
        {
          id: "NASDAQ:MSFT" as const,
          ticker: "MSFT",
          exchange: "NASDAQ",
          name: "Microsoft Corporation",
          sector: "Technology",
          currency: "USD" as const,
        },
      ],
    };

    await adapter.save(draft);
    expect(await adapter.load()).toMatchObject({ symbols: draft.symbols });

    const completed = await adapter.complete(draft);
    expect(completed.completedAt).toBe("2026-11-11T22:00:00.000Z");
    expect(JSON.parse(storage.values.get(DASHBOARD_PREFERENCES_KEY) ?? "null"))
      .toEqual({
        version: 2,
        instruments: draft.instruments,
        selectedSymbol: "NASDAQ:NVDA",
        timeframe: "1D",
      });
    expect(storage.values.has(ONBOARDING_DRAFT_KEY)).toBe(true);
  });

  it("does not overwrite an existing dashboard watchlist when setup is skipped", async () => {
    const storage = memoryStorage();
    storage.setItem(DASHBOARD_PREFERENCES_KEY, "existing-dashboard-state");
    const adapter = createLocalOnboardingDraftAdapter(storage, supported);

    await adapter.complete(createEmptyOnboardingDraft());

    expect(storage.getItem(DASHBOARD_PREFERENCES_KEY)).toBe(
      "existing-dashboard-state",
    );
  });
});
