import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockPortfolioRepositoryError extends Error {
    constructor(readonly code: string) {
      super(`private portfolio detail: ${code}`);
    }
  }

  class MockWatchlistRepositoryError extends Error {
    constructor(readonly code: string) {
      super(`private watchlist detail: ${code}`);
    }
  }

  class MockInstrumentResolutionError extends Error {
    constructor(readonly code: string) {
      super(`private catalog detail: ${code}`);
    }
  }

  return {
    getChatGPTUser: vi.fn(),
    getUserPortfolio: vi.fn(),
    putPortfolioHolding: vi.fn(),
    putPortfolioProfile: vi.fn(),
    ensureDefaultWatchlist: vi.fn(),
    addSymbolToWatchlist: vi.fn(),
    resolveCanonicalInstrument: vi.fn(),
    PortfolioRepositoryError: MockPortfolioRepositoryError,
    WatchlistRepositoryError: MockWatchlistRepositoryError,
    InstrumentResolutionError: MockInstrumentResolutionError,
  };
});

vi.mock("@/app/chatgpt-auth", () => ({
  getChatGPTUser: mocks.getChatGPTUser,
}));

vi.mock("@/lib/repositories/portfolio", () => ({
  getUserPortfolio: mocks.getUserPortfolio,
  putPortfolioHolding: mocks.putPortfolioHolding,
  putPortfolioProfile: mocks.putPortfolioProfile,
  PortfolioRepositoryError: mocks.PortfolioRepositoryError,
}));

vi.mock("@/lib/repositories/watchlists", () => ({
  ensureDefaultWatchlist: mocks.ensureDefaultWatchlist,
  addSymbolToWatchlist: mocks.addSymbolToWatchlist,
  WatchlistRepositoryError: mocks.WatchlistRepositoryError,
}));

vi.mock("@/lib/services/instrument-resolution", () => ({
  resolveCanonicalInstrument: mocks.resolveCanonicalInstrument,
  InstrumentResolutionError: mocks.InstrumentResolutionError,
}));

import { POST } from "@/app/api/onboarding/complete/route";

const serverNow = "2026-11-12T20:30:00.000Z";

function draftRequest(body: unknown) {
  return new Request("https://omnigaze.test/api/onboarding/complete", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function draft(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    currentStep: 3,
    highestStep: 3,
    symbols: ["NASDAQ:NVDA", "NASDAQ:AAPL"],
    positions: [],
    goals: ["portfolio-context"],
    horizon: "one-three-years",
    riskProfile: "balanced",
    liquidityNeed: "none-near-term",
    holdingsSkipped: false,
    preferencesSkipped: false,
    updatedAt: serverNow,
    completedAt: null,
    ...overrides,
  };
}

function instrument(symbolId: string) {
  const [exchange, ticker] = symbolId.split(":");
  return {
    id: symbolId,
    ticker,
    exchange,
    name: `${ticker} Incorporated`,
    sector: null,
    currency: "USD",
    status: "active",
  };
}

describe("authenticated onboarding sync API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(serverNow));
    mocks.getChatGPTUser.mockResolvedValue({
      userId: "user-a",
      email: "private@example.test",
      fullName: "Private User",
    });
    mocks.resolveCanonicalInstrument.mockImplementation(async (symbolId: string) =>
      instrument(symbolId),
    );
    mocks.getUserPortfolio.mockResolvedValue({ profile: null, holdings: [] });
    mocks.ensureDefaultWatchlist.mockResolvedValue({
      id: "default-list-private-id",
      ownerId: "user-a",
      name: "Core holdings",
      isDefault: true,
    });
    mocks.addSymbolToWatchlist.mockResolvedValue({});
    mocks.putPortfolioHolding.mockImplementation(
      async (_ownerId: string, symbolId: string, mutation: { quantity: string }) => ({
        symbolId,
        quantity: mutation.quantity,
        version: 1,
      }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("requires authentication before parsing, resolving, or mutating", async () => {
    mocks.getChatGPTUser.mockResolvedValue(null);

    const response = await POST(draftRequest(draft()));

    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "Authentication required.",
      code: "auth_required",
    });
    expect(mocks.resolveCanonicalInstrument).not.toHaveBeenCalled();
    expect(mocks.getUserPortfolio).not.toHaveBeenCalled();
    expect(mocks.addSymbolToWatchlist).not.toHaveBeenCalled();
    expect(mocks.putPortfolioHolding).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON and invalid draft versions with no-store responses", async () => {
    const malformed = await POST(
      new Request("https://omnigaze.test/api/onboarding/complete", {
        method: "POST",
        body: "{not-json",
      }),
    );
    const wrongVersion = await POST(draftRequest(draft({ version: 99 })));

    expect(malformed.status).toBe(400);
    expect(malformed.headers.get("cache-control")).toBe("no-store");
    expect(await malformed.json()).toMatchObject({ code: "invalid_json" });
    expect(wrongVersion.status).toBe(400);
    expect(wrongVersion.headers.get("cache-control")).toBe("no-store");
    expect(await wrongVersion.json()).toMatchObject({
      code: "invalid_onboarding_draft",
    });
    expect(mocks.resolveCanonicalInstrument).not.toHaveBeenCalled();
    expect(mocks.ensureDefaultWatchlist).not.toHaveBeenCalled();
  });

  it("validates every owned holding before any resolution or mutation", async () => {
    const response = await POST(
      draftRequest(
        draft({
          positions: [
            {
              symbolId: "NASDAQ:NVDA",
              owned: true,
              shares: "1.125000",
              averageCost: "147.250000",
            },
            {
              symbolId: "NASDAQ:AAPL",
              owned: true,
              shares: "1.0000001",
              averageCost: "200",
            },
          ],
        }),
      ),
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "One or more holdings are invalid.",
      code: "invalid_holdings",
    });
    expect(mocks.resolveCanonicalInstrument).not.toHaveBeenCalled();
    expect(mocks.getUserPortfolio).not.toHaveBeenCalled();
    expect(mocks.ensureDefaultWatchlist).not.toHaveBeenCalled();
    expect(mocks.addSymbolToWatchlist).not.toHaveBeenCalled();
    expect(mocks.putPortfolioHolding).not.toHaveBeenCalled();
  });

  it("sanitizes to bundled symbols and performs an additive, exact merge", async () => {
    mocks.getUserPortfolio.mockResolvedValue({
      profile: { version: 4 },
      holdings: [
        {
          symbolId: "NASDAQ:NVDA",
          quantity: "99",
          averageCost: "999",
          version: 7,
        },
      ],
    });

    const response = await POST(
      draftRequest(
        draft({
          owner_id: "attacker-selected-owner",
          symbols: [
            "NASDAQ:NVDA",
            "NYSE:IBM",
            "NASDAQ:AAPL",
            "NASDAQ:NVDA",
          ],
          positions: [
            {
              symbolId: "NASDAQ:NVDA",
              owned: true,
              shares: "1.500000",
              averageCost: "150.000000",
            },
            {
              symbolId: "NASDAQ:AAPL",
              owned: true,
              shares: "2.125000",
              averageCost: "200.250000",
            },
            {
              symbolId: "NYSE:IBM",
              owned: true,
              shares: "500",
              averageCost: "1",
            },
          ],
        }),
      ),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.resolveCanonicalInstrument.mock.calls.map(([symbol]) => symbol)).toEqual([
      "NASDAQ:NVDA",
      "NASDAQ:AAPL",
    ]);
    expect(mocks.getUserPortfolio).toHaveBeenCalledWith("user-a");
    expect(mocks.ensureDefaultWatchlist).toHaveBeenCalledWith("user-a");
    expect(mocks.addSymbolToWatchlist).toHaveBeenCalledTimes(2);
    expect(mocks.addSymbolToWatchlist).toHaveBeenNthCalledWith(
      1,
      "user-a",
      "default-list-private-id",
      "NASDAQ:NVDA",
      expect.objectContaining({ id: "NASDAQ:NVDA", ticker: "NVDA" }),
    );
    expect(mocks.addSymbolToWatchlist).toHaveBeenNthCalledWith(
      2,
      "user-a",
      "default-list-private-id",
      "NASDAQ:AAPL",
      expect.objectContaining({ id: "NASDAQ:AAPL", ticker: "AAPL" }),
    );
    expect(mocks.putPortfolioHolding).toHaveBeenCalledTimes(1);
    expect(mocks.putPortfolioHolding).toHaveBeenCalledWith(
      "user-a",
      "NASDAQ:AAPL",
      {
        quantity: "2.125000",
        average_cost: "200.250000",
        cost_currency: "USD",
        quantity_as_of: serverNow,
        expected_version: 0,
      },
    );
    expect(mocks.putPortfolioProfile).not.toHaveBeenCalled();
    expect(body).toEqual({
      data: {
        symbolsAccepted: 2,
        watchlistSymbolsEnsured: 2,
        holdingsRequested: 2,
        holdingsCreated: 1,
        holdingsPreserved: 1,
      },
      meta: {
        scope: "personal",
        identity: "authenticated",
        persistence: "server",
        strategy: "additive",
        profileUpdated: false,
        completedAt: serverNow,
      },
    });
    expect(JSON.stringify(body)).not.toContain("user-a");
    expect(JSON.stringify(body)).not.toContain("attacker-selected-owner");
    expect(JSON.stringify(body)).not.toContain("private@example.test");
    expect(JSON.stringify(body)).not.toContain("default-list-private-id");
  });

  it("treats a create race as preserved and never retries an overwrite", async () => {
    mocks.putPortfolioHolding.mockRejectedValue(
      new mocks.PortfolioRepositoryError("holding_version_conflict"),
    );

    const response = await POST(
      draftRequest(
        draft({
          symbols: ["NASDAQ:NVDA"],
          positions: [
            {
              symbolId: "NASDAQ:NVDA",
              owned: true,
              shares: "3.75",
              averageCost: "100.50",
            },
          ],
        }),
      ),
    );

    expect(response.status).toBe(200);
    expect(mocks.putPortfolioHolding).toHaveBeenCalledTimes(1);
    expect(mocks.putPortfolioHolding).toHaveBeenCalledWith(
      "user-a",
      "NASDAQ:NVDA",
      expect.objectContaining({ expected_version: 0 }),
    );
    expect(await response.json()).toMatchObject({
      data: { holdingsCreated: 0, holdingsPreserved: 1 },
    });
  });

  it("resolves every accepted symbol before performing any write", async () => {
    mocks.resolveCanonicalInstrument
      .mockResolvedValueOnce(instrument("NASDAQ:NVDA"))
      .mockRejectedValueOnce(
        new mocks.InstrumentResolutionError("asset_catalog_unavailable"),
      );

    const response = await POST(draftRequest(draft()));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      error: "The asset catalog is temporarily unavailable.",
      code: "asset_catalog_unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("private catalog detail");
    expect(mocks.getUserPortfolio).not.toHaveBeenCalled();
    expect(mocks.ensureDefaultWatchlist).not.toHaveBeenCalled();
    expect(mocks.addSymbolToWatchlist).not.toHaveBeenCalled();
    expect(mocks.putPortfolioHolding).not.toHaveBeenCalled();
  });

  it("sanitizes repository failures without leaking identity or internals", async () => {
    mocks.getUserPortfolio.mockRejectedValue(
      new Error("D1 secret binding failed for owner user-a"),
    );

    const response = await POST(draftRequest(draft()));
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      error: "Account setup could not be synced. Retrying is safe.",
      code: "onboarding_sync_unavailable",
    });
    expect(JSON.stringify(body)).not.toContain("user-a");
    expect(JSON.stringify(body)).not.toContain("D1 secret");
    expect(mocks.ensureDefaultWatchlist).not.toHaveBeenCalled();
    expect(mocks.addSymbolToWatchlist).not.toHaveBeenCalled();
    expect(mocks.putPortfolioHolding).not.toHaveBeenCalled();
  });
});
