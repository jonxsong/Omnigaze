import { describe, expect, it } from "vitest";
import {
  isOnboardingComplete,
  parsePortfolioDecisionSupportRequest,
  parsePortfolioHoldingDeleteQuery,
  parsePortfolioHoldingMutation,
  parsePortfolioProfileMutation,
} from "@/lib/portfolio/contracts";
import {
  decimalToMicros,
  MAX_AVERAGE_COST_MICROS,
  MAX_QUANTITY_MICROS,
  microsToDecimal,
  multiplyMicrosToDecimal,
  PortfolioDecimalError,
} from "@/lib/portfolio/decimal";

describe("portfolio decimal contract", () => {
  it("converts canonical decimal strings without floating-point arithmetic", () => {
    expect(
      decimalToMicros("12.345678", {
        allowZero: false,
        maxMicros: MAX_QUANTITY_MICROS,
      }),
    ).toBe(12_345_678);
    expect(microsToDecimal(12_345_678)).toBe("12.345678");
    expect(microsToDecimal(2_000_000)).toBe("2");
    expect(multiplyMicrosToDecimal(1_500_000, 2_250_000)).toBe("3.375");
  });

  it("rejects non-canonical, over-precision, zero, and oversized quantities", () => {
    for (const value of ["01", "1.", ".5", "1.0000000", "-1", "0"]) {
      expect(() =>
        decimalToMicros(value, {
          allowZero: false,
          maxMicros: MAX_QUANTITY_MICROS,
        }),
      ).toThrow(PortfolioDecimalError);
    }

    expect(() =>
      decimalToMicros("1000000000.000001", {
        allowZero: false,
        maxMicros: MAX_QUANTITY_MICROS,
      }),
    ).toThrow(PortfolioDecimalError);
    expect(
      decimalToMicros("0", {
        allowZero: true,
        maxMicros: MAX_AVERAGE_COST_MICROS,
      }),
    ).toBe(0);
    expect(() =>
      decimalToMicros("1", {
        allowZero: false,
        maxMicros: Number.MAX_VALUE,
      }),
    ).toThrow(PortfolioDecimalError);
  });
});

describe("portfolio request contracts", () => {
  const profile = {
    base_currency: "USD",
    experience_level: "intermediate",
    risk_comfort: "medium",
    time_horizon: "3_to_7y",
    objective: "balanced_growth",
    max_single_position_bps: 2_000,
    expected_version: 0,
  } as const;

  const holding = {
    quantity: "12.5",
    average_cost: "101.125",
    cost_currency: "USD",
    quantity_as_of: "2026-11-11T18:00:00.000Z",
    expected_version: 0,
  } as const;

  it("accepts complete onboarding and rejects caller-supplied identity", () => {
    const parsed = parsePortfolioProfileMutation(profile);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(isOnboardingComplete(parsed.data)).toBe(true);

    expect(
      parsePortfolioProfileMutation({
        ...profile,
        owner_id: "someone-else",
      }).success,
    ).toBe(false);
  });

  it("keeps holding input strict and future-safe", () => {
    expect(parsePortfolioHoldingMutation(holding).success).toBe(true);
    expect(
      parsePortfolioHoldingMutation({
        ...holding,
        quantity: 12.5,
      }).success,
    ).toBe(false);
    expect(
      parsePortfolioHoldingMutation({
        ...holding,
        symbol_id: "NASDAQ:NVDA",
      }).success,
    ).toBe(false);
    expect(
      parsePortfolioHoldingMutation({
        ...holding,
        quantity_as_of: "2099-01-01T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("requires an exact optimistic version for holding deletion", () => {
    expect(
      parsePortfolioHoldingDeleteQuery(
        new URLSearchParams("expected_version=3"),
      ),
    ).toMatchObject({
      success: true,
      data: { expected_version: 3 },
    });
    expect(
      parsePortfolioHoldingDeleteQuery(
        new URLSearchParams("expected_version=0"),
      ).success,
    ).toBe(false);
    expect(
      parsePortfolioHoldingDeleteQuery(
        new URLSearchParams("expected_version=3&owner_id=other"),
      ).success,
    ).toBe(false);
  });

  it("keeps decision support scenario-only and owner-derived", () => {
    expect(
      parsePortfolioDecisionSupportRequest({
        symbol_id: "nasdaq:nvda",
        horizon: "near_term",
        preset: "balanced",
        budget: "2500",
      }),
    ).toMatchObject({
      success: true,
      data: { symbol_id: "NASDAQ:NVDA" },
    });

    expect(
      parsePortfolioDecisionSupportRequest({
        symbol_id: "NASDAQ:NVDA",
        horizon: "near_term",
        preset: "balanced",
        quantity: "100",
        owner_id: "someone-else",
      }).success,
    ).toBe(false);
  });
});
