import { describe, expect, it } from "vitest";
import { POST } from "@/app/mcp/route";

async function callMcp(method: string, params?: unknown, authenticated = true) {
  const response = await POST(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { "oai-authenticated-user-id": "test-user" } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  return response.json() as Promise<{
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  }>;
}

describe("MCP 2026-07-28 contract", () => {
  it("discovers the stateless tool capability", async () => {
    const body = await callMcp("server/discover");
    expect(body.result).toMatchObject({
      supportedVersions: ["2026-07-28"],
      capabilities: { tools: {} },
    });
  });

  it("lists schemas for the Omnigaze tools", async () => {
    const body = await callMcp("tools/list");
    const tools = body.result?.tools as Array<{ name: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "search_symbols",
        "get_market_snapshot",
        "get_market_context",
        "get_move_lens",
        "get_intelligence_feed",
        "get_omnigaze_view",
        "get_daily_brief",
        "get_watchlist_dashboard",
        "get_portfolio_pulse",
      ]),
    );
  });

  it("returns a timestamped snapshot in MCP content", async () => {
    const body = await callMcp("tools/call", {
      name: "get_market_snapshot",
      arguments: { symbol_id: "NASDAQ:NVDA" },
    });
    const result = body.result as { content: Array<{ text: string }> };
    const content = JSON.parse(result.content[0].text) as {
      data: { symbolId: string };
      meta: { isDelayed: boolean };
    };
    expect(content.data.symbolId).toBe("NASDAQ:NVDA");
    expect(content.meta.isDelayed).toBe(true);
  });

  it("returns the fixed, honestly labeled ETF-proxy market context", async () => {
    const body = await callMcp("tools/call", {
      name: "get_market_context",
      arguments: {},
    });
    const result = body.result as { content: Array<{ text: string }> };
    const content = JSON.parse(result.content[0].text) as {
      data: Array<{ ticker: string; assetType: string; status: string }>;
      meta: { requestedCount: number; notice: string };
    };

    expect(content.data.map((item) => item.ticker)).toEqual([
      "SPY",
      "QQQ",
      "IWM",
      "TLT",
      "USO",
      "GLD",
    ]);
    expect(content.data.every((item) => item.assetType === "etf_proxy")).toBe(
      true,
    );
    expect(content.meta).toMatchObject({
      requestedCount: 6,
      notice:
        "Provider-backed ETF proxies. Values are not the underlying index, yield, volatility index, or spot commodity.",
    });
  });

  it("reports privacy-bounded owner projection readiness with provider status", async () => {
    const body = await callMcp("tools/call", {
      name: "get_provider_status",
      arguments: {},
    });
    const result = body.result as { content: Array<{ text: string }> };
    const content = JSON.parse(result.content[0].text) as {
      data: {
        projection: {
          mode: string;
          status: string;
          hasProfiles: boolean | null;
          hasPendingWork: boolean | null;
        };
      };
    };

    expect(content.data.projection).toMatchObject({
      mode: expect.stringMatching(/^(request_time|scheduled|unavailable)$/),
      status: expect.stringMatching(
        /^(healthy|catching_up|delayed|degraded|idle|unavailable)$/,
      ),
    });
    expect([true, false, null]).toContain(content.data.projection.hasProfiles);
    expect([true, false, null]).toContain(
      content.data.projection.hasPendingWork,
    );
    expect(JSON.stringify(content.data.projection)).not.toMatch(
      /ownerId|ownerCount|pendingOwnerCount|leasedOwnerCount|failingOwnerCount|symbol|claimToken|lastSequence|partitionKey/,
    );
  });

  it("reports unknown tools without crashing the endpoint", async () => {
    const body = await callMcp("tools/call", {
      name: "does_not_exist",
      arguments: {},
    });
    expect(body.result).toMatchObject({ isError: true });
  });

  it("requires trusted identity for the personal watchlist tool", async () => {
    const body = await callMcp(
      "tools/call",
      { name: "get_watchlist_dashboard", arguments: {} },
      false,
    );
    const result = body.result as {
      isError: boolean;
      content: Array<{ text: string }>;
    };

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: "Authentication required.",
      details: { code: "auth_required" },
    });
  });

  it("returns a JSON-RPC method error for unsupported methods", async () => {
    const body = await callMcp("unknown/method");
    expect(body.error?.code).toBe(-32601);
  });
});
