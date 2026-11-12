import { describe, expect, it } from "vitest";
import { POST } from "@/app/mcp/route";

async function callMcp(method: string, params?: unknown) {
  const response = await POST(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "oai-authenticated-user-id": "test-user",
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
        "get_intelligence_feed",
        "get_omnigaze_view",
        "get_watchlist_dashboard",
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

  it("reports unknown tools without crashing the endpoint", async () => {
    const body = await callMcp("tools/call", {
      name: "does_not_exist",
      arguments: {},
    });
    expect(body.result).toMatchObject({ isError: true });
  });

  it("returns a JSON-RPC method error for unsupported methods", async () => {
    const body = await callMcp("unknown/method");
    expect(body.error?.code).toBe(-32601);
  });
});
