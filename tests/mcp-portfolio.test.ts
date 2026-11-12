import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getUserPortfolio: vi.fn(),
  getPortfolioDecisionSupport: vi.fn(),
}));

vi.mock("@/lib/repositories/portfolio", () => ({
  getUserPortfolio: mocks.getUserPortfolio,
}));

vi.mock("@/lib/services/portfolio-decision-support", () => ({
  getPortfolioDecisionSupport: mocks.getPortfolioDecisionSupport,
}));

import { POST } from "@/app/mcp/route";
import { InstrumentResolutionError } from "@/lib/services/instrument-resolution";

async function callTool(
  name: string,
  args: Record<string, unknown>,
  userId?: string,
) {
  const response = await POST(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(userId ? { "oai-authenticated-user-id": userId } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const body = (await response.json()) as {
    result: {
      isError?: boolean;
      content: Array<{ text: string }>;
      structuredContent?: Record<string, unknown>;
    };
  };
  return {
    response,
    result: body.result,
    content: JSON.parse(body.result.content[0].text) as Record<string, unknown>,
  };
}

describe("portfolio MCP tools", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each(["get_portfolio", "get_decision_support"])(
    "requires trusted identity for %s",
    async (name) => {
      const response = await callTool(
        name,
        name === "get_decision_support"
          ? {
              symbol_id: "NASDAQ:NVDA",
              horizon: "near_term",
              preset: "balanced",
            }
          : {},
      );

      expect(response.result.isError).toBe(true);
      expect(response.content).toMatchObject({
        error: "Authentication required.",
        details: { code: "auth_required" },
      });
    },
  );

  it("returns personal portfolio data without exposing an owner identifier", async () => {
    mocks.getUserPortfolio.mockResolvedValue({
      profile: { riskComfort: "medium", version: 1 },
      holdings: [{ symbolId: "NASDAQ:NVDA", quantity: "15", version: 1 }],
    });

    const response = await callTool("get_portfolio", {}, "owner-a");

    expect(mocks.getUserPortfolio).toHaveBeenCalledWith("owner-a");
    expect(response.response.headers.get("cache-control")).toBe("no-store");
    expect(response.content).toMatchObject({
      data: { holdings: [{ symbolId: "NASDAQ:NVDA", quantity: "15" }] },
      meta: {
        scope: "personal",
        identity: "authenticated",
        persistence: "server",
      },
    });
    expect(JSON.stringify(response.content)).not.toContain("owner-a");
    expect(response.result.structuredContent).toEqual(response.content);
  });

  it("enforces the advertised closed schema for portfolio reads", async () => {
    const response = await callTool(
      "get_portfolio",
      { owner_id: "someone-else" },
      "owner-a",
    );

    expect(response.result.isError).toBe(true);
    expect(response.content).toMatchObject({
      error: "Invalid tool arguments.",
    });
    expect(mocks.getUserPortfolio).not.toHaveBeenCalled();
  });

  it("exposes non-executing decision scenarios through the same domain service", async () => {
    mocks.getPortfolioDecisionSupport.mockResolvedValue({
      decision: {
        eligible: false,
        symbolId: "NASDAQ:NVDA",
        suppressedReasons: ["insufficient_evidence"],
        tradeExecutionAllowed: false,
        modelOutputRole: "scenario_math_only",
      },
      context: { evidenceCount: 1 },
    });

    const response = await callTool(
      "get_decision_support",
      {
        symbol_id: "nasdaq:nvda",
        horizon: "near_term",
        preset: "balanced",
        budget: "1000",
      },
      "owner-a",
    );

    expect(mocks.getPortfolioDecisionSupport).toHaveBeenCalledWith("owner-a", {
      symbol_id: "NASDAQ:NVDA",
      horizon: "near_term",
      preset: "balanced",
      budget: "1000",
    });
    expect(response.content).toMatchObject({
      data: {
        decision: {
          eligible: false,
          tradeExecutionAllowed: false,
        },
      },
      meta: {
        purpose: "research_scenarios",
        tradeExecutionAllowed: false,
      },
    });
  });

  it("rejects undeclared or malformed scenario arguments", async () => {
    const response = await callTool(
      "get_decision_support",
      {
        symbol_id: "NASDAQ:NVDA",
        horizon: "near_term",
        preset: "balanced",
        owner_id: "someone-else",
      },
      "owner-a",
    );

    expect(response.result.isError).toBe(true);
    expect(response.content).toMatchObject({ error: "Invalid tool arguments." });
    expect(mocks.getPortfolioDecisionSupport).not.toHaveBeenCalled();
  });

  it("returns a stable tool error for an unverified canonical symbol", async () => {
    mocks.getPortfolioDecisionSupport.mockRejectedValue(
      new InstrumentResolutionError("symbol_not_supported"),
    );

    const response = await callTool(
      "get_decision_support",
      {
        symbol_id: "FAKE:NVDA",
        horizon: "near_term",
        preset: "balanced",
      },
      "owner-a",
    );

    expect(response.result.isError).toBe(true);
    expect(response.content).toEqual({
      error: "Symbol is not supported.",
      details: { code: "symbol_not_supported" },
    });
  });

  it("does not expose repository or provider exception text", async () => {
    mocks.getUserPortfolio.mockRejectedValue(
      new Error("sensitive database binding detail"),
    );

    const response = await callTool("get_portfolio", {}, "owner-a");

    expect(response.result.isError).toBe(true);
    expect(response.content).toEqual({
      error: "Tool execution failed.",
      details: { code: "tool_execution_failed" },
    });
    expect(JSON.stringify(response.content)).not.toContain("sensitive");
  });
});
