import { describe, expect, it } from "vitest";
import { formatPortfolioPulsePercent } from "@/components/portfolio-pulse-card";

describe("Portfolio Pulse percent formatting", () => {
  it("rounds positive decimal ties exactly and preserves the signed display", () => {
    expect(formatPortfolioPulsePercent("1.005", true)).toBe("+1.01%");
    expect(formatPortfolioPulsePercent("2.675", true)).toBe("+2.68%");
  });

  it("rounds negative decimal ties symmetrically", () => {
    expect(formatPortfolioPulsePercent("-1.005", true)).toBe("-1.01%");
    expect(formatPortfolioPulsePercent("-2.675", true)).toBe("-2.68%");
  });

  it("retains ordinary canonical and unavailable output", () => {
    expect(formatPortfolioPulsePercent("1.27", true)).toBe("+1.27%");
    expect(formatPortfolioPulsePercent("0", true)).toBe("0.00%");
    expect(formatPortfolioPulsePercent("-0.000001", true)).toBe("0.00%");
    expect(formatPortfolioPulsePercent(null, true)).toBe("—");
  });
});
