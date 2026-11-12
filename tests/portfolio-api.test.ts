import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockPortfolioRepositoryError extends Error {
    constructor(
      readonly code:
        | "asset_catalog_unavailable"
        | "holding_not_found"
        | "holding_version_conflict"
        | "profile_version_conflict"
        | "symbol_not_supported",
    ) {
      super(code);
    }
  }

  return {
    getChatGPTUser: vi.fn(),
    getUserPortfolio: vi.fn(),
    putPortfolioProfile: vi.fn(),
    putPortfolioHolding: vi.fn(),
    deletePortfolioHolding: vi.fn(),
    getPortfolioDecisionSupport: vi.fn(),
    PortfolioRepositoryError: MockPortfolioRepositoryError,
  };
});

vi.mock("@/app/chatgpt-auth", () => ({
  getChatGPTUser: mocks.getChatGPTUser,
}));

vi.mock("@/lib/repositories/portfolio", () => ({
  getUserPortfolio: mocks.getUserPortfolio,
  putPortfolioProfile: mocks.putPortfolioProfile,
  putPortfolioHolding: mocks.putPortfolioHolding,
  deletePortfolioHolding: mocks.deletePortfolioHolding,
  PortfolioRepositoryError: mocks.PortfolioRepositoryError,
}));

vi.mock("@/lib/services/portfolio-decision-support", () => ({
  getPortfolioDecisionSupport: mocks.getPortfolioDecisionSupport,
}));

import { GET as getPortfolio } from "@/app/api/portfolio/route";
import { PUT as putProfile } from "@/app/api/portfolio/profile/route";
import {
  DELETE as deleteHolding,
  PUT as putHolding,
} from "@/app/api/portfolio/holdings/[symbol]/route";
import { POST as postDecisionSupport } from "@/app/api/portfolio/decision-support/route";
import { InstrumentResolutionError } from "@/lib/services/instrument-resolution";

const routeContext = (symbol: string) => ({ params: Promise.resolve({ symbol }) });

function jsonRequest(url: string, method: "PUT" | "POST", body: unknown) {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validProfile = {
  base_currency: "USD",
  experience_level: "intermediate",
  risk_comfort: "medium",
  time_horizon: "3_to_7y",
  objective: "balanced_growth",
  max_single_position_bps: 2_000,
  expected_version: 0,
} as const;

const validHolding = {
  quantity: "15",
  average_cost: "147.25",
  cost_currency: "USD",
  quantity_as_of: "2026-01-01T18:00:00.000Z",
  expected_version: 0,
} as const;

describe("portfolio HTTP API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getChatGPTUser.mockResolvedValue({
      userId: "user-a",
      email: "a@example.test",
      fullName: "A User",
    });
  });

  it("requires authentication before every personal read or write", async () => {
    mocks.getChatGPTUser.mockResolvedValue(null);

    const read = await getPortfolio();
    const profile = await putProfile(
      jsonRequest("https://omnigaze.test/api/portfolio/profile", "PUT", validProfile),
    );
    const holding = await putHolding(
      jsonRequest(
        "https://omnigaze.test/api/portfolio/holdings/NASDAQ%3ANVDA",
        "PUT",
        validHolding,
      ),
      routeContext("NASDAQ%3ANVDA"),
    );
    const deletion = await deleteHolding(
      new Request(
        "https://omnigaze.test/api/portfolio/holdings/NASDAQ%3ANVDA?expected_version=1",
        { method: "DELETE" },
      ),
      routeContext("NASDAQ%3ANVDA"),
    );
    const decision = await postDecisionSupport(
      jsonRequest(
        "https://omnigaze.test/api/portfolio/decision-support",
        "POST",
        {
          symbol_id: "NASDAQ:NVDA",
          horizon: "near_term",
          preset: "balanced",
        },
      ),
    );

    expect([
      read.status,
      profile.status,
      holding.status,
      deletion.status,
      decision.status,
    ]).toEqual([401, 401, 401, 401, 401]);
    for (const response of [read, profile, holding, deletion, decision]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("x-request-id")).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
      expect(response.headers.get("server-timing")).toMatch(
        /^omnigaze;dur=\d+\.\d$/,
      );
    }
    expect(mocks.getUserPortfolio).not.toHaveBeenCalled();
    expect(mocks.putPortfolioProfile).not.toHaveBeenCalled();
    expect(mocks.putPortfolioHolding).not.toHaveBeenCalled();
    expect(mocks.deletePortfolioHolding).not.toHaveBeenCalled();
    expect(mocks.getPortfolioDecisionSupport).not.toHaveBeenCalled();
  });

  it("returns an owner-derived, no-store portfolio envelope", async () => {
    mocks.getUserPortfolio.mockResolvedValue({
      profile: { version: 2, riskComfort: "medium" },
      holdings: [{ symbolId: "NASDAQ:NVDA", quantity: "15", version: 1 }],
    });

    const response = await getPortfolio();
    const body = (await response.json()) as {
      data: {
        profile: Record<string, unknown> | null;
        holdings: Array<Record<string, unknown>>;
      };
      meta: {
        scope: string;
        identity: string;
        persistence: string;
      };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getUserPortfolio).toHaveBeenCalledWith("user-a");
    expect(body).toMatchObject({
      data: { holdings: [{ symbolId: "NASDAQ:NVDA", quantity: "15" }] },
      meta: {
        scope: "personal",
        identity: "authenticated",
        persistence: "server",
      },
    });
    expect(JSON.stringify(body)).not.toContain("user-a");
  });

  it("keeps profile writes closed to caller-supplied identity", async () => {
    const invalid = await putProfile(
      jsonRequest("https://omnigaze.test/api/portfolio/profile", "PUT", {
        ...validProfile,
        owner_id: "user-b",
      }),
    );
    mocks.putPortfolioProfile.mockResolvedValue({ version: 1 });
    const valid = await putProfile(
      jsonRequest(
        "https://omnigaze.test/api/portfolio/profile",
        "PUT",
        validProfile,
      ),
    );

    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(200);
    expect(mocks.putPortfolioProfile).toHaveBeenCalledWith(
      "user-a",
      expect.objectContaining({ expected_version: 0 }),
    );
  });

  it("preserves decimal strings and canonicalizes holding symbols", async () => {
    mocks.putPortfolioHolding.mockResolvedValue({
      symbolId: "NASDAQ:NVDA",
      quantity: "15",
      averageCost: "147.25",
      version: 1,
    });

    const response = await putHolding(
      jsonRequest(
        "https://omnigaze.test/api/portfolio/holdings/nasdaq%3Anvda",
        "PUT",
        validHolding,
      ),
      routeContext("nasdaq%3Anvda"),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.putPortfolioHolding).toHaveBeenCalledWith(
      "user-a",
      "NASDAQ:NVDA",
      expect.objectContaining({
        quantity: "15",
        average_cost: "147.25",
      }),
    );
  });

  it("maps optimistic conflicts without leaking repository details", async () => {
    mocks.putPortfolioHolding.mockRejectedValue(
      new mocks.PortfolioRepositoryError("holding_version_conflict"),
    );

    const response = await putHolding(
      jsonRequest(
        "https://omnigaze.test/api/portfolio/holdings/NASDAQ%3ANVDA",
        "PUT",
        { ...validHolding, expected_version: 4 },
      ),
      routeContext("NASDAQ%3ANVDA"),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "Holding changed. Refresh before saving again.",
      code: "version_conflict",
    });
  });

  it("reports catalog outages without exposing provider details", async () => {
    mocks.putPortfolioHolding.mockRejectedValue(
      new mocks.PortfolioRepositoryError("asset_catalog_unavailable"),
    );

    const response = await putHolding(
      jsonRequest(
        "https://omnigaze.test/api/portfolio/holdings/NYSE%3AIBM",
        "PUT",
        validHolding,
      ),
      routeContext("NYSE%3AIBM"),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "The asset catalog is temporarily unavailable.",
      code: "asset_catalog_unavailable",
    });
  });

  it("requires a positive version when deleting a holding", async () => {
    const invalid = await deleteHolding(
      new Request(
        "https://omnigaze.test/api/portfolio/holdings/NASDAQ%3ANVDA?expected_version=0",
        { method: "DELETE" },
      ),
      routeContext("NASDAQ%3ANVDA"),
    );
    mocks.deletePortfolioHolding.mockResolvedValue({
      symbolId: "NASDAQ:NVDA",
      deleted: true,
    });
    const valid = await deleteHolding(
      new Request(
        "https://omnigaze.test/api/portfolio/holdings/NASDAQ%3ANVDA?expected_version=3",
        { method: "DELETE" },
      ),
      routeContext("NASDAQ%3ANVDA"),
    );

    expect(invalid.status).toBe(400);
    expect(valid.status).toBe(200);
    expect(mocks.deletePortfolioHolding).toHaveBeenCalledWith(
      "user-a",
      "NASDAQ:NVDA",
      3,
    );
  });

  it.each([
    ["holding_version_conflict", 409, "version_conflict"],
    ["holding_not_found", 404, "holding_not_found"],
  ] as const)(
    "maps delete repository error %s to a sanitized response",
    async (repositoryCode, expectedStatus, expectedCode) => {
      mocks.deletePortfolioHolding.mockRejectedValue(
        new mocks.PortfolioRepositoryError(repositoryCode),
      );

      const response = await deleteHolding(
        new Request(
          "https://omnigaze.test/api/portfolio/holdings/NASDAQ%3ANVDA?expected_version=3",
          { method: "DELETE" },
        ),
        routeContext("NASDAQ%3ANVDA"),
      );
      const body = (await response.json()) as { code: string; error: string };

      expect(response.status).toBe(expectedStatus);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body.code).toBe(expectedCode);
      expect(body.error).not.toContain(repositoryCode);
    },
  );

  it("keeps decision support scenario-only and explicitly non-executing", async () => {
    mocks.getPortfolioDecisionSupport.mockResolvedValue({
      decision: {
        eligible: false,
        symbolId: "NASDAQ:NVDA",
        suppressedReasons: ["independent_sources_required"],
        tradeExecutionAllowed: false,
        modelOutputRole: "scenario_math_only",
      },
      context: { evidenceCount: 1 },
    });

    const response = await postDecisionSupport(
      jsonRequest(
        "https://omnigaze.test/api/portfolio/decision-support",
        "POST",
        {
          symbol_id: "nasdaq:nvda",
          horizon: "near_term",
          preset: "balanced",
          budget: "1000",
        },
      ),
    );
    const body = (await response.json()) as {
      meta: { purpose: string; tradeExecutionAllowed: boolean };
    };

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.getPortfolioDecisionSupport).toHaveBeenCalledWith(
      "user-a",
      {
        symbol_id: "NASDAQ:NVDA",
        horizon: "near_term",
        preset: "balanced",
        budget: "1000",
      },
    );
    expect(body.meta).toMatchObject({
      purpose: "research_scenarios",
      tradeExecutionAllowed: false,
    });
  });

  it("maps unverified decision-support symbols to a safe client error", async () => {
    mocks.getPortfolioDecisionSupport.mockRejectedValue(
      new InstrumentResolutionError("symbol_not_supported"),
    );

    const response = await postDecisionSupport(
      jsonRequest(
        "https://omnigaze.test/api/portfolio/decision-support",
        "POST",
        {
          symbol_id: "fake:nvda",
          horizon: "near_term",
          preset: "balanced",
        },
      ),
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: "Symbol is not supported.",
      code: "symbol_not_supported",
    });
  });
});
