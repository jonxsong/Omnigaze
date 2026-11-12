import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
}));

vi.mock("@/lib/services/asset-search", () => ({
  getAssetSearchService: () => ({ search: mocks.search }),
}));

import { POST } from "@/app/mcp/route";

async function search(arguments_: Record<string, unknown>) {
  const response = await POST(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "asset-search",
        method: "tools/call",
        params: { name: "search_symbols", arguments: arguments_ },
      }),
    }),
  );
  const body = (await response.json()) as {
    result: { isError?: boolean; content: Array<{ text: string }> };
  };
  return {
    result: body.result,
    content: JSON.parse(body.result.content[0].text) as Record<string, unknown>,
  };
}

describe("MCP asset search", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the live catalog service instead of the bundled demo universe", async () => {
    mocks.search.mockResolvedValue({
      data: [
        {
          symbolId: "NYSE:IBM",
          symbol: "IBM",
          name: "International Business Machines Corporation",
          exchange: "NYSE",
          provider: "alpaca",
        },
      ],
      meta: {
        source: "alpaca",
        catalogAsOf: "2026-11-12T08:00:00.000Z",
        totalMatches: 1,
        freshness: { state: "fresh", ageSeconds: 5 },
      },
    });

    const response = await search({ query: " ibm " });

    expect(mocks.search).toHaveBeenCalledWith("ibm", 20);
    expect(response.content).toMatchObject({
      data: [{ symbolId: "NYSE:IBM", provider: "alpaca" }],
      meta: { source: "alpaca", freshness: { state: "fresh" } },
    });
  });

  it("rejects blank or undeclared query fields before catalog access", async () => {
    const blank = await search({ query: "   " });
    const extra = await search({ query: "IBM", owner_id: "other" });

    expect(blank.result.isError).toBe(true);
    expect(extra.result.isError).toBe(true);
    expect(mocks.search).not.toHaveBeenCalled();
  });
});
