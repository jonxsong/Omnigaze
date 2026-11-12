import { describe, expect, it } from "vitest";
import { POST } from "@/app/mcp/route";

function request(body: string, headers: Record<string, string> = {}) {
  return POST(
    new Request("https://omnigaze.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    }),
  );
}

async function rpc(method: string, params?: unknown) {
  const response = await request(
    JSON.stringify({ jsonrpc: "2.0", id: "contract-test", method, params }),
    { "oai-authenticated-user-id": "user-contract-test" },
  );
  return response.json() as Promise<{
    id: string | null;
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  }>;
}

describe("MCP JSON-RPC response stability", () => {
  it("uses the standard parse and invalid-request error codes", async () => {
    const parseError = (await (await request("{" )).json()) as {
      error: { code: number };
    };
    const invalidRequest = (await (
      await request(JSON.stringify({ jsonrpc: "1.0", id: 7, method: "tools/list" }))
    ).json()) as { error: { code: number } };

    expect(parseError.error.code).toBe(-32700);
    expect(invalidRequest.error.code).toBe(-32600);
  });

  it("keeps all advertised tool schemas closed to undeclared properties", async () => {
    const body = await rpc("tools/list");
    const tools = body.result?.tools as Array<{
      name: string;
      inputSchema: { type: string; additionalProperties?: boolean };
    }>;

    expect(tools.length).toBeGreaterThan(0);
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it("returns validation failures as tool errors rather than endpoint failures", async () => {
    const body = await rpc("tools/call", {
      name: "get_market_snapshot",
      arguments: { symbol_id: "nvda", unexpected: true },
    });

    expect(body.error).toBeUndefined();
    expect(body.result).toMatchObject({ isError: true });
    const result = body.result as { content: Array<{ type: string; text: string }> };
    expect(result.content[0].type).toBe("text");
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      error: "Invalid tool arguments.",
    });
  });

  it("returns a stable evidence view envelope with delayed-data metadata", async () => {
    const body = await rpc("tools/call", {
      name: "get_omnigaze_view",
      arguments: { symbol_id: "NASDAQ:MSFT" },
    });
    const result = body.result as { content: Array<{ type: string; text: string }> };
    const content = JSON.parse(result.content[0].text) as {
      data: { view: { symbolId: string; dataCutoff: string }; evidence: unknown[] };
      meta: { mode: string; isDelayed: boolean; provider: string };
    };

    expect(content.data.view.symbolId).toBe("NASDAQ:MSFT");
    expect(Number.isNaN(Date.parse(content.data.view.dataCutoff))).toBe(false);
    expect(content.data.evidence.length).toBeGreaterThan(0);
    expect(content.meta).toMatchObject({
      mode: "demo",
      isDelayed: true,
      provider: "Omnigaze fixture provider",
    });
  });
});
