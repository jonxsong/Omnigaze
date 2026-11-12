import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getChatGPTUser: vi.fn(),
  getPortfolioPulse: vi.fn(),
}));

vi.mock("@/app/chatgpt-auth", () => ({
  getChatGPTUser: mocks.getChatGPTUser,
}));

vi.mock("@/lib/services/portfolio-pulse", () => ({
  getPortfolioPulse: mocks.getPortfolioPulse,
}));

import { GET } from "@/app/api/portfolio/pulse/route";

const pulse = {
  currency: "USD",
  calculatedAt: "2026-11-12T17:00:00.000Z",
  asOf: "2026-11-12T16:59:45.000Z",
  tradeExecutionAllowed: false,
  modelOutputRole: "portfolio_math_only",
  totals: {
    currentValue: "1500",
    previousCloseValue: "1470",
    dayPnl: "30",
    dayChangePercent: "2.040816",
    coveredCostBasis: "1200",
    coveredUnrealizedPnl: "300",
  },
  coverage: {
    status: "partial",
    totalPositions: 2,
    consideredPositions: 2,
    omittedPositions: 0,
    truncated: false,
    includedPositions: 1,
    excludedPositions: 1,
    delayedPositions: 0,
    costBasisPositions: 1,
    costBasisStatus: "complete",
  },
  positions: [
    {
      symbolId: "NASDAQ:NVDA",
      included: true,
      currentValue: "1500",
    },
    {
      symbolId: "NASDAQ:MSFT",
      included: false,
      exclusionReason: "missing_quote",
    },
  ],
  contributors: { positive: [], negative: [] },
} as const;

describe("portfolio pulse HTTP API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChatGPTUser.mockResolvedValue({
      userId: "owner-a",
      email: "owner@example.test",
      fullName: "Owner A",
    });
  });

  it("requires authentication before reading personal holdings", async () => {
    mocks.getChatGPTUser.mockResolvedValue(null);

    const response = await GET();

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(response.headers.get("server-timing")).toMatch(
      /^omnigaze;dur=\d+\.\d$/,
    );
    expect(await response.json()).toEqual({
      error: "Authentication required.",
      code: "auth_required",
    });
    expect(mocks.getPortfolioPulse).not.toHaveBeenCalled();
  });

  it("returns the exact shared pulse contract for the session-derived owner", async () => {
    mocks.getPortfolioPulse.mockResolvedValue(pulse);

    const response = await GET();
    const body = (await response.json()) as {
      data: unknown;
      meta: Record<string, unknown>;
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getPortfolioPulse).toHaveBeenCalledOnce();
    expect(mocks.getPortfolioPulse).toHaveBeenCalledWith("owner-a");
    expect(body.data).toEqual(pulse);
    expect(body.meta).toMatchObject({
      scope: "personal",
      identity: "authenticated",
      purpose: "portfolio_pulse",
      tradeExecutionAllowed: false,
      generatedAt: expect.any(String),
    });
    expect(JSON.stringify(body)).not.toContain("owner-a");
    expect(JSON.stringify(body)).not.toContain("owner@example.test");
  });

  it("sanitizes repository and provider failures", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getPortfolioPulse.mockRejectedValue(
      new Error("sensitive portfolio database binding detail"),
    );

    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      error: "Portfolio pulse is temporarily unavailable.",
      code: "portfolio_pulse_unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("sensitive");
    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("sensitive");

    errorSpy.mockRestore();
  });
});
